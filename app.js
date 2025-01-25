const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  path: '/vivo',
  transports: ['websocket'], // Asegurar compatibilidad con cliente
  pingTimeout: 30000, // Tiempo máximo para esperar un ping (30 segundos)
  pingInterval: 10000, // Intervalo para enviar pings (10 segundos)
  cors: {
    origin: "*", // Permitir cualquier origen
    methods: ["GET", "POST"], // Métodos permitidos
    credentials: false // Si deseas aceptar cookies, cambia a true
  }
});

// Mapa para rastrear las salas y los usuarios conectados
const rooms = new Map(); // { roomName: Set<socketId> }

// Directorio donde se almacenan los logs
const LOG_DIRECTORY = path.join(__dirname, '/logs');

// Crear el directorio de logs si no existe
if (!fs.existsSync(LOG_DIRECTORY)) {
  fs.mkdirSync(LOG_DIRECTORY);
}

// Función para registrar logs
function log(room, message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;
  const logFileName = path.join(LOG_DIRECTORY, `app_${room}.log`);
  fs.appendFile(logFileName, logMessage, (err) => {
    if (err) {
      console.error(`Error al escribir en el archivo de log para la room ${room}:`, err);
    }
  });
  console.log(`[${room}] ${logMessage.trim()}`);
}

// Función para limpiar logs antiguos
function limpiarLogsAntiguos(dias) {
  const ahora = Date.now();
  const limiteTiempo = dias * 24 * 60 * 60 * 1000; // Convertir días a milisegundos

  fs.readdir(LOG_DIRECTORY, (err, files) => {
    if (err) {
      console.error('Error al leer el directorio de logs:', err);
      return;
    }

    files.forEach((file) => {
      const filePath = path.join(LOG_DIRECTORY, file);

      fs.stat(filePath, (err, stats) => {
        if (err) {
          console.error(`Error al obtener la información del archivo ${file}:`, err);
          return;
        }

        // Verificar si el archivo es más antiguo que el límite de tiempo
        if (ahora - stats.mtimeMs > limiteTiempo) {
          fs.unlink(filePath, (err) => {
            if (err) {
              console.error(`Error al eliminar el archivo de log ${file}:`, err);
            } else {
              console.log(`Archivo de log eliminado: ${file}`);
            }
          });
        }
      });
    });
  });
}

// Programar limpieza de logs cada tres días
const INTERVALO_LIMPIEZA = 3 * 24 * 60 * 60 * 1000; // Tres días en milisegundos
setInterval(() => limpiarLogsAntiguos(3), INTERVALO_LIMPIEZA);

io.on('connection', (socket) => {
  log('general', `Nueva conexión establecida: ${socket.id}`);

  // Unir al cliente a una sala (room)
  socket.on('joinRoom', (entornoConModulo) => {
    const room = entornoConModulo;

    // Registrar al usuario en la sala
    if (!rooms.has(room)) {
      rooms.set(room, new Set());
    }
    rooms.get(room).add(socket.id);
    socket.join(room);

    log(room, `Cliente ${socket.id} unido a la room: ${room}`);

    // Escuchar eventos en la sala
    socket.on('actualizarEstadoVenta', (data) => {
      log(room, `Mensaje recibido en ${room}: ` + JSON.stringify(data));
      if (data.venta_id && data.estado_nuevo) {
        io.to(room).emit('actualizarEstadoVenta', data); // Emitir evento a la sala
        log(room, `Emitido a room ${room}: Actualización de venta ID ${data.venta_id}`);
      } else {
        log(room, 'Mensaje recibido con formato incorrecto.');
      }
    });

    socket.on('nuevoComentario', (data) => {
      log(room, `Mensaje recibido en ${room}: ` + JSON.stringify(data));
      if (data.venta_id && data.estado_nuevo) {
        io.to(room).emit('nuevoComentario', data); // Emitir evento a la sala
        log(room, `Emitido a room ${room}: Comentario en venta ID ${data.venta_id}`);
      } else {
        log(room, 'Mensaje recibido con formato incorrecto.');
      }
    });
  });

  // Manejo de desconexión
  socket.on('disconnect', () => {
    log('general', `Conexión cerrada: ${socket.id}`);

    // Remover al usuario de todas las salas
    for (const [room, clients] of rooms.entries()) {
      if (clients.has(socket.id)) {
        clients.delete(socket.id);
        log(room, `Cliente ${socket.id} removido de la room: ${room}`);

        // Eliminar la sala si queda vacía
        if (clients.size === 0) {
          rooms.delete(room);
          log('general', `Room eliminada porque quedó vacía: ${room}`);
        }
      }
    }
  });

  // Manejo de errores
  socket.on('error', (err) => {
    log('general', `Error en la conexión de ${socket.id}: ${err}`);
  });
});

// Endpoint para consultar el estado de las salas
app.get('/api/rooms', (req, res) => {
  const roomStatus = {};
  for (const [room, clients] of rooms.entries()) {
    roomStatus[room] = Array.from(clients); // Mostrar IDs de clientes en cada sala
  }
  res.json(roomStatus); // Respuesta en formato JSON
});

// Servir archivos estáticos (opcional)
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.send('Servidor Socket.IO está en funcionamiento');
});

// Iniciar el servidor
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  log('general', `Servidor escuchando en el puerto ${PORT}`);
});
