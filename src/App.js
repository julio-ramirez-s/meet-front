import React, { useState, useEffect, useRef, createContext, useContext, useCallback } from 'react';
import { Mic, MicOff, Video, VideoOff, ScreenShare, MessageSquare, Send, X, LogIn, Plus, Sun, Moon, Settings, Users, Volume2, VolumeX, Minimize2, Maximize2 } from 'lucide-react'; 
import { io } from 'socket.io-client';
import Peer from 'peerjs';
import { ToastContainer, toast } from 'react-toastify';
import 'react-toastify/dist/React-Toastify.css';
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
    const currentPeerIdRef = useRef('');

    const toggleTheme = () => {
        const newTheme = appTheme === 'dark' ? 'light' : 'dark';
        setAppTheme(newTheme);
        document.body.className = newTheme === 'light' ? styles.lightMode : '';
    };

    // Lógica para inicializar el stream (sin cambios)
    const initializeStream = async (audioDeviceId, videoDeviceId) => {
        try {
            const constraints = {
                video: { deviceId: videoDeviceId ? { exact: videoDeviceId } : true },
                audio: { deviceId: audioDeviceId ? { exact: audioDeviceId } : true }
            };
            const stream = await navigator.mediaDevices.getUserMedia(constraints);
            
            // Establecer el estado inicial de mute/video basado en si la cámara/micrófono se obtuvo
            const audioTrack = stream.getAudioTracks()[0];
            const videoTrack = stream.getVideoTracks()[0];

            setIsMuted(audioTrack ? !audioTrack.enabled : false);
            setIsVideoOff(videoTrack ? !videoTrack.enabled : false);

            setMyStream(stream);
            return stream;
        } catch (error) {
            console.error("Error al obtener el stream:", error);
            toast.error("No se pudo acceder a la cámara o micrófono. Por favor, revisa los permisos.");
            return null;
        }
    };

    // Lógica de conexión a Socket.IO y PeerJS (CORRECCIÓN APLICADA AQUÍ)
    const connect = useCallback((stream, userName) => {
        currentUserNameRef.current = userName;

        const SERVER_URL = "https://meet-clone-v0ov.onrender.com"; // URL del servidor de Render
        const API_HOST = new URL(SERVER_URL).hostname;

        socketRef.current = io(SERVER_URL);
        
        // CORRECCIÓN CLAVE: El PeerServer está montado en /peerjs y el ExpressPeerServer tiene path: '/myapp'.
        // La ruta completa debe ser '/peerjs/myapp'.
        myPeerRef.current = new Peer(undefined, { 
            host: API_HOST, 
            path: '/peerjs/myapp', // <--- RUTA CORREGIDA
            secure: true, 
            port: 443 
        });

        // --- MANEJO DE PEERJS ---
        myPeerRef.current.on('open', (id) => {
            currentPeerIdRef.current = id;
            console.log('Mi ID de Peer es:', id);
            // Al unirse, enviar el estado inicial de mute/video
            socketRef.current.emit('join-room', roomId, id, userName, { 
                isMuted: isMuted,
                isVideoOff: isVideoOff,
                isSharingScreen: false
            });
        });

        // Al recibir una llamada de un nuevo usuario
        myPeerRef.current.on('call', (call) => {
            console.log('Recibiendo llamada:', call.peer);
            call.answer(stream);

            call.on('stream', (userVideoStream) => {
                console.log('Stream recibido de:', call.peer);
                setPeers(prevPeers => ({
                    ...prevPeers,
                    [call.peer]: { stream: userVideoStream, call: call }
                }));
            });
            peerConnections.current[call.peer] = call;
        });

        myPeerRef.current.on('error', (err) => {
            console.error('Error en PeerJS:', err);
            toast.error(`Error de conexión P2P: ${err.type}`);
        });

        // --- MANEJO DE SOCKET.IO ---

        // Nuevo usuario se une a la sala (solo notifica)
        socketRef.current.on('user-connected', (userId, userName) => {
            toast.info(`${userName} se ha unido a la sala.`);
            // No hacemos la llamada aquí, ya que 'room-state' se encargará.
        });

        // Estado inicial de la sala y llamadas a usuarios existentes
        socketRef.current.on('room-state', (users) => {
            setRoomUsers(users);
            console.log('Estado de la sala recibido:', users);
            
            // Llama a todos los usuarios, excepto a mí mismo, solo si el stream está listo
            if (stream) {
                Object.entries(users).forEach(([id, user]) => {
                    if (id !== currentPeerIdRef.current) {
                        // Comprobar si ya existe una conexión para evitar llamadas duplicadas
                        if (!peerConnections.current[id]) {
                            connectToNewUser(id, user.name, stream);
                        }
                    }
                });
            }
        });
        
        // Actualización de estado (mute/video)
        socketRef.current.on('user-status-update', (userId, status) => {
            setRoomUsers(prevUsers => ({
                ...prevUsers,
                [userId]: { ...prevUsers[userId], ...status }
            }));
        });

        // Usuario se desconecta
        socketRef.current.on('user-disconnected', (userId, userName) => {
            toast.warning(`${userName} ha abandonado la sala.`);
            // Cierra la conexión PeerJS
            if (peerConnections.current[userId]) {
                peerConnections.current[userId].close();
                delete peerConnections.current[userId];
            }
            // Elimina el par de la lista
            setPeers(prevPeers => {
                const newPeers = { ...prevPeers };
                delete newPeers[userId];
                return newPeers;
            });
            // Actualiza la lista de usuarios de la sala
            setRoomUsers(prevUsers => {
                const newUsers = { ...prevUsers };
                delete newUsers[userId];
                return newUsers;
            });
        });

        // Manejo del chat
        socketRef.current.on('chat-message', (message) => {
            setChatMessages(prevMessages => [...prevMessages, message]);
        });
    }, [roomId, isMuted, isVideoOff]); // Dependencias: isMuted y isVideoOff para enviar el estado inicial


    // Función para llamar a un nuevo usuario (sin cambios)
    const connectToNewUser = (userId, userName, stream) => {
        if (!myPeerRef.current || !stream) return;
        console.log(`Llamando al nuevo usuario: ${userName} (${userId})`);

        const call = myPeerRef.current.call(userId, stream);
        
        call.on('stream', (userVideoStream) => {
            console.log('Stream recibido (outbound):', userId);
            setPeers(prevPeers => ({
                ...prevPeers,
                [userId]: { stream: userVideoStream, call: call }
            }));
        });

        call.on('close', () => {
            console.log('Llamada cerrada con:', userId);
            setPeers(prevPeers => {
                const newPeers = { ...prevPeers };
                delete newPeers[userId];
                return newPeers;
            });
        });

        peerConnections.current[userId] = call;
    };

    // --- CONTROLES DE WEBRTC ---
    
    // Toggle Mute (sin cambios)
    const toggleMute = () => {
        if (!myStream) return;
        const audioTrack = myStream.getAudioTracks()[0];
        if (audioTrack) {
            audioTrack.enabled = !isMuted;
            setIsMuted(!isMuted);
            socketRef.current.emit('update-status', { isMuted: !isMuted });
            toast.info(`Micrófono: ${!isMuted ? 'ON' : 'OFF'}`);
        }
    };

    // Toggle Video (sin cambios)
    const toggleVideo = () => {
        if (!myStream) return;
        const videoTrack = myStream.getVideoTracks()[0];
        if (videoTrack) {
            videoTrack.enabled = !isVideoOff;
            setIsVideoOff(!isVideoOff);
            socketRef.current.emit('update-status', { isVideoOff: !isVideoOff });
            toast.info(`Cámara: ${!isVideoOff ? 'ON' : 'OFF'}`);
        }
    };

    // Toggle Compartir Pantalla (sin cambios funcionales)
    const toggleScreenShare = async () => {
        if (myScreenStream) {
            // Detener compartición de pantalla
            myScreenStream.getTracks().forEach(track => track.stop());
            setMyScreenStream(null);

            // Reemplazar la pista de video por la original en todas las llamadas
            const videoTrack = myStream.getVideoTracks()[0];
            Object.values(peerConnections.current).forEach(call => {
                const sender = call.peerConnection.getSenders().find(s => s.track.kind === 'video');
                if (sender) {
                    sender.replaceTrack(videoTrack);
                }
            });
            toast.info("Compartición de pantalla detenida.");
            socketRef.current.emit('update-status', { isSharingScreen: false });

        } else {
            // Iniciar compartición de pantalla
            try {
                const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
                setMyScreenStream(screenStream);

                // Reemplazar la pista de video por la de la pantalla
                const screenVideoTrack = screenStream.getVideoTracks()[0];
                Object.values(peerConnections.current).forEach(call => {
                    const sender = call.peerConnection.getSenders().find(s => s.track.kind === 'video');
                    if (sender) {
                        sender.replaceTrack(screenVideoTrack);
                    }
                });

                // Detener el stream de pantalla cuando el usuario pulsa 'detener' en el navegador
                screenVideoTrack.onended = () => toggleScreenShare();
                
                toast.success("Compartiendo mi pantalla.");
                socketRef.current.emit('update-status', { isSharingScreen: true });

            } catch (error) {
                console.error("Error al compartir pantalla:", error);
                toast.error("No se pudo iniciar la compartición de pantalla.");
            }
        }
    };

    // Enviar mensaje de Chat (sin cambios)
    const sendChatMessage = (message) => {
        if (socketRef.current && message.trim()) {
            const timestamp = new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
            const messageData = {
                text: message,
                sender: currentUserNameRef.current,
                timestamp: timestamp,
                isMine: true
            };
            setChatMessages(prevMessages => [...prevMessages, messageData]);
            socketRef.current.emit('chat-message', { ...messageData, isMine: false });
        }
    };

    // Limpieza al salir (sin cambios)
    const cleanup = () => {
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
        Object.values(peerConnections.current).forEach(call => call.close());
        peerConnections.current = {};
        setPeers({});
        setRoomUsers({});
    };

    return {
        myStream, myScreenStream, peers, chatMessages, isMuted, isVideoOff, appTheme,
        roomUsers, initializeStream, connect, toggleMute, toggleVideo, toggleScreenShare,
        sendChatMessage, cleanup, toggleTheme, currentUserId: currentPeerIdRef.current,
        currentUserName: currentUserNameRef.current,
    };
};

// --- COMPONENTES DE UI ---

// Componente para manejar el audio output (sin cambios)
const VideoComponent = React.memo(({ stream, muted, name, isLocal, isMuted, isVideoOff, isScreen, isSharingScreen }) => {
    const videoRef = useRef(null);
    useEffect(() => {
        if (videoRef.current && stream) {
            videoRef.current.srcObject = stream;
        }
    }, [stream]);

    const statusIcon = isScreen ? <ScreenShare size={18} /> : (isMuted ? <MicOff size={18} /> : <Mic size={18} />);
    const videoIcon = isVideoOff ? <VideoOff size={32} /> : null;
    
    return (
        <div className={`${styles.videoContainer} ${isLocal ? styles.localVideo : ''} ${isScreen ? styles.screenShareVideo : ''} ${isSharingScreen ? styles.remoteScreenShare : ''}`}>
            <video 
                ref={videoRef} 
                className={styles.videoElement} 
                autoPlay 
                muted={muted} 
                playsInline 
                style={{ display: isVideoOff && !isScreen ? 'none' : 'block' }}
            />
            {videoIcon && (
                <div className={styles.videoOffOverlay}>
                    {videoIcon}
                    <span className="mt-2 text-sm">{name}</span>
                </div>
            )}
            <div className={styles.nameTag}>
                {statusIcon}
                <span className="ml-1">{name} {isLocal ? '(Yo)' : ''}</span>
            </div>
            {isScreen && <div className={styles.screenShareLabel}>Compartiendo Pantalla</div>}
        </div>
    );
});

// NUEVO: Galería de Videos
const VideoGallery = () => {
    const { 
        myStream, myScreenStream, peers, roomUsers, currentUserId, 
        isMuted, isVideoOff, currentUserName 
    } = useWebRTC();
    
    // Crear una lista de todos los streams, incluyendo el propio.
    const allStreams = [];

    // 1. Agregar el stream propio
    if (myStream) {
        // Obtenemos el estado más reciente del usuario local
        const localStatus = roomUsers[currentUserId] || { isMuted, isVideoOff, isSharingScreen: !!myScreenStream };

        allStreams.push({
            id: currentUserId,
            name: currentUserName,
            stream: myStream,
            isLocal: true,
            isMuted: localStatus.isMuted,
            isVideoOff: localStatus.isVideoOff,
            isScreen: false,
            isSharingScreen: localStatus.isSharingScreen
        });
    }

    // 2. Agregar el stream de mi pantalla compartida
    if (myScreenStream) {
        allStreams.unshift({ // Poner al inicio para prioridad
            id: `${currentUserId}-screen`,
            name: `${currentUserName} (Pantalla)`,
            stream: myScreenStream,
            isLocal: true,
            isMuted: false,
            isVideoOff: false,
            isScreen: true,
            isSharingScreen: true
        });
    }

    // 3. Agregar streams de otros usuarios
    Object.entries(peers).forEach(([id, peerData]) => {
        const userData = roomUsers[id] || {};
        const isSharingScreen = userData.isSharingScreen || false;
        
        if (peerData.stream) {
            // El stream de un peer es su cámara O su pantalla.
            // Si está compartiendo, tratamos su stream como pantalla remota.
            const isPeerScreen = isSharingScreen;

            allStreams.push({
                id: id,
                name: userData.name || id,
                stream: peerData.stream,
                isLocal: false,
                isMuted: userData.isMuted || false,
                isVideoOff: userData.isVideoOff || false,
                isScreen: isPeerScreen,
                isSharingScreen: isSharingScreen
            });
        }
    });

    // Filtra para mostrar solo streams únicos (puede haber duplicados si la lógica no es perfecta)
    const uniqueStreams = allStreams.filter((stream, index, self) => 
        index === self.findIndex((t) => t.id === stream.id)
    );

    // Si hay una pantalla compartida (local o remota), ponerla de primero
    uniqueStreams.sort((a, b) => {
        if (a.isScreen && !b.isScreen) return -1;
        if (!a.isScreen && b.isScreen) return 1;
        return 0;
    });

    return (
        <div className={styles.videoGallery}>
            {uniqueStreams.map(data => (
                <VideoComponent 
                    key={data.id}
                    stream={data.stream}
                    muted={data.isLocal} // Solo el stream local está silenciado localmente
                    name={data.name}
                    isLocal={data.isLocal}
                    isMuted={data.isMuted}
                    isVideoOff={data.isVideoOff}
                    isScreen={data.isScreen}
                    isSharingScreen={data.isSharingScreen}
                />
            ))}
        </div>
    );
};


// NUEVO: Panel de Controles Flotante
const ControlPanel = ({ onLeave, isControlsOpen, setIsControlsOpen, isChatOpen, setIsChatOpen }) => {
    const { 
        isMuted, isVideoOff, toggleMute, toggleVideo, 
        toggleScreenShare, myScreenStream, toggleTheme, appTheme 
    } = useWebRTC();

    const isSharingScreen = !!myScreenStream;

    return (
        <div className={styles.controlsBar}>
            
            {/* Botón Flotante principal (si no está abierto) */}
            {!isControlsOpen && (
                <button 
                    onClick={() => setIsControlsOpen(true)} 
                    className={`${styles.mainFloatingButton} ${styles.controlButton} ${styles.primaryControl}`}
                    aria-label="Abrir panel de control"
                >
                    <Settings size={24} />
                </button>
            )}

            {/* Panel de Controles Desplegado */}
            {isControlsOpen && (
                <div className={styles.floatingPanel}>
                    <button 
                        onClick={() => setIsControlsOpen(false)} 
                        className={styles.closePanelButton}
                        aria-label="Cerrar panel de control"
                    >
                        <X size={20} />
                    </button>

                    <div className={styles.controlButtonsGroup}>
                        {/* Botón Mute/Unmute */}
                        <button 
                            onClick={toggleMute} 
                            className={`${styles.controlButton} ${isMuted ? styles.dangerControl : styles.successControl}`}
                            aria-label={isMuted ? "Activar micrófono" : "Silenciar micrófono"}
                        >
                            {isMuted ? <MicOff size={24} /> : <Mic size={24} />}
                            <span className={styles.controlLabel}>{isMuted ? 'Unmute' : 'Mute'}</span>
                        </button>
                        
                        {/* Botón Video On/Off */}
                        <button 
                            onClick={toggleVideo} 
                            className={`${styles.controlButton} ${isVideoOff ? styles.dangerControl : styles.successControl}`}
                            aria-label={isVideoOff ? "Activar cámara" : "Desactivar cámara"}
                        >
                            {isVideoOff ? <VideoOff size={24} /> : <Video size={24} />}
                            <span className={styles.controlLabel}>{isVideoOff ? 'Video ON' : 'Video OFF'}</span>
                        </button>
                        
                        {/* Botón Compartir Pantalla */}
                        <button 
                            onClick={toggleScreenShare} 
                            className={`${styles.controlButton} ${isSharingScreen ? styles.primaryControl : styles.secondaryControl}`}
                            aria-label={isSharingScreen ? "Detener compartir pantalla" : "Compartir pantalla"}
                        >
                            <ScreenShare size={24} />
                            <span className={styles.controlLabel}>{isSharingScreen ? 'Detener' : 'Compartir'}</span>
                        </button>

                        {/* Botón Abrir Chat */}
                        <button 
                            onClick={() => setIsChatOpen(!isChatOpen)} 
                            className={`${styles.controlButton} ${isChatOpen ? styles.primaryControl : styles.secondaryControl}`}
                            aria-label={isChatOpen ? "Cerrar chat" : "Abrir chat"}
                        >
                            <MessageSquare size={24} />
                            <span className={styles.controlLabel}>Chat</span>
                        </button>
                        
                        {/* Botón Cambiar Tema */}
                        <button 
                            onClick={toggleTheme} 
                            className={`${styles.controlButton} ${styles.secondaryControl}`}
                            aria-label="Cambiar tema"
                        >
                            {appTheme === 'dark' ? <Sun size={24} /> : <Moon size={24} />}
                            <span className={styles.controlLabel}>{appTheme === 'dark' ? 'Claro' : 'Oscuro'}</span>
                        </button>
                        
                        {/* Botón Salir */}
                        <button 
                            onClick={onLeave} 
                            className={`${styles.controlButton} ${styles.leaveControl}`}
                            aria-label="Salir de la reunión"
                        >
                            <X size={24} />
                            <span className={styles.controlLabel}>Salir</span>
                        </button>
                    </div>
                </div>
            )}

        </div>
    );
};

// NUEVO: Panel de Chat Lateral
const ChatPanel = ({ isChatOpen, setIsChatOpen }) => {
    const { chatMessages, sendChatMessage, roomUsers, currentUserId } = useWebRTC();
    const [input, setInput] = useState('');
    const chatEndRef = useRef(null);

    const handleSubmit = (e) => {
        e.preventDefault();
        sendChatMessage(input);
        setInput('');
    };

    useEffect(() => {
        if (isChatOpen) {
            chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
        }
    }, [chatMessages, isChatOpen]);

    const activeUsersCount = Object.keys(roomUsers).length;

    return (
        <div className={`${styles.chatPanel} ${isChatOpen ? styles.chatPanelOpen : ''}`}>
            <div className={styles.chatHeader}>
                <h3 className="text-xl font-bold flex items-center">
                    <MessageSquare size={20} className="mr-2" />
                    Chat de la Sala
                </h3>
                <span className={styles.userCountBadge}>
                    <Users size={16} /> {activeUsersCount}
                </span>
                <button 
                    onClick={() => setIsChatOpen(false)} 
                    className={styles.chatCloseButton}
                    aria-label="Cerrar chat"
                >
                    <X size={20} />
                </button>
            </div>
            
            <div className={styles.chatMessages}>
                {chatMessages.map((msg, index) => (
                    <div key={index} className={`${styles.chatMessage} ${msg.isMine ? styles.myMessage : styles.otherMessage}`}>
                        <div className={styles.messageContent}>
                            <span className={styles.messageSender}>{msg.isMine ? 'Yo' : msg.sender}</span>
                            <p>{msg.text}</p>
                            <span className={styles.messageTime}>{msg.timestamp}</span>
                        </div>
                    </div>
                ))}
                <div ref={chatEndRef} />
            </div>

            <form onSubmit={handleSubmit} className={styles.chatInputForm}>
                <input 
                    type="text"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder="Escribe un mensaje..."
                    className={styles.chatInput}
                    disabled={!currentUserId}
                />
                <button type="submit" disabled={!currentUserId || input.trim() === ''} className={styles.chatSendButton} aria-label="Enviar mensaje">
                    <Send size={20} />
                </button>
            </form>
        </div>
    );
};


// Componente de Lobby (sin cambios, excepto estilos)
const Lobby = ({ onJoin }) => {
    const [name, setName] = useState('');
    const [audioDeviceId, setAudioDeviceId] = useState('');
    const [videoDeviceId, setVideoDeviceId] = useState('');
    const [audioOutputDeviceId, setAudioOutputDeviceId] = useState('');
    const [devices, setDevices] = useState({ audioIn: [], videoIn: [], audioOut: [] });
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        const getDevices = async () => {
            try {
                // Pedir permisos primero
                await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
                const deviceList = await navigator.mediaDevices.enumerateDevices();

                const audioIn = deviceList.filter(d => d.kind === 'audioinput');
                const videoIn = deviceList.filter(d => d.kind === 'videoinput');
                const audioOut = deviceList.filter(d => d.kind === 'audiooutput');

                setDevices({ audioIn, videoIn, audioOut });
                if (audioIn.length > 0) setAudioDeviceId(audioIn[0].deviceId);
                if (videoIn.length > 0) setVideoDeviceId(videoIn[0].deviceId);
                if (audioOut.length > 0) setAudioOutputDeviceId(audioOut[0].deviceId);
                
            } catch (error) {
                console.error("Error al obtener dispositivos o permisos:", error);
                toast.error("Error al acceder a los dispositivos. Por favor, revisa los permisos.");
            } finally {
                setIsLoading(false);
            }
        };

        getDevices();
    }, []);

    const handleSubmit = (e) => {
        e.preventDefault();
        if (name.trim()) {
            onJoin(name.trim(), audioDeviceId, videoDeviceId, audioOutputDeviceId);
        } else {
            toast.error("Por favor, ingresa tu nombre.");
        }
    };

    if (isLoading) {
        return <div className={styles.loadingMessage}>Cargando dispositivos...</div>;
    }

    return (
        <div className={styles.lobbyContainer}>
            <div className={styles.lobbyCard}>
                <h1 className={styles.lobbyTitle}>Unirse a la Reunión</h1>
                <form onSubmit={handleSubmit} className={styles.lobbyForm}>
                    <div className={styles.formGroup}>
                        <label className={styles.formLabel} htmlFor="name">Tu Nombre</label>
                        <input 
                            id="name"
                            type="text" 
                            value={name} 
                            onChange={(e) => setName(e.target.value)} 
                            className={styles.formInput} 
                            placeholder="Ej: John Doe"
                            required
                        />
                    </div>

                    <div className={styles.formGroup}>
                        <label className={styles.formLabel} htmlFor="video">Cámara</label>
                        <select 
                            id="video"
                            value={videoDeviceId} 
                            onChange={(e) => setVideoDeviceId(e.target.value)} 
                            className={styles.formSelect}
                        >
                            {devices.videoIn.map(device => (
                                <option key={device.deviceId} value={device.deviceId}>
                                    {device.label || `Video ${device.deviceId}`}
                                </option>
                            ))}
                        </select>
                    </div>

                    <div className={styles.formGroup}>
                        <label className={styles.formLabel} htmlFor="audio-in">Micrófono</label>
                        <select 
                            id="audio-in"
                            value={audioDeviceId} 
                            onChange={(e) => setAudioDeviceId(e.target.value)} 
                            className={styles.formSelect}
                        >
                            {devices.audioIn.map(device => (
                                <option key={device.deviceId} value={device.deviceId}>
                                    {device.label || `Audio In ${device.deviceId}`}
                                </option>
                            ))}
                        </select>
                    </div>

                    <div className={styles.formGroup}>
                        <label className={styles.formLabel} htmlFor="audio-out">Salida de Audio</label>
                        <select 
                            id="audio-out"
                            value={audioOutputDeviceId} 
                            onChange={(e) => setAudioOutputDeviceId(e.target.value)} 
                            className={styles.formSelect}
                        >
                            {devices.audioOut.map(device => (
                                <option key={device.deviceId} value={device.deviceId}>
                                    {device.label || `Audio Out ${device.deviceId}`}
                                </option>
                            ))}
                        </select>
                    </div>
                    
                    <button type="submit" className={styles.joinButton}>
                        <LogIn size={20} className="mr-2" />
                        Unirme a la Sala
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
    const [isControlsOpen, setIsControlsOpen] = useState(false); // Estado para el panel de controles
    const [isChatOpen, setIsChatOpen] = useState(false); // Estado para el panel de chat
    
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
        setIsControlsOpen(false);
        setIsChatOpen(false);
    };

    useEffect(() => {
        window.addEventListener('beforeunload', webRTCLogic.cleanup);
        return () => {
            window.removeEventListener('beforeunload', webRTCLogic.cleanup);
        };
    }, [webRTCLogic]);

    // Aplicar el tema al body
    useEffect(() => {
        document.body.className = webRTCLogic.appTheme === 'light' ? styles.lightMode : '';
    }, [webRTCLogic.appTheme]);


    if (!isJoined) {
        return (
            <>
                <Lobby onJoin={handleJoin} /> 
                <ToastContainer position="top-right" autoClose={3000} hideProgressBar newestOnTop={false} closeOnClick rtl={false} pauseOnFocusLoss draggable pauseOnHover theme={webRTCLogic.appTheme} />
            </>
        );
    } else {
        return (
            <WebRTCContext.Provider value={{ ...webRTCLogic, selectedAudioOutput, userName }}>
                <div className={styles.appContainer}>
                    <header className={styles.appHeader}>
                        <h1 className={styles.roomTitle}>
                            <Users size={20} className="mr-2" /> Sala de Reunión ({webRTCLogic.currentUserName})
                        </h1>
                        <button onClick={webRTCLogic.toggleTheme} className={styles.themeToggle} aria-label="Cambiar tema">
                            {webRTCLogic.appTheme === 'dark' ? <Sun size={20} /> : <Moon size={20} />}
                        </button>
                    </header>
                    
                    <main className={styles.mainContent}>
                        <VideoGallery />
                        <ChatPanel isChatOpen={isChatOpen} setIsChatOpen={setIsChatOpen} />
                    </main>

                    <ControlPanel 
                        onLeave={handleLeave} 
                        isControlsOpen={isControlsOpen} 
                        setIsControlsOpen={setIsControlsOpen}
                        isChatOpen={isChatOpen}
                        setIsChatOpen={setIsChatOpen}
                    />

                </div>
                <ToastContainer position="bottom-right" autoClose={3000} hideProgressBar newestOnTop={false} closeOnClick rtl={false} pauseOnFocusLoss draggable pauseOnHover theme={webRTCLogic.appTheme} />
            </WebRTCContext.Provider>
        );
    }
}