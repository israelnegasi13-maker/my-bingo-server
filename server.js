const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

/**
 * State Management
 * rooms: { 
 * [stakeAmount]: { 
 * players: { socketId: { id, name, box } }, 
 * takenBoxes: [number], 
 * drawing: boolean, 
 * balls: [number] 
 * } 
 * }
 */
const rooms = {
    10: { players: {}, takenBoxes: [], drawing: false, balls: [] },
    20: { players: {}, takenBoxes: [], drawing: false, balls: [] },
    50: { players: {}, takenBoxes: [], drawing: false, balls: [] },
    100: { players: {}, takenBoxes: [], drawing: false, balls: [] }
};

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // 1. Initial request to see which boxes are taken in a specific arena
    socket.on('getTakenBoxes', ({ room }, callback) => {
        if (rooms[room]) {
            callback(rooms[room].takenBoxes);
        } else {
            callback([]);
        }
    });

    // 2. Immediate validation when a player clicks a specific number (1-50)
    socket.on('checkBoxAvailability', ({ room, box }, callback) => {
        const arena = rooms[room];
        if (arena && !arena.takenBoxes.includes(box)) {
            // Box is available at this exact microsecond
            callback({ available: true });
        } else {
            // Box was likely taken while the user was looking at it
            callback({ available: false });
        }
    });

    // 3. Official entry into the match
    socket.on('joinRoom', ({ room, box, userName }) => {
        const arena = rooms[room];
        if (!arena) return;

        // Double check lock
        if (!arena.takenBoxes.includes(box)) {
            arena.takenBoxes.push(box);
        }

        socket.join(room);
        arena.players[socket.id] = { 
            id: socket.id, 
            name: userName, 
            box: box 
        };

        console.log(`[Room ${room}] ${userName} reserved box #${box}`);

        // Broadcast the update so other players see the 🔒 icon immediately
        io.emit('boxUpdate', { room, takenBoxes: arena.takenBoxes });

        // Start drawing balls if this is the first player to trigger the game cycle
        if (!arena.drawing) {
            startBingoDraw(room);
        }
    });

    // 4. Bingo Claim Validation
    socket.on('claimBingo', (data) => {
        const arena = rooms[data.room];
        if (!arena || !arena.drawing) return;

        const winner = arena.players[socket.id];
        
        // Broadcast the win to everyone in that specific stake room
        io.to(data.room).emit('gameOver', {
            room: data.room,
            winnerId: socket.id,
            winnerName: winner ? winner.name : "Elite Player",
            prize: data.room * 0.9 // 10% House Edge
        });

        console.log(`[Room ${data.room}] Bingo claimed by ${winner ? winner.name : socket.id}`);

        // Reset Room State for the next round
        arena.drawing = false;
        arena.balls = [];
        arena.takenBoxes = [];
        arena.players = {};
        
        // Clear locks for everyone looking at the discovery grid
        io.emit('boxUpdate', { room: data.room, takenBoxes: [] });
    });

    // 5. Cleanup on Disconnect
    socket.on('disconnect', () => {
        for (const stake in rooms) {
            const arena = rooms[stake];
            if (arena.players[socket.id]) {
                const releasedBox = arena.players[socket.id].box;
                
                // Remove the box from the taken list
                arena.takenBoxes = arena.takenBoxes.filter(b => b !== releasedBox);
                delete arena.players[socket.id];
                
                console.log(`[Room ${stake}] Box #${releasedBox} released by disconnect`);
                
                // Notify others that the box is now available
                io.emit('boxUpdate', { room: stake, takenBoxes: arena.takenBoxes });
                break;
            }
        }
    });
});

/**
 * Server-Side Random Number Generator
 * Ensures all players in the same room see the same ball at the same time
 */
function startBingoDraw(room) {
    const arena = rooms[room];
    arena.drawing = true;
    
    console.log(`[Room ${room}] Starting ball draw sequence...`);

    const interval = setInterval(() => {
        // Stop if the game ended (Bingo claimed) or room reset
        if (!arena.drawing) {
            clearInterval(interval);
            return;
        }

        // Stop if all balls drawn
        if (arena.balls.length >= 75) {
            arena.drawing = false;
            clearInterval(interval);
            return;
        }

        let newBall;
        do {
            newBall = Math.floor(Math.random() * 75) + 1;
        } while (arena.balls.includes(newBall));

        arena.balls.push(newBall);
        
        // Send the ball to everyone currently in the game room
        io.to(room).emit('ballDrawn', { room, num: newBall });

    }, 4500); // 4.5 seconds between balls for mobile readability
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Bingo Server Live on Port ${PORT}`);
});
