import React, { useState, useEffect, useRef, createContext, useContext } from 'react';
import { Mic, MicOff, Video, VideoOff, ScreenShare, MessageSquare, Send, X, LogIn, Sun, Moon, Flame, UserPlus, Lock } from 'lucide-react'; 
import { io } from 'socket.io-client';
import Peer from 'peerjs';
import { ToastContainer, toast } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';
import styles from './App.module.css';

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
    const [appTheme, setAppTheme] = useState('dark'); 

    const [roomUsers, setRoomUsers] = useState({});

    const socketRef = useRef(null);
    const myPeerRef = useRef(null);
    const peerConnections = useRef({});

    const currentUserNameRef = useRef('');
    const screenSharePeer = useRef(null);

    const cleanup = () => {
        console.log("Limpiando conexiones...");
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
    };

    const initializeStream = async (audioDeviceId, videoDeviceId) => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: { deviceId: videoDeviceId ? { exact: videoDeviceId } : undefined },
                audio: { deviceId: audioDeviceId ? { exact: audioDeviceId } : undefined }
            });
            setMyStream(stream);
            console.log("Stream local inicializado. Pistas de audio:", stream.getAudioTracks().length, "Pistas de video:", stream.getVideoTracks().length);
            return stream;
        } catch (error) {
            console.error("Error al obtener stream de usuario:", error);
            toast.error("No se pudo acceder a la cámara o micrófono. Por favor, revisa los permisos.");
            return null;
        }
    };
    
    const connectToNewUser = (peerId, remoteUserName, stream, localUserName, isScreenShare = false) => {
        if (!myPeerRef.current || !stream) return;

        const callKey = peerId + (isScreenShare ? '_screen' : '');
        if (peerConnections.current[callKey]) {
            console.log(`[PeerJS] Ya existe una conexión con ${callKey}. Ignorando.`);
            return;
        }

        const metadata = { userName: localUserName, isScreenShare };
        console.log(`[PeerJS] Llamando a nuevo usuario ${remoteUserName} (${peerId}) con mi metadata:`, metadata);

        const call = myPeerRef.current.call(peerId, stream, { metadata });

        call.on('stream', (remoteStream) => {
            console.log(`[PeerJS] Stream recibido de mi llamada a: ${remoteUserName} (${peerId}). Es pantalla: ${isScreenShare}`);

            if (isScreenShare) {
                setPeers(prevPeers => ({
                    ...prevPeers,
                    'screen-share': {
                        stream: remoteStream,
                        userName: remoteUserName,
                        isScreenShare: true
                    }
                }));
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
            console.log(`[PeerJS] Mi llamada con ${peerId} (${isScreenShare ? 'pantalla' : 'cámara'}) cerrada.`);
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
            console.log('Mi ID de Peer es: ' + peerId);
            socketRef.current.emit('join-room', roomId, peerId, currentUserNameRef.current);
        });

        myPeerRef.current.on('call', (call) => {
            const { peer: peerId, metadata } = call;
            console.log(`[PeerJS] Llamada entrante de ${peerId}. Metadata recibida:`, metadata);

            const streamToSend = metadata.isScreenShare ? myScreenStream : myStream;
            if (streamToSend) {
                call.answer(streamToSend);
            } else {
                call.answer(stream);
            }

            call.on('stream', (remoteStream) => {
                console.log(`[PeerJS] Stream recibido de: ${peerId}. Nombre de metadata: ${metadata.userName}, Es pantalla: ${metadata.isScreenShare}`);

                if (metadata.isScreenShare) {
                    setPeers(prevPeers => {
                        const newPeers = { ...prevPeers };
                        const key = 'screen-share';
                        newPeers[key] = {
                            stream: remoteStream,
                            userName: metadata.userName || 'Usuario Desconocido',
                            isScreenShare: true
                        };
                        screenSharePeer.current = peerId;
                        return newPeers;
                    });
                } else {
                    setPeers(prevPeers => {
                        const newPeers = { ...prevPeers };
                        newPeers[peerId] = {
                            ...newPeers[peerId],
                            stream: remoteStream,
                            userName: metadata.userName || 'Usuario Desconocido',
                            isScreenShare: false
                        };
                        return newPeers;
                    });
                }
            });

            call.on('close', () => {
                console.log(`[PeerJS] Llamada cerrada con ${peerId}`);
                if (metadata.isScreenShare) {
                    removeScreenShare(peerId);
                } else {
                    removePeer(peerId);
                }
            });

            peerConnections.current[peerId + (metadata.isScreenShare ? '_screen' : '')] = call;
        });

        socketRef.current.on('room-users', ({ users }) => {
            console.log(`[Socket] Recibida lista de usuarios existentes:`, users);
            setRoomUsers(users);
            
            users.forEach(existingUser => {
                if (existingUser.userId !== myPeerRef.current.id) {
                    connectToNewUser(existingUser.userId, existingUser.userName, stream, currentUserNameRef.current);
                    
                    if (existingUser.isScreenShare) {
                        connectToNewUser(existingUser.userId, existingUser.userName, myScreenStream, currentUserNameRef.current, true);
                    }
                }
            });
        });
        
        socketRef.current.on('user-joined', ({ userId, userName: remoteUserName }) => {
            console.log(`[Socket] Usuario ${remoteUserName} (${userId}) se unió.`);
            setChatMessages(prev => [...prev, { type: 'system', text: `${remoteUserName} se ha unido.`, id: Date.now() }]);
            toast.info(`${remoteUserName} se ha unido a la sala.`);

            setPeers(prevPeers => ({
                ...prevPeers,
                [userId]: { stream: null, userName: remoteUserName, isScreenShare: false }
            }));

            connectToNewUser(userId, remoteUserName, stream, currentUserNameRef.current);

            if (myScreenStream && myPeerRef.current) {
                connectToNewUser(userId, remoteUserName, myScreenStream, currentUserNameRef.current, true);
            }
        });

        socketRef.current.on('user-disconnected', (userId, disconnectedUserName) => {
            console.log(`[Socket] Usuario ${disconnectedUserName} (${userId}) se desconectó.`);
            setChatMessages(prev => [...prev, { type: 'system', text: `${disconnectedUserName} se ha ido.`, id: Date.now() }]);
            toast.warn(`${disconnectedUserName} ha abandonado la sala.`);

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
            toast.success(`${user} reaccionó con ${emoji}`, {
                icon: emoji,
                autoClose: 2000,
                hideProgressBar: true,
                closeOnClick: true,
                pauseOnOnHover: false,
                draggable: false,
                position: "top-center",
            });
        });

        socketRef.current.on('user-started-screen-share', ({ userId, userName: remoteUserName }) => {
            console.log(`[Socket] ${remoteUserName} (${userId}) ha empezado a compartir pantalla.`);
            toast.info(`${remoteUserName} está compartiendo su pantalla.`);
            
            if (myPeerRef.current) {
                connectToNewUser(userId, remoteUserName, myStream, currentUserNameRef.current, true);
            }
        });

        socketRef.current.on('user-stopped-screen-share', (userId) => {
            console.log(`[Socket] Usuario ${userId} ha dejado de compartir pantalla.`);
            removeScreenShare(userId);
        });

        socketRef.current.on('theme-changed', (theme) => {
            console.log(`[Socket] Tema cambiado a: ${theme}`);
            setAppTheme(theme);
            toast.info(`El tema ha cambiado a ${theme}.`);
        });
    };

    const removePeer = (peerId) => {
        if (peerConnections.current[peerId]) {
            peerConnections.current[peerId].close();
            delete peerConnections.current[peerId];
        }
        setPeers(prev => {
            const newPeers = { ...prev };
            delete newPeers[peerId];
            return newPeers;
        });
    };

    const removeScreenShare = (peerId) => {
        if (screenSharePeer.current === peerId) {
            screenSharePeer.current = null;
            setPeers(prev => {
                const newPeers = { ...prev };
                delete newPeers['screen-share'];
                return newPeers;
            });
            const callKey = peerId + '_screen';
            if (peerConnections.current[callKey]) {
                peerConnections.current[callKey].close();
                delete peerConnections.current[callKey];
            }
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

    const sendThemeChange = (theme) => {
        if (socketRef.current) {
            socketRef.current.emit('change-theme', theme);
        }
    };

    const shareScreen = async () => {
        if (myScreenStream) {
            console.log("[ScreenShare] Deteniendo compartición de pantalla.");
            myScreenStream.getTracks().forEach(track => track.stop());
            setMyScreenStream(null); 
            socketRef.current.emit('stop-screen-share'); 

            Object.keys(peerConnections.current).forEach(key => {
                if (key.endsWith('_screen')) { 
                    peerConnections.current[key].close();
                    delete peerConnections.current[key];
                }
            });
            return; 
        }

        try {
            const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
            setMyScreenStream(screenStream);
            console.log("Stream de pantalla inicializado.");

            screenStream.getVideoTracks()[0].onended = () => {
                console.log("[ScreenShare] Compartición de pantalla finalizada por controles del navegador.");
                setMyScreenStream(null); 
                socketRef.current.emit('stop-screen-share'); 
                Object.keys(peerConnections.current).forEach(key => {
                    if (key.endsWith('_screen')) {
                        peerConnections.current[key].current.close();
                        delete peerConnections.current[key];
                    }
                });
            };

            socketRef.current.emit('start-screen-share', myPeerRef.current.id, currentUserNameRef.current);

            Object.keys(peerConnections.current).forEach(peerKey => {
                if (!peerKey.endsWith('_screen')) {
                    const peerId = peerKey;
                    if (peerId === myPeerRef.current?.id) return; 
                    connectToNewUser(peerId, peers[peerId]?.userName, screenStream, currentUserNameRef.current, true);
                }
            });

        } catch (err) {
            console.error("Error al compartir pantalla:", err);
            toast.error("No se pudo compartir la pantalla. Revisa los permisos.");
        }
    };

    return {
        myStream, myScreenStream, peers, chatMessages, isMuted, isVideoOff, appTheme, 
        initializeStream, connect, cleanup,
        toggleMute, toggleVideo, sendMessage, shareScreen, sendReaction, sendThemeChange, 
        currentUserName: currentUserNameRef.current
    };
};

// --- COMPONENTES DE LA UI ---

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
                {userName || 'Usuario Desconocido'} {isScreenShare && "(Pantalla)"}
            </div>
        </div>
    );
};

const VideoGrid = () => {
    const { myStream, myScreenStream, peers, currentUserName, selectedAudioOutput } = useWebRTC();

    const [isDesktop, setIsDesktop] = useState(window.innerWidth > 768);

    useEffect(() => {
        const handleResize = () => {
            setIsDesktop(window.innerWidth > 768);
        };
        window.addEventListener('resize', handleResize);
        return () => window.removeEventListener('resize', handleResize);
    }, []);

    const videoElements = [
        myStream && { id: 'my-video', stream: myStream, userName: `${currentUserName} (Tú)`, isLocal: true, muted: true },
        myScreenStream && { id: 'my-screen', stream: myScreenStream, userName: `${currentUserName} (Tú)`, isLocal: true, isScreenShare: true, muted: true },
        peers['screen-share'] && {
            id: 'remote-screen',
            stream: peers['screen-share'].stream,
            userName: peers['screen-share'].userName,
            isScreenShare: true
        },
        ...Object.entries(peers)
            .filter(([key, peerData]) => key !== 'screen-share' && peerData.stream)
            .map(([key, peerData]) => ({
                id: key,
                stream: peerData.stream,
                userName: peerData.userName,
                isScreenShare: false
            }))
    ].filter(Boolean);

    const isSharingScreen = videoElements.some(v => v.isScreenShare);
    const mainContent = isSharingScreen ? videoElements.find(v => v.isScreenShare) : null;
    const sideContent = videoElements.filter(v => !v.isScreenShare);

    const secondaryGridLayoutClass = isDesktop ? styles.desktopLayout : styles.mobileLayout;

    return (
        <div className={styles.videoGridContainer}>
            {mainContent && (
                <div className={styles.mainVideo}>
                    <VideoPlayer key={mainContent.id} {...mainContent} selectedAudioOutput={selectedAudioOutput} />
                </div>
            )}
            <div className={`${styles.videoSecondaryGrid} ${secondaryGridLayoutClass}`}>
                {sideContent.map(v => (
                    <VideoPlayer key={v.id} {...v} selectedAudioOutput={selectedAudioOutput} />
                ))}
            </div>
        </div>
    );
};


const Controls = ({ onToggleChat, onLeave }) => { 
    const { 
        toggleMute, toggleVideo, shareScreen, sendReaction, sendThemeChange, 
        isMuted, isVideoOff, myScreenStream, peers, appTheme 
    } = useWebRTC();
    
    const [isEmojiPickerOpen, setIsEmojiPickerOpen] = useState(false);
    const emojiPickerRef = useRef(null);
    
    const commonEmojis = appTheme === 'hot' 
    ? ['❤️', '🥵', '😍', '💋', '❤️‍🔥'] 
    : ['👍', '😆', '❤️', '🎉', '🥺'];

    const emojis = appTheme === 'hot'   
        ? [
            '🌶️', '🥵', '😈', '💋', '❤️‍🔥', '🔥', '🥰', '😏', '🤤', '🫦',
            '👄', '👅', '🍑', '🍆', '🍒', '💄', '👠', '👙', '🩲', '💦',
            '🕺', '😉', '😜', '😘', '🤭', '🙈', '🤑', '💎', '👑', '🫣'
         ]
        : [
            '👍', '👎', '👏', '🙌', '🤝', '🙏', '✋', '🖐️', '👌', '🤌', '🤏', '✌️', '🤘', '🖖', '👋',
            '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '😉', '😊', '😇', '🥰', '😍', '🤩', '😘', '☺️',
            '🥲', '😋', '😛', '😜', '😝', '🤑', '🤗', '🤭', '🤫', '🤨', '🤔', '🤐', '😐', '😑', '😶', '😏', '😒', '😬', '😮‍💨',
            '😌', '😔', '😪', '🤤', '😴', '😷', '🤒', '🤕', '🤢', '🤧', '🥵', '🥶', '🥴', '😵', '🤯', '🤠', '🥳', '😎',
            '😭', '😢', '😤', '😠', '😡', '😳', '🥺', '😱', '😨', '😥', '😓', '😞', '😟', '😣', '😫', '🥱',
            '💔', '💕', '💞', '💗', '💖', '💘', '🎉',
            '👀', '👄','🫦', '🫶', '💪'
        ];
    
    
    const handleSendReaction = (emoji) => {
        sendReaction(emoji);
        setIsEmojiPickerOpen(false);
    };

    const handleToggleEmojiPicker = () => {
        setIsEmojiPickerOpen(prev => !prev);
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
    const isViewingRemoteScreen = !!peers['screen-share']; 

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
                disabled={isViewingRemoteScreen && !isSharingMyScreen} 
            >
                <ScreenShare size={20} />
            </button>
            <button onClick={onToggleChat} className={styles.controlButton}>
                <MessageSquare size={20} />
            </button>
            <div className={styles.reactionContainer} ref={emojiPickerRef}>
                {commonEmojis.map((emoji) => (
                    <button
                        key={emoji}
                        onClick={() => handleSendReaction(emoji)}
                        className={`${styles.controlButton} ${styles.commonEmojiButton}`}
                    >
                        {emoji}
                    </button>
                ))}
                <button
                    onClick={handleToggleEmojiPicker}
                    className={`${styles.controlButton} ${styles.plusButton} ${isEmojiPickerOpen ? styles.controlButtonActive : ''}`}
                >
                    <Plus size={20} />
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
            <div className={styles.themeControls}>
                <button onClick={() => sendThemeChange('dark')} className={`${styles.controlButton} ${appTheme === 'dark' ? styles.controlButtonActive : ''}`}>
                    <Moon size={20} />
                </button>
                <button onClick={() => sendThemeChange('light')} className={`${styles.controlButton} ${appTheme === 'light' ? styles.controlButtonActive : ''}`}>
                    <Sun size={20} />
                </button>
                <button onClick={() => sendThemeChange('hot')} className={`${styles.controlButton} ${appTheme === 'hot' ? styles.controlButtonActive : ''}`}>
                    <Flame size={20} />
                </button>
            </div>
            <button onClick={onLeave} className={styles.leaveButton}>
                Salir
            </button>
        </footer>
    );
};

const ChatSidebar = ({ isOpen, onClose }) => { 
    const { chatMessages, sendMessage, currentUserName, appTheme } = useWebRTC(); 
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

    const chatTitleText = appTheme === 'hot' ? 'Chat de Mundi-Hot' : 'Chat de Mundi-Link';

    return (
        <aside className={`${styles.chatSidebar} ${isOpen ? styles.chatSidebarOpen : ''}`}>
            <header className={styles.chatHeader}>
                <h2 className={styles.chatTitle}>{chatTitleText}</h2>
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
                    placeholder="Escribe un mensaje..."
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
    const { appTheme } = useWebRTC(); 
    return (
        <div className={`${styles.mainContainer} ${styles[appTheme + 'Mode']}`}> 
            <main className={styles.mainContent}>
                <VideoGrid />
                <Controls onToggleChat={() => setIsChatOpen(o => !o)} onLeave={onLeave} /> 
            </main>
            <ChatSidebar isOpen={isChatOpen} onClose={() => setIsChatOpen(false)} /> 
        </div>
    );
};

const Lobby = ({ onJoin, authenticatedUserName }) => { // Ahora recibe authenticatedUserName
    const [userName, setUserName] = useState(authenticatedUserName || ''); // Usa el nombre de usuario autenticado
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
                // Pedir permisos primero para que los labels de los dispositivos no estén vacíos
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
                console.error("Error al enumerar dispositivos:", err);
                toast.error("No se pudo acceder a la cámara o micrófono. Por favor, verifica los permisos en tu navegador.");
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

    const lobbyTitleText = 'Unirse a Mundi-Link'; 

    return (
        <div className={`${styles.lobbyContainer} ${styles.darkMode}`}> 
            <div className={styles.lobbyFormWrapper}>
                <div className={styles.lobbyCard}>
                    <img src="logo512.png" alt="Mundi-Link Logo" className={styles.lobbyLogo} />
                    <h1 className={styles.lobbyTitle}>{lobbyTitleText}</h1>
                    <form onSubmit={handleSubmit} className={styles.lobbyForm}>
                        <div className={styles.formGroup}>
                            <label htmlFor="userName" className={styles.formLabel}>Tu nombre</label>
                            <input
                                id="userName" type="text" value={userName}
                                onChange={(e) => setUserName(e.target.value)}
                                placeholder="Ingresa tu nombre"
                                className={styles.formInput}
                                disabled={!!authenticatedUserName} // Deshabilitar si ya está autenticado
                            />
                        </div>
                        {isLoading ? (
                            <div className={styles.loadingMessage}>Cargando dispositivos...</div>
                        ) : (
                            <>
                                {videoDevices.length > 0 && (
                                    <div className={styles.formGroup}>
                                        <label htmlFor="videoDevice" className={styles.formLabel}>Cámara</label>
                                        <select id="videoDevice" value={selectedVideo} onChange={(e) => setSelectedVideo(e.target.value)}
                                            className={styles.formSelect}>
                                            {videoDevices.map(d => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}
                                        </select>
                                    </div>
                                )}
                                {audioDevices.length > 0 && (
                                    <div className={styles.formGroup}>
                                        <label htmlFor="audioDevice" className={styles.formLabel}>Micrófono</label>
                                        <select id="audioDevice" value={selectedAudio} onChange={(e) => setSelectedAudio(e.target.value)}
                                            className={styles.formSelect}>
                                            {audioDevices.map(d => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}
                                        </select>
                                    </div>
                                )}
                                {audioOutputs.length > 0 && (
                                    <div className={styles.formGroup}>
                                        <label htmlFor="audioOutputDevice" className={styles.formLabel}>Salida de Audio</label>
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
                            Unirse a la llamada
                        </button>
                    </form>
                </div>
            </div>
        </div>
    );
};

// --- Nuevo componente para la pantalla de Login/Registro ---
const AuthScreen = ({ onAuthSuccess }) => {
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [accessCode, setAccessCode] = useState('');
    const [isRegistering, setIsRegistering] = useState(false);
    const [loading, setLoading] = useState(false);

    const SERVER_BASE_URL = "https://meet-clone-v0ov.onrender.com"; // Asegúrate de que esta URL sea correcta

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        const endpoint = isRegistering ? `${SERVER_BASE_URL}/register` : `${SERVER_BASE_URL}/login`;

        try {
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ username, password, accessCode }),
            });

            const data = await response.json();

            if (response.ok) {
                toast.success(data.message);
                onAuthSuccess(username); // Pasa el nombre de usuario autenticado al componente padre
            } else {
                toast.error(data.message || 'Error en la autenticación.');
            }
        } catch (error) {
            console.error('Error de red o del servidor:', error);
            toast.error('No se pudo conectar con el servidor de autenticación.');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className={`${styles.lobbyContainer} ${styles.darkMode}`}> {/* Reutilizamos el estilo del lobby */}
            <div className={styles.lobbyFormWrapper}>
                <div className={styles.lobbyCard}>
                    <img src="logo512.png" alt="Mundi-Link Logo" className={styles.lobbyLogo} />
                    <h1 className={styles.lobbyTitle}>
                        {isRegistering ? 'Registrarse en Mundi-Link' : 'Iniciar Sesión en Mundi-Link'}
                    </h1>
                    <form onSubmit={handleSubmit} className={styles.lobbyForm}>
                        <div className={styles.formGroup}>
                            <label htmlFor="authUsername" className={styles.formLabel}>Nombre de usuario</label>
                            <input
                                id="authUsername" type="text" value={username}
                                onChange={(e) => setUsername(e.target.value)}
                                placeholder="Tu nombre de usuario"
                                className={styles.formInput}
                                required
                            />
                        </div>
                        <div className={styles.formGroup}>
                            <label htmlFor="authPassword" className={styles.formLabel}>Contraseña</label>
                            <input
                                id="authPassword" type="password" value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                placeholder="Tu contraseña"
                                className={styles.formInput}
                                required
                            />
                        </div>
                        <div className={styles.formGroup}>
                            <label htmlFor="authAccessCode" className={styles.formLabel}>Código de Acceso</label>
                            <input
                                id="authAccessCode" type="password" value={accessCode}
                                onChange={(e) => setAccessCode(e.target.value)}
                                placeholder="Código de acceso"
                                className={styles.formInput}
                                required
                            />
                        </div>
                        <button type="submit" disabled={loading || !username || !password || !accessCode} className={styles.joinButton}>
                            {loading ? 'Cargando...' : isRegistering ? <><UserPlus size={20} className={styles.joinButtonIcon} /> Registrarse</> : <><LogIn size={20} className={styles.joinButtonIcon} /> Iniciar Sesión</>}
                        </button>
                        <button 
                            type="button" 
                            onClick={() => setIsRegistering(prev => !prev)} 
                            className={styles.joinButton} 
                            style={{ backgroundColor: 'transparent', color: 'var(--primary-color)', boxShadow: 'none' }}
                            disabled={loading}
                        >
                            {isRegistering ? '¿Ya tienes una cuenta? Inicia Sesión' : '¿No tienes cuenta? Regístrate'}
                        </button>
                    </form>
                </div>
            </div>
        </div>
    );
};


// --- COMPONENTE PRINCIPAL DE LA APLICACIÓN CORREGIDO ---
export default function App() {
    const [isAuthenticated, setIsAuthenticated] = useState(false);
    const [authenticatedUserName, setAuthenticatedUserName] = useState(''); // Guarda el nombre de usuario autenticado
    const [isJoined, setIsJoined] = useState(false);
    const [selectedAudioOutput, setSelectedAudioOutput] = useState('');
    
    const webRTCLogic = useWebRTCLogic('main-room');

    const handleAuthSuccess = (username) => {
        setIsAuthenticated(true);
        setAuthenticatedUserName(username);
    };

    const handleJoin = async (name, audioId, videoId, audioOutputId) => {
        // Asegúrate de usar el nombre de usuario autenticado, o el que se ingresó si no se autenticó
        const finalUserName = authenticatedUserName || name; 
        setSelectedAudioOutput(audioOutputId);
        const stream = await webRTCLogic.initializeStream(audioId, videoId);
        if (stream) {
            webRTCLogic.connect(stream, finalUserName);
            setIsJoined(true);
        }
    };

    const handleLeave = () => {
        webRTCLogic.cleanup();
        setIsJoined(false);
        setIsAuthenticated(false); // Volver a la pantalla de autenticación al salir
        setAuthenticatedUserName('');
        setSelectedAudioOutput('');
    };

    useEffect(() => {
        window.addEventListener('beforeunload', webRTCLogic.cleanup);
        return () => {
            window.removeEventListener('beforeunload', webRTCLogic.cleanup);
        };
    }, [webRTCLogic]);

    if (!isAuthenticated) {
        return <AuthScreen onAuthSuccess={handleAuthSuccess} />;
    } else if (!isJoined) {
        return <Lobby onJoin={handleJoin} authenticatedUserName={authenticatedUserName} />;
    } else {
        return (
            <WebRTCContext.Provider value={{ ...webRTCLogic, selectedAudioOutput }}> 
                <CallRoom onLeave={handleLeave} /> 
                <ToastContainer />
            </WebRTCContext.Provider>
        );
    }
}
