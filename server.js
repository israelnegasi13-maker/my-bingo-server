const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();

// Essential: Enable CORS so your Telegram frontend can talk to this server
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*", // Allows any origin to connect
        methods: ["GET", "POST"]
    }
});

// Game state storage
const rooms = {};

/**
 * Creates a fresh state for a specific stake room
 */
const createRoomState = (stake) => ({
    stake,
    players: [],
    takenBoxes: [], // Tracks which ticket numbers (1-50) are currently occupied
    calledNumbers: [],
    availableNumbers: Array.from({ length: 75 }, (_, i) => i + 1),
    status: 'LOBBY', 
    timer: 10,
    interval: null
});

io.on('connection', (socket) => {
    console.log('User Connected:', socket.id);

    // 1. Send currently locked boxes to the user so they can't pick them
    socket.on('getTakenBoxes', ({ room }, callback) => {
        if (!rooms[room]) rooms[room] = createRoomState(room);
        callback(rooms[room].takenBoxes);
    });

    // 2. Handle joining a specific stake room and selecting a box
    socket.on('joinRoom', ({ room, box, userName }) => {
        if (!rooms[room]) rooms[room] = createRoomState(room);
        const currentRoom = rooms[room];

        // Block entry if game is already running or box is already picked by someone else
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

        io.to(`room_${room}`).emit('lobbyUpdate', {
            room,
            count: currentRoom.players.length
        });

        // Auto-start countdown when 2 or more players are present in the lobby
        if (currentRoom.players.length >= 2 && currentRoom.status === 'LOBBY') {
            startCountdown(room);
        }
    });

    // 3. Bingo Claim Validation
    socket.on('claimBingo', ({ room, grid, marked }) => {
        const currentRoom = rooms[room];
        if (!currentRoom || currentRoom.status !== 'PLAYING') return;

        // Verify that every number the user marked was actually drawn by the server
        const isValid = marked.every(num => 
            num === 'FREE' || currentRoom.calledNumbers.includes(num)
        );

        if (isValid) {
            const player = currentRoom.players.find(p => p.id === socket.id);
            endGame(room, socket.id, player ? player.userName : "Unknown Player");
        }
    });

    // 4. Handle Disconnection
    socket.on('disconnect', () => {
        for (const roomId in rooms) {
            const room = rooms[roomId];
            const playerIndex = room.players.findIndex(p => p.id === socket.id);
            if (playerIndex !== -1) {
                const player = room.players[playerIndex];
                // If the game hasn't started yet, unlock their box immediately for others
                if (room.status === 'LOBBY') {
                    room.takenBoxes = room.takenBoxes.filter(b => b !== player.box);
                }
                room.players.splice(playerIndex, 1);
                io.to(`room_${roomId}`).emit('lobbyUpdate', {
                    room: roomId,
                    count: room.players.length
                });
            }
        }
    });
});

/**
 * Handles the 10-second countdown before a match starts
 */
function startCountdown(stake) {
    const room = rooms[stake];
    if (room.status !== 'LOBBY') return;
    
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

/**
 * Starts the game loop drawing balls every 4 seconds
 */
function startGame(stake) {
    const room = rooms[stake];
    room.status = 'PLAYING';
    
    // Server-side randomization of balls (Fisher-Yates style shuffle)
    room.availableNumbers.sort(() => Math.random() - 0.5);

    room.interval = setInterval(() => {
        // HOUSE WINS: If all 75 numbers are drawn and no player has claimed Bingo
        if (room.availableNumbers.length === 0) {
            endGame(stake, 'HOUSE', 'THE ARENA');
            return;
        }

        const drawn = room.availableNumbers.pop();
        room.calledNumbers.push(drawn);
        
        io.to(`room_${stake}`).emit('ballDrawn', {
            room: stake,
            num: drawn
        });

    }, 4000); // 4-second delay between balls
}

/**
 * Ends the match, announces winner, and handles state reset
 */
function endGame(stake, winnerId, winnerName) {
    const room = rooms[stake];
    if (!room || room.status === 'FINISHED') return;
    
    clearInterval(room.interval);
    room.status = 'FINISHED';

    // Calculate prize pool (Total stakes minus a 10% house fee)
    const totalPool = room.stake * room.players.length;
    const prize = winnerId === 'HOUSE' ? 0 : totalPool * 0.9;

    io.to(`room_${stake}`).emit('gameOver', {
        room: stake,
        winnerId,
        winnerName,
        prize
    });

    // AUTO-RESET: Wipe the room memory after 7 seconds
    // This unlocks all boxes and clears history for the next set of players
    setTimeout(() => {
        console.log(`Match finished in room ${stake}. Resetting and opening all boxes.`);
        rooms[stake] = createRoomState(stake);
    }, 7000); 
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Bingo Elite Server is live on port ${PORT}`);
});
