const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Arena state management
const arenas = {
    10: { status: 'Lobby', takenBoxes: [], ballsDrawn: [], players: [], timer: null },
    20: { status: 'Lobby', takenBoxes: [], ballsDrawn: [], players: [], timer: null },
    50: { status: 'Lobby', takenBoxes: [], ballsDrawn: [], players: [], timer: null },
    100: { status: 'Lobby', takenBoxes: [], ballsDrawn: [], players: [], timer: null }
};

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // Send status of all arenas on request
    socket.on('getRoomsStatus', () => {
        const busyRooms = Object.keys(arenas)
            .filter(id => arenas[id].status === 'Playing')
            .map(Number);
        socket.emit('roomsStatusUpdate', busyRooms);
    });

    // Check if a box is taken
    socket.on('getTakenBoxes', (data, callback) => {
        const arena = arenas[data.room];
        if (arena) {
            callback(arena.takenBoxes);
        }
    });

    socket.on('checkBoxAvailability', (data, callback) => {
        const arena = arenas[data.room];
        if (!arena || arena.status === 'Playing') {
            return callback({ available: false });
        }
        const isTaken = arena.takenBoxes.includes(data.box);
        callback({ available: !isTaken });
    });

    // Join Arena
    socket.on('joinRoom', (data) => {
        const arena = arenas[data.room];
        if (!arena || arena.status === 'Playing') return;

        socket.join(data.room);
        arena.players.push({ id: socket.id, name: data.userName, box: data.box });
        arena.takenBoxes.push(data.box);

        // Broadcast updated taken boxes to everyone in lobby for this room
        io.emit('boxUpdate', { room: data.room, takenBoxes: arena.takenBoxes });

        // Start 15s countdown when the first player joins
        if (arena.players.length === 1 && !arena.timer) {
            startCountdown(data.room);
        }
    });

    // Handle Bingo Claim
    socket.on('claimBingo', (data) => {
        const arena = arenas[data.room];
        if (!arena || arena.status !== 'Playing') return;

        // In a production app, you would validate the 'grid' and 'marked' numbers here
        // For now, first claim wins
        const winner = arena.players.find(p => p.id === socket.id);
        const prize = data.room * arena.players.length * 0.9; // 10% House edge

        io.to(data.room).emit('gameOver', {
            room: data.room,
            winnerId: socket.id,
            winnerName: winner ? winner.name : "Elite Player",
            prize: prize
        });

        resetArena(data.room);
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
    });
});

function startCountdown(roomId) {
    const arena = arenas[roomId];
    let count = 15;

    arena.timer = setInterval(() => {
        count--;
        if (count <= 0) {
            clearInterval(arena.timer);
            arena.status = 'Playing';
            
            // Tell everyone globally that this room is now busy
            const busyRooms = Object.keys(arenas).filter(id => arenas[id].status === 'Playing').map(Number);
            io.emit('roomsStatusUpdate', busyRooms);
            
            startGameLoop(roomId);
        }
    }, 1000);
}

function startGameLoop(roomId) {
    const arena = arenas[roomId];
    
    const gameInterval = setInterval(() => {
        // Stop if room was reset (someone won) or 75 balls reached
        if (arena.status === 'Lobby') {
            clearInterval(gameInterval);
            return;
        }

        if (arena.ballsDrawn.length >= 75) {
            clearInterval(gameInterval);
            io.to(roomId).emit('gameOver', { room: roomId, winnerId: null, winnerName: "House", prize: 0 });
            resetArena(roomId);
            return;
        }

        // Generate unique ball 1-75
        let ball;
        do {
            ball = Math.floor(Math.random() * 75) + 1;
        } while (arena.ballsDrawn.includes(ball));

        arena.ballsDrawn.push(ball);
        io.to(roomId).emit('ballDrawn', { room: roomId, num: ball });

    }, 4000); // New ball every 4 seconds
}

function resetArena(roomId) {
    const arena = arenas[roomId];
    if (arena.timer) clearInterval(arena.timer);
    
    arenas[roomId] = {
        status: 'Lobby',
        takenBoxes: [],
        ballsDrawn: [],
        players: [],
        timer: null
    };

    // Broadcast that room is now open
    const busyRooms = Object.keys(arenas).filter(id => arenas[id].status === 'Playing').map(Number);
    io.emit('roomsStatusUpdate', busyRooms);
    io.emit('boxUpdate', { room: roomId, takenBoxes: [] });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Bingo Server running on port ${PORT}`);
});
