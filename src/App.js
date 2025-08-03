import React, { useState, useEffect, useRef, createContext, useContext } from 'react';
import { Mic, MicOff, Video, VideoOff, ScreenShare, MessageSquare, Send, X, LogIn, PartyPopper } from 'lucide-react';
import { io } from 'socket.io-client';
import Peer from 'peerjs';
import { ToastContainer, toast } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';

// Contexto para WebRTC para compartir el estado de la aplicación
const WebRTCContext = createContext();
const useWebRTC = () => useContext(WebRTCContext);

// Hook personalizado para la lógica de WebRTC, ahora con manejo mejorado de nuevos usuarios
const useWebRTCLogic = (roomId) => {
    const [myStream, setMyStream] = useState(null);
    const [myScreenStream, setMyScreenStream] = useState(null);
    const [peers, setPeers] = useState({});
    const [chatMessages, setChatMessages] = useState([]);
    const [isMuted, setIsMuted] = useState(false);
    const [isVideoOff, setIsVideoOff] = useState(false);
    const [isScreenSharing, setIsScreenSharing] = useState(false);

    const socketRef = useRef(null);
    const myPeerRef = useRef(null);
    const peerConnections = useRef({});

    const currentUserNameRef = useRef('');

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
        setIsScreenSharing(false);
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

        // Este handler es para recibir llamadas de otros peers
        myPeerRef.current.on('call', (call) => {
            const { peer: peerId, metadata } = call;
            console.log(`[PeerJS] Llamada entrante de ${peerId}. Metadatos recibidos:`, metadata);

            const streamToSend = metadata.isScreenShare ? myScreenStream : myStream;
            if (streamToSend) {
                call.answer(streamToSend);
            } else {
                // Si aún no tenemos el stream, usamos el que se inicializó en el lobby
                call.answer(stream);
            }

            call.on('stream', (remoteStream) => {
                console.log(`[PeerJS] Stream recibido de: ${peerId}. Nombre de metadatos: ${metadata.userName}, Es pantalla: ${metadata.isScreenShare}`);
                setPeers(prevPeers => {
                    const newPeers = { ...prevPeers };
                    const key = metadata.isScreenShare ? `screen-share-${peerId}` : peerId;
                    newPeers[key] = {
                        stream: remoteStream,
                        userName: metadata.userName || 'Usuario Desconocido',
                        isScreenShare: metadata.isScreenShare
                    };
                    return newPeers;
                });
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

        // --- LÓGICA CORREGIDA PARA NUEVOS USUARIOS Y PANTALLA COMPARTIDA ---
        // Este evento se dispara cuando un NUEVO usuario se une y recibe la lista de usuarios existentes.
        socketRef.current.on('room-users', (usersInRoom) => {
            console.log("[Socket] Recibida lista de usuarios en la sala:", usersInRoom);
            const myPeerId = myPeerRef.current.id;
            usersInRoom.forEach(({ userId, userName, isSharingScreen }) => {
                if (userId !== myPeerId) {
                    // Conectar a cada usuario existente con su video stream
                    connectToNewUser(userId, userName, stream, currentUserNameRef.current, false);

                    // Si el usuario existente está compartiendo pantalla, también conectar a su stream de pantalla
                    if (isSharingScreen) {
                        connectToNewUser(userId, userName, myScreenStream, currentUserNameRef.current, true);
                    }
                }
            });
        });

        // Este evento se dispara para los USUARIOS EXISTENTES cuando un nuevo usuario se une.
        socketRef.current.on('user-joined', ({ userId, userName: remoteUserName }) => {
            console.log(`[Socket] Usuario ${remoteUserName} (${userId}) se unió.`);
            setChatMessages(prev => [...prev, { type: 'system', text: `${remoteUserName} se ha unido.`, id: Date.now() }]);
            toast.info(`${remoteUserName} se ha unido a la sala.`);

            // Agregar un marcador de posición para el nuevo peer antes de que llegue el stream
            setPeers(prevPeers => ({
                ...prevPeers,
                [userId]: { stream: null, userName: remoteUserName, isScreenShare: false }
            }));

            // Iniciar la llamada de video con el nuevo usuario
            connectToNewUser(userId, remoteUserName, stream, currentUserNameRef.current);
            // Si yo estoy compartiendo pantalla, también iniciar la llamada de pantalla con el nuevo usuario
            if (myScreenStream && myPeerRef.current) {
                connectToNewUser(userId, remoteUserName, myScreenStream, currentUserNameRef.current, true);
            }
        });
        
        socketRef.current.on('user-disconnected', (userId, disconnectedUserName) => {
            console.log(`[Socket] Usuario ${disconnectedUserName} (${userId}) se desconectó.`);
            setChatMessages(prev => [...prev, { type: 'system', text: `${disconnectedUserName} se ha ido.`, id: Date.now() }]);
            toast.warn(`${disconnectedUserName} ha abandonado la sala.`);

            // Eliminar los peers asociados al usuario desconectado
            removePeer(userId);
            removeScreenShare(userId);
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
        });

        socketRef.current.on('user-stopped-screen-share', (userId) => {
            console.log(`[Socket] Usuario ${userId} ha dejado de compartir pantalla.`);
            removeScreenShare(userId);
        });
    };

    const connectToNewUser = (peerId, remoteUserName, stream, localUserName, isScreenShare = false) => {
        if (!myPeerRef.current || !stream || peerId === myPeerRef.current.id) return;
        
        // Evitar múltiples conexiones si ya existe una
        const callKey = peerId + (isScreenShare ? '_screen' : '');
        if(peerConnections.current[callKey]) return;

        const metadata = { userName: localUserName, isScreenShare };
        console.log(`[PeerJS] Llamando al nuevo usuario ${remoteUserName} (${peerId}) con mis metadatos:`, metadata);

        const call = myPeerRef.current.call(peerId, stream, { metadata });

        call.on('stream', (remoteStream) => {
            console.log(`[PeerJS] Stream recibido de mi llamada a: ${remoteUserName} (${peerId}). Es pantalla: ${isScreenShare}`);
            setPeers(prevPeers => {
                const newPeers = { ...prevPeers };
                const key = isScreenShare ? `screen-share-${peerId}` : peerId;
                newPeers[key] = {
                    stream: remoteStream,
                    userName: remoteUserName,
                    isScreenShare
                };
                return newPeers;
            });
        });

        call.on('close', () => {
            console.log(`[PeerJS] Mi llamada con ${peerId} (cámara) cerrada.`);
            if (isScreenShare) {
                removeScreenShare(peerId);
            } else {
                removePeer(peerId);
            }
        });
        
        peerConnections.current[callKey] = call;
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
    
    // Remueve un stream de pantalla específico, no todos
    const removeScreenShare = (peerId) => {
        const callKey = `screen-share-${peerId}`;
        const call = peerConnections.current[callKey];
        if (call) {
            call.close();
            delete peerConnections.current[callKey];
        }
        setPeers(prev => {
            const newPeers = { ...prev };
            delete newPeers[callKey];
            return newPeers;
        });
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
            console.log("[ScreenShare] Deteniendo pantalla compartida.");
            myScreenStream.getTracks().forEach(track => track.stop());
            socketRef.current.emit('stop-screen-share');
            setMyScreenStream(null);
            setIsScreenSharing(false);
            // Cierra todas las llamadas de pantalla salientes
            Object.keys(peerConnections.current).forEach(key => {
                if (key.endsWith('_screen')) {
                    peerConnections.current[key].close();
                    delete peerConnections.current[key];
                }
            });
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
                // Cierra todas las llamadas de pantalla salientes
                Object.keys(peerConnections.current).forEach(key => {
                    if (key.endsWith('_screen')) {
                        peerConnections.current[key].close();
                        delete peerConnections.current[key];
                    }
                });
            };

            socketRef.current.emit('start-screen-share', myPeerRef.current.id, currentUserNameRef.current);
            const myPeerId = myPeerRef.current.id;
            // Llama a todos los peers existentes para compartir la pantalla
            Object.keys(peers).forEach(peerKey => {
                const peerId = peerKey.includes('screen-share') ? peerKey.split('-').pop() : peerKey;
                const peerData = peers[peerKey];
                if (peerId !== myPeerId && !peerData.isScreenShare) {
                    connectToNewUser(peerId, peerData.userName, screenStream, currentUserNameRef.current, true);
                }
            });

        } catch (err) {
            console.error("Error al compartir pantalla:", err);
            toast.error("No se pudo compartir la pantalla. Revisa los permisos.");
        }
    };

    return {
        myStream, myScreenStream, peers, chatMessages, isMuted, isVideoOff, isScreenSharing,
        initializeStream, connect, cleanup,
        toggleMute, toggleVideo, sendMessage, shareScreen, sendReaction,
        currentUserName: currentUserNameRef.current
    };
};

// --- COMPONENTES DE LA UI CON ESTILOS TAILWIND ---

const VideoPlayer = ({ stream, userName, muted = false, isScreenShare = false, isLocal = false, selectedAudioOutput }) => {
    const videoRef = useRef();
    const [isStreamLoaded, setIsStreamLoaded] = useState(false);

    useEffect(() => {
        if (videoRef.current && stream) {
            videoRef.current.srcObject = stream;
            // Escucha el evento 'loadedmetadata' para saber cuando el video está listo
            videoRef.current.onloadedmetadata = () => {
                videoRef.current.play().catch(e => console.error("Error al reproducir el video:", e));
                setIsStreamLoaded(true);
            };

            if (selectedAudioOutput && videoRef.current.setSinkId) {
                videoRef.current.setSinkId(selectedAudioOutput)
                    .then(() => {
                        console.log(`Salida de audio configurada en el dispositivo: ${selectedAudioOutput}`);
                    })
                    .catch(error => {
                        console.error("Error al configurar la salida de audio:", error);
                    });
            }
        }
    }, [stream, selectedAudioOutput]);

    return (
        <div className={`relative w-full h-full bg-slate-800 rounded-lg overflow-hidden ${!isStreamLoaded && "flex items-center justify-center"}`}>
            <video
                ref={videoRef}
                playsInline
                autoPlay
                muted={muted}
                className={`absolute inset-0 w-full h-full object-cover rounded-lg transform ${isLocal && !isScreenShare ? '-scale-x-100' : ''}`}
            />
            <div className="absolute bottom-2 left-2 px-2 py-1 bg-slate-900 bg-opacity-70 text-white text-xs font-semibold rounded-md">
                {userName || 'Usuario Desconocido'} {isScreenShare && "(Pantalla)"}
            </div>
            {!isStreamLoaded && (
                 <div className="absolute inset-0 flex items-center justify-center text-slate-300 font-bold text-lg">
                    Cargando video...
                 </div>
            )}
        </div>
    );
};

const VideoGrid = () => {
    const { myStream, myScreenStream, peers, currentUserName, selectedAudioOutput, isScreenSharing } = useWebRTC();

    const allPeers = { ...peers };
    if (myStream) {
        allPeers['my-video'] = { stream: myStream, userName: `${currentUserName} (Tú)`, isLocal: true, muted: true };
    }
    if (myScreenStream) {
        allPeers['my-screen'] = { stream: myScreenStream, userName: `${currentUserName} (Tú)`, isScreenShare: true, isLocal: true, muted: true };
    }

    const screenSharePeer = Object.entries(allPeers).find(([key, peerData]) => peerData.isScreenShare);
    const regularVideoPeers = Object.entries(allPeers).filter(([key, peerData]) => !peerData.isScreenShare);

    const mainContent = screenSharePeer;
    const sideContent = regularVideoPeers;

    let gridLayoutClass = '';
    const numVideos = sideContent.length;

    if (mainContent) {
        // Layout con pantalla compartida, videos laterales en una fila
        gridLayoutClass = `grid-cols-2 lg:grid-cols-3 xl:grid-cols-4`;
    } else {
        // Layout sin pantalla compartida, grid dinámico
        if (numVideos <= 1) {
            gridLayoutClass = "grid-cols-1";
        } else if (numVideos === 2) {
            gridLayoutClass = "grid-cols-2";
        } else if (numVideos <= 4) {
            gridLayoutClass = "grid-cols-2 sm:grid-cols-2";
        } else if (numVideos <= 6) {
            gridLayoutClass = "grid-cols-2 sm:grid-cols-3";
        } else {
            gridLayoutClass = "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4";
        }
    }

    return (
        <div className="flex flex-col h-full w-full">
            {mainContent && (
                <div className="w-full flex-grow p-2">
                    <VideoPlayer key={mainContent[0]} {...mainContent[1]} selectedAudioOutput={selectedAudioOutput} />
                </div>
            )}
            <div className={`grid gap-4 w-full p-2 ${mainContent ? 'flex-shrink-0 h-40 overflow-x-auto overflow-y-hidden' : 'flex-grow'} ${gridLayoutClass}`}>
                {sideContent.map(([key, peerData]) => (
                    <VideoPlayer key={key} {...peerData} selectedAudioOutput={selectedAudioOutput} />
                ))}
            </div>
        </div>
    );
};

const Controls = ({ onToggleChat, onLeave }) => {
    const { toggleMute, toggleVideo, shareScreen, sendReaction, isMuted, isVideoOff, isScreenSharing } = useWebRTC();
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

    const baseButtonStyle = "p-3 rounded-full transition-all duration-200 ease-in-out shadow-lg";

    return (
        <footer className="w-full h-16 flex items-center justify-center p-4 bg-slate-900 text-white z-20">
            <div className="flex gap-4">
                <button
                    onClick={toggleMute}
                    className={`${baseButtonStyle} ${isMuted ? 'bg-red-600 hover:bg-red-700' : 'bg-slate-700 hover:bg-slate-600'}`}
                    title={isMuted ? "Desactivar silencio" : "Silenciar"}
                >
                    {isMuted ? <MicOff size={20} /> : <Mic size={20} />}
                </button>
                <button
                    onClick={toggleVideo}
                    className={`${baseButtonStyle} ${isVideoOff ? 'bg-red-600 hover:bg-red-700' : 'bg-slate-700 hover:bg-slate-600'}`}
                    title={isVideoOff ? "Encender cámara" : "Apagar cámara"}
                >
                    {isVideoOff ? <VideoOff size={20} /> : <Video size={20} />}
                </button>
                <button
                    onClick={shareScreen}
                    className={`${baseButtonStyle} ${isScreenSharing ? 'bg-sky-500 hover:bg-sky-600' : 'bg-slate-700 hover:bg-slate-600'}`}
                    title={isScreenSharing ? "Dejar de compartir pantalla" : "Compartir pantalla"}
                >
                    <ScreenShare size={20} />
                </button>
                <button
                    onClick={onToggleChat}
                    className={`${baseButtonStyle} bg-slate-700 hover:bg-slate-600`}
                    title="Abrir chat"
                >
                    <MessageSquare size={20} />
                </button>
                <div className="relative" ref={emojiPickerRef}>
                    <button
                        onClick={() => setIsEmojiPickerOpen(prev => !prev)}
                        className={`${baseButtonStyle} bg-slate-700 hover:bg-slate-600`}
                        title="Reacciones"
                    >
                        <PartyPopper size={20} />
                    </button>
                    {isEmojiPickerOpen && (
                        <div className="absolute bottom-16 right-0 w-60 p-2 bg-white rounded-lg shadow-2xl flex flex-wrap gap-2 animate-fade-in-up">
                            {emojis.map((emoji) => (
                                <button
                                    key={emoji}
                                    onClick={() => handleSendReaction(emoji)}
                                    className="p-2 text-xl rounded-full hover:bg-gray-200 transition-colors duration-200"
                                >
                                    {emoji}
                                </button>
                            ))}
                        </div>
                    )}
                </div>
                <button
                    onClick={onLeave}
                    className="flex items-center px-6 py-2 bg-red-600 text-white rounded-full font-semibold shadow-lg hover:bg-red-700 transition-colors duration-200"
                    title="Salir de la sala"
                >
                    <X className="mr-2" size={16} />
                    Salir
                </button>
            </div>
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
        <aside className={`fixed top-0 right-0 h-full w-full max-w-sm bg-gray-900 text-white shadow-2xl transform transition-transform duration-300 ease-in-out flex flex-col z-10 ${isOpen ? 'translate-x-0' : 'translate-x-full'}`}>
            <header className="flex items-center justify-between p-4 bg-gray-800 border-b border-gray-700">
                <h2 className="text-xl font-bold">Chat de la Sala</h2>
                <button onClick={onClose} className="p-2 rounded-full text-white hover:bg-gray-700 transition-colors duration-200">
                    <X size={20} />
                </button>
            </header>
            <div className="flex-1 p-4 overflow-y-auto space-y-4">
                {chatMessages.map((msg) => {
                    if (msg.type === 'system') {
                        return <div key={msg.id} className="text-center text-gray-400 text-sm italic">{msg.text}</div>;
                    }
                    const isMe = msg.user === currentUserName;
                    return (
                        <div key={msg.id} className={`flex ${isMe ? 'justify-end' : 'justify-start'}`}>
                            <div className={`p-3 rounded-xl max-w-xs break-words ${isMe ? 'bg-blue-600 rounded-br-none' : 'bg-gray-700 rounded-bl-none'}`}>
                                {!isMe && <div className="text-sm font-semibold text-gray-300 mb-1">{msg.user}</div>}
                                <p className="text-sm">{msg.text}</p>
                            </div>
                        </div>
                    );
                })}
                <div ref={messagesEndRef} />
            </div>
            <form onSubmit={handleSend} className="p-4 bg-gray-800 border-t border-gray-700 flex">
                <input
                    type="text"
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    className="flex-1 p-2 rounded-full bg-gray-700 text-white border border-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-400"
                    placeholder="Escribe un mensaje..."
                />
                <button type="submit" className="ml-2 p-2 bg-blue-600 text-white rounded-full hover:bg-blue-700 transition-colors duration-200">
                    <Send size={18} />
                </button>
            </form>
        </aside>
    );
};

const CallRoom = ({ onLeave }) => {
    const [isChatOpen, setIsChatOpen] = useState(false);
    return (
        <div className="flex h-screen bg-gray-950 text-white">
            <main className="flex-1 flex flex-col items-center justify-between">
                <header className="p-4 w-full text-center">
                    <h1 className="text-2xl font-bold text-gray-100">Sala de Videollamada</h1>
                </header>
                <div className="flex-1 flex w-full h-full p-4">
                    <VideoGrid />
                </div>
                <Controls onToggleChat={() => setIsChatOpen(o => !o)} onLeave={onLeave} />
            </main>
            <ChatSidebar isOpen={isChatOpen} onClose={() => setIsChatOpen(false)} />
            <ToastContainer position="bottom-right" />
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
                // Solicitar permisos para acceder a los dispositivos
                const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
                stream.getTracks().forEach(track => track.stop()); // Detener los tracks después de obtener permisos
                
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
        <div className="flex items-center justify-center min-h-screen bg-gray-950 text-white p-4">
            <div className="w-full max-w-md bg-gray-900 rounded-xl shadow-2xl p-8">
                <h1 className="text-3xl font-extrabold text-center text-blue-500 mb-6">Unirse a la Sala</h1>
                <form onSubmit={handleSubmit} className="space-y-6">
                    <div className="relative">
                        <label htmlFor="userName" className="block text-sm font-medium text-gray-300">Tu nombre</label>
                        <input
                            id="userName"
                            type="text"
                            value={userName}
                            onChange={(e) => setUserName(e.target.value)}
                            placeholder="Ingresa tu nombre"
                            className="mt-1 block w-full px-4 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                    </div>
                    {isLoading ? (
                        <div className="text-center text-gray-400">Cargando dispositivos...</div>
                    ) : (
                        <>
                            {videoDevices.length > 0 && (
                                <div className="relative">
                                    <label htmlFor="videoDevice" className="block text-sm font-medium text-gray-300">Cámara</label>
                                    <select
                                        id="videoDevice"
                                        value={selectedVideo}
                                        onChange={(e) => setSelectedVideo(e.target.value)}
                                        className="mt-1 block w-full px-4 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                                    >
                                        {videoDevices.map(d => <option key={d.deviceId} value={d.deviceId}>{d.label || `Cámara ${d.deviceId}`}</option>)}
                                    </select>
                                </div>
                            )}
                            {audioDevices.length > 0 && (
                                <div className="relative">
                                    <label htmlFor="audioDevice" className="block text-sm font-medium text-gray-300">Micrófono</label>
                                    <select
                                        id="audioDevice"
                                        value={selectedAudio}
                                        onChange={(e) => setSelectedAudio(e.target.value)}
                                        className="mt-1 block w-full px-4 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                                    >
                                        {audioDevices.map(d => <option key={d.deviceId} value={d.deviceId}>{d.label || `Micrófono ${d.deviceId}`}</option>)}
                                    </select>
                                </div>
                            )}
                            {audioOutputs.length > 0 && (
                                <div className="relative">
                                    <label htmlFor="audioOutputDevice" className="block text-sm font-medium text-gray-300">Salida de Audio</label>
                                    <select
                                        id="audioOutputDevice"
                                        value={selectedAudioOutput}
                                        onChange={(e) => setSelectedAudioOutput(e.target.value)}
                                        className="mt-1 block w-full px-4 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                                    >
                                        {audioOutputs.map(d => <option key={d.deviceId} value={d.deviceId}>{d.label || `Altavoces ${d.deviceId}`}</option>)}
                                    </select>
                                </div>
                            )}
                        </>
                    )}
                    <button
                        type="submit"
                        disabled={!userName.trim() || isLoading}
                        className="w-full flex items-center justify-center px-6 py-3 bg-blue-600 text-white font-bold rounded-lg shadow-lg hover:bg-blue-700 transition-colors duration-200 disabled:bg-gray-700 disabled:cursor-not-allowed"
                    >
                        <LogIn className="mr-2" size={20} />
                        Unirse
                    </button>
                </form>
            </div>
        </div>
    );
};

// Componente principal de la aplicación
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
            </WebRTCContext.Provider>
        );
    }
}
