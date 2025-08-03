import React, { useState, useEffect, useRef, createContext, useContext } from 'react';
import { Mic, MicOff, Video, VideoOff, ScreenShare, MessageSquare, Send, X, LogIn, Settings, Users, ArrowLeft, ThumbsUp, Heart, PartyPopper } from 'lucide-react';
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

    // Almacena qué usuario remoto está compartiendo su pantalla
    const screenSharePeer = useRef(null);

    // Función para limpiar todas las conexiones y streams
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

    // Inicializa el stream local del usuario (asegurando audio y video)
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

    // Conecta al servidor de señalización y a PeerJS
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

        // Escucha llamadas entrantes
        myPeerRef.current.on('call', (call) => {
            const { peer: peerId, metadata } = call;
            console.log(`[PeerJS] Incoming call from ${peerId}. Metadata received:`, metadata);

            const streamToSend = metadata.isScreenShare ? myScreenStream : myStream;
            if (streamToSend) {
                call.answer(streamToSend);
            } else {
                // Si el stream aún no está disponible, respondemos con el stream inicial
                call.answer(stream);
            }

            call.on('stream', (remoteStream) => {
                console.log(`[PeerJS] Stream received from: ${peerId}. Name from metadata: ${metadata.userName}, Es pantalla: ${metadata.isScreenShare}`);
                
                // Si el stream es de una pantalla compartida, actualiza el estado del peer de pantalla
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
                    // Si el stream es de video/cámara, actualiza el estado del peer normal
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

            // Almacena la conexión de la llamada
            peerConnections.current[peerId + (metadata.isScreenShare ? '_screen' : '')] = call;
        });

        socketRef.current.on('user-joined', ({ userId, userName: remoteUserName }) => {
            console.log(`[Socket] Usuario ${remoteUserName} (${userId}) se unió.`);
            setChatMessages(prev => [...prev, { type: 'system', text: `${remoteUserName} se ha unido.`, id: Date.now() }]);
            toast.info(`${remoteUserName} se ha unido a la sala.`);

            // Prepara el estado del nuevo peer antes de la llamada
            setPeers(prevPeers => ({
                ...prevPeers,
                [userId]: { stream: null, userName: remoteUserName, isScreenShare: false }
            }));

            connectToNewUser(userId, remoteUserName, stream, currentUserNameRef.current);

            // Si hay una pantalla compartida activa, envía ese stream al nuevo usuario
            if (myScreenStream && myPeerRef.current) {
                connectToNewUser(userId, remoteUserName, myScreenStream, currentUserNameRef.current, true);
            }
        });

        socketRef.current.on('user-disconnected', (userId, disconnectedUserName) => {
            console.log(`[Socket] Usuario ${disconnectedUserName} (${userId}) se desconectó.`);
            setChatMessages(prev => [...prev, { type: 'system', text: `${disconnectedUserName} se ha ido.`, id: Date.now() }]);
            toast.warn(`${disconnectedUserName} ha abandonado la sala.`);
            
            // Si el usuario desconectado era el que compartía pantalla, quítala
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

        // Manejo de eventos para la pantalla compartida
        socketRef.current.on('user-started-screen-share', ({ userId, userName: remoteUserName }) => {
            console.log(`[Socket] ${remoteUserName} (${userId}) ha empezado a compartir pantalla.`);
            toast.info(`${remoteUserName} está compartiendo su pantalla.`);
            // No hacemos nada aquí, la llamada P2P ya se encargará de añadir el stream.
        });

        socketRef.current.on('user-stopped-screen-share', (userId) => {
            console.log(`[Socket] Usuario ${userId} ha dejado de compartir pantalla.`);
            removeScreenShare(userId);
        });
    };

    const connectToNewUser = (peerId, remoteUserName, stream, localUserName, isScreenShare = false) => {
        if (!myPeerRef.current || !stream) return;

        const metadata = { userName: localUserName, isScreenShare };
        console.log(`[PeerJS] Calling new user ${remoteUserName} (${peerId}) with my metadata:`, metadata);

        const call = myPeerRef.current.call(peerId, stream, { metadata });

        call.on('stream', (remoteStream) => {
            console.log(`[PeerJS] Stream received from my call to: ${remoteUserName} (${peerId}). Is screen share: ${isScreenShare}`);

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
            console.log(`[PeerJS] My call with ${peerId} (camera) closed.`);
            if (isScreenShare) {
                removeScreenShare(peerId);
            } else {
                removePeer(peerId);
            }
        });

        peerConnections.current[peerId + (isScreenShare ? '_screen' : '')] = call;
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
            // También cierra la llamada si existe
            const callKey = peerId + '_screen';
            if (peerConnections.current[callKey]) {
                peerConnections.current[callKey].close();
                delete peerConnections.current[callKey];
            }
        }
    };


    // --- Funciones de control ---
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
        if (myScreenStream) {
            console.log("[ScreenShare] Stopping screen share.");
            myScreenStream.getTracks().forEach(track => track.stop());
            socketRef.current.emit('stop-screen-share');
            setMyScreenStream(null);
            
            // Cierra las conexiones de pantalla compartida con todos los peers
            Object.keys(peerConnections.current).forEach(key => {
                if (key.endsWith('_screen')) {
                    const peerId = key.replace('_screen', '');
                    peerConnections.current[key].close();
                    delete peerConnections.current[key];
                    // Informa al peer remoto que el stream de pantalla ya no está disponible
                    setPeers(prevPeers => {
                        const newPeers = { ...prevPeers };
                        delete newPeers['screen-share']; // Elimina el peer de pantalla de la UI local
                        return newPeers;
                    });
                }
            });
            return;
        }

        try {
            const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
            setMyScreenStream(screenStream);
            console.log("Stream de pantalla inicializado.");

            screenStream.getVideoTracks()[0].onended = () => {
                setMyScreenStream(null);
                socketRef.current.emit('stop-screen-share');
                Object.keys(peerConnections.current).forEach(key => {
                    if (key.endsWith('_screen')) {
                        peerConnections.current[key].close();
                        delete peerConnections.current[key];
                    }
                });
            };

            // Notifica al servidor que se ha iniciado la pantalla compartida
            socketRef.current.emit('start-screen-share', myPeerRef.current.id, currentUserNameRef.current);
            
            // Llama a todos los usuarios existentes para compartir la pantalla
            Object.keys(peerConnections.current).forEach(peerKey => {
                // Asegúrate de no llamar con la conexión de pantalla del mismo usuario
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
        myStream, myScreenStream, peers, chatMessages, isMuted, isVideoOff,
        initializeStream, connect, cleanup,
        toggleMute, toggleVideo, sendMessage, shareScreen, sendReaction,
        currentUserName: currentUserNameRef.current
    };
};

// --- COMPONENTES DE LA UI ---

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
                {userName || 'Usuario Desconocido'} {isScreenShare && "(Pantalla)"}
            </div>
        </div>
    );
};

const VideoGrid = () => {
    const { myStream, myScreenStream, peers, currentUserName } = useWebRTC();

    const videoElements = [
        // Siempre muestra tu video normal
        myStream && { id: 'my-video', stream: myStream, userName: `${currentUserName} (Tú)`, isLocal: true, muted: true },
        // Si estás compartiendo pantalla, muestra tu pantalla
        myScreenStream && { id: 'my-screen', stream: myScreenStream, userName: `${currentUserName} (Tú)`, isLocal: true, isScreenShare: true, muted: true },
        // Muestra la pantalla compartida de otro usuario si existe
        peers['screen-share'] && {
            id: 'remote-screen',
            stream: peers['screen-share'].stream,
            userName: peers['screen-share'].userName,
            isScreenShare: true
        },
        // Muestra el video de los demás usuarios
        ...Object.entries(peers)
            .filter(([key, peerData]) => key !== 'screen-share' && peerData.stream) // Excluye el peer de pantalla compartida y peers sin stream
            .map(([key, peerData]) => ({
                id: key,
                stream: peerData.stream,
                userName: peerData.userName,
                isScreenShare: false
            }))
    ].filter(Boolean);

    // Ajusta la lógica del grid para priorizar la pantalla compartida
    const isSharingScreen = videoElements.some(v => v.isScreenShare);
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
                    <VideoPlayer key={mainContent.id} {...mainContent} />
                </div>
            )}
            <div className={`${styles.videoSecondaryGrid} ${gridLayoutClass}`}>
                {sideContent.map(v => (
                    <VideoPlayer key={v.id} {...v} />
                ))}
            </div>
        </div>
    );
};


const Controls = ({ onToggleChat, onLeave }) => {
    const { toggleMute, toggleVideo, shareScreen, sendReaction, isMuted, isVideoOff, myScreenStream } = useWebRTC();
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
            <div className={styles.reactionButtons}>
                <button onClick={() => sendReaction('👍')} className={styles.reactionButton}>
                    <ThumbsUp size={20} />
                </button>
                <button onClick={() => sendReaction('❤️')} className={styles.reactionButton}>
                    <Heart size={20} />
                </button>
                <button onClick={() => sendReaction('🎉')} className={styles.reactionButton}>
                    <PartyPopper size={20} />
                </button>
            </div>
            <button onClick={onLeave} className={styles.leaveButton}>
                Salir
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


// --- COMPONENTE PRINCIPAL DE LA APLICACIÓN ---
export default function App() {
    const [isJoined, setIsJoined] = useState(false);
    const [userName, setUserName] = useState('');
    const webRTCLogic = useWebRTCLogic('main-room');

    const handleJoin = async (name, audioId, videoId) => {
        setUserName(name);
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
        <WebRTCContext.Provider value={{ ...webRTCLogic, currentUserName: userName }}>
            <CallRoom onLeave={handleLeave} />
            <ToastContainer />
        </WebRTCContext.Provider>
    );
}