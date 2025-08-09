import React, { useState, useEffect, useRef, createContext, useContext, useCallback } from 'react';
import { Mic, MicOff, Video, VideoOff, ScreenShare, MessageSquare, Send, X, LogIn, Plus, Sun, Moon, Flame, UserPlus, Lock, WifiOff, Wifi } from 'lucide-react'; 
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
    const [connectionStatus, setConnectionStatus] = useState('connected'); // 'connected', 'disconnected', 'reconnecting'

    const [roomUsers, setRoomUsers] = useState({});

    const socketRef = useRef(null);
    const myPeerRef = useRef(null);
    const peerConnections = useRef({});

    const currentUserNameRef = useRef('');
    const screenSharePeer = useRef(null);
    const currentRoomIdRef = useRef(roomId); // Para mantener el roomId accesible en callbacks

    // Variable para controlar si la limpieza ya está en curso
    const cleanupInProgress = useRef(false);

    const cleanup = useCallback(() => {
        if (cleanupInProgress.current) {
            console.log("Cleanup ya está en curso, ignorando llamada duplicada.");
            return;
        }
        cleanupInProgress.current = true;
        console.log("Limpiando conexiones...");

        // Detener todas las pistas de los streams locales
        if (myStream) {
            myStream.getTracks().forEach(track => track.stop());
            setMyStream(null);
        }
        if (myScreenStream) {
            myScreenStream.getTracks().forEach(track => track.stop());
            setMyScreenStream(null);
        }

        // Cerrar todas las conexiones PeerJS activas
        Object.values(peerConnections.current).forEach(call => {
            if (call && call.open) { // Solo cerrar si la llamada está abierta
                call.close();
            }
        });
        peerConnections.current = {}; // Limpiar el objeto de conexiones

        // Desconectar Socket.IO
        if (socketRef.current) {
            socketRef.current.disconnect();
            socketRef.current = null;
        }

        // Destruir PeerJS
        if (myPeerRef.current) {
            myPeerRef.current.destroy();
            myPeerRef.current = null;
        }

        // Resetear estados
        setPeers({});
        setChatMessages([]);
        setIsMuted(false);
        setIsVideoOff(false);
        setRoomUsers({});
        screenSharePeer.current = null;
        currentUserNameRef.current = '';
        setConnectionStatus('disconnected'); // Poner el estado como desconectado

        cleanupInProgress.current = false;
        console.log("Limpieza completada.");
    }, [myStream, myScreenStream]);

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
    
    const connectToNewUser = useCallback((peerId, remoteUserName, stream, localUserName, isScreenShare = false) => {
        if (!myPeerRef.current || !stream) {
            console.log("No se puede conectar a nuevo usuario: Peer o stream no disponibles.");
            return;
        }

        const callKey = peerId + (isScreenShare ? '_screen' : '');
        if (peerConnections.current[callKey]) {
            console.log(`[PeerJS] Ya existe una conexión con ${callKey}. Ignorando.`);
            return;
        }

        const metadata = { userName: localUserName, isScreenShare };
        console.log(`[PeerJS] Llamando a nuevo usuario ${remoteUserName} (${peerId}) con mi metadata:`, metadata);

        try {
            const call = myPeerRef.current.call(peerId, stream, { metadata });

            call.on('stream', (remoteStream) => {
                console.log(`[PeerJS] Stream recibido de mi llamada a: ${remoteUserName} (${peerId}). Es pantalla: ${isScreenShare}`);

                if (metadata.isScreenShare || isScreenShare) { // Usa metadata.isScreenShare o el parámetro isScreenShare
                    setPeers(prevPeers => ({
                        ...prevPeers,
                        'screen-share': {
                            stream: remoteStream,
                            userName: remoteUserName,
                            isScreenShare: true,
                            peerId: peerId // Guardar el peerId de la pantalla compartida
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
                console.log(`[PeerJS] Mi llamada con ${peerId} (${isScreenShare ? 'pantalla' : 'cámara'}) cerrada.`);
                if (metadata.isScreenShare || isScreenShare) {
                    removeScreenShare(peerId);
                } else {
                    removePeer(peerId);
                }
            });

            call.on('error', (err) => {
                console.error(`[PeerJS] Error en llamada a ${peerId} (${isScreenShare ? 'pantalla' : 'cámara'}):`, err);
                toast.error(`Error de conexión con ${remoteUserName}.`);
                if (metadata.isScreenShare || isScreenShare) {
                    removeScreenShare(peerId);
                } else {
                    removePeer(peerId);
                }
            });

            peerConnections.current[callKey] = call;
        } catch (error) {
            console.error(`Error al iniciar llamada PeerJS a ${peerId}:`, error);
        }
    }, [myStream, myScreenStream]); // Asegúrate de que los streams están en las dependencias

    const initializeConnections = useCallback((initialStream, userNameToUse) => {
        const SERVER_URL = "https://meet-clone-v0ov.onrender.com";

        if (socketRef.current) {
            socketRef.current.disconnect(); // Desconectar si ya existe una conexión
            socketRef.current = null;
        }
        if (myPeerRef.current) {
            myPeerRef.current.destroy(); // Destruir si ya existe una instancia
            myPeerRef.current = null;
        }

        socketRef.current = io(SERVER_URL);
        myPeerRef.current = new Peer(undefined, {
            host: new URL(SERVER_URL).hostname,
            port: new URL(SERVER_URL).port || 443,
            path: '/peerjs/myapp',
            secure: true,
        });

        // Eventos de Socket.IO
        socketRef.current.on('connect', () => {
            console.log('✅ Socket.IO conectado.');
            setConnectionStatus('connected');
            toast.success('Conectado al servidor de chat.');
            // Emitir join-room después de la conexión de Socket.IO
            myPeerRef.current.on('open', (peerId) => {
                console.log('Mi ID de Peer es: ' + peerId);
                socketRef.current.emit('join-room', currentRoomIdRef.current, peerId, userNameToUse);
            });
        });

        socketRef.current.on('disconnect', (reason) => {
            console.log('❌ Socket.IO desconectado:', reason);
            setConnectionStatus('disconnected');
            toast.error(`Desconectado del servidor de chat: ${reason}. Intentando reconectar...`);
            // Limpiar conexiones PeerJS aquí también para evitar cuellos de botella
            Object.values(peerConnections.current).forEach(call => {
                if (call && call.open) call.close();
            });
            peerConnections.current = {};
            setPeers({}); // Limpiar peers en la UI
            screenSharePeer.current = null;
            if (myPeerRef.current) {
                myPeerRef.current.destroy(); // Destruir PeerJS al desconectarse el socket
                myPeerRef.current = null;
            }
        });

        socketRef.current.on('reconnect_attempt', (attemptNumber) => {
            console.log(`🔌 Intentando reconectar Socket.IO (intento ${attemptNumber})...`);
            setConnectionStatus('reconnecting');
            toast.info(`Intentando reconectar (intento ${attemptNumber})...`);
        });

        socketRef.current.on('reconnect', (attemptNumber) => {
            console.log(`✅ Socket.IO reconectado después de ${attemptNumber} intentos.`);
            setConnectionStatus('connected');
            toast.success('¡Reconectado al servidor!');
            // Al reconectar el socket, re-inicializar PeerJS
            if (!myPeerRef.current) {
                initializeConnections(initialStream, userNameToUse); // Re-iniciar todo el proceso de conexión
            }
        });

        socketRef.current.on('connect_error', (error) => {
            console.error('❌ Error de conexión de Socket.IO:', error);
            setConnectionStatus('disconnected');
            toast.error('Error de conexión al servidor de chat.');
        });


        // Eventos de PeerJS
        myPeerRef.current.on('open', (peerId) => {
            console.log('Mi ID de Peer es: ' + peerId);
            currentUserNameRef.current = userNameToUse; // Asegura que el nombre de usuario esté actualizado
            socketRef.current.emit('join-room', currentRoomIdRef.current, peerId, userNameToUse);
            setConnectionStatus('connected');
        });

        myPeerRef.current.on('call', (call) => {
            const { peer: peerId, metadata } = call;
            console.log(`[PeerJS] Llamada entrante de ${peerId}. Metadata recibida:`, metadata);

            const streamToSend = metadata.isScreenShare ? myScreenStream : initialStream; // Usar initialStream si es la cámara
            if (streamToSend) {
                call.answer(streamToSend);
            } else {
                call.answer(); // Responder sin stream si no hay uno disponible
            }

            call.on('stream', (remoteStream) => {
                console.log(`[PeerJS] Stream recibido de: ${peerId}. Nombre de metadata: ${metadata.userName}, Es pantalla: ${metadata.isScreenShare}`);

                if (metadata.isScreenShare) {
                    setPeers(prevPeers => {
                        const newPeers = { ...prevPeers };
                        const key = 'screen-share';
                        newPeers[key] = {
                            stream: remoteStream,
                            userName: metadata.userName || 'Usuario Desconocido',
                            isScreenShare: true,
                            peerId: peerId
                        };
                        screenSharePeer.current = peerId;
                        return newPeers;
                    });
                } else {
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

            call.on('error', (err) => {
                console.error(`[PeerJS] Error en llamada entrante de ${peerId}:`, err);
                toast.error(`Error de conexión con ${metadata.userName}.`);
                if (metadata.isScreenShare) {
                    removeScreenShare(peerId);
                } else {
                    removePeer(peerId);
                }
            });

            peerConnections.current[peerId + (metadata.isScreenShare ? '_screen' : '')] = call;
        });

        myPeerRef.current.on('disconnected', () => {
            console.log('❌ PeerJS desconectado. Intentando re-inicializar...');
            setConnectionStatus('reconnecting');
            toast.warn('Conexión de video perdida. Intentando reconectar...');
            // Limpiar y re-inicializar PeerJS y Socket.IO (si es necesario)
            // Un pequeño retardo para evitar bucles rápidos en caso de problemas persistentes
            setTimeout(() => {
                if (!myPeerRef.current || myPeerRef.current.destroyed) { // Solo si no ha sido destruido o ya re-inicializado
                     console.log("Re-inicializando PeerJS después de desconexión.");
                    initializeConnections(initialStream, userNameToUse);
                }
            }, 3000); 
        });

        myPeerRef.current.on('error', (err) => {
            console.error('❌ Error de PeerJS:', err);
            setConnectionStatus('disconnected');
            toast.error(`Error en conexión PeerJS: ${err.type}.`);
            // Esto a menudo ocurre si el servidor PeerJS no está disponible.
            // Considerar reintentar la inicialización PeerJS.
            if (err.type === 'peer-unavailable' || err.type === 'server-error') {
                console.log("Reintentando inicialización de PeerJS debido a error de servidor.");
                setTimeout(() => initializeConnections(initialStream, userNameToUse), 5000);
            }
        });

        // Eventos de Socket.IO que dependen de PeerJS y Streams
        socketRef.current.on('room-users', ({ users }) => {
            console.log(`[Socket] Recibida lista de usuarios existentes:`, users);
            setRoomUsers(users);
            
            // Re-establecer llamadas a usuarios existentes
            users.forEach(existingUser => {
                if (existingUser.userId !== myPeerRef.current.id) {
                    if (initialStream && initialStream.active) { // Asegúrate de que el stream local esté activo
                        connectToNewUser(existingUser.userId, existingUser.userName, initialStream, userNameToUse);
                    } else {
                        console.warn("No hay stream local disponible para conectar a nuevos usuarios.");
                    }
                    
                    // Si el usuario remoto ya estaba compartiendo pantalla, intenta conectar a su stream de pantalla
                    // Esto es más complejo ya que el servidor no "guarda" el estado del screen share.
                    // Idealmente, el servidor debería notificar el estado de screen share activo
                    // o el usuario remoto debería re-emitir el evento de screen-share-started al reconectar.
                    // Por ahora, solo conectamos si el usuario ya se había unido y ya tenía un stream de pantalla activo.
                }
            });
        });
        
        socketRef.current.on('user-joined', ({ userId, userName: remoteUserName }) => {
            console.log(`[Socket] Usuario ${remoteUserName} (${userId}) se unió.`);
            setChatMessages(prev => [...prev, { type: 'system', text: `${remoteUserName} se ha unido.`, id: Date.now() }]);
            toast.info(`${remoteUserName} se ha unido a la sala.`);

            setPeers(prevPeers => ({
                ...prevPeers,
                [userId]: { stream: null, userName: remoteUserName, isScreenShare: false }
            }));
            
            if (initialStream && initialStream.active) { // Asegúrate de que el stream local esté activo
                connectToNewUser(userId, remoteUserName, initialStream, userNameToUse);
            } else {
                console.warn("No hay stream local disponible para conectar a usuarios que se unen.");
            }

            if (myScreenStream && myScreenStream.active && myPeerRef.current) {
                connectToNewUser(userId, remoteUserName, myScreenStream, userNameToUse, true);
            }
        });

        socketRef.current.on('user-disconnected', (userId, disconnectedUserName) => {
            console.log(`[Socket] Usuario ${disconnectedUserName} (${userId}) se desconectó.`);
            setChatMessages(prev => [...prev, { type: 'system', text: `${disconnectedUserName} se ha ido.`, id: Date.now() }]);
            toast.warn(`${disconnectedUserName} ha abandonado la sala.`);

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

        socketRef.current.on('user-started-screen-share', ({ userId, userName: remoteUserName }) => {
            console.log(`[Socket] ${remoteUserName} (${userId}) ha empezado a compartir pantalla.`);
            toast.info(`${remoteUserName} está compartiendo su pantalla.`);
            
            // Si yo soy el que está compartiendo, no intento conectarme a mi propia pantalla remota
            if (myPeerRef.current && myPeerRef.current.id === userId) {
                console.log("Ignorando notificación de screen share, es mi propia pantalla.");
                return;
            }

            // Solo conectar a la pantalla compartida remota si no estamos ya viéndola
            if (screenSharePeer.current !== userId) {
                connectToNewUser(userId, remoteUserName, myStream, userNameToUse, true); // Usa mi stream local como dummy, PeerJS lo reemplazará
            }
        });

        socketRef.current.on('user-stopped-screen-share', (userId) => {
            console.log(`[Socket] Usuario ${userId} ha dejado de compartir pantalla.`);
            removeScreenShare(userId);
        });

        socketRef.current.on('theme-changed', (theme) => {
            console.log(`[Socket] Tema cambiado a: ${theme}`);
            setAppTheme(theme);
            toast.info(`El tema ha cambiado a ${theme}.`);
        });

    }, [connectToNewUser]); // Se añadió connectToNewUser como dependencia porque se usa dentro de initializeConnections


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
        console.log(`Peer ${peerId} eliminado.`);
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
            console.log(`Screen share de ${peerId} eliminado.`);
        }
    }, []);


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

    const sendThemeChange = (theme) => {
        if (socketRef.current) {
            socketRef.current.emit('change-theme', theme);
        }
    };

    const shareScreen = async () => {
        if (!socketRef.current || !myPeerRef.current) {
            toast.error("No estás conectado para compartir pantalla.");
            return;
        }

        if (myScreenStream) {
            console.log("[ScreenShare] Deteniendo compartición de pantalla.");
            myScreenStream.getTracks().forEach(track => track.stop());
            setMyScreenStream(null); 
            socketRef.current.emit('stop-screen-share'); 

            Object.keys(peerConnections.current).forEach(key => {
                if (key.endsWith('_screen') && peerConnections.current[key]) { 
                    peerConnections.current[key].close();
                    delete peerConnections.current[key];
                }
            });
            return; 
        }

        try {
            const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
            setMyScreenStream(screenStream);
            console.log("Stream de pantalla inicializado.");

            screenStream.getVideoTracks()[0].onended = () => {
                console.log("[ScreenShare] Compartición de pantalla finalizada por controles del navegador.");
                setMyScreenStream(null); 
                if (socketRef.current) { // Asegurarse de que el socket aún exista
                    socketRef.current.emit('stop-screen-share'); 
                }
                Object.keys(peerConnections.current).forEach(key => {
                    if (key.endsWith('_screen') && peerConnections.current[key]) {
                        peerConnections.current[key].close();
                        delete peerConnections.current[key];
                    }
                });
            };

            socketRef.current.emit('start-screen-share', myPeerRef.current.id, currentUserNameRef.current);

            // Notificar a los peers existentes para que se conecten a mi stream de pantalla
            Object.values(roomUsers).forEach(user => { // Itera sobre los usuarios de la sala
                if (user.userId && user.userId !== myPeerRef.current.id) {
                    connectToNewUser(user.userId, user.userName, screenStream, currentUserNameRef.current, true);
                }
            });

        } catch (err) {
            console.error("Error al compartir pantalla:", err);
            toast.error("No se pudo compartir la pantalla. Revisa los permisos o intenta de nuevo.");
        }
    };

    // La función connect ahora envuelve initializeConnections
    const connect = useCallback(async (initialStream, userName) => {
        currentUserNameRef.current = userName;
        initializeConnections(initialStream, userName);
    }, [initializeConnections]);


    return {
        myStream, myScreenStream, peers, chatMessages, isMuted, isVideoOff, appTheme, connectionStatus, // connectionStatus incluido
        initializeStream, connect, cleanup,
        toggleMute, toggleVideo, sendMessage, shareScreen, sendReaction, sendThemeChange, 
        currentUserName: currentUserNameRef.current
    };
};

// --- COMPONENTES DE LA UI ---

const VideoPlayer = ({ stream, userName, muted = false, isScreenShare = false, isLocal = false, selectedAudioOutput }) => {
    const videoRef = useRef();

    useEffect(() => {
        if (videoRef.current && stream) {
            videoRef.current.srcObject = stream;

            // Intenta establecer el dispositivo de salida de audio solo si está disponible
            if (selectedAudioOutput && videoRef.current.setSinkId) {
                videoRef.current.setSinkId(selectedAudioOutput)
                    .then(() => {
                        // console.log(`Audio output set to device ID: ${selectedAudioOutput}`);
                    })
                    .catch(error => {
                        console.error("Error setting audio output:", error);
                        // toast.error("No se pudo cambiar la salida de audio."); // Evitar spam de toasts
                    });
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
};

const VideoGrid = () => {
    const { myStream, myScreenStream, peers, currentUserName, selectedAudioOutput, connectionStatus } = useWebRTC();

    const [isDesktop, setIsDesktop] = useState(window.innerWidth > 768);

    useEffect(() => {
        const handleResize = () => {
            setIsDesktop(window.innerWidth > 768);
        };
        window.addEventListener('resize', handleResize);
        return () => window.removeEventListener('resize', handleResize);
    }, []);

    const videoElements = [
        myStream && { id: 'my-video', stream: myStream, userName: `${currentUserName} (Tú)`, isLocal: true, muted: true },
        myScreenStream && { id: 'my-screen', stream: myScreenStream, userName: `${currentUserName} (Tú)`, isLocal: true, isScreenShare: true, muted: true },
        peers['screen-share'] && {
            id: 'remote-screen',
            stream: peers['screen-share'].stream,
            userName: peers['screen-share'].userName,
            isScreenShare: true
        },
        ...Object.entries(peers)
            .filter(([key, peerData]) => key !== 'screen-share' && peerData.stream)
            .map(([key, peerData]) => ({
                id: key,
                stream: peerData.stream,
                userName: peerData.userName,
                isScreenShare: false
            }))
    ].filter(Boolean);

    const isSharingScreen = videoElements.some(v => v.isScreenShare);
    const mainContent = isSharingScreen ? videoElements.find(v => v.isScreenShare) : null;
    const sideContent = videoElements.filter(v => !v.isScreenShare);

    const secondaryGridLayoutClass = isDesktop ? styles.desktopLayout : styles.mobileLayout;

    return (
        <div className={styles.videoGridContainer}>
            {connectionStatus !== 'connected' && (
                <div className={styles.connectionStatusOverlay}>
                    <WifiOff size={48} className={styles.connectionStatusIcon} />
                    <p className={styles.connectionStatusText}>
                        {connectionStatus === 'disconnected' ? 'Desconectado' : 'Reconectando...'}
                    </p>
                </div>
            )}
            {mainContent && (
                <div className={styles.mainVideo}>
                    <VideoPlayer key={mainContent.id} {...mainContent} selectedAudioOutput={selectedAudioOutput} />
                </div>
            )}
            <div className={`${styles.videoSecondaryGrid} ${secondaryGridLayoutClass}`}>
                {sideContent.map(v => (
                    <VideoPlayer key={v.id} {...v} selectedAudioOutput={selectedAudioOutput} />
                ))}
            </div>
        </div>
    );
};


const Controls = ({ onToggleChat, onLeave }) => { 
    const { 
        toggleMute, toggleVideo, shareScreen, sendReaction, sendThemeChange, 
        isMuted, isVideoOff, myScreenStream, peers, appTheme, connectionStatus 
    } = useWebRTC();
    
    const [isEmojiPickerOpen, setIsEmojiPickerOpen] = useState(false);
    const emojiPickerRef = useRef(null);
    
    const commonEmojis = appTheme === 'hot' 
    ? ['❤️', '🥵', '😍', '💋', '❤️‍�'] 
    : ['👍', '😆', '❤️', '🎉', '🥺'];

    const emojis = appTheme === 'hot'   
        ? [
            '🌶️', '🥵', '😈', '💋', '❤️‍🔥', '🔥', '🥰', '😏', '🤤', '🫦',
            '👄', '👅', '🍑', '🍆', '🍒', '💄', '👠', '👙', '🩲', '💦',
            '🕺', '😉', '😜', '😘', '🤭', '🙈', '🤑', '💎', '👑', '🫣'
         ]
        : [
            '👍', '👎', '👏', '🙌', '🤝', '🙏', '✋', '🖐️', '👌', '🤌', '🤏', '✌️', '🤘', '🖖', '👋',
            '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '😉', '😊', '😇', '🥰', '😍', '🤩', '😘', '☺️',
            '🥲', '😋', '😛', '😜', '😝', '🤑', '🤗', '🤭', '🤫', '🤨', '🤔', '🤐', '😐', '😑', '😶', '😏', '😒', '😬', '😮‍💨',
            '😌', '😔', '😪', '🤤', '😴', '😷', '🤒', '🤕', '🤢', '🤧', '🥵', '🥶', '🥴', '😵', '🤯', '🤠', '🥳', '😎',
            '😭', '😢', '😤', '😠', '😡', '😳', '🥺', '😱', '😨', '😥', '😓', '😞', '😟', '😣', '😫', '🥱',
            '💔', '💕', '💞', '💗', '💖', '💘', '🎉',
            '👀', '👄','🫦', '🫶', '💪'
        ];
    
    
    const handleSendReaction = (emoji) => {
        sendReaction(emoji);
        setIsEmojiPickerOpen(false);
    };

    const handleToggleEmojiPicker = () => {
        setIsEmojiPickerOpen(prev => !prev);
    };

    useEffect(() => {
        const handleClickOutside = (event) => {
            if (emojiPickerRef.current && !emojiPickerRef.current.contains(event.target)) {
                setIsEmojiPickerOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
        };
    }, [emojiPickerRef]);

    const isSharingMyScreen = !!myScreenStream;
    const isViewingRemoteScreen = !!peers['screen-share']; 

    // Deshabilitar controles si no hay conexión
    const controlsDisabled = connectionStatus !== 'connected';

    return (
        <footer className={styles.controlsFooter}>
            <button onClick={toggleMute} className={`${styles.controlButton} ${isMuted ? styles.controlButtonActive : ''}`} disabled={controlsDisabled}>
                {isMuted ? <MicOff size={20} /> : <Mic size={20} />}
            </button>
            <button onClick={toggleVideo} className={`${styles.controlButton} ${isVideoOff ? styles.controlButtonActive : ''}`} disabled={controlsDisabled}>
                {isVideoOff ? <VideoOff size={20} /> : <Video size={20} />}
            </button>
            <button 
                onClick={shareScreen} 
                className={`${styles.controlButton} ${isSharingMyScreen ? styles.controlButtonScreenShare : ''}`}
                disabled={controlsDisabled || (isViewingRemoteScreen && !isSharingMyScreen)} 
            >
                <ScreenShare size={20} />
            </button>
            <button onClick={onToggleChat} className={styles.controlButton} disabled={controlsDisabled}>
                <MessageSquare size={20} />
            </button>
            <div className={styles.reactionContainer} ref={emojiPickerRef}>
                {commonEmojis.map((emoji) => (
                    <button
                        key={emoji}
                        onClick={() => handleSendReaction(emoji)}
                        className={`${styles.controlButton} ${styles.commonEmojiButton}`}
                        disabled={controlsDisabled}
                    >
                        {emoji}
                    </button>
                ))}
                <button
                    onClick={handleToggleEmojiPicker}
                    className={`${styles.controlButton} ${styles.plusButton} ${isEmojiPickerOpen ? styles.controlButtonActive : ''}`}
                    disabled={controlsDisabled}
                >
                    <Plus size={20} />
                </button>
                {isEmojiPickerOpen && (
                    <div className={styles.emojiPicker}>
                        {emojis.map((emoji) => (
                            <button
                                key={emoji}
                                onClick={() => handleSendReaction(emoji)}
                                className={styles.emojiButton}
                                disabled={controlsDisabled}
                            >
                                {emoji}
                            </button>
                        ))}
                    </div>
                )}
            </div>
            <div className={styles.themeControls}>
                <button onClick={() => sendThemeChange('dark')} className={`${styles.controlButton} ${appTheme === 'dark' ? styles.controlButtonActive : ''}`} disabled={controlsDisabled}>
                    <Moon size={20} />
                </button>
                <button onClick={() => sendThemeChange('light')} className={`${styles.controlButton} ${appTheme === 'light' ? styles.controlButtonActive : ''}`} disabled={controlsDisabled}>
                    <Sun size={20} />
                </button>
                <button onClick={() => sendThemeChange('hot')} className={`${styles.controlButton} ${appTheme === 'hot' ? styles.controlButtonActive : ''}`} disabled={controlsDisabled}>
                    <Flame size={20} />
                </button>
            </div>
            <button onClick={onLeave} className={styles.leaveButton}>
                Salir
            </button>
        </footer>
    );
};

const ChatSidebar = ({ isOpen, onClose }) => { 
    const { chatMessages, sendMessage, currentUserName, appTheme, connectionStatus } = useWebRTC(); 
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

    const chatTitleText = appTheme === 'hot' ? 'Chat de Mundi-Hot' : 'Chat de Mundi-Link';

    // Deshabilitar el input y el botón de enviar si no hay conexión
    const chatDisabled = connectionStatus !== 'connected';

    return (
        <aside className={`${styles.chatSidebar} ${isOpen ? styles.chatSidebarOpen : ''}`}>
            <header className={styles.chatHeader}>
                <h2 className={styles.chatTitle}>{chatTitleText}</h2>
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
                    disabled={chatDisabled} // Deshabilitar si no hay conexión
                />
                <button type="submit" className={styles.chatSendButton} disabled={chatDisabled}>
                    <Send size={18} />
                </button>
            </form>
        </aside>
    );
};

const CallRoom = ({ onLeave }) => { 
    const [isChatOpen, setIsChatOpen] = useState(false);
    const { appTheme } = useWebRTC(); 
    return (
        <div className={`${styles.mainContainer} ${styles[appTheme + 'Mode']}`}> 
            <main className={styles.mainContent}>
                <VideoGrid />
                <Controls onToggleChat={() => setIsChatOpen(o => !o)} onLeave={onLeave} /> 
            </main>
            <ChatSidebar isOpen={isChatOpen} onClose={() => setIsChatOpen(false)} /> 
        </div>
    );
};

const Lobby = ({ onJoin, authenticatedUserName }) => { 
    const [userName, setUserName] = useState(authenticatedUserName || ''); 
    const [videoDevices, setVideoDevices] = useState([]);
    const [audioDevices, setAudioDevices] = useState([]);
    const [audioOutputs, setAudioOutputs] = useState([]);
    const [selectedVideo, setSelectedVideo] = useState('');
    const [selectedAudio, setSelectedAudio] = useState('');
    const [selectedAudioOutput, setSelectedAudioOutput] = useState('');
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        const getDevices = async () => {
            try {
                // Pedir permisos primero para que los labels de los dispositivos no estén vacíos
                await navigator.mediaDevices.getUserMedia({ video: true, audio: true }); 
                const devices = await navigator.mediaDevices.enumerateDevices();
                const videoInputs = devices.filter(d => d.kind === 'videoinput');
                const audioInputs = devices.filter(d => d.kind === 'audioinput');
                const audioOutputs = devices.filter(d => d.kind === 'audiooutput');

                setVideoDevices(videoInputs);
                setAudioDevices(audioInputs);
                setAudioOutputs(audioOutputs);

                if (videoInputs.length > 0) setSelectedVideo(videoInputs[0].deviceId);
                if (audioInputs.length > 0) setSelectedAudio(audioInputs[0].deviceId);
                if (audioOutputs.length > 0) setSelectedAudioOutput(audioOutputs[0].deviceId);

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
            onJoin(userName, selectedAudio, selectedVideo, selectedAudioOutput);
        }
    };

    const lobbyTitleText = 'Unirse a Mundi-Link'; 

    return (
        <div className={`${styles.lobbyContainer} ${styles.darkMode}`}> 
            <div className={styles.lobbyFormWrapper}>
                <div className={styles.lobbyCard}>
                    <img src="logo512.png" alt="Mundi-Link Logo" className={styles.lobbyLogo} />
                    <h1 className={styles.lobbyTitle}>{lobbyTitleText}</h1>
                    <form onSubmit={handleSubmit} className={styles.lobbyForm}>
                        <div className={styles.formGroup}>
                            <label htmlFor="userName" className={styles.formLabel}>Tu nombre</label>
                            <input
                                id="userName" type="text" value={userName}
                                onChange={(e) => setUserName(e.target.value)}
                                placeholder="Ingresa tu nombre"
                                className={styles.formInput}
                                disabled={!!authenticatedUserName} 
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
                                {audioOutputs.length > 0 && (
                                    <div className={styles.formGroup}>
                                        <label htmlFor="audioOutputDevice" className={styles.formLabel}>Salida de Audio</label>
                                        <select id="audioOutputDevice" value={selectedAudioOutput} onChange={(e) => setSelectedAudioOutput(e.target.value)}
                                            className={styles.formSelect}>
                                            {audioOutputs.map(d => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}
                                        </select>
                                    </div>
                                )}
                            </>
                        )}
                        <button type="submit" disabled={!userName.trim() || isLoading} className={styles.joinButton}>
                            <LogIn className={styles.joinButtonIcon} size={20} />
                            Unirse a la llamada
                        </button>
                    </form>
                </div>
            </div>
        </div>
    );
};

const AuthScreen = ({ onAuthSuccess }) => {
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [accessCode, setAccessCode] = useState('');
    const [isRegistering, setIsRegistering] = useState(false);
    const [loading, setLoading] = useState(false);

    const SERVER_BASE_URL = "https://meet-clone-v0ov.onrender.com"; 

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        const endpoint = isRegistering ? `${SERVER_BASE_URL}/register` : `${SERVER_BASE_URL}/login`;

        try {
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ username, password, accessCode }),
            });

            const data = await response.json();

            if (response.ok) {
                toast.success(data.message);
                onAuthSuccess(username); 
            } else {
                toast.error(data.message || 'Error en la autenticación.');
            }
        } catch (error) {
            console.error('Error de red o del servidor:', error);
            toast.error('No se pudo conectar con el servidor de autenticación.');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className={`${styles.lobbyContainer} ${styles.darkMode}`}> 
            <div className={styles.lobbyFormWrapper}>
                <div className={styles.lobbyCard}>
                    <img src="logo512.png" alt="Mundi-Link Logo" className={styles.lobbyLogo} />
                    <h1 className={styles.lobbyTitle}>
                        {isRegistering ? 'Registrarse en Mundi-Link' : 'Iniciar Sesión en Mundi-Link'}
                    </h1>
                    <form onSubmit={handleSubmit} className={styles.lobbyForm}>
                        <div className={styles.formGroup}>
                            <label htmlFor="authUsername" className={styles.formLabel}>Nombre de usuario</label>
                            <input
                                id="authUsername" type="text" value={username}
                                onChange={(e) => setUsername(e.target.value)}
                                placeholder="Tu nombre de usuario"
                                className={styles.formInput}
                                required
                            />
                        </div>
                        <div className={styles.formGroup}>
                            <label htmlFor="authPassword" className={styles.formLabel}>Contraseña</label>
                            <input
                                id="authPassword" type="password" value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                placeholder="Tu contraseña"
                                className={styles.formInput}
                                required
                            />
                        </div>
                        <div className={styles.formGroup}>
                            <label htmlFor="authAccessCode" className={styles.formLabel}>Código de Acceso</label>
                            <input
                                id="authAccessCode" type="password" value={accessCode}
                                onChange={(e) => setAccessCode(e.target.value)}
                                placeholder="Código de acceso"
                                className={styles.formInput}
                                required
                            />
                        </div>
                        <button type="submit" disabled={loading || !username || !password || !accessCode} className={styles.joinButton}>
                            {loading ? 'Cargando...' : isRegistering ? <><UserPlus size={20} className={styles.joinButtonIcon} /> Registrarse</> : <><LogIn size={20} className={styles.joinButtonIcon} /> Iniciar Sesión</>}
                        </button>
                        <button 
                            type="button" 
                            onClick={() => setIsRegistering(prev => !prev)} 
                            className={styles.joinButton} 
                            style={{ backgroundColor: 'transparent', color: 'var(--primary-color)', boxShadow: 'none' }}
                            disabled={loading}
                        >
                            {isRegistering ? '¿Ya tienes una cuenta? Inicia Sesión' : '¿No tienes cuenta? Regístrate'}
                        </button>
                    </form>
                </div>
            </div>
        </div>
    );
};


// --- COMPONENTE PRINCIPAL DE LA APLICACIÓN CORREGIDO ---
export default function App() {
    const [isAuthenticated, setIsAuthenticated] = useState(false);
    const [authenticatedUserName, setAuthenticatedUserName] = useState(''); 
    const [isJoined, setIsJoined] = useState(false);
    const [selectedAudioOutput, setSelectedAudioOutput] = useState('');
    
    const webRTCLogic = useWebRTCLogic('main-room');

    const handleAuthSuccess = (username) => {
        setIsAuthenticated(true);
        setAuthenticatedUserName(username);
    };

    const handleJoin = async (name, audioId, videoId, audioOutputId) => {
        const finalUserName = authenticatedUserName || name; 
        setSelectedAudioOutput(audioOutputId);
        const stream = await webRTCLogic.initializeStream(audioId, videoId);
        if (stream) {
            webRTCLogic.connect(stream, finalUserName); // Pasa el stream inicial y el nombre de usuario
            setIsJoined(true);
        }
    };

    const handleLeave = () => {
        webRTCLogic.cleanup();
        setIsJoined(false);
        setIsAuthenticated(false); 
        setAuthenticatedUserName('');
        setSelectedAudioOutput('');
    };

    useEffect(() => {
        // Listener para el estado de la red global del navegador
        const handleOnline = () => {
            toast.success('¡Internet reconectado! Intentando restablecer la conexión.', { autoClose: 5000 });
            // Si la aplicación ya estaba en una llamada, intenta reconectar PeerJS/Socket.IO
            if (isJoined && webRTCLogic.connectionStatus !== 'connected') {
                // webRTCLogic.connect() se encarga de re-inicializar Peer y Socket si ya están destruidos/desconectados
                // Sin embargo, para que funcione bien, el stream original debe estar disponible.
                // Una forma más robusta sería guardar las device IDs y re-obtener el stream.
                // Por simplicidad, asumimos que el stream original de la conexión se mantiene o se re-obtiene correctamente.
                if (webRTCLogic.myStream) {
                   // No es necesario llamar connect aquí, los listeners de PeerJS/Socket.IO ya lo manejan
                   // initializeConnections lo haría si se detecta una desconexión Peer/Socket.
                }
            }
        };
        const handleOffline = () => {
            toast.error('¡Internet desconectado! La conexión de la llamada podría interrumpirse.', { autoClose: false });
        };

        window.addEventListener('online', handleOnline);
        window.addEventListener('offline', handleOffline);

        // Limpieza de WebRTC al cerrar la ventana
        window.addEventListener('beforeunload', webRTCLogic.cleanup);

        return () => {
            window.removeEventListener('online', handleOnline);
            window.removeEventListener('offline', handleOffline);
            window.removeEventListener('beforeunload', webRTCLogic.cleanup);
        };
    }, [isJoined, webRTCLogic]); // webRTCLogic es una dependencia porque sus propiedades cambian, aunque el objeto en sí es el mismo

    if (!isAuthenticated) {
        return <AuthScreen onAuthSuccess={handleAuthSuccess} />;
    } else if (!isJoined) {
        return <Lobby onJoin={handleJoin} authenticatedUserName={authenticatedUserName} />;
    } else {
        return (
            <WebRTCContext.Provider value={{ ...webRTCLogic, selectedAudioOutput }}> 
                <CallRoom onLeave={handleLeave} /> 
                <ToastContainer />
            </WebRTCContext.Provider>
        );
    }
}
