const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs');
const compression = require('compression');
const winston = require('winston');
const cluster = require('cluster');
const numCPUs = require('os').cpus().length;

function initWorker() {
  const app = express();
  const server = http.createServer(app);

  const io = socketIo(server, {
    path: '/vivo',
    connectionStateRecovery: {},
    maxHttpBufferSize: 1e6,
    pingTimeout: 10000,
    pingInterval: 5000,
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
      credentials: false
    },
    allowEIO3: true,
    transports: ['polling', 'websocket'],
    upgrade: true,
    forceNew: true,
    reconnection: true,
    reconnectionAttempts: 5,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000
  });

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

  app.use(compression());

  const rooms = new Map();
  const userSockets = new WeakMap();
  const errorStats = {
    websocket: 0,
    connection: 0,
    transport: 0,
    lastErrors: []
  };

  function log(room, message, level = 'info', error = null) {
    const logData = {
      workerId: process.pid,
      room,
      message,
      timestamp: new Date().toISOString(),
      error: error ? {
        message: error.message,
        stack: error.stack
      } : null
    };
    logger[level](logData);
  }

  app.get('/status', (req, res) => {
    const stats = {
      memoria: process.memoryUsage(),
      rooms: Array.from(rooms).map(([name, clients]) => ({
        name,
        clientCount: clients.size
      })),
      conexiones: {
        total: io.engine.clientsCount,
        sockets: Array.from(io.sockets.sockets).map(([id, socket]) => ({
          id,
          rooms: Array.from(socket.rooms),
          transport: socket.conn.transport.name
        }))
      },
      errores: errorStats,
      uptime: process.uptime()
    };
    res.json(stats);
  });

  app.get('/monitor', (req, res) => {
    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Monitor Socket.IO</title>
          <meta charset="UTF-8">
          <style>
            body { font-family: Arial; margin: 20px; }
            .section { margin: 20px 0; padding: 10px; border: 1px solid #ddd; }
            .error { color: red; }
          </style>
          <script>
            function updateStats() {
              fetch('/status')
                .then(r => r.json())
                .then(stats => {
                  document.getElementById('stats').innerHTML = 
                    '<pre>' + JSON.stringify(stats, null, 2) + '</pre>';
                });
            }
            setInterval(updateStats, 5000);
            updateStats();
          </script>
        </head>
        <body>
          <h1>Monitor Socket.IO</h1>
          <div id="stats"></div>
        </body>
      </html>
    `;
    res.send(html);
  });

  io.on('connection', (socket) => {
    const userId = socket.handshake.query.userId;
    log('general', `Nueva conexión: ${socket.id} (userId: ${userId || 'anónimo'})`);

    socket.conn.on('upgrade', (transport) => {
      log('general', `Transporte actualizado a: ${transport.name}`);
    });

    socket.conn.on('error', (error) => {
      errorStats.transport++;
      errorStats.lastErrors.push({
        type: 'transport',
        message: error.message,
        time: new Date()
      });
      if (errorStats.lastErrors.length > 10) errorStats.lastErrors.shift();
      log('general', `Error de transporte: ${error.message}`, 'error', error);
    });

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

  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    log('general', `Worker ${process.pid} iniciado en puerto ${PORT}`);
  });
}

if (cluster.isMaster) {
  console.log(`Master ${process.pid} iniciando`);
  const workerCount = Math.min(numCPUs, 2);

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

process.on('uncaughtException', (error) => {
  console.error('Error no capturado', error);
  if (process.env.NODE_ENV === 'production') {
    process.exit(1);
  }
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Promesa rechazada no manejada', reason);
});