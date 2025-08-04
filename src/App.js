import React, { useState, useEffect, useRef, createContext, useContext, useCallback } from 'react';
import { Mic, MicOff, Video, VideoOff, ScreenShare, MessageSquare, Send, X, LogIn, PartyPopper, Plus, Users, LayoutDashboard, Settings } from 'lucide-react';
import { io } from 'socket.io-client';
import Peer from 'peerjs';
import { ToastContainer, toast } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';
import { create } from 'zustand';

// URL del servidor para PeerJS y Socket.io
const SERVER_URL = "https://meet-clone-v0ov.onrender.com";

// --- CONTEXTO PARA WEBRTC ---
const WebRTCContext = createContext();
const useWebRTC = () => useContext(WebRTCContext);

// --- ESTADO GLOBAL CON ZUSTAND para manejar las reacciones flotantes ---
const useReactionStore = create((set) => ({
    reactions: [],
    addReaction: (reaction) => set((state) => ({ reactions: [...state.reactions, reaction] })),
    removeReaction: (id) => set((state) => ({ reactions: state.reactions.filter(r => r.id !== id) })),
}));

// --- HOOK PERSONALIZADO PARA LA LÓGICA DE WEBRTC ---
const useWebRTCLogic = (roomId) => {
    const [myStream, setMyStream] = useState(null);
    const [myScreenStream, setMyScreenStream] = useState(null);
    const [peers, setPeers] = useState({});
    const [chatMessages, setChatMessages] = useState([]);
    const [isMuted, setIsMuted] = useState(false);
    const [isVideoOff, setIsVideoOff] = useState(false);
    const [isScreenSharing, setIsScreenSharing] = useState(false);
    const [isChatOpen, setIsChatOpen] = useState(false);

    // Lista de usuarios presentes en la sala
    const [roomUsers, setRoomUsers] = useState({});

    const socketRef = useRef(null);
    const myPeerRef = useRef(null);
    const peerConnections = useRef({});
    const currentUserNameRef = useRef('');
    const screenSharePeer = useRef(null);
    const { addReaction, removeReaction } = useReactionStore();

    // Función de limpieza para cerrar todas las conexiones
    const cleanup = useCallback(() => {
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
        setIsScreenSharing(false);
    }, [myStream, myScreenStream]);

    // Inicializa el stream de audio y video
    const initializeStream = async (audioDeviceId, videoDeviceId) => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: videoDeviceId ? { deviceId: { exact: videoDeviceId } } : true,
                audio: audioDeviceId ? { deviceId: { exact: audioDeviceId } } : true
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
    
    // Función para conectar con un nuevo usuario.
    const connectToNewUser = (peerId, remoteUserName, stream, localUserName, isScreenShare = false) => {
        if (!myPeerRef.current || !stream) return;

        const callKey = peerId + (isScreenShare ? '_screen' : '');
        if (peerConnections.current[callKey]) {
            console.log(`[PeerJS] Ya existe una conexión con ${callKey}. Ignorando.`);
            return;
        }

        const metadata = { userName: localUserName, isScreenShare };
        console.log(`[PeerJS] Llamando a nuevo usuario ${remoteUserName} (${peerId}) con mi metadata:`, metadata);

        const call = myPeerRef.current.call(peerId, stream, { metadata });

        call.on('stream', (remoteStream) => {
            console.log(`[PeerJS] Stream recibido de mi llamada a: ${remoteUserName} (${peerId}). Es pantalla: ${isScreenShare}`);

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
            console.log(`[PeerJS] Mi llamada con ${peerId} (${isScreenShare ? 'pantalla' : 'cámara'}) cerrada.`);
            if (isScreenShare) {
                removeScreenShare(peerId);
            } else {
                removePeer(peerId);
            }
        });

        call.on('error', (err) => {
            console.error(`[PeerJS] Error en la llamada con ${peerId}:`, err);
        });

        peerConnections.current[callKey] = call;
    };
    
    const connect = (stream, currentUserName) => {
        currentUserNameRef.current = currentUserName;

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

        myPeerRef.current.on('call', (call) => {
            const { peer: peerId, metadata } = call;
            console.log(`[PeerJS] Llamada entrante de ${peerId}. Metadata recibida:`, metadata);

            const streamToSend = metadata.isScreenShare ? myScreenStream : myStream;
            if (streamToSend) {
                call.answer(streamToSend);
            } else {
                call.answer(stream);
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
                            isScreenShare: true
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
                console.error(`[PeerJS] Error en la llamada entrante de ${peerId}:`, err);
            });

            peerConnections.current[peerId + (metadata.isScreenShare ? '_screen' : '')] = call;
        });

        // Evento que se dispara cuando un nuevo usuario se une a la sala
        socketRef.current.on('room-users', ({ users }) => {
            console.log(`[Socket] Recibida lista de usuarios existentes:`, users);
            setRoomUsers(users);
            
            users.forEach(existingUser => {
                if (existingUser.userId !== myPeerRef.current.id) {
                    connectToNewUser(existingUser.userId, existingUser.userName, stream, currentUserNameRef.current);
                    
                    if (existingUser.isScreenShare && myScreenStream) {
                        connectToNewUser(existingUser.userId, existingUser.userName, myScreenStream, currentUserNameRef.current, true);
                    }
                }
            });
        });
        
        socketRef.current.on('user-joined', ({ userId, userName: remoteUserName }) => {
            console.log(`[Socket] Usuario ${remoteUserName} (${userId}) se unió.`);
            setChatMessages(prev => [...prev, { type: 'system', text: `${remoteUserName} se ha unido.`, id: Date.now() }]);
            toast.info(`${remoteUserName} se ha unido a la sala.`);

            setRoomUsers(prevUsers => ({
                ...prevUsers,
                [userId]: { userName: remoteUserName, isScreenShare: false, userId }
            }));

            setPeers(prevPeers => ({
                ...prevPeers,
                [userId]: { stream: null, userName: remoteUserName, isScreenShare: false }
            }));

            connectToNewUser(userId, remoteUserName, stream, currentUserNameRef.current);

            if (myScreenStream && myPeerRef.current) {
                connectToNewUser(userId, remoteUserName, myScreenStream, currentUserNameRef.current, true);
            }
        });

        socketRef.current.on('user-disconnected', (userId, disconnectedUserName) => {
            console.log(`[Socket] Usuario ${disconnectedUserName} (${userId}) se desconectó.`);
            setChatMessages(prev => [...prev, { type: 'system', text: `${disconnectedUserName} se ha ido.`, id: Date.now() }]);
            toast.warn(`${disconnectedUserName} ha abandonado la sala.`);

            setRoomUsers(prevUsers => {
                const newUsers = { ...prevUsers };
                delete newUsers[userId];
                return newUsers;
            });

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

        socketRef.current.on('reaction-received', (emoji, user, userId) => {
            toast.success(`${user} reaccionó con ${emoji}`, {
                icon: emoji,
                autoClose: 2000,
                hideProgressBar: true,
                closeOnClick: true,
                pauseOnHover: false,
                draggable: false,
                position: "top-center",
            });
            addReaction({ emoji, userId, id: Date.now() });
        });

        socketRef.current.on('user-started-screen-share', ({ userId, userName: remoteUserName }) => {
            console.log(`[Socket] ${remoteUserName} (${userId}) ha empezado a compartir pantalla.`);
            toast.info(`${remoteUserName} está compartiendo su pantalla.`);

            setRoomUsers(prevUsers => {
                if (prevUsers[userId]) {
                    return { ...prevUsers, [userId]: { ...prevUsers[userId], isScreenShare: true } };
                }
                return prevUsers;
            });

            if (myPeerRef.current) {
                connectToNewUser(userId, remoteUserName, myStream, currentUserNameRef.current, true);
            }
        });

        socketRef.current.on('user-stopped-screen-share', (userId) => {
            console.log(`[Socket] Usuario ${userId} ha dejado de compartir pantalla.`);
            toast.warn(`${roomUsers[userId]?.userName || 'Un usuario'} ha dejado de compartir pantalla.`);

            setRoomUsers(prevUsers => {
                if (prevUsers[userId]) {
                    return { ...prevUsers, [userId]: { ...prevUsers[userId], isScreenShare: false } };
                }
                return prevUsers;
            });
            removeScreenShare(userId);
        });
    };

    // Remueve un peer de la lista de conexiones
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
    }, []);

    // Remueve el stream de pantalla compartida
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
        }
    }, []);

    // Toggles del micrófono, video y pantalla compartida
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

    const shareScreen = async () => {
        if (myScreenStream) {
            console.log("[ScreenShare] Stopping screen share.");
            myScreenStream.getTracks().forEach(track => track.stop());
            socketRef.current.emit('stop-screen-share');
            setMyScreenStream(null);
            setIsScreenSharing(false);
            
            Object.keys(peerConnections.current).forEach(key => {
                if (key.endsWith('_screen')) {
                    const peerId = key.replace('_screen', '');
                    peerConnections.current[key].close();
                    delete peerConnections.current[key];
                }
            });
            
            setPeers(prevPeers => {
                const newPeers = { ...prevPeers };
                delete newPeers['screen-share'];
                return newPeers;
            });

            if (myPeerRef.current) {
                setRoomUsers(prevUsers => {
                    if (prevUsers[myPeerRef.current.id]) {
                        return { ...prevUsers, [myPeerRef.current.id]: { ...prevUsers[myPeerRef.current.id], isScreenShare: false } };
                    }
                    return prevUsers;
                });
            }

            return;
        }

        try {
            const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
            setMyScreenStream(screenStream);
            setIsScreenSharing(true);
            console.log("Stream de pantalla inicializado.");
            
            screenStream.getVideoTracks()[0].onended = () => {
                setMyScreenStream(null);
                setIsScreenSharing(false);
                socketRef.current.emit('stop-screen-share');

                Object.keys(peerConnections.current).forEach(key => {
                    if (key.endsWith('_screen')) {
                        const peerId = key.replace('_screen', '');
                        peerConnections.current[key].close();
                        delete peerConnections.current[key];
                    }
                });

                setPeers(prevPeers => {
                    const newPeers = { ...prevPeers };
                    delete newPeers['screen-share'];
                    return newPeers;
                });
                
                if (myPeerRef.current) {
                    setRoomUsers(prevUsers => {
                        if (prevUsers[myPeerRef.current.id]) {
                            return { ...prevUsers, [myPeerRef.current.id]: { ...prevUsers[myPeerRef.current.id], isScreenShare: false } };
                        }
                        return prevUsers;
                    });
                }
            };

            socketRef.current.emit('start-screen-share');

            Object.keys(peers).forEach(peerId => {
                if (peerId !== 'screen-share') {
                    connectToNewUser(peerId, peers[peerId].userName, screenStream, currentUserNameRef.current, true);
                }
            });

            if (myPeerRef.current) {
                setRoomUsers(prevUsers => {
                    if (prevUsers[myPeerRef.current.id]) {
                        return { ...prevUsers, [myPeerRef.current.id]: { ...prevUsers[myPeerRef.current.id], isScreenShare: true } };
                    }
                    return prevUsers;
                });
            }

        } catch (error) {
            console.error("Error al compartir pantalla:", error);
            toast.error("No se pudo iniciar la pantalla compartida. Por favor, revisa los permisos.");
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

    useEffect(() => {
        // Maneja la limpieza al desmontar el componente o al recargar la página
        return () => {
            if (socketRef.current) {
                socketRef.current.disconnect();
            }
            if (myPeerRef.current) {
                myPeerRef.current.destroy();
            }
        };
    }, []);

    // Proporciona el estado y las funciones a los componentes hijos
    return {
        myStream,
        myScreenStream,
        peers,
        chatMessages,
        isMuted,
        isVideoOff,
        isScreenSharing,
        isChatOpen,
        roomUsers,
        cleanup,
        initializeStream,
        connect,
        toggleMute,
        toggleVideo,
        shareScreen,
        sendMessage,
        sendReaction,
        setIsChatOpen,
    };
};

// --- COMPONENTE LOBBY (PÁGINA DE INGRESO) ---
const Lobby = ({ onJoin }) => {
    const [userName, setUserName] = useState('');
    const [audioDevices, setAudioDevices] = useState([]);
    const [videoDevices, setVideoDevices] = useState([]);
    const [selectedAudioInput, setSelectedAudioInput] = useState('');
    const [selectedVideoInput, setSelectedVideoInput] = useState('');
    const [isLoading, setIsLoading] = useState(true);

    const getDevices = async () => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
            const devices = await navigator.mediaDevices.enumerateDevices();
            
            const audioInputs = devices.filter(device => device.kind === 'audioinput');
            const videoInputs = devices.filter(device => device.kind === 'videoinput');
            
            setAudioDevices(audioInputs);
            setVideoDevices(videoInputs);
            
            // Selecciona el primer dispositivo por defecto
            if (audioInputs.length > 0) {
                setSelectedAudioInput(audioInputs[0].deviceId);
            }
            if (videoInputs.length > 0) {
                setSelectedVideoInput(videoInputs[0].deviceId);
            }
            
            stream.getTracks().forEach(track => track.stop()); // Detiene el stream temporal
            setIsLoading(false);
        } catch (error) {
            console.error("Error al obtener dispositivos de medios:", error);
            setIsLoading(false);
        }
    };

    useEffect(() => {
        getDevices();
    }, []);

    const handleSubmit = (e) => {
        e.preventDefault();
        if (userName) {
            onJoin(userName, selectedAudioInput, selectedVideoInput);
        }
    };

    return (
        <div className="lobbyContainer">
            <div className="lobbyFormWrapper">
                <div className="lobbyCard">
                    <h1 className="lobbyTitle">
                        <PartyPopper className="inline-block mr-2" />
                        Bienvenido a la sala
                    </h1>
                    {isLoading ? (
                        <div className="loadingMessage">Cargando dispositivos...</div>
                    ) : (
                        <form onSubmit={handleSubmit} className="lobbyForm">
                            <div className="formGroup">
                                <label htmlFor="userName" className="formLabel">Tu Nombre</label>
                                <input
                                    id="userName"
                                    type="text"
                                    value={userName}
                                    onChange={(e) => setUserName(e.target.value)}
                                    placeholder="Ingresa tu nombre"
                                    className="formInput"
                                    required
                                />
                            </div>
                            <div className="formGroup">
                                <label htmlFor="audioInput" className="formLabel">Micrófono</label>
                                <select
                                    id="audioInput"
                                    value={selectedAudioInput}
                                    onChange={(e) => setSelectedAudioInput(e.target.value)}
                                    className="formSelect"
                                >
                                    {audioDevices.map(device => (
                                        <option key={device.deviceId} value={device.deviceId}>
                                            {device.label || `Micrófono ${device.deviceId}`}
                                        </option>
                                    ))}
                                </select>
                            </div>
                            <div className="formGroup">
                                <label htmlFor="videoInput" className="formLabel">Cámara</label>
                                <select
                                    id="videoInput"
                                    value={selectedVideoInput}
                                    onChange={(e) => setSelectedVideoInput(e.target.value)}
                                    className="formSelect"
                                >
                                    {videoDevices.map(device => (
                                        <option key={device.deviceId} value={device.deviceId}>
                                            {device.label || `Cámara ${device.deviceId}`}
                                        </option>
                                    ))}
                                </select>
                            </div>
                            <button type="submit" className="joinButton" disabled={!userName}>
                                <LogIn className="joinButtonIcon" />
                                Unirse
                            </button>
                        </form>
                    )}
                </div>
            </div>
        </div>
    );
};

// --- COMPONENTE DE VIDEO INDIVIDUAL ---
const VideoPlayer = ({ stream, userName, isMuted, isScreenShare, isLocal }) => {
    const videoRef = useRef();
    const { reactions, removeReaction } = useReactionStore();

    useEffect(() => {
        if (videoRef.current && stream) {
            videoRef.current.srcObject = stream;
        }
    }, [stream]);

    return (
        <div className={`videoWrapper ${isLocal ? 'localVideoWrapper' : ''} relative`}>
            {stream ? (
                <>
                    <video
                        ref={videoRef}
                        className={`videoElement ${isLocal ? 'localVideo' : ''}`}
                        autoPlay
                        playsInline
                        muted={isLocal || isMuted}
                    />
                    <div className="userNameLabel">{userName}</div>
                    {isLocal && isMuted && <MicOff className="absolute top-2 right-2 text-red-500" size={24} />}
                    {isScreenShare && (
                        <div className="absolute top-2 left-2 flex items-center bg-green-500 text-white px-2 py-1 rounded-full text-xs font-bold">
                            <ScreenShare className="mr-1" size={12} /> Compartiendo
                        </div>
                    )}
                </>
            ) : (
                <div className="flex items-center justify-center h-full w-full bg-slate-800">
                    <p className="text-slate-400">Sin video...</p>
                </div>
            )}
            {reactions.filter(r => r.userId === (isLocal ? 'local' : userName)).map(reaction => (
                <FloatingReaction
                    key={reaction.id}
                    emoji={reaction.emoji}
                    onRemove={() => removeReaction(reaction.id)}
                />
            ))}
        </div>
    );
};

// --- COMPONENTE DE REACCIÓN FLOTANTE ---
const FloatingReaction = ({ emoji, onRemove }) => {
    const [style, setStyle] = useState({});
    const ref = useRef(null);

    useEffect(() => {
        const timeoutId = setTimeout(() => {
            onRemove();
        }, 3000); // Duración de la animación

        const startPositionX = Math.random() * 80 + 10; // 10% a 90%
        const startPositionY = 100;
        const endPositionY = Math.random() * 50;
        const duration = 2 + Math.random() * 1;
        const delay = Math.random() * 0.5;

        setStyle({
            position: 'absolute',
            left: `${startPositionX}%`,
            bottom: '10%',
            opacity: 1,
            fontSize: '2rem',
            transition: `transform ${duration}s ease-out, opacity ${duration}s ease-out`,
            transform: `translateY(-${startPositionY}vh)`,
            animation: `floatUp ${duration}s forwards ease-out`,
            zIndex: 100,
        });

        // setTimeout para la animación de opacidad
        setTimeout(() => {
            if (ref.current) {
                ref.current.style.opacity = 0;
            }
        }, 2000); // Empieza a desvanecerse después de 2s

        return () => clearTimeout(timeoutId);
    }, [onRemove]);

    return (
        <span ref={ref} style={style} className="floating-reaction">
            {emoji}
        </span>
    );
};

// --- COMPONENTE CHAT ---
const Chat = ({ messages, isChatOpen, setIsChatOpen, sendMessage, userName }) => {
    const [message, setMessage] = useState('');
    const chatMessagesRef = useRef(null);

    useEffect(() => {
        if (chatMessagesRef.current) {
            chatMessagesRef.current.scrollTop = chatMessagesRef.current.scrollHeight;
        }
    }, [messages]);

    const handleSubmit = (e) => {
        e.preventDefault();
        sendMessage(message);
        setMessage('');
    };

    return (
        <div className={`chatSidebar ${isChatOpen ? 'chatSidebarOpen' : ''}`}>
            <div className="chatHeader">
                <h2 className="chatTitle">Chat</h2>
                <button className="closeChatButton" onClick={() => setIsChatOpen(false)}>
                    <X size={24} />
                </button>
            </div>
            <div className="chatMessages" ref={chatMessagesRef}>
                {messages.map((msg, index) => (
                    <div key={index} className={`chatMessageWrapper ${msg.user === userName ? 'chatMessageWrapperMe' : ''}`}>
                        {msg.type === 'system' ? (
                            <div className="systemMessage">{msg.text}</div>
                        ) : (
                            <div className={`chatMessage ${msg.user === userName ? 'chatMessageMe' : ''}`}>
                                <div className="chatUserName">{msg.user}</div>
                                <div className="chatMessageText">{msg.text}</div>
                            </div>
                        )}
                    </div>
                ))}
            </div>
            <form className="chatForm" onSubmit={handleSubmit}>
                <input
                    type="text"
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    placeholder="Escribe un mensaje..."
                    className="chatInput"
                />
                <button type="submit" className="chatSendButton">
                    <Send size={20} />
                </button>
            </form>
        </div>
    );
};

// --- COMPONENTE PRINCIPAL DE LA APLICACIÓN ---
export default function App() {
    const [isJoined, setIsJoined] = useState(false);
    const [userName, setUserName] = useState('');
    const webRTCLogic = useWebRTCLogic('main-room');
    const { myStream, myScreenStream, peers, chatMessages, isMuted, isVideoOff, isScreenSharing, isChatOpen, roomUsers, cleanup, initializeStream, connect, toggleMute, toggleVideo, shareScreen, sendMessage, sendReaction, setIsChatOpen } = webRTCLogic;

    // Estado local para los botones de reacción
    const [isEmojiPickerOpen, setIsEmojiPickerOpen] = useState(false);
    const emojiPickerRef = useRef(null);

    const handleJoin = async (name, audioId, videoId) => {
        setUserName(name);
        const stream = await initializeStream(audioId, videoId);
        if (stream) {
            connect(stream, name);
            setIsJoined(true);
        }
    };

    const handleLeave = () => {
        cleanup();
        setIsJoined(false);
        setUserName('');
    };

    const handleReaction = (emoji) => {
        sendReaction(emoji);
        setIsEmojiPickerOpen(false);
    };

    useEffect(() => {
        window.addEventListener('beforeunload', cleanup);
        return () => {
            window.removeEventListener('beforeunload', cleanup);
        };
    }, [cleanup]);

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

    if (!isJoined) {
        return <Lobby onJoin={handleJoin} />;
    }

    const allPeers = Object.entries(peers).filter(([id]) => id !== 'screen-share');
    const myId = myPeerRef?.current?.id;
    const myPeerData = { stream: myStream, userName, isMuted, isVideoOff, isLocal: true, id: myId };
    
    // Organiza los videos para la visualización
    const videoElements = [
        ...allPeers.map(([peerId, peerData]) => (
            <VideoPlayer
                key={peerId}
                stream={peerData.stream}
                userName={peerData.userName}
                isMuted={false} // No tenemos estado de mute del otro usuario
                isScreenShare={false}
            />
        )),
        <VideoPlayer
            key="local-user"
            stream={myStream}
            userName={userName}
            isMuted={isMuted}
            isVideoOff={isVideoOff}
            isLocal={true}
        />
    ];

    return (
        <WebRTCContext.Provider value={webRTCLogic}>
            <div className="mainContainer">
                <div className="mainContent">
                    <div className="videoGridContainer">
                        {isScreenSharing && myScreenStream ? (
                            <div className="mainVideoWrapper">
                                <VideoPlayer stream={myScreenStream} userName={userName} isScreenShare={true} isLocal={true} />
                            </div>
                        ) : peers['screen-share'] ? (
                            <div className="mainVideoWrapper">
                                <VideoPlayer stream={peers['screen-share'].stream} userName={peers['screen-share'].userName} isScreenShare={true} />
                            </div>
                        ) : (
                            <div className="videoGridFlex">
                                {videoElements}
                            </div>
                        )}
                        {isScreenSharing || peers['screen-share'] ? (
                            <div className="videoSidebar">
                                {videoElements.map((video, index) => (
                                    <div key={index} className="videoWrapper small-video">
                                        {video}
                                    </div>
                                ))}
                            </div>
                        ) : null}
                    </div>

                    <div className="controlsFooter">
                        <div className="reactionContainer" ref={emojiPickerRef}>
                            <button
                                className={`plusButton ${isEmojiPickerOpen ? 'controlButtonActive' : ''}`}
                                onClick={() => setIsEmojiPickerOpen(!isEmojiPickerOpen)}
                                title="Reacciones"
                            >
                                <Plus size={24} />
                            </button>
                            {isEmojiPickerOpen && (
                                <div className="emojiPicker">
                                    {['👍', '👎', '😄', '🎉', '❤️', '👏', '🔥'].map(emoji => (
                                        <button
                                            key={emoji}
                                            onClick={() => handleReaction(emoji)}
                                            className="emojiButton"
                                        >
                                            {emoji}
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>

                        <button
                            className={`controlButton ${isMuted ? 'controlButtonActive' : ''}`}
                            onClick={toggleMute}
                            title={isMuted ? 'Desactivar micrófono' : 'Activar micrófono'}
                        >
                            {isMuted ? <MicOff size={24} /> : <Mic size={24} />}
                        </button>
                        <button
                            className={`controlButton ${isVideoOff ? 'controlButtonActive' : ''}`}
                            onClick={toggleVideo}
                            title={isVideoOff ? 'Activar cámara' : 'Desactivar cámara'}
                        >
                            {isVideoOff ? <VideoOff size={24} /> : <Video size={24} />}
                        </button>
                        <button
                            className={`controlButton ${isScreenSharing ? 'controlButtonScreenShare' : ''}`}
                            onClick={shareScreen}
                            title={isScreenSharing ? 'Detener pantalla compartida' : 'Compartir pantalla'}
                        >
                            <ScreenShare size={24} />
                        </button>
                        <button
                            className={`controlButton ${isChatOpen ? 'controlButtonActive' : ''}`}
                            onClick={() => setIsChatOpen(!isChatOpen)}
                            title="Abrir chat"
                        >
                            <MessageSquare size={24} />
                        </button>
                        <button className="leaveButton" onClick={handleLeave}>
                            <X size={18} className="mr-2" />
                            Salir
                        </button>
                    </div>
                </div>
                <Chat messages={chatMessages} isChatOpen={isChatOpen} setIsChatOpen={setIsChatOpen} sendMessage={sendMessage} userName={userName} />
                <ToastContainer
                    position="bottom-right"
                    autoClose={5000}
                    hideProgressBar={false}
                    newestOnTop={false}
                    closeOnClick
                    rtl={false}
                    pauseOnFocusLoss
                    draggable
                    pauseOnHover
                />
            </div>
        </WebRTCContext.Provider>
    );
}

