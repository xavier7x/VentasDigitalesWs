import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { availableParallelism } from 'node:os';
import cluster from 'node:cluster';
import { createAdapter, setupPrimary } from '@socket.io/cluster-adapter';
import morgan from 'morgan'; // Logs HTTP en consola

// Número de CPUs disponibles
if (cluster.isPrimary) {
  const numCPUs = availableParallelism();

  // Crear un worker por cada núcleo disponible
  for (let i = 0; i < numCPUs; i++) {
    cluster.fork({
      PORT: 3000 + i
    });
  }

  // Configurar el adaptador en el hilo principal
  setupPrimary();
} else {
  const app = express();
  const server = createServer(app);
  const io = new Server(server, {
    connectionStateRecovery: {
      maxDisconnectionDuration: 2 * 60 * 1000, // 2 minutos para recuperación de conexión
      skipMiddlewares: true, // Omitir middlewares en reconexión
    },
    adapter: createAdapter(), // Configuración del adaptador de cluster
  });

  // Middleware de Morgan para ver logs en consola
  app.use(morgan('dev'));

  // Mapa para rastrear usuarios y salas
  const rooms = new Map(); // { roomName: Set<socketId> }
  const userSockets = new Map(); // { userId: Set<socketId> }

  const disconnectTimeout = 60000; // Tiempo de desconexión por inactividad (60s)

  io.on('connection', (socket) => {
    const userId = socket.handshake.query.userId; // Obtener userId desde la query

    console.log(`🔗 Usuario conectado: ${socket.id} - userId: ${userId || 'anónimo'}`);

    // Asignar socket a userId
    if (userId) {
      if (!userSockets.has(userId)) {
        userSockets.set(userId, new Set());
      }
      userSockets.get(userId).add(socket.id);
    }

    // Manejo de recuperación de estado de conexión
    if (socket.recovered) {
      console.log(`♻️ Conexión recuperada: ${socket.id}`);
    }

    // Unir usuario a una sala específica
    socket.on('join room', (room) => {
      if (!rooms.has(room)) {
        rooms.set(room, new Set());
      }
      rooms.get(room).add(socket.id);
      socket.join(room);

      console.log(`🏠 Usuario ${socket.id} unido a la sala: ${room}`);
    });

    // Evento de actualización de estado de venta
    socket.on('actualizarEstadoVenta', (data, room) => {
      io.to(room).emit('actualizarEstadoVenta', data);
      console.log(`📢 Estado de venta actualizado en room ${room}:`, data);
    });

    // Evento de nuevo comentario
    socket.on('nuevoComentario', (data, room) => {
      io.to(room).emit('nuevoComentario', data);
      console.log(`💬 Nuevo comentario en room ${room}:`, data);
    });

    // Manejo de inactividad (auto desconexión)
    let disconnectTimer;
    socket.on('activity', () => {
      clearTimeout(disconnectTimer);
      disconnectTimer = setTimeout(() => {
        socket.disconnect(true);
      }, disconnectTimeout);
    });

    // Manejo de desconexión
    socket.on('disconnect', () => {
      console.log(`❌ Usuario desconectado: ${socket.id}`);

      if (userId && userSockets.has(userId)) {
        const sockets = userSockets.get(userId);
        sockets.delete(socket.id);
        if (sockets.size === 0) {
          userSockets.delete(userId);
        }
      }

      // Eliminar usuario de todas las salas
      for (const [room, clients] of rooms.entries()) {
        if (clients.has(socket.id)) {
          clients.delete(socket.id);
          console.log(`🚪 Usuario ${socket.id} removido de la sala: ${room}`);
          if (clients.size === 0) {
            rooms.delete(room);
          }
        }
      }
    });
  });

  // Endpoint para consultar el estado de las salas
  app.get('/rooms', (req, res) => {
    const roomStatus = {};
    for (const [room, clients] of rooms.entries()) {
      roomStatus[room] = Array.from(clients);
    }
    res.json(roomStatus);
  });

  // Configuración de CORS
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*'); // 🔥 Permitir cualquier origen
    res.header('Access-Control-Allow-Methods', 'GET, POST');
    next();
  });

  // Cada worker escuchará en un puerto distinto
  const port = process.env.PORT || 3000;
  server.listen(port, () => {
    console.log(`✅ Servidor Socket.IO ejecutándose en http://localhost:${port}`);
  });
}
