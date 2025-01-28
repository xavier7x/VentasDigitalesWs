const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  path: '/vivo',
  connectionStateRecovery: { 
    maxDisconnectionDuration: 2 * 60 * 1000, // 2 minutos para recuperación de conexión
    skipMiddlewares: true, // Omitir middlewares en reconexión
  },
  //transports: ['websocket'], // Compatibilidad con cliente (solo websocket)
  pingTimeout: 30000, // Tiempo máximo para esperar un ping (30 segundos)
  pingInterval: 10000, // Intervalo para enviar pings (10 segundos)
  cors: {
    origin: "*", // Permitir cualquier origen
    methods: ["GET", "POST"], // Métodos permitidos
    credentials: false // Si deseas aceptar cookies, cambia a true
  }
});

// Función para registrar logs en un archivo, ahora acepta el nombre de la room
function log(room, message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;
  // Nombre de archivo de log dinámico basado en la room
  const logFileName = `app_${room}.log`;
  fs.appendFile(logFileName, logMessage, err => {
    if (err) {
      console.error(`Error al escribir en el archivo de log para la room ${room}:`, err);
    }
  });
  console.log(`[${room}] ${logMessage.trim()}`); // Añadir prefijo de room a la consola
}

// Mapa para rastrear las salas activas y sus clientes
const rooms = new Map(); // { roomName: Set<socketId> }

io.on('connection', (socket) => {
  log('general', `Nueva conexión establecida: ${socket.id}`); // Log general para conexión

  // Unir al cliente a la room adecuada
  socket.on('joinRoom', (entornoConModulo) => {
    const room = entornoConModulo;

    if (!rooms.has(room)) {
      rooms.set(room, new Set());
    }
    rooms.get(room).add(socket.id);
    socket.join(room);
    log(room, `Cliente ${socket.id} unido a la room: ${room}`);
  });

  // Evento de actualización de estado de venta
  socket.on('actualizarEstadoVenta', (data) => {
    const room = Array.from(socket.rooms).find((r) => r !== socket.id);
    if (!room) {
      log('general', `Error: Cliente ${socket.id} no está en ninguna room.`);
      return;
    }
    if (data.venta_id && data.estado_nuevo) {
      log(room, `Estado de venta actualizado: Venta ID ${data.venta_id}, Nuevo Estado ${data.estado_nuevo}`);
      io.to(room).emit('actualizarEstadoVenta', data);
    } else {
      log(room, `Error: Datos de venta incompletos - ${JSON.stringify(data)}`);
    }
  });

  // Evento de nuevo comentario
  socket.on('nuevoComentario', (data) => {
    const room = Array.from(socket.rooms).find((r) => r !== socket.id);
    if (!room) {
      log('general', `Error: Cliente ${socket.id} no está en ninguna room.`);
      return;
    }
    if (data.venta_id && data.comentario) {
      log(room, `Nuevo comentario: Venta ID ${data.venta_id}, Comentario: ${data.comentario}`);
      io.to(room).emit('nuevoComentario', data);
    } else {
      log(room, `Error: Datos de comentario incompletos - ${JSON.stringify(data)}`);
    }
  });

  socket.on('disconnecting', () => {
    const userRooms = Array.from(socket.rooms).filter(r => r !== socket.id);
    userRooms.forEach(room => {
      if (rooms.has(room)) {
        rooms.get(room).delete(socket.id);
        log(room, `Cliente ${socket.id} eliminando antes de desconexión.`);
      }
    });
  });

  // Manejo de desconexión
  socket.on('disconnect', () => {
    log('general', `Cliente desconectado: ${socket.id}`);
    for (const [room, clients] of rooms.entries()) {
      if (clients.has(socket.id)) {
        clients.delete(socket.id);
        log(room, `Cliente ${socket.id} removido de la room: ${room}`);
        if (clients.size === 0) {
          rooms.delete(room);
          log('general', `Room ${room} eliminada por estar vacía`);
        }
        break;
      }
    }
  });

  // Manejo de errores
  socket.on('error', (err) => {
    log('general', `Error en la conexión: ${err.message}`);
  });
});

// Servir archivos estáticos (opcional)
app.use(express.static(path.join(__dirname, 'public')));

// Ruta de prueba
app.get('/', (req, res) => {
  res.send('Servidor Socket.IO está en funcionamiento');
});

// Iniciar servidor
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  log('general', `Servidor escuchando en el puerto ${PORT}`);
});
