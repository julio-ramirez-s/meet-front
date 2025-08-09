import React, { useState, useEffect, useRef, createContext, useContext, useCallback } from 'react';
import { Mic, MicOff, Video, VideoOff, ScreenShare, MessageSquare, Send, X, LogIn, Sun, Moon, Flame, UserPlus, Lock, WifiOff, Wifi, Plus } from 'lucide-react'; 
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

    // Para persistir los IDs de dispositivos de media entre reconexiones
    const [savedAudioInputDeviceId, setSavedAudioInputDeviceId] = useState(null);
    const [savedVideoInputDeviceId, setSavedVideoInputDeviceId] = useState(null);

    const socketRef = useRef(null);
    const myPeerRef = useRef(null);
    const peerConnections = useRef({}); // Stores PeerJS Call objects

    const currentUserNameRef = useRef('');
    const screenSharePeer = useRef(null);
    const currentRoomIdRef = useRef(roomId); 

    const cleanupInProgress = useRef(false);

    const cleanup = useCallback(() => {
        if (cleanupInProgress.current) {
            console.log("Cleanup ya está en curso, ignorando llamada duplicada.");
            return;
        }
        cleanupInProgress.current = true;
        console.log("Limpiando conexiones...");

        if (myStream) {
            myStream.getTracks().forEach(track => track.stop());
            setMyStream(null);
        }
        if (myScreenStream) {
            myScreenStream.getTracks().forEach(track => track.stop());
            setMyScreenStream(null);
        }

        Object.values(peerConnections.current).forEach(call => {
            if (call && call.open) {
                call.close();
            }
        });
        peerConnections.current = {};

        if (socketRef.current) {
            socketRef.current.disconnect();
            socketRef.current = null;
        }

        if (myPeerRef.current) {
            myPeerRef.current.destroy();
            myPeerRef.current = null;
        }

        setPeers({});
        setChatMessages([]);
        setIsMuted(false);
        setIsVideoOff(false);
        setRoomUsers({});
        screenSharePeer.current = null;
        currentUserNameRef.current = '';
        setConnectionStatus('disconnected'); 

        cleanupInProgress.current = false;
        console.log("Limpieza completada.");
    }, [myStream, myScreenStream]);


    // Función para inicializar o re-inicializar el stream local
    const initializeStream = useCallback(async (audioDeviceId, videoDeviceId) => {
        try {
            // Guarda los IDs de dispositivos para futuras reconexiones
            setSavedAudioInputDeviceId(audioDeviceId);
            setSavedVideoInputDeviceId(videoDeviceId);

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
            setMyStream(null); // Asegura que el stream sea null si hay un error
            return null;
        }
    }, []); 

    
    // Funciones removePeer y removeScreenShare movidas aquí para que connectToNewUser las capture.
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

    // Función para conectar a un nuevo usuario Peer
    const connectToNewUser = useCallback((peerId, remoteUserName, streamToOffer, localUserName, isScreenShare = false) => {
        if (!myPeerRef.current || !streamToOffer || !streamToOffer.active) { // Asegura que el stream a ofrecer esté activo
            console.log("No se puede conectar a nuevo usuario: Peer o stream no disponibles/activos.");
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
            const call = myPeerRef.current.call(peerId, streamToOffer, { metadata });

            call.on('stream', (remoteStream) => {
                console.log(`[PeerJS] Stream recibido de mi llamada a: ${remoteUserName} (${peerId}). Es pantalla: ${isScreenShare}`);

                if (metadata.isScreenShare || isScreenShare) {
                    setPeers(prevPeers => ({
                        ...prevPeers,
                        'screen-share': {
                            stream: remoteStream,
                            userName: remoteUserName,
                            isScreenShare: true,
                            peerId: peerId 
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
    }, [myStream, myScreenStream, removePeer, removeScreenShare]);


    // Función principal para inicializar todas las conexiones (Socket.IO y PeerJS)
    const initializeConnections = useCallback(async (userNameToUse) => { // Eliminado initialStream como argumento
        const SERVER_URL = "https://meet-clone-v0ov.onrender.com"; // URL del backend

        // Limpiar conexiones existentes antes de re-inicializar
        if (socketRef.current) {
            socketRef.current.disconnect(); 
            socketRef.current = null;
        }
        if (myPeerRef.current) {
            myPeerRef.current.destroy(); 
            myPeerRef.current = null;
        }

        setConnectionStatus('reconnecting'); // Indica que estamos en proceso de reconexión
        
        socketRef.current = io(SERVER_URL, {
            // Configuración de reconexión para Socket.IO
            reconnection: true,
            reconnectionAttempts: Infinity, // Intentos infinitos de reconexión
            reconnectionDelay: 1000, // Primer retraso de 1 segundo
            reconnectionDelayMax: 5000, // Retraso máximo de 5 segundos
            randomizationFactor: 0.5 // Aleatoriza el retraso
        });

        // Eventos de Socket.IO
        socketRef.current.on('connect', () => {
            console.log('✅ Socket.IO conectado.');
            setConnectionStatus('connected');
            toast.success('Conectado al servidor de chat.');

            // Inicializar PeerJS solo después de que Socket.IO esté conectado
            if (!myPeerRef.current || myPeerRef.current.destroyed) {
                myPeerRef.current = new Peer(undefined, {
                    host: new URL(SERVER_URL).hostname,
                    port: new URL(SERVER_URL).port || 443,
                    path: '/peerjs/myapp',
                    secure: true,
                    config: { // Configuración ICE para STUN/TURN (importante para conexiones NAT)
                        'iceServers': [
                            { urls: 'stun:stun.l.google.com:19302' },
                            { urls: 'stun:stun1.l.google.com:19302' },
                            // Puedes añadir servidores TURN si tienes uno
                            // { urls: 'turn:YOUR_TURN_SERVER_IP:PORT', username: 'YOUR_USERNAME', credential: 'YOUR_PASSWORD' }
                        ]
                    }
                });

                myPeerRef.current.on('open', (peerId) => {
                    console.log('Mi ID de Peer es: ' + peerId);
                    currentUserNameRef.current = userNameToUse;
                    socketRef.current.emit('join-room', currentRoomIdRef.current, peerId, userNameToUse);
                    setConnectionStatus('connected'); // Confirma que PeerJS también está listo
                });

                myPeerRef.current.on('call', (call) => {
                    const { peer: peerId, metadata } = call;
                    console.log(`[PeerJS] Llamada entrante de ${peerId}. Metadata recibida:`, metadata);

                    const streamToSend = metadata.isScreenShare ? myScreenStream : myStream; // Usa el estado actual de myStream/myScreenStream
                    if (streamToSend && streamToSend.active) { 
                        call.answer(streamToSend);
                    } else {
                        console.warn(`[PeerJS] Respondiendo a la llamada de ${peerId} sin stream activo. Es pantalla: ${metadata.isScreenShare}`);
                        call.answer(); 
                    }

                    call.on('stream', (remoteStream) => {
                        console.log(`[PeerJS] Stream recibido de: ${peerId}. Nombre de metadata: ${metadata.userName}, Es pantalla: ${metadata.isScreenShare}`);

                        if (metadata.isScreenShare) {
                            setPeers(prevPeers => ({
                                ...prevPeers,
                                'screen-share': { stream: remoteStream, userName: metadata.userName || 'Usuario Desconocido', isScreenShare: true, peerId: peerId }
                            }));
                            screenSharePeer.current = peerId;
                        } else {
                            setPeers(prevPeers => ({
                                ...prevPeers,
                                [peerId]: { ...prevPeers[peerId], stream: remoteStream, userName: metadata.userName || 'Usuario Desconocido', isScreenShare: false }
                            }));
                        }
                    });

                    call.on('close', () => {
                        console.log(`[PeerJS] Llamada cerrada con ${peerId}`);
                        if (metadata.isScreenShare) { removeScreenShare(peerId); } else { removePeer(peerId); }
                    });

                    call.on('error', (err) => {
                        console.error(`[PeerJS] Error en llamada entrante de ${peerId}:`, err);
                        toast.error(`Error de conexión con ${metadata.userName}.`);
                        if (metadata.isScreenShare) { removeScreenShare(peerId); } else { removePeer(peerId); }
                    });

                    const callKey = peerId + (metadata.isScreenShare ? '_screen' : ''); 
                    peerConnections.current[callKey] = call;
                });

                myPeerRef.current.on('disconnected', () => {
                    console.log('❌ PeerJS desconectado. Intentando re-inicializar...');
                    setConnectionStatus('reconnecting');
                    toast.warn('Conexión de video perdida. Intentando reconectar...');
                    setTimeout(() => {
                        if (currentUserNameRef.current && myStream) { // Usar myStream del estado
                            console.log("Re-conectando PeerJS y Socket.IO...");
                            initializeConnections(currentUserNameRef.current); // No pasar stream
                        } else {
                            console.warn("No hay suficientes datos para re-inicializar la conexión PeerJS automáticamente.");
                            toast.error("No se pudo reconectar automáticamente. Intenta salir y volver a unirte.");
                            setConnectionStatus('disconnected');
                        }
                    }, 3000); 
                });

                myPeerRef.current.on('error', (err) => {
                    console.error('❌ Error de PeerJS:', err);
                    setConnectionStatus('disconnected');
                    toast.error(`Error en conexión PeerJS: ${err.type}.`);
                    if (err.type === 'peer-unavailable' || err.type === 'server-error' || err.type === 'network') {
                        console.log("Reintentando inicialización de PeerJS debido a error de servidor/red.");
                        setTimeout(() => {
                            if (currentUserNameRef.current && myStream) { // Usar myStream del estado
                                initializeConnections(currentUserNameRef.current); // No pasar stream
                            }
                        }, 5000);
                    }
                });
            }
        });

        socketRef.current.on('disconnect', (reason) => {
            console.log('❌ Socket.IO desconectado:', reason);
            setConnectionStatus('disconnected');
            toast.error(`Desconectado del servidor de chat: ${reason}. Intentando reconectar...`);
            Object.values(peerConnections.current).forEach(call => { if (call && call.open) call.close(); });
            peerConnections.current = {};
            setPeers({});
            screenSharePeer.current = null;
            if (myPeerRef.current) { myPeerRef.current.destroy(); myPeerRef.current = null; }
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
            if (currentUserNameRef.current && myStream) { // Usar myStream del estado
                 initializeConnections(currentUserNameRef.current); // No pasar stream
            } else {
                 console.warn("No se puede re-unir a la sala después de la reconexión: faltan datos.");
            }
        });

        socketRef.current.on('connect_error', (error) => {
            console.error('❌ Error de conexión de Socket.IO:', error);
            setConnectionStatus('disconnected');
            toast.error('Error de conexión al servidor de chat.');
        });
    }, [initializeStream, connectToNewUser, removePeer, removeScreenShare, myStream, myScreenStream]); // Dependencias para initializeConnections (myStream y myScreenStream añadidos)

    // Este useEffect ahora está en el nivel superior del hook useWebRTCLogic
    useEffect(() => {
        // Eventos de Socket.IO que dependen de PeerJS y Streams
        if (!socketRef.current || !myPeerRef.current) return; 

        socketRef.current.on('room-users', ({ users }) => {
            console.log(`[Socket] Recibida lista de usuarios existentes:`, users);
            setRoomUsers(users);
            
            users.forEach(existingUser => {
                if (myPeerRef.current && existingUser.userId !== myPeerRef.current.id) {
                    if (myStream && myStream.active) { 
                        connectToNewUser(existingUser.userId, existingUser.userName, myStream, currentUserNameRef.current);
                    } else {
                        console.warn("No hay stream local activo disponible para conectar a usuarios existentes.");
                    }
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
            
            if (myStream && myStream.active) { 
                connectToNewUser(userId, remoteUserName, myStream, currentUserNameRef.current);
            } else {
                console.warn("No hay stream local activo disponible para conectar a usuarios que se unen.");
            }

            if (myScreenStream && myScreenStream.active && myPeerRef.current) {
                connectToNewUser(userId, remoteUserName, myScreenStream, currentUserNameRef.current, true);
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
            
            if (myPeerRef.current && myPeerRef.current.id === userId) {
                console.log("Ignorando notificación de screen share, es mi propia pantalla.");
                return;
            }

            if (screenSharePeer.current !== userId) {
                connectToNewUser(userId, remoteUserName, myStream, currentUserNameRef.current, true);
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

        // Cleanup function for this useEffect
        return () => {
            if (socketRef.current) {
                socketRef.current.off('room-users');
                socketRef.current.off('user-joined');
                socketRef.current.off('user-disconnected');
                socketRef.current.off('createMessage');
                socketRef.current.off('reaction-received');
                socketRef.current.off('user-started-screen-share');
                socketRef.current.off('user-stopped-screen-share');
                socketRef.current.off('theme-changed');
            }
        };

    }, [myStream, myScreenStream, connectToNewUser, removePeer, removeScreenShare, setAppTheme, setChatMessages, setPeers, setRoomUsers]); 


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
            socketRef.current.emit('reaction', emoji); // FIXED: changed from socket.current to socketRef.current
        }
    };
    const sendThemeChange = (theme) => { 
        if (socketRef.current) {
            socketRef.current.emit('change-theme', theme);
        }
    };

    const shareScreen = async () => {
        if (!socketRef.current || !myPeerRef.current || connectionStatus !== 'connected') {
            toast.error("No estás conectado o la red es inestable para compartir pantalla.");
            return;
        }

        if (myScreenStream) {
            console.log("[ScreenShare] Deteniendo compartición de pantalla.");
            myScreenStream.getTracks().forEach(track => track.stop());
            setMyScreenStream(null); 
            socketRef.current.emit('stop-screen-share', myPeerRef.current.id); // Pasa el userId
            
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
                if (socketRef.current) { 
                    socketRef.current.emit('stop-screen-share', myPeerRef.current.id); 
                }
                Object.keys(peerConnections.current).forEach(key => {
                    if (key.endsWith('_screen') && peerConnections.current[key]) {
                        peerConnections.current[key].close();
                        delete peerConnections.current[key];
                    }
                });
            };

            socketRef.current.emit('start-screen-share', myPeerRef.current.id, currentUserNameRef.current);

            // Reconnect existing peers with the screen stream
            Object.values(roomUsers).forEach(user => { 
                if (user.userId && user.userId !== myPeerRef.current.id) {
                    connectToNewUser(user.userId, user.userName, screenStream, currentUserNameRef.current, true);
                }
            });

        } catch (err) {
            console.error("Error al compartir pantalla:", err);
            toast.error("No se pudo compartir la pantalla. Revisa los permisos o intenta de nuevo.");
        }
    };

    // Función que se llama desde el componente App para iniciar la conexión
    const connect = useCallback(async (userName, audioDeviceId, videoId) => { 
        currentUserNameRef.current = userName;
        // Llama a initializeStream aquí para asegurar que el stream se obtiene antes de initializeConnections
        // FIXED: Renamed parameter 'videoId' to 'videoDeviceId' for clarity with initializeStream
        const stream = await initializeStream(audioDeviceId, videoId); // This 'videoId' is the actual device ID
        if (stream) {
             initializeConnections(userName); 
        } else {
            toast.error("No se pudo obtener el stream para iniciar la conexión.");
            setConnectionStatus('disconnected');
        }
    }, [initializeConnections, initializeStream]);


    return {
        myStream, myScreenStream, peers, chatMessages, isMuted, isVideoOff, appTheme, connectionStatus,
        initializeStream, connect, cleanup,
        toggleMute, toggleVideo, sendMessage, shareScreen, sendReaction, sendThemeChange, 
        currentUserName: currentUserNameRef.current
    };
};

// --- COMPONENTES DE LA UI (Sin cambios significativos en su lógica interna) ---

const VideoPlayer = ({ stream, userName, muted = false, isScreenShare = false, isLocal = false, selectedAudioOutput }) => {
    const videoRef = useRef();
    useEffect(() => { 
        if (videoRef.current && stream) {
            videoRef.current.srcObject = stream;

            if (selectedAudioOutput && videoRef.current.setSinkId) {
                videoRef.current.setSinkId(selectedAudioOutput)
                    .then(() => {
                        // console.log(`Audio output set to device ID: ${selectedAudioOutput}`);
                    })
                    .catch(error => {
                        console.error("Error setting audio output:", error);
                        // toast.error("No se pudo cambiar la salida de audio."); 
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
            {mainContent && ( <div className={styles.mainVideo}> <VideoPlayer key={mainContent.id} {...mainContent} selectedAudioOutput={selectedAudioOutput} /> </div> )}
            <div className={`${styles.videoSecondaryGrid} ${secondaryGridLayoutClass}`}>
                {sideContent.map(v => ( <VideoPlayer key={v.id} {...v} selectedAudioOutput={selectedAudioOutput} /> ))}
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
    ? ['❤️', '🥵', '😍', '💋', '❤️‍🔥'] 
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


// --- COMPONENTE PRINCIPAL DE LA APLICACIÓN ---
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
        // webRTCLogic.connect ahora se encarga de llamar a initializeStream internamente
        await webRTCLogic.connect(finalUserName, audioId, videoId); 
        setIsJoined(true);
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
    }, [webRTCLogic]); 

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
