const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" } // Adjust for production security
});

// --- Game State Memory ---
// In a real production app, use Redis or a Database.
const rooms = {
    "10": { players: [], takenBoxes: [], balls: [], status: "waiting", timer: 30 },
    "50": { players: [], takenBoxes: [], balls: [], status: "waiting", timer: 30 },
    "100": { players: [], takenBoxes: [], balls: [], status: "waiting", timer: 30 }
};

const allPlayers = new Map(); // Global tracking for Admin Panel

io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    // Identify role (Admin or Player)
    const isAdmin = socket.handshake.auth?.role === "admin";

    // 1. INITIAL DATA SYNC
    if (isAdmin) {
        socket.emit('admin:players', Array.from(allPlayers.values()));
    }

    // 2. PLAYER LOGIC: Request taken boxes for a specific stake
    socket.on('getTakenBoxes', (stake) => {
        const room = rooms[stake];
        if (room) {
            socket.emit('boxStatus', room.takenBoxes);
        }
    });

    // 3. PLAYER LOGIC: Join Room after picking a box
    socket.on('joinRoom', (data) => {
        const { room: stake, box, userName } = data;
        const room = rooms[stake];

        if (!room) return;
        
        // Prevent double booking a box
        if (room.takenBoxes.includes(box)) {
            return socket.emit('error', 'Box already taken');
        }

        // Add player to room and global list
        const playerData = {
            id: socket.id,
            name: userName,
            balance: 0, // In reality, fetch from DB
            stake: stake,
            box: box
        };

        room.players.push(playerData);
        room.takenBoxes.push(box);
        allPlayers.set(socket.id, playerData);

        socket.join(stake);
        
        // Notify all players in that lobby of the updated boxes
        io.to(stake).emit('boxStatus', room.takenBoxes);
        
        // Update Admin Panel
        io.emit('admin:players', Array.from(allPlayers.values()));

        console.log(`${userName} joined ${stake} ETB room at box ${box}`);
    });

    // 4. ADMIN LOGIC: Handle Fund Additions
    socket.on('addFunds', (data) => {
        if (!isAdmin) return;
        const player = allPlayers.get(data.playerId);
        if (player) {
            player.balance += data.amount;
            // Update the specific player and refresh the admin list
            io.to(data.playerId).emit('balanceUpdate', player.balance);
            io.emit('admin:players', Array.from(allPlayers.values()));
        }
    });

    // 5. DISCONNECT LOGIC
    socket.on('disconnect', () => {
        const player = allPlayers.get(socket.id);
        if (player) {
            const room = rooms[player.stake];
            if (room) {
                room.players = room.players.filter(p => p.id !== socket.id);
                room.takenBoxes = room.takenBoxes.filter(b => b !== player.box);
                io.to(player.stake).emit('boxStatus', room.takenBoxes);
            }
            allPlayers.delete(socket.id);
            io.emit('admin:players', Array.from(allPlayers.values()));
        }
    });
});

// Game Loop: Simple 1-second interval to handle room timers
setInterval(() => {
    for (const stake in rooms) {
        const room = rooms[stake];
        if (room.players.length > 0 && room.status === "waiting") {
            room.timer--;
            io.to(stake).emit('gameCountdown', { room: stake, timer: room.timer });

            if (room.timer <= 0) {
                room.status = "playing";
                startGame(stake);
            }
        }
    }
}, 1000);

function startGame(stake) {
    console.log(`Game starting for ${stake} ETB room!`);
    // Logic to start drawing balls would go here...
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
