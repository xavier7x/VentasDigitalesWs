const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { availableParallelism } = require('os');
const cluster = require('cluster');
const { createAdapter, setupPrimary } = require('@socket.io/cluster-adapter');

if (cluster.isPrimary) {
  const numCPUs = availableParallelism();
  console.log(`🖥️ Iniciando en modo cluster con ${numCPUs} núcleos.`);

  // Crea un worker por cada núcleo disponible
  for (let i = 0; i < numCPUs; i++) {
    cluster.fork({ PORT: 3000 + i });
  }

  // Configurar el adaptador en el hilo principal
  setupPrimary();

  // Manejo de reinicio automático de workers si fallan
  cluster.on('exit', (worker, code, signal) => {
    console.warn(`⚠️ Worker ${worker.process.pid} cayó. Reiniciando...`);
    cluster.fork();
  });

} else {
  const app = express();
  const server = createServer(app);
  const io = new Server(server, {
    path: '/vivo',
    connectionStateRecovery: {
      maxDisconnectionDuration: 2 * 60 * 1000, // 2 minutos de recuperación de conexión
      skipMiddlewares: true,
    },
    cleanupEmptyChildNamespaces: true, // Eliminar namespaces vacíos
    pingTimeout: 30000, // Máximo 30s esperando ping
    pingInterval: 10000, // Enviar ping cada 10s
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
      credentials: false
    },
    adapter: createAdapter() // Configurar cluster-adapter para múltiples instancias
  });

  // Función de logs
  function log(room, message) {
    const timestamp = new Date().toISOString();
    console.log(`[${room}] ${timestamp} - ${message}`);
  }

  // Mapa para rastrear las salas activas y sus clientes
  const rooms = new Map();

  // Manejador de conexiones
  io.on('connection', (socket) => {
    log('general', `Nueva conexión establecida: ${socket.id}`);

    socket.on('joinRoom', (room) => {
      if (!rooms.has(room)) rooms.set(room, new Set());
      rooms.get(room).add(socket.id);
      socket.join(room);
      log(room, `Cliente ${socket.id} unido.`);
    });

    // Actualización de estado de venta
    socket.on('actualizarEstadoVenta', (data) => {
      try {
        const room = [...socket.rooms].find(r => r !== socket.id);
        if (room && data.venta_id && data.estado_nuevo) {
          io.to(room).emit('actualizarEstadoVenta', data);
          log(room, `Venta ID ${data.venta_id} actualizada a ${data.estado_nuevo}`);
        } else {
          log('general', `Error en actualizarEstadoVenta: datos inválidos - ${JSON.stringify(data)}`);
        }
      } catch (error) {
        log('general', `Error en actualizarEstadoVenta: ${error.message}`);
      }
    });

    // Nuevo comentario
    socket.on('nuevoComentario', (data) => {
      try {
        const room = [...socket.rooms].find(r => r !== socket.id);
        if (room && data.venta_id && data.comentario) {
          io.to(room).emit('nuevoComentario', data);
          log(room, `Nuevo comentario en venta ID ${data.venta_id}`);
        } else {
          log('general', `Error en nuevoComentario: datos inválidos - ${JSON.stringify(data)}`);
        }
      } catch (error) {
        log('general', `Error en nuevoComentario: ${error.message}`);
      }
    });

    // Manejo de desconexión
    socket.on('disconnecting', () => {
      const userRooms = [...socket.rooms].filter(r => r !== socket.id);
      userRooms.forEach(room => {
        if (rooms.has(room)) {
          rooms.get(room).delete(socket.id);
          log(room, `Cliente ${socket.id} eliminado antes de desconexión.`);
          if (rooms.get(room).size === 0) {
            rooms.delete(room);
            log('general', `Room ${room} eliminada por estar vacía.`);
          }
        }
      });
    });

    socket.on('disconnect', () => {
      log('general', `Cliente desconectado: ${socket.id}`);
    });

    socket.on('error', (err) => {
      log('general', `Error en la conexión: ${err.message}`);
    });
  });

  // Servir archivos estáticos
  app.use(express.static('public'));

  // Ruta de prueba
  app.get('/', (req, res) => {
    res.send('Servidor Socket.IO está en funcionamiento');
  });

  // Iniciar servidor
  const port = process.env.PORT || 3000;
  server.listen(port, () => {
    log('general', `Servidor escuchando en puerto ${port} - Worker ${process.pid}`);
  });
}
