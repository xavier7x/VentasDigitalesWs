const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs');
const compression = require('compression');
const winston = require('winston');
const cluster = require('cluster');
const numCPUs = require('os').cpus().length;

// Función para iniciar el servidor worker
function initWorker() {
  const app = express();
  const server = http.createServer(app);

  // Configuración de Socket.IO sin forzar websocket
  const io = socketIo(server, {
    path: '/vivo',
    connectionStateRecovery: {},
    maxHttpBufferSize: 1e6, // 1 MB
    pingTimeout: 30000,
    pingInterval: 10000,
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
      credentials: false
    },
    // Configuración para hosting compartido
    allowEIO3: true, // Permite compatibilidad con versiones anteriores
    transports: ['polling', 'websocket'], // Permite polling como fallback
    upgrade: true // Permite actualizar de polling a websocket
  });

  // Configuración de Winston y directorio de logs
  const LOG_DIRECTORY = path.join(__dirname, '/logs');
  if (!fs.existsSync(LOG_DIRECTORY)) {
    fs.mkdirSync(LOG_DIRECTORY);
  }

  const logger = winston.createLogger({
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.json()
    ),
    transports: [
      new winston.transports.File({ 
        filename: path.join(LOG_DIRECTORY, `worker-${process.pid}-error.log`), 
        level: 'error',
        maxsize: 5242880,
        maxFiles: 5
      }),
      new winston.transports.File({ 
        filename: path.join(LOG_DIRECTORY, `worker-${process.pid}-combined.log`),
        maxsize: 5242880,
        maxFiles: 5
      })
    ]
  });

  // Middleware
  app.use(compression());

  // Estructuras de datos compartidas
  const rooms = new Map();
  const userSockets = new WeakMap();

  // Función de logging
  function log(room, message, level = 'info') {
    const logData = {
      workerId: process.pid,
      room,
      message,
      timestamp: new Date().toISOString()
    };
    logger[level](logData);
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[Worker ${process.pid}][${room}] ${message}`);
    }
  }

  // Manejo de conexiones Socket.IO
  io.on('connection', (socket) => {
    const userId = socket.handshake.query.userId;
    log('general', `Nueva conexión: ${socket.id} (userId: ${userId || 'anónimo'})`);

    if (userId) {
      const userSocketSet = userSockets.get(userId) || new Set();
      userSocketSet.add(socket.id);
      userSockets.set(userId, userSocketSet);
    }

    socket.on('joinRoom', (entornoConModulo) => {
      const room = entornoConModulo;
      
      try {
        if (!rooms.has(room)) {
          rooms.set(room, new Set());
        }
        rooms.get(room).add(socket.id);
        socket.join(room);
        
        log(room, `Cliente ${socket.id} unido a room: ${room}`);

        // Eventos de sala
        socket.on('actualizarEstadoVenta', (data) => {
          try {
            if (!data?.venta_id || !data?.estado_nuevo) {
              throw new Error('Datos incompletos');
            }
            io.to(room).emit('actualizarEstadoVenta', data);
            log(room, `Actualización venta ID ${data.venta_id}`);
          } catch (error) {
            log(room, `Error en actualizarEstadoVenta: ${error.message}`, 'error');
          }
        });

        socket.on('nuevoComentario', (data) => {
          try {
            if (!data?.venta_id || !data?.estado_nuevo) {
              throw new Error('Datos incompletos');
            }
            io.to(room).emit('nuevoComentario', data);
            log(room, `Nuevo comentario en venta ID ${data.venta_id}`);
          } catch (error) {
            log(room, `Error en nuevoComentario: ${error.message}`, 'error');
          }
        });
      } catch (error) {
        log('general', `Error al unirse a room: ${error.message}`, 'error');
      }
    });

    socket.on('disconnect', () => {
      try {
        log('general', `Desconexión: ${socket.id}`);

        if (userId && userSockets.has(userId)) {
          const userSocketSet = userSockets.get(userId);
          userSocketSet.delete(socket.id);
          if (userSocketSet.size === 0) {
            userSockets.delete(userId);
          }
        }

        for (const [room, clients] of rooms.entries()) {
          if (clients.has(socket.id)) {
            clients.delete(socket.id);
            log(room, `Cliente ${socket.id} removido de room: ${room}`);

            if (clients.size === 0) {
              rooms.delete(room);
              log('general', `Room eliminada: ${room}`);
            }
          }
        }
      } catch (error) {
        log('general', `Error en disconnect: ${error.message}`, 'error');
      }
    });

    socket.on('error', (error) => {
      log('general', `Error de socket: ${error.message}`, 'error');
    });
  });

  // Endpoints
  app.get('/health', (req, res) => {
    res.json({
      status: 'OK',
      workerId: process.pid,
      uptime: process.uptime()
    });
  });

  // Iniciar servidor
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    log('general', `Worker ${process.pid} iniciado en puerto ${PORT}`);
  });
}

// Iniciar cluster
if (cluster.isMaster) {
  console.log(`Master ${process.pid} iniciando`);

  // Limitar el número de workers en hosting compartido
  const workerCount = Math.min(numCPUs, 2); // Máximo 2 workers en hosting compartido

  // Crear workers
  for (let i = 0; i < workerCount; i++) {
    cluster.fork();
  }

  cluster.on('exit', (worker, code, signal) => {
    console.log(`Worker ${worker.process.pid} murió. Reiniciando...`);
    cluster.fork();
  });
} else {
  initWorker();
}

// Manejo de errores no capturados
process.on('uncaughtException', (error) => {
  console.error('Error no capturado', error);
  if (process.env.NODE_ENV === 'production') {
    process.exit(1);
  }
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Promesa rechazada no manejada', reason);
});