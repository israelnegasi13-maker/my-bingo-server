const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" } // Allow Telegram Mini App to connect
});

// Game state for each stake room
// Rooms are: 10, 20, 50, 100
const rooms = {};

const createRoomState = (stake) => ({
    stake,
    players: [],
    takenBoxes: [],
    calledNumbers: [],
    availableNumbers: Array.from({ length: 75 }, (_, i) => i + 1),
    status: 'LOBBY', // LOBBY, COUNTDOWN, PLAYING
    timer: 10,
    interval: null
});

io.on('connection', (socket) => {
    console.log('User Connected:', socket.id);

    // 1. Send taken boxes for the selection screen
    socket.on('getTakenBoxes', ({ room }, callback) => {
        if (!rooms[room]) rooms[room] = createRoomState(room);
        callback(rooms[room].takenBoxes);
    });

    // 2. Handle joining a specific stake room
    socket.on('joinRoom', ({ room, box, userName }) => {
        if (!rooms[room]) rooms[room] = createRoomState(room);
        
        const currentRoom = rooms[room];

        // Prevent joining if game already started or box taken
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
        currentRoom.takenBoxes.push(box);

        // Notify room of new player count
        io.to(`room_${room}`).emit('lobbyUpdate', {
            room,
            count: currentRoom.players.length
        });

        // Start countdown if 2 players joined
        if (currentRoom.players.length >= 2 && currentRoom.status === 'LOBBY') {
            startCountdown(room);
        }
    });

    // 3. Handle Bingo Claim
    socket.on('claimBingo', ({ room, grid, marked }) => {
        const currentRoom = rooms[room];
        if (!currentRoom || currentRoom.status !== 'PLAYING') return;

        // SERVER-SIDE VALIDATION
        // Check if all marked numbers (except FREE) were actually called by the server
        const isValid = marked.every(num => 
            num === 'FREE' || currentRoom.calledNumbers.includes(num)
        );

        if (isValid) {
            // In a real app, you'd also verify the pattern (line/diagonal) here
            currentRoom.status = 'FINISHED';
            clearInterval(currentRoom.interval);

            const winner = currentRoom.players.find(p => p.id === socket.id);
            const prize = currentRoom.stake * currentRoom.players.length * 0.9; // 10% House Edge

            io.to(`room_${room}`).emit('gameOver', {
                room,
                winnerId: socket.id,
                winnerName: winner.userName,
                prize: prize
            });

            // Reset room after a delay
            setTimeout(() => {
                rooms[room] = createRoomState(room);
            }, 5000);
        }
    });

    socket.on('disconnect', () => {
        // Clean up player from rooms if they disconnect during lobby
        for (const stake in rooms) {
            const room = rooms[stake];
            const pIndex = room.players.findIndex(p => p.id === socket.id);
            if (pIndex !== -1 && room.status !== 'PLAYING') {
                const player = room.players[pIndex];
                room.takenBoxes = room.takenBoxes.filter(b => b !== player.box);
                room.players.splice(pIndex, 1);
                io.to(`room_${stake}`).emit('lobbyUpdate', {
                    room: stake,
                    count: room.players.length
                });
            }
        }
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
    
    // Shuffle numbers
    room.availableNumbers.sort(() => Math.random() - 0.5);

    room.interval = setInterval(() => {
        if (room.availableNumbers.length > 0) {
            const drawn = room.availableNumbers.pop();
            room.calledNumbers.push(drawn);
            io.to(`room_${stake}`).emit('ballDrawn', {
                room: stake,
                num: drawn
            });
        } else {
            clearInterval(room.interval);
        }
    }, 5000); // Draw every 5 seconds
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Bingo Server running on port ${PORT}`));
