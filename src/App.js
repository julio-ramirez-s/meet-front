import React, { useState, useEffect, useRef, createContext, useContext, useCallback, useMemo } from 'react';
import { Mic, MicOff, Video, VideoOff, ScreenShare, MessageSquare, Send, X, LogIn, Sun, Moon, Settings, Users } from 'lucide-react'; 
import { io } from 'socket.io-client';
import Peer from 'peerjs';
// Usamos solo un console.log para errores en lugar de la librería toast, para ahorrar peso
// import { ToastContainer, toast } from 'react-toastify'; 
import styles from './App.module.css';

// --- CONTEXTO Y HOOKS ---
const WebRTCContext = createContext();
const useWebRTC = () => useContext(WebRTCContext);

// Función de utilidad para mostrar notificaciones simples sin librería externa
const showSimpleNotification = (message) => {
    // Implementación mínima para dispositivos de bajo consumo
    console.log(`[NOTIFICACIÓN] ${message}`);
    const notificationBox = document.getElementById('notification-box');
    if (notificationBox) {
        notificationBox.textContent = message;
        notificationBox.style.opacity = '1';
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
    }, []);

    const connect = useCallback((stream, userName) => {
        currentUserNameRef.current = userName;

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
            showSimpleNotification(`Error de conexión P2P: ${err.type}`);
        });

        // --- MANEJO DE SOCKET.IO ---
        socketRef.current.on('user-connected', (userId, userName) => {
            showSimpleNotification(`${userName} se ha unido.`);
        });

        socketRef.current.on('room-state', (users) => {
            setRoomUsers(users);
            
            if (stream) {
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
                        sender.replaceTrack(screenVideoTrack);
                    }
                });

                screenVideoTrack.onended = () => toggleScreenShare();
                
                showSimpleNotification("Compartiendo mi pantalla.");
                socketRef.current.emit('update-status', { isSharingScreen: true });

            } catch (error) {
                console.error("Error al compartir pantalla:", error);
                showSimpleNotification("No se pudo iniciar la compartición de pantalla.");
            }
        }
    }, [myStream, myScreenStream, toggleScreenShare]);

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

    // Crear un objeto de contexto estable
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

// React.memo para evitar re-renderizados innecesarios en la galería
const VideoComponent = React.memo(({ stream, muted, name, isLocal, isMuted, isVideoOff, isScreen }) => {
    const videoRef = useRef(null);
    useEffect(() => {
        if (videoRef.current && stream) {
            videoRef.current.srcObject = stream;
        }
    }, [stream]);

    const statusIcon = isScreen ? <ScreenShare size={16} /> : (isMuted ? <MicOff size={16} /> : <Mic size={16} />);
    
    // Si es mi pantalla compartida o una pantalla remota, siempre mostramos video.
    const showVideo = !isVideoOff || isScreen;

    return (
        <div className={`${styles.videoContainer} ${isLocal ? styles.localVideo : ''} ${isScreen ? styles.screenShareVideo : ''}`}>
            {/* Elemento de video: oculto si es mi video off y no es pantalla */}
            <video 
                ref={videoRef} 
                className={styles.videoElement} 
                autoPlay 
                muted={muted} 
                playsInline 
                style={{ display: showVideo ? 'block' : 'none' }}
            />

            {/* Overlay si el video está apagado y no es pantalla compartida */}
            {!showVideo && (
                <div className={styles.videoOffOverlay}>
                    <VideoOff size={32} />
                    <span className="mt-2 text-sm">{name}</span>
                </div>
            )}

            {/* Etiqueta de Nombre y Estado (siempre visible) */}
            <div className={styles.nameTag}>
                {statusIcon}
                <span className={styles.nameLabel}>{name} {isLocal ? '(Yo)' : ''}</span>
            </div>
            {isScreen && <div className={styles.screenShareLabel}>Pantalla Compartida</div>}
        </div>
    );
});


const VideoGallery = () => {
    const { 
        myStream, myScreenStream, peers, roomUsers, currentUserId, 
        isMuted, isVideoOff, currentUserName 
    } = useWebRTC();
    
    // Objeto useMemo para crear la lista de streams una sola vez por cambio de estado
    const uniqueStreams = useMemo(() => {
        const streams = [];
        const localStatus = roomUsers[currentUserId] || { isMuted, isVideoOff, isSharingScreen: !!myScreenStream };

        // 1. Stream propio (cámara/micrófono)
        if (myStream) {
            streams.push({
                id: currentUserId,
                name: currentUserName,
                stream: myStream,
                isLocal: true,
                isMuted: localStatus.isMuted,
                isVideoOff: localStatus.isVideoOff,
                isScreen: false,
            });
        }

        // 2. Stream de mi pantalla compartida
        if (myScreenStream) {
            streams.unshift({ // Prioridad alta
                id: `${currentUserId}-screen`,
                name: `${currentUserName} (Pantalla)`,
                stream: myScreenStream,
                isLocal: true,
                isMuted: false,
                isVideoOff: false,
                isScreen: true,
            });
        }

        // 3. Streams de otros usuarios
        Object.entries(peers).forEach(([id, peerData]) => {
            const userData = roomUsers[id] || {};
            const isPeerScreen = userData.isSharingScreen || false;

            if (peerData.stream) {
                streams.push({
                    id: id,
                    name: userData.name || 'Usuario Remoto',
                    stream: peerData.stream,
                    isLocal: false,
                    isMuted: userData.isMuted || false,
                    isVideoOff: userData.isVideoOff || false,
                    isScreen: isPeerScreen,
                });
            }
        });
        
        // Ordenar: primero la pantalla compartida (sea local o remota)
        streams.sort((a, b) => {
            if (a.isScreen && !b.isScreen) return -1;
            if (!a.isScreen && b.isScreen) return 1;
            if (a.isLocal && !b.isLocal) return -1;
            return 0;
        });

        return streams;
    }, [myStream, myScreenStream, peers, roomUsers, currentUserId, isMuted, isVideoOff, currentUserName]);


    return (
        // Usamos Grid nativo en CSS para el layout responsive y ligero
        <div className={styles.videoGallery}>
            {uniqueStreams.map(data => (
                <VideoComponent 
                    key={data.id}
                    stream={data.stream}
                    muted={data.isLocal} 
                    name={data.name}
                    isLocal={data.isLocal}
                    isMuted={data.isMuted}
                    isVideoOff={data.isVideoOff}
                    isScreen={data.isScreen}
                />
            ))}
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

    return (
        <div className={styles.controlsBar}>
            
            {/* Botón Flotante principal */}
            <button 
                onClick={() => setIsControlsOpen(prev => !prev)} 
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
                        
                        {/* Botón Compartir Pantalla */}
                        <button 
                            onClick={toggleScreenShare} 
                            className={`${styles.controlButton} ${isSharingScreen ? styles.primaryControl : styles.secondaryControl}`}
                            aria-label={isSharingScreen ? "Detener compartir pantalla" : "Compartir pantalla"}
                        >
                            <ScreenShare size={24} />
                            <span className={styles.controlLabel}>{isSharingScreen ? 'Detener' : 'Pantalla'}</span>
                        </button>

                        {/* Botón Abrir Chat */}
                        <button 
                            onClick={() => setIsChatOpen(prev => !prev)} 
                            className={`${styles.controlButton} ${isChatOpen ? styles.primaryControl : styles.secondaryControl}`}
                            aria-label={isChatOpen ? "Cerrar chat" : "Abrir chat"}
                        >
                            <MessageSquare size={24} />
                            <span className={styles.controlLabel}>Chat ({Object.keys(roomUsers).length})</span>
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

    const activeUsersCount = Object.keys(roomUsers).length;

    return (
        <div className={`${styles.chatPanel} ${isChatOpen ? styles.chatPanelOpen : ''}`}>
            {/* Cabecera, siempre renderizada para el botón de cerrar */}
            <div className={styles.chatHeader}>
                <h3 className={styles.chatTitle}>
                    <MessageSquare size={16} /> Chat ({activeUsersCount})
                </h3>
                <button 
                    onClick={() => setIsChatOpen(false)} 
                    className={styles.chatCloseButton}
                    aria-label="Cerrar chat"
                >
                    <X size={16} />
                </button>
            </div>
            
            {/* Cuerpo del chat y formulario (Solo se renderizan si está abierto) */}
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

    // Obtener dispositivos de forma ultra-sencilla
    useEffect(() => {
        const getDevices = async () => {
            try {
                // Pre-solicitar permisos
                await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
                const deviceList = await navigator.mediaDevices.enumerateDevices();

                setDevices({ 
                    audioIn: deviceList.filter(d => d.kind === 'audioinput'), 
                    videoIn: deviceList.filter(d => d.kind === 'videoinput'), 
                    audioOut: deviceList.filter(d => d.kind === 'audiooutput') 
                });
                // Establecer valores predeterminados (el primero de cada tipo)
                if (devices.audioIn.length > 0) setAudioDeviceId(devices.audioIn[0].deviceId);
                if (devices.videoIn.length > 0) setVideoDeviceId(devices.videoIn[0].deviceId);
                if (devices.audioOut.length > 0) setAudioOutputDeviceId(devices.audioOut[0].deviceId);
                
            } catch (error) {
                console.error("Error al obtener dispositivos o permisos:", error);
            } finally {
                setIsLoading(false);
            }
        };

        // Si ya tenemos permisos y el navegador lo soporta, enumeramos
        if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
             getDevices();
        } else {
             // Fallback rápido si el navegador es una "patata" de verdad
             setIsLoading(false);
        }
    }, [devices.audioIn.length, devices.videoIn.length, devices.audioOut.length]); // Dependencias para evitar bucle

    const handleSubmit = (e) => {
        e.preventDefault();
        if (name.trim()) {
            onJoin(name.trim(), audioDeviceId, videoDeviceId, audioOutputDeviceId);
        } else {
            showSimpleNotification("Por favor, ingresa tu nombre.");
        }
    };

    if (isLoading) {
        return <div className={styles.loadingMessage}>Cargando...</div>;
    }

    // Se eliminan los select boxes si no se encontraron dispositivos, para evitar errores.
    const hasVideo = devices.videoIn.length > 0;
    const hasAudioIn = devices.audioIn.length > 0;
    const hasAudioOut = devices.audioOut.length > 0;


    return (
        <div className={styles.lobbyContainer}>
            <div className={styles.lobbyCard}>
                <h1 className={styles.lobbyTitle}>Ultra-Meet: Ligera</h1>
                <form onSubmit={handleSubmit} className={styles.lobbyForm}>
                    <div className={styles.formGroup}>
                        <label className={styles.formLabel} htmlFor="name">Tu Nombre</label>
                        <input 
                            id="name"
                            type="text" 
                            value={name} 
                            onChange={(e) => setName(e.target.value)} 
                            className={styles.formInput} 
                            placeholder="Nombre Simple"
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
                            <label className={styles.formLabel} htmlFor="audio-out">Salida</label>
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
    
    // Usamos useMemo para garantizar que webRTCLogic solo cambie si el roomId cambia
    const webRTCLogic = useWebRTCLogic('main-room'); 

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

    // Aplicar el tema al body (efecto más ligero que usar la librería Tailwind)
    useEffect(() => {
        document.body.className = webRTCLogic.appTheme === 'light' ? styles.lightMode : '';
    }, [webRTCLogic.appTheme]);

    // Limpieza
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
                                <Users size={16} className="mr-2" /> Ultra-Meet (Sala Simple)
                            </h1>
                        </header>
                        
                        <main className={styles.mainContent}>
                            <VideoGallery />
                            {/* Renderizar el ChatPanel siempre, pero que solo renderice el contenido si está abierto */}
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