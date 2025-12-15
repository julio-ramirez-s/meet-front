import React, { useState, useEffect, useRef, createContext, useContext } from 'react';
import { Mic, MicOff, Video, VideoOff, ScreenShare, LogIn, Plus, X } from 'lucide-react'; // Imports simplificados
import { io } from 'socket.io-client';
import Peer from 'peerjs';
// Eliminadas las dependencias de Toastify
import styles from './App.module.css';

// --- CONTEXTO PARA WEBRTC ---
const WebRTCContext = createContext();
const useWebRTC = () => useContext(WebRTCContext);

// --- HOOK PERSONALIZADO PARA LA LÓGICA DE WEBRTC ---
const useWebRTCLogic = (roomId) => {
    const [myStream, setMyStream] = useState(null);
    const [myScreenStream, setMyScreenStream] = useState(null);
    // peers: { peerId: { stream, userName, peerConnection } }
    const [peers, setPeers] = useState({}); 
    const [isMuted, setIsMuted] = useState(false);
    const [isVideoOff, setIsVideoOff] = useState(false);
    const [roomUsers, setRoomUsers] = useState({}); // { userId: userName }

    const socketRef = useRef(null);
    const myPeerRef = useRef(null);
    const peerConnections = useRef({});
    // Referencia al stream principal (cámara o pantalla) para un manejo eficiente de tracks
    const currentStreamRef = useRef(null); 

    // Helper para manejar notificaciones internas (reemplaza toastify)
    const showLocalNotification = (message) => {
        console.log("Notification:", message);
        // En una app real, aquí iría una UI simple de mensajes
    };

    // --- 1. Inicialización de MediaStream ---
    const initializeStream = async (audioId, videoId) => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                // Usar deviceId específico para forzar la selección de la cámara/micrófono más ligero
                video: videoId ? { deviceId: videoId } : true,
                audio: audioId ? { deviceId: audioId } : true,
            });
            setMyStream(stream);
            currentStreamRef.current = stream;
            return stream;
        } catch (err) {
            showLocalNotification("Error al acceder a cámara/micrófono: " + err.message);
            return null;
        }
    };

    // --- 2. Conexión a Socket.IO y PeerJS ---
    const connect = (stream, userName) => {
        if (socketRef.current || myPeerRef.current) return;

        // Inicialización de Socket.IO
        socketRef.current = io(process.env.REACT_APP_SOCKET_SERVER || '/');

        socketRef.current.on('connect', () => {
            // Inicialización de PeerJS
            myPeerRef.current = new Peer(undefined, {
                host: process.env.REACT_APP_PEER_HOST || '/',
                port: process.env.REACT_APP_PEER_PORT || (window.location.protocol === 'https:' ? 443 : 9000),
                path: '/peerjs',
                // Optimización: Servidores STUN para NAT traversal más rápido
                config: {
                    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
                },
            });

            myPeerRef.current.on('open', (id) => {
                showLocalNotification(`Conectado. ID: ${id}`);
                // Unirse a la sala con información de usuario
                socketRef.current.emit('join-room', roomId, id, userName);
            });

            // Escuchar llamadas entrantes
            myPeerRef.current.on('call', (call) => {
                // Responder la llamada y enviarle mi stream actual
                call.answer(currentStreamRef.current);

                call.on('stream', (remoteStream) => {
                    setPeers(prev => ({
                        ...prev,
                        [call.peer]: {
                            ...prev[call.peer],
                            stream: remoteStream,
                            peerConnection: call.peerConnection // Guardar la conexión
                        }
                    }));
                });
                call.on('close', () => {
                    handlePeerDisconnect(call.peer, 'Call closed');
                });
                peerConnections.current[call.peer] = call; // Guardar la llamada
            });

            myPeerRef.current.on('error', (err) => {
                console.error("PeerJS Error:", err);
                showLocalNotification(`Error de PeerJS: ${err.type}`);
            });
        });

        // --- Manejo de mensajes de Socket.IO ---

        // Nuevo usuario conectado
        socketRef.current.on('user-connected', (userId, userName) => {
            showLocalNotification(`${userName} se ha unido a la sala.`);
            setRoomUsers(prev => ({ ...prev, [userId]: userName }));

            // Llamar al nuevo usuario con mi stream actual
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

            peerConnections.current[userId] = call; // Guardar la llamada
        });

        // Usuario desconectado
        socketRef.current.on('user-disconnected', (userId, userName) => {
            handlePeerDisconnect(userId, `${userName} ha abandonado la sala.`);
        });

        // Actualización de estado (solo nombre)
        socketRef.current.on('update-user-list', (users) => {
            setRoomUsers(users);
        });
    };

    // --- 3. Funciones de Control de Media ---

    // Función crucial para el rendimiento: reemplaza eficientemente todos los tracks en todas las conexiones
    const replaceAllTracks = (newStream) => {
        // Detener tracks del stream anterior (si no es el mismo)
        if (currentStreamRef.current && currentStreamRef.current !== newStream) {
            currentStreamRef.current.getTracks().forEach(track => track.stop());
        }
        
        // Actualizar el estado local y la referencia
        setMyStream(newStream);
        currentStreamRef.current = newStream;

        // Iterar sobre todas las conexiones P2P y reemplazar los tracks sin reiniciar la llamada
        Object.values(peerConnections.current).forEach(call => {
            // Reemplazar Video Track
            const videoSender = call.peerConnection.getSenders().find(s => s.track.kind === 'video');
            if (videoSender && newStream.getVideoTracks().length > 0) {
                videoSender.replaceTrack(newStream.getVideoTracks()[0]).catch(err => console.error("Error replacing video track:", err));
            }
            // Reemplazar Audio Track
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
            // Ya compartiendo, detener:
            myScreenStream.getTracks().forEach(track => track.stop());
            setMyScreenStream(null);
            // Volver al stream de cámara original
            if (myStream) {
                replaceAllTracks(myStream);
            }
        } else {
            try {
                // Capturar pantalla y audio del sistema
                const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
                setMyScreenStream(screenStream);

                // Reemplazar tracks en todas las conexiones P2P con el stream de pantalla
                replaceAllTracks(screenStream);

                // Escuchar evento de fin de compartir pantalla por botón nativo
                screenStream.getVideoTracks()[0].onended = () => {
                    startScreenShare(); // Llama a la función para detener la compartición
                };
            } catch (err) {
                console.error("Error al compartir pantalla:", err);
                showLocalNotification("No se pudo iniciar la compartición de pantalla.");
            }
        }
    };

    // --- 4. Cleanup y Desconexión ---

    const handlePeerDisconnect = (userId, message) => {
        showLocalNotification(message);

        // 1. Cerrar la llamada P2P
        if (peerConnections.current[userId]) {
            peerConnections.current[userId].close();
            delete peerConnections.current[userId];
        }

        // 2. Eliminar de la lista de pares y actualizar la UI
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
        // 1. Cerrar Socket
        if (socketRef.current) {
            socketRef.current.emit('disconnect-room', roomId, myPeerRef.current?.id);
            socketRef.current.disconnect();
            socketRef.current = null;
        }

        // 2. Cerrar PeerJS
        if (myPeerRef.current) {
            myPeerRef.current.destroy();
            myPeerRef.current = null;
        }

        // 3. Cerrar todas las conexiones P2P activas
        Object.values(peerConnections.current).forEach(call => {
            try {
                call.close();
            } catch (e) {
                console.warn("Error closing peer call:", e);
            }
        });
        peerConnections.current = {};

        // 4. Detener tracks de streams
        if (myStream) {
            myStream.getTracks().forEach(track => track.stop());
            setMyStream(null);
        }
        if (myScreenStream) {
            myScreenStream.getTracks().forEach(track => track.stop());
            setMyScreenStream(null);
        }

        // 5. Limpiar estados
        setPeers({});
        setRoomUsers({});
        setIsMuted(false);
        setIsVideoOff(false);
        currentStreamRef.current = null;
    };

    // Exportar solo lo necesario y optimizado
    return {
        myStream,
        myScreenStream,
        peers,
        isMuted,
        isVideoOff,
        roomUsers,
        initializeStream,
        connect,
        cleanup,
        toggleMute,
        toggleVideo,
        startScreenShare,
    };
};

// --- COMPONENTE: VideoGrid (Muestra los videos) ---
const VideoGrid = () => {
    const { myStream, peers, myScreenStream } = useWebRTC();

    // Solo mostrar el stream principal (cámara o pantalla) como video local
    const mainStream = myScreenStream || myStream;

    // Calcular la lista de videos a mostrar
    const videoList = [
        mainStream ? { id: 'local-video', stream: mainStream, userName: 'Tú', isLocal: true, isScreenSharing: !!myScreenStream } : null,
        ...Object.entries(peers).map(([id, peer]) => ({
            id,
            stream: peer.stream,
            userName: peer.userName || 'Usuario Remoto',
            isLocal: false,
            isScreenSharing: false, // Simplificamos el estado remoto, solo nos interesa si es local
        }))
    ].filter(Boolean);

    // Determinar la clase de la cuadrícula para el layout fluido
    let gridClass = styles.videoGrid;
    const count = videoList.length;

    if (count === 1) {
        gridClass += ` ${styles.grid1}`;
    } else if (count === 2) {
        gridClass += ` ${styles.grid2}`;
    } else if (count <= 4) {
        gridClass += ` ${styles.grid4}`;
    } else {
        gridClass += ` ${styles.gridFlex}`; // Para 5+ videos, usa flexbox wrap (más simple)
    }

    return (
        <div className={gridClass}>
            {videoList.map(videoProps => (
                <RemoteVideo key={videoProps.id} {...videoProps} />
            ))}
            {/* Mensaje de espera si solo está el usuario local */}
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
            
            // Asignar el dispositivo de salida de audio solo a videos remotos
            if (!isLocal && videoRef.current.setSinkId && selectedAudioOutput) {
                videoRef.current.setSinkId(selectedAudioOutput).catch(err => {
                    console.error("Error al establecer el dispositivo de salida de audio:", err);
                });
            }
        }
    }, [stream, isLocal, selectedAudioOutput]);

    // Ocultar el video si el track de video está deshabilitado (si es local)
    const isVideoHidden = isLocal && stream && stream.getVideoTracks().length > 0 && !stream.getVideoTracks()[0].enabled;
    const isAudioHidden = isLocal && stream && stream.getAudioTracks().length > 0 && !stream.getAudioTracks()[0].enabled;


    return (
        <div className={`${styles.videoContainer} ${isLocal ? styles.localVideo : ''} ${isVideoHidden ? styles.videoOff : ''} ${isScreenSharing ? styles.screenSharing : ''}`}>
            {/* El atributo `autoPlay` y `playsInline` son cruciales para el móvil */}
            <video
                ref={videoRef}
                autoPlay
                playsInline
                muted={isLocal} // Silenciar video local para evitar eco
                className={styles.videoElement}
            />

            {/* Overlay para indicador de usuario y estado */}
            <div className={styles.videoOverlay}>
                <span className={styles.videoUserName}>{userName}</span>
                
                {/* Indicador de audio apagado */}
                {isAudioHidden && (
                    <MicOff size={24} className={styles.micOffIcon} />
                )}
                {/* Indicador de que el usuario local está compartiendo pantalla */}
                {isScreenSharing && (
                    <ScreenShare size={24} className={styles.screenShareIconIndicator} />
                )}
            </div>

            {/* Placeholder cuando el video está apagado */}
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
    const { toggleMute, toggleVideo, startScreenShare, isMuted, isVideoOff, myScreenStream } = useWebRTC();

    return (
        <div className={styles.controlPanel}>
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

            {/* Botón de Salir (rojo, enfatizado) */}
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

    // Obtener dispositivos
    useEffect(() => {
        const getDevices = async () => {
            try {
                // Solicitar permisos primero
                await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
                const devices = await navigator.mediaDevices.enumerateDevices();

                setAudioDevices(devices.filter(d => d.kind === 'audioinput'));
                setVideoDevices(devices.filter(d => d.kind === 'videoinput'));
                setAudioOutputDevices(devices.filter(d => d.kind === 'audiooutput'));

                // Establecer valores por defecto
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
                    {/* Campo de Nombre */}
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

                    {/* Selector de Micrófono */}
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

                    {/* Selector de Cámara */}
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

                    {/* Selector de Salida de Audio (Altavoces) */}
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
    const { peers } = useWebRTC();

    return (
        <div className={styles.appContainer}>
            <header className={styles.header}>
                <div className={styles.roomInfo}>
                    <h1 className={styles.roomTitle}>Conferencia P2P Liviana</h1>
                    <span className={styles.userCount}>
                        <Plus size={16} className="mr-1" />
                        {Object.keys(peers).length + 1} Participantes
                    </span>
                </div>
            </header>

            {/* Video Grid principal */}
            <main className={styles.mainContent}>
                <VideoGrid />
            </main>

            {/* Panel de Control en la parte inferior */}
            <ControlPanel onLeave={onLeave} />
        </div>
    );
};

// --- COMPONENTE: App (Contenedor Principal) ---
const App = () => {
    const [isJoined, setIsJoined] = useState(false);
    const [userName, setUserName] = useState('');
    const [selectedAudioOutput, setSelectedAudioOutput] = useState(''); // Guarda el ID de altavoz seleccionado

    const webRTCLogic = useWebRTCLogic('main-room');

    const handleJoin = async (name, audioId, videoId, audioOutputId) => {
        setUserName(name);
        setSelectedAudioOutput(audioOutputId);
        // Inicialización del stream antes de conectar
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

    useEffect(() => {
        // Asegurar que la limpieza se haga al cerrar la pestaña/navegador
        window.addEventListener('beforeunload', webRTCLogic.cleanup);
        return () => {
            window.removeEventListener('beforeunload', webRTCLogic.cleanup);
        };
    }, [webRTCLogic]);

    if (!isJoined) {
        return <Lobby onJoin={handleJoin} />;
    } else {
        return (
            // Se pasa el contexto optimizado
            <WebRTCContext.Provider value={{ ...webRTCLogic, selectedAudioOutput, userName }}>
                <CallRoom onLeave={handleLeave} />
            </WebRTCContext.Provider>
        );
    }
};

export default App;