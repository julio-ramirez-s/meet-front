import React, { useState, useEffect, useRef, createContext, useContext } from 'react';
import { Mic, MicOff, Video, VideoOff, ScreenShare, MessageSquare, Send, X, LogIn, PartyPopper } from 'lucide-react';
import { io } from 'socket.io-client';
import Peer from 'peerjs';
import { ToastContainer, toast } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';
import styles from './App.module.css';

// --- CONTEXT FOR WEBRTC ---
const WebRTCContext = createContext();
const useWebRTC = () => useContext(WebRTCContext);

// --- CUSTOM HOOK FOR WEBRTC LOGIC ---
const useWebRTCLogic = (roomId) => {
    const [myStream, setMyStream] = useState(null);
    const [myScreenStream, setMyScreenStream] = useState(null);
    const [peers, setPeers] = useState({});
    const [chatMessages, setChatMessages] = useState([]);
    const [isMuted, setIsMuted] = useState(false);
    const [isVideoOff, setIsVideoOff] = useState(false);
    
    // List of users in the room, including video and screen share status
    const [roomUsers, setRoomUsers] = useState([]);
    
    // State for the active remote screen share
    const [remoteScreenStream, setRemoteScreenStream] = useState(null);

    const socketRef = useRef(null);
    const myPeerRef = useRef(null);
    const peerConnections = useRef({});

    const currentUserNameRef = useRef('');
    const screenSharePeer = useRef(null);

    const cleanup = () => {
        console.log("Cleaning up connections...");
        if (myStream) {
            myStream.getTracks().forEach(track => track.stop());
        }
        if (myScreenStream) {
            myScreenStream.getTracks().forEach(track => track.stop());
        }
        if (socketRef.current) {
            socketRef.current.disconnect();
        }
        if (myPeerRef.current) {
            myPeerRef.current.destroy();
        }
        setMyStream(null);
        setMyScreenStream(null);
        setPeers({});
        peerConnections.current = {};
        screenSharePeer.current = null;
        setRemoteScreenStream(null);
    };

    const initializeStream = async (audioDeviceId, videoDeviceId) => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: { deviceId: videoDeviceId ? { exact: videoDeviceId } : undefined },
                audio: { deviceId: audioDeviceId ? { exact: audioDeviceId } : undefined }
            });
            setMyStream(stream);
            console.log("Local stream initialized. Audio tracks:", stream.getAudioTracks().length, "Video tracks:", stream.getVideoTracks().length);
            return stream;
        } catch (error) {
            console.error("Error getting user stream:", error);
            toast.error("Could not access camera or microphone. Please check your permissions.");
            return null;
        }
    };
    
    // Function to connect to a new user.
    const connectToNewUser = (peerId, remoteUserName, stream, localUserName, isScreenShare = false) => {
        if (!myPeerRef.current || !stream) return;

        // If we already have a connection with this user/stream, do nothing
        const callKey = peerId + (isScreenShare ? '_screen' : '');
        if (peerConnections.current[callKey]) {
            console.log(`[PeerJS] A connection with ${callKey} already exists. Ignoring.`);
            return;
        }

        const metadata = { userName: localUserName, isScreenShare };
        console.log(`[PeerJS] Calling new user ${remoteUserName} (${peerId}) with my metadata:`, metadata);

        // My local stream is used to initiate the call, the other side will respond with their stream
        const call = myPeerRef.current.call(peerId, stream, { metadata });

        call.on('stream', (remoteStream) => {
            console.log(`[PeerJS] Stream received from my call to: ${remoteUserName} (${peerId}). Is screen: ${isScreenShare}`);

            if (isScreenShare) {
                // New behavior: if it's a screen share, save it in the remote screen state, not in 'peers'.
                setRemoteScreenStream({
                    stream: remoteStream,
                    userName: remoteUserName,
                    isScreenShare: true,
                    peerId: peerId
                });
                screenSharePeer.current = peerId;
            } else {
                setPeers(prevPeers => ({
                    ...prevPeers,
                    [peerId]: {
                        ...prevPeers[peerId],
                        stream: remoteStream,
                        userName: remoteUserName,
                        isScreenShare: false
                    }
                }));
            }
        });

        call.on('close', () => {
            console.log(`[PeerJS] My call with ${peerId} (${isScreenShare ? 'screen' : 'camera'}) closed.`);
            if (isScreenShare) {
                removeScreenShare(peerId);
            } else {
                removePeer(peerId);
            }
        });

        peerConnections.current[callKey] = call;
    };
    
    const connect = (stream, currentUserName) => {
        currentUserNameRef.current = currentUserName;

        const SERVER_URL = "https://meet-clone-v0ov.onrender.com";

        socketRef.current = io(SERVER_URL);
        myPeerRef.current = new Peer(undefined, {
            host: new URL(SERVER_URL).hostname,
            port: new URL(SERVER_URL).port || 443,
            path: '/peerjs/myapp',
            secure: true,
        });

        myPeerRef.current.on('open', (peerId) => {
            console.log('My Peer ID is: ' + peerId);
            socketRef.current.emit('join-room', roomId, peerId, currentUserNameRef.current);
        });

        myPeerRef.current.on('call', (call) => {
            const { peer: peerId, metadata } = call;
            console.log(`[PeerJS] Incoming call from ${peerId}. Metadata received:`, metadata);

            // Respond to the call with my video or screen share stream
            const streamToSend = metadata.isScreenShare ? myScreenStream : myStream;
            if (streamToSend) {
                call.answer(streamToSend);
            } else {
                call.answer(stream); // If I don't have a screen stream, I respond with the video stream
            }

            call.on('stream', (remoteStream) => {
                console.log(`[PeerJS] Stream received from: ${peerId}. Metadata name: ${metadata.userName}, Is screen: ${metadata.isScreenShare}`);

                if (metadata.isScreenShare) {
                     setRemoteScreenStream({
                        stream: remoteStream,
                        userName: metadata.userName || 'Unknown User',
                        isScreenShare: true,
                        peerId: peerId
                    });
                    screenSharePeer.current = peerId;
                } else {
                    setPeers(prevPeers => {
                        const newPeers = { ...prevPeers };
                        newPeers[peerId] = {
                            ...newPeers[peerId],
                            stream: remoteStream,
                            userName: metadata.userName || 'Unknown User',
                            isScreenShare: false
                        };
                        return newPeers;
                    });
                }
            });

            call.on('close', () => {
                console.log(`[PeerJS] Call with ${peerId} closed.`);
                if (metadata.isScreenShare) {
                    removeScreenShare(peerId);
                } else {
                    removePeer(peerId);
                }
            });

            peerConnections.current[peerId + (metadata.isScreenShare ? '_screen' : '')] = call;
        });

        // LÓGICA CORREGIDA: When a new user joins, they receive the list of all users
        // and automatically connect to their video and screen share streams if they are sharing.
        socketRef.current.on('room-users', ({ users }) => {
            console.log(`[Socket] Received list of existing users:`, users);
            setRoomUsers(users);
            
            // A new user joins the room. They must initiate calls to all existing users.
            users.forEach(existingUser => {
                if (existingUser.userId !== myPeerRef.current.id) {
                    // Call for video stream
                    connectToNewUser(existingUser.userId, existingUser.userName, stream, currentUserNameRef.current);
                    
                    // If the user is already sharing their screen, also connect to that stream.
                    if (existingUser.isScreenShare) {
                        connectToNewUser(existingUser.userId, existingUser.userName, stream, currentUserNameRef.current, true);
                    }
                }
            });
        });
        
        socketRef.current.on('user-joined', ({ userId, userName: remoteUserName }) => {
            console.log(`[Socket] User ${remoteUserName} (${userId}) joined.`);
            setChatMessages(prev => [...prev, { type: 'system', text: `${remoteUserName} has joined.`, id: Date.now() }]);
            toast.info(`${remoteUserName} has joined the room.`);

            setPeers(prevPeers => ({
                ...prevPeers,
                [userId]: { stream: null, userName: remoteUserName, isScreenShare: false }
            }));

            // LÓGICA CORREGIDA: An existing user calls the new user with their video stream.
            connectToNewUser(userId, remoteUserName, myStream, currentUserNameRef.current, false);

            // If the existing user is sharing their screen, they also call the new user with the screen stream.
            if (myScreenStream) {
                connectToNewUser(userId, remoteUserName, myScreenStream, currentUserNameRef.current, true);
            }
        });

        socketRef.current.on('user-disconnected', (userId, disconnectedUserName) => {
            console.log(`[Socket] User ${disconnectedUserName} (${userId}) disconnected.`);
            setChatMessages(prev => [...prev, { type: 'system', text: `${disconnectedUserName} has left.`, id: Date.now() }]);
            toast.warn(`${disconnectedUserName} has left the room.`);

            if (screenSharePeer.current === userId) {
                removeScreenShare(userId);
            }
            removePeer(userId);
        });

        socketRef.current.on('createMessage', (message, user) => {
            setChatMessages(prev => [...prev, { user, text: message, id: Date.now(), type: 'chat' }]);
            toast.info(`${user}: ${message}`, {
                autoClose: 3000,
                hideProgressBar: true,
                closeOnClick: true,
                pauseOnHover: true,
                draggable: true,
            });
        });

        socketRef.current.on('reaction-received', (emoji, user) => {
            toast.success(`${user} reacted with ${emoji}`, {
                icon: emoji,
                autoClose: 2000,
                hideProgressBar: true,
                closeOnClick: true,
                pauseOnOnHover: false,
                draggable: false,
                position: "top-center",
            });
        });

        // When a user starts sharing, the other users connect to that screen stream
        socketRef.current.on('user-started-screen-share', ({ userId, userName: remoteUserName }) => {
            console.log(`[Socket] ${remoteUserName} (${userId}) has started screen sharing.`);
            toast.info(`${remoteUserName} is sharing their screen.`);
            
            // If it's not me sharing and I'm not already viewing a screen, I connect.
            if(myPeerRef.current.id !== userId && !remoteScreenStream) {
                connectToNewUser(userId, remoteUserName, myStream, currentUserNameRef.current, true);
            }
        });

        socketRef.current.on('user-stopped-screen-share', (userId) => {
            console.log(`[Socket] User ${userId} has stopped screen sharing.`);
            if (remoteScreenStream && remoteScreenStream.peerId === userId) {
                setRemoteScreenStream(null);
            }
            removeScreenShare(userId);
            // Update the list of room users
            setRoomUsers(prev => prev.map(user => user.userId === userId ? {...user, isScreenShare: false} : user));
        });
    };

    const removePeer = (peerId) => {
        const callKey = peerId;
        if (peerConnections.current[callKey]) {
            peerConnections.current[callKey].close();
            delete peerConnections.current[callKey];
        }
        setPeers(prev => {
            const newPeers = { ...prev };
            delete newPeers[peerId];
            return newPeers;
        });
    };

    const removeScreenShare = (peerId) => {
        const callKey = peerId + '_screen';
        if (peerConnections.current[callKey]) {
            peerConnections.current[callKey].close();
            delete peerConnections.current[callKey];
        }

        // If the screen we are viewing is the one that stopped, we remove it
        if (remoteScreenStream && remoteScreenStream.peerId === peerId) {
            setRemoteScreenStream(null);
        }
    };


    const toggleMute = () => {
        if (myStream) {
            myStream.getAudioTracks().forEach(track => track.enabled = !track.enabled);
            setIsMuted(prev => !prev);
        }
    };

    const toggleVideo = () => {
        if (myStream) {
            myStream.getVideoTracks().forEach(track => track.enabled = !track.enabled);
            setIsVideoOff(prev => !prev);
        }
    };

    const sendMessage = (message) => {
        if (socketRef.current && message.trim()) {
            socketRef.current.emit('message', message);
        }
    };

    const sendReaction = (emoji) => {
        if (socketRef.current) {
            socketRef.current.emit('reaction', emoji);
        }
    };

    const shareScreen = async () => {
        // Logic to stop screen sharing if it's already active
        if (myScreenStream) {
            console.log("[ScreenShare] Stopping screen sharing.");
            myScreenStream.getTracks().forEach(track => track.stop());
            socketRef.current.emit('stop-screen-share');
            setMyScreenStream(null);
            return;
        }

        try {
            const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
            setMyScreenStream(screenStream);
            console.log("Screen stream initialized.");

            // When the user stops sharing from the browser (bar button), we emit the event
            screenStream.getVideoTracks()[0].onended = () => {
                setMyScreenStream(null);
                socketRef.current.emit('stop-screen-share');
            };

            // Notify the server that we are sharing the screen
            socketRef.current.emit('start-screen-share', myPeerRef.current.id, currentUserNameRef.current);
            
            // CORRECTED LOGIC: We call all existing peers to connect to my screen stream
            Object.keys(peers).forEach(peerId => {
                const peerData = peers[peerId];
                console.log(`[ScreenShare] Calling peer ${peerId} to share my screen...`);
                // We use connectToNewUser with the screen stream and the isScreenShare flag set to true
                connectToNewUser(peerId, peerData.userName, screenStream, currentUserNameRef.current, true);
            });

        } catch (err) {
            console.error("Error sharing screen:", err);
            toast.error("Could not share the screen. Check your permissions.");
        }
    };

    return {
        myStream, myScreenStream, peers, chatMessages, isMuted, isVideoOff,
        initializeStream, connect, cleanup,
        toggleMute, toggleVideo, sendMessage, shareScreen, sendReaction,
        currentUserName: currentUserNameRef.current,
        roomUsers, remoteScreenStream
    };
};

// --- UI COMPONENTS ---

const VideoPlayer = ({ stream, userName, muted = false, isScreenShare = false, isLocal = false, selectedAudioOutput }) => {
    const videoRef = useRef();

    useEffect(() => {
        if (videoRef.current && stream) {
            videoRef.current.srcObject = stream;

            if (selectedAudioOutput && videoRef.current.setSinkId) {
                videoRef.current.setSinkId(selectedAudioOutput)
                    .then(() => {
                        console.log(`Audio output set to device ID: ${selectedAudioOutput}`);
                    })
                    .catch(error => {
                        console.error("Error setting audio output:", error);
                    });
            }
        }
    }, [stream, selectedAudioOutput]);

    return (
        <div className={styles.videoWrapper}>
            <video
                ref={videoRef}
                playsInline
                autoPlay
                muted={muted}
                className={`${styles.videoElement} ${isLocal && !isScreenShare ? styles.localVideo : ''}`}
            />
            <div className={styles.userNameLabel}>
                {userName || 'Unknown User'} {isScreenShare && "(Screen)"}
            </div>
        </div>
    );
};

const VideoGrid = () => {
    const { myStream, myScreenStream, peers, currentUserName, selectedAudioOutput, remoteScreenStream } = useWebRTC();

    const videoElements = [
        myStream && { id: 'my-video', stream: myStream, userName: `${currentUserName} (You)`, isLocal: true, muted: true },
        myScreenStream && { id: 'my-screen', stream: myScreenStream, userName: `${currentUserName} (You)`, isLocal: true, isScreenShare: true, muted: true },
        // The remote screen that is being actively viewed
        remoteScreenStream && {
            id: 'remote-screen',
            stream: remoteScreenStream.stream,
            userName: remoteScreenStream.userName,
            isScreenShare: true
        },
        ...Object.entries(peers)
            .filter(([key, peerData]) => peerData.stream)
            .map(([key, peerData]) => ({
                id: key,
                stream: peerData.stream,
                userName: peerData.userName,
                isScreenShare: false
            }))
    ].filter(Boolean);

    const isSharingScreen = myScreenStream || remoteScreenStream;
    const mainContent = isSharingScreen ? videoElements.find(v => v.isScreenShare) : null;
    const sideContent = videoElements.filter(v => !v.isScreenShare);

    const getGridLayoutClass = (count) => {
        if (count <= 1) return styles.grid_1;
        if (count === 2) return styles.grid_2;
        if (count <= 4) return styles.grid_4;
        if (count <= 6) return styles.grid_6;
        return styles.grid_8_plus;
    };

    const gridLayoutClass = getGridLayoutClass(sideContent.length);

    return (
        <div className={styles.videoGridContainer}>
            {mainContent && (
                <div className={styles.mainVideo}>
                    <VideoPlayer key={mainContent.id} {...mainContent} selectedAudioOutput={selectedAudioOutput} />
                </div>
            )}
            <div className={`${styles.videoSecondaryGrid} ${gridLayoutClass}`}>
                {sideContent.map(v => (
                    <VideoPlayer key={v.id} {...v} selectedAudioOutput={selectedAudioOutput} />
                ))}
            </div>
        </div>
    );
};

const Controls = ({ onToggleChat, onLeave }) => {
    const { 
        toggleMute, toggleVideo, shareScreen, sendReaction,
        isMuted, isVideoOff, myScreenStream, remoteScreenStream
    } = useWebRTC();
    
    const [isEmojiPickerOpen, setIsEmojiPickerOpen] = useState(false);
    const emojiPickerRef = useRef(null);
    const emojis = ['👍', '❤️', '�', '😂', '🔥', '👏', '😢', '🤔', '👀', '🥳'];

    const handleSendReaction = (emoji) => {
        sendReaction(emoji);
        setIsEmojiPickerOpen(false);
    };

    useEffect(() => {
        const handleClickOutside = (event) => {
            if (emojiPickerRef.current && !emojiPickerRef.current.contains(event.target)) {
                setIsEmojiPickerOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
        };
    }, [emojiPickerRef]);

    const isSharingMyScreen = !!myScreenStream;
    const isViewingRemoteScreen = !!remoteScreenStream;
    
    return (
        <footer className={styles.controlsFooter}>
            <button onClick={toggleMute} className={`${styles.controlButton} ${isMuted ? styles.controlButtonActive : ''}`}>
                {isMuted ? <MicOff size={20} /> : <Mic size={20} />}
            </button>
            <button onClick={toggleVideo} className={`${styles.controlButton} ${isVideoOff ? styles.controlButtonActive : ''}`}>
                {isVideoOff ? <VideoOff size={20} /> : <Video size={20} />}
            </button>
            <button 
                onClick={shareScreen} 
                className={`${styles.controlButton} ${isSharingMyScreen ? styles.controlButtonScreenShare : ''}`}
                disabled={isViewingRemoteScreen}
            >
                <ScreenShare size={20} />
            </button>
            <button onClick={onToggleChat} className={styles.controlButton}>
                <MessageSquare size={20} />
            </button>
            <div className={styles.reactionContainer} ref={emojiPickerRef}>
                <button
                    onClick={() => setIsEmojiPickerOpen(prev => !prev)}
                    className={`${styles.controlButton} ${isEmojiPickerOpen ? styles.controlButtonActive : ''}`}
                >
                    <PartyPopper size={20} />
                </button>
                {isEmojiPickerOpen && (
                    <div className={styles.emojiPicker}>
                        {emojis.map((emoji) => (
                            <button
                                key={emoji}
                                onClick={() => handleSendReaction(emoji)}
                                className={styles.emojiButton}
                            >
                                {emoji}
                            </button>
                        ))}
                    </div>
                )}
            </div>
            <button onClick={onLeave} className={styles.leaveButton}>
                Leave
            </button>
        </footer>
    );
};

const ChatSidebar = ({ isOpen, onClose }) => {
    const { chatMessages, sendMessage, currentUserName } = useWebRTC();
    const [message, setMessage] = useState('');
    const messagesEndRef = useRef(null);

    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [chatMessages]);

    const handleSend = (e) => {
        e.preventDefault();
        if (message.trim()) {
            sendMessage(message);
            setMessage('');
        }
    };

    return (
        <aside className={`${styles.chatSidebar} ${isOpen ? styles.chatSidebarOpen : ''}`}>
            <header className={styles.chatHeader}>
                <h2 className={styles.chatTitle}>Chat</h2>
                <button onClick={onClose} className={styles.closeChatButton}>
                    <X size={20} />
                </button>
            </header>
            <div className={styles.chatMessages}>
                {chatMessages.map((msg) => {
                    if (msg.type === 'system') {
                        return <div key={msg.id} className={styles.systemMessage}>{msg.text}</div>;
                    }
                    const isMe = msg.user === currentUserName;
                    return (
                        <div key={msg.id} className={`${styles.chatMessageWrapper} ${isMe ? styles.chatMessageWrapperMe : ''}`}>
                            <div className={`${styles.chatMessage} ${isMe ? styles.chatMessageMe : ''}`}>
                                {!isMe && <div className={styles.chatUserName}>{msg.user}</div>}
                                <p className={styles.chatMessageText}>{msg.text}</p>
                            </div>
                        </div>
                    );
                })}
                <div ref={messagesEndRef} />
            </div>
            <form onSubmit={handleSend} className={styles.chatForm}>
                <input
                    type="text"
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    className={styles.chatInput}
                    placeholder="Write a message..."
                />
                <button type="submit" className={styles.chatSendButton}>
                    <Send size={18} />
                </button>
            </form>
        </aside>
    );
};

const CallRoom = ({ onLeave }) => {
    const [isChatOpen, setIsChatOpen] = useState(false);
    return (
        <div className={styles.mainContainer}>
            <main className={styles.mainContent}>
                <VideoGrid />
                <Controls onToggleChat={() => setIsChatOpen(o => !o)} onLeave={onLeave} />
            </main>
            <ChatSidebar isOpen={isChatOpen} onClose={() => setIsChatOpen(false)} />
        </div>
    );
};

const Lobby = ({ onJoin }) => {
    const [userName, setUserName] = useState('');
    const [videoDevices, setVideoDevices] = useState([]);
    const [audioDevices, setAudioDevices] = useState([]);
    const [audioOutputs, setAudioOutputs] = useState([]);
    const [selectedVideo, setSelectedVideo] = useState('');
    const [selectedAudio, setSelectedAudio] = useState('');
    const [selectedAudioOutput, setSelectedAudioOutput] = useState('');
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        const getDevices = async () => {
            try {
                await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
                const devices = await navigator.mediaDevices.enumerateDevices();
                const videoInputs = devices.filter(d => d.kind === 'videoinput');
                const audioInputs = devices.filter(d => d.kind === 'audioinput');
                const audioOutputs = devices.filter(d => d.kind === 'audiooutput');

                setVideoDevices(videoInputs);
                setAudioDevices(audioInputs);
                setAudioOutputs(audioOutputs);

                if (videoInputs.length > 0) setSelectedVideo(videoInputs[0].deviceId);
                if (audioInputs.length > 0) setSelectedAudio(audioInputs[0].deviceId);
                if (audioOutputs.length > 0) setSelectedAudioOutput(audioOutputs[0].deviceId);

            } catch (err) {
                console.error("Error enumerating devices:", err);
                toast.error("Could not access camera or microphone. Please check your browser permissions.");
            } finally {
                setIsLoading(false);
            }
        };
        getDevices();
    }, []);

    const handleSubmit = (e) => {
        e.preventDefault();
        if (userName.trim()) {
            onJoin(userName, selectedAudio, selectedVideo, selectedAudioOutput);
        }
    };

    return (
        <div className={styles.lobbyContainer}>
            <div className={styles.lobbyFormWrapper}>
                <div className={styles.lobbyCard}>
                    <h1 className={styles.lobbyTitle}>Join Room</h1>
                    <form onSubmit={handleSubmit} className={styles.lobbyForm}>
                        <div className={styles.formGroup}>
                            <label htmlFor="userName" className={styles.formLabel}>Your name</label>
                            <input
                                id="userName" type="text" value={userName}
                                onChange={(e) => setUserName(e.target.value)}
                                placeholder="Enter your name"
                                className={styles.formInput}
                            />
                        </div>
                        {isLoading ? (
                            <div className={styles.loadingMessage}>Loading devices...</div>
                        ) : (
                            <>
                                {videoDevices.length > 0 && (
                                    <div className={styles.formGroup}>
                                        <label htmlFor="videoDevice" className={styles.formLabel}>Camera</label>
                                        <select id="videoDevice" value={selectedVideo} onChange={(e) => setSelectedVideo(e.target.value)}
                                            className={styles.formSelect}>
                                            {videoDevices.map(d => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}
                                        </select>
                                    </div>
                                )}
                                {audioDevices.length > 0 && (
                                    <div className={styles.formGroup}>
                                        <label htmlFor="audioDevice" className={styles.formLabel}>Microphone</label>
                                        <select id="audioDevice" value={selectedAudio} onChange={(e) => setSelectedAudio(e.target.value)}
                                            className={styles.formSelect}>
                                            {audioDevices.map(d => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}
                                        </select>
                                    </div>
                                )}
                                {audioOutputs.length > 0 && (
                                    <div className={styles.formGroup}>
                                        <label htmlFor="audioOutputDevice" className={styles.formLabel}>Audio Output</label>
                                        <select id="audioOutputDevice" value={selectedAudioOutput} onChange={(e) => setSelectedAudioOutput(e.target.value)}
                                            className={styles.formSelect}>
                                            {audioOutputs.map(d => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}
                                        </select>
                                    </div>
                                )}
                            </>
                        )}
                        <button type="submit" disabled={!userName.trim() || isLoading} className={styles.joinButton}>
                            <LogIn className={styles.joinButtonIcon} size={20} />
                            Join
                        </button>
                    </form>
                </div>
            </div>
        </div>
    );
};


// --- MAIN APPLICATION COMPONENT ---
export default function App() {
    const [isJoined, setIsJoined] = useState(false);
    const [userName, setUserName] = useState('');
    const [selectedAudioOutput, setSelectedAudioOutput] = useState('');
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
        window.addEventListener('beforeunload', webRTCLogic.cleanup);
        return () => {
            window.removeEventListener('beforeunload', webRTCLogic.cleanup);
        };
    }, [webRTCLogic]);

    if (!isJoined) {
        return <Lobby onJoin={handleJoin} />;
    } else {
        return (
            <WebRTCContext.Provider value={{ ...webRTCLogic, selectedAudioOutput }}>
                <CallRoom onLeave={handleLeave} />
                <ToastContainer />
            </WebRTCContext.Provider>
        );
    }
}
