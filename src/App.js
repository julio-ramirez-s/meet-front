import React, { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import Peer from 'peerjs';

// En un entorno real, instalarías estas bibliotecas.
// Para este documento, las importaciones se mantienen por claridad, pero el código
// asume que están disponibles globalmente o en tu entorno de desarrollo.

// Iconos SVG en línea para reemplazar lucide-react y hacer el código autocontenido.
const MicIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-mic">
    <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
    <line x1="12" x2="12" y1="19" y2="22" />
  </svg>
);
const MicOffIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-mic-off">
    <line x1="2" x2="22" y1="2" y2="22" />
    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
    <path d="M12 19v3" />
    <path d="M15 9.34V5a3 3 0 0 0-5.636-1.34" />
    <path d="M9 10.7A3 3 0 0 0 12 13v-2" />
  </svg>
);
const VideoIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-video">
    <path d="m22 8-6 4 6 4V8Z" />
    <rect width="14" height="12" x="2" y="6" rx="2" ry="2" />
  </svg>
);
const VideoOffIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-video-off">
    <path d="M10.66 6H14a2 2 0 0 1 2 2v2.34l-3.34 2.89" />
    <path d="M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2.34" />
    <path d="m10 16 2-2 6 4V8l-6-4-2 2" />
    <line x1="2" x2="22" y1="2" y2="22" />
  </svg>
);
const ScreenShareIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-screen-share">
    <path d="M13 3H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8" />
    <path d="m19 7-4 4-4-4" />
    <path d="M15 11V3" />
  </svg>
);
const XIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-x">
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </svg>
);
const MessageSquareIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-message-square">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </svg>
);
const SendIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-send">
    <path d="m22 2-7 20-4-9-9-4 20-7Z" />
    <path d="M22 2 11 13" />
  </svg>
);
const LogInIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-log-in">
    <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
    <polyline points="10 17 15 12 10 7" />
    <line x1="15" x2="3" y1="12" y2="12" />
  </svg>
);
const ChevronLeftIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-chevron-left">
    <path d="m15 18-6-6 6-6" />
  </svg>
);
const ChevronRightIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-chevron-right">
    <path d="m9 18 6-6-6-6" />
  </svg>
);


// Componente para renderizar la tarjeta de video
const VideoComponent = ({ stream, muted, userName, isScreenShare = false }) => {
  const ref = useRef();
  useEffect(() => {
    if (stream && ref.current) {
      ref.current.srcObject = stream;
    }
  }, [stream]);

  const videoClasses = `w-full h-full object-cover ${!isScreenShare ? 'transform scale-x-[-1]' : ''}`;

  return (
    <div className="relative aspect-video bg-gray-900 rounded-xl overflow-hidden shadow-xl border border-gray-700">
      <video
        ref={ref}
        playsInline
        autoPlay
        muted={muted}
        className={videoClasses}
      />
      <div className="absolute bottom-3 left-3 bg-gray-900 bg-opacity-70 text-white text-sm px-3 py-1 rounded-full font-semibold">
        {userName}
        {isScreenShare && <span className="ml-2 text-yellow-300"> (Pantalla)</span>}
      </div>
    </div>
  );
};

// Componente principal de la aplicación
export default function App() {
  const [roomId] = useState('main-room');
  const [myStream, setMyStream] = useState(null);
  const [peerStreams, setPeerStreams] = useState([]);
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoOff, setIsVideoOff] = useState(false);
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [isJoined, setIsJoined] = useState(false);
  const [isLoadingDevices, setIsLoadingDevices] = useState(true);
  const [videoDevices, setVideoDevices] = useState([]);
  const [audioDevices, setAudioDevices] = useState([]);
  const [selectedVideoDeviceId, setSelectedVideoDeviceId] = useState('');
  const [selectedAudioDeviceId, setSelectedAudioDeviceId] = useState('');
  const [chatMessages, setChatMessages] = useState([]);
  const [message, setMessage] = useState('');
  const [userName, setUserName] = useState('');
  const [peerUserNames, setPeerUserNames] = useState({});
  const [myScreenStream, setMyScreenStream] = useState(null);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  
  const socketRef = useRef();
  const myPeerRef = useRef();
  const chatMessagesRef = useRef();
  const peersRef = useRef({});

  // Efecto para enumerar los dispositivos de audio y video disponibles
  useEffect(() => {
    const getDevices = async () => {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoInputs = devices.filter(device => device.kind === 'videoinput');
        const audioInputs = devices.filter(device => device.kind === 'audioinput');
        setVideoDevices(videoInputs);
        setAudioDevices(audioInputs);
        if (videoInputs.length > 0) setSelectedVideoDeviceId(videoInputs[0].deviceId);
        if (audioInputs.length > 0) setSelectedAudioDeviceId(audioInputs[0].deviceId);
      } catch (err) {
        console.error("Error al enumerar dispositivos:", err);
      } finally {
        setIsLoadingDevices(false);
      }
    };
    getDevices();
  }, []);

  // Efecto para inicializar la conexión con el servidor y PeerJS
  useEffect(() => {
    if (!isJoined) return;
    
    // URL del servidor. Debes reemplazar esto con la URL de tu propio servidor.
    const SERVER_URL = "https://meet-clone-v0ov.onrender.com"; // Ejemplo
    
    const initializeCall = async () => {
      try {
        // Obtener el stream local del usuario
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { deviceId: selectedVideoDeviceId ? { exact: selectedVideoDeviceId } : undefined },
          audio: { deviceId: selectedAudioDeviceId ? { exact: selectedAudioDeviceId } : undefined }
        });
        
        setMyStream(stream);
        
        // Inicializar Socket.io y PeerJS
        const socket = io(SERVER_URL);
        const peer = new Peer(undefined, {
          host: new URL(SERVER_URL).hostname,
          port: new URL(SERVER_URL).port || (new URL(SERVER_URL).protocol === 'https:' ? 443 : 80),
          path: '/peerjs/myapp',
          secure: new URL(SERVER_URL).protocol === 'https:'
        });

        socketRef.current = socket;
        myPeerRef.current = peer;

        // PeerJS: Cuando se abre la conexión
        peer.on('open', id => {
          console.log('Mi ID de Peer es: ' + id);
          socket.emit('join-room', roomId, id, userName);
        });

        // PeerJS: Cuando alguien me llama
        peer.on('call', call => {
          console.log('Recibiendo llamada de: ' + call.peer);
          call.answer(stream);
          call.on('stream', userVideoStream => {
            console.log('Stream recibido de: ' + call.peer);
            setPeerStreams(prev => {
              // Prevenir duplicados del mismo stream
              if (prev.some(p => p.stream.id === userVideoStream.id)) return prev;
              
              const isScreen = userVideoStream.getVideoTracks()[0]?.label.includes('screen');
              return [...prev, { stream: userVideoStream, peerId: call.peer, isScreenShare: isScreen }];
            });
          });
          call.on('close', () => {
            console.log('Conexión cerrada con: ' + call.peer);
            setPeerStreams(prev => prev.filter(p => p.peerId !== call.peer));
          });
          peersRef.current = { ...peersRef.current, [call.peer]: call };
        });
        
        // Socket.io: Cuando un nuevo usuario se une
        socket.on('user-joined', ({ userId, userName: remoteUserName }) => {
          console.log('Nuevo usuario se unió: ' + remoteUserName + ' (' + userId + ')');
          setChatMessages(prev => [...prev, { user: 'Sistema', text: `${remoteUserName} se ha unido.`, id: Date.now() }]);
          setPeerUserNames(prev => ({ ...prev, [userId]: remoteUserName }));
          // Conectar al nuevo usuario
          const call = peer.call(userId, stream);
          call.on('stream', userVideoStream => {
            setPeerStreams(prev => {
                if (prev.some(p => p.stream.id === userVideoStream.id)) return prev;
                const isScreen = userVideoStream.getVideoTracks()[0]?.label.includes('screen');
                return [...prev, { stream: userVideoStream, peerId: userId, isScreenShare: isScreen }];
            });
          });
          call.on('close', () => {
            setPeerStreams(prev => prev.filter(p => p.peerId !== userId));
          });
          peersRef.current = { ...peersRef.current, [userId]: call };
        });

        // Socket.io: Recibir lista de usuarios existentes y conectar
        socket.on('all-users', (existingUsers) => {
          console.log('Usuarios existentes en la sala:', existingUsers);
          existingUsers.forEach(user => {
            if (user.userId !== peer.id) {
              setPeerUserNames(prev => ({ ...prev, [user.userId]: user.userName }));
              const call = peer.call(user.userId, stream);
              call.on('stream', userVideoStream => {
                  setPeerStreams(prev => {
                      if (prev.some(p => p.stream.id === userVideoStream.id)) return prev;
                      const isScreen = userVideoStream.getVideoTracks()[0]?.label.includes('screen');
                      return [...prev, { stream: userVideoStream, peerId: user.userId, isScreenShare: isScreen }];
                  });
              });
              call.on('close', () => {
                  setPeerStreams(prev => prev.filter(p => p.peerId !== user.userId));
              });
              peersRef.current = { ...peersRef.current, [user.userId]: call };
            }
          });
        });

        // Socket.io: Cuando un usuario se desconecta
        socket.on('user-disconnected', (userId, disconnectedUserName) => {
          console.log('Usuario desconectado: ' + disconnectedUserName + ' (' + userId + ')');
          setChatMessages(prev => [...prev, { user: 'Sistema', text: `${disconnectedUserName} se ha ido.`, id: Date.now() }]);
          if (peersRef.current[userId]) {
            peersRef.current[userId].close();
            const { [userId]: removedPeer, ...newPeers } = peersRef.current;
            peersRef.current = newPeers;
          }
          setPeerStreams(prev => prev.filter(p => p.peerId !== userId));
        });

        // Socket.io: Recibir mensajes de chat
        socket.on('createMessage', (message, user) => {
          setChatMessages(prev => [...prev, { user, text: message, id: Date.now() }]);
        });
        
      } catch (err) {
        console.error("Error al obtener el stream local", err);
      }
    };
    
    initializeCall();

    // Función de limpieza al desmontar el componente
    return () => {
      if (socketRef.current) socketRef.current.disconnect();
      if (myPeerRef.current) myPeerRef.current.destroy();
    };
  }, [isJoined, roomId, userName, selectedVideoDeviceId, selectedAudioDeviceId]);
  
  // Efecto para hacer scroll automático en el chat
  useEffect(() => {
    if (chatMessagesRef.current) {
      chatMessagesRef.current.scrollTop = chatMessagesRef.current.scrollHeight;
    }
  }, [chatMessages, isChatOpen]);
  
  // Manejador para enviar mensajes de chat
  const handleSendMessage = (e) => {
    e.preventDefault();
    if (message.trim() && userName && socketRef.current) {
      socketRef.current.emit('message', message, userName);
      setMessage('');
    }
  };

  // Funciones para alternar micrófono, video y compartir pantalla
  const toggleMute = () => {
    if (myStream) {
      const audioTrack = myStream.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        setIsMuted(!audioTrack.enabled);
      }
    }
  };

  const toggleVideo = () => {
    if (myStream) {
      const videoTrack = myStream.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.enabled = !videoTrack.enabled;
        setIsVideoOff(!videoTrack.enabled);
      }
    }
  };

  const shareScreen = async () => {
    try {
      if (isScreenSharing) {
        // Detener pantalla compartida
        if (myScreenStream) {
          myScreenStream.getTracks().forEach(track => track.stop());
          setMyScreenStream(null);
          setIsScreenSharing(false);
          // Eliminar el stream de la lista local
          setPeerStreams(prev => prev.filter(p => p.stream.id !== myScreenStream.id));
        }
        return;
      }
      
      const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      setMyScreenStream(screenStream);
      setIsScreenSharing(true);
      
      // Agregar el stream de la pantalla compartida a los peers
      for (const peerId in peersRef.current) {
        const call = peersRef.current[peerId];
        // Enviar el nuevo stream
        myPeerRef.current.call(peerId, screenStream);
      }
      
      // Manejar la finalización de la pantalla compartida por el usuario
      screenStream.getVideoTracks()[0].onended = () => {
        setMyScreenStream(null);
        setIsScreenSharing(false);
        // Eliminar el stream de la pantalla de la lista local
        setPeerStreams(prev => prev.filter(p => p.stream.id !== screenStream.id));
      };
      
    } catch (err) {
      console.error("Error al compartir la pantalla:", err);
    }
  };

  // Manejador para unirse a la llamada
  const handleJoinCall = (e) => {
    e.preventDefault();
    if (userName.trim()) {
      setIsJoined(true);
    }
  };

  // Renderizar la pantalla de inicio si el usuario no se ha unido
  if (!isJoined) {
    return (
      <div className="flex flex-col items-center justify-center h-screen bg-gray-950 text-white font-sans p-4">
        <form onSubmit={handleJoinCall} className="bg-gray-900 p-8 md:p-12 rounded-2xl shadow-2xl w-full max-w-lg space-y-6">
          <h1 className="text-4xl font-extrabold text-center text-blue-500 mb-6">Únete a la Llamada</h1>
          <div className="space-y-4">
            <div>
              <label htmlFor="userName" className="block text-sm font-medium text-gray-300">Tu nombre</label>
              <input
                id="userName"
                type="text"
                value={userName}
                onChange={(e) => setUserName(e.target.value)}
                placeholder="Ingresa tu nombre"
                className="w-full mt-1 p-3 bg-gray-700 text-white rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            {isLoadingDevices ? (
              <div className="text-center text-gray-400">Cargando dispositivos...</div>
            ) : (
              <>
                {videoDevices.length > 0 && (
                  <div>
                    <label htmlFor="videoDevice" className="block text-sm font-medium text-gray-300">Cámara</label>
                    <select
                      id="videoDevice"
                      value={selectedVideoDeviceId}
                      onChange={(e) => setSelectedVideoDeviceId(e.target.value)}
                      className="w-full mt-1 p-3 bg-gray-700 text-white rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      {videoDevices.map(device => (
                        <option key={device.deviceId} value={device.deviceId}>{device.label}</option>
                      ))}
                    </select>
                  </div>
                )}
                {audioDevices.length > 0 && (
                  <div>
                    <label htmlFor="audioDevice" className="block text-sm font-medium text-gray-300">Micrófono</label>
                    <select
                      id="audioDevice"
                      value={selectedAudioDeviceId}
                      onChange={(e) => setSelectedAudioDeviceId(e.target.value)}
                      className="w-full mt-1 p-3 bg-gray-700 text-white rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      {audioDevices.map(device => (
                        <option key={device.deviceId} value={device.deviceId}>{device.label}</option>
                      ))}
                    </select>
                  </div>
                )}
              </>
            )}
          </div>
          <button
            type="submit"
            disabled={!userName.trim() || isLoadingDevices}
            className="w-full flex items-center justify-center p-3 text-lg font-semibold rounded-lg bg-blue-600 hover:bg-blue-500 transition-colors duration-200 disabled:bg-gray-500 disabled:cursor-not-allowed"
          >
            <LogInIcon className="mr-2" />
            Unirse a la Llamada
          </button>
        </form>
      </div>
    );
  }

  // Renderizar la interfaz de la videollamada
  const videoElements = [
    myStream && <VideoComponent key="my-video" stream={myStream} muted={true} userName={userName} />,
    ...peerStreams.map((peer) => (
      <VideoComponent key={peer.stream.id} stream={peer.stream} userName={peerUserNames[peer.peerId] || peer.peerId} isScreenShare={peer.isScreenShare} />
    ))
  ].filter(Boolean);

  const gridClass = videoElements.length > 2 ? `grid-cols-1 md:grid-cols-2 lg:grid-cols-3` : `grid-cols-1 md:grid-cols-${videoElements.length}`;

  return (
    <div className="flex h-screen bg-gray-950 text-white font-sans overflow-hidden">
      <main className={`flex flex-col flex-grow relative transition-all duration-300 ease-in-out`}>
        <div id="video-grid" className={`flex-grow grid ${gridClass} gap-4 p-4 md:p-8 overflow-y-auto`}>
          {videoElements}
        </div>
        <footer className="bg-gray-900 p-4 flex justify-center items-center flex-wrap space-x-2 md:space-x-4 sticky bottom-0">
          <button
            onClick={toggleMute}
            className={`px-4 py-2 rounded-full text-xs md:text-base transition-colors duration-200 shadow-md flex items-center justify-center space-x-2 ${isMuted ? 'bg-red-600 hover:bg-red-500' : 'bg-gray-700 hover:bg-gray-600'}`}
          >
            {isMuted ? <MicOffIcon /> : <MicIcon />}
            <span className="hidden md:inline">{isMuted ? 'Activar' : 'Silenciar'}</span>
          </button>
          <button
            onClick={toggleVideo}
            className={`px-4 py-2 rounded-full text-xs md:text-base transition-colors duration-200 shadow-md flex items-center justify-center space-x-2 ${isVideoOff ? 'bg-red-600 hover:bg-red-500' : 'bg-gray-700 hover:bg-gray-600'}`}
          >
            {isVideoOff ? <VideoOffIcon /> : <VideoIcon />}
            <span className="hidden md:inline">{isVideoOff ? 'Activar' : 'Detener'}</span>
          </button>
          <button
            onClick={shareScreen}
            className={`px-4 py-2 rounded-full text-xs md:text-base transition-colors duration-200 shadow-md flex items-center justify-center space-x-2 ${isScreenSharing ? 'bg-green-600 hover:bg-green-500' : 'bg-blue-600 hover:bg-blue-500'}`}
          >
            {isScreenSharing ? <XIcon /> : <ScreenShareIcon />}
            <span className="hidden md:inline">{isScreenSharing ? 'Dejar de compartir' : 'Compartir Pantalla'}</span>
          </button>
          <button
            onClick={() => setIsChatOpen(!isChatOpen)}
            className={`px-4 py-2 rounded-full text-xs md:text-base transition-colors duration-200 shadow-md flex items-center justify-center space-x-2 ${isChatOpen ? 'bg-indigo-600 hover:bg-indigo-500' : 'bg-gray-700 hover:bg-gray-600'}`}
          >
            <MessageSquareIcon />
            <span className="hidden md:inline">Chat</span>
            <span className="md:hidden">{isChatOpen ? <ChevronRightIcon size={16} /> : <ChevronLeftIcon size={16} />}</span>
          </button>
        </footer>
      </main>
      
      {/* Sidebar para el chat, se muestra/oculta en móviles */}
      <aside className={`fixed top-0 right-0 h-full w-full md:w-96 bg-gray-900 flex flex-col transform transition-transform duration-300 ease-in-out z-50 ${isChatOpen ? 'translate-x-0' : 'translate-x-full md:translate-x-0'}`}>
        <div className="p-4 flex items-center justify-between border-b border-gray-700 bg-gray-900">
          <h2 className="text-xl font-bold">Chat</h2>
          <button onClick={() => setIsChatOpen(false)} className="md:hidden text-white hover:text-gray-400 p-2 rounded-full hover:bg-gray-700">
            <XIcon size={20} />
          </button>
        </div>
        <div ref={chatMessagesRef} className="flex-grow p-4 overflow-y-auto custom-scrollbar">
          <div className="space-y-4 text-sm">
            {chatMessages.map((msg) => (
              <div key={msg.id} className="flex flex-col">
                <span className="font-semibold text-blue-400 text-xs">{msg.user}:</span>
                <span className="break-words text-gray-200 text-sm">{msg.text}</span>
              </div>
            ))}
          </div>
        </div>
        <form onSubmit={handleSendMessage} className="p-4 border-t border-gray-700 flex space-x-2 bg-gray-900">
          <input
            type="text"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            className="flex-grow p-3 bg-gray-800 rounded-lg focus:outline-none text-white placeholder-gray-400 border border-gray-700"
            placeholder="Escribe un mensaje..."
          />
          <button type="submit" className="bg-blue-600 hover:bg-blue-500 p-3 rounded-lg text-white transition-colors duration-200">
            <SendIcon size={20} />
          </button>
        </form>
      </aside>
    </div>
  );
}
