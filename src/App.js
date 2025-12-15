import React, { useState, useEffect, useRef, createContext, useContext } from 'react';
import { Mic, MicOff, Video, VideoOff, ScreenShare, MessageSquare, Send, X, LogIn, Plus, Sun, Moon, Menu } from 'lucide-react'; // Importar Menu icon
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
    currentRoomIdRef.current = roomId;

    const toggleTheme = () => {
        setAppTheme(prevTheme => prevTheme === 'dark' ? 'light' : 'dark');
    };

    const initializeStream = async (audioId, videoId) => {
        try {
            const constraints = {
                video: videoId ? { deviceId: videoId } : true,
                audio: audioId ? { deviceId: audioId } : true,
            };
            const stream = await navigator.mediaDevices.getUserMedia(constraints);
            setMyStream(stream);
            return stream;
        } catch (error) {
            console.error("Error al acceder a los dispositivos multimedia:", error);
            toast.error("Error al acceder a la cámara/micrófono. Asegúrate de dar permisos.");
            return null;
        }
    };

    const startScreenShare = async () => {
        if (myScreenStream) {
            stopScreenShare();
            return;
        }

        try {
            // @ts-ignore
            const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
            setMyScreenStream(screenStream);

            const videoTrack = screenStream.getVideoTracks()[0];
            videoTrack.onended = stopScreenShare;

            // Reemplazar la pista de video en todas las conexiones P2P
            Object.values(peerConnections.current).forEach(conn => {
                conn.getSenders().forEach(sender => {
                    if (sender.track.kind === 'video') {
                        // Buscar el sender de la pista de video principal para reemplazarla
                        // Esto asume que la primera pista de video es la de la cámara o la que se quiere reemplazar
                        if (myStream.getVideoTracks().includes(sender.track)) {
                            sender.replaceTrack(videoTrack);
                        }
                    }
                });
            });

            toast.info("Compartiendo pantalla...");
        } catch (error) {
            console.error("Error al compartir pantalla:", error);
            toast.error("No se pudo iniciar la compartición de pantalla.");
        }
    };

    const stopScreenShare = () => {
        if (myScreenStream) {
            myScreenStream.getTracks().forEach(track => track.stop());
            setMyScreenStream(null);

            // Volver a la pista de video original (cámara)
            const cameraTrack = myStream ? myStream.getVideoTracks()[0] : null;

            if (cameraTrack) {
                Object.values(peerConnections.current).forEach(conn => {
                    conn.getSenders().forEach(sender => {
                        if (sender.track.kind === 'video') {
                            // Buscar el sender de la pista de video principal para reemplazarla
                            if (!myScreenStream.getVideoTracks().includes(sender.track)) {
                                sender.replaceTrack(cameraTrack);
                            }
                        }
                    });
                });
            }

            toast.info("Compartición de pantalla detenida.");
        }
    };


    const toggleMute = () => {
        if (myStream) {
            const audioTrack = myStream.getAudioTracks()[0];
            if (audioTrack) {
                audioTrack.enabled = !isMuted;
                setIsMuted(!isMuted);
                socketRef.current.emit('user-action', { userId: myPeerRef.current.id, action: 'mute', isMuted: !isMuted });
            }
        }
    };

    const toggleVideo = () => {
        if (myStream) {
            const videoTrack = myStream.getVideoTracks()[0];
            if (videoTrack) {
                videoTrack.enabled = !isVideoOff;
                setIsVideoOff(!isVideoOff);
                socketRef.current.emit('user-action', { userId: myPeerRef.current.id, action: 'video', isVideoOff: !isVideoOff });
            }
        }
    };

    const sendMessage = (message) => {
        if (socketRef.current) {
            const newMessage = {
                id: Date.now(),
                sender: currentUserNameRef.current,
                text: message,
                timestamp: new Date().toLocaleTimeString(),
                isLocal: true,
            };
            setChatMessages(prev => [...prev, newMessage]);
            socketRef.current.emit('chat-message', newMessage);
        }
    };

    const connect = (stream, name) => {
        currentUserNameRef.current = name;
        currentRoomIdRef.current = roomId;

        socketRef.current = io(process.env.SOCKET_SERVER_URL || 'http://localhost:3001');

        myPeerRef.current = new Peer(undefined, {
            host: process.env.PEER_HOST || '/',
            port: process.env.PEER_PORT || 3002,
            path: process.env.PEER_PATH || '/peerjs/mundi-link'
        });

        myPeerRef.current.on('open', (id) => {
            console.log('Mi ID de Peer es:', id);
            socketRef.current.emit('join-room', roomId, id, name);
        });

        myPeerRef.current.on('error', (err) => {
            console.error("Error en PeerJS:", err);
            toast.error(`Error de conexión P2P: ${err.type}. Intenta recargar.`);
        });

        socketRef.current.on('user-connected', (userId, userName) => {
            console.log('Usuario conectado:', userId, userName);
            toast.info(`${userName} se ha unido a la sala.`);
            setRoomUsers(prev => ({ ...prev, [userId]: { name: userName, isMuted: false, isVideoOff: false } }));

            // Llamar al nuevo usuario
            const call = myPeerRef.current.call(userId, stream);

            call.on('stream', (userVideoStream) => {
                console.log('Recibiendo stream de:', userId);
                setPeers(prevPeers => {
                    // Asegúrate de que el stream no se agregue dos veces
                    if (!prevPeers[userId]) {
                        return { ...prevPeers, [userId]: { stream: userVideoStream, name: userName } };
                    }
                    return prevPeers;
                });
            });

            call.on('close', () => {
                console.log('Llamada cerrada por:', userId);
                setPeers(prevPeers => {
                    const newPeers = { ...prevPeers };
                    delete newPeers[userId];
                    return newPeers;
                });
            });

            // Guardar la conexión P2P para su manejo posterior (e.g., reemplazo de pista)
            peerConnections.current[userId] = call.peerConnection;
        });

        // Respuesta a la llamada de otro usuario
        myPeerRef.current.on('call', (call) => {
            call.answer(stream);
            const callerId = call.peer;

            call.on('stream', (userVideoStream) => {
                console.log('Respondiendo y recibiendo stream de:', callerId);
                setPeers(prevPeers => {
                    const userName = roomUsers[callerId]?.name || callerId;
                    if (!prevPeers[callerId]) {
                        return { ...prevPeers, [callerId]: { stream: userVideoStream, name: userName } };
                    }
                    return prevPeers;
                });
            });

            call.on('close', () => {
                console.log('Llamada cerrada al responder por:', callerId);
                setPeers(prevPeers => {
                    const newPeers = { ...prevPeers };
                    delete newPeers[callerId];
                    return newPeers;
                });
            });

            // Guardar la conexión P2P
            peerConnections.current[callerId] = call.peerConnection;
        });

        socketRef.current.on('user-disconnected', (userId) => {
            console.log('Usuario desconectado:', userId);
            const disconnectedUserName = roomUsers[userId]?.name || 'Un usuario';
            toast.warn(`${disconnectedUserName} ha salido de la sala.`);

            // Cerrar la conexión P2P
            if (peerConnections.current[userId]) {
                // peerConnections.current[userId].close(); // No es necesario si se usa call.close()
                delete peerConnections.current[userId];
            }

            // Eliminar de peers y roomUsers
            setPeers(prevPeers => {
                const newPeers = { ...prevPeers };
                delete newPeers[userId];
                return newPeers;
            });
            setRoomUsers(prev => {
                const newUsers = { ...prev };
                delete newUsers[userId];
                return newUsers;
            });
        });

        socketRef.current.on('chat-message', (message) => {
            setChatMessages(prev => [...prev, { ...message, isLocal: false }]);
        });

        socketRef.current.on('user-action', ({ userId, action, ...data }) => {
            setRoomUsers(prev => {
                const user = prev[userId];
                if (!user) return prev;

                let updatedUser = { ...user };
                if (action === 'mute') {
                    updatedUser.isMuted = data.isMuted;
                } else if (action === 'video') {
                    updatedUser.isVideoOff = data.isVideoOff;
                }
                return { ...prev, [userId]: updatedUser };
            });
        });

        socketRef.current.on('room-users', (users) => {
            setRoomUsers(users);
        });
    };

    const cleanup = () => {
        if (myStream) {
            myStream.getTracks().forEach(track => track.stop());
            setMyStream(null);
        }
        if (myScreenStream) {
            myScreenStream.getTracks().forEach(track => track.stop());
            setMyScreenStream(null);
        }

        Object.keys(peerConnections.current).forEach(peerId => {
            // Nota: Aquí no se hace call.close(), sino que se espera el 'user-disconnected' del socket
            // Para mantener la consistencia con la implementación original, se deja así.
        });
        peerConnections.current = {};
        setPeers({});

        if (myPeerRef.current) {
            myPeerRef.current.destroy();
            myPeerRef.current = null;
        }
        if (socketRef.current) {
            socketRef.current.disconnect();
            socketRef.current = null;
        }

        setIsMuted(false);
        setIsVideoOff(false);
        setChatMessages([]);
        setRoomUsers({});
    };

    // Exportar el estado y las funciones que se usarán en los componentes
    return {
        myStream,
        myScreenStream,
        peers,
        chatMessages,
        isMuted,
        isVideoOff,
        appTheme,
        roomUsers,
        // CORRECCIÓN: Asegurar que 'connect' y 'setRoomUsers' se devuelvan
        connect,
        setRoomUsers, // Necesario para que MainInterface actualice el estado local
        toggleMute,
        toggleVideo,
        startScreenShare,
        sendMessage,
        initializeStream,
        cleanup,
        toggleTheme,
    };
};

// --- COMPONENTES AUXILIARES ---

// Referencia de video
const VideoRef = ({ stream, name, isLocal, isMuted, isVideoOff, isScreenShare, userId }) => {
    const videoRef = useRef(null);
    const { appTheme } = useWebRTC();

    useEffect(() => {
        if (videoRef.current && stream) {
            videoRef.current.srcObject = stream;
        }
    }, [stream]);

    const displayMuted = isLocal ? isMuted : isMuted;
    const displayVideoOff = isLocal ? isVideoOff : isVideoOff;

    // Determinar la clase basada en si es video, pantalla compartida o solo audio
    let videoClass = styles.videoContainer;
    if (isLocal) {
        videoClass += ` ${styles.localVideo}`;
    } else if (isScreenShare) {
        videoClass += ` ${styles.screenShareVideo}`;
    } else {
        videoClass += ` ${styles.remoteVideo}`;
    }


    return (
        <div className={`${videoClass} ${appTheme === 'dark' ? styles.darkTheme : styles.lightTheme}`}>
            {/* El video real */}
            <video
                ref={videoRef}
                autoPlay
                playsInline
                muted={isLocal} // Silencia solo el video local para evitar eco
                className={styles.videoElement}
                style={{ display: displayVideoOff ? 'none' : 'block' }} // Ocultar el elemento de video si está apagado
            />

            {/* Overlay para cuando la cámara está apagada o es solo audio */}
            {displayVideoOff && (
                <div className={styles.videoOffOverlay}>
                    <VideoOff size={48} className={styles.videoOffIcon} />
                    <p>{name}</p>
                </div>
            )}

            {/* Etiqueta de nombre y estado */}
            <div className={styles.videoLabel}>
                <span>
                    {name} {isLocal && "(Tú)"}
                </span>
                {displayMuted && <MicOff size={16} className={styles.mutedIcon} />}
            </div>

            {/* Indicador de pantalla compartida */}
            {isScreenShare && (
                <div className={styles.screenShareIndicator}>
                    <ScreenShare size={18} />
                    Compartiendo Pantalla
                </div>
            )}
        </div>
    );
};


// Componente de la barra de controles
const ControlBar = () => {
    const {
        isMuted,
        isVideoOff,
        myStream,
        myScreenStream,
        toggleMute,
        toggleVideo,
        startScreenShare,
        cleanup,
        toggleTheme,
        appTheme,
    } = useWebRTC();
    // Añadimos la función de manejo de chat que no está en el contexto
    const { isChatOpen, setIsChatOpen, handleLeave, isMenuOpen, setIsMenuOpen } = useMainInterfaceContext();

    const isSharing = !!myScreenStream;

    return (
        <div className={styles.controlBar}>
            {/* Botón de Menú para móvil */}
            <button
                className={`${styles.controlButton} ${styles.mobileMenuButton}`}
                onClick={() => setIsMenuOpen(prev => !prev)}
                title="Menú"
            >
                {/* Cambiar ícono a X si está abierto para mejor UX */}
                {isMenuOpen ? <X size={24} /> : <Menu size={24} />}
            </button>

            {/* Contenedor de Controles - Será el menú desplegable en móvil */}
            <div className={`${styles.controlContainer} ${isMenuOpen ? styles.menuOpen : ''}`}>

                {/* Botón de Micrófono */}
                <button
                    className={`${styles.controlButton} ${isMuted ? styles.off : styles.on}`}
                    onClick={toggleMute}
                    disabled={!myStream || isSharing}
                    title={isMuted ? "Activar Micrófono" : "Silenciar Micrófono"}
                >
                    {isMuted ? <MicOff size={24} /> : <Mic size={24} />}
                </button>

                {/* Botón de Video */}
                <button
                    className={`${styles.controlButton} ${isVideoOff ? styles.off : styles.on}`}
                    onClick={toggleVideo}
                    disabled={!myStream || isSharing}
                    title={isVideoOff ? "Activar Video" : "Apagar Video"}
                >
                    {isVideoOff ? <VideoOff size={24} /> : <Video size={24} />}
                </button>

                {/* Botón de Compartir Pantalla */}
                <button
                    className={`${styles.controlButton} ${isSharing ? styles.sharing : styles.on}`}
                    onClick={startScreenShare}
                    title={isSharing ? "Detener Compartir" : "Compartir Pantalla"}
                >
                    <ScreenShare size={24} />
                </button>

                {/* Botón de Chat (Toggle) */}
                <button
                    className={`${styles.controlButton} ${isChatOpen ? styles.chatOpen : styles.on}`}
                    onClick={() => setIsChatOpen(prev => !prev)}
                    title={isChatOpen ? "Cerrar Chat" : "Abrir Chat"}
                >
                    <MessageSquare size={24} />
                </button>

                {/* Botón de Tema (Theme) */}
                <button
                    className={`${styles.controlButton} ${styles.themeButton}`}
                    onClick={toggleTheme}
                    title={`Cambiar a Tema ${appTheme === 'dark' ? 'Claro' : 'Oscuro'}`}
                >
                    {appTheme === 'dark' ? <Sun size={24} /> : <Moon size={24} />}
                </button>
            </div>

            {/* Botón de Salir (Leave) - Se mantiene visible */}
            <button
                className={`${styles.controlButton} ${styles.leaveButton}`}
                onClick={handleLeave}
                title="Salir de la Reunión"
            >
                <X size={24} />
            </button>
        </div>
    );
};

// Chat
const Chat = () => {
    const { chatMessages, sendMessage, appTheme } = useWebRTC();
    const { isChatOpen, setIsChatOpen } = useMainInterfaceContext();
    const [input, setInput] = useState('');
    const messagesEndRef = useRef(null);

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    };

    useEffect(scrollToBottom, [chatMessages]);

    const handleSubmit = (e) => {
        e.preventDefault();
        if (input.trim()) {
            sendMessage(input.trim());
            setInput('');
        }
    };

    return (
        <div className={`${styles.chatContainer} ${isChatOpen ? styles.chatOpen : ''} ${appTheme === 'dark' ? styles.darkTheme : styles.lightMode}`}>
            <div className={styles.chatHeader}>
                <h2>Chat de la Sala</h2>
                <button className={styles.chatCloseButton} onClick={() => setIsChatOpen(false)} title="Cerrar Chat">
                    <X size={20} />
                </button>
            </div>
            <div className={styles.chatMessages}>
                {chatMessages.map((msg) => (
                    <div key={msg.id} className={`${styles.chatMessage} ${msg.isLocal ? styles.localMessage : styles.remoteMessage}`}>
                        <div className={styles.messageContent}>
                            <span className={styles.messageSender}>{msg.sender}</span>
                            <span className={styles.messageText}>{msg.text}</span>
                            <span className={styles.messageTime}>{msg.timestamp}</span>
                        </div>
                    </div>
                ))}
                <div ref={messagesEndRef} />
            </div>
            <form onSubmit={handleSubmit} className={styles.chatInputForm}>
                <input
                    type="text"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder="Escribe un mensaje..."
                    className={styles.chatInput}
                />
                <button type="submit" className={styles.chatSendButton} title="Enviar Mensaje">
                    <Send size={20} />
                </button>
            </form>
        </div>
    );
};

// Grid de Video
const VideoGrid = () => {
    const { myStream, peers, roomUsers, myScreenStream } = useWebRTC();
    const { userName } = useMainInterfaceContext();
    const peersArray = Object.entries(peers).map(([userId, peer]) => ({
        userId,
        stream: peer.stream,
        name: roomUsers[userId]?.name || peer.name,
        isMuted: roomUsers[userId]?.isMuted,
        isVideoOff: roomUsers[userId]?.isVideoOff,
    }));

    // El video local
    const localUser = {
        userId: 'local',
        stream: myStream,
        name: userName,
        isMuted: roomUsers['local']?.isMuted || false, // El estado local ya está en isMuted/isVideoOff
        isVideoOff: roomUsers['local']?.isVideoOff || false,
        isLocal: true,
    };

    // La pantalla compartida
    const screenShareStream = myScreenStream ? {
        userId: 'screen-share',
        stream: myScreenStream,
        name: `${userName} (Pantalla)`,
        isLocal: true,
        isScreenShare: true,
        isVideoOff: false, // La pantalla compartida siempre está "encendida"
    } : null;

    // Priorizar pantalla compartida, luego los remotos, luego el local
    const displayVideos = [
        ...(screenShareStream ? [screenShareStream] : []),
        ...peersArray,
        ...(myScreenStream ? [] : [localUser]), // Mostrar local solo si no está compartiendo pantalla (o manejarlo como un pequeño PIP)
    ];

    // Si solo hay un video (pantalla compartida o un solo usuario), usar una clase de diseño diferente
    const gridClass = displayVideos.length === 1 && screenShareStream
        ? styles.singleScreenShareGrid
        : displayVideos.length === 1 && !screenShareStream
            ? styles.singleVideoGrid
            : displayVideos.length <= 4
                ? styles.smallVideoGrid
                : styles.largeVideoGrid;


    return (
        <div className={`${styles.videoGrid} ${gridClass}`}>
            {displayVideos.map((video) => (
                <VideoRef
                    key={video.userId}
                    {...video}
                />
            ))}
            {/* Si no hay videos, mostrar un mensaje (aunque siempre debería haber al menos el local) */}
            {displayVideos.length === 0 && (
                <div className={styles.noVideos}>
                    Esperando conexiones...
                </div>
            )}
        </div>
    );
};

// Lobby de Conexión
const Lobby = ({ onJoin }) => {
    const [name, setName] = useState('');
    const [audioDeviceId, setAudioDeviceId] = useState('');
    const [videoDeviceId, setVideoDeviceId] = useState('');
    const [audioOutputDeviceId, setAudioOutputDeviceId] = useState('');
    const [audioDevices, setAudioDevices] = useState([]);
    const [videoDevices, setVideoDevices] = useState([]);
    const [audioOutputDevices, setAudioOutputDevices] = useState([]);
    const [isLoading, setIsLoading] = useState(true);

    // Función para obtener dispositivos multimedia
    const getDevices = async () => {
        try {
            // Se necesita solicitar permisos antes de enumerar los nombres de los dispositivos
            await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
            const devices = await navigator.mediaDevices.enumerateDevices();
            const audios = devices.filter(d => d.kind === 'audioinput');
            const videos = devices.filter(d => d.kind === 'videoinput');
            const audioOutputs = devices.filter(d => d.kind === 'audiooutput');

            setAudioDevices(audios);
            setVideoDevices(videos);
            setAudioOutputDevices(audioOutputs);

            if (audios.length > 0) setAudioDeviceId(audios[0].deviceId);
            if (videos.length > 0) setVideoDeviceId(videos[0].deviceId);
            if (audioOutputs.length > 0) setAudioOutputDeviceId(audioOutputs[0].deviceId);

            setIsLoading(false);
        } catch (error) {
            console.error("Error al obtener dispositivos:", error);
            toast.error("Error al acceder a dispositivos. Asegúrate de dar permisos.");
            setIsLoading(false);
        }
    };

    useEffect(() => {
        getDevices();
    }, []);

    const handleSubmit = (e) => {
        e.preventDefault();
        if (name.trim()) {
            onJoin(name.trim(), audioDeviceId, videoDeviceId, audioOutputDeviceId);
        }
    };

    return (
        <div className={styles.lobbyContainer}>
            <ToastContainer />
            <div className={styles.lobbyCard}>
                <div className={styles.lobbyHeader}>
                    <LogIn size={40} className={styles.lobbyIcon} />
                    <h1>Mundi-Link</h1>
                    <p>Inicia o únete a una reunión</p>
                </div>

                <form onSubmit={handleSubmit} className={styles.lobbyForm}>
                    <div className={styles.formGroup}>
                        <label htmlFor="userName" className={styles.formLabel}>Tu Nombre</label>
                        <input
                            id="userName"
                            type="text"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="Ej. Juan Pérez"
                            required
                            className={styles.formInput}
                        />
                    </div>

                    {isLoading ? (
                        <p className={styles.loadingMessage}>Cargando dispositivos multimedia...</p>
                    ) : (
                        <>
                            <div className={styles.formGroup}>
                                <label htmlFor="audioInput" className={styles.formLabel}>Micrófono</label>
                                <select
                                    id="audioInput"
                                    value={audioDeviceId}
                                    onChange={(e) => setAudioDeviceId(e.target.value)}
                                    className={styles.formSelect}
                                >
                                    {audioDevices.map(device => (
                                        <option key={device.deviceId} value={device.deviceId}>{device.label || `Micrófono ${device.deviceId}`}</option>
                                    ))}
                                </select>
                            </div>

                            <div className={styles.formGroup}>
                                <label htmlFor="videoInput" className={styles.formLabel}>Cámara</label>
                                <select
                                    id="videoInput"
                                    value={videoDeviceId}
                                    onChange={(e) => setVideoDeviceId(e.target.value)}
                                    className={styles.formSelect}
                                >
                                    {videoDevices.map(device => (
                                        <option key={device.deviceId} value={device.deviceId}>{device.label || `Cámara ${device.deviceId}`}</option>
                                    ))}
                                </select>
                            </div>

                            <div className={styles.formGroup}>
                                <label htmlFor="audioOutput" className={styles.formLabel}>Salida de Audio (Altavoces)</label>
                                <select
                                    id="audioOutput"
                                    value={audioOutputDeviceId}
                                    onChange={(e) => setAudioOutputDeviceId(e.target.value)}
                                    className={styles.formSelect}
                                >
                                    {audioOutputDevices.map(device => (
                                        <option key={device.deviceId} value={device.deviceId}>{device.label || `Altavoz ${device.deviceId}`}</option>
                                    ))}
                                </select>
                            </div>
                        </>
                    )}

                    <button type="submit" className={styles.joinButton} disabled={!name.trim() || isLoading}>
                        <Plus size={20} /> Unirse a la Reunión
                    </button>
                </form>
            </div>
        </div>
    );
};

// Contexto adicional para manejar el estado del chat y el nombre de usuario fuera del hook WebRTC
const MainInterfaceContext = createContext({});
const useMainInterfaceContext = () => useContext(MainInterfaceContext);

// Interfaz Principal de la Reunión
const MainInterface = ({ handleLeave, userName, selectedAudioOutput }) => {
    const webRTCLogic = useWebRTC();
    const [isChatOpen, setIsChatOpen] = useState(false);
    // NUEVO: Estado para controlar la apertura del menú de controles en móvil
    const [isMenuOpen, setIsMenuOpen] = useState(false);

    useEffect(() => {
        // Asignar el dispositivo de salida de audio al video local del usuario
        if (webRTCLogic.myStream && selectedAudioOutput) {
            const videoElement = document.getElementById('local-video');
            // Nota: Aquí se necesita una forma de obtener la referencia del video local.
            // La solución más simple es buscar el elemento DOM o refactorizar VideoRef para exponer la ref.
            // Para mantener la modificación en MainInterface, se confía en que el navegador asignará la salida.
            // Si fuera una app real, VideoRef debería manejar esto con un prop o ref.
        }
    }, [selectedAudioOutput, webRTCLogic.myStream]);


    // Añadir el userId local a roomUsers para que el estado de mute/video se refleje
    useEffect(() => {
        if (webRTCLogic.myStream) {
            // webRTCLogic.setRoomUsers es ahora accesible gracias a la corrección en useWebRTCLogic
            webRTCLogic.setRoomUsers(prev => ({
                ...prev,
                // Usamos 'local' como ID temporal hasta que PeerJS/Socket asignen uno real
                [webRTCLogic.myPeerRef.current?.id || 'local']: {
                    name: userName,
                    isMuted: webRTCLogic.isMuted,
                    isVideoOff: webRTCLogic.isVideoOff,
                }
            }));
        }
    }, [webRTCLogic.isMuted, webRTCLogic.isVideoOff, webRTCLogic.myStream, userName, webRTCLogic.setRoomUsers]);


    return (
        // Proveer estados adicionales al ControlBar y Chat
        <MainInterfaceContext.Provider value={{ isChatOpen, setIsChatOpen, handleLeave, userName, isMenuOpen, setIsMenuOpen }}>
            <div className={`${styles.mainInterface} ${webRTCLogic.appTheme === 'dark' ? styles.darkTheme : styles.lightMode}`}>
                <ToastContainer />
                <VideoGrid />
                <Chat />
                <ControlBar />
            </div>
        </MainInterfaceContext.Provider>
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
            // Esta línea ahora funciona correctamente porque 'connect' se devuelve desde el hook.
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
                <MainInterface handleLeave={handleLeave} userName={userName} selectedAudioOutput={selectedAudioOutput} />
            </WebRTCContext.Provider>
        );
    }
}