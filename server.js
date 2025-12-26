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

// --- CONFIGURATION ---
const ADMIN_SECRET_KEY = "YOUR_ADMIN_SECRET_KEY"; // Change this to match admin.html
const HOUSE_TAX = 0.10; // 10% House commission

// --- GAME STATE ---
let players = {}; // { socketId: { name, balance, status, room, box } }
let rooms = {};   // { roomType: { players: [], balls: [], interval, timer, status } }
let bannedPlayers = new Set(); 
let houseRevenue = 0;

// Helper to update admin dashboard
const broadcastAdminData = () => {
    const adminData = {
        stats: {
            totalPlayers: Object.keys(players).length,
            activeRooms: Object.keys(rooms).length,
            revenue: houseRevenue
        },
        players: Object.values(players).map(p => ({
            id: p.id,
            name: p.name,
            balance: p.balance,
            status: bannedPlayers.has(p.id) ? 'banned' : 'active'
        }))
    };
    io.to('admin_room').emit('admin_data_update', adminData);
};

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // 1. Initial Player Setup
    players[socket.id] = {
        id: socket.id,
        name: "Guest",
        balance: 0.00, // Default balance 0 as requested
        status: 'active',
        room: null
    };

    // 2. Admin Authentication
    if (socket.handshake.auth && socket.handshake.auth.token === ADMIN_SECRET_KEY) {
        socket.join('admin_room');
        console.log('Admin connected:', socket.id);
    }

    // --- PLAYER ACTIONS ---

    socket.on('joinRoom', (data) => {
        // Check if banned
        if (bannedPlayers.has(socket.id)) {
            socket.emit('error', 'You are banned from this server.');
            return socket.disconnect();
        }

        const { room, box, userName } = data;
        players[socket.id].name = userName;
        players[socket.id].room = room;
        players[socket.id].box = box;

        // Deduction logic would happen here if balance >= room
        // For now, let's assume client handles initial check, server confirms
        if (players[socket.id].balance < room) {
            return; // Client-side already prevents this
        }

        socket.join(`room_${room}`);
        
        if (!rooms[room]) {
            rooms[room] = { players: [], balls: [], status: 'waiting', timer: 10 };
        }
        
        rooms[room].players.push(socket.id);

        // Notify lobby
        io.to(`room_${room}`).emit('lobbyUpdate', { 
            room: room, 
            count: rooms[room].players.length 
        });

        // Start countdown if 2+ players
        if (rooms[room].players.length >= 2 && rooms[room].status === 'waiting') {
            startRoomCountdown(room);
        }
        
        broadcastAdminData();
    });

    socket.on('getTakenBoxes', (data, callback) => {
        const room = data.room;
        const taken = Object.values(players)
            .filter(p => p.room === room)
            .map(p => p.box);
        callback(taken);
    });

    socket.on('claimBingo', (data) => {
        const { room } = data;
        const roomData = rooms[room];
        if (!roomData || roomData.status !== 'playing') return;

        // Game Over Logic
        roomData.status = 'finished';
        clearInterval(roomData.interval);

        const totalPot = room * roomData.players.length;
        const tax = totalPot * HOUSE_TAX;
        const winnerPrize = totalPot - tax;
        houseRevenue += tax;

        // Update Winner Balance
        players[socket.id].balance += winnerPrize;

        io.to(`room_${room}`).emit('gameOver', {
            room: room,
            winnerId: socket.id,
            winnerName: players[socket.id].name,
            prize: winnerPrize
        });

        // Update balances for everyone
        roomData.players.forEach(pId => {
            if (players[pId]) {
                io.to(pId).emit('balanceUpdate', players[pId].balance);
            }
        });

        // Clean up room
        setTimeout(() => delete rooms[room], 5000);
        broadcastAdminData();
    });

    // --- ADMIN ACTIONS ---

    socket.on('admin_get_data', () => {
        broadcastAdminData();
    });

    socket.on('admin_modify_balance', (data) => {
        const { playerId, amount } = data;
        if (players[playerId]) {
            players[playerId].balance += amount;
            io.to(playerId).emit('balanceUpdate', players[playerId].balance);
            broadcastAdminData();
        }
    });

    socket.on('admin_toggle_ban', (data) => {
        const { playerId, ban } = data;
        if (ban) {
            bannedPlayers.add(playerId);
            if (players[playerId]) {
                io.to(playerId).emit('error', 'You have been banned.');
                const s = io.sockets.sockets.get(playerId);
                if (s) s.disconnect();
            }
        } else {
            bannedPlayers.delete(playerId);
        }
        broadcastAdminData();
    });

    socket.on('disconnect', () => {
        delete players[socket.id];
        broadcastAdminData();
    });
});

// --- GAME LOOP LOGIC ---

function startRoomCountdown(roomType) {
    const room = rooms[roomType];
    room.status = 'counting';
    
    const countInterval = setInterval(() => {
        room.timer--;
        io.to(`room_${roomType}`).emit('gameCountdown', { room: roomType, timer: room.timer });
        
        if (room.timer <= 0) {
            clearInterval(countInterval);
            startGame(roomType);
        }
    }, 1000);
}

function startGame(roomType) {
    const room = rooms[roomType];
    room.status = 'playing';
    room.balls = [];
    
    // Deduct entry fee from all players
    room.players.forEach(pId => {
        if (players[pId]) {
            players[pId].balance -= roomType;
            io.to(pId).emit('balanceUpdate', players[pId].balance);
        }
    });

    room.interval = setInterval(() => {
        if (room.balls.length >= 75) {
            clearInterval(room.interval);
            io.to(`room_${roomType}`).emit('gameOver', { winnerId: 'HOUSE' });
            return;
        }

        let ball;
        do {
            ball = Math.floor(Math.random() * 75) + 1;
        } while (room.balls.includes(ball));

        room.balls.push(ball);
        io.to(`room_${roomType}`).emit('ballDrawn', { room: roomType, num: ball });
    }, 4000);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Bingo Server running on port ${PORT}`));
