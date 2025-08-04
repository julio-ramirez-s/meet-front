import React, { useState, useEffect, useRef, createContext, useContext } from 'react';
import { Mic, MicOff, Video, VideoOff, ScreenShare, MessageSquare, Send, X, LogIn, PartyPopper, Plus } from 'lucide-react';
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
    
    // Lista de usuarios presentes en la sala, incluyendo video y pantalla compartida
    const [roomUsers, setRoomUsers] = useState({});

    const socketRef = useRef(null);
    const myPeerRef = useRef(null);
    const peerConnections = useRef({});

    const currentUserNameRef = useRef('');
    const screenSharePeer = useRef(null);

    const cleanup = () => {
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
    };

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
    
    // Función para conectar con un nuevo usuario.
    // Se usa tanto cuando un usuario existente se une como cuando yo me uno y los veo a ellos.
    const connectToNewUser = (peerId, remoteUserName, stream, localUserName, isScreenShare = false) => {
        if (!myPeerRef.current || !stream) return;

        // Si ya tenemos una conexión con este usuario/stream, no hacemos nada
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

        peerConnections.current[callKey] = call;
    };
    
    const connect = (stream, currentUserName) => {
        currentUserNameRef.current = currentUserName;

        const SERVER_URL = "https://meet-clone-v0ov.onrender.com";

        socketRef.current = io(SERVER_URL);
        myPeerRef.current = new Peer(undefined, {
            host: new URL(SERVER_URL).hostname,
            port: new URL(SERVER_URL).port || 443,
            path: '/peerjs/myapp',
            secure: true,
        });

        myPeerRef.current.on('open', (peerId) => {
            console.log('Mi ID de Peer es: ' + peerId);
            // Cuando un usuario se une, el servidor debe notificar a todos
            // y enviar al nuevo usuario una lista de los usuarios existentes.
            socketRef.current.emit('join-room', roomId, peerId, currentUserNameRef.current);
        });

        myPeerRef.current.on('call', (call) => {
            const { peer: peerId, metadata } = call;
            console.log(`[PeerJS] Llamada entrante de ${peerId}. Metadata recibida:`, metadata);

            // Responde a la llamada con mi stream de video o pantalla compartida
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

            peerConnections.current[peerId + (metadata.isScreenShare ? '_screen' : '')] = call;
        });

        // LÓGICA MODIFICADA: El nuevo usuario recibe una lista de todos los usuarios existentes
        // Esto permite que el nuevo usuario inicie llamadas a todos los demás.
        socketRef.current.on('room-users', ({ users }) => {
            console.log(`[Socket] Recibida lista de usuarios existentes:`, users);
            setRoomUsers(users);
            
            // Un nuevo usuario se une a la sala. Debe iniciar llamadas a todos los usuarios existentes.
            users.forEach(existingUser => {
                if (existingUser.userId !== myPeerRef.current.id) {
                    connectToNewUser(existingUser.userId, existingUser.userName, stream, currentUserNameRef.current);
                    
                    // También verifica si el usuario existente está compartiendo pantalla
                    if (existingUser.isScreenShare) {
                        connectToNewUser(existingUser.userId, existingUser.userName, myScreenStream, currentUserNameRef.current, true);
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

            // Lógica existente: un usuario existente llama al nuevo usuario
            connectToNewUser(userId, remoteUserName, stream, currentUserNameRef.current);

            if (myScreenStream && myPeerRef.current) {
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

        // LÓGICA MODIFICADA: Cuando un usuario empieza a compartir,
        // los demás usuarios deben iniciar una llamada a esa transmisión de pantalla
        socketRef.current.on('user-started-screen-share', ({ userId, userName: remoteUserName }) => {
            console.log(`[Socket] ${remoteUserName} (${userId}) ha empezado a compartir pantalla.`);
            toast.info(`${remoteUserName} está compartiendo su pantalla.`);
            
            // Iniciar la llamada para recibir el stream de la pantalla compartida
            if (myPeerRef.current) {
                 // Si el stream de video ya existe, se envía con la llamada para obtener el de pantalla
                connectToNewUser(userId, remoteUserName, myStream, currentUserNameRef.current, true);
            }
        });

        socketRef.current.on('user-stopped-screen-share', (userId) => {
            console.log(`[Socket] Usuario ${userId} ha dejado de compartir pantalla.`);
            removeScreenShare(userId);
        });
    };

    const removePeer = (peerId) => {
        if (peerConnections.current[peerId]) {
            peerConnections.current[peerId].close();
            delete peerConnections.current[peerId];
        }
        setPeers(prev => {
            const newPeers = { ...prev };
            delete newPeers[peerId];
            return newPeers;
        });
    };

    const removeScreenShare = (peerId) => {
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
    };

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

    const shareScreen = async () => {
        if (myScreenStream) {
            console.log("[ScreenShare] Stopping screen share.");
            myScreenStream.getTracks().forEach(track => track.stop());
            socketRef.current.emit('stop-screen-share');
            setMyScreenStream(null);
            Object.keys(peerConnections.current).forEach(key => {
                if (key.endsWith('_screen')) {
                    const peerId = key.replace('_screen', '');
                    peerConnections.current[key].close();
                    delete peerConnections.current[key];
                    setPeers(prevPeers => {
                        const newPeers = { ...prevPeers };
                        delete newPeers['screen-share'];
                        return newPeers;
                    });
                }
            });
            return;
        }

        try {
            const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
            setMyScreenStream(screenStream);
            console.log("Stream de pantalla inicializado.");

            screenStream.getVideoTracks()[0].onended = () => {
                setMyScreenStream(null);
                socketRef.current.emit('stop-screen-share');
                Object.keys(peerConnections.current).forEach(key => {
                    if (key.endsWith('_screen')) {
                        peerConnections.current[key].close();
                        delete peerConnections.current[key];
                    }
                });
            };
            socketRef.current.emit('start-screen-share', myPeerRef.current.id, currentUserNameRef.current);
            Object.keys(peerConnections.current).forEach(peerKey => {
                if (!peerKey.endsWith('_screen')) {
                    const peerId = peerKey;
                    if (peerId === myPeerRef.current?.id) return;
                    connectToNewUser(peerId, peers[peerId]?.userName, screenStream, currentUserNameRef.current, true);
                }
            });
        } catch (err) {
            console.error("Error al compartir pantalla:", err);
            toast.error("No se pudo compartir la pantalla. Revisa los permisos.");
        }
    };

    return { myStream, myScreenStream, peers, chatMessages, isMuted, isVideoOff, initializeStream, connect, cleanup, toggleMute, toggleVideo, sendMessage, shareScreen, sendReaction, currentUserName: currentUserNameRef.current };
};

// --- COMPONENTES DE LA UI ---
const VideoPlayer = ({ stream, userName, muted = false, isScreenShare = false, isLocal = false, selectedAudioOutput }) => {
    const videoRef = useRef();

    useEffect(() => {
        if (videoRef.current && stream) {
            videoRef.current.srcObject = stream;
            if (selectedAudioOutput && videoRef.current.setSinkId) {
                videoRef.current.setSinkId(selectedAudioOutput)
                    .then(() => {
                        console.log(`Audio output set to device ID: ${selectedAudioOutput}`);
                    })
                    .catch(error => {
                        console.error("Error setting audio output:", error);
                    });
            }
        }
    }, [stream, selectedAudioOutput]);

    return (
        <div className={styles.videoWrapper}>
            <video ref={videoRef} playsInline autoPlay muted={muted} className={`${styles.videoElement} ${isLocal && !isScreenShare ? styles.localVideo : ''}`} />
            <div className={styles.userNameLabel}>{userName} {isLocal && "(Tú)"}</div>
        </div>
    );
};

const VideoGrid = () => {
    const { myStream, peers, myScreenStream, currentUserName, selectedAudioOutput } = useWebRTC();

    const allVideos = [];
    if (myStream) {
        allVideos.push({ id: 'local', stream: myStream, userName: currentUserName, isLocal: true, muted: true });
    }
    Object.keys(peers).forEach(peerId => {
        const peer = peers[peerId];
        if (peer.stream) {
            allVideos.push({
                id: peerId,
                stream: peer.stream,
                userName: peer.userName,
                isScreenShare: peer.isScreenShare,
                muted: false,
            });
        }
    });

    const isHorizontal = window.innerWidth > window.innerHeight;
    const gridClass = isHorizontal ? styles.horizontalGrid : styles.verticalGrid;
    const isSharingScreen = myScreenStream || allVideos.some(v => v.isScreenShare && !v.isLocal);

    if (isSharingScreen) {
        const mainVideo = allVideos.find(v => v.isScreenShare) || allVideos.find(v => v.isLocal);
        const otherVideos = allVideos.filter(v => v !== mainVideo);

        return (
            <div className={styles.videoGridContainer}>
                {mainVideo && (
                    <div className={styles.mainVideoWrapper}>
                        <VideoPlayer
                            stream={mainVideo.stream}
                            userName={mainVideo.userName}
                            muted={mainVideo.muted}
                            isLocal={mainVideo.isLocal}
                            isScreenShare={mainVideo.isScreenShare}
                            selectedAudioOutput={selectedAudioOutput}
                        />
                    </div>
                )}
                <div className={styles.videoSidebar}>
                    {otherVideos.map((video) => (
                        <div key={video.id} className={styles.videoSidebarItem}>
                            <VideoPlayer
                                stream={video.stream}
                                userName={video.userName}
                                muted={video.muted}
                                isLocal={video.isLocal}
                                isScreenShare={video.isScreenShare}
                                selectedAudioOutput={selectedAudioOutput}
                            />
                        </div>
                    ))}
                </div>
            </div>
        );
    } else {
        return (
            <div className={`${styles.videoGridContainer} ${gridClass}`}>
                {allVideos.map(video => (
                    <VideoPlayer
                        key={video.id}
                        stream={video.stream}
                        userName={video.userName}
                        muted={video.muted}
                        isLocal={video.isLocal}
                        isScreenShare={video.isScreenShare}
                        selectedAudioOutput={selectedAudioOutput}
                    />
                ))}
            </div>
        );
    }
};

const ChatBox = ({ messages, onClose, onSendMessage, onSendReaction }) => {
    // ... [ChatBox component content remains unchanged]
    const [newMessage, setNewMessage] = useState('');
    const chatEndRef = useRef(null);
    const [isEmojiPickerVisible, setIsEmojiPickerVisible] = useState(false);

    const handleSendMessage = (e) => {
        e.preventDefault();
        onSendMessage(newMessage);
        setNewMessage('');
    };

    const scrollToBottom = () => {
        chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
    };

    useEffect(() => {
        scrollToBottom();
    }, [messages]);

    const emojis = ['😂', '❤️', '👍', '🙏', '🎉', '😢'];

    return (
        <div className={styles.chatBoxContainer}>
            <div className={styles.chatBoxHeader}>
                <h3 className={styles.chatBoxTitle}>Chat de la Sala</h3>
                <button onClick={onClose} className={styles.chatBoxCloseButton}>
                    <X size={18} />
                </button>
            </div>
            <div className={styles.chatMessages}>
                {messages.map((msg, index) => (
                    <div key={index} className={`${styles.chatMessage} ${msg.type === 'system' ? styles.systemMessage : ''}`}>
                        {msg.type === 'system' ? (
                            <span>{msg.text}</span>
                        ) : (
                            <>
                                <strong className={styles.messageUser}>{msg.user}:</strong>
                                <span className={styles.messageText}>{msg.text}</span>
                            </>
                        )}
                    </div>
                ))}
                <div ref={chatEndRef} />
            </div>
            <div className={styles.chatInputArea}>
                <form onSubmit={handleSendMessage} className={styles.chatInputForm}>
                    <div className={styles.reactionContainer}>
                        <button
                            type="button"
                            className={`${styles.plusButton} ${isEmojiPickerVisible ? styles.controlButtonActive : ''}`}
                            onClick={() => setIsEmojiPickerVisible(!isEmojiPickerVisible)}
                        >
                            <Plus size={20} />
                        </button>
                        {isEmojiPickerVisible && (
                            <div className={styles.emojiPicker}>
                                {emojis.map(emoji => (
                                    <button
                                        key={emoji}
                                        type="button"
                                        className={styles.emojiButton}
                                        onClick={() => {
                                            onSendReaction(emoji);
                                            setIsEmojiPickerVisible(false);
                                        }}
                                    >
                                        {emoji}
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                    <input
                        type="text"
                        value={newMessage}
                        onChange={(e) => setNewMessage(e.target.value)}
                        placeholder="Escribe un mensaje..."
                        className={styles.chatInput}
                    />
                    <button type="submit" className={styles.chatSendButton} disabled={!newMessage.trim()}>
                        <Send size={20} />
                    </button>
                </form>
            </div>
        </div>
    );
};

const ControlsFooter = () => {
    const { toggleMute, isMuted, toggleVideo, isVideoOff, shareScreen, myScreenStream, sendMessage, sendReaction, chatMessages } = useWebRTC();
    const [isChatOpen, setIsChatOpen] = useState(false);

    return (
        <div className={styles.controlsFooter}>
            <button onClick={toggleMute} className={styles.controlButton}>
                {isMuted ? <MicOff size={24} /> : <Mic size={24} />}
                <span>{isMuted ? 'Desmutear' : 'Mutear'}</span>
            </button>
            <button onClick={toggleVideo} className={styles.controlButton}>
                {isVideoOff ? <VideoOff size={24} /> : <Video size={24} />}
                <span>{isVideoOff ? 'Activar Video' : 'Desactivar Video'}</span>
            </button>
            <button onClick={shareScreen} className={`${styles.controlButton} ${myScreenStream ? styles.controlButtonActive : ''}`}>
                <ScreenShare size={24} />
                <span>{myScreenStream ? 'Dejar de Compartir' : 'Compartir Pantalla'}</span>
            </button>
            <button onClick={() => setIsChatOpen(prev => !prev)} className={`${styles.controlButton} ${isChatOpen ? styles.controlButtonActive : ''}`}>
                <MessageSquare size={24} />
                <span>Chat</span>
            </button>
            <button onClick={() => window.location.reload()} className={`${styles.controlButton} ${styles.leaveButton}`}>
                <X size={24} />
                <span>Salir</span>
            </button>
            {isChatOpen && (
                <ChatBox messages={chatMessages} onClose={() => setIsChatOpen(false)} onSendMessage={sendMessage} onSendReaction={sendReaction} />
            )}
        </div>
    );
};

// --- COMPONENTES DE LA PÁGINA DE ENTRADA (Lobby) ---
const Lobby = ({ onJoin }) => {
    const [name, setName] = useState('');
    const [videoDevices, setVideoDevices] = useState([]);
    const [audioDevices, setAudioDevices] = useState([]);
    const [audioOutputDevices, setAudioOutputDevices] = useState([]);
    const [selectedVideo, setSelectedVideo] = useState('');
    const [selectedAudio, setSelectedAudio] = useState('');
    const [selectedAudioOutput, setSelectedAudioOutput] = useState('');
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        const getDevices = async () => {
            try {
                // Pedir permisos para listar los dispositivos
                const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
                stream.getTracks().forEach(track => track.stop());

                const devices = await navigator.mediaDevices.enumerateDevices();
                const video = devices.filter(d => d.kind === 'videoinput');
                const audio = devices.filter(d => d.kind === 'audioinput');
                const audioOutput = devices.filter(d => d.kind === 'audiooutput');

                setVideoDevices(video);
                setAudioDevices(audio);
                setAudioOutputDevices(audioOutput);
                
                if (video.length > 0) setSelectedVideo(video[0].deviceId);
                if (audio.length > 0) setSelectedAudio(audio[0].deviceId);
                if (audioOutput.length > 0) setSelectedAudioOutput(audioOutput[0].deviceId);

                setIsLoading(false);
            } catch (err) {
                console.error("Error al obtener dispositivos:", err);
                toast.error("No se pudo acceder a los dispositivos. Por favor, revisa los permisos.");
                setIsLoading(false);
            }
        };
        getDevices();
    }, []);

    const handleSubmit = (e) => {
        e.preventDefault();
        if (name.trim()) {
            onJoin(name, selectedAudio, selectedVideo, selectedAudioOutput);
        } else {
            toast.error("Por favor, ingresa tu nombre.");
        }
    };

    if (isLoading) {
        return (
            <div className={styles.lobbyContainer}>
                <div className={styles.lobbyCard}>
                    <p className={styles.loadingMessage}>Cargando dispositivos...</p>
                </div>
            </div>
        );
    }

    return (
        <div className={styles.lobbyContainer}>
            <div className={styles.lobbyCard}>
                <div className={styles.lobbyHeader}>
                    <PartyPopper size={32} className={styles.icon} />
                    <h2 className={styles.lobbyTitle}>Únete a la Video llamada</h2>
                </div>
                <form onSubmit={handleSubmit} className={styles.lobbyForm}>
                    <div className={styles.formGroup}>
                        <label htmlFor="name" className={styles.formLabel}>Tu nombre:</label>
                        <input
                            id="name"
                            type="text"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="Ej. Juan Pérez"
                            className={styles.formInput}
                            required
                        />
                    </div>
                    <div className={styles.formGroup}>
                        <label htmlFor="video" className={styles.formLabel}>Cámara:</label>
                        <select
                            id="video"
                            value={selectedVideo}
                            onChange={(e) => setSelectedVideo(e.target.value)}
                            className={styles.formSelect}
                        >
                            {videoDevices.map(device => (
                                <option key={device.deviceId} value={device.deviceId}>
                                    {device.label || `Cámara ${device.deviceId.substring(0, 8)}`}
                                </option>
                            ))}
                        </select>
                    </div>
                    <div className={styles.formGroup}>
                        <label htmlFor="audio" className={styles.formLabel}>Micrófono:</label>
                        <select
                            id="audio"
                            value={selectedAudio}
                            onChange={(e) => setSelectedAudio(e.target.value)}
                            className={styles.formSelect}
                        >
                            {audioDevices.map(device => (
                                <option key={device.deviceId} value={device.deviceId}>
                                    {device.label || `Micrófono ${device.deviceId.substring(0, 8)}`}
                                </option>
                            ))}
                        </select>
                    </div>
                    <div className={styles.formGroup}>
                        <label htmlFor="audioOutput" className={styles.formLabel}>Salida de Audio:</label>
                        <select
                            id="audioOutput"
                            value={selectedAudioOutput}
                            onChange={(e) => setSelectedAudioOutput(e.target.value)}
                            className={styles.formSelect}
                        >
                            {audioOutputDevices.map(device => (
                                <option key={device.deviceId} value={device.deviceId}>
                                    {device.label || `Salida de Audio ${device.deviceId.substring(0, 8)}`}
                                </option>
                            ))}
                        </select>
                    </div>
                    <button type="submit" className={styles.joinButton}>
                        <LogIn size={20} />
                        <span>Unirse a la Reunión</span>
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
                <div className={styles.mainContainer}>
                    <main className={styles.mainContent}>
                        <VideoGrid />
                        <ControlsFooter />
                    </main>
                </div>
            </WebRTCContext.Provider>
        );
    }
}
