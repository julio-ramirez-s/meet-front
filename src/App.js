import React, { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import Peer from 'peerjs';
import { Mic, MicOff, Video, VideoOff, ScreenShare, MessageSquare, Send, X, LogIn } from 'lucide-react';
import 'tailwindcss/tailwind.css';

// Componente para renderizar cada video
const VideoComponent = ({ stream, muted, userName }) => {
  const ref = useRef();

  useEffect(() => {
    if (stream) {
      ref.current.srcObject = stream;
    }
  }, [stream]);

  return (
    <div className="relative w-full h-full bg-gray-900 rounded-lg overflow-hidden">
      <video
        ref={ref}
        playsInline
        autoPlay
        muted={muted}
        className="w-full h-full object-cover transform scale-x-[-1]"
      />
      <div className="absolute bottom-2 left-2 bg-gray-900 bg-opacity-70 text-white text-xs px-2 py-1 rounded-md">
        {userName}
      </div>
    </div>
  );
};

const App = () => {
  // === CONFIGURACIÓN CLAVE ===
  // 1. Hemos reemplazado 'http://localhost:3001' con la URL de tu servidor en Render.
  //    ¡Esta es la única línea que tienes que cambiar!
  const SERVER_URL = 'https://meet-clone-v0ov.onrender.com';

  // Estado para la lógica de la app
  const [roomId] = useState('main-room');
  const [myStream, setMyStream] = useState(null);
  const [peerStreams, setPeerStreams] = useState([]);
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoOff, setIsVideoOff] = useState(false);
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [isJoined, setIsJoined] = useState(false);
  const [isLoadingDevices, setIsLoadingDevices] = useState(true);

  // Estado para la selección de dispositivos
  const [videoDevices, setVideoDevices] = useState([]);
  const [audioDevices, setAudioDevices] = useState([]);
  const [selectedVideoDeviceId, setSelectedVideoDeviceId] = useState('');
  const [selectedAudioDeviceId, setSelectedAudioDeviceId] = useState('');

  // Estado para el chat
  const [chatMessages, setChatMessages] = useState([]);
  const [message, setMessage] = useState('');
  const [userName, setUserName] = useState('');
  
  // Mapeo de Peer ID a nombre de usuario para el video
  const [peerUserNames, setPeerUserNames] = useState({});

  // Referencias para las instancias de Socket.IO, PeerJS y las conexiones
  const socketRef = useRef();
  const myPeerRef = useRef();
  const myOriginalStreamRef = useRef();
  const chatMessagesRef = useRef();
  const peersRef = useRef({});

  // Efecto 1: Obtener la lista de dispositivos de medios
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

  // Efecto 2: Lógica principal de la videollamada, se ejecuta solo al unirse a la sala
  useEffect(() => {
    if (!isJoined) return;
    if (myPeerRef.current || socketRef.current) return;

    navigator.mediaDevices.getUserMedia({
      video: { deviceId: selectedVideoDeviceId ? { exact: selectedVideoDeviceId } : undefined },
      audio: { deviceId: selectedAudioDeviceId ? { exact: selectedAudioDeviceId } : undefined }
    })
    .then(stream => {
        setMyStream(stream);
        myOriginalStreamRef.current = stream;

        // Conexión a Socket.io
        socketRef.current = io(SERVER_URL);

        // Conexión a PeerJS. Aseguramos que la configuración sea correcta para Render.
        myPeerRef.current = new Peer(undefined, {
          host: new URL(SERVER_URL).hostname,
          port: new URL(SERVER_URL).port || (new URL(SERVER_URL).protocol === 'https:' ? 443 : 80),
          path: '/peerjs/myapp',
          secure: new URL(SERVER_URL).protocol === 'https:'
        });

        myPeerRef.current.on('open', id => {
          console.log(`Mi Peer ID es: ${id}`);
          socketRef.current.emit('join-room', roomId, id, userName);
        });

        myPeerRef.current.on('call', call => {
          console.log(`Recibiendo llamada de: ${call.peer}`);
          call.answer(stream);
          call.on('stream', userVideoStream => {
            console.log(`Stream recibido de: ${call.peer}`);
            setPeerStreams(prev => {
              if (prev.some(p => p.peerId === call.peer)) return prev;
              return [...prev, { stream: userVideoStream, peerId: call.peer }];
            });
          });
          call.on('close', () => {
            console.log(`Conexión cerrada con: ${call.peer}`);
            setPeerStreams(prev => prev.filter(p => p.peerId !== call.peer));
          });
        });

        socketRef.current.on('user-joined', ({ userId, userName: remoteUserName }) => {
          console.log(`Nuevo usuario se unió: ${remoteUserName} (${userId})`);
          setChatMessages(prev => [...prev, { user: 'Sistema', text: `${remoteUserName} se ha unido.`, id: Date.now() }]);
          setPeerUserNames(prev => ({ ...prev, [userId]: remoteUserName }));
        });

        socketRef.current.on('all-users', (existingUsers) => {
          console.log('Usuarios existentes en la sala:', existingUsers);
          existingUsers.forEach(user => {
            if (user.userId !== myPeerRef.current.id) {
              setPeerUserNames(prev => ({ ...prev, [user.userId]: user.userName }));
              connectToNewUser(user.userId, stream);
            }
          });
        });

        socketRef.current.on('user-disconnected', (userId, disconnectedUserName) => {
          console.log(`Usuario desconectado: ${disconnectedUserName} (${userId})`);
          setChatMessages(prev => [...prev, { user: 'Sistema', text: `${disconnectedUserName} se ha ido.`, id: Date.now() }]);
          if (peersRef.current[userId]) {
            peersRef.current[userId].close();
            const { [userId]: removedPeer, ...newPeers } = peersRef.current;
            peersRef.current = newPeers;
          }
          setPeerStreams(prev => prev.filter(p => p.peerId !== userId));
        });

        socketRef.current.on('createMessage', (message, user) => {
          setChatMessages(prev => [...prev, { user, text: message, id: Date.now() }]);
        });
        
    }).catch(err => {
        console.error("Error al obtener stream local", err);
    });

    return () => {
      if (socketRef.current) socketRef.current.disconnect();
      if (myPeerRef.current) myPeerRef.current.destroy();
    };

  }, [isJoined, roomId, userName, selectedVideoDeviceId, selectedAudioDeviceId]);

  useEffect(() => {
    if (chatMessagesRef.current) {
      chatMessagesRef.current.scrollTop = chatMessagesRef.current.scrollHeight;
    }
  }, [chatMessages, isChatOpen]);

  const connectToNewUser = (userId, stream) => {
    const call = myPeerRef.current.call(userId, stream);
    call.on('stream', userVideoStream => {
      console.log(`Stream enviado y recibido de: ${userId}`);
      setPeerStreams(prev => {
        if (prev.some(p => p.peerId === userId)) return prev;
        return [...prev, { stream: userVideoStream, peerId: userId }];
      });
    });
    call.on('close', () => {
      setPeerStreams(prev => prev.filter(p => p.peerId !== userId));
    });
    peersRef.current = { ...peersRef.current, [userId]: call };
  };

  const handleSendMessage = (e) => {
    e.preventDefault();
    if (message.trim() && userName) {
      socketRef.current.emit('message', message);
      setMessage('');
    }
  };

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
      const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      const screenTrack = screenStream.getVideoTracks()[0];
      
      for (const peerId in peersRef.current) {
        const sender = peersRef.current[peerId].peerConnection.getSenders().find(s => s.track.kind === 'video');
        if (sender) sender.replaceTrack(screenTrack);
      }
      
      const newStreamWithScreen = new MediaStream([screenTrack, myOriginalStreamRef.current.getAudioTracks()[0]]);
      setMyStream(newStreamWithScreen);
      setIsVideoOff(false);

      screenTrack.onended = () => {
        const originalStream = myOriginalStreamRef.current;
        const originalTrack = originalStream.getVideoTracks()[0];
        setMyStream(new MediaStream([originalTrack, originalStream.getAudioTracks()[0]]));
        for (const peerId in peersRef.current) {
          const sender = peersRef.current[peerId].peerConnection.getSenders().find(s => s.track.kind === 'video');
          if (sender) sender.replaceTrack(originalTrack);
        }
      };
    } catch (err) {
      console.error("Error al compartir pantalla:", err);
    }
  };

  const handleJoinCall = (e) => {
    e.preventDefault();
    if (userName.trim()) {
      setIsJoined(true);
    }
  };

  if (!isJoined) {
    return (
      <div className="flex flex-col items-center justify-center h-screen bg-gray-900 text-white font-sans p-4">
        <form onSubmit={handleJoinCall} className="bg-gray-800 p-8 rounded-xl shadow-2xl w-full max-w-md space-y-6">
          <h1 className="text-3xl font-bold text-center mb-6">Únete a la Llamada</h1>
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
            className="w-full flex items-center justify-center p-3 text-lg font-semibold rounded-lg bg-blue-600 hover:bg-blue-500 transition-colors duration-200 disabled:bg-gray-500"
          >
            <LogIn className="mr-2" />
            Unirse a la Llamada
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="flex flex-col md:flex-row h-screen bg-gray-900 text-white font-sans">
      <main className={`flex flex-col flex-grow ${isChatOpen ? 'md:mr-80' : ''}`}>
        <div id="video-grid" className="flex-grow grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 p-4">
          {myStream && <VideoComponent stream={myStream} muted={true} userName={userName} />}
          {peerStreams.map((peer) => (
            <VideoComponent key={peer.peerId} stream={peer.stream} userName={peerUserNames[peer.peerId] || peer.peerId} />
          ))}
        </div>
        <footer className="bg-gray-800 p-4 flex justify-center items-center space-x-2 md:space-x-4">
          <button
            onClick={toggleMute}
            className={`px-4 py-2 rounded-full text-xs md:text-base transition-colors duration-200 shadow-md flex items-center justify-center space-x-2 ${isMuted ? 'bg-red-600 hover:bg-red-500' : 'bg-gray-600 hover:bg-gray-500'}`}
          >
            {isMuted ? <MicOff /> : <Mic />}
            <span className="hidden md:inline">{isMuted ? 'Activar' : 'Silenciar'}</span>
          </button>
          <button
            onClick={toggleVideo}
            className={`px-4 py-2 rounded-full text-xs md:text-base transition-colors duration-200 shadow-md flex items-center justify-center space-x-2 ${isVideoOff ? 'bg-red-600 hover:bg-red-500' : 'bg-gray-600 hover:bg-gray-500'}`}
          >
            {isVideoOff ? <VideoOff /> : <Video />}
            <span className="hidden md:inline">{isVideoOff ? 'Activar' : 'Detener'}</span>
          </button>
          <button
            onClick={shareScreen}
            className="px-4 py-2 rounded-full text-xs md:text-base bg-blue-600 hover:bg-blue-500 transition-colors duration-200 shadow-md flex items-center justify-center space-x-2"
          >
            <ScreenShare />
            <span className="hidden md:inline">Compartir Pantalla</span>
          </button>
          <button
            onClick={() => setIsChatOpen(!isChatOpen)}
            className={`px-4 py-2 rounded-full text-xs md:text-base transition-colors duration-200 shadow-md flex items-center justify-center space-x-2 ${isChatOpen ? 'bg-indigo-600 hover:bg-indigo-500' : 'bg-gray-600 hover:bg-gray-500'}`}
          >
            <MessageSquare />
            <span className="hidden md:inline">Chat</span>
          </button>
        </footer>
      </main>
      <aside className={`fixed top-0 right-0 h-full w-full md:w-80 bg-gray-800 flex flex-col transform transition-transform duration-300 ease-in-out z-50 ${isChatOpen ? 'translate-x-0' : 'translate-x-full'}`}>
        <div className="p-4 flex items-center justify-between border-b border-gray-700">
          <h2 className="text-lg md:text-xl font-bold">Chat</h2>
          <button onClick={() => setIsChatOpen(false)} className="text-white hover:text-gray-400">
            <X />
          </button>
        </div>
        <div ref={chatMessagesRef} className="flex-grow p-4 overflow-y-auto custom-scrollbar">
          <div className="space-y-4 text-sm">
            {chatMessages.map((msg) => (
              <div key={msg.id} className="flex flex-col">
                <span className="font-semibold text-blue-400 text-xs">{msg.user}:</span>
                <span className="break-words text-white text-sm">{msg.text}</span>
              </div>
            ))}
          </div>
        </div>
        <form onSubmit={handleSendMessage} className="p-4 border-t border-gray-700 flex space-x-2">
          <input
            type="text"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            className="flex-grow p-2 bg-gray-700 rounded-lg focus:outline-none text-white placeholder-gray-400"
            placeholder="Escribe un mensaje..."
          />
          <button type="submit" className="bg-blue-600 hover:bg-blue-500 p-2 rounded-lg text-white">
            <Send size={20} />
          </button>
        </form>
      </aside>
    </div>
  );
};

export default App;
