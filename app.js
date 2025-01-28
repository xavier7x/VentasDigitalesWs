// Servidor
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const bodyParser = require('body-parser');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const disconnectTimeout = 60000;

io.on('connection', (socket) => {
    console.log('Usuario conectado');

    socket.on('join room', (room) => {
        socket.join(room);
        console.log(`Usuario unido a room: ${room}`);
    });

    socket.on('actualizarEstadoVenta', (data, room) => {
        io.to(room).emit('actualizarEstadoVenta', data);
    });

    socket.on('nuevoComentario', (data, room) => {
        io.to(room).emit('nuevoComentario', data);
    });

    let disconnectTimer;
    socket.on('activity', () => {
        clearTimeout(disconnectTimer);
        disconnectTimer = setTimeout(() => {
            socket.disconnect(true);
        }, disconnectTimeout);
    });

    socket.on('disconnecting', () => {
        const rooms = Object.keys(socket.rooms);
        rooms.forEach((room) => {
            io.to(room).emit('user disconnected', socket.id);
        });
    });

    socket.on('disconnect', () => {
        console.log('Usuario desconectado');
        clearTimeout(disconnectTimer);
    });
});

app.use(bodyParser.json());

// Manejo de CORS
app.use((req, res, next) => {
    const allowedOrigins = ['https://app.victormaman.com/administracion/', 'https://app.victormaman.com/', 'https://dev.victormaman.com/administracion/', 'https://dev.victormaman.com/'];
    const origin = req.headers.origin;
    
    if (allowedOrigins.includes(origin)) {
        res.header('Access-Control-Allow-Origin', origin);
    }
    res.header('Access-Control-Allow-Methods', 'GET, POST');
    next();
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor Socket.IO escuchando en puerto ${PORT}`);
});
