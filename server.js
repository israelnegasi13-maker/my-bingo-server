const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

// --- STATE MANAGEMENT ---
const players = new Map(); // Store player data: id -> { name, balance, banned, socketId }
const rooms = {
    "10": { players: [], balls: [], interval: null },
    "20": { players: [], balls: [], interval: null },
    "50": { players: [], balls: [], interval: null },
    "100": { players: [], balls: [], interval: null }
};

const ADMIN_SECRET = "ELITE_PRO_ADMIN";

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // --- PLAYER LOGIC ---
    socket.on('player_init', (data) => {
        // Initialize or update player
        const userId = data.userId || socket.id;
        if (!players.has(userId)) {
            players.set(userId, {
                id: userId,
                socketId: socket.id,
                name: data.name || "Guest",
                balance: 100.00, // Default starting balance
                banned: false,
                isInfinite: false
            });
        } else {
            const p = players.get(userId);
            p.socketId = socket.id;
            players.set(userId, p);
        }
        
        const player = players.get(userId);
        socket.emit('player_data', player);
    });

    socket.on('joinLobby', (d) => {
        const player = Array.from(players.values()).find(p => p.socketId === socket.id);
        if (!player) return;
        if (player.banned) return socket.emit('error', { msg: "You are banned." });
        
        // Logical check for balance
        const stake = parseInt(d.room);
        if (player.balance < stake && !player.isInfinite) {
            return socket.emit('error', { msg: "Insufficient funds." });
        }

        socket.join(d.room);
        console.log(`${player.name} joined room ${d.room}`);
        
        // Start game loop if first person or logic requires
        startBallDraw(d.room);
    });

    // --- ADMIN LOGIC ---
    socket.on('admin_login', (data) => {
        if (data.secret === ADMIN_SECRET) {
            socket.isAdmin = true;
            console.log("Admin authenticated");
            sendAdminData();
        }
    });

    socket.on('admin_request_stats', () => {
        if (socket.isAdmin) sendAdminData();
    });

    socket.on('admin_update_balance', (data) => {
        if (!socket.isAdmin) return;
        const player = players.get(data.targetId);
        if (player) {
            player.balance += data.amount;
            players.set(data.targetId, player);
            // Notify the specific player of their new balance
            io.to(player.socketId).emit('balance_updated', { balance: player.balance });
            sendAdminData();
        }
    });

    socket.on('admin_ban_player', (data) => {
        if (!socket.isAdmin) return;
        const player = players.get(data.targetId);
        if (player) {
            player.banned = !player.banned;
            players.set(data.targetId, player);
            if (player.banned) {
                io.to(player.socketId).emit('kicked', { reason: "Banned by Admin" });
            }
            sendAdminData();
        }
    });

    socket.on('admin_toggle_infinite', (data) => {
        if (!socket.isAdmin) return;
        // Logic: Grant admin (yourself) infinite money
        // We find the player record associated with this admin session if applicable
        // Or apply to a specific hardcoded Admin ID
        const adminPlayer = Array.from(players.values()).find(p => p.name.includes("Admin"));
        if (adminPlayer) {
            adminPlayer.isInfinite = data.active;
            adminPlayer.balance = data.active ? 99999999 : 100;
            io.to(adminPlayer.socketId).emit('player_data', adminPlayer);
        }
        sendAdminData();
    });

    function sendAdminData() {
        const adminData = {
            playerCount: players.size,
            lobbyCount: Object.keys(rooms).filter(r => io.sockets.adapter.rooms.get(r)).length,
            players: Array.from(players.values())
        };
        io.emit('admin_update_data', adminData);
    }

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
    });
});

function startBallDraw(room) {
    if (rooms[room].interval) return; // Already running

    rooms[room].interval = setInterval(() => {
        if (rooms[room].balls.length >= 75) {
            clearInterval(rooms[room].interval);
            rooms[room].interval = null;
            return;
        }

        let ball;
        do { ball = Math.floor(Math.random() * 75) + 1; } 
        while (rooms[room].balls.includes(ball));

        rooms[room].balls.push(ball);
        io.to(room).emit('ballDrawn', { room: room, num: ball });
    }, 5000); // Draw every 5 seconds
}

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
