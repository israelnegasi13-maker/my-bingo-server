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
const ADMIN_SECRET_KEY = "YOUR_ADMIN_SECRET_KEY"; // Ensure this matches admin.html
const HOUSE_TAX = 0.10; // 10% House commission

// --- GAME STATE (Stored in RAM) ---
let players = {};      // { socketId: { id, name, balance, room, box, status } }
let rooms = {};        // { stake: { players: [], balls: [], status, timer, interval } }
let bannedPlayers = new Set(); 
let houseRevenue = 0;

// Utility: Broadcast latest data to all connected admins
const broadcastAdminData = () => {
    const adminData = {
        stats: {
            totalPlayers: Object.keys(players).length,
            activeRooms: Object.values(rooms).filter(r => r.status === 'playing').length,
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

    // Initial default player object
    players[socket.id] = {
        id: socket.id,
        name: "Guest",
        balance: 0.00,
        room: null,
        box: null
    };

    // Admin Authentication Check
    if (socket.handshake.auth && socket.handshake.auth.token === ADMIN_SECRET_KEY) {
        socket.join('admin_room');
        console.log('Admin identified:', socket.id);
    }

    // --- GAMEPLAY EVENTS ---

    socket.on('joinRoom', (data) => {
        if (bannedPlayers.has(socket.id)) {
            socket.emit('error', 'Your account has been restricted.');
            return socket.disconnect();
        }

        const { room, box, userName } = data;
        const stake = parseInt(room);

        // Update player profile
        players[socket.id].name = userName;
        players[socket.id].room = stake;
        players[socket.id].box = box;

        socket.join(`room_${stake}`);
        
        if (!rooms[stake]) {
            rooms[stake] = { players: [], balls: [], status: 'waiting', timer: 10 };
        }
        
        if (!rooms[stake].players.includes(socket.id)) {
            rooms[stake].players.push(socket.id);
        }

        io.to(`room_${stake}`).emit('lobbyUpdate', { 
            room: stake, 
            count: rooms[stake].players.length 
        });

        // Auto-start countdown if 2 or more players join
        if (rooms[stake].players.length >= 2 && rooms[stake].status === 'waiting') {
            startRoomCountdown(stake);
        }
        
        broadcastAdminData();
    });

    socket.on('claimBingo', (data) => {
        const stake = parseInt(data.room);
        const room = rooms[stake];
        if (!room || room.status !== 'playing') return;

        room.status = 'finished';
        clearInterval(room.interval);

        const totalPot = stake * room.players.length;
        const tax = totalPot * HOUSE_TAX;
        const winnerPrize = totalPot - tax;
        houseRevenue += tax;

        // Credit the winner
        if (players[socket.id]) {
            players[socket.id].balance += winnerPrize;
        }

        io.to(`room_${stake}`).emit('gameOver', {
            room: stake,
            winnerId: socket.id,
            winnerName: players[socket.id].name,
            prize: winnerPrize
        });

        // Push balance updates to everyone in the room
        room.players.forEach(pId => {
            if (players[pId]) {
                io.to(pId).emit('balanceUpdate', players[pId].balance);
            }
        });

        // Reset room after a delay
        setTimeout(() => {
            delete rooms[stake];
            broadcastAdminData();
        }, 5000);
    });

    // --- ADMIN CONTROL EVENTS ---

    socket.on('admin_get_data', () => {
        broadcastAdminData();
    });

    // Add balance logic (The "Infinite Admin Balance" part)
    socket.on('admin_modify_balance', (data) => {
        const { playerId, amount } = data;
        if (players[playerId]) {
            players[playerId].balance += parseFloat(amount);
            // Send immediate update to the specific player
            io.to(playerId).emit('balanceUpdate', players[playerId].balance);
            // Update the admin dashboard view
            broadcastAdminData();
            console.log(`Admin added ${amount} to ${playerId}`);
        }
    });

    socket.on('admin_toggle_ban', (data) => {
        const { playerId, ban } = data;
        if (ban) {
            bannedPlayers.add(playerId);
            io.to(playerId).emit('error', 'You have been banned by the administrator.');
            const targetSocket = io.sockets.sockets.get(playerId);
            if (targetSocket) targetSocket.disconnect();
        } else {
            bannedPlayers.delete(playerId);
        }
        broadcastAdminData();
    });

    socket.on('disconnect', () => {
        // Clean up player from rooms if they leave early
        const p = players[socket.id];
        if (p && p.room && rooms[p.room]) {
            rooms[p.room].players = rooms[p.room].players.filter(id => id !== socket.id);
            io.to(`room_${p.room}`).emit('lobbyUpdate', { 
                room: p.room, 
                count: rooms[p.room].players.length 
            });
        }
        delete players[socket.id];
        broadcastAdminData();
    });
});

// --- ENGINE LOGIC ---

function startRoomCountdown(stake) {
    const room = rooms[stake];
    room.status = 'counting';
    
    const countInterval = setInterval(() => {
        room.timer--;
        io.to(`room_${stake}`).emit('gameCountdown', { room: stake, timer: room.timer });
        
        if (room.timer <= 0) {
            clearInterval(countInterval);
            startGame(stake);
        }
    }, 1000);
}

function startGame(stake) {
    const room = rooms[stake];
    room.status = 'playing';
    room.balls = [];
    
    // Deduct entry fee from everyone
    room.players.forEach(pId => {
        if (players[pId]) {
            players[pId].balance -= stake;
            io.to(pId).emit('balanceUpdate', players[pId].balance);
        }
    });

    broadcastAdminData();

    room.interval = setInterval(() => {
        if (room.balls.length >= 75) {
            clearInterval(room.interval);
            io.to(`room_${stake}`).emit('gameOver', { room: stake, winnerId: 'HOUSE' });
            return;
        }

        let ball;
        do {
            ball = Math.floor(Math.random() * 75) + 1;
        } while (room.balls.includes(ball));

        room.balls.push(ball);
        io.to(`room_${stake}`).emit('ballDrawn', { room: stake, num: ball });
    }, 4000);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Bingo Server running on port ${PORT}`));
