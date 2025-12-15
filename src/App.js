import React, { useState, useEffect, useRef, createContext, useContext, useCallback, useMemo } from 'react';
import { Mic, MicOff, Video, VideoOff, ScreenShare, MessageSquare, Send, X, LogIn, Sun, Moon, Settings, Users, ArrowLeft } from 'lucide-react'; 
import { io } from 'socket.io-client';
import Peer from 'peerjs';
import styles from './App.module.css';

// --- CONTEXTO Y HOOKS ---
const WebRTCContext = createContext();
const useWebRTC = () => useContext(WebRTCContext);

// Función de utilidad para mostrar notificaciones simples sin librería externa
const showSimpleNotification = (message) => {
    console.log(`[NOTIFICACIÓN] ${message}`);
    const notificationBox = document.getElementById('notification-box');
    if (notificationBox) {
        notificationBox.textContent = message;
        notificationBox.style.opacity = '1';
        // Usar setTimeout para manejar el desvanecimiento después de un tiempo
        setTimeout(() => {
            notificationBox.style.opacity = '0';
        }, 3000);
    }
};

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

    const toggleTheme = useCallback(() => {
        const newTheme = appTheme === 'dark' ? 'light' : 'dark';
        setAppTheme(newTheme);
    }, [appTheme]);

    const initializeStream = useCallback(async (audioDeviceId, videoDeviceId) => {
        try {
            const constraints = {
                video: { deviceId: videoDeviceId ? { exact: videoDeviceId } : true },
                audio: { deviceId: audioDeviceId ? { exact: audioDeviceId } : true }
            };
            const stream = await navigator.mediaDevices.getUserMedia(constraints);
            
            const audioTrack = stream.getAudioTracks()[0];
            const videoTrack = stream.getVideoTracks()[0];

            // Establecer el estado inicial basado en si los tracks están disponibles
            setIsMuted(audioTrack ? !audioTrack.enabled : false);
            setIsVideoOff(videoTrack ? !videoTrack.enabled : false);

            setMyStream(stream);
            return stream;
        } catch (error) {
            console.error("Error al obtener el stream:", error);
            showSimpleNotification("No se pudo acceder a la cámara o micrófono. Revise permisos.");
            return null;
        }
    }, []);

    const connectToNewUser = useCallback((userId, userName, stream) => {
        if (!myPeerRef.current || !stream || peerConnections.current[userId]) return;
        
        const call = myPeerRef.current.call(userId, stream);
        
        call.on('stream', (userVideoStream) => {
            setPeers(prevPeers => ({
                ...prevPeers,
                [userId]: { stream: userVideoStream, call: call }
            }));
        });

        call.on('close', () => {
            setPeers(prevPeers => {
                const newPeers = { ...prevPeers };
                delete newPeers[userId];
                return newPeers;
            });
        });

        peerConnections.current[userId] = call;
    }, []);

    const connect = useCallback((stream, userName) => {
        currentUserNameRef.current = userName;

        // Servidor PeerJS y Socket.IO (Usando la URL de Render recomendada)
        const SERVER_URL = "https://meet-clone-v0ov.onrender.com"; 
        const API_HOST = new URL(SERVER_URL).hostname;

        socketRef.current = io(SERVER_URL);
        
        myPeerRef.current = new Peer(undefined, { 
            host: API_HOST, 
            path: '/peerjs/myapp', 
            secure: true, 
            port: 443 
        });

        // --- MANEJO DE PEERJS ---
        myPeerRef.current.on('open', (id) => {
            currentPeerIdRef.current = id;
            socketRef.current.emit('join-room', roomId, id, userName, { 
                isMuted: isMuted,
                isVideoOff: isVideoOff,
                isSharingScreen: false
            });
        });

        myPeerRef.current.on('call', (call) => {
            call.answer(stream);

            call.on('stream', (userVideoStream) => {
                setPeers(prevPeers => ({
                    ...prevPeers,
                    [call.peer]: { stream: userVideoStream, call: call }
                }));
            });
            peerConnections.current[call.peer] = call;
        });

        myPeerRef.current.on('error', (err) => {
            console.error('Error en PeerJS:', err);
            showSimpleNotification(`Error P2P: ${err.type}`);
        });

        // --- MANEJO DE SOCKET.IO ---
        socketRef.current.on('user-connected', (userId, userName) => {
            showSimpleNotification(`${userName} se ha unido.`);
        });

        socketRef.current.on('room-state', (users) => {
            setRoomUsers(users);
            
            if (stream) {
                // Conectar a todos los usuarios existentes en la sala
                Object.entries(users).forEach(([id, user]) => {
                    if (id !== currentPeerIdRef.current) {
                        connectToNewUser(id, user.name, stream);
                    }
                });
            }
        });
        
        socketRef.current.on('user-status-update', (userId, status) => {
            setRoomUsers(prevUsers => {
                const updatedUsers = { ...prevUsers };
                if (updatedUsers[userId]) {
                    updatedUsers[userId] = { ...updatedUsers[userId], ...status };
                }
                return updatedUsers;
            });
        });

        socketRef.current.on('user-disconnected', (userId, userName) => {
            showSimpleNotification(`${userName} ha abandonado.`);
            if (peerConnections.current[userId]) {
                peerConnections.current[userId].close();
                delete peerConnections.current[userId];
            }
            setPeers(prevPeers => {
                const newPeers = { ...prevPeers };
                delete newPeers[userId];
                return newPeers;
            });
            setRoomUsers(prevUsers => {
                const newUsers = { ...prevUsers };
                delete newUsers[userId];
                return newUsers;
            });
        });

        socketRef.current.on('chat-message', (message) => {
            setChatMessages(prevMessages => [...prevMessages, message]);
        });
    }, [roomId, isMuted, isVideoOff, connectToNewUser]); 


    const toggleMute = useCallback(() => {
        if (!myStream) return;
        const audioTrack = myStream.getAudioTracks()[0];
        if (audioTrack) {
            audioTrack.enabled = isMuted; // Toggle: si estaba muted (true), ahora lo habilitamos (false)
            setIsMuted(prev => {
                socketRef.current.emit('update-status', { isMuted: !prev });
                showSimpleNotification(`Micrófono: ${!prev ? 'ON' : 'OFF'}`);
                return !prev;
            });
        }
    }, [myStream, isMuted]);

    const toggleVideo = useCallback(() => {
        if (!myStream) return;
        const videoTrack = myStream.getVideoTracks()[0];
        if (videoTrack) {
            videoTrack.enabled = isVideoOff; // Toggle
            setIsVideoOff(prev => {
                socketRef.current.emit('update-status', { isVideoOff: !prev });
                showSimpleNotification(`Cámara: ${!prev ? 'ON' : 'OFF'}`);
                return !prev;
            });
        }
    }, [myStream, isVideoOff]);

    const toggleScreenShare = useCallback(async () => {
        if (!socketRef.current || !myStream) return;
        
        if (myScreenStream) {
            // Detener
            myScreenStream.getTracks().forEach(track => track.stop());
            setMyScreenStream(null);

            const videoTrack = myStream.getVideoTracks()[0];
            Object.values(peerConnections.current).forEach(call => {
                const sender = call.peerConnection.getSenders().find(s => s.track && s.track.kind === 'video');
                if (sender) {
                    // Reemplazar la pista de pantalla por la de la cámara
                    sender.replaceTrack(videoTrack);
                }
            });
            showSimpleNotification("Compartición de pantalla detenida.");
            socketRef.current.emit('update-status', { isSharingScreen: false });

        } else {
            // Iniciar
            try {
                const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
                setMyScreenStream(screenStream);

                const screenVideoTrack = screenStream.getVideoTracks()[0];
                Object.values(peerConnections.current).forEach(call => {
                    const sender = call.peerConnection.getSenders().find(s => s.track && s.track.kind === 'video');
                    if (sender) {
                        // Reemplazar la pista de la cámara por la de la pantalla
                        sender.replaceTrack(screenVideoTrack);
                    }
                });

                // Detener automáticamente al cerrar la ventana de compartición
                screenVideoTrack.onended = () => toggleScreenShare();
                
                showSimpleNotification("Compartiendo mi pantalla.");
                socketRef.current.emit('update-status', { isSharingScreen: true });

            } catch (error) {
                console.error("Error al compartir pantalla:", error);
                showSimpleNotification("No se pudo iniciar la compartición de pantalla.");
            }
        }
    }, [myStream, myScreenStream]); 

    const sendChatMessage = useCallback((message) => {
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
    }, []);

    const cleanup = useCallback(() => {
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
        Object.values(peerConnections.current).forEach(call => call.close());
        peerConnections.current = {};
        
        setMyStream(null);
        setMyScreenStream(null);
        setPeers({});
        setRoomUsers({});
        setChatMessages([]);
    }, [myStream, myScreenStream]);

    const contextValue = useMemo(() => ({
        myStream, myScreenStream, peers, chatMessages, isMuted, isVideoOff, appTheme,
        roomUsers, initializeStream, connect, toggleMute, toggleVideo, toggleScreenShare,
        sendChatMessage, cleanup, toggleTheme, currentUserId: currentPeerIdRef.current,
        currentUserName: currentUserNameRef.current,
    }), [
        myStream, myScreenStream, peers, chatMessages, isMuted, isVideoOff, appTheme,
        roomUsers, initializeStream, connect, toggleMute, toggleVideo, toggleScreenShare,
        sendChatMessage, cleanup, toggleTheme
    ]);

    return contextValue;
};

// --- COMPONENTES DE UI ---

// Declaración de la función del componente VideoComponent
function VideoComponentContent({ stream, muted, name, isLocal, isMuted, isVideoOff, isScreen, className }) {
    const videoRef = useRef(null);
    
    useEffect(() => {
        if (videoRef.current && stream) {
            videoRef.current.srcObject = stream;
        }
    }, [stream]);

    const statusIcon = isScreen ? <ScreenShare size={16} /> : (isMuted ? <MicOff size={16} /> : <Mic size={16} />);
    
    // Si es pantalla compartida, siempre mostramos video. Si es cámara, depende de isVideoOff.
    const showVideo = !isVideoOff || isScreen;

    return (
        <div className={`${styles.videoContainer} ${className || ''} ${isLocal ? styles.localVideo : ''}`}>
            
            <video 
                ref={videoRef} 
                className={styles.videoElement} 
                autoPlay 
                muted={muted} 
                playsInline 
                style={{ display: showVideo ? 'block' : 'none' }}
            />

            {/* Overlay si el video está apagado y no es pantalla compartida */}
            {!showVideo && !isScreen && (
                <div className={styles.videoOffOverlay}>
                    <VideoOff size={32} />
                    <span className="mt-2 text-sm">{name}</span>
                </div>
            )}

            {/* Etiqueta de Nombre y Estado */}
            <div className={styles.nameTag}>
                {statusIcon}
                <span className={styles.nameLabel}>{name} {isLocal ? '(Yo)' : ''}</span>
            </div>
            {isScreen && <div className={styles.screenShareLabel}>Pantalla Compartida</div>}
        </div>
    );
}
// React.memo aplicado a la función.
const VideoComponent = React.memo(VideoComponentContent);


const VideoGallery = () => {
    const { 
        myStream, myScreenStream, peers, roomUsers, currentUserId, 
        isMuted, isVideoOff, currentUserName 
    } = useWebRTC();
    
    // Lógica para generar la lista de streams, separando el principal
    const { mainStream, secondaryStreams } = useMemo(() => {
        const localStatus = roomUsers[currentUserId] || { isMuted, isVideoOff, isSharingScreen: !!myScreenStream };
        const allStreams = [];

        // 1. Stream propio (cámara/micrófono)
        if (myStream) {
            allStreams.push({
                id: currentUserId,
                name: currentUserName,
                stream: myStream,
                isLocal: true,
                isMuted: localStatus.isMuted,
                isVideoOff: localStatus.isVideoOff,
                isScreen: false,
                isCamera: true,
            });
        }

        // 2. Stream de mi pantalla compartida (si existe)
        if (myScreenStream) {
            allStreams.push({ 
                id: `${currentUserId}-screen`,
                name: `${currentUserName} (Mi Pantalla)`,
                stream: myScreenStream,
                isLocal: true,
                isMuted: false,
                isVideoOff: false,
                isScreen: true,
                isCamera: false,
            });
        }

        // 3. Streams de otros usuarios
        Object.entries(peers).forEach(([id, peerData]) => {
            const userData = roomUsers[id] || {};
            const isPeerScreen = userData.isSharingScreen || false;
            
            if (peerData.stream) {
                allStreams.push({
                    id: id,
                    name: userData.name || 'Usuario Remoto',
                    stream: peerData.stream,
                    isLocal: false,
                    isMuted: userData.isMuted || false,
                    isVideoOff: userData.isVideoOff || false,
                    isScreen: isPeerScreen,
                    isCamera: !isPeerScreen,
                });
            }
        });
        
        let main = null;
        let secondary = [];

        // Prioridad del Main Stream: 1. Cualquier pantalla compartida (la última que encuentre para ser la más reciente)
        const screenStream = allStreams.reverse().find(s => s.isScreen);
        
        if (screenStream) {
            main = screenStream;
            // Todos los demás streams (incluyendo cámaras y otras pantallas, aunque solo una será la grande)
            secondary = allStreams.filter(s => s.id !== main.id && s.isCamera);
        } else {
            // Si no hay pantalla compartida, el stream principal es mi propia cámara (si existe)
            main = allStreams.find(s => s.id === currentUserId);
            // El resto son cámaras secundarias
            secondary = allStreams.filter(s => s.id !== currentUserId && s.isCamera);
        }
        
        // Desestructuración limpia y segura
        return { mainStream: main, secondaryStreams: secondary.filter(s => s && s.isCamera) };

    }, [myStream, myScreenStream, peers, roomUsers, currentUserId, isMuted, isVideoOff, currentUserName]);


    return (
        <div className={styles.screenFocusLayout}>
            {/* 1. AREA PRINCIPAL: Pantalla Compartida o Mi Video (si no hay pantalla) */}
            <div className={styles.mainStreamArea}>
                {mainStream ? (
                    <VideoComponent 
                        key={mainStream.id}
                        stream={mainStream.stream}
                        muted={mainStream.isLocal && !mainStream.isScreen} // Mute only my camera, not my screen audio
                        name={mainStream.name}
                        isLocal={mainStream.isLocal}
                        isMuted={mainStream.isMuted}
                        isVideoOff={mainStream.isVideoOff}
                        isScreen={mainStream.isScreen}
                        className={styles.mainScreenVideoContainer} 
                    />
                ) : (
                    <div className={styles.videoOffOverlay} style={{ width: '100%', height: '100%' }}>
                        <Video size={48} />
                        <span className="mt-4 text-lg">Esperando contenido o usuarios...</span>
                    </div>
                )}
            </div>

            {/* 2. AREA SECUNDARIA: Cámaras pequeñas (Feeds) */}
            <div className={styles.cameraFeedsArea}>
                {secondaryStreams.map(data => (
                    <VideoComponent 
                        key={data.id}
                        stream={data.stream}
                        muted={data.isLocal} 
                        name={data.name}
                        isLocal={data.isLocal}
                        isMuted={data.isMuted}
                        isVideoOff={data.isVideoOff}
                        isScreen={data.isScreen}
                        className={styles.smallCameraVideoContainer} 
                    />
                ))}
            </div>
        </div>
    );
};


// Panel de Controles Flotante
const ControlPanel = ({ onLeave, isControlsOpen, setIsControlsOpen, isChatOpen, setIsChatOpen }) => {
    const { 
        isMuted, isVideoOff, toggleMute, toggleVideo, 
        toggleScreenShare, myScreenStream, toggleTheme, appTheme,
        roomUsers
    } = useWebRTC();

    const isSharingScreen = !!myScreenStream;
    const activeUsersCount = useMemo(() => Object.keys(roomUsers).length, [roomUsers]);

    return (
        <div className={styles.controlsBar}>
            
            {/* Botón Flotante principal */}
            <button 
                onClick={() => setIsControlsOpen(prev => {
                    // Si se va a abrir el panel, cerramos el chat para ahorrar espacio en móvil
                    if (!prev) setIsChatOpen(false); 
                    return !prev;
                })} 
                className={`${styles.mainFloatingButton} ${styles.controlButton} ${styles.primaryControl}`}
                aria-label="Toggle panel de control"
            >
                {isControlsOpen ? <X size={24} /> : <Settings size={24} />}
            </button>

            {/* Panel de Controles Desplegado */}
            {isControlsOpen && (
                <div className={styles.floatingPanel}>
                    <div className={styles.controlButtonsGroup}>
                        {/* Botón Mute/Unmute */}
                        <button 
                            onClick={toggleMute} 
                            className={`${styles.controlButton} ${isMuted ? styles.dangerControl : styles.successControl}`}
                            aria-label={isMuted ? "Activar micrófono" : "Silenciar micrófono"}
                        >
                            {isMuted ? <MicOff size={24} /> : <Mic size={24} />}
                            <span className={styles.controlLabel}>{isMuted ? 'Mic ON' : 'Mic OFF'}</span>
                        </button>
                        
                        {/* Botón Video On/Off */}
                        <button 
                            onClick={toggleVideo} 
                            className={`${styles.controlButton} ${isVideoOff ? styles.dangerControl : styles.successControl}`}
                            aria-label={isVideoOff ? "Activar cámara" : "Desactivar cámara"}
                        >
                            {isVideoOff ? <VideoOff size={24} /> : <Video size={24} />}
                            <span className={styles.controlLabel}>{isVideoOff ? 'Vid ON' : 'Vid OFF'}</span>
                        </button>
                        
                        {/* Botón Compartir Pantalla (Prioridad para ti y tu novia) */}
                        <button 
                            onClick={toggleScreenShare} 
                            className={`${styles.controlButton} ${isSharingScreen ? styles.primaryControl : styles.shareControl}`}
                            aria-label={isSharingScreen ? "Detener compartir pantalla" : "Compartir pantalla"}
                        >
                            <ScreenShare size={24} />
                            <span className={styles.controlLabel}>{isSharingScreen ? 'Detener' : 'Pantalla'}</span>
                        </button>

                        {/* Botón Abrir Chat */}
                        <button 
                            onClick={() => setIsChatOpen(prev => {
                                // Si se va a abrir el chat, cerramos el panel de control
                                if (!prev) setIsControlsOpen(false); 
                                return !prev;
                            })} 
                            className={`${styles.controlButton} ${isChatOpen ? styles.primaryControl : styles.secondaryControl}`}
                            aria-label={isChatOpen ? "Cerrar chat" : "Abrir chat"}
                        >
                            <MessageSquare size={24} />
                            <span className={styles.controlLabel}>Chat ({activeUsersCount})</span>
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


// Panel de Chat Lateral (Renderizado Condicional de Contenido)
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

    const activeUsersCount = useMemo(() => Object.keys(roomUsers).length, [roomUsers]);

    return (
        <div className={`${styles.chatPanel} ${isChatOpen ? styles.chatPanelOpen : ''}`}>
            
            <div className={styles.chatHeader}>
                <h3 className={styles.chatTitle}>
                    <MessageSquare size={16} /> Chat ({activeUsersCount})
                </h3>
                <button 
                    onClick={() => setIsChatOpen(false)} 
                    className={styles.chatCloseButton}
                    aria-label="Cerrar chat"
                >
                    <ArrowLeft size={16} className="md:hidden" />
                    <X size={16} className="hidden md:block" />
                </button>
            </div>
            
            {isChatOpen && (
                <>
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
                            placeholder="Escribe..."
                            className={styles.chatInput}
                            disabled={!currentUserId}
                            autoFocus
                        />
                        <button type="submit" disabled={!currentUserId || input.trim() === ''} className={styles.chatSendButton} aria-label="Enviar mensaje">
                            <Send size={16} />
                        </button>
                    </form>
                </>
            )}
        </div>
    );
};


// Componente de Lobby (Simplificado)
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
                showSimpleNotification("Advertencia: No se pudo obtener la lista de dispositivos (permisos denegados).");
            } finally {
                setIsLoading(false);
            }
        };

        if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
             getDevices();
        } else {
             setIsLoading(false);
        }
    }, []); 

    const handleSubmit = (e) => {
        e.preventDefault();
        if (name.trim()) {
            onJoin(name.trim(), audioDeviceId, videoDeviceId, audioOutputDeviceId);
        } else {
            showSimpleNotification("Por favor, ingresa tu nombre.");
        }
    };

    if (isLoading) {
        return <div className={styles.loadingMessage}>Cargando dispositivos...</div>;
    }

    const hasVideo = devices.videoIn.length > 0;
    const hasAudioIn = devices.audioIn.length > 0;
    const hasAudioOut = devices.audioOut.length > 0;


    return (
        <div className={styles.lobbyContainer}>
            <div className={styles.lobbyCard}>
                <h1 className={styles.lobbyTitle}>Ultra-Meet: Streaming Ligero</h1>
                <p className={styles.lobbySubtitle}>Optimizado para dispositivos con recursos limitados.</p>
                <form onSubmit={handleSubmit} className={styles.lobbyForm}>
                    <div className={styles.formGroup}>
                        <label className={styles.formLabel} htmlFor="name">Tu Nombre</label>
                        <input 
                            id="name"
                            type="text" 
                            value={name} 
                            onChange={(e) => setName(e.target.value)} 
                            className={styles.formInput} 
                            placeholder="Ej: David o [tu nombre]"
                            required
                        />
                    </div>

                    {hasVideo && (
                        <div className={styles.formGroup}>
                            <label className={styles.formLabel} htmlFor="video">Cámara</label>
                            <select id="video" value={videoDeviceId} onChange={(e) => setVideoDeviceId(e.target.value)} className={styles.formSelect}>
                                {devices.videoIn.map(device => <option key={device.deviceId} value={device.deviceId}>{device.label || `Video ${device.deviceId}`}</option>)}
                            </select>
                        </div>
                    )}

                    {hasAudioIn && (
                        <div className={styles.formGroup}>
                            <label className={styles.formLabel} htmlFor="audio-in">Micrófono</label>
                            <select id="audio-in" value={audioDeviceId} onChange={(e) => setAudioDeviceId(e.target.value)} className={styles.formSelect}>
                                {devices.audioIn.map(device => <option key={device.deviceId} value={device.deviceId}>{device.label || `Mic ${device.deviceId}`}</option>)}
                            </select>
                        </div>
                    )}

                    {hasAudioOut && (
                        <div className={styles.formGroup}>
                            <label className={styles.formLabel} htmlFor="audio-out">Salida de Audio</label>
                            <select id="audio-out" value={audioOutputDeviceId} onChange={(e) => setAudioOutputDeviceId(e.target.value)} className={styles.formSelect}>
                                {devices.audioOut.map(device => <option key={device.deviceId} value={device.deviceId}>{device.label || `Altavoz ${device.deviceId}`}</option>)}
                            </select>
                        </div>
                    )}
                    
                    <button type="submit" className={styles.joinButton}>
                        <LogIn size={20} className="mr-2" />
                        Unirme (Simple)
                    </button>
                </form>
            </div>
        </div>
    );
};


// --- COMPONENTE PRINCIPAL DE LA APLICACIÓN ---
export default function App() {
    const [isJoined, setIsJoined] = useState(false);
    const [userName, setUserName] = useState('');
    const [selectedAudioOutput, setSelectedAudioOutput] = useState('');
    const [isControlsOpen, setIsControlsOpen] = useState(false); 
    const [isChatOpen, setIsChatOpen] = useState(false); 
    
    const webRTCLogic = useWebRTCLogic('screen-focus-room'); 

    const handleJoin = async (name, audioId, videoId, audioOutputId) => {
        setUserName(name);
        setSelectedAudioOutput(audioOutputId);
        const stream = await webRTCLogic.initializeStream(audioId, videoId);
        if (stream) {
            webRTCLogic.connect(stream, name);
            setIsJoined(true);
            showSimpleNotification(`¡Bienvenido a la sala, ${name}!`);
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

    // Aplicar el tema al body
    useEffect(() => {
        document.body.className = webRTCLogic.appTheme === 'light' ? styles.lightMode : '';
    }, [webRTCLogic.appTheme]);

    // Limpieza al desmontar
    useEffect(() => {
        const cleanupHandler = () => webRTCLogic.cleanup();
        window.addEventListener('beforeunload', cleanupHandler);
        return () => {
            window.removeEventListener('beforeunload', cleanupHandler);
        };
    }, [webRTCLogic]);


    // Renderizado condicional
    return (
        <div className={styles.globalWrapper}>
            {/* Contenedor de Notificaciones Simples (sustituye a ToastContainer) */}
            <div id="notification-box" className={styles.notificationBox}></div>
            
            {isJoined ? (
                <WebRTCContext.Provider value={{ ...webRTCLogic, selectedAudioOutput, userName }}>
                    <div className={styles.appContainer}>
                        <header className={styles.appHeader}>
                            <h1 className={styles.roomTitle}>
                                <Users size={16} className="mr-2" /> Ultra-Meet (Foco en Streaming)
                            </h1>
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
                </WebRTCContext.Provider>
            ) : (
                <Lobby onJoin={handleJoin} /> 
            )}
        </div>
    );
}