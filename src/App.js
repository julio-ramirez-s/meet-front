import React, { useState, useEffect, useRef, createContext, useContext, useCallback, memo, useMemo } from 'react';
import { Mic, MicOff, Video, VideoOff, ScreenShare, MessageSquare, Send, X, LogIn, Plus, Sun, Moon, Volume2, Speaker, User, VideoIcon } from 'lucide-react';
import { io } from 'socket.io-client';
import Peer from 'peerjs';
import { ToastContainer, toast } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';
import styles from './App.module.css';

// URL del servidor Socket.io (Se asume que está en el mismo host)
const SOCKET_SERVER_URL = process.env.NODE_ENV === 'production' ? window.location.origin : 'http://localhost:3001';

// --- CONTEXTO PARA WEBRTC ---
const WebRTCContext = createContext();
const useWebRTC = () => useContext(WebRTCContext);

// --- HOOK PERSONALIZADO PARA LA LÓGICA DE WEBRTC (SIN CAMBIOS) ---
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
        console.log("Limpiando recursos...");
        if (myStream) {
            myStream.getTracks().forEach(track => track.stop());
            setMyStream(null);
        }
        if (myScreenStream) {
            myScreenStream.getTracks().forEach(track => track.stop());
            setMyScreenStream(null);
        }
        if (socketRef.current) {
            socketRef.current.disconnect();
            socketRef.current = null;
        }
        if (myPeerRef.current) {
            myPeerRef.current.destroy();
            myPeerRef.current = null;
        }
        Object.values(peerConnections.current).forEach(conn => conn.close());
        peerConnections.current = {};
        setPeers({});
        setChatMessages([]);
    }, [myStream, myScreenStream]);

    // Lógica para obtener dispositivos de medios (Manejo de UI de dispositivos en Lobby)
    const getMediaDevices = useCallback(async () => {
        try {
            // Se solicita permiso sin crear stream para listar dispositivos
            await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
            const devices = await navigator.mediaDevices.enumerateDevices();
            return {
                audioInputs: devices.filter(d => d.kind === 'audioinput'),
                videoInputs: devices.filter(d => d.kind === 'videoinput'),
                audioOutputs: devices.filter(d => d.kind === 'audiooutput'),
            };
        } catch (error) {
            console.error("Error al obtener dispositivos:", error);
            toast.error("Error al acceder a dispositivos de audio/video. Verifica permisos.");
            return { audioInputs: [], videoInputs: [], audioOutputs: [] };
        }
    }, []);

    const initializeStream = useCallback(async (audioDeviceId, videoDeviceId) => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: { deviceId: audioDeviceId ? { exact: audioDeviceId } : undefined },
                video: { deviceId: videoDeviceId ? { exact: videoDeviceId } : undefined, width: 1280, height: 720 },
            });
            setMyStream(stream);
            setIsMuted(!stream.getAudioTracks().some(track => track.enabled));
            setIsVideoOff(!stream.getVideoTracks().some(track => track.enabled));
            return stream;
        } catch (error) {
            console.error("Error al inicializar stream:", error);
            toast.error("No se pudo iniciar el video/audio. Asegúrate de tener permisos.");
            return null;
        }
    }, []);

    const connect = useCallback((stream, name) => {
        currentUserNameRef.current = name;
        socketRef.current = io(SOCKET_SERVER_URL);
        myPeerRef.current = new Peer(undefined, {
            host: '/',
            port: 3002 // Puerto por defecto para PeerJS
        });

        const socket = socketRef.current;
        const myPeer = myPeerRef.current;

        myPeer.on('open', (id) => {
            console.log('Mi ID de Peer es:', id);
            socket.emit('join-room', roomId, id, name);
        });

        // Evento: Alguien llama
        myPeer.on('call', (call) => {
            console.log('Recibiendo llamada de:', call.peer);
            call.answer(stream);
            
            call.on('stream', (userVideoStream) => {
                console.log('Stream recibido de:', call.peer);
                // Aquí usamos el ID de socket, no el de peer, para mantener la consistencia
                setPeers(prev => ({ 
                    ...prev, 
                    [call.metadata.socketId]: { 
                        id: call.peer, 
                        stream: userVideoStream, 
                        name: call.metadata.name,
                        isMuted: false, 
                        isVideoOff: false,
                        isScreenSharing: false,
                        isMe: false,
                        socketId: call.metadata.socketId
                    } 
                }));
            });
            peerConnections.current[call.metadata.socketId] = call;
        });

        // Socket: Nuevo usuario conectado (para que yo lo llame)
        socket.on('user-connected', (userId, userName, socketId) => {
            console.log('Nuevo usuario para llamar:', userName, userId);
            
            // Si ya tengo un stream, llamo al nuevo usuario
            if (stream) {
                const call = myPeer.call(userId, stream, { 
                    metadata: { 
                        socketId: socket.id, 
                        name: currentUserNameRef.current 
                    } 
                });
                
                call.on('stream', (userVideoStream) => {
                    console.log('Stream de usuario conectado recibido:', userId);
                    setPeers(prev => ({ 
                        ...prev, 
                        [socketId]: { 
                            id: userId, 
                            stream: userVideoStream, 
                            name: userName,
                            isMuted: false, 
                            isVideoOff: false,
                            isScreenSharing: false,
                            isMe: false,
                            socketId: socketId
                        } 
                    }));
                });
                
                peerConnections.current[socketId] = call;
            } else {
                 // Si no hay stream aún (error), solo registro el peer
                 setPeers(prev => ({
                     ...prev,
                     [socketId]: { 
                         id: userId, 
                         stream: null, 
                         name: userName,
                         isMuted: true, 
                         isVideoOff: true,
                         isScreenSharing: false,
                         isMe: false,
                         socketId: socketId
                     }
                 }));
            }
            
            toast.info(`${userName} se ha unido a la sala.`);
        });

        // Socket: Usuario desconectado
        socket.on('user-disconnected', (socketId, userName) => {
            console.log('Usuario desconectado:', socketId, userName);
            
            if (peerConnections.current[socketId]) {
                peerConnections.current[socketId].close();
                delete peerConnections.current[socketId];
            }
            
            setPeers(prev => {
                const newState = { ...prev };
                delete newState[socketId];
                return newState;
            });

            toast.warn(`${userName} ha abandonado la sala.`);
        });

        // Socket: Recibir mensaje de chat
        socket.on('chat-message', (message) => {
            setChatMessages(prev => [...prev, message]);
        });
        
        // Socket: Recibir estados de mute/video/pantalla
        socket.on('peer-state-change', (socketId, state) => {
            setPeers(prev => {
                const peer = prev[socketId];
                if (peer) {
                    return {
                        ...prev,
                        [socketId]: {
                            ...peer,
                            ...state
                        }
                    };
                }
                return prev;
            });
        });


    }, [roomId]); // Dependencias del useCallback

    // Enviar mensaje de chat
    const sendChatMessage = useCallback((message) => {
        if (socketRef.current && currentUserNameRef.current) {
            const messageData = {
                sender: currentUserNameRef.current,
                text: message,
                timestamp: Date.now(),
                isMe: true
            };
            socketRef.current.emit('chat-message', messageData);
            setChatMessages(prev => [...prev, messageData]);
        }
    }, []);

    // Funciones de control de stream
    const toggleMute = useCallback(() => {
        if (myStream) {
            const audioTrack = myStream.getAudioTracks()[0];
            if (audioTrack) {
                audioTrack.enabled = !audioTrack.enabled;
                setIsMuted(!audioTrack.enabled);
                if (socketRef.current) {
                    socketRef.current.emit('peer-state-change', { isMuted: !audioTrack.enabled });
                }
            }
        }
    }, [myStream]);

    const toggleVideo = useCallback(() => {
        if (myStream) {
            const videoTrack = myStream.getVideoTracks()[0];
            if (videoTrack) {
                videoTrack.enabled = !videoTrack.enabled;
                setIsVideoOff(!videoTrack.enabled);
                if (socketRef.current) {
                    socketRef.current.emit('peer-state-change', { isVideoOff: !videoTrack.enabled });
                }
            }
        }
    }, [myStream]);

    // Función para actualizar el stream de todos los peers
    const replaceAllTracks = useCallback((newStream) => {
        Object.values(peerConnections.current).forEach(call => {
            call.peerConnection.getSenders().forEach(sender => {
                if (newStream.getTracks().includes(sender.track)) {
                    // Si el track ya existe en el nuevo stream, no hacemos nada
                    return;
                }
                
                // Encontramos el track que estamos reemplazando (por tipo)
                const oldTrack = sender.track;
                const newTrack = newStream.getTracks().find(t => t.kind === oldTrack.kind);
                
                if (newTrack) {
                    sender.replaceTrack(newTrack)
                        .catch(err => console.error("Error al reemplazar track:", err));
                }
            });
        });
    }, []);

    // Compartir pantalla
    const toggleScreenShare = useCallback(async () => {
        if (!myScreenStream) {
            // Iniciar compartición de pantalla
            try {
                const screenStream = await navigator.mediaDevices.getDisplayMedia({
                    video: true,
                    audio: true 
                });
                
                setMyScreenStream(screenStream);

                // 1. Reemplazar el video track principal con el de la pantalla
                const videoTrack = myStream.getVideoTracks()[0];
                if (videoTrack) {
                    const screenVideoTrack = screenStream.getVideoTracks()[0];
                    Object.values(peerConnections.current).forEach(call => {
                        const sender = call.peerConnection.getSenders().find(s => s.track.kind === 'video');
                        if (sender) {
                            sender.replaceTrack(screenVideoTrack).catch(err => console.error(err));
                        }
                    });
                    
                    // El audio de la pantalla también debe ser enviado si existe
                    const screenAudioTrack = screenStream.getAudioTracks()[0];
                    if (screenAudioTrack) {
                         Object.values(peerConnections.current).forEach(call => {
                            const sender = call.peerConnection.getSenders().find(s => s.track.kind === 'audio');
                            if (sender) {
                                sender.replaceTrack(screenAudioTrack).catch(err => console.error(err));
                            }
                        });
                    }

                    // Notificar a los demás que estoy compartiendo
                    if (socketRef.current) {
                        socketRef.current.emit('peer-state-change', { isScreenSharing: true });
                    }
                }
                
                // Manejar la detención de la compartición por el botón del navegador
                screenStream.getVideoTracks()[0].onended = () => {
                    toggleScreenShare(); // Llama a la función para detener la compartición
                };

            } catch (error) {
                console.error("Error al compartir pantalla:", error);
                toast.error("No se pudo iniciar la compartición de pantalla.");
            }
        } else {
            // Detener compartición de pantalla
            myScreenStream.getTracks().forEach(track => track.stop());
            setMyScreenStream(null);

            // 1. Revertir al video track de la cámara
            const cameraVideoTrack = myStream.getVideoTracks()[0];
            const cameraAudioTrack = myStream.getAudioTracks()[0];

            Object.values(peerConnections.current).forEach(call => {
                // Revertir video
                const videoSender = call.peerConnection.getSenders().find(s => s.track.kind === 'video');
                if (videoSender) {
                    videoSender.replaceTrack(cameraVideoTrack).catch(err => console.error(err));
                }
                
                // Revertir audio (si se estaba compartiendo audio de pantalla)
                const audioSender = call.peerConnection.getSenders().find(s => s.track.kind === 'audio');
                if (audioSender) {
                     audioSender.replaceTrack(cameraAudioTrack).catch(err => console.error(err));
                }
            });

            // Notificar a los demás que he dejado de compartir
            if (socketRef.current) {
                socketRef.current.emit('peer-state-change', { isScreenSharing: false });
            }
        }
    }, [myStream, myScreenStream, replaceAllTracks]);


    // Exponer el estado y las funciones
    return useMemo(() => ({
        myStream,
        myScreenStream,
        peers,
        chatMessages,
        isMuted,
        isVideoOff,
        getMediaDevices,
        initializeStream,
        connect,
        cleanup,
        toggleMute,
        toggleVideo,
        toggleScreenShare,
        sendChatMessage,
        currentUserName: currentUserNameRef.current,
        isScreenSharing: !!myScreenStream
    }), [
        myStream,
        myScreenStream,
        peers,
        chatMessages,
        isMuted,
        isVideoOff,
        getMediaDevices,
        initializeStream,
        connect,
        cleanup,
        toggleMute,
        toggleVideo,
        toggleScreenShare,
        sendChatMessage,
    ]);
};


// --- COMPONENTES DE UI ---

// Componente para la Tarjeta de Video
const VideoTile = memo(({ stream, name, isMe, isMuted, isVideoOff, isScreenSharing }) => {
    const videoRef = useRef(null);

    useEffect(() => {
        if (videoRef.current && stream) {
            videoRef.current.srcObject = stream;
        }
    }, [stream]);

    // Usar la función de utilidad para establecer el dispositivo de salida de audio
    const { selectedAudioOutput } = useWebRTC();
    useEffect(() => {
        if (videoRef.current && selectedAudioOutput) {
            try {
                // Solo aplica para el stream remoto (no es "isMe")
                if (!isMe && videoRef.current.setSinkId) {
                    videoRef.current.setSinkId(selectedAudioOutput);
                }
            } catch (error) {
                console.warn("No se pudo cambiar el dispositivo de salida de audio:", error);
                // Si falla, es probable que el navegador no lo soporte o el usuario no dio permiso
            }
        }
    }, [selectedAudioOutput, isMe]);


    // Determinar si mostrar el video de la cámara, la pantalla o un placeholder
    const showVideo = stream && stream.getVideoTracks().length > 0 && stream.getVideoTracks()[0].enabled && !isVideoOff;
    
    // Si es mi tile y estoy compartiendo pantalla, muestro mi screenStream
    const activeStream = (isMe && isScreenSharing) ? stream : stream;

    return (
        <div className={styles.videoTileContainer}>
            {showVideo ? (
                // El transform: scaleX(-1) está en el CSS para `userVideo`
                <video 
                    ref={videoRef} 
                    className={styles.userVideo}
                    playsInline 
                    autoPlay 
                    muted={isMe} // Siempre silenciar el propio video
                />
            ) : (
                <div className={styles.placeholder}>
                    <VideoOff size={48} />
                    <span>{isScreenSharing ? "Compartiendo Pantalla" : "Video Desactivado"}</span>
                </div>
            )}
            
            <div className={styles.videoOverlay}>
                <span className={styles.userName}>{name} {isMe && "(Tú)"}</span>
                <div className={styles.statusIcon}>
                    {isScreenSharing && <ScreenShare size={20} className="text-green-400 mr-2" />}
                    {isMuted ? <MicOff size={20} className="text-red-400" /> : <Mic size={20} className="text-white" />}
                </div>
            </div>
        </div>
    );
});


// Componente de Chat (rediseñado)
const ChatSidebar = ({ isChatOpen, setIsChatOpen }) => {
    const { chatMessages, sendChatMessage, currentUserName } = useWebRTC();
    const [message, setMessage] = useState('');
    const messagesEndRef = useRef(null);

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    };

    useEffect(scrollToBottom, [chatMessages]);

    const handleSubmit = (e) => {
        e.preventDefault();
        if (message.trim()) {
            sendChatMessage(message.trim());
            setMessage('');
        }
    };
    
    // Estilos del chat basados en si está abierto (para móvil)
    const chatClasses = `${styles.chatSidebar} ${isChatOpen ? styles.open : ''}`;

    return (
        <div className={chatClasses}>
            <div className={styles.chatHeader}>
                <h3 className={styles.chatTitle}><MessageSquare size={20} className="inline-block mr-2" />Chat de la Sala</h3>
                <button 
                    onClick={() => setIsChatOpen(false)} 
                    className="md:hidden" // Botón de cerrar solo en móvil
                    aria-label="Cerrar Chat"
                >
                    <X size={24} />
                </button>
            </div>
            
            <div className={styles.chatMessages}>
                {chatMessages.map((msg, index) => {
                    const isMyMessage = msg.sender === currentUserName;
                    return (
                        <div key={index} className={`${styles.messageContainer} ${isMyMessage ? styles.myMessage : ''}`}>
                            <div className={`${styles.messageBubble} ${isMyMessage ? styles.myMessage : styles.otherMessage}`}>
                                {!isMyMessage && <div className={styles.messageSender}>{msg.sender}</div>}
                                <div>{msg.text}</div>
                            </div>
                        </div>
                    );
                })}
                <div ref={messagesEndRef} />
            </div>
            
            <form onSubmit={handleSubmit} className={styles.chatInputForm}>
                <input
                    type="text"
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    placeholder="Escribe un mensaje..."
                    className={styles.chatInput}
                    disabled={!sendChatMessage}
                />
                <button type="submit" className={styles.sendButton} disabled={!message.trim()}>
                    <Send size={20} />
                </button>
            </form>
        </div>
    );
};

// Componente de Barra de Control (rediseñado con iconos circulares)
const ControlBar = ({ onLeave, toggleTheme, isLightMode, toggleChat, isChatOpen }) => {
    const { 
        isMuted, toggleMute, 
        isVideoOff, toggleVideo, 
        toggleScreenShare, 
        isScreenSharing, 
    } = useWebRTC();

    return (
        <>
            <button 
                onClick={toggleTheme} 
                className={styles.themeToggle}
                title={isLightMode ? "Cambiar a Tema Oscuro" : "Cambiar a Tema Claro"}
                aria-label="Cambiar Tema"
            >
                {isLightMode ? <Moon size={20} /> : <Sun size={20} />}
            </button>
            
            <div className={styles.controlBar}>
                {/* Botón de Micrófono */}
                <button 
                    onClick={toggleMute} 
                    className={`${styles.controlButton} ${!isMuted ? styles.buttonActive : ''}`}
                    title={isMuted ? "Activar Micrófono" : "Silenciar Micrófono"}
                >
                    {isMuted ? <MicOff size={24} /> : <Mic size={24} />}
                </button>

                {/* Botón de Video */}
                <button 
                    onClick={toggleVideo} 
                    className={`${styles.controlButton} ${!isVideoOff ? styles.buttonActive : ''}`}
                    title={isVideoOff ? "Activar Video" : "Desactivar Video"}
                >
                    {isVideoOff ? <VideoOff size={24} /> : <Video size={24} />}
                </button>
                
                {/* Botón de Compartir Pantalla */}
                <button 
                    onClick={toggleScreenShare} 
                    className={`${styles.controlButton} ${isScreenSharing ? styles.buttonShare : ''}`}
                    title={isScreenSharing ? "Detener Compartir" : "Compartir Pantalla"}
                >
                    <ScreenShare size={24} />
                </button>
                
                {/* Botón de Chat */}
                <button 
                    onClick={toggleChat} 
                    className={`${styles.controlButton} ${isChatOpen ? styles.buttonActive : ''}`}
                    title={isChatOpen ? "Ocultar Chat" : "Mostrar Chat"}
                >
                    <MessageSquare size={24} />
                </button>

                {/* Botón de Salir (Rojo) */}
                <button 
                    onClick={onLeave} 
                    className={`${styles.controlButton} ${styles.buttonLeave}`}
                    title="Abandonar Llamada"
                >
                    <X size={24} />
                </button>
            </div>
        </>
    );
};


// Componente principal de la sala de llamadas
const CallRoom = ({ onLeave, toggleTheme, isLightMode }) => {
    const { myStream, peers, currentUserName, isMuted, isVideoOff, isScreenSharing } = useWebRTC();
    const [isChatOpen, setIsChatOpen] = useState(true);

    // Lista de videos
    const allPeers = useMemo(() => {
        const myTile = {
            id: 'me',
            stream: myStream,
            name: currentUserName,
            isMe: true,
            isMuted,
            isVideoOff,
            isScreenSharing
        };
        const remoteTiles = Object.values(peers).map(p => ({
            ...p,
            isMe: false,
        }));
        return [myTile, ...remoteTiles];
    }, [myStream, peers, currentUserName, isMuted, isVideoOff, isScreenSharing]);

    // Clases del contenedor principal
    const roomClasses = `${styles.callRoomContainer} ${isLightMode ? styles.lightMode : ''} ${isChatOpen ? styles.withChat : ''}`;

    // Lógica para determinar el layout de la cuadrícula
    // Esta función podría ser más compleja para un layout perfecto, pero esto es un buen inicio.
    const gridStyle = useMemo(() => {
        const count = allPeers.length;
        let rows, cols;
        
        if (count === 1) {
            rows = 1; cols = 1;
        } else if (count === 2) {
            rows = 1; cols = 2;
        } else if (count === 3 || count === 4) {
            rows = 2; cols = 2;
        } else if (count === 5 || count === 6) {
            rows = 2; cols = 3;
        } else if (count > 6 && count <= 9) {
            rows = 3; cols = 3;
        } else {
             // Dejamos que el CSS grid por defecto (auto-fit) se encargue para más de 9
             return {}; 
        }

        return {
            gridTemplateRows: `repeat(${rows}, 1fr)`,
            gridTemplateColumns: `repeat(${cols}, 1fr)`,
        };
    }, [allPeers.length]);


    return (
        <div className={roomClasses}>
            <div className={styles.videoGrid} style={gridStyle}>
                {allPeers.map(peer => (
                    <VideoTile 
                        key={peer.id}
                        stream={peer.stream}
                        name={peer.name}
                        isMe={peer.isMe}
                        isMuted={peer.isMuted}
                        isVideoOff={peer.isVideoOff}
                        isScreenSharing={peer.isScreenSharing}
                    />
                ))}
            </div>
            
            {isChatOpen && <ChatSidebar isChatOpen={isChatOpen} setIsChatOpen={setIsChatOpen} />}

            <ControlBar 
                onLeave={onLeave} 
                toggleTheme={toggleTheme} 
                isLightMode={isLightMode} 
                toggleChat={() => setIsChatOpen(prev => !prev)}
                isChatOpen={isChatOpen}
            />

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
                theme={isLightMode ? "light" : "dark"}
            />
        </div>
    );
};


// Componente de Lobby (rediseñado)
const Lobby = ({ onJoin }) => {
    const [name, setName] = useState('');
    const [audioIn, setAudioIn] = useState('');
    const [videoIn, setVideoIn] = useState('');
    const [audioOut, setAudioOut] = useState('');
    const [devices, setDevices] = useState({ audioInputs: [], videoInputs: [], audioOutputs: [] });
    const [loading, setLoading] = useState(true);
    const webRTCLogic = useWebRTCLogic('main-room');

    useEffect(() => {
        // Cargar dispositivos al inicio
        webRTCLogic.getMediaDevices().then(devs => {
            setDevices(devs);
            // Establecer valores por defecto
            if (devs.audioInputs.length > 0) setAudioIn(devs.audioInputs[0].deviceId);
            if (devs.videoInputs.length > 0) setVideoIn(devs.videoInputs[0].deviceId);
            if (devs.audioOutputs.length > 0) setAudioOut(devs.audioOutputs[0].deviceId);
            setLoading(false);
        });
    }, [webRTCLogic]);

    const handleJoinClick = (e) => {
        e.preventDefault();
        if (name && audioIn && videoIn && audioOut) {
            onJoin(name, audioIn, videoIn, audioOut);
        }
    };
    
    const isFormValid = name.trim().length > 0 && audioIn && videoIn && audioOut;

    // Título y Logo
    const AppLogo = useMemo(() => (
        <div className={styles.lobbyHeader}>
            <h1 className={styles.lobbyTitle}>
                <Volume2 size={32} className="inline-block mr-2" />mundi-link
            </h1>
            <p className={styles.lobbySubtitle}>Tu plataforma de videollamadas profesional.</p>
        </div>
    ), []);

    return (
        <div className={`${styles.lobbyContainer} ${styles.lightMode}`}>
            <div className={styles.lobbyCard}>
                {AppLogo}

                {loading ? (
                    <div className={styles.loadingMessage}>Cargando dispositivos de audio/video...</div>
                ) : (
                    <form onSubmit={handleJoinClick}>
                        {/* Nombre de Usuario */}
                        <div className={styles.formGroup}>
                            <label htmlFor="userName" className={styles.formLabel}>Tu Nombre</label>
                            <input
                                id="userName"
                                type="text"
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                className={styles.formInput}
                                placeholder="Escribe tu nombre para unirte"
                                required
                            />
                        </div>

                        {/* Selección de Dispositivo de Audio (Entrada) */}
                        <div className={styles.formGroup}>
                            <label htmlFor="audioIn" className={styles.formLabel}>Micrófono (Entrada)</label>
                            <select
                                id="audioIn"
                                value={audioIn}
                                onChange={(e) => setAudioIn(e.target.value)}
                                className={styles.formSelect}
                                required
                            >
                                {devices.audioInputs.map(device => (
                                    <option key={device.deviceId} value={device.deviceId}>
                                        {device.label || `Micrófono ${device.deviceId.substring(0, 8)}...`}
                                    </option>
                                ))}
                            </select>
                        </div>
                        
                        {/* Selección de Dispositivo de Audio (Salida) */}
                        <div className={styles.formGroup}>
                            <label htmlFor="audioOut" className={styles.formLabel}>Altavoz (Salida)</label>
                            <select
                                id="audioOut"
                                value={audioOut}
                                onChange={(e) => setAudioOut(e.target.value)}
                                className={styles.formSelect}
                                required
                            >
                                {devices.audioOutputs.map(device => (
                                    <option key={device.deviceId} value={device.deviceId}>
                                        {device.label || `Altavoz ${device.deviceId.substring(0, 8)}...`}
                                    </option>
                                ))}
                            </select>
                        </div>

                        {/* Selección de Dispositivo de Video */}
                        <div className={styles.formGroup}>
                            <label htmlFor="videoIn" className={styles.formLabel}>Cámara (Video)</label>
                            <select
                                id="videoIn"
                                value={videoIn}
                                onChange={(e) => setVideoIn(e.target.value)}
                                className={styles.formSelect}
                                required
                            >
                                {devices.videoInputs.map(device => (
                                    <option key={device.deviceId} value={device.deviceId}>
                                        {device.label || `Cámara ${device.deviceId.substring(0, 8)}...`}
                                    </option>
                                ))}
                            </select>
                        </div>

                        <button 
                            type="submit" 
                            className={styles.joinButton} 
                            disabled={!isFormValid}
                        >
                            <LogIn size={20} className="mr-2" />
                            Unirse a la Reunión
                        </button>
                    </form>
                )}
            </div>
        </div>
    );
};


// --- COMPONENTE PRINCIPAL ---
export default function App() {
    const [isJoined, setIsJoined] = useState(false);
    const [selectedAudioOutput, setSelectedAudioOutput] = useState('');
    const [isLightMode, setIsLightMode] = useState(false);
    
    // Usamos 'main-room' como ID fijo de la sala
    const webRTCLogic = useWebRTCLogic('main-room');

    const handleJoin = useCallback(async (name, audioId, videoId, audioOutputId) => {
        setSelectedAudioOutput(audioOutputId); // Guardar la salida para los streams remotos
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

    // Limpieza al cerrar la ventana
    useEffect(() => {
        const cleanup = webRTCLogic.cleanup;
        window.addEventListener('beforeunload', cleanup);
        return () => window.removeEventListener('beforeunload', cleanup);
    }, [webRTCLogic.cleanup]);

    // Renderizado condicional
    if (!isJoined) {
        // El Lobby ahora usa el modo claro por defecto para una mejor primera impresión
        return <Lobby onJoin={handleJoin} />; 
    }

    return (
        <WebRTCContext.Provider value={{ ...webRTCLogic, selectedAudioOutput }}>
            <CallRoom 
                onLeave={handleLeave} 
                toggleTheme={toggleTheme} 
                isLightMode={isLightMode} 
            />
        </WebRTCContext.Provider>
    );
}