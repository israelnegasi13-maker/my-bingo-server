const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

// Game state
const rooms = {};

const createRoomState = (stake) => ({
    stake,
    players: [],
    takenBoxes: [], // Tracks locked numbers
    calledNumbers: [],
    availableNumbers: Array.from({ length: 75 }, (_, i) => i + 1),
    status: 'LOBBY', 
    timer: 10,
    interval: null
});

io.on('connection', (socket) => {
    console.log('User Connected:', socket.id);

    // 1. Send taken boxes to client
    socket.on('getTakenBoxes', ({ room }, callback) => {
        if (!rooms[room]) rooms[room] = createRoomState(room);
        // Important: Send the server's memory of what is taken
        callback(rooms[room].takenBoxes);
    });

    // 2. Player joins room
    socket.on('joinRoom', ({ room, box, userName }) => {
        if (!rooms[room]) rooms[room] = createRoomState(room);
        const currentRoom = rooms[room];

        if (currentRoom.status === 'PLAYING' || currentRoom.takenBoxes.includes(box)) {
            return;
        }

        socket.join(`room_${room}`);
        
        const player = {
            id: socket.id,
            userName,
            box,
            markedNumbers: ['FREE']
        };

        currentRoom.players.push(player);
        currentRoom.takenBoxes.push(box); // Lock the box

        io.to(`room_${room}`).emit('lobbyUpdate', {
            room,
            count: currentRoom.players.length
        });

        if (currentRoom.players.length >= 2 && currentRoom.status === 'LOBBY') {
            startCountdown(room);
        }
    });

    // 3. Check for Winner
    socket.on('claimBingo', ({ room, grid, marked }) => {
        const currentRoom = rooms[room];
        if (!currentRoom || currentRoom.status !== 'PLAYING') return;

        // Verify numbers against server history
        const isValid = marked.every(num => 
            num === 'FREE' || currentRoom.calledNumbers.includes(num)
        );

        if (isValid) {
            endGame(room, socket.id, currentRoom.players.find(p => p.id === socket.id).userName);
        }
    });

    socket.on('disconnect', () => {
        // ... (Cleanup logic same as before)
    });
});

function startCountdown(stake) {
    const room = rooms[stake];
    room.status = 'COUNTDOWN';
    room.timer = 10;

    const countInterval = setInterval(() => {
        io.to(`room_${stake}`).emit('gameCountdown', {
            room: stake,
            timer: room.timer
        });

        if (room.timer <= 0) {
            clearInterval(countInterval);
            startGame(stake);
        }
        room.timer--;
    }, 1000);
}

function startGame(stake) {
    const room = rooms[stake];
    room.status = 'PLAYING';
    
    // Shuffle
    room.availableNumbers.sort(() => Math.random() - 0.5);

    room.interval = setInterval(() => {
        // HOUSE WINS LOGIC (Run out of balls)
        if (room.availableNumbers.length === 0) {
            endGame(stake, 'HOUSE', 'HOUSE');
            return;
        }

        const drawn = room.availableNumbers.pop();
        room.calledNumbers.push(drawn);
        
        io.to(`room_${stake}`).emit('ballDrawn', {
            room: stake,
            num: drawn
        });

    }, 4000);
}

function endGame(stake, winnerId, winnerName) {
    const room = rooms[stake];
    clearInterval(room.interval);
    room.status = 'FINISHED';

    const prize = winnerId === 'HOUSE' ? 0 : (room.stake * room.players.length * 0.9);

    io.to(`room_${stake}`).emit('gameOver', {
        room: stake,
        winnerId,
        winnerName,
        prize
    });

    // RESET LOGIC: This opens the boxes for the next match
    setTimeout(() => {
        console.log(`Resetting room ${stake} for new players`);
        rooms[stake] = createRoomState(stake); // Clears takenBoxes array
    }, 5000); // 5 second cooldown before room reopens
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
