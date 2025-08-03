import React, { useEffect, useRef, useState } from 'react';
import Peer from 'peerjs';
import { io } from 'socket.io-client';
import './App.css';

const App = () => {
  const [peers, setPeers] = useState({});
  const [myStream, setMyStream] = useState(null);
  const [myScreenStream, setMyScreenStream] = useState(null);
  const socketRef = useRef(null);
  const myVideoRef = useRef();
  const myPeerRef = useRef();
  const peerConnections = useRef({});
  const currentUserNameRef = useRef("Yo");

  useEffect(() => {
    const init = async () => {
      socketRef.current = io('https://meet-clone-v0ov.onrender.com'); // Ajusta según tu servidor

      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      setMyStream(stream);
      myVideoRef.current.srcObject = stream;

      myPeerRef.current = new Peer(undefined, { host: '/', port: '3001' });

      myPeerRef.current.on('open', id => {
        socketRef.current.emit('join-room', { roomId: 'sala1', userId: id, userName: currentUserNameRef.current });
      });

      myPeerRef.current.on('call', call => {
        call.answer(stream);

        call.on('stream', userVideoStream => {
          const callerId = call.peer + (call.metadata?.isScreenShare ? '_screen' : '');
          setPeers(prev => ({
            ...prev,
            [callerId]: {
              stream: userVideoStream,
              userName: call.metadata?.userName || "Usuario",
              isScreenShare: call.metadata?.isScreenShare || false,
            },
          }));
        });

        call.on('close', () => {
          const callerId = call.peer + (call.metadata?.isScreenShare ? '_screen' : '');
          removePeer(callerId);
        });

        peerConnections.current[call.peer + (call.metadata?.isScreenShare ? '_screen' : '')] = call;
      });

      socketRef.current.on('user-connected', ({ userId, userName }) => {
        connectToNewUser(userId, stream, userName);
        if (myScreenStream) {
          shareScreenToUser(userId, myScreenStream, userName);
        }
      });

      socketRef.current.on('user-disconnected', userId => {
        removePeer(userId);
        removePeer(userId + '_screen');
      });

      socketRef.current.on('stop-screen-share', () => {
        Object.keys(peers).forEach(key => {
          if (key.endsWith('_screen')) removePeer(key);
        });
      });
    };

    init();
  }, []);

  const connectToNewUser = (userId, stream, userName) => {
    const call = myPeerRef.current.call(userId, stream, {
      metadata: { userName, isScreenShare: false },
    });

    call.on('stream', userVideoStream => {
      setPeers(prev => ({
        ...prev,
        [userId]: { stream: userVideoStream, userName, isScreenShare: false },
      }));
    });

    call.on('close', () => {
      removePeer(userId);
    });

    peerConnections.current[userId] = call;
  };

  const shareScreenToUser = (userId, screenStream, userName) => {
    const call = myPeerRef.current.call(userId, screenStream, {
      metadata: { userName, isScreenShare: true },
    });

    call.on('close', () => {
      removePeer(userId + '_screen');
    });

    peerConnections.current[userId + '_screen'] = call;
  };

  const removePeer = (peerId) => {
    setPeers(prev => {
      const updated = { ...prev };
      delete updated[peerId];
      return updated;
    });

    if (peerConnections.current[peerId]) {
      peerConnections.current[peerId].close();
      delete peerConnections.current[peerId];
    }
  };

  const shareScreen = async () => {
    if (myScreenStream) {
      myScreenStream.getTracks().forEach(track => track.stop());
      socketRef.current.emit('stop-screen-share');
      setMyScreenStream(null);
      Object.keys(peerConnections.current).forEach(key => {
        if (key.endsWith('_screen')) removePeer(key);
      });
      return;
    }

    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      setMyScreenStream(screenStream);

      screenStream.getVideoTracks()[0].onended = () => {
        setMyScreenStream(null);
        socketRef.current.emit('stop-screen-share');
        Object.keys(peerConnections.current).forEach(key => {
          if (key.endsWith('_screen')) removePeer(key);
        });
      };

      Object.keys(peerConnections.current).forEach(peerKey => {
        if (!peerKey.endsWith('_screen')) {
          const peerId = peerKey;
          if (peerId === myPeerRef.current.id) return;

          shareScreenToUser(peerId, screenStream, currentUserNameRef.current);
        }
      });

    } catch (err) {
      console.error("Error al compartir pantalla:", err);
    }
  };

  return (
    <div className="app">
      <div className="controls">
        <button onClick={shareScreen}>
          {myScreenStream ? "Dejar de compartir pantalla" : "Compartir pantalla"}
        </button>
      </div>

      <div className="videos-container">
        <div className="video-wrapper">
          <video ref={myVideoRef} autoPlay muted playsInline />
          <div className="video-label">{currentUserNameRef.current} (Tú)</div>
        </div>
        {Object.entries(peers).map(([peerId, peerData]) => (
          <div className="video-wrapper" key={peerId}>
            <video
              ref={video => {
                if (video && peerData.stream) video.srcObject = peerData.stream;
              }}
              autoPlay
              playsInline
            />
            <div className="video-label">
              {peerData.userName} {peerData.isScreenShare ? "(Pantalla)" : ""}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default App;
