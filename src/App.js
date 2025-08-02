import React, { useState, useEffect, useRef, createContext, useContext } from 'react';
import { Mic, MicOff, Video, VideoOff, ScreenShare, MessageSquare, Send, X, LogIn, Settings, Users, ArrowLeft } from 'lucide-react';
import { io } from 'socket.io-client';
import Peer from 'peerjs';
import styles from './App.module.css'; 
// --- CONTEXTO PARA WEBRTC ---
const WebRTCContext = createContext();
const useWebRTC = () => useContext(WebRTCContext);

// --- HOOK PERSONALIZADO PARA LA LÓGICA DE WEBRTC ---
const useWebRTCLogic = (roomId, userName) => {
    const [myStream, setMyStream] = useState(null);
    const [myScreenStream, setMyScreenStream] = useState(null);
    const [peers, setPeers] = useState({});
    const [chatMessages, setChatMessages] = useState([]);
    const [isMuted, setIsMuted] = useState(false);
    const [isVideoOff, setIsVideoOff] = useState(false);
    
    const socketRef = useRef(null);
    const myPeerRef = useRef(null);
    const peerConnections = useRef({});

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
    };

    const initializeStream = async (audioDeviceId, videoDeviceId) => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: { deviceId: videoDeviceId ? { exact: videoDeviceId } : undefined },
                audio: { deviceId: audioDeviceId ? { exact: audioDeviceId } : undefined }
            });
            setMyStream(stream);
            return stream;
        } catch (error) {
            console.error("Error al obtener stream de usuario:", error);
            alert("No se pudo acceder a la cámara o micrófono. Por favor, revisa los permisos.");
            return null;
        }
    };
    
    const connect = (stream) => {
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
            socketRef.current.emit('join-room', roomId, peerId, userName);
        });

        myPeerRef.current.on('call', (call) => {
            const { peer: peerId, metadata } = call;
            console.log(`Recibiendo llamada de ${peerId} con metadata:`, metadata);
            
            const streamToSend = metadata.isScreenShare ? myScreenStream : myStream;
            if(streamToSend) {
                call.answer(streamToSend);
            } else {
                 call.answer(stream);
            }

            call.on('stream', (remoteStream) => {
                console.log(`Stream recibido de: ${peerId}`);
                setPeers(prev => ({
                    ...prev,
                    [peerId + (metadata.isScreenShare ? '_screen' : '')]: { 
                        stream: remoteStream, 
                        userName: metadata.userName,
                        isScreenShare: metadata.isScreenShare 
                    }
                }));
            });
            
            call.on('close', () => {
                console.log(`Llamada cerrada con ${peerId}`);
                removePeer(peerId, metadata.isScreenShare);
            });

            peerConnections.current[peerId + (metadata.isScreenShare ? '_screen' : '')] = call;
        });

        socketRef.current.on('user-joined', ({ userId, userName: remoteUserName }) => {
            console.log(`Usuario ${remoteUserName} (${userId}) se unió.`);
            setChatMessages(prev => [...prev, { type: 'system', text: `${remoteUserName} se ha unido.`, id: Date.now() }]);
            connectToNewUser(userId, remoteUserName, stream);
        });

        socketRef.current.on('user-disconnected', (userId, disconnectedUserName) => {
            console.log(`Usuario ${disconnectedUserName} (${userId}) se desconectó.`);
            setChatMessages(prev => [...prev, { type: 'system', text: `${disconnectedUserName} se ha ido.`, id: Date.now() }]);
            removePeer(userId, false);
            removePeer(userId, true);
        });
        
        socketRef.current.on('createMessage', (message, user) => {
            setChatMessages(prev => [...prev, { user, text: message, id: Date.now(), type: 'chat' }]);
        });
    };

    const connectToNewUser = (peerId, remoteUserName, stream) => {
        console.log(`Llamando a ${remoteUserName} (${peerId})`);
        if (!myPeerRef.current) return;

        const call = myPeerRef.current.call(peerId, stream, { metadata: { userName, isScreenShare: false } });
        
        call.on('stream', (remoteStream) => {
            console.log(`Stream de cámara recibido de ${remoteUserName} (${peerId})`);
            setPeers(prev => ({ ...prev, [peerId]: { stream: remoteStream, userName: remoteUserName, isScreenShare: false } }));
        });
        
        call.on('close', () => {
            console.log(`Llamada con ${peerId} (cámara) cerrada.`);
            removePeer(peerId, false);
        });

        peerConnections.current[peerId] = call;
    };

    const removePeer = (peerId, isScreenShare) => {
        const key = peerId + (isScreenShare ? '_screen' : '');
        if (peerConnections.current[key]) {
            peerConnections.current[key].close();
            delete peerConnections.current[key];
        }
        setPeers(prev => {
            const newPeers = { ...prev };
            delete newPeers[key];
            return newPeers;
        });
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

    const shareScreen = async () => {
        if (myScreenStream) {
            myScreenStream.getTracks().forEach(track => track.stop());
            socketRef.current.emit('stop-screen-share');
            setMyScreenStream(null);
            Object.keys(peerConnections.current).forEach(key => {
                if (key.endsWith('_screen')) {
                    removePeer(key.replace('_screen', ''), true);
                }
            });
            return;
        }

        try {
            const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
            setMyScreenStream(screenStream);

            screenStream.getVideoTracks()[0].onended = () => {
                setMyScreenStream(null);
                socketRef.current.emit('stop-screen-share');
                Object.keys(peerConnections.current).forEach(key => {
                    if (key.endsWith('_screen')) {
                        removePeer(key.replace('_screen', ''), true);
                    }
                });
            };

            Object.keys(peerConnections.current).forEach(peerKey => {
                const peerId = peerKey.split('_')[0];
                if(peerConnections.current[peerId]){
                    console.log(`Enviando pantalla a ${peerId}`);
                    const call = myPeerRef.current.call(peerId, screenStream, { metadata: { userName, isScreenShare: true } });
                    peerConnections.current[peerId + '_screen'] = call;
                }
            });

        } catch (err) {
            console.error("Error al compartir pantalla:", err);
        }
    };

    return {
        myStream, myScreenStream, peers, chatMessages, isMuted, isVideoOff,
        initializeStream, connect, cleanup,
        toggleMute, toggleVideo, sendMessage, shareScreen
    };
};

const VideoPlayer = ({ stream, userName, muted = false, isScreenShare = false, isLocal = false }) => {
    const videoRef = useRef();
    useEffect(() => {
        if (stream) {
            videoRef.current.srcObject = stream;
        }
    }, [stream]);

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
                {userName} {isScreenShare && "(Pantalla)"}
            </div>
        </div>
    );
};

const VideoGrid = () => {
    const { myStream, myScreenStream, peers, userName } = useWebRTC();
    
    const videoElements = [
        myStream && { id: 'my-video', stream: myStream, userName: `${userName} (Tú)`, isLocal: true, muted: true },
        myScreenStream && { id: 'my-screen', stream: myScreenStream, userName: `${userName} (Tú)`, isLocal: true, isScreenShare: true, muted: true },
        ...Object.entries(peers).map(([key, { stream, userName, isScreenShare }]) => ({
            id: key, stream, userName, isScreenShare
        }))
    ].filter(Boolean);

    const getGridLayoutClass = (count) => {
        if (count <= 1) return styles.grid_1;
        if (count <= 2) return styles.grid_2_md;
        if (count <= 4) return styles.grid_2;
        if (count <= 6) return styles.grid_2_lg;
        return styles.grid_4;
    };
    
    const gridLayoutClass = getGridLayoutClass(videoElements.length);

    return (
        <div className={`${styles.videoGridContainer} ${gridLayoutClass}`}>
            {videoElements.map(v => (
                <VideoPlayer key={v.id} {...v} />
            ))}
        </div>
    );
};

const Controls = ({ onToggleChat, onLeave }) => {
    const { toggleMute, toggleVideo, shareScreen, isMuted, isVideoOff, myScreenStream } = useWebRTC();
    return (
        <footer className={styles.controlsFooter}>
            <button onClick={toggleMute} className={`${styles.controlButton} ${isMuted ? styles.controlButtonActive : ''}`}>
                {isMuted ? <MicOff size={20} /> : <Mic size={20} />}
            </button>
            <button onClick={toggleVideo} className={`${styles.controlButton} ${isVideoOff ? styles.controlButtonActive : ''}`}>
                {isVideoOff ? <VideoOff size={20} /> : <Video size={20} />}
            </button>
            <button onClick={shareScreen} className={`${styles.controlButton} ${myScreenStream ? styles.controlButtonScreenShare : ''}`}>
                <ScreenShare size={20} />
            </button>
            <button onClick={onToggleChat} className={styles.controlButton}>
                <MessageSquare size={20} />
            </button>
            <button onClick={onLeave} className={styles.leaveButton}>
                Salir
            </button>
        </footer>
    );
};

const ChatSidebar = ({ isOpen, onClose }) => {
    const { chatMessages, sendMessage, userName } = useWebRTC();
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
                    const isMe = msg.user === userName;
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
    const [selectedVideo, setSelectedVideo] = useState('');
    const [selectedAudio, setSelectedAudio] = useState('');
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        const getDevices = async () => {
            try {
                await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
                const devices = await navigator.mediaDevices.enumerateDevices();
                const videoInputs = devices.filter(d => d.kind === 'videoinput');
                const audioInputs = devices.filter(d => d.kind === 'audioinput');
                setVideoDevices(videoInputs);
                setAudioDevices(audioInputs);
                if (videoInputs.length > 0) setSelectedVideo(videoInputs[0].deviceId);
                if (audioInputs.length > 0) setSelectedAudio(audioInputs[0].deviceId);
            } catch (err) {
                console.error("Error al enumerar dispositivos:", err);
                alert("No se pudo acceder a la cámara o micrófono. Por favor, verifica los permisos en tu navegador.");
            } finally {
                setIsLoading(false);
            }
        };
        getDevices();
    }, []);

    const handleSubmit = (e) => {
        e.preventDefault();
        if (userName.trim()) {
            onJoin(userName, selectedAudio, selectedVideo);
        }
    };

    return (
        <div className={styles.lobbyContainer}>
            <div className={styles.lobbyFormWrapper}>
                <div className={styles.lobbyCard}>
                    <h1 className={styles.lobbyTitle}>Unirse a la Sala</h1>
                    <form onSubmit={handleSubmit} className={styles.lobbyForm}>
                        <div className={styles.formGroup}>
                            <label htmlFor="userName" className={styles.formLabel}>Tu nombre</label>
                            <input
                                id="userName" type="text" value={userName}
                                onChange={(e) => setUserName(e.target.value)}
                                placeholder="Ingresa tu nombre"
                                className={styles.formInput}
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
                            </>
                        )}
                        <button type="submit" disabled={!userName.trim() || isLoading} className={styles.joinButton}>
                            <LogIn className={styles.joinButtonIcon} size={20} />
                            Unirse
                        </button>
                    </form>
                </div>
            </div>
        </div>
    );
};

export default function App() {
    const [isJoined, setIsJoined] = useState(false);
    const [userName, setUserName] = useState('');
    const webRTCLogic = useWebRTCLogic('main-room', userName);

    const handleJoin = async (name, audioId, videoId) => {
        setUserName(name);
        const stream = await webRTCLogic.initializeStream(audioId, videoId);
        if (stream) {
            webRTCLogic.connect(stream);
            setIsJoined(true);
        }
    };

    const handleLeave = () => {
        webRTCLogic.cleanup();
        setIsJoined(false);
        setUserName('');
    };
    
    useEffect(() => {
        window.addEventListener('beforeunload', webRTCLogic.cleanup);
        return () => {
            window.removeEventListener('beforeunload', webRTCLogic.cleanup);
        };
    }, []);

    if (!isJoined) {
        return <Lobby onJoin={handleJoin} />;
    }

    return (
        <WebRTCContext.Provider value={{ ...webRTCLogic, userName }}>
            <CallRoom onLeave={handleLeave} />
        </WebRTCContext.Provider>
    );
}