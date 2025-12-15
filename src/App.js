import React, { useState, useEffect, useRef, createContext, useContext, useCallback, useMemo } from 'react';
import { Mic, MicOff, Video, VideoOff, ScreenShare, MessageSquare, Send, X, LogIn, Plus, Sun, Moon, Volume2, VolumeX, Users, Settings } from 'lucide-react';
import { io } from 'socket.io-client';
import Peer from 'peerjs';
import { ToastContainer, toast } from 'react-toastify';
import 'react-toastify/dist/index.css'; // <-- CORRECTED IMPORT PATH
import styles from './App.module.css';

// --- UTILS AND CONSTANTS ---
const API_KEY = ""; // Placeholder for Gemini API Key. Left blank for Canvas environment.
const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models/';
const GEMINI_MODEL = 'gemini-2.5-flash-preview-09-2025';

// --- CONTEXTO PARA WEBRTC ---
const WebRTCContext = createContext();
const useWebRTC = () => useContext(WebRTCContext);

// --- HOOK PERSONALIZADO PARA LA LÓGICA DE WEBRTC ---
const useWebRTCLogic = (roomId) => {
    const [myStream, setMyStream] = useState(null);
    const [myScreenStream, setMyScreenStream] = useState(null);
    const [peers, setPeers] = useState({});
    const [chatMessages, setChatMessages] = useState([]);
    const [isMuted, setIsMuted] = useState(false);
    const [isVideoOff, setIsVideoOff] = useState(false);
    const [isScreenSharing, setIsScreenSharing] = useState(false);
    const [appTheme, setAppTheme] = useState('dark');
    const [roomUsers, setRoomUsers] = useState({});
    const [currentUserId, setCurrentUserId] = useState(null);
    const [isSocketConnected, setIsSocketConnected] = useState(false);

    const socketRef = useRef(null);
    const myPeerRef = useRef(null);
    const peerConnections = useRef({});
    const currentUserNameRef = useRef('');

    const toggleTheme = () => {
        setAppTheme(prev => prev === 'dark' ? 'light' : 'dark');
    };

    const playAudioBuffer = useCallback((audioBuffer, audioOutputId) => {
        if (!audioBuffer) return;

        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        audioContext.decodeAudioData(audioBuffer, (buffer) => {
            const source = audioContext.createBufferSource();
            source.buffer = buffer;

            // Handle audio output device selection (only works in non-safari browsers)
            let audioDestination = audioContext.destination;
            if (audioOutputId && audioContext.setSinkId) {
                audioContext.setSinkId(audioOutputId)
                    .then(() => {
                        source.connect(audioDestination);
                        source.start(0);
                    })
                    .catch(e => {
                        console.warn("Could not set audio sink ID:", e);
                        source.connect(audioDestination);
                        source.start(0);
                    });
            } else {
                source.connect(audioDestination);
                source.start(0);
            }
        });
    }, []);

    const fetchTTSAudio = useCallback(async (text) => {
        if (!text) return null;

        const payload = {
            contents: [{
                parts: [{ text: text }]
            }],
            generationConfig: {
                responseModalities: ["AUDIO"],
                speechConfig: {
                    voiceConfig: {
                        // Using a distinct, friendly voice for general text
                        prebuiltVoiceConfig: { voiceName: "Achird" }
                    }
                }
            },
            model: "gemini-2.5-flash-preview-tts"
        };

        let currentDelay = 1000;
        const maxRetries = 5;

        for (let i = 0; i < maxRetries; i++) {
            try {
                const response = await fetch(`${BASE_URL}gemini-2.5-flash-preview-tts:generateContent?key=${API_KEY}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });

                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }

                const result = await response.json();
                const part = result?.candidates?.[0]?.content?.parts?.[0];
                const audioData = part?.inlineData?.data;

                if (audioData) {
                    // Convert base64 to ArrayBuffer
                    const binaryString = window.atob(audioData);
                    const len = binaryString.length;
                    const bytes = new Uint8Array(len);
                    for (let j = 0; j < len; j++) {
                        bytes[j] = binaryString.charCodeAt(j);
                    }
                    return bytes.buffer;
                }
            } catch (error) {
                console.error(`Attempt ${i + 1} failed to fetch TTS audio:`, error);
                if (i < maxRetries - 1) {
                    await new Promise(resolve => setTimeout(resolve, currentDelay));
                    currentDelay *= 2; // Exponential backoff
                } else {
                    toast.error("Failed to generate TTS audio after multiple retries.");
                    return null;
                }
            }
        }
    }, []);

    const addMessage = useCallback((message) => {
        setChatMessages((prevMessages) => {
            // Only keep the last 50 messages to prevent memory issues
            const newMessages = [...prevMessages, message];
            return newMessages.slice(-50);
        });
    }, []);

    const sendMessage = useCallback((messageText) => {
        if (!messageText || !socketRef.current) return;

        const message = {
            id: Date.now() + Math.random(),
            user: currentUserNameRef.current,
            text: messageText,
            timestamp: new Date().toLocaleTimeString(),
            isTTS: false,
        };

        socketRef.current.emit('message', message);
        addMessage({ ...message, isMe: true });
    }, [addMessage]);

    const sendTTSMessage = useCallback(async (messageText, audioOutputId) => {
        if (!messageText || !socketRef.current) return;

        const audioBuffer = await fetchTTSAudio(messageText);
        if (!audioBuffer) return;

        // Convert ArrayBuffer to Base64 for transport over socket
        const base64Audio = btoa(String.fromCharCode(...new Uint8Array(audioBuffer)));

        const message = {
            id: Date.now() + Math.random(),
            user: currentUserNameRef.current,
            text: messageText,
            timestamp: new Date().toLocaleTimeString(),
            isTTS: true,
            audioData: base64Audio,
        };

        socketRef.current.emit('message', message);
        addMessage({ ...message, isMe: true });
        // Play local audio immediately
        playAudioBuffer(audioBuffer, audioOutputId);
    }, [addMessage, fetchTTSAudio, playAudioBuffer]);

    const initializeStream = useCallback(async (audioId, videoId) => {
        try {
            const constraints = {
                audio: audioId ? { deviceId: { exact: audioId } } : true,
                video: videoId ? { deviceId: { exact: videoId } } : true
            };
            const stream = await navigator.mediaDevices.getUserMedia(constraints);
            setMyStream(stream);
            return stream;
        } catch (err) {
            console.error("Error accessing media devices:", err);
            toast.error("Could not access camera/microphone. Please check permissions.");
            return null;
        }
    }, []);

    const handleNewPeer = useCallback((userId, peerId, userName, stream) => {
        setPeers(prev => ({
            ...prev,
            [userId]: { peerId, stream, userName, isMuted: false, isVideoOff: false, isScreenSharing: false, peerConnection: null }
        }));
        toast.info(`${userName} has joined the room!`);
    }, []);

    const handlePeerDisconnect = useCallback((userId, userName) => {
        setPeers(prev => {
            const newPeers = { ...prev };
            delete newPeers[userId];
            return newPeers;
        });

        // Close peer connection
        if (peerConnections.current[userId]) {
            peerConnections.current[userId].close();
            delete peerConnections.current[userId];
        }

        toast.warning(`${userName} has left the room.`);
    }, []);


    const connect = useCallback((stream, userName) => {
        if (socketRef.current || myPeerRef.current) {
            console.warn("Already connected. Cleaning up first.");
            cleanup();
        }

        currentUserNameRef.current = userName;

        // 1. Socket Setup
        socketRef.current = io('http://localhost:3001'); // Replace with your Socket.IO server URL
        // Fallback for secure environment: This is a placeholder. In a real environment, this should point to a secure, public backend.

        socketRef.current.on('connect', () => {
            console.log("Socket connected:", socketRef.current.id);
            setIsSocketConnected(true);

            // 2. PeerJS Setup
            myPeerRef.current = new Peer(undefined, {
                host: 'peerjs.azurewebsites.net', // Replace with your PeerJS server
                secure: true,
                port: 443,
                path: '/'
            });

            myPeerRef.current.on('open', (peerId) => {
                console.log("PeerJS ready with ID:", peerId);
                setCurrentUserId(peerId); // Use Peer ID as user ID for simplicity

                // Tell server we joined
                socketRef.current.emit('join-room', roomId, peerId, userName);
            });

            myPeerRef.current.on('error', (err) => {
                console.error("PeerJS error:", err);
                toast.error(`Peer connection failed: ${err.type}`);
            });

            // Handle incoming calls (A calls B)
            myPeerRef.current.on('call', (call) => {
                console.log("Incoming call from:", call.peer);
                // Answer the call with my stream
                call.answer(stream);

                call.on('stream', (remoteStream) => {
                    console.log("Received remote stream.");
                    // The server will handle notifying about the new user and stream via socket
                    // For now, let's keep track of the stream locally until the socket message comes in
                    // This is slightly simplified; a real app links the call.peer ID to the user ID
                });

                call.on('close', () => console.log("Peer call closed."));
                call.on('error', (err) => console.error("Call error:", err));

                // Save connection for later use (e.g., toggling tracks)
                peerConnections.current[call.peer] = call;
            });
        });

        socketRef.current.on('user-connected', (userId, peerId, userName) => {
            console.log(`User connected: ${userName} (${userId})`);
            // Call the new user
            const call = myPeerRef.current.call(peerId, stream);

            call.on('stream', (remoteStream) => {
                console.log("Initiated call and received remote stream from new user.");
                handleNewPeer(userId, peerId, userName, remoteStream);
            });

            call.on('close', () => console.log(`Call to ${userName} closed.`));
            call.on('error', (err) => console.error(`Call error with ${userName}:`, err));

            // Save connection
            peerConnections.current[userId] = call;
        });

        socketRef.current.on('user-disconnected', handlePeerDisconnect);

        socketRef.current.on('room-users', (users) => {
            setRoomUsers(users);
        });

        socketRef.current.on('message', (message) => {
            if (message.user !== currentUserNameRef.current) {
                addMessage({ ...message, isMe: false });
                if (message.isTTS && message.audioData) {
                    try {
                        const audioBuffer = Uint8Array.from(atob(message.audioData), c => c.charCodeAt(0)).buffer;
                        // Use the selected audio output ID passed from App.js/Lobby
                        const selectedOutputId = document.getElementById('audio-output-select')?.value;
                        playAudioBuffer(audioBuffer, selectedOutputId);
                    } catch (e) {
                        console.error("Error decoding or playing remote TTS audio:", e);
                        toast.error(`Error playing TTS from ${message.user}`);
                    }
                }
            }
        });

        socketRef.current.on('stream-toggle', (userId, type, state) => {
            setPeers(prev => {
                const peer = prev[userId];
                if (!peer) return prev;

                const newState = {};
                if (type === 'audio') {
                    newState.isMuted = state; // isMuted means audio is OFF (true)
                    toast.info(`${peer.userName} has turned their mic ${state ? 'OFF' : 'ON'}`);
                } else if (type === 'video') {
                    newState.isVideoOff = state; // isVideoOff means video is OFF (true)
                    toast.info(`${peer.userName} has turned their video ${state ? 'OFF' : 'ON'}`);
                } else if (type === 'screen') {
                    newState.isScreenSharing = state;
                    toast.info(`${peer.userName} is now ${state ? 'sharing their screen' : 'done sharing'}`);
                }

                return { ...prev, [userId]: { ...peer, ...newState } };
            });
        });

        socketRef.current.on('disconnect', () => {
            console.log("Socket disconnected.");
            setIsSocketConnected(false);
            toast.error("Lost connection to the meeting server.");
        });

    }, [roomId, initializeStream, handleNewPeer, handlePeerDisconnect, addMessage, playAudioBuffer]);

    const cleanup = useCallback(() => {
        if (myStream) {
            myStream.getTracks().forEach(track => track.stop());
            setMyStream(null);
        }
        if (myScreenStream) {
            myScreenStream.getTracks().forEach(track => track.stop());
            setMyScreenStream(null);
            setIsScreenSharing(false);
        }

        // Close all peer connections
        Object.values(peerConnections.current).forEach(call => {
            call.close();
        });
        peerConnections.current = {};
        setPeers({});
        setRoomUsers({});

        // Close PeerJS
        if (myPeerRef.current) {
            myPeerRef.current.destroy();
            myPeerRef.current = null;
        }

        // Close Socket.IO
        if (socketRef.current) {
            socketRef.current.disconnect();
            socketRef.current = null;
        }
        setIsSocketConnected(false);
        setCurrentUserId(null);
        setChatMessages([]);
        currentUserNameRef.current = '';
    }, [myStream, myScreenStream]);

    const toggleMedia = useCallback((type) => {
        if (!myStream || !socketRef.current || !currentUserId) return;

        let newState;
        let track;

        if (type === 'audio') {
            track = myStream.getAudioTracks()[0];
            if (!track) return;
            newState = !isMuted;
            track.enabled = !newState;
            setIsMuted(newState);
        } else if (type === 'video') {
            track = myStream.getVideoTracks()[0];
            if (!track) return;
            newState = !isVideoOff;
            track.enabled = !newState;
            setIsVideoOff(newState);
        } else {
            return;
        }

        // Notify others
        socketRef.current.emit('stream-toggle', type, newState);
    }, [myStream, isMuted, isVideoOff, currentUserId]);

    const toggleScreenShare = useCallback(async () => {
        if (isScreenSharing) {
            // Stop sharing
            myScreenStream.getTracks().forEach(track => track.stop());

            // Switch video track back to camera (if it was on) or stop streaming an empty track
            const cameraTrack = myStream?.getVideoTracks()[0];
            const videoSender = Object.values(peerConnections.current).map(call =>
                call.peerConnection.getSenders().find(sender => sender.track?.kind === 'video')
            ).filter(Boolean);

            if (cameraTrack) {
                videoSender.forEach(sender => sender.replaceTrack(cameraTrack));
                // Re-enable camera track if it was disabled (e.g., if isVideoOff was true)
                cameraTrack.enabled = !isVideoOff;
            } else {
                // If there was no camera stream, just stop replacing
            }

            setMyScreenStream(null);
            setIsScreenSharing(false);
            socketRef.current.emit('stream-toggle', 'screen', false);

        } else {
            // Start sharing
            try {
                const screenStream = await navigator.mediaDevices.getDisplayMedia({
                    video: true,
                    audio: true
                });

                if (screenStream) {
                    setMyScreenStream(screenStream);
                    setIsScreenSharing(true);

                    // 1. Replace my existing video track with the screen share track
                    const screenVideoTrack = screenStream.getVideoTracks()[0];
                    const screenAudioTrack = screenStream.getAudioTracks()[0];

                    const videoSender = Object.values(peerConnections.current).map(call =>
                        call.peerConnection.getSenders().find(sender => sender.track?.kind === 'video')
                    ).filter(Boolean);

                    const audioSender = Object.values(peerConnections.current).map(call =>
                        call.peerConnection.getSenders().find(sender => sender.track?.kind === 'audio')
                    ).filter(Boolean);

                    if (videoSender.length > 0) {
                        videoSender.forEach(sender => sender.replaceTrack(screenVideoTrack));
                    }

                    // 2. Add screen audio track if available and replace existing audio if we were sharing mic audio
                    // For simplicity, we only handle video replacement here. A robust solution needs separate audio mixing.
                    // For now, if the user was mic-muted, we don't unmute them, but the screen audio track will be sent.
                    if (screenAudioTrack) {
                        if (audioSender.length > 0) {
                             audioSender.forEach(sender => sender.replaceTrack(screenAudioTrack));
                        }
                    }

                    // 3. Set up listener to automatically stop when user clicks 'Stop Sharing' in browser UI
                    screenVideoTrack.onended = () => {
                        console.log("Screen share stopped by browser UI.");
                        toggleScreenShare(); // Re-call to handle cleanup logic
                    };

                    socketRef.current.emit('stream-toggle', 'screen', true);
                }
            } catch (err) {
                console.error("Error starting screen share:", err);
                toast.error("Could not start screen sharing.");
            }
        }
    }, [isScreenSharing, myScreenStream, myStream, isVideoOff]);


    return {
        myStream,
        peers,
        chatMessages,
        isMuted,
        isVideoOff,
        isScreenSharing,
        appTheme,
        roomUsers,
        currentUserId,
        isSocketConnected,
        initializeStream,
        connect,
        cleanup,
        toggleMedia,
        toggleScreenShare,
        sendMessage,
        sendTTSMessage,
        toggleTheme
    };
};

// --- COMPONENTES DE VÍDEO --
const VideoContainer = ({ stream, userName, isMuted, isVideoOff, isScreenSharing, isMe }) => {
    const videoRef = useRef(null);

    useEffect(() => {
        if (videoRef.current && stream) {
            videoRef.current.srcObject = stream;
        }
    }, [stream]);

    // Determine the user's status icon and color
    const statusIcon = isMuted ? <MicOff size={20} /> : <Mic size={20} />;
    const micClass = isMuted ? styles.micOff : styles.micOn;
    const videoPlaceholderClass = isVideoOff ? '' : styles.hiddenPlaceholder;

    const mainContent = useMemo(() => {
        if (isScreenSharing) {
            return (
                <div className={styles.screenShareIndicator}>
                    <ScreenShare size={40} />
                    <p>{userName} is Sharing Screen</p>
                </div>
            );
        }
        if (isVideoOff) {
            return (
                <div className={styles.videoPlaceholder}>
                    <Users size={64} className="text-gray-400" />
                    <p className="text-xl font-semibold mt-2">{userName[0]}</p>
                </div>
            );
        }
        // If video is ON and not screen sharing
        return (
            <video
                ref={videoRef}
                className={styles.videoElement}
                autoPlay
                playsInline
                muted={isMe} // Mute local video
            />
        );
    }, [isScreenSharing, isVideoOff, userName, isMe]);

    return (
        <div className={`${styles.videoContainer} ${isMe ? styles.myVideo : styles.peerVideo} ${isScreenSharing ? styles.screenShareView : ''}`}>
            {mainContent}
            <div className={styles.videoOverlay}>
                <div className={styles.videoNameTag}>
                    <span className={micClass}>{statusIcon}</span>
                    <p className="font-medium truncate">{userName} {isMe && '(You)'}</p>
                    {isScreenSharing && <ScreenShare size={20} className="ml-2 text-green-400" />}
                </div>
            </div>
        </div>
    );
};

// --- COMPONENTE CHAT ---
const ChatPanel = ({ messages, sendMessage, sendTTSMessage, audioOutputId }) => {
    const [inputText, setInputText] = useState('');
    const chatEndRef = useRef(null);

    const handleSubmit = (e, isTTS = false) => {
        e.preventDefault();
        if (inputText.trim() === '') return;

        if (isTTS) {
            sendTTSMessage(inputText.trim(), audioOutputId);
        } else {
            sendMessage(inputText.trim());
        }

        setInputText('');
    };

    useEffect(() => {
        chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);

    return (
        <div className={styles.chatPanel}>
            <div className={styles.chatHeader}>
                <MessageSquare size={20} />
                <h2>Room Chat</h2>
            </div>
            <div className={styles.chatMessages}>
                {messages.map((msg) => (
                    <div key={msg.id} className={`${styles.chatMessage} ${msg.isMe ? styles.myMessage : styles.peerMessage}`}>
                        <div className={styles.messageContent}>
                            <p className={styles.messageText}>{msg.text}</p>
                            <span className={styles.messageInfo}>
                                {msg.isTTS && <Volume2 size={12} className="inline-block mr-1" />}
                                {msg.user} • {msg.timestamp}
                            </span>
                        </div>
                    </div>
                ))}
                <div ref={chatEndRef} />
            </div>
            <form onSubmit={handleSubmit} className={styles.chatInputForm}>
                <input
                    type="text"
                    value={inputText}
                    onChange={(e) => setInputText(e.target.value)}
                    placeholder="Type a message..."
                    className={styles.chatInput}
                    required
                />
                <button type="button" onClick={(e) => handleSubmit(e, true)} className={`${styles.ttsButton} ${styles.controlButton}`}>
                    <Volume2 size={20} />
                </button>
                <button type="submit" className={styles.sendButton}>
                    <Send size={20} />
                </button>
            </form>
        </div>
    );
};


// --- COMPONENTE PRINCIPAL DE LA SALA DE REUNIÓN ---
const MeetingRoom = ({ handleLeave, userName, selectedAudioOutput }) => {
    const {
        myStream,
        peers,
        isMuted,
        isVideoOff,
        isScreenSharing,
        toggleMedia,
        toggleScreenShare,
        chatMessages,
        sendMessage,
        sendTTSMessage,
        appTheme,
        roomUsers,
        currentUserId,
        toggleTheme
    } = useWebRTC();

    const allPeers = useMemo(() => {
        const myPeer = {
            userId: currentUserId,
            userName: userName,
            stream: myStream,
            isMuted: isMuted,
            isVideoOff: isVideoOff,
            isScreenSharing: isScreenSharing,
            isMe: true
        };

        const otherPeers = Object.entries(peers).map(([userId, peer]) => ({
            userId,
            ...peer,
            isMe: false
        }));

        // Prioritize screen sharing views
        const sharingPeers = [myPeer, ...otherPeers].filter(p => p.isScreenSharing);
        const nonSharingPeers = [myPeer, ...otherPeers].filter(p => !p.isScreenSharing);

        // Put my video first among non-sharers
        const orderedPeers = [
            ...sharingPeers,
            ...nonSharingPeers.sort((a, b) => a.isMe ? -1 : (b.isMe ? 1 : 0))
        ];

        return orderedPeers;
    }, [myStream, peers, isMuted, isVideoOff, isScreenSharing, userName, currentUserId]);


    // Determine the layout class based on the number of users
    const videoGridClass = useMemo(() => {
        const count = allPeers.length;
        if (count === 1) return styles.grid1;
        if (count === 2) return styles.grid2;
        if (count <= 4) return styles.grid4;
        if (count <= 9) return styles.grid9;
        return styles.gridN;
    }, [allPeers.length]);

    const usersList = useMemo(() => {
        return Object.values(roomUsers).map(u => ({
            id: u.id,
            name: u.userName,
            isMe: u.peerId === currentUserId
        }));
    }, [roomUsers, currentUserId]);


    return (
        <div className={`${styles.roomContainer} ${appTheme === 'dark' ? '' : styles.lightMode}`}>
            <ToastContainer
                position="top-right"
                autoClose={3000}
                hideProgressBar={false}
                newestOnTop={false}
                closeOnClick
                rtl={false}
                pauseOnFocusLoss
                draggable
                pauseOnHover
                theme={appTheme}
            />
            {/* Header / Room Info */}
            <header className={styles.roomHeader}>
                <div className={styles.roomTitle}>
                    <p className="text-xl font-bold">WebRTC Meeting Room</p>
                    <p className="text-sm font-light">Room ID: main-room</p>
                </div>
                <div className={styles.roomActions}>
                    <div className={styles.userCount}>
                        <Users size={20} className="mr-2" />
                        {usersList.length} user{usersList.length !== 1 ? 's' : ''} online
                    </div>
                    <button onClick={toggleTheme} className={styles.themeToggle}>
                        {appTheme === 'dark' ? <Sun size={20} /> : <Moon size={20} />}
                    </button>
                </div>
            </header>

            {/* Main Content Area */}
            <main className={styles.mainContent}>
                {/* Video Grid */}
                <div className={`${styles.videoGrid} ${videoGridClass}`}>
                    {allPeers.map(peer => (
                        <VideoContainer
                            key={peer.userId}
                            stream={peer.isScreenSharing ? peer.stream : peer.stream}
                            userName={peer.userName}
                            isMuted={peer.isMuted}
                            isVideoOff={peer.isVideoOff}
                            isScreenSharing={peer.isScreenSharing}
                            isMe={peer.isMe}
                        />
                    ))}
                </div>

                {/* Chat Panel */}
                <ChatPanel
                    messages={chatMessages}
                    sendMessage={sendMessage}
                    sendTTSMessage={sendTTSMessage}
                    audioOutputId={selectedAudioOutput}
                />
            </main>

            {/* Controls Bar */}
            <footer className={styles.controlsBar}>
                <button
                    onClick={() => toggleMedia('audio')}
                    className={`${styles.controlButton} ${isMuted ? styles.controlOff : styles.controlOn}`}
                    title={isMuted ? "Unmute Microphone" : "Mute Microphone"}
                >
                    {isMuted ? <MicOff size={24} /> : <Mic size={24} />}
                </button>

                <button
                    onClick={() => toggleMedia('video')}
                    className={`${styles.controlButton} ${isVideoOff ? styles.controlOff : styles.controlOn}`}
                    title={isVideoOff ? "Turn On Video" : "Turn Off Video"}
                >
                    {isVideoOff ? <VideoOff size={24} /> : <Video size={24} />}
                </button>

                <button
                    onClick={toggleScreenShare}
                    className={`${styles.controlButton} ${isScreenSharing ? styles.controlSharing : styles.controlOn}`}
                    title={isScreenSharing ? "Stop Screen Share" : "Share Screen"}
                >
                    <ScreenShare size={24} />
                </button>

                <button
                    onClick={handleLeave}
                    className={`${styles.controlButton} ${styles.hangupButton}`}
                    title="Leave Meeting"
                >
                    <X size={24} />
                </button>
            </footer>
        </div>
    );
};

// --- COMPONENTE DE LOBBY (SETUP) ---
const Lobby = ({ onJoin }) => {
    const [userName, setUserName] = useState('');
    const [audioDevices, setAudioDevices] = useState([]);
    const [videoDevices, setVideoDevices] = useState([]);
    const [audioOutputDevices, setAudioOutputDevices] = useState([]);
    const [selectedAudioId, setSelectedAudioId] = useState('');
    const [selectedVideoId, setSelectedVideoId] = useState('');
    const [selectedAudioOutputId, setSelectedAudioOutputId] = useState('');
    const [isLoading, setIsLoading] = useState(true);
    const { appTheme, toggleTheme } = useWebRTCLogic(''); // Use logic hook to access theme/toggle

    const getMediaDevices = useCallback(async () => {
        try {
            // Request permissions first to populate device list labels
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
            stream.getTracks().forEach(track => track.stop());

            const devices = await navigator.mediaDevices.enumerateDevices();
            const audioIn = devices.filter(d => d.kind === 'audioinput');
            const videoIn = devices.filter(d => d.kind === 'videoinput');
            const audioOut = devices.filter(d => d.kind === 'audiooutput');

            setAudioDevices(audioIn);
            setVideoDevices(videoIn);
            setAudioOutputDevices(audioOut);

            if (audioIn.length > 0) setSelectedAudioId(audioIn[0].deviceId);
            if (videoIn.length > 0) setSelectedVideoId(videoIn[0].deviceId);
            if (audioOut.length > 0) setSelectedAudioOutputId(audioOut[0].deviceId);

        } catch (err) {
            console.error("Error enumerating devices:", err);
            toast.error("Could not access devices. Permissions denied or device issue.");
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        getMediaDevices();
    }, [getMediaDevices]);

    const handleJoinClick = (e) => {
        e.preventDefault();
        if (userName.trim()) {
            onJoin(userName.trim(), selectedAudioId, selectedVideoId, selectedAudioOutputId);
        } else {
            toast.error("Please enter your name.");
        }
    };

    if (isLoading) {
        return <div className={styles.loadingMessage}>Loading devices...</div>;
    }

    return (
        <div className={`${styles.lobbyContainer} ${appTheme === 'dark' ? '' : styles.lightMode}`}>
            <ToastContainer
                position="top-right"
                autoClose={3000}
                hideProgressBar={false}
                newestOnTop={false}
                closeOnClick
                rtl={false}
                pauseOnFocusLoss
                draggable
                pauseOnHover
                theme={appTheme}
            />
            <div className={styles.lobbyCard}>
                <div className={styles.lobbyHeader}>
                    <h1 className="text-3xl font-bold flex items-center">
                        <LogIn size={28} className="mr-3 text-[--primary-color]" />
                        Join the WebRTC Room
                    </h1>
                    <button onClick={toggleTheme} className={styles.themeToggle}>
                        {appTheme === 'dark' ? <Sun size={20} /> : <Moon size={20} />}
                    </button>
                </div>
                <form onSubmit={handleJoinClick} className={styles.lobbyForm}>
                    <div className={styles.formGroup}>
                        <label htmlFor="userName" className={styles.formLabel}>Your Name</label>
                        <input
                            id="userName"
                            type="text"
                            value={userName}
                            onChange={(e) => setUserName(e.target.value)}
                            placeholder="e.g., Jane Doe"
                            className={styles.formInput}
                            required
                        />
                    </div>

                    <div className={styles.formGroup}>
                        <label htmlFor="audioInput" className={styles.formLabel}>Microphone</label>
                        <select
                            id="audioInput"
                            value={selectedAudioId}
                            onChange={(e) => setSelectedAudioId(e.target.value)}
                            className={styles.formSelect}
                        >
                            {audioDevices.map(device => (
                                <option key={device.deviceId} value={device.deviceId}>
                                    {device.label || `Microphone (${device.deviceId})`}
                                </option>
                            ))}
                            {audioDevices.length === 0 && <option value="">No audio input devices found</option>}
                        </select>
                    </div>

                    <div className={styles.formGroup}>
                        <label htmlFor="videoInput" className={styles.formLabel}>Camera</label>
                        <select
                            id="videoInput"
                            value={selectedVideoId}
                            onChange={(e) => setSelectedVideoId(e.target.value)}
                            className={styles.formSelect}
                        >
                            {videoDevices.map(device => (
                                <option key={device.deviceId} value={device.deviceId}>
                                    {device.label || `Camera (${device.deviceId})`}
                                </option>
                            ))}
                            {videoDevices.length === 0 && <option value="">No video devices found</option>}
                        </select>
                    </div>

                    <div className={styles.formGroup}>
                        <label htmlFor="audioOutput" className={styles.formLabel}>Audio Output (For TTS)</label>
                        <select
                            id="audio-output-select" // Use this ID to access the value for playAudioBuffer
                            value={selectedAudioOutputId}
                            onChange={(e) => setSelectedAudioOutputId(e.target.value)}
                            className={styles.formSelect}
                        >
                            {audioOutputDevices.map(device => (
                                <option key={device.deviceId} value={device.deviceId}>
                                    {device.label || `Speaker (${device.deviceId})`}
                                </option>
                            ))}
                            {audioOutputDevices.length === 0 && <option value="">Default Speaker</option>}
                        </select>
                        <p className="text-sm text-gray-400 mt-1">This selects where TTS audio is played.</p>
                    </div>

                    <button type="submit" className={styles.joinButton}>
                        <LogIn size={24} className="mr-2" />
                        Join Meeting
                    </button>
                </form>
            </div>
        </div>
    );
};


// --- COMPONENTE PRINCIPAL DE LA APLICACIÓN CORREGIDO ---
export default function App() {
    const [isJoined, setIsJoined] = useState(false);
    const [userName, setUserName] = useState('');
    const [selectedAudioOutput, setSelectedAudioOutput] = useState('');
    // appTheme ahora se gestiona dentro de useWebRTCLogic
    const webRTCLogic = useWebRTCLogic('main-room');

    const handleJoin = async (name, audioId, videoId, audioOutputId) => {
        setUserName(name);
        setSelectedAudioOutput(audioOutputId);
        const stream = await webRTCLogic.initializeStream(audioId, videoId);
        if (stream) {
            webRTCLogic.connect(stream, name);
            setIsJoined(true);
        }
    };

    const handleLeave = () => {
        webRTCLogic.cleanup();
        setIsJoined(false);
        setUserName('');
        setSelectedAudioOutput('');
    };

    useEffect(() => {
        // Cleanup on component unmount
        return () => {
            webRTCLogic.cleanup();
        };
    }, [webRTCLogic]);

    if (!isJoined) {
        return <Lobby onJoin={handleJoin} />;
    } else {
        return (
            <WebRTCContext.Provider value={{ ...webRTCLogic, selectedAudioOutput }}>
                <MeetingRoom handleLeave={handleLeave} userName={userName} selectedAudioOutput={selectedAudioOutput} />
            </WebRTCContext.Provider>
        );
    }
}