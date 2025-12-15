import React, { useState, useEffect, useRef, createContext, useContext } from 'react';
import { Mic, MicOff, Video, VideoOff, ScreenShare, MessageSquare, Send, X, LogIn, Plus, Sun, Moon } from 'lucide-react';
import { io } from 'socket.io-client';
import Peer from 'peerjs';
import { ToastContainer, toast } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';
import styles from './App.module.css';

// =========================================================================================
// !!! CORRECCIÓN CRÍTICA: Usando la dirección REAL proporcionada por el usuario !!!
const SIGNALING_SERVER_URL = 'https://meet-clone-v0ov.onrender.com';
// =========================================================================================

// --- CONTEXTO PARA WEBRTC ---
const WebRTCContext = createContext();
const useWebRTC = () => useContext(WebRTCContext);

// --- HOOK PERSONALIZADO PARA LA LÓGICA DE WEBRTC ---
const useWebRTCLogic = (roomId) => {
    const [myStream, setMyStream] = useState(null);
    const [myScreenStream, setMyScreenStream] = useState(null);
    // peers: { peerId: { stream, userName, peerConnection } }
    const [peers, setPeers] = useState({});
    const [chatMessages, setChatMessages] = useState([]); // Restaurado
    const [isMuted, setIsMuted] = useState(false);
    const [isVideoOff, setIsVideoOff] = useState(false);
    const [appTheme, setAppTheme] = useState('dark'); // Restaurado
    const [roomUsers, setRoomUsers] = useState({});

    const socketRef = useRef(null);
    const myPeerRef = useRef(null);
    const peerConnections = useRef({});
    const currentStreamRef = useRef(null);

    // Helper para manejar notificaciones (usando Toastify)
    const showLocalNotification = (message, type = 'info') => {
        switch (type) {
            case 'success':
                toast.success(message, { theme: appTheme });
                break;
            case 'error':
                toast.error(message, { theme: appTheme });
                break;
            case 'warning':
                toast.warn(message, { theme: appTheme });
                break;
            default:
                toast.info(message, { theme: appTheme });
        }
    };


    // --- 1. Inicialización de MediaStream ---
    const initializeStream = async (audioId, videoId) => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: videoId ? { deviceId: videoId } : true,
                audio: audioId ? { deviceId: audioId } : true,
            });
            setMyStream(stream);
            currentStreamRef.current = stream;
            return stream;
        } catch (err) {
            showLocalNotification("Error al acceder a cámara/micrófono: " + err.message, 'error');
            return null;
        }
    };

    // --- 2. Conexión a Socket.IO y PeerJS ---
    const connect = (stream, userName) => {
        if (socketRef.current || myPeerRef.current) return;

        // Modificación clave: Usar la URL explícita del servidor de señalización.
        socketRef.current = io(SIGNALING_SERVER_URL, {
            transports: ['websocket', 'polling']
        });

        socketRef.current.on('connect', () => {
            showLocalNotification("Conexión al servidor de señalización exitosa.", 'success');
            
            // Inicialización de PeerJS
            const serverUrl = new URL(SIGNALING_SERVER_URL);
            const host = serverUrl.hostname;
            // PeerJS en Render a veces requiere el puerto 443 si es HTTPS, pero omitirlo y confiar en la ruta a menudo funciona
            const port = serverUrl.port || (serverUrl.protocol === 'https:' ? 443 : 80);

            myPeerRef.current = new Peer(undefined, {
                host: host,
                port: port,
                path: '/peerjs', // Asegúrate de que tu servidor PeerJS esté configurado con esta ruta
                config: {
                    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
                },
            });

            myPeerRef.current.on('open', (id) => {
                showLocalNotification(`Conectado a PeerJS. Mi ID: ${id}`);
                // Unirse a la sala con información de usuario
                socketRef.current.emit('join-room', roomId, id, userName);
                // Inicializar el tema de la aplicación al unirse (si hay otros temas)
                document.body.className = appTheme === 'light' ? styles.lightMode : '';
            });

            // Escuchar llamadas entrantes
            myPeerRef.current.on('call', (call) => {
                call.answer(currentStreamRef.current);

                call.on('stream', (remoteStream) => {
                    setPeers(prev => ({
                        ...prev,
                        [call.peer]: {
                            ...prev[call.peer],
                            stream: remoteStream,
                            peerConnection: call.peerConnection
                        }
                    }));
                });
                call.on('close', () => {
                    handlePeerDisconnect(call.peer, 'Call closed');
                });
                peerConnections.current[call.peer] = call;
            });

            myPeerRef.current.on('error', (err) => {
                console.error("PeerJS Error:", err);
                showLocalNotification(`Error de PeerJS: ${err.type}`, 'error');
            });
        });

        // Manejo de errores de conexión de Socket.IO
        socketRef.current.on('connect_error', (err) => {
            console.error("Socket.IO Connection Error:", err.message);
            showLocalNotification(`Error de conexión al servidor de señalización: ${err.message}. Revise la URL: ${SIGNALING_SERVER_URL}`, 'error');
        });

        // --- Manejo de mensajes de Socket.IO ---

        // Nuevo usuario conectado
        socketRef.current.on('user-connected', (userId, userName) => {
            showLocalNotification(`${userName} se ha unido a la sala.`, 'info');
            setRoomUsers(prev => ({ ...prev, [userId]: userName }));

            const call = myPeerRef.current.call(userId, currentStreamRef.current);

            call.on('stream', (remoteStream) => {
                setPeers(prev => ({
                    ...prev,
                    [userId]: {
                        stream: remoteStream,
                        userName: userName,
                        peerConnection: call.peerConnection
                    }
                }));
            });
            call.on('close', () => {
                handlePeerDisconnect(userId, 'Call closed by remote peer');
            });

            call.on('error', (err) => {
                console.error("Call Error:", err);
                handlePeerDisconnect(userId, 'Call error');
            });

            peerConnections.current[userId] = call;
        });

        // Usuario desconectado
        socketRef.current.on('user-disconnected', (userId, userName) => {
            handlePeerDisconnect(userId, `${userName} ha abandonado la sala.`, 'warning');
        });

        // Actualización de estado (solo nombre)
        socketRef.current.on('update-user-list', (users) => {
            setRoomUsers(users);
        });

        // --- CHAT Listeners (Restaurado) ---
        socketRef.current.on('chat-message', ({ message, senderId, senderName, timestamp }) => {
            setChatMessages(prev => [...prev, { message, senderId, senderName, timestamp, isRemote: true }]);
        });

        // --- THEME Listener (Restaurado) ---
        socketRef.current.on('theme-change', (newTheme) => {
            setAppTheme(newTheme);
            document.body.className = newTheme === 'light' ? styles.lightMode : '';
        });
    };

    // --- 3. Funciones de Control de Media ---

    // Función crucial para el rendimiento: reemplaza eficientemente todos los tracks en todas las conexiones
    const replaceAllTracks = (newStream) => {
        if (currentStreamRef.current && currentStreamRef.current !== newStream) {
            currentStreamRef.current.getTracks().forEach(track => track.stop());
        }

        setMyStream(newStream);
        currentStreamRef.current = newStream;

        Object.values(peerConnections.current).forEach(call => {
            const videoSender = call.peerConnection.getSenders().find(s => s.track.kind === 'video');
            if (videoSender && newStream.getVideoTracks().length > 0) {
                videoSender.replaceTrack(newStream.getVideoTracks()[0]).catch(err => console.error("Error replacing video track:", err));
            }
            const audioSender = call.peerConnection.getSenders().find(s => s.track.kind === 'audio');
            if (audioSender && newStream.getAudioTracks().length > 0) {
                audioSender.replaceTrack(newStream.getAudioTracks()[0]).catch(err => console.error("Error replacing audio track:", err));
            }
        });
    };


    const toggleMute = () => {
        if (myStream) {
            const audioTrack = myStream.getAudioTracks()[0];
            if (audioTrack) {
                audioTrack.enabled = isMuted;
                setIsMuted(!isMuted);
            }
        }
    };

    const toggleVideo = () => {
        if (myStream) {
            const videoTrack = myStream.getVideoTracks()[0];
            if (videoTrack) {
                videoTrack.enabled = isVideoOff;
                setIsVideoOff(!isVideoOff);
            }
        }
    };

    const startScreenShare = async () => {
        if (myScreenStream) {
            // Detener compartición
            myScreenStream.getTracks().forEach(track => track.stop());
            setMyScreenStream(null);
            if (myStream) {
                replaceAllTracks(myStream);
            }
        } else {
            try {
                // Capturar pantalla y audio del sistema (si es posible)
                const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
                setMyScreenStream(screenStream);
                replaceAllTracks(screenStream);

                screenStream.getVideoTracks()[0].onended = () => {
                    startScreenShare();
                };
            } catch (err) {
                console.error("Error al compartir pantalla:", err);
                showLocalNotification("No se pudo iniciar la compartición de pantalla.", 'error');
            }
        }
    };

    // --- 4. Funciones de Chat y Tema (Restaurado) ---

    const sendChatMessage = (message, senderName) => {
        if (socketRef.current && message.trim()) {
            const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const senderId = myPeerRef.current?.id || 'local';

            // Emitir mensaje al servidor
            socketRef.current.emit('send-chat-message', {
                roomId,
                message,
                senderId,
                senderName,
                timestamp
            });

            // Agregar a la lista local inmediatamente
            setChatMessages(prev => [...prev, { message, senderId, senderName, timestamp, isLocal: true }]);
        }
    };

    const cycleTheme = () => {
        const newTheme = appTheme === 'dark' ? 'light' : 'dark';
        setAppTheme(newTheme);
        document.body.className = newTheme === 'light' ? styles.lightMode : '';

        // Emitir cambio de tema a otros usuarios
        if (socketRef.current) {
            socketRef.current.emit('change-theme', roomId, newTheme);
        }
    };

    // --- 5. Cleanup y Desconexión ---

    const handlePeerDisconnect = (userId, message, type = 'info') => {
        showLocalNotification(message, type);

        if (peerConnections.current[userId]) {
            peerConnections.current[userId].close();
            delete peerConnections.current[userId];
        }

        setPeers(prev => {
            const newPeers = { ...prev };
            delete newPeers[userId];
            return newPeers;
        });
        setRoomUsers(prev => {
            const newUsers = { ...prev };
            delete newUsers[userId];
            return newUsers;
        });
    };

    const cleanup = () => {
        if (socketRef.current) {
            socketRef.current.emit('disconnect-room', roomId, myPeerRef.current?.id);
            socketRef.current.disconnect();
            socketRef.current = null;
        }

        if (myPeerRef.current) {
            myPeerRef.current.destroy();
            myPeerRef.current = null;
        }

        Object.values(peerConnections.current).forEach(call => {
            try {
                call.close();
            } catch (e) {
                console.warn("Error closing peer call:", e);
            }
        });
        peerConnections.current = {};

        if (myStream) {
            myStream.getTracks().forEach(track => track.stop());
            setMyStream(null);
        }
        if (myScreenStream) {
            myScreenStream.getTracks().forEach(track => track.stop());
            setMyScreenStream(null);
        }

        setPeers({});
        setRoomUsers({});
        setIsMuted(false);
        setIsVideoOff(false);
        setChatMessages([]);
        currentStreamRef.current = null;
    };

    // Exportar solo lo necesario y optimizado
    return {
        myStream,
        myScreenStream,
        peers,
        chatMessages,
        isMuted,
        isVideoOff,
        appTheme,
        roomUsers,
        initializeStream,
        connect,
        cleanup,
        toggleMute,
        toggleVideo,
        startScreenShare,
        sendChatMessage,
        cycleTheme,
    };
};

// --- COMPONENTE: ChatBox (Restaurado) ---
const ChatBox = ({ userName }) => {
    const { chatMessages, sendChatMessage, appTheme } = useWebRTC();
    const [messageInput, setMessageInput] = useState('');
    const chatEndRef = useRef(null);

    // Scroll automático al final
    useEffect(() => {
        chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [chatMessages]);

    const handleSubmit = (e) => {
        e.preventDefault();
        if (messageInput.trim()) {
            sendChatMessage(messageInput, userName);
            setMessageInput('');
        }
    };

    return (
        <div className={styles.chatBox} data-theme={appTheme}>
            <div className={styles.chatHeader}>
                <MessageSquare size={20} className="mr-2" /> Chat de la Sala
            </div>
            <div className={styles.chatMessages}>
                {chatMessages.length === 0 ? (
                    <p className={styles.noMessages}>Aún no hay mensajes. ¡Di algo!</p>
                ) : (
                    chatMessages.map((msg, index) => (
                        <div
                            key={index}
                            className={`${styles.chatMessage} ${msg.isLocal ? styles.localMessage : styles.remoteMessage}`}
                        >
                            <span className={styles.chatSender}>{msg.isLocal ? 'Tú' : msg.senderName}:</span>
                            <p className={styles.chatText}>{msg.message}</p>
                            <span className={styles.chatTimestamp}>{msg.timestamp}</span>
                        </div>
                    ))
                )}
                <div ref={chatEndRef} />
            </div>
            <form onSubmit={handleSubmit} className={styles.chatInputForm}>
                <input
                    type="text"
                    value={messageInput}
                    onChange={(e) => setMessageInput(e.target.value)}
                    placeholder="Escribe un mensaje..."
                    className={styles.chatInput}
                    aria-label="Escribir mensaje de chat"
                />
                <button type="submit" disabled={!messageInput.trim()} className={styles.chatSendButton}>
                    <Send size={20} />
                </button>
            </form>
        </div>
    );
};

// --- COMPONENTE: VideoGrid (Muestra los videos) ---
const VideoGrid = () => {
    const { myStream, peers, myScreenStream } = useWebRTC();

    const mainStream = myScreenStream || myStream;

    const videoList = [
        mainStream ? { id: 'local-video', stream: mainStream, userName: 'Tú', isLocal: true, isScreenSharing: !!myScreenStream } : null,
        ...Object.entries(peers).map(([id, peer]) => ({
            id,
            stream: peer.stream,
            userName: peer.userName || 'Usuario Remoto',
            isLocal: false,
            isScreenSharing: false,
        }))
    ].filter(Boolean);

    let gridClass = styles.videoGrid;
    const count = videoList.length;

    if (count === 1) {
        gridClass += ` ${styles.grid1}`;
    } else if (count === 2) {
        gridClass += ` ${styles.grid2}`;
    } else if (count <= 4) {
        gridClass += ` ${styles.grid4}`;
    } else {
        gridClass += ` ${styles.gridFlex}`;
    }

    return (
        <div className={gridClass}>
            {videoList.map(videoProps => (
                <RemoteVideo key={videoProps.id} {...videoProps} />
            ))}
            {count === 1 && (
                <div className={styles.waitingMessage}>
                    Esperando a otros usuarios...
                </div>
            )}
        </div>
    );
};

// --- COMPONENTE: RemoteVideo (Muestra un solo video) ---
const RemoteVideo = ({ id, stream, userName, isLocal, isScreenSharing }) => {
    const videoRef = useRef(null);
    const { selectedAudioOutput } = useWebRTC();

    useEffect(() => {
        if (videoRef.current && stream) {
            videoRef.current.srcObject = stream;

            if (!isLocal && videoRef.current.setSinkId && selectedAudioOutput) {
                videoRef.current.setSinkId(selectedAudioOutput).catch(err => {
                    console.error("Error al establecer el dispositivo de salida de audio:", err);
                });
            }
        }
    }, [stream, isLocal, selectedAudioOutput]);

    const isVideoHidden = isLocal && stream && stream.getVideoTracks().length > 0 && !stream.getVideoTracks()[0].enabled;
    const isAudioHidden = isLocal && stream && stream.getAudioTracks().length > 0 && !stream.getAudioTracks()[0].enabled;


    return (
        <div className={`${styles.videoContainer} ${isLocal ? styles.localVideo : ''} ${isVideoHidden ? styles.videoOff : ''} ${isScreenSharing ? styles.screenSharing : ''}`}>
            <video
                ref={videoRef}
                autoPlay
                playsInline
                muted={isLocal}
                className={styles.videoElement}
            />

            <div className={styles.videoOverlay}>
                <span className={styles.videoUserName}>{userName}</span>

                {isAudioHidden && (
                    <MicOff size={24} className={styles.micOffIcon} />
                )}
                {isScreenSharing && (
                    <ScreenShare size={24} className={styles.screenShareIconIndicator} />
                )}
            </div>

            {isVideoHidden && (
                <div className={styles.videoOffPlaceholder}>
                    <VideoOff size={48} />
                    <span>Video Apagado</span>
                </div>
            )}
        </div>
    );
};

// --- COMPONENTE: ControlPanel (Botones de control) ---
const ControlPanel = ({ onLeave }) => {
    const { toggleMute, toggleVideo, startScreenShare, cycleTheme, isMuted, isVideoOff, myScreenStream, appTheme } = useWebRTC();

    return (
        <div className={styles.controlPanel}>
            {/* Botón de Tema (Restaurado) */}
            <button
                className={styles.controlButton}
                onClick={cycleTheme}
                title={appTheme === 'dark' ? 'Cambiar a Modo Claro' : 'Cambiar a Modo Oscuro'}
            >
                {appTheme === 'dark' ? <Moon size={24} /> : <Sun size={24} />}
            </button>

            <button
                className={`${styles.controlButton} ${isMuted ? styles.muted : ''}`}
                onClick={toggleMute}
                title={isMuted ? 'Habilitar Micrófono' : 'Silenciar Micrófono'}
            >
                {isMuted ? <MicOff size={24} /> : <Mic size={24} />}
            </button>

            <button
                className={`${styles.controlButton} ${isVideoOff ? styles.videoOffButton : ''}`}
                onClick={toggleVideo}
                title={isVideoOff ? 'Habilitar Video' : 'Apagar Video'}
            >
                {isVideoOff ? <VideoOff size={24} /> : <Video size={24} />}
            </button>

            <button
                className={`${styles.controlButton} ${myScreenStream ? styles.sharing : styles.screenShareButton}`}
                onClick={startScreenShare}
                title={myScreenStream ? 'Detener Compartir Pantalla' : 'Compartir Pantalla'}
            >
                <ScreenShare size={24} />
            </button>

            <button
                className={`${styles.controlButton} ${styles.leaveButton}`}
                onClick={onLeave}
                title="Abandonar Sala"
            >
                <X size={24} />
            </button>
        </div>
    );
};

// --- COMPONENTE: Lobby (Formulario de Ingreso) ---
const Lobby = ({ onJoin }) => {
    const [userName, setUserName] = useState('');
    const [audioDevices, setAudioDevices] = useState([]);
    const [videoDevices, setVideoDevices] = useState([]);
    const [audioOutputDevices, setAudioOutputDevices] = useState([]);
    const [selectedAudioIn, setSelectedAudioIn] = useState('');
    const [selectedVideoIn, setSelectedVideoIn] = useState('');
    const [selectedAudioOut, setSelectedAudioOut] = useState('');
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        const getDevices = async () => {
            try {
                // Pedir permisos de media para enumerar dispositivos con nombres reales
                await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
                const devices = await navigator.mediaDevices.enumerateDevices();

                setAudioDevices(devices.filter(d => d.kind === 'audioinput'));
                setVideoDevices(devices.filter(d => d.kind === 'videoinput'));
                setAudioOutputDevices(devices.filter(d => d.kind === 'audiooutput'));

                setSelectedAudioIn(devices.find(d => d.kind === 'audioinput')?.deviceId || '');
                setSelectedVideoIn(devices.find(d => d.kind === 'videoinput')?.deviceId || '');
                setSelectedAudioOut(devices.find(d => d.kind === 'audiooutput')?.deviceId || '');

            } catch (err) {
                console.error("Error al obtener dispositivos:", err);
            } finally {
                setIsLoading(false);
            }
        };
        getDevices();
    }, []);

    const handleSubmit = (e) => {
        e.preventDefault();
        if (userName.trim()) {
            onJoin(userName.trim(), selectedAudioIn, selectedVideoIn, selectedAudioOut);
        }
    };

    if (isLoading) {
        return <div className={styles.loadingMessage}>Cargando dispositivos...</div>;
    }

    return (
        <div className={styles.lobbyContainer}>
            <div className={styles.lobbyCard}>
                <h1 className={styles.lobbyTitle}>Uniéndose a la Videollamada P2P</h1>
                <p className={styles.lobbySubtitle}>Optimizado para fluidez y dispositivos de bajo rendimiento.</p>

                <form onSubmit={handleSubmit} className={styles.lobbyForm}>
                    <div className={styles.formGroup}>
                        <label htmlFor="userName" className={styles.formLabel}>Tu Nombre</label>
                        <input
                            id="userName"
                            type="text"
                            value={userName}
                            onChange={(e) => setUserName(e.target.value)}
                            placeholder="Introduce tu nombre"
                            required
                            className={styles.formInput}
                        />
                    </div>

                    <div className={styles.formGroup}>
                        <label htmlFor="audioIn" className={styles.formLabel}>Micrófono</label>
                        <select
                            id="audioIn"
                            value={selectedAudioIn}
                            onChange={(e) => setSelectedAudioIn(e.target.value)}
                            className={styles.formSelect}
                        >
                            {audioDevices.map(device => (
                                <option key={device.deviceId} value={device.deviceId}>
                                    {device.label || `Micrófono ${device.deviceId.substring(0, 4)}`}
                                </option>
                            ))}
                        </select>
                    </div>

                    <div className={styles.formGroup}>
                        <label htmlFor="videoIn" className={styles.formLabel}>Cámara</label>
                        <select
                            id="videoIn"
                            value={selectedVideoIn}
                            onChange={(e) => setSelectedVideoIn(e.target.value)}
                            className={styles.formSelect}
                        >
                            {videoDevices.map(device => (
                                <option key={device.deviceId} value={device.deviceId}>
                                    {device.label || `Cámara ${device.deviceId.substring(0, 4)}`}
                                </option>
                            ))}
                        </select>
                    </div>

                    <div className={styles.formGroup}>
                        <label htmlFor="audioOut" className={styles.formLabel}>Altavoces (Salida)</label>
                        <select
                            id="audioOut"
                            value={selectedAudioOut}
                            onChange={(e) => setSelectedAudioOut(e.target.value)}
                            className={styles.formSelect}
                        >
                            {audioOutputDevices.map(device => (
                                <option key={device.deviceId} value={device.deviceId}>
                                    {device.label || `Altavoz ${device.deviceId.substring(0, 4)}`}
                                </option>
                            ))}
                        </select>
                    </div>

                    <button type="submit" className={styles.joinButton} disabled={!userName.trim() || isLoading}>
                        <LogIn size={20} className="mr-2" />
                        Unirse a la Sala
                    </button>
                </form>
            </div>
        </div>
    );
};

// --- COMPONENTE: CallRoom (Sala de Llamada Principal) ---
const CallRoom = ({ onLeave }) => {
    const { peers, userName, appTheme } = useWebRTC();
    const [isChatOpen, setIsChatOpen] = useState(false);

    return (
        <div className={styles.appContainer} data-theme={appTheme}>
            <header className={styles.header}>
                <div className={styles.roomInfo}>
                    <h1 className={styles.roomTitle}>Conferencia P2P Liviana</h1>
                    <span className={styles.userCount}>
                        <Plus size={16} className="mr-1" />
                        {Object.keys(peers).length + 1} Participantes
                    </span>
                </div>
                <button
                    className={`${styles.chatToggleButton} ${isChatOpen ? styles.chatActive : ''}`}
                    onClick={() => setIsChatOpen(!isChatOpen)}
                    title="Alternar Chat"
                >
                    <MessageSquare size={24} />
                </button>
            </header>

            <div className={styles.mainLayout}>
                <main className={styles.mainContent}>
                    <VideoGrid />
                </main>

                {isChatOpen && (
                    <aside className={styles.chatSidebar}>
                        <ChatBox userName={userName} />
                    </aside>
                )}
            </div>

            <ControlPanel onLeave={onLeave} />
            <ToastContainer position="bottom-right" />
        </div>
    );
};

// --- COMPONENTE: App (Contenedor Principal) ---
const App = () => {
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
    
    // Aplicar el tema globalmente
    useEffect(() => {
        document.body.className = webRTCLogic.appTheme === 'light' ? styles.lightMode : '';
    }, [webRTCLogic.appTheme]);


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
            <WebRTCContext.Provider value={{ ...webRTCLogic, selectedAudioOutput, userName }}>
                <CallRoom onLeave={handleLeave} />
            </WebRTCContext.Provider>
        );
    }
};

export default App;