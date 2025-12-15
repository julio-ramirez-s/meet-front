// CÓDIGO COMPLETO MODIFICADO
// (Se mantiene toda la lógica WebRTC original y se mejora UI/UX móvil)

import React, { useState, useEffect, useRef, createContext, useContext, useCallback } from 'react';
import { Mic, MicOff, Video, VideoOff, ScreenShare, MessageSquare, Send, X, LogIn, Plus, Sun, Moon, MoreVertical, Loader } from 'lucide-react';
import { io } from 'socket.io-client';
import Peer from 'peerjs';
import { ToastContainer, toast } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';
import styles from './App.module.css';

/* ================= CONTEXTO ================= */
const WebRTCContext = createContext();
const useWebRTC = () => useContext(WebRTCContext);

/* ================= HOOK PRINCIPAL ================= */
const useWebRTCLogic = (roomId) => {
  // Configuración inicial
  const API_URL = "http://localhost:3000"; // URL de tu servidor Socket.io/PeerJS
  const socketRef = useRef();
  const peerRef = useRef();
  const connections = useRef({});
  
  // Estados de la videollamada
  const [myStream, setMyStream] = useState(null);
  const [myScreenStream, setMyScreenStream] = useState(null); // NUEVO: Estado de la pantalla compartida
  const [peers, setPeers] = useState({});
  const [chatMessages, setChatMessages] = useState([]);
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoOff, setIsVideoOff] = useState(false);
  const [currentUserName, setCurrentUserName] = useState('');
  const [appTheme, setAppTheme] = useState('dark'); // NUEVO: Estado del tema

  // Inicializa la conexión con Socket.io
  useEffect(() => {
    socketRef.current = io(API_URL);

    // Escuchar eventos de chat
    socketRef.current.on('chat-message', (message) => {
      setChatMessages(prev => [...prev, message]);
      toast.info(`${message.userName}: ${message.text.substring(0, 30)}...`);
    });

    // NUEVO: Escuchar eventos de pantalla compartida
    socketRef.current.on('screen-shared', ({ userId, isSharing }) => {
      setPeers(p => {
        const peer = p[userId];
        if (peer) {
          const newState = { ...p, [userId]: { ...peer, isSharingScreen: isSharing } };
          const userName = peer.userName || 'Un usuario';
          if (isSharing) {
            toast.info(`${userName} ha empezado a compartir su pantalla.`);
          } else {
            toast.info(`${userName} ha dejado de compartir su pantalla.`);
          }
          return newState;
        }
        return p;
      });
    });

    return () => {
      socketRef.current.disconnect();
    };
  }, [API_URL]);

  // Maneja la inicialización de la transmisión de la cámara/micrófono
  const initializeStream = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      setMyStream(stream);
      return stream;
    } catch (err) {
      toast.error('No se pudo acceder a la cámara o al micrófono.');
      console.error('Error al obtener stream local:', err);
      return null;
    }
  };

  // Maneja la conexión con PeerJS
  const connect = (stream, name) => {
    setCurrentUserName(name);
    peerRef.current = new Peer(undefined, {
      host: 'localhost',
      port: 3000,
      path: '/peerjs'
    });

    peerRef.current.on('open', (id) => {
      socketRef.current.emit('join-room', roomId, id, name);
    });

    // Escucha llamadas entrantes
    peerRef.current.on('call', (call) => {
      // Responde la llamada y envía tu stream
      call.answer(stream);
      
      call.on('stream', (peerStream) => {
        // Obtenemos el ID del peer que llama a través del socket
        socketRef.current.emit('get-user-info', call.peer);

        // Agrega el nuevo peer
        setPeers(prevPeers => ({
          ...prevPeers,
          [call.peer]: { stream: peerStream, userName: 'Cargando...', peerId: call.peer, isSharingScreen: false }
        }));
      });

      call.on('close', () => {
        setPeers(prevPeers => {
          const { [call.peer]: removed, ...rest } = prevPeers;
          toast.warn(`${removed?.userName || 'Un usuario'} ha abandonado la reunión.`);
          return rest;
        });
        delete connections.current[call.peer];
      });

      connections.current[call.peer] = { call, sender: call.peerConnection.getSenders().find(s => s.track.kind === 'video') };
    });

    // Escucha la información del usuario
    socketRef.current.on('user-info', ({ userId, userName, isSharingScreen }) => {
      setPeers(prevPeers => {
        if (prevPeers[userId]) {
          return { ...prevPeers, [userId]: { ...prevPeers[userId], userName, isSharingScreen } };
        }
        return prevPeers;
      });
    });
    
    // Conexión con otros usuarios en la sala
    socketRef.current.on('user-connected', (userId, userName) => {
      toast.success(`${userName} se ha unido a la reunión.`);
      
      // Llama al nuevo usuario y envía tu stream
      const call = peerRef.current.call(userId, stream);
      
      call.on('stream', (peerStream) => {
        setPeers(prevPeers => ({
          ...prevPeers,
          [userId]: { stream: peerStream, userName, peerId: userId, isSharingScreen: false }
        }));
      });

      call.on('close', () => {
        setPeers(prevPeers => {
          const { [userId]: removed, ...rest } = prevPeers;
          toast.warn(`${removed?.userName || 'Un usuario'} ha abandonado la reunión.`);
          return rest;
        });
        delete connections.current[userId];
      });

      connections.current[userId] = { call, sender: call.peerConnection.getSenders().find(s => s.track.kind === 'video') };
    });

    // Desconexión de usuarios
    socketRef.current.on('user-disconnected', (userId) => {
      if (connections.current[userId]) {
        connections.current[userId].call.close();
      }
      setPeers(prevPeers => {
        const { [userId]: removed, ...rest } = prevPeers;
        toast.warn(`${removed?.userName || 'Un usuario'} ha abandonado la reunión.`);
        return rest;
      });
      delete connections.current[userId];
    });
  };
  
  // Función para enviar mensajes de chat
  const sendChatMessage = (text) => {
    if (text.trim() === '') return;
    const message = { userId: peerRef.current.id, userName: currentUserName, text, timestamp: Date.now() };
    socketRef.current.emit('chat-message', message);
    setChatMessages(prev => [...prev, message]);
  };

  // Función para mutear/desmutear
  const toggleMute = () => {
    if (myStream) {
      const audioTrack = myStream.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        setIsMuted(!audioTrack.enabled);
      }
    }
  };

  // Función para encender/apagar video
  const toggleVideo = () => {
    if (myStream) {
      const videoTrack = myStream.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.enabled = !videoTrack.enabled;
        setIsVideoOff(!videoTrack.enabled);
      }
    }
  };

  // NUEVO: Función para compartir/dejar de compartir pantalla
  const toggleScreenShare = useCallback(async () => {
    const videoSender = Object.values(connections.current).map(conn => 
      conn.call.peerConnection.getSenders().find(s => s.track.kind === 'video')
    ).filter(Boolean);

    if (myScreenStream) {
      // Detener de compartir
      myScreenStream.getTracks().forEach(track => track.stop());
      setMyScreenStream(null);
      socketRef.current.emit('screen-shared', false); // Notificar a todos

      // Reemplazar la pista de video principal con la cámara original
      const cameraTrack = myStream?.getVideoTracks()[0];
      if (videoSender.length > 0 && cameraTrack) {
        videoSender.forEach(sender => sender.replaceTrack(cameraTrack.enabled ? cameraTrack : null));
        setIsVideoOff(!cameraTrack.enabled); // Reflejar el estado real de la cámara
      }
      return;
    }

    // Iniciar a compartir
    try {
      // Usamos `video: true` para obtener la pantalla completa, no solo un área
      const screen = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      setMyScreenStream(screen);
      socketRef.current.emit('screen-shared', true); // Notificar a todos

      // Reemplazar la pista de video en las conexiones de PeerJS con la pantalla
      const screenTrack = screen.getVideoTracks()[0];
      if (videoSender.length > 0) {
        videoSender.forEach(sender => sender.replaceTrack(screenTrack));
        setIsVideoOff(false); // Siempre hay video cuando se comparte pantalla
      }
      
      // Manejar cuando se detiene la captura de pantalla a través del botón del navegador
      screenTrack.onended = () => {
        if (myScreenStream) { // Asegurarse de que el estado no ha sido limpiado ya
             toggleScreenShare(); 
        }
      };

    } catch (err) {
      toast.error('No se pudo compartir la pantalla.');
      console.error('Error al compartir pantalla:', err);
    }
  }, [myScreenStream, myStream]);

  // Limpieza al salir
  const cleanup = () => {
    Object.values(connections.current).forEach(conn => conn.call.close());
    if (myStream) {
      myStream.getTracks().forEach(track => track.stop());
    }
    if (myScreenStream) {
      myScreenStream.getTracks().forEach(track => track.stop());
    }
    peerRef.current?.destroy();
    socketRef.current?.disconnect();
  };

  return {
    myStream,
    myScreenStream, // EXPORTADO
    peers,
    chatMessages,
    isMuted,
    isVideoOff,
    currentUserName,
    appTheme,
    initializeStream,
    connect,
    sendChatMessage,
    toggleMute,
    toggleVideo,
    toggleScreenShare, // EXPORTADO
    sendThemeChange: setAppTheme,
    cleanup
  };
};

/* ================= VIDEO PLAYER ================= */
const VideoPlayer = ({ stream, userName, muted, isLocal = false }) => {
  const videoRef = useRef();
  
  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream;
    }
  }, [stream]);

  // Clase para ocultar el video si está apagado y no es el stream de pantalla
  const videoHidden = isLocal && !stream?.getVideoTracks()[0]?.enabled && !stream?.id.includes('screen');

  return (
    <div className={styles.videoWrapper} data-username={userName}>
      <video 
        ref={videoRef} 
        className={`${styles.videoElement} ${videoHidden ? styles.videoHidden : ''}`}
        autoPlay 
        playsInline 
        muted={muted} 
      />
      
      {/* Indicador de video apagado (solo para cámaras) */}
      {videoHidden && (
        <div className={styles.videoPlaceholder}>
          <VideoOff size={48} />
          <p>{userName}</p>
        </div>
      )}
      
      {/* Etiqueta del usuario */}
      <div className={styles.userNameTag}>{userName}</div>
      
      {/* Icono de mute */}
      {muted && <div className={styles.muteIcon}><MicOff size={16} /></div>}
    </div>
  );
};

/* ================= VIDEO GRID ================= */
const VideoGrid = () => {
  const { myStream, peers, currentUserName, myScreenStream } = useWebRTC();

  // 1. Determinar el video principal (si alguien comparte pantalla)
  const mainVideoPeerEntry = Object.entries(peers).find(([, p]) => p.isSharingScreen);
  const mainVideoStream = myScreenStream || (mainVideoPeerEntry ? mainVideoPeerEntry[1].stream : null);
  const mainVideoUserName = myScreenStream ? `${currentUserName} (Tú, Pantalla)` : (mainVideoPeerEntry ? `${mainVideoPeerEntry[1].userName} (Pantalla)` : null);

  // 2. Determinar los videos secundarios (cámaras)
  const secondaryVideos = [];
  
  // Añadir mi cámara a los secundarios si NO estoy compartiendo mi pantalla O si estoy
  // pero el video principal es la pantalla de otra persona.
  if (myStream) {
    // Si yo estoy compartiendo mi pantalla, mi cámara se oculta (o si alguien más lo hace y yo tengo la cámara apagada)
    const isMyScreenMain = myScreenStream !== null;
    // Si mi cámara no es la principal (pantalla), la pongo en secundarios
    if (!isMyScreenMain || !mainVideoStream) {
       secondaryVideos.push({ 
           stream: myStream, 
           userName: `${currentUserName} (Tú)`, 
           muted: true, 
           isLocal: true,
           key: 'local-camera' 
        });
    }
  }

  // Añadir las cámaras de los demás peers
  Object.entries(peers).forEach(([id, p]) => {
    // Si el peer está compartiendo pantalla y es el video principal, no lo añadimos aquí
    if (p.isSharingScreen && mainVideoPeerEntry && mainVideoPeerEntry[0] === id) {
      return; 
    }
    // Sino, añadimos su stream (que será su cámara o su pantalla si no fue seleccionada como principal)
    secondaryVideos.push({ 
        stream: p.stream, 
        userName: p.userName, 
        muted: false, 
        key: id 
    });
  });


  return (
    // Agregamos la clase 'mainVideoPresent' si hay pantalla compartida
    <div className={`${styles.videoGridContainer} ${mainVideoStream ? styles.mainVideoPresent : ''}`}>
      
      {/* Contenedor del video principal (pantalla compartida o video más grande) */}
      {mainVideoStream ? (
        <div className={styles.mainVideo}>
          <VideoPlayer stream={mainVideoStream} userName={mainVideoUserName} muted={!!myScreenStream} />
        </div>
      ) : (
         // Si no hay video principal, todos los videos secundarios toman el espacio
         <div className={styles.videoSecondaryGrid} style={{ flexGrow: 1, flexDirection: 'row' }}>
            {secondaryVideos.map((p) => (
                <VideoPlayer key={p.key} stream={p.stream} userName={p.userName} muted={p.muted} isLocal={p.isLocal} />
            ))}
         </div>
      )}

      {/* Contenedor de los videos secundarios (cámaras) cuando hay main video */}
      {mainVideoStream && (
        <div className={styles.videoSecondaryGrid}>
          {secondaryVideos.map((p) => (
            <VideoPlayer key={p.key} stream={p.stream} userName={p.userName} muted={p.muted} isLocal={p.isLocal} />
          ))}
        </div>
      )}
    </div>
  );
};

/* ================= CHAT ================= */
const ChatSidebar = ({ isOpen, onClose }) => {
  const { chatMessages, sendChatMessage, currentUserName } = useWebRTC();
  const [inputText, setInputText] = useState('');
  const messagesEndRef = useRef(null);

  const sendMessage = (e) => {
    e.preventDefault();
    if (inputText.trim()) {
      sendChatMessage(inputText);
      setInputText('');
    }
  };

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatMessages, isOpen]);

  return (
    <aside className={`${styles.chatSidebar} ${isOpen ? styles.chatOpen : styles.chatClosed}`}>
      <header className={styles.chatHeader}>
        <h2>Chat de la Reunión</h2>
        <button onClick={onClose} className={styles.chatCloseButton}><X /></button>
      </header>
      <div className={styles.chatMessages}>
        {chatMessages.map((msg, index) => (
          <div key={index} className={`${styles.chatMessage} ${msg.userName === currentUserName ? styles.myMessage : styles.peerMessage}`}>
            <span className={styles.chatUserName}>{msg.userName}:</span>
            <p className={styles.chatText}>{msg.text}</p>
            <span className={styles.chatTimestamp}>{new Date(msg.timestamp).toLocaleTimeString()}</span>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>
      <form onSubmit={sendMessage} className={styles.chatInputContainer}>
        <input
          type="text"
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          placeholder="Escribe un mensaje..."
          className={styles.chatInput}
        />
        <button type="submit" className={styles.sendButton}><Send /></button>
      </form>
    </aside>
  );
};

/* ================= CONTROLES ================= */

// Componente para manejar el menú flotante en móvil
const MobileMenu = ({ onToggleChat, onLeave, sendThemeChange, appTheme }) => (
  <div className={styles.mobileMenu}>
    <button onClick={onToggleChat} className={styles.controlButton}>
      <MessageSquare /> Chat
    </button>
    <button className={styles.controlButton}>
      <Plus /> Reacciones
    </button>
    <button 
      onClick={() => sendThemeChange(appTheme === 'dark' ? 'light' : 'dark')}
      className={styles.controlButton}
    >
      {appTheme === 'dark' ? <Sun /> : <Moon />} Tema
    </button>
    <button onClick={onLeave} className={styles.leaveButtonMobile}>
        Salir
    </button>
  </div>
);


const Controls = ({ onToggleChat, onLeave }) => {
  const { 
    toggleMute, toggleVideo, toggleScreenShare, sendThemeChange, 
    isMuted, isVideoOff, myScreenStream, appTheme 
  } = useWebRTC();
  
  // Utilizar el media query definido en CSS para determinar el modo móvil
  const [isMobile, setIsMobile] = useState(window.innerWidth <= 768);
  const [openMobileMenu, setOpenMobileMenu] = useState(false);

  useEffect(() => {
    const handleResize = () => {
        setIsMobile(window.innerWidth <= 768);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  return (
    <footer className={styles.controlsFooter}>
      {/* Grupo de Controles principales: Audio/Video */}
      <div className={styles.mainControlsGroup}>
        <button 
          onClick={toggleMute} 
          className={`${styles.controlButton} ${!isMuted ? styles.controlButtonActive : ''}`}
          title={isMuted ? 'Desmutear' : 'Mutear'}
        >
          {isMuted ? <MicOff /> : <Mic />}
        </button>
        <button 
          onClick={toggleVideo} 
          className={`${styles.controlButton} ${!isVideoOff ? styles.controlButtonActive : ''}`}
          title={isVideoOff ? 'Encender Video' : 'Apagar Video'}
        >
          {isVideoOff ? <VideoOff /> : <Video />}
        </button>
      </div>
      
      {/* Controles de Acción: Pantalla, Chat, Tema (en escritorio) */}
      <div className={styles.actionControlsGroup}>
        <button 
          onClick={toggleScreenShare} 
          className={`${styles.controlButton} ${myScreenStream ? styles.controlButtonScreenShare : ''}`}
          title={myScreenStream ? 'Detener Pantalla' : 'Compartir Pantalla'}
        >
          <ScreenShare />
        </button>
        
        {/* Chat y Tema (Solo visible en escritorio) */}
        {!isMobile && (
            <>
                <button onClick={onToggleChat} className={styles.controlButton} title="Abrir Chat">
                    <MessageSquare />
                </button>
                <button 
                  onClick={() => sendThemeChange(appTheme === 'dark' ? 'light' : 'dark')}
                  className={styles.controlButton}
                  title={appTheme === 'dark' ? 'Modo Claro' : 'Modo Oscuro'}
                >
                  {appTheme === 'dark' ? <Sun /> : <Moon />}
                </button>
            </>
        )}
        
        {/* Menú flotante para móvil */}
        {isMobile && (
          <button onClick={() => setOpenMobileMenu(!openMobileMenu)} className={styles.controlButton} title="Más Opciones">
            <MoreVertical />
          </button>
        )}
      </div>

      {/* Botón de Salir (Solo en escritorio) */}
      {!isMobile && (
        <button onClick={onLeave} className={styles.leaveButton}>
          Salir
        </button>
      )}

      {/* Menú Móvil Flotante */}
      {openMobileMenu && isMobile && (
        <MobileMenu 
            onToggleChat={() => { onToggleChat(); setOpenMobileMenu(false); }} 
            onLeave={onLeave}
            sendThemeChange={sendThemeChange}
            appTheme={appTheme}
        />
      )}
    </footer>
  );
};

/* ================= LAYOUT ================= */
const CallRoom = ({ onLeave }) => {
  const [chat, setChat] = useState(false);
  return (
    <div className={styles.mainContainer}>
      <VideoGrid />
      <Controls onToggleChat={() => setChat(v => !v)} onLeave={onLeave} />
      <ChatSidebar isOpen={chat} onClose={() => setChat(false)} />
    </div>
  );
};

/* ================= LOBBY ================= */
const Lobby = ({ onJoin }) => {
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!name.trim()) {
        toast.error("Por favor, introduce tu nombre.");
        return;
    }
    setLoading(true);
    await onJoin(name);
    setLoading(false);
  };

  return (
    <div className={styles.lobbyContainer}>
      <form onSubmit={handleSubmit} className={styles.lobbyForm}>
        <h1 className={styles.lobbyTitle}>UniRTC Meet</h1>
        <p className={styles.lobbySubtitle}>Ingresa tu nombre para unirte a la reunión.</p>
        <input 
            placeholder="Tu nombre" 
            value={name} 
            onChange={e => setName(e.target.value)} 
            className={styles.lobbyInput}
            disabled={loading}
        />
        <button className={styles.joinButton} disabled={loading}>
          {loading ? <Loader className={styles.spinner} size={20} /> : <LogIn />} 
          {loading ? 'Conectando...' : 'Entrar a la Sala'}
        </button>
      </form>
    </div>
  );
};

/* ================= APP PRINCIPAL ================= */
export default function App() {
  const [joined, setJoined] = useState(false);
  const logic = useWebRTCLogic('room'); // Hardcodeado para este ejemplo

  const join = async name => {
    const stream = await logic.initializeStream();
    if (stream) {
      logic.connect(stream, name);
      setJoined(true);
    }
  };

  const leave = () => {
    logic.cleanup();
    setJoined(false);
    window.location.reload(); // Recarga simple para resetear estados complejos
  };

  // NUEVO: Aplicar el tema a la etiqueta <body>
  useEffect(() => {
    document.body.className = logic.appTheme === 'light' ? styles.lightMode : '';
  }, [logic.appTheme]);


  return (
    <div className={styles.appWrapper}>
      <ToastContainer 
        position="top-right"
        autoClose={3000}
        hideProgressBar={false}
        newestOnTop={false}
        closeOnClick
        rtl={false}
        pauseOnFocusLoss
        draggable
        pauseOnHover
        theme={logic.appTheme === 'dark' ? "dark" : "light"}
      />
      
      {joined ? (
        <WebRTCContext.Provider value={logic}>
          <CallRoom onLeave={leave} />
        </WebRTCContext.Provider>
      ) : (
        <Lobby onJoin={join} />
      )}
    </div>
  );
}