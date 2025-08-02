import React, { useState, useEffect, useRef } from 'react';
import { Mic, MicOff, Video, VideoOff, ScreenShare, MessageSquare, Send, X, LogIn, ChevronRight, ChevronLeft } from 'lucide-react';
import { io } from 'socket.io-client';
import Peer from 'peerjs';
import './App.css';

// Componente para renderizar la tarjeta de video
const VideoComponent = ({ stream, muted, userName, isScreenShare = false }) => {
  const ref = useRef();
  useEffect(() => {
    if (stream && ref.current) {
      ref.current.srcObject = stream;
    }
  }, [stream]);

  // Si es una pantalla compartida, no voltear la imagen.
  const videoClasses = `w-full h-full object-cover ${isScreenShare ? '' : 'transform scale-x-[-1]'}`;

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
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  
  // Referencias para las conexiones
  const socketRef = useRef();
  const myPeerRef = useRef();
  const myScreenPeerRef = useRef(null);
  const myScreenStreamRef = useRef(null);
  const myLocalStreamRef = useRef(null);
  const chatMessagesRef = useRef();
  const peersRef = useRef({});
  const screenPeersRef = useRef({});

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

  // Efecto principal para la inicialización de la llamada
  useEffect(() => {
    if (!isJoined) return;

    const SERVER_URL = process.env.REACT_APP_SERVER_URL;

    // Función para conectar a un nuevo usuario
    const connectToNewUser = (userId, stream) => {
      if (peersRef.current[userId]) return;
      const call = myPeerRef.current.call(userId, stream);
      call.on('stream', userVideoStream => {
        setPeerStreams(prev => {
          if (prev.some(p => p.peerId === userId)) return prev;
          const streamUserName = peerUserNames[userId] || userId;
          return [...prev, { stream: userVideoStream, peerId: userId, isScreenShare: false, userName: streamUserName }];
        });
      });
      call.on('close', () => {
        setPeerStreams(prev => prev.filter(p => p.peerId !== userId));
      });
      peersRef.current = { ...peersRef.current, [userId]: call };
    };

    // Función para conectar al stream de pantalla de otro usuario
    const connectToScreenShare = (userId) => {
      const screenPeerId = `${userId}-screen`;
      if (screenPeersRef.current[userId]) return;
      const call = myPeerRef.current.call(screenPeerId, myLocalStreamRef.current);
      call.on('stream', userScreenStream => {
        console.log('Stream de pantalla recibido al unirse de: ' + screenPeerId);
        setPeerStreams(prev => {
          if (prev.some(p => p.peerId === screenPeerId)) return prev;
          const streamUserName = `${peerUserNames[userId] || userId} (Pantalla)`;
          return [...prev, { stream: userScreenStream, peerId: screenPeerId, isScreenShare: true, userName: streamUserName }];
        });
      });
      call.on('close', () => {
        setPeerStreams(prev => prev.filter(p => p.peerId !== screenPeerId));
      });
      screenPeersRef.current = { ...screenPeersRef.current, [userId]: call };
    };

    // Obtener el stream local y inicializar todo
    navigator.mediaDevices.getUserMedia({
      video: { deviceId: selectedVideoDeviceId ? { exact: selectedVideoDeviceId } : undefined },
      audio: { deviceId: selectedAudioDeviceId ? { exact: selectedAudioDeviceId } : undefined }
    }).then(stream => {
      myLocalStreamRef.current = stream;
      setMyStream(stream);
      
      socketRef.current = io(SERVER_URL);
      myPeerRef.current = new Peer(undefined, {
        host: new URL(SERVER_URL).hostname,
        port: new URL(SERVER_URL).port || (new URL(SERVER_URL).protocol === 'https:' ? 443 : 80),
        path: '/peerjs/myapp',
        secure: new URL(SERVER_URL).protocol === 'https:'
      });

      myPeerRef.current.on('open', id => {
        console.log('Mi ID de Peer es: ' + id);
        socketRef.current.emit('join-room', roomId, id, userName);
      });

      // Listener para llamadas entrantes
      myPeerRef.current.on('call', call => {
        console.log('Recibiendo llamada de: ' + call.peer);
        call.answer(myLocalStreamRef.current);
        
        call.on('stream', userVideoStream => {
          console.log('Stream recibido de: ' + call.peer);
          setPeerStreams(prev => {
            if (prev.some(p => p.peerId === call.peer)) return prev;

            const isScreen = userVideoStream.getVideoTracks()[0]?.label.includes('screen');
            let streamUserName = peerUserNames[call.peer] || call.peer;

            if (isScreen && call.peer.endsWith('-screen')) {
                const userId = call.peer.split('-screen')[0];
                streamUserName = `${peerUserNames[userId] || userId} (Pantalla)`;
            } else {
                streamUserName = peerUserNames[call.peer] || call.peer;
            }

            return [...prev, { stream: userVideoStream, peerId: call.peer, isScreenShare: isScreen, userName: streamUserName }];
          });
        });
        call.on('close', () => {
          console.log('Conexión cerrada con: ' + call.peer);
          setPeerStreams(prev => prev.filter(p => p.peerId !== call.peer));
        });
      });

      // Listeners de Socket.io
      socketRef.current.on('user-joined', ({ userId, userName: remoteUserName }) => {
        console.log('Nuevo usuario se unió: ' + remoteUserName + ' (' + userId + ')');
        setChatMessages(prev => [...prev, { user: 'Sistema', text: `${remoteUserName} se ha unido.`, id: Date.now() }]);
        setPeerUserNames(prev => ({ ...prev, [userId]: remoteUserName }));
        connectToNewUser(userId, myLocalStreamRef.current);
      });

      socketRef.current.on('all-users', (existingUsers) => {
        console.log('Usuarios existentes en la sala:', existingUsers);
        existingUsers.forEach(user => {
          if (user.userId !== myPeerRef.current.id) {
            setPeerUserNames(prev => ({ ...prev, [user.userId]: user.userName }));
            connectToNewUser(user.userId, myLocalStreamRef.current);
            if (user.isScreenSharing) {
              connectToScreenShare(user.userId);
            }
          }
        });
      });
      
      socketRef.current.on('user-started-screen-share', ({ userId, userName: remoteUserName }) => {
          console.log(`Usuario ${remoteUserName} ha empezado a compartir pantalla.`);
          setChatMessages(prev => [...prev, { user: 'Sistema', text: `${remoteUserName} ha empezado a compartir pantalla.`, id: Date.now() }]);
          connectToScreenShare(userId);
      });

      socketRef.current.on('user-stopped-screen-share', ({ userId, userName: remoteUserName }) => {
          console.log(`Usuario ${remoteUserName} ha dejado de compartir pantalla.`);
          setChatMessages(prev => [...prev, { user: 'Sistema', text: `${remoteUserName} ha dejado de compartir pantalla.`, id: Date.now() }]);
          const screenPeerId = `${userId}-screen`;
          setPeerStreams(prev => prev.filter(p => p.peerId !== screenPeerId));
          if (screenPeersRef.current[userId]) {
              screenPeersRef.current[userId].close();
              delete screenPeersRef.current[userId];
          }
      });

      socketRef.current.on('user-disconnected', (userId, disconnectedUserName) => {
        console.log('Usuario desconectado: ' + disconnectedUserName + ' (' + userId + ')');
        setChatMessages(prev => [...prev, { user: 'Sistema', text: `${disconnectedUserName} se ha ido.`, id: Date.now() }]);
        const screenPeerId = `${userId}-screen`;
        setPeerStreams(prev => prev.filter(p => p.peerId !== userId && p.peerId !== screenPeerId));
        if (peersRef.current[userId]) {
          peersRef.current[userId].close();
          delete peersRef.current[userId];
        }
        if (screenPeersRef.current[userId]) {
          screenPeersRef.current[userId].close();
          delete screenPeersRef.current[userId];
        }
      });

      socketRef.current.on('createMessage', (message, user) => {
        setChatMessages(prev => [...prev, { user, text: message, id: Date.now() }]);
      });
    }).catch(err => {
        console.error("Error al obtener el stream local", err);
    });

    return () => {
      if (socketRef.current) socketRef.current.disconnect();
      if (myPeerRef.current) myPeerRef.current.destroy();
    };
  }, [isJoined, roomId, userName, selectedVideoDeviceId, selectedAudioDeviceId, peerUserNames]);
  
  // Efecto para hacer scroll automático en el chat
  useEffect(() => {
    if (chatMessagesRef.current) {
      chatMessagesRef.current.scrollTop = chatMessagesRef.current.scrollHeight;
    }
  }, [chatMessages, isChatOpen]);
  
  // Manejador para enviar mensajes de chat
  const handleSendMessage = (e) => {
    e.preventDefault();
    if (message.trim() && userName) {
      socketRef.current.emit('message', message);
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
        if (myScreenStreamRef.current) {
          myScreenStreamRef.current.getTracks().forEach(track => track.stop());
          myScreenStreamRef.current = null;
        }
        if (myScreenPeerRef.current) {
          myScreenPeerRef.current.destroy();
          myScreenPeerRef.current = null;
        }
        setIsScreenSharing(false);
        const screenPeerId = `${myPeerRef.current.id}-screen`;
        socketRef.current.emit('stop-screen-share', { userId: myPeerRef.current.id, userName });
        setPeerStreams(prev => prev.filter(p => p.peerId !== screenPeerId));
        return;
      }
      
      const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      myScreenStreamRef.current = screenStream;
      setIsScreenSharing(true);
      
      const screenPeerId = `${myPeerRef.current.id}-screen`;
      
      if (!myScreenPeerRef.current) {
          myScreenPeerRef.current = new Peer(screenPeerId, {
            host: new URL(process.env.REACT_APP_SERVER_URL).hostname,
            port: new URL(process.env.REACT_APP_SERVER_URL).port || (new URL(process.env.REACT_APP_SERVER_URL).protocol === 'https:' ? 443 : 80),
            path: '/peerjs/myapp',
            secure: new URL(process.env.REACT_APP_SERVER_URL).protocol === 'https:'
          });

          myScreenPeerRef.current.on('open', id => {
              console.log(`Peer de pantalla abierto con ID: ${id}`);
              const streamUserName = `${userName} (Pantalla)`;
              setPeerStreams(prev => [...prev, { stream: screenStream, peerId: screenPeerId, isScreenShare: true, userName: streamUserName }]);
              socketRef.current.emit('start-screen-share', { userId: myPeerRef.current.id, userName });
          });
          
          myScreenPeerRef.current.on('call', call => {
              call.answer(screenStream);
          });
      }

      screenStream.getVideoTracks()[0].onended = () => {
        if (myScreenPeerRef.current) {
          myScreenPeerRef.current.destroy();
          myScreenPeerRef.current = null;
        }
        setIsScreenSharing(false);
        socketRef.current.emit('stop-screen-share', { userId: myPeerRef.current.id, userName });
        const screenPeerId = `${myPeerRef.current.id}-screen`;
        setPeerStreams(prev => prev.filter(p => p.peerId !== screenPeerId));
      };

    } catch (err) {
      console.error("Error al compartir la pantalla:", err);
      setIsScreenSharing(false);
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
            <LogIn className="mr-2" />
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
      <VideoComponent key={peer.peerId} stream={peer.stream} muted={false} userName={peer.userName} isScreenShare={peer.isScreenShare} />
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
            {isMuted ? <MicOff /> : <Mic />}
            <span className="hidden md:inline">{isMuted ? 'Activar' : 'Silenciar'}</span>
          </button>
          <button
            onClick={toggleVideo}
            className={`px-4 py-2 rounded-full text-xs md:text-base transition-colors duration-200 shadow-md flex items-center justify-center space-x-2 ${isVideoOff ? 'bg-red-600 hover:bg-red-500' : 'bg-gray-700 hover:bg-gray-600'}`}
          >
            {isVideoOff ? <VideoOff /> : <Video />}
            <span className="hidden md:inline">{isVideoOff ? 'Activar' : 'Detener'}</span>
          </button>
          <button
            onClick={shareScreen}
            className={`px-4 py-2 rounded-full text-xs md:text-base transition-colors duration-200 shadow-md flex items-center justify-center space-x-2 ${isScreenSharing ? 'bg-green-600 hover:bg-green-500' : 'bg-blue-600 hover:bg-blue-500'}`}
          >
            {isScreenSharing ? <X /> : <ScreenShare />}
            <span className="hidden md:inline">{isScreenSharing ? 'Dejar de compartir' : 'Compartir Pantalla'}</span>
          </button>
          <button
            onClick={() => setIsChatOpen(!isChatOpen)}
            className={`px-4 py-2 rounded-full text-xs md:text-base transition-colors duration-200 shadow-md flex items-center justify-center space-x-2 ${isChatOpen ? 'bg-indigo-600 hover:bg-indigo-500' : 'bg-gray-700 hover:bg-gray-600'}`}
          >
            <MessageSquare />
            <span className="hidden md:inline">Chat</span>
            <span className="md:hidden">{isChatOpen ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}</span>
          </button>
        </footer>
      </main>
      
      {/* Sidebar para el chat, se muestra/oculta en móviles */}
      <aside className={`fixed top-0 right-0 h-full w-full md:w-96 bg-gray-900 flex flex-col transform transition-transform duration-300 ease-in-out z-50 ${isChatOpen ? 'translate-x-0' : 'translate-x-full'}`}>
        <div className="p-4 flex items-center justify-between border-b border-gray-700 bg-gray-900">
          <h2 className="text-xl font-bold">Chat</h2>
          <button onClick={() => setIsChatOpen(false)} className="text-white hover:text-gray-400 p-2 rounded-full hover:bg-gray-700">
            <X size={20} />
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
            <Send size={20} />
          </button>
        </form>
      </aside>
    </div>
  );
}
