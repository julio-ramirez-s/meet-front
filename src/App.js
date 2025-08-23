import React, { useState, useEffect, useRef, createContext, useContext, useCallback, memo, useMemo } from 'react';
import { Mic, MicOff, Video, VideoOff, ScreenShare, MessageSquare, Send, X, LogIn, Plus, Sun, Moon } from 'lucide-react';
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

    const socketRef = useRef(null);
    const myPeerRef = useRef(null);
    const peerConnections = useRef({});
    const currentUserNameRef = useRef('');
    const screenSharePeer = useRef(null);

    const cleanup = useCallback(() => {
        console.log("Limpiando conexiones...");
        myStream?.getTracks().forEach(track => track.stop());
        myScreenStream?.getTracks().forEach(track => track.stop());
        socketRef.current?.disconnect();
        myPeerRef.current?.destroy();
        
        setMyStream(null);
        setMyScreenStream(null);
        setPeers({});
        peerConnections.current = {};
        screenSharePeer.current = null;
    }, [myStream, myScreenStream]);

    const initializeStream = useCallback(async (audioDeviceId, videoDeviceId) => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: { deviceId: videoDeviceId ? { exact: videoDeviceId } : undefined },
                audio: { deviceId: audioDeviceId ? { exact: audioDeviceId } : undefined, echoCancellation: true, noiseSuppression: true }
            });
            setMyStream(stream);
            console.log("Stream local inicializado.");
            return stream;
        } catch (error) {
            console.error("Error al obtener stream de usuario:", error);
            toast.error("No se pudo acceder a la cámara o micrófono. Por favor, revisa los permisos.");
            return null;
        }
    }, []);
    
    const removePeer = useCallback((peerId) => {
        if (peerConnections.current[peerId]) {
            peerConnections.current[peerId].close();
            delete peerConnections.current[peerId];
        }
        setPeers(prev => {
            const newPeers = { ...prev };
            delete newPeers[peerId];
            return newPeers;
        });
    }, []);

    const removeScreenShare = useCallback((peerId) => {
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
    }, []);

    const connectToNewUser = useCallback((peerId, remoteUserName, stream, localUserName, isScreenShare = false) => {
        if (!myPeerRef.current || !stream) return;

        const callKey = peerId + (isScreenShare ? '_screen' : '');
        if (peerConnections.current[callKey]) {
            console.log(`[PeerJS] Ya existe una conexión con ${callKey}. Ignorando.`);
            return;
        }

        const metadata = { userName: localUserName, isScreenShare };
        const call = myPeerRef.current.call(peerId, stream, { metadata });

        call.on('stream', (remoteStream) => {
            setPeers(prevPeers => {
                if (isScreenShare) {
                    screenSharePeer.current = peerId;
                    return {
                        ...prevPeers,
                        'screen-share': { stream: remoteStream, userName: remoteUserName, isScreenShare: true }
                    };
                }
                return {
                    ...prevPeers,
                    [peerId]: { ...prevPeers[peerId], stream: remoteStream, userName: remoteUserName, isScreenShare: false }
                };
            });
        });

        call.on('close', () => {
            console.log(`[PeerJS] Mi llamada con ${peerId} (${isScreenShare ? 'pantalla' : 'cámara'}) cerrada.`);
            if (isScreenShare) removeScreenShare(peerId);
            else removePeer(peerId);
        });

        peerConnections.current[callKey] = call;
    }, [removePeer, removeScreenShare]);
    
    const connect = useCallback((stream, currentUserName) => {
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
            socketRef.current.emit('join-room', roomId, peerId, currentUserNameRef.current);
        });

        myPeerRef.current.on('call', (call) => {
            const { peer: peerId, metadata } = call;
            const streamToSend = metadata.isScreenShare ? myScreenStream : myStream;
            call.answer(streamToSend || stream);

            call.on('stream', (remoteStream) => {
                setPeers(prevPeers => {
                    if (metadata.isScreenShare) {
                        screenSharePeer.current = peerId;
                        return {
                            ...prevPeers,
                            'screen-share': { stream: remoteStream, userName: metadata.userName || 'Usuario Desconocido', isScreenShare: true }
                        };
                    }
                    return {
                        ...prevPeers,
                        [peerId]: { ...prevPeers[peerId], stream: remoteStream, userName: metadata.userName || 'Usuario Desconocido', isScreenShare: false }
                    };
                });
            });

            call.on('close', () => {
                if (metadata.isScreenShare) removeScreenShare(peerId);
                else removePeer(peerId);
            });

            peerConnections.current[peerId + (metadata.isScreenShare ? '_screen' : '')] = call;
        });

        socketRef.current.on('room-users', ({ users }) => {
            users.forEach(existingUser => {
                if (existingUser.userId !== myPeerRef.current.id) {
                    connectToNewUser(existingUser.userId, existingUser.userName, stream, currentUserNameRef.current);
                }
            });
        });
        
        socketRef.current.on('user-joined', ({ userId, userName: remoteUserName }) => {
            setChatMessages(prev => [...prev, { type: 'system', text: `${remoteUserName} se ha unido.`, id: Date.now() }]);
            toast.info(`${remoteUserName} se ha unido a la sala.`);
            connectToNewUser(userId, remoteUserName, stream, currentUserNameRef.current);
            if (myScreenStream) {
                connectToNewUser(userId, remoteUserName, myScreenStream, currentUserNameRef.current, true);
            }
        });

        socketRef.current.on('user-disconnected', (userId, disconnectedUserName) => {
            setChatMessages(prev => [...prev, { type: 'system', text: `${disconnectedUserName} se ha ido.`, id: Date.now() }]);
            toast.warn(`${disconnectedUserName} ha abandonado la sala.`);
            if (screenSharePeer.current === userId) removeScreenShare(userId);
            removePeer(userId);
        });

        socketRef.current.on('createMessage', (message, user) => {
            setChatMessages(prev => [...prev, { user, text: message, id: Date.now(), type: 'chat' }]);
        });

        socketRef.current.on('user-started-screen-share', ({ userId, userName: remoteUserName }) => {
            toast.info(`${remoteUserName} está compartiendo su pantalla.`);
            connectToNewUser(userId, remoteUserName, stream, currentUserNameRef.current, true);
        });

        socketRef.current.on('user-stopped-screen-share', (userId) => {
            removeScreenShare(userId);
        });
    }, [roomId, myStream, myScreenStream, connectToNewUser, removePeer, removeScreenShare]);

    const toggleMute = useCallback(() => {
        if (myStream) {
            const enabled = !myStream.getAudioTracks()[0].enabled;
            myStream.getAudioTracks().forEach(track => track.enabled = enabled);
            setIsMuted(!enabled);
        }
    }, [myStream]);

    const toggleVideo = useCallback(() => {
        if (myStream) {
            const enabled = !myStream.getVideoTracks()[0].enabled;
            myStream.getVideoTracks().forEach(track => track.enabled = enabled);
            setIsVideoOff(!enabled);
        }
    }, [myStream]);

    const sendMessage = useCallback((message) => {
        if (socketRef.current && message.trim()) {
            socketRef.current.emit('message', message);
        }
    }, []);

    const sendReaction = useCallback((emoji) => {
        socketRef.current?.emit('reaction', emoji);
    }, []);

    const shareScreen = useCallback(async () => {
        if (myScreenStream) {
            myScreenStream.getTracks().forEach(track => track.stop());
            setMyScreenStream(null);
            socketRef.current?.emit('stop-screen-share');
            Object.keys(peerConnections.current).forEach(key => {
                if (key.endsWith('_screen')) {
                    peerConnections.current[key].close();
                    delete peerConnections.current[key];
                }
            });
            return;
        }

        try {
            const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30 } }, audio: true });
            setMyScreenStream(screenStream);

            screenStream.getVideoTracks()[0].onended = () => {
                setMyScreenStream(null);
                socketRef.current?.emit('stop-screen-share');
                 Object.keys(peerConnections.current).forEach(key => {
                    if (key.endsWith('_screen')) {
                        peerConnections.current[key].close();
                        delete peerConnections.current[key];
                    }
                });
            };

            socketRef.current?.emit('start-screen-share', myPeerRef.current.id, currentUserNameRef.current);
            Object.keys(peers).forEach(peerId => {
                connectToNewUser(peerId, peers[peerId]?.userName, screenStream, currentUserNameRef.current, true);
            });
        } catch (err) {
            console.error("Error al compartir pantalla:", err);
            toast.error("No se pudo compartir la pantalla. Revisa los permisos.");
        }
    }, [myScreenStream, peers, connectToNewUser]);

    return {
        myStream, myScreenStream, peers, chatMessages, isMuted, isVideoOff,
        initializeStream, connect, cleanup,
        toggleMute, toggleVideo, sendMessage, shareScreen, sendReaction,
        currentUserName: currentUserNameRef.current
    };
};

// --- COMPONENTES DE LA UI (MEMOIZADOS) ---

const VideoPlayer = memo(({ stream, userName, muted = false, isScreenShare = false, isLocal = false, selectedAudioOutput }) => {
    const videoRef = useRef();

    useEffect(() => {
        if (videoRef.current) {
            videoRef.current.srcObject = stream;
            if (selectedAudioOutput && videoRef.current.setSinkId) {
                videoRef.current.setSinkId(selectedAudioOutput).catch(console.error);
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
});

const VideoGrid = memo(() => {
    const { myStream, myScreenStream, peers, currentUserName, selectedAudioOutput } = useWebRTC();
    const [isDesktop, setIsDesktop] = useState(window.innerWidth > 768);

    useEffect(() => {
        const handleResize = () => setIsDesktop(window.innerWidth > 768);
        window.addEventListener('resize', handleResize);
        return () => window.removeEventListener('resize', handleResize);
    }, []);

    const videoElements = useMemo(() => [
        myStream && { id: 'my-video', stream: myStream, userName: `${currentUserName} (Tú)`, isLocal: true, muted: true },
        myScreenStream && { id: 'my-screen', stream: myScreenStream, userName: `${currentUserName} (Tú)`, isLocal: true, isScreenShare: true, muted: true },
        peers['screen-share'] && { id: 'remote-screen', stream: peers['screen-share'].stream, userName: peers['screen-share'].userName, isScreenShare: true },
        ...Object.entries(peers)
            .filter(([key, peerData]) => key !== 'screen-share' && peerData.stream)
            .map(([key, peerData]) => ({ id: key, stream: peerData.stream, userName: peerData.userName }))
    ].filter(Boolean), [myStream, myScreenStream, peers, currentUserName]);

    const mainContent = useMemo(() => videoElements.find(v => v.isScreenShare), [videoElements]);
    const sideContent = useMemo(() => videoElements.filter(v => !v.isScreenShare), [videoElements]);

    return (
        <div className={styles.videoGridContainer}>
            {mainContent && (
                <div className={styles.mainVideo}>
                    <VideoPlayer {...mainContent} selectedAudioOutput={selectedAudioOutput} />
                </div>
            )}
            <div className={`${styles.videoSecondaryGrid} ${isDesktop ? styles.desktopLayout : styles.mobileLayout}`}>
                {sideContent.map(v => (
                    <VideoPlayer key={v.id} {...v} selectedAudioOutput={selectedAudioOutput} />
                ))}
            </div>
        </div>
    );
});

const Controls = memo(({ onToggleChat, onLeave, toggleTheme, isLightMode }) => {
    const { toggleMute, toggleVideo, shareScreen, sendReaction, isMuted, isVideoOff, myScreenStream, peers } = useWebRTC();
    const [isEmojiPickerOpen, setIsEmojiPickerOpen] = useState(false);
    const emojiPickerRef = useRef(null);

    const commonEmojis = useMemo(() => ['👍', '😂', '🎉', '❤️', '👏'], []);
    const emojis = useMemo(() => [ '👍', '👎', '👏', '🙌', '🙏', '👌', '✌️', '😂', '🙂', '😍', '🤩', '🤔', '😭', '🤯', '🥳', '😎', '💔', '🎉', '👀' ], []);
    
    const handleSendReaction = useCallback((emoji) => {
        sendReaction(emoji);
        setIsEmojiPickerOpen(false);
    }, [sendReaction]);

    useEffect(() => {
        const handleClickOutside = (event) => {
            if (emojiPickerRef.current && !emojiPickerRef.current.contains(event.target)) {
                setIsEmojiPickerOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

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
            <button onClick={shareScreen} className={`${styles.controlButton} ${isSharingMyScreen ? styles.controlButtonScreenShare : ''}`} disabled={isViewingRemoteScreen && !isSharingMyScreen}>
                <ScreenShare size={20} />
            </button>
            <button onClick={onToggleChat} className={styles.controlButton}>
                <MessageSquare size={20} />
            </button>
            <div className={styles.reactionContainer} ref={emojiPickerRef}>
                {commonEmojis.map((emoji) => (
                    <button key={emoji} onClick={() => handleSendReaction(emoji)} className={`${styles.controlButton} ${styles.commonEmojiButton}`}>{emoji}</button>
                ))}
                <button onClick={() => setIsEmojiPickerOpen(prev => !prev)} className={`${styles.controlButton} ${styles.plusButton} ${isEmojiPickerOpen ? styles.controlButtonActive : ''}`}>
                    <Plus size={20} />
                </button>
                {isEmojiPickerOpen && (
                    <div className={styles.emojiPicker}>
                        {emojis.map((emoji) => (
                            <button key={emoji} onClick={() => handleSendReaction(emoji)} className={styles.emojiButton}>{emoji}</button>
                        ))}
                    </div>
                )}
            </div>
            <button onClick={toggleTheme} className={styles.controlButton}>
                {isLightMode ? <Moon size={20} /> : <Sun size={20} />}
            </button>
            <button onClick={onLeave} className={styles.leaveButton}>Salir</button>
        </footer>
    );
});

const ChatSidebar = memo(({ isOpen, onClose }) => {
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
                <h2 className={styles.chatTitle}>Chat de Mundi-Link</h2>
                <button onClick={onClose} className={styles.closeChatButton}><X size={20} /></button>
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
                <input type="text" value={message} onChange={(e) => setMessage(e.target.value)} className={styles.chatInput} placeholder="Escribe un mensaje..." />
                <button type="submit" className={styles.chatSendButton}><Send size={18} /></button>
            </form>
        </aside>
    );
});

const CallRoom = ({ onLeave, toggleTheme, isLightMode }) => {
    const [isChatOpen, setIsChatOpen] = useState(false);
    const handleToggleChat = useCallback(() => setIsChatOpen(o => !o), []);

    return (
        <div className={`${styles.mainContainer} ${isLightMode ? styles.lightMode : ''}`}>
            <main className={styles.mainContent}>
                <VideoGrid />
                <Controls onToggleChat={handleToggleChat} onLeave={onLeave} toggleTheme={toggleTheme} isLightMode={isLightMode} />
            </main>
            <ChatSidebar isOpen={isChatOpen} onClose={handleToggleChat} />
        </div>
    );
};

// Hook personalizado para gestionar dispositivos
const useDeviceManager = () => {
    const [devices, setDevices] = useState({ video: [], audio: [], output: [] });
    const [selected, setSelected] = useState({ video: '', audio: '', output: '' });
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        const getDevices = async () => {
            try {
                await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
                const allDevices = await navigator.mediaDevices.enumerateDevices();
                const videoDevices = allDevices.filter(d => d.kind === 'videoinput');
                const audioDevices = allDevices.filter(d => d.kind === 'audioinput');
                const audioOutputs = allDevices.filter(d => d.kind === 'audiooutput');

                setDevices({ video: videoDevices, audio: audioDevices, output: audioOutputs });
                setSelected({
                    video: videoDevices[0]?.deviceId || '',
                    audio: audioDevices[0]?.deviceId || '',
                    output: audioOutputs[0]?.deviceId || ''
                });
            } catch (err) {
                toast.error("No se pudo acceder a la cámara o micrófono. Verifica los permisos.");
            } finally {
                setIsLoading(false);
            }
        };
        getDevices();
    }, []);

    return { devices, selected, setSelected, isLoading };
};

const Lobby = memo(({ onJoin }) => {
    const [userName, setUserName] = useState('');
    const { devices, selected, setSelected, isLoading } = useDeviceManager();

    const handleSubmit = (e) => {
        e.preventDefault();
        if (userName.trim()) {
            onJoin(userName, selected.audio, selected.video, selected.output);
        }
    };

    return (
        <div className={styles.lobbyContainer}>
            <div className={styles.lobbyFormWrapper}>
                <div className={styles.lobbyCard}>
                    <img src="logo512.png" alt="Mundi-Link Logo" className={styles.lobbyLogo} />
                    <h1 className={styles.lobbyTitle}>Unirse a Mundi-Link</h1>
                    <form onSubmit={handleSubmit} className={styles.lobbyForm}>
                        <div className={styles.formGroup}>
                            <label htmlFor="userName" className={styles.formLabel}>Tu nombre</label>
                            <input id="userName" type="text" value={userName} onChange={(e) => setUserName(e.target.value)} placeholder="Ingresa tu nombre" className={styles.formInput} />
                        </div>
                        {isLoading ? <div className={styles.loadingMessage}>Cargando dispositivos...</div> : (
                            <>
                                {devices.video.length > 0 && (
                                    <div className={styles.formGroup}>
                                        <label htmlFor="videoDevice" className={styles.formLabel}>Cámara</label>
                                        <select id="videoDevice" value={selected.video} onChange={(e) => setSelected(s => ({ ...s, video: e.target.value }))} className={styles.formSelect}>
                                            {devices.video.map(d => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}
                                        </select>
                                    </div>
                                )}
                                {devices.audio.length > 0 && (
                                    <div className={styles.formGroup}>
                                        <label htmlFor="audioDevice" className={styles.formLabel}>Micrófono</label>
                                        <select id="audioDevice" value={selected.audio} onChange={(e) => setSelected(s => ({ ...s, audio: e.target.value }))} className={styles.formSelect}>
                                            {devices.audio.map(d => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}
                                        </select>
                                    </div>
                                )}
                                {devices.output.length > 0 && (
                                    <div className={styles.formGroup}>
                                        <label htmlFor="audioOutputDevice" className={styles.formLabel}>Salida de Audio</label>
                                        <select id="audioOutputDevice" value={selected.output} onChange={(e) => setSelected(s => ({ ...s, output: e.target.value }))} className={styles.formSelect}>
                                            {devices.output.map(d => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}
                                        </select>
                                    </div>
                                )}
                            </>
                        )}
                        <button type="submit" disabled={!userName.trim() || isLoading} className={styles.joinButton}>
                            <LogIn className={styles.joinButtonIcon} size={20} /> Unirse a la llamada
                        </button>
                    </form>
                </div>
            </div>
        </div>
    );
});

// --- COMPONENTE PRINCIPAL DE LA APLICACIÓN ---
export default function App() {
    const [isJoined, setIsJoined] = useState(false);
    const [selectedAudioOutput, setSelectedAudioOutput] = useState('');
    const [isLightMode, setIsLightMode] = useState(false);
    const webRTCLogic = useWebRTCLogic('main-room');

    const handleJoin = useCallback(async (name, audioId, videoId, audioOutputId) => {
        setSelectedAudioOutput(audioOutputId);
        const stream = await webRTCLogic.initializeStream(audioId, videoId);
        if (stream) {
            webRTCLogic.connect(stream, name);
            setIsJoined(true);
        }
    }, [webRTCLogic]);

    const handleLeave = useCallback(() => {
        webRTCLogic.cleanup();
        setIsJoined(false);
    }, [webRTCLogic]);

    const toggleTheme = useCallback(() => {
        setIsLightMode(prevMode => !prevMode);
    }, []);

    useEffect(() => {
        const cleanup = webRTCLogic.cleanup;
        window.addEventListener('beforeunload', cleanup);
        return () => window.removeEventListener('beforeunload', cleanup);
    }, [webRTCLogic.cleanup]);

    if (!isJoined) {
        return <Lobby onJoin={handleJoin} />;
    }

    return (
        <WebRTCContext.Provider value={{ ...webRTCLogic, selectedAudioOutput }}>
            <CallRoom onLeave={handleLeave} toggleTheme={toggleTheme} isLightMode={isLightMode} />
            <ToastContainer position="bottom-right" theme={isLightMode ? "light" : "dark"}/>
        </WebRTCContext.Provider>
    );
}