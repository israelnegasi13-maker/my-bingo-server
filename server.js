const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();

// Apply CORS middleware for Express
app.use(cors());

const server = http.createServer(app);

// Apply CORS configuration for Socket.io
const io = new Server(server, {
    cors: { 
        origin: "*", 
        methods: ["GET", "POST"] 
    }
});

// State management for rooms
const rooms = {
    "10": { players: new Map(), drawnNumbers: [], usedCartelas: new Set(), interval: null },
    "20": { players: new Map(), drawnNumbers: [], usedCartelas: new Set(), interval: null },
    "50": { players: new Map(), drawnNumbers: [], usedCartelas: new Set(), interval: null },
    "100": { players: new Map(), drawnNumbers: [], usedCartelas: new Set(), interval: null }
};

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // 1. Check if a Cartela (Card) is taken in a specific room
    socket.on('checkCartela', ({ room, cartelaId }, callback) => {
        const roomData = rooms[room.toString()];
        if (!roomData) return callback({ available: true });
        
        const isTaken = roomData.usedCartelas.has(cartelaId);
        callback({ available: !isTaken });
    });

    // 2. Join a specific stake room
    socket.on('joinRoom', ({ room, cartelaId, userName }) => {
        const roomStr = room.toString();
        const roomData = rooms[roomStr];

        if (!roomData) return;

        // Leave previous rooms if any
        socket.rooms.forEach(r => { if(r !== socket.id) socket.leave(r); });

        // Join the new socket.io room
        socket.join(roomStr);
        
        // Register player and card
        roomData.players.set(socket.id, { userName, cartelaId });
        roomData.usedCartelas.add(cartelaId);

        console.log(`${userName} joined ${roomStr} ETB room with card ${cartelaId}`);

        // Start ball drawing loop if this is the first player
        if (roomData.players.size >= 1 && !roomData.interval) {
            startBallLoop(roomStr);
        }
    });

    // 3. Handle Bingo Claims
    socket.on('claimBingo', ({ room, grid, marked }) => {
        const roomStr = room.toString();
        const roomData = rooms[roomStr];
        
        if (!roomData) return;

        // Simple validation logic (server-side)
        const allCalled = marked.every(num => num === 'FREE' || roomData.drawnNumbers.includes(num));
        
        if (allCalled) {
            const prize = parseInt(roomStr) * roomData.players.size;
            io.to(roomStr).emit('gameOver', {
                room: roomStr,
                winnerId: socket.id,
                winnerName: roomData.players.get(socket.id).userName,
                prize: prize
            });
            resetRoom(roomStr);
        }
    });

    socket.on('disconnect', () => {
        Object.keys(rooms).forEach(roomStr => {
            const roomData = rooms[roomStr];
            if (roomData.players.has(socket.id)) {
                const p = roomData.players.get(socket.id);
                roomData.usedCartelas.delete(p.cartelaId);
                roomData.players.delete(socket.id);
                
                if (roomData.players.size === 0) stopBallLoop(roomStr);
            }
        });
    });
});

function startBallLoop(roomStr) {
    const roomData = rooms[roomStr];
    console.log(`Starting game loop for Room ${roomStr}`);
    
    roomData.interval = setInterval(() => {
        if (roomData.drawnNumbers.length >= 75) {
            stopBallLoop(roomStr);
            return;
        }

        let nextNum;
        do {
            nextNum = Math.floor(Math.random() * 75) + 1;
        } while (roomData.drawnNumbers.includes(nextNum));

        roomData.drawnNumbers.push(nextNum);
        
        io.to(roomStr).emit('ballDrawn', {
            room: roomStr,
            num: nextNum
        });
    }, 5000);
}

function stopBallLoop(roomStr) {
    if (rooms[roomStr].interval) {
        clearInterval(rooms[roomStr].interval);
        rooms[roomStr].interval = null;
    }
}

function resetRoom(roomStr) {
    stopBallLoop(roomStr);
    rooms[roomStr].drawnNumbers = [];
    rooms[roomStr].usedCartelas.clear();
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
