import React, { useState, useEffect, useRef, createContext, useContext } from 'react';
import { Mic, MicOff, Video, VideoOff, ScreenShare, MessageSquare, Send, X, LogIn, Settings, Users, ArrowLeft } from 'lucide-react';
import { io } from 'socket.io-client';
import Peer from 'peerjs';

// --- CONTEXTO PARA WEBRTC ---
// Usamos un Contexto para evitar pasar props por muchos niveles (prop drilling)
const WebRTCContext = createContext();
const useWebRTC = () => useContext(WebRTCContext);

// --- HOOK PERSONALIZADO PARA LA LÓGICA DE WEBRTC ---
// Encapsula toda la lógica de Socket.IO y PeerJS para mantener los componentes limpios.
const useWebRTCLogic = (roomId, userName) => {
    const [myStream, setMyStream] = useState(null);
    const [myScreenStream, setMyScreenStream] = useState(null);
    const [peers, setPeers] = useState({}); // Almacena streams de otros { peerId: { stream, userName, isScreenShare } }
    const [chatMessages, setChatMessages] = useState([]);
    const [isMuted, setIsMuted] = useState(false);
    const [isVideoOff, setIsVideoOff] = useState(false);
    
    const socketRef = useRef(null);
    const myPeerRef = useRef(null);
    const peerConnections = useRef({}); // Referencia a las conexiones activas de PeerJS

    // Función para limpiar todas las conexiones y streams
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
    };

    // Inicializa el stream local del usuario
    const initializeStream = async (audioDeviceId, videoDeviceId) => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: { deviceId: videoDeviceId ? { exact: videoDeviceId } : undefined },
                audio: { deviceId: audioDeviceId ? { exact: audioDeviceId } : undefined }
            });
            setMyStream(stream);
            return stream;
        } catch (error) {
            console.error("Error al obtener stream de usuario:", error);
            alert("No se pudo acceder a la cámara o micrófono. Por favor, revisa los permisos.");
            return null;
        }
    };
    
    // Conecta al servidor de señalización y a PeerJS
    const connect = (stream) => {
        // URL del servidor de señalización (debería estar en una variable de entorno)
        const SERVER_URL = "https://meet-clone-v0ov.onrender.com"; // Reemplaza con tu servidor desplegado

        socketRef.current = io(SERVER_URL);
        myPeerRef.current = new Peer(undefined, {
            host: new URL(SERVER_URL).hostname,
            port: new URL(SERVER_URL).port || 443,
            path: '/peerjs/myapp',
            secure: true,
        });

        myPeerRef.current.on('open', (peerId) => {
            console.log('Mi ID de Peer es: ' + peerId);
            socketRef.current.emit('join-room', roomId, peerId, userName);
        });

        // Escucha llamadas entrantes
        myPeerRef.current.on('call', (call) => {
            const { peer: peerId, metadata } = call;
            console.log(`Recibiendo llamada de ${peerId} con metadata:`, metadata);
            
            // Responde con el stream correspondiente (cámara o pantalla)
            const streamToSend = metadata.isScreenShare ? myScreenStream : myStream;
            if(streamToSend) {
                call.answer(streamToSend);
            } else {
                 call.answer(stream); // Fallback al stream principal
            }

            call.on('stream', (remoteStream) => {
                console.log(`Stream recibido de: ${peerId}`);
                setPeers(prev => ({
                    ...prev,
                    [peerId + (metadata.isScreenShare ? '_screen' : '')]: { 
                        stream: remoteStream, 
                        userName: metadata.userName,
                        isScreenShare: metadata.isScreenShare 
                    }
                }));
            });
            
            call.on('close', () => {
                console.log(`Llamada cerrada con ${peerId}`);
                removePeer(peerId, metadata.isScreenShare);
            });

            peerConnections.current[peerId + (metadata.isScreenShare ? '_screen' : '')] = call;
        });

        socketRef.current.on('user-joined', ({ userId, userName: remoteUserName }) => {
            console.log(`Usuario ${remoteUserName} (${userId}) se unió.`);
            setChatMessages(prev => [...prev, { type: 'system', text: `${remoteUserName} se ha unido.`, id: Date.now() }]);
            connectToNewUser(userId, remoteUserName, stream);
        });

        socketRef.current.on('user-disconnected', (userId, disconnectedUserName) => {
            console.log(`Usuario ${disconnectedUserName} (${userId}) se desconectó.`);
            setChatMessages(prev => [...prev, { type: 'system', text: `${disconnectedUserName} se ha ido.`, id: Date.now() }]);
            removePeer(userId, false);
            removePeer(userId, true); // También elimina su posible pantalla compartida
        });
        
        socketRef.current.on('createMessage', (message, user) => {
            setChatMessages(prev => [...prev, { user, text: message, id: Date.now(), type: 'chat' }]);
        });
    };

    const connectToNewUser = (peerId, remoteUserName, stream) => {
        console.log(`Llamando a ${remoteUserName} (${peerId})`);
        if (!myPeerRef.current) return;

        // Llamada con el stream de la cámara
        const call = myPeerRef.current.call(peerId, stream, { metadata: { userName, isScreenShare: false } });
        
        call.on('stream', (remoteStream) => {
            console.log(`Stream de cámara recibido de ${remoteUserName} (${peerId})`);
            setPeers(prev => ({ ...prev, [peerId]: { stream: remoteStream, userName: remoteUserName, isScreenShare: false } }));
        });
        
        call.on('close', () => {
            console.log(`Llamada con ${peerId} (cámara) cerrada.`);
            removePeer(peerId, false);
        });

        peerConnections.current[peerId] = call;
    };

    const removePeer = (peerId, isScreenShare) => {
        const key = peerId + (isScreenShare ? '_screen' : '');
        if (peerConnections.current[key]) {
            peerConnections.current[key].close();
            delete peerConnections.current[key];
        }
        setPeers(prev => {
            const newPeers = { ...prev };
            delete newPeers[key];
            return newPeers;
        });
    };

    // --- Funciones de control ---
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

    const shareScreen = async () => {
        if (myScreenStream) { // Si ya se está compartiendo, detener
            myScreenStream.getTracks().forEach(track => track.stop());
            socketRef.current.emit('stop-screen-share');
            setMyScreenStream(null);
            Object.keys(peerConnections.current).forEach(key => {
                if (key.endsWith('_screen')) {
                    removePeer(key.replace('_screen', ''), true);
                }
            });
            return;
        }

        try {
            const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
            setMyScreenStream(screenStream);

            screenStream.getVideoTracks()[0].onended = () => { // Cuando el usuario detiene desde el navegador
                setMyScreenStream(null);
                socketRef.current.emit('stop-screen-share');
                 Object.keys(peerConnections.current).forEach(key => {
                    if (key.endsWith('_screen')) {
                        removePeer(key.replace('_screen', ''), true);
                    }
                });
            };

            Object.keys(peerConnections.current).forEach(peerKey => {
                const peerId = peerKey.split('_')[0];
                if(peerConnections.current[peerId]){
                    console.log(`Enviando pantalla a ${peerId}`);
                    const call = myPeerRef.current.call(peerId, screenStream, { metadata: { userName, isScreenShare: true } });
                    peerConnections.current[peerId + '_screen'] = call;
                }
            });

        } catch (err) {
            console.error("Error al compartir pantalla:", err);
        }
    };

    return {
        myStream, myScreenStream, peers, chatMessages, isMuted, isVideoOff,
        initializeStream, connect, cleanup,
        toggleMute, toggleVideo, sendMessage, shareScreen
    };
};

// --- COMPONENTES DE LA UI ---

const VideoPlayer = ({ stream, userName, muted = false, isScreenShare = false, isLocal = false }) => {
    const videoRef = useRef();
    useEffect(() => {
        if (stream) {
            videoRef.current.srcObject = stream;
        }
    }, [stream]);

    return (
        <div className="relative aspect-video bg-slate-800 rounded-lg overflow-hidden shadow-lg border-2 border-slate-700">
            <video
                ref={videoRef}
                playsInline
                autoPlay
                muted={muted}
                className={`w-full h-full object-cover ${isLocal && !isScreenShare ? 'transform scale-x-[-1]' : ''}`}
            />
            <div className="absolute bottom-2 left-2 bg-black bg-opacity-50 text-white text-xs px-2 py-1 rounded-md font-medium">
                {userName} {isScreenShare && "(Pantalla)"}
            </div>
        </div>
    );
};

const VideoGrid = () => {
    const { myStream, myScreenStream, peers, userName } = useWebRTC();
    
    const videoElements = [
        myStream && { id: 'my-video', stream: myStream, userName: `${userName} (Tú)`, isLocal: true, muted: true },
        myScreenStream && { id: 'my-screen', stream: myScreenStream, userName: `${userName} (Tú)`, isLocal: true, isScreenShare: true, muted: true },
        ...Object.entries(peers).map(([key, { stream, userName, isScreenShare }]) => ({
            id: key, stream, userName, isScreenShare
        }))
    ].filter(Boolean);

    const gridLayout = (count) => {
        if (count <= 1) return 'grid-cols-1';
        if (count <= 2) return 'grid-cols-1 md:grid-cols-2';
        if (count <= 4) return 'grid-cols-2';
        if (count <= 6) return 'grid-cols-2 lg:grid-cols-3';
        return 'grid-cols-2 md:grid-cols-3 lg:grid-cols-4';
    };

    return (
        <div className={`grid ${gridLayout(videoElements.length)} gap-4 p-4 flex-grow overflow-y-auto`}>
            {videoElements.map(v => (
                <VideoPlayer key={v.id} {...v} />
            ))}
        </div>
    );
};

const Controls = ({ onToggleChat, onLeave }) => {
    const { toggleMute, toggleVideo, shareScreen, isMuted, isVideoOff, myScreenStream } = useWebRTC();
    return (
        <footer className="bg-slate-900/80 backdrop-blur-sm p-3 flex justify-center items-center space-x-2 sm:space-x-4">
            <button onClick={toggleMute} className={`p-3 rounded-full transition-colors ${isMuted ? 'bg-red-500 text-white' : 'bg-slate-700 hover:bg-slate-600'}`}>
                {isMuted ? <MicOff size={20} /> : <Mic size={20} />}
            </button>
            <button onClick={toggleVideo} className={`p-3 rounded-full transition-colors ${isVideoOff ? 'bg-red-500 text-white' : 'bg-slate-700 hover:bg-slate-600'}`}>
                {isVideoOff ? <VideoOff size={20} /> : <Video size={20} />}
            </button>
            <button onClick={shareScreen} className={`p-3 rounded-full transition-colors ${myScreenStream ? 'bg-green-500 text-white' : 'bg-slate-700 hover:bg-slate-600'}`}>
                <ScreenShare size={20} />
            </button>
            <button onClick={onToggleChat} className="p-3 rounded-full bg-slate-700 hover:bg-slate-600">
                <MessageSquare size={20} />
            </button>
            <button onClick={onLeave} className="px-4 py-3 rounded-full bg-red-600 hover:bg-red-700 text-white font-semibold text-sm">
                Salir
            </button>
        </footer>
    );
};

const ChatSidebar = ({ isOpen, onClose }) => {
    const { chatMessages, sendMessage, userName } = useWebRTC();
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
        <aside className={`fixed top-0 right-0 h-full w-full sm:w-80 md:w-96 bg-slate-900 flex flex-col transform transition-transform duration-300 ease-in-out z-50 ${isOpen ? 'translate-x-0' : 'translate-x-full'}`}>
            <header className="p-4 flex items-center justify-between border-b border-slate-700">
                <h2 className="text-lg font-bold">Chat</h2>
                <button onClick={onClose} className="p-2 rounded-full hover:bg-slate-700">
                    <X size={20} />
                </button>
            </header>
            <div className="flex-grow p-4 overflow-y-auto space-y-4">
                {chatMessages.map((msg) => {
                    if (msg.type === 'system') {
                        return <div key={msg.id} className="text-center text-xs text-slate-400 italic">{msg.text}</div>;
                    }
                    const isMe = msg.user === userName;
                    return (
                        <div key={msg.id} className={`flex flex-col ${isMe ? 'items-end' : 'items-start'}`}>
                            <div className={`p-2 rounded-lg max-w-xs ${isMe ? 'bg-blue-600' : 'bg-slate-700'}`}>
                                {!isMe && <div className="text-xs font-bold text-blue-300">{msg.user}</div>}
                                <p className="text-sm break-words">{msg.text}</p>
                            </div>
                        </div>
                    );
                })}
                <div ref={messagesEndRef} />
            </div>
            <form onSubmit={handleSend} className="p-4 border-t border-slate-700 flex space-x-2">
                <input
                    type="text"
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    className="flex-grow p-2 bg-slate-800 rounded-lg focus:outline-none text-white placeholder-slate-400 border border-slate-700"
                    placeholder="Escribe un mensaje..."
                />
                <button type="submit" className="bg-blue-600 hover:bg-blue-500 p-3 rounded-lg text-white transition-colors">
                    <Send size={18} />
                </button>
            </form>
        </aside>
    );
};


const CallRoom = ({ onLeave }) => {
    const [isChatOpen, setIsChatOpen] = useState(false);
    return (
        <div className="flex h-screen bg-slate-950 text-white font-sans overflow-hidden">
            <main className="flex flex-col flex-grow relative">
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
    const [selectedVideo, setSelectedVideo] = useState('');
    const [selectedAudio, setSelectedAudio] = useState('');
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        const getDevices = async () => {
            try {
                // Pedir permiso para activar los dispositivos y poder listarlos
                await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
                const devices = await navigator.mediaDevices.enumerateDevices();
                const videoInputs = devices.filter(d => d.kind === 'videoinput');
                const audioInputs = devices.filter(d => d.kind === 'audioinput');
                setVideoDevices(videoInputs);
                setAudioDevices(audioInputs);
                if (videoInputs.length > 0) setSelectedVideo(videoInputs[0].deviceId);
                if (audioInputs.length > 0) setSelectedAudio(audioInputs[0].deviceId);
            } catch (err) {
                console.error("Error al enumerar dispositivos:", err);
                alert("No se pudo acceder a la cámara o micrófono. Por favor, verifica los permisos en tu navegador.");
            } finally {
                setIsLoading(false);
            }
        };
        getDevices();
    }, []);

    const handleSubmit = (e) => {
        e.preventDefault();
        if (userName.trim()) {
            onJoin(userName, selectedAudio, selectedVideo);
        }
    };

    return (
        <div className="flex flex-col items-center justify-center min-h-screen bg-slate-950 text-white p-4">
            <div className="w-full max-w-md">
                <div className="bg-slate-900 p-8 rounded-2xl shadow-2xl border border-slate-700">
                    <h1 className="text-3xl font-bold text-center text-blue-400 mb-6">Unirse a la Sala</h1>
                    <form onSubmit={handleSubmit} className="space-y-6">
                        <div>
                            <label htmlFor="userName" className="block text-sm font-medium text-slate-300 mb-1">Tu nombre</label>
                            <input
                                id="userName" type="text" value={userName}
                                onChange={(e) => setUserName(e.target.value)}
                                placeholder="Ingresa tu nombre"
                                className="w-full p-3 bg-slate-800 border border-slate-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                            />
                        </div>
                        {isLoading ? (
                            <div className="text-center text-slate-400">Cargando dispositivos...</div>
                        ) : (
                            <>
                                {videoDevices.length > 0 && (
                                    <div>
                                        <label htmlFor="videoDevice" className="block text-sm font-medium text-slate-300 mb-1">Cámara</label>
                                        <select id="videoDevice" value={selectedVideo} onChange={(e) => setSelectedVideo(e.target.value)}
                                            className="w-full p-3 bg-slate-800 border border-slate-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500">
                                            {videoDevices.map(d => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}
                                        </select>
                                    </div>
                                )}
                                {audioDevices.length > 0 && (
                                    <div>
                                        <label htmlFor="audioDevice" className="block text-sm font-medium text-slate-300 mb-1">Micrófono</label>
                                        <select id="audioDevice" value={selectedAudio} onChange={(e) => setSelectedAudio(e.target.value)}
                                            className="w-full p-3 bg-slate-800 border border-slate-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500">
                                            {audioDevices.map(d => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}
                                        </select>
                                    </div>
                                )}
                            </>
                        )}
                        <button type="submit" disabled={!userName.trim() || isLoading}
                            className="w-full flex items-center justify-center p-3 text-lg font-semibold rounded-lg bg-blue-600 hover:bg-blue-500 transition-colors disabled:bg-slate-500 disabled:cursor-not-allowed">
                            <LogIn className="mr-2" size={20} />
                            Unirse
                        </button>
                    </form>
                </div>
            </div>
        </div>
    );
};


// --- COMPONENTE PRINCIPAL DE LA APLICACIÓN ---
export default function App() {
    const [isJoined, setIsJoined] = useState(false);
    const [userName, setUserName] = useState('');
    const webRTCLogic = useWebRTCLogic('main-room', userName);

    const handleJoin = async (name, audioId, videoId) => {
        setUserName(name);
        const stream = await webRTCLogic.initializeStream(audioId, videoId);
        if (stream) {
            webRTCLogic.connect(stream);
            setIsJoined(true);
        }
    };

    const handleLeave = () => {
        webRTCLogic.cleanup();
        setIsJoined(false);
        setUserName('');
    };
    
    // Asegurarse de limpiar al cerrar la pestaña
    useEffect(() => {
        window.addEventListener('beforeunload', webRTCLogic.cleanup);
        return () => {
            window.removeEventListener('beforeunload', webRTCLogic.cleanup);
        };
    }, []);

    if (!isJoined) {
        return <Lobby onJoin={handleJoin} />;
    }

    return (
        <WebRTCContext.Provider value={{ ...webRTCLogic, userName }}>
            <CallRoom onLeave={handleLeave} />
        </WebRTCContext.Provider>
    );
}