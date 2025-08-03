import React, { useState, useEffect, useRef, createContext, useContext } from 'react';
import { Mic, MicOff, Video, VideoOff, ScreenShare, MessageSquare, Send, X, LogIn, PartyPopper } from 'lucide-react';
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
    const [roomUsers, setRoomUsers] = useState([]);
    
    // Estado para la pantalla compartida remota activa
    const [remoteScreenStream, setRemoteScreenStream] = useState(null);

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
        setRemoteScreenStream(null);
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

        // Se usa mi stream local para iniciar la llamada, el otro lado responderá con su stream
        const call = myPeerRef.current.call(peerId, stream, { metadata });

        call.on('stream', (remoteStream) => {
            console.log(`[PeerJS] Stream recibido de mi llamada a: ${remoteUserName} (${peerId}). Es pantalla: ${isScreenShare}`);

            if (isScreenShare) {
                // Nuevo comportamiento: si es una pantalla compartida,
                // la guardamos en el estado de pantalla remota, no en 'peers'.
                setRemoteScreenStream({
                    stream: remoteStream,
                    userName: remoteUserName,
                    isScreenShare: true,
                    peerId: peerId
                });
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
                call.answer(stream); // Si no tengo stream de pantalla, respondo con el de video
            }

            call.on('stream', (remoteStream) => {
                console.log(`[PeerJS] Stream recibido de: ${peerId}. Nombre de metadata: ${metadata.userName}, Es pantalla: ${metadata.isScreenShare}`);

                if (metadata.isScreenShare) {
                     setRemoteScreenStream({
                        stream: remoteStream,
                        userName: metadata.userName || 'Usuario Desconocido',
                        isScreenShare: true,
                        peerId: peerId
                    });
                    screenSharePeer.current = peerId;
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

        // LÓGICA CORREGIDA: Cuando un nuevo usuario se une, recibe la lista de todos los usuarios
        // y se conecta automáticamente a sus streams de video y de pantalla si están compartiendo
        socketRef.current.on('room-users', ({ users }) => {
            console.log(`[Socket] Recibida lista de usuarios existentes:`, users);
            setRoomUsers(users);
            
            // Un nuevo usuario se une a la sala. Debe iniciar llamadas a todos los usuarios existentes.
            users.forEach(existingUser => {
                if (existingUser.userId !== myPeerRef.current.id) {
                    // Llamada al stream de video
                    connectToNewUser(existingUser.userId, existingUser.userName, stream, currentUserNameRef.current);
                    
                    // Si el usuario ya está compartiendo pantalla, también se conecta a ese stream.
                    if (existingUser.isScreenShare) {
                        connectToNewUser(existingUser.userId, existingUser.userName, stream, currentUserNameRef.current, true);
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

        // Cuando un usuario empieza a compartir, los demás usuarios se conectan a ese stream de pantalla
        socketRef.current.on('user-started-screen-share', ({ userId, userName: remoteUserName }) => {
            console.log(`[Socket] ${remoteUserName} (${userId}) ha empezado a compartir pantalla.`);
            toast.info(`${remoteUserName} está compartiendo su pantalla.`);
            
            // Si no soy yo el que está compartiendo y no estoy ya viendo una pantalla, me conecto.
            if(myPeerRef.current.id !== userId && !remoteScreenStream) {
                connectToNewUser(userId, remoteUserName, myStream, currentUserNameRef.current, true);
            }
        });

        socketRef.current.on('user-stopped-screen-share', (userId) => {
            console.log(`[Socket] Usuario ${userId} ha dejado de compartir pantalla.`);
            if (remoteScreenStream && remoteScreenStream.peerId === userId) {
                setRemoteScreenStream(null);
            }
            removeScreenShare(userId);
            // Actualizar la lista de usuarios de la sala
            setRoomUsers(prev => prev.map(user => user.userId === userId ? {...user, isScreenShare: false} : user));
        });
    };

    const removePeer = (peerId) => {
        const callKey = peerId;
        if (peerConnections.current[callKey]) {
            peerConnections.current[callKey].close();
            delete peerConnections.current[callKey];
        }
        setPeers(prev => {
            const newPeers = { ...prev };
            delete newPeers[peerId];
            return newPeers;
        });
    };

    const removeScreenShare = (peerId) => {
        const callKey = peerId + '_screen';
        if (peerConnections.current[callKey]) {
            peerConnections.current[callKey].close();
            delete peerConnections.current[callKey];
        }

        // Si la pantalla que estamos viendo es la que se detuvo, la quitamos
        if (remoteScreenStream && remoteScreenStream.peerId === peerId) {
            setRemoteScreenStream(null);
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
        // Lógica para detener el uso compartido de la pantalla si ya está activa
        if (myScreenStream) {
            console.log("[ScreenShare] Deteniendo el uso compartido de pantalla.");
            myScreenStream.getTracks().forEach(track => track.stop());
            socketRef.current.emit('stop-screen-share');
            setMyScreenStream(null);
            return;
        }

        try {
            const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
            setMyScreenStream(screenStream);
            console.log("Stream de pantalla inicializado.");

            // Cuando el usuario deja de compartir desde el navegador (botón de la barra), emitimos el evento
            screenStream.getVideoTracks()[0].onended = () => {
                setMyScreenStream(null);
                socketRef.current.emit('stop-screen-share');
            };

            // Notificamos al servidor que estamos compartiendo pantalla
            socketRef.current.emit('start-screen-share', myPeerRef.current.id, currentUserNameRef.current);
            
            // LÓGICA CORREGIDA: Llamamos a todos los peers existentes para que se conecten a mi stream de pantalla
            Object.keys(peers).forEach(peerId => {
                const peerData = peers[peerId];
                console.log(`[ScreenShare] Llamando a peer ${peerId} para compartir mi pantalla...`);
                // Usamos connectToNewUser con el stream de la pantalla y el flag de isScreenShare en true
                connectToNewUser(peerId, peerData.userName, screenStream, currentUserNameRef.current, true);
            });

        } catch (err) {
            console.error("Error al compartir pantalla:", err);
            toast.error("No se pudo compartir la pantalla. Revisa los permisos.");
        }
    };

    return {
        myStream, myScreenStream, peers, chatMessages, isMuted, isVideoOff,
        initializeStream, connect, cleanup,
        toggleMute, toggleVideo, sendMessage, shareScreen, sendReaction,
        currentUserName: currentUserNameRef.current,
        roomUsers, remoteScreenStream
    };
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
    const { myStream, myScreenStream, peers, currentUserName, selectedAudioOutput, remoteScreenStream } = useWebRTC();

    const videoElements = [
        myStream && { id: 'my-video', stream: myStream, userName: `${currentUserName} (Tú)`, isLocal: true, muted: true },
        myScreenStream && { id: 'my-screen', stream: myScreenStream, userName: `${currentUserName} (Tú)`, isLocal: true, isScreenShare: true, muted: true },
        // La pantalla remota que se está viendo activamente
        remoteScreenStream && {
            id: 'remote-screen',
            stream: remoteScreenStream.stream,
            userName: remoteScreenStream.userName,
            isScreenShare: true
        },
        ...Object.entries(peers)
            .filter(([key, peerData]) => peerData.stream)
            .map(([key, peerData]) => ({
                id: key,
                stream: peerData.stream,
                userName: peerData.userName,
                isScreenShare: false
            }))
    ].filter(Boolean);

    const isSharingScreen = myScreenStream || remoteScreenStream;
    const mainContent = isSharingScreen ? videoElements.find(v => v.isScreenShare) : null;
    const sideContent = videoElements.filter(v => !v.isScreenShare);

    const getGridLayoutClass = (count) => {
        if (count <= 1) return styles.grid_1;
        if (count === 2) return styles.grid_2;
        if (count <= 4) return styles.grid_4;
        if (count <= 6) return styles.grid_6;
        return styles.grid_8_plus;
    };

    const gridLayoutClass = getGridLayoutClass(sideContent.length);

    return (
        <div className={styles.videoGridContainer}>
            {mainContent && (
                <div className={styles.mainVideo}>
                    <VideoPlayer key={mainContent.id} {...mainContent} selectedAudioOutput={selectedAudioOutput} />
                </div>
            )}
            <div className={`${styles.videoSecondaryGrid} ${gridLayoutClass}`}>
                {sideContent.map(v => (
                    <VideoPlayer key={v.id} {...v} selectedAudioOutput={selectedAudioOutput} />
                ))}
            </div>
        </div>
    );
};

const Controls = ({ onToggleChat, onLeave }) => {
    const { 
        toggleMute, toggleVideo, shareScreen, sendReaction,
        isMuted, isVideoOff, myScreenStream, remoteScreenStream
    } = useWebRTC();
    
    const [isEmojiPickerOpen, setIsEmojiPickerOpen] = useState(false);
    const emojiPickerRef = useRef(null);
    const emojis = ['👍', '❤️', '🎉', '😂', '🔥', '👏', '😢', '🤔', '👀', '🥳'];

    const handleSendReaction = (emoji) => {
        sendReaction(emoji);
        setIsEmojiPickerOpen(false);
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
    const isViewingRemoteScreen = !!remoteScreenStream;
    
    return (
        <footer className={styles.controlsFooter}>
            <button onClick={toggleMute} className={`${styles.controlButton} ${isMuted ? styles.controlButtonActive : ''}`}>
                {isMuted ? <MicOff size={20} /> : <Mic size={20} />}
            </button>
            <button onClick={toggleVideo} className={`${styles.controlButton} ${isVideoOff ? styles.controlButtonActive : ''}`}>
                {isVideoOff ? <VideoOff size={20} /> : <Video size={20} />}
            </button>
            <button 
                onClick={shareScreen} 
                className={`${styles.controlButton} ${isSharingMyScreen ? styles.controlButtonScreenShare : ''}`}
                disabled={isViewingRemoteScreen}
            >
                <ScreenShare size={20} />
            </button>
            <button onClick={onToggleChat} className={styles.controlButton}>
                <MessageSquare size={20} />
            </button>
            <div className={styles.reactionContainer} ref={emojiPickerRef}>
                <button
                    onClick={() => setIsEmojiPickerOpen(prev => !prev)}
                    className={`${styles.controlButton} ${isEmojiPickerOpen ? styles.controlButtonActive : ''}`}
                >
                    <PartyPopper size={20} />
                </button>
                {isEmojiPickerOpen && (
                    <div className={styles.emojiPicker}>
                        {emojis.map((emoji) => (
                            <button
                                key={emoji}
                                onClick={() => handleSendReaction(emoji)}
                                className={styles.emojiButton}
                            >
                                {emoji}
                            </button>
                        ))}
                    </div>
                )}
            </div>
            <button onClick={onLeave} className={styles.leaveButton}>
                Salir
            </button>
        </footer>
    );
};

const ChatSidebar = ({ isOpen, onClose }) => {
    const { chatMessages, sendMessage, currentUserName } = useWebRTC();
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

    return (
        <aside className={`${styles.chatSidebar} ${isOpen ? styles.chatSidebarOpen : ''}`}>
            <header className={styles.chatHeader}>
                <h2 className={styles.chatTitle}>Chat</h2>
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
                />
                <button type="submit" className={styles.chatSendButton}>
                    <Send size={18} />
                </button>
            </form>
        </aside>
    );
};

const CallRoom = ({ onLeave }) => {
    const [isChatOpen, setIsChatOpen] = useState(false);
    return (
        <div className={styles.mainContainer}>
            <main className={styles.mainContent}>
                <VideoGrid />
                <Controls onToggleChat={() => setIsChatOpen(o => !o)} onLeave={onLeave} />
            </main>
            <ChatSidebar isOpen={isChatOpen} onClose={() => setIsChatOpen(false)} />
        </div>
    );
};

const Lobby = ({ onJoin }) => {
    const [userName, setUserName] = useState('');
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

    return (
        <div className={styles.lobbyContainer}>
            <div className={styles.lobbyFormWrapper}>
                <div className={styles.lobbyCard}>
                    <h1 className={styles.lobbyTitle}>Unirse a la Sala</h1>
                    <form onSubmit={handleSubmit} className={styles.lobbyForm}>
                        <div className={styles.formGroup}>
                            <label htmlFor="userName" className={styles.formLabel}>Tu nombre</label>
                            <input
                                id="userName" type="text" value={userName}
                                onChange={(e) => setUserName(e.target.value)}
                                placeholder="Ingresa tu nombre"
                                className={styles.formInput}
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
                            Unirse
                        </button>
                    </form>
                </div>
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
                <CallRoom onLeave={handleLeave} />
                <ToastContainer />
            </WebRTCContext.Provider>
        );
    }
}
