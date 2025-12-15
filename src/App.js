// Archivo App.js con la URL del servidor remoto configurada.
// Se mantiene la funcionalidad original y se aplica el diseño responsivo.

import React, { useState, useEffect, useRef, createContext, useContext } from 'react';
import { Mic, MicOff, Video, VideoOff, MessageSquare, Send, X, LogIn, Plus, MoreVertical, Loader, Sun, Moon } from 'lucide-react';
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
  // Configuración de la URL del servidor en Render (CORRECCIÓN IMPORTANTE)
  const API_URL = "https://meet-clone-v0ov.onrender.com"; 
  const socketRef = useRef();
  const peerRef = useRef();
  const connections = useRef({});
  
  // Estados de la videollamada
  const [myStream, setMyStream] = useState(null);
  const [peers, setPeers] = useState({});
  const [chatMessages, setChatMessages] = useState([]);
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoOff, setIsVideoOff] = useState(false);
  const [currentUserName, setCurrentUserName] = useState('');
  const [appTheme, setAppTheme] = useState('dark'); 

  // Inicializa la conexión con Socket.io
  useEffect(() => {
    // CORRECCIÓN: Usar la URL completa para la conexión de Socket.io
    socketRef.current = io(API_URL);

    // Escuchar eventos de chat
    socketRef.current.on('chat-message', (message) => {
      setChatMessages(prev => [...prev, message]);
      toast.info(`${message.userName}: ${message.text.substring(0, 30)}...`);
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
      toast.error('No se pudo acceder a la cámara o al micrófono. Asegúrate de dar permisos.');
      console.error('Error al obtener stream local:', err);
      return null;
    }
  };

  // Maneja la conexión con PeerJS
  const connect = (stream, name) => {
    setCurrentUserName(name);
    
    // CORRECCIÓN: Usar la configuración de PeerJS que apunte a la instancia de Render
    const url = new URL(API_URL);

    peerRef.current = new Peer(undefined, {
      host: url.hostname,
      port: url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : parseInt(url.port),
      path: '/', // CORRECCIÓN CLAVE: Se cambia '/peerjs' a '/' para evitar la duplicación de ruta que causa el 404.
      secure: url.protocol === 'https:', // Usar 'secure: true' si la URL es HTTPS
    });

    peerRef.current.on('open', (id) => {
      socketRef.current.emit('join-room', roomId, id, name);
    });

    // Escucha llamadas entrantes
    peerRef.current.on('call', (call) => {
      call.answer(stream);
      
      call.on('stream', (peerStream) => {
        socketRef.current.emit('get-user-info', call.peer);

        setPeers(prevPeers => ({
          ...prevPeers,
          [call.peer]: { stream: peerStream, userName: 'Cargando...', peerId: call.peer }
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

      connections.current[call.peer] = { call };
    });

    // Escucha la información del usuario
    socketRef.current.on('user-info', ({ userId, userName }) => {
      setPeers(prevPeers => {
        if (prevPeers[userId]) {
          return { ...prevPeers, [userId]: { ...prevPeers[userId], userName } };
        }
        return prevPeers;
      });
    });
    
    // Conexión con otros usuarios en la sala
    socketRef.current.on('user-connected', (userId, userName) => {
      toast.success(`${userName} se ha unido a la reunión.`);
      
      const call = peerRef.current.call(userId, stream);
      
      call.on('stream', (peerStream) => {
        setPeers(prevPeers => ({
          ...prevPeers,
          [userId]: { stream: peerStream, userName, peerId: userId }
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

      connections.current[userId] = { call };
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

  // Limpieza al salir
  const cleanup = () => {
    Object.values(connections.current).forEach(conn => conn.call.close());
    if (myStream) {
      myStream.getTracks().forEach(track => track.stop());
    }
    peerRef.current?.destroy();
    socketRef.current?.disconnect();
  };

  return {
    myStream,
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

  // Se añade la lógica para el placeholder si el video está apagado
  const videoHidden = isLocal && !stream?.getVideoTracks()[0]?.enabled;

  return (
    <div className={styles.videoWrapper} data-username={userName}>
      <video 
        ref={videoRef} 
        className={`${styles.videoElement} ${videoHidden ? styles.videoHidden : ''}`}
        autoPlay 
        playsInline 
        muted={muted} 
      />
      
      {/* Indicador de video apagado */}
      {videoHidden && (
        <div className={styles.videoPlaceholder}>
          <VideoOff size={48} />
          <p>{userName}</p>
        </div>
      )}
      
      <div className={styles.userNameTag}>{userName}</div>
      
      {(muted || (isLocal && stream?.getAudioTracks()[0]?.enabled === false)) && <div className={styles.muteIcon}><MicOff size={16} /></div>}
    </div>
  );
};

/* ================= VIDEO GRID ================= */
const VideoGrid = () => {
  const { myStream, peers, currentUserName } = useWebRTC();
  
  // Creamos una lista combinada de mi stream y los streams de los peers
  const allVideos = [
    // Mi stream (muted)
    ...(myStream ? [{ stream: myStream, userName: `${currentUserName} (Tú)`, muted: true, isLocal: true, key: 'local-user' }] : []),
    // Streams de los otros usuarios
    ...Object.entries(peers).map(([id, p]) => ({ stream: p.stream, userName: p.userName, key: id, muted: false })),
  ];

  return (
    <div className={styles.videoGridContainer}>
      {/* videoSecondaryGrid ahora contiene todos los videos y maneja la cuadrícula */}
      <div className={styles.videoSecondaryGrid}>
        {allVideos.map((p) => (
          <VideoPlayer key={p.key} stream={p.stream} userName={p.userName} muted={p.muted} isLocal={p.isLocal} />
        ))}
      </div>
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

// Componente para el menú flotante en móvil (Controles secundarios)
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
    toggleMute, toggleVideo, sendThemeChange, 
    isMuted, isVideoOff, appTheme 
  } = useWebRTC();
  
  // Detección de móvil para alternar el menú
  const [isMobile, setIsMobile] = useState(window.innerWidth <= 768);
  const [openMobileMenu, setOpenMobileMenu] = useState(false);

  useEffect(() => {
    const handleResize = () => {
        setIsMobile(window.innerWidth <= 768);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);
  
  // Placeholder para Compartir Pantalla 
  const ScreenShareButton = () => (
    <button className={styles.controlButton} title="Compartir Pantalla">
      {/* Icono de Pantalla Compartida */}
      <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-screen-share"><path d="M13 3H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8"/><path d="m17 14 5-5-5-5"/><path d="M22 9h-7"/></svg>
    </button>
  );


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
        {/* Placeholder para Compartir Pantalla */}
        <ScreenShareButton />
        
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
    // Simulación de espera para la conexión
    await new Promise(resolve => setTimeout(resolve, 500)); 
    onJoin(name);
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
        <button type="submit" className={styles.joinButton} disabled={loading}>
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
  const logic = useWebRTCLogic('room');

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
    window.location.reload(); 
  };

  // Aplica el tema al body
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