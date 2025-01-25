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

io.on('connection', (socket) => {
  log('general', 'Nueva conexión establecida.'); // Log general para conexión

  // Unir al cliente a la room adecuada según el entorno
  socket.on('joinRoom', (entornoConModulo) => { // Renombrar parámetro para claridad
    const room = entornoConModulo; // Usar el entorno completo como nombre de sala
    socket.join(room);
    log(room, `Cliente unido a la room: ${room}`); // Log específico de la room

    socket.on('actualizarEstadoVenta', (data) => {
      log(room, `Mensaje recibido en ${room}: ` + JSON.stringify(data)); // Log específico de la room

      if (data.venta_id && data.estado_nuevo) {
        log(room, `Actualización de estado de la venta recibida: Venta ID ${data.venta_id}, Nuevo Estado ${data.estado_nuevo}`); // Log específico de la room

        // Emitir solo a la room correspondiente
        io.to(room).emit('actualizarEstadoVenta', data);
      } else {
        log(room, 'Mensaje recibido con formato incorrecto.'); // Log específico de la room
      }
    });
    
    socket.on('nuevoComentario', (data) => {
      log(room, `Mensaje recibido en ${room}: ` + JSON.stringify(data)); // Log específico de la room

      if (data.venta_id && data.estado_nuevo) {
        log(room, `Comentario de la venta recibida: Venta ID ${data.venta_id}, Nuevo Estado ${data.estado_nuevo}`); // Log específico de la room

        // Emitir solo a la room correspondiente
        io.to(room).emit('nuevoComentario', data);
      } else {
        log(room, 'Mensaje recibido con formato incorrecto.'); // Log específico de la room
      }
    });
  });

  // Manejo de desconexión
  socket.on('disconnect', () => {
    log('general', 'Conexión cerrada.'); // Log general para desconexión
  });

  socket.on('error', (err) => {
    log('general', 'Error en la conexión: ' + err); // Log general para error
  });
});

// Servir archivos estáticos (opcional)
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.send('Servidor Socket.IO está en funcionamiento');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  log('general', `Servidor escuchando en el puerto ${PORT}`); // Log general para inicio del servidor
});