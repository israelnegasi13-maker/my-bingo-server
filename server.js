const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
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

// --- STATE MANAGEMENT ---
let users = {};         // userId -> { socketId, balance, name, room }
let rooms = {};         // roomValue -> { players: [], gameState: 'waiting', calledNumbers: Set(), pot: 0 }
const BANNED_USERS = new Set(); 
const ADMIN_SECRET = "admin_secret"; // <--- IMPORTANT: Change this to match your Admin Panel

// --- HELPERS ---

function getRoom(roomVal) {
    if (!rooms[roomVal]) {
        rooms[roomVal] = {
            players: [],
            gameState: 'waiting', 
            timer: null,
            calledNumbers: new Set(),
            pot: 0
        };
    }
    return rooms[roomVal];
}

// Sends the current online player list to anyone in the 'admin_room'
function syncAdminPlayerList() {
    const playerList = Object.values(users).map(u => ({
        id: u.id,
        name: u.name,
        room: u.room
    }));
    io.to('admin_room').emit('admin:playerList', playerList);
}

function updateGlobalStats() {
    const activePlayers = Object.keys(users).length;
    io.to('admin_room').emit('lobbyUpdate', { room: 'global', count: activePlayers });
}

// --- CORE LOGIC ---

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // Initial User State
    users[socket.id] = {
        id: socket.id,
        balance: 1000.00, // Starting balance for testing
        name: "Guest",
        room: null
    };

    socket.emit('balanceUpdate', users[socket.id].balance);

    // 1. GAMEPLAY EVENTS
    socket.on('joinRoom', ({ room, box, userName }) => {
        if(BANNED_USERS.has(userName) || BANNED_USERS.has(socket.id)) {
            socket.emit('error', 'Unauthorized: You are restricted from this server.');
            socket.disconnect();
            return;
        }

        const r = getRoom(room);
        const user = users[socket.id];

        if(user.balance < room) {
            socket.emit('error', 'Insufficient funds');
            return;
        }

        // Setup User
        user.balance -= room;
        user.name = userName;
        user.room = room;
        
        socket.join(`room_${room}`);
        r.players.push({ id: socket.id, name: userName, box: box });
        r.pot += room;

        socket.emit('balanceUpdate', user.balance);
        io.to(`room_${room}`).emit('lobbyUpdate', { room: room, count: r.players.length });

        // Update Admin Dashboard
        syncAdminPlayerList();

        // Start countdown if 2+ players
        if(r.players.length >= 2 && r.gameState === 'waiting') {
            startGameCountdown(room);
        }
    });

    socket.on('claimBingo', ({ room }) => {
        const r = rooms[room];
        if(!r || r.gameState !== 'playing') return;

        r.gameState = 'finished';
        if(r.timer) clearInterval(r.timer);
        
        const user = users[socket.id];
        const prize = r.pot;
        user.balance += prize;
        r.pot = 0; 

        socket.emit('balanceUpdate', user.balance);
        io.to(`room_${room}`).emit('gameOver', {
            room: room,
            winnerId: socket.id,
            winnerName: user.name,
            prize: prize
        });

        setTimeout(() => resetRoom(room), 5000);
    });

    // 2. ADMIN CONTROL EVENTS
    socket.on('admin:auth', ({ token }) => {
        if(token === ADMIN_SECRET) {
            socket.join('admin_room');
            socket.emit('admin:authSuccess');
            syncAdminPlayerList();
            updateGlobalStats();
        }
    });

    socket.on('admin:banPlayer', ({ userId, reason }) => {
        if(!socket.rooms.has('admin_room')) return;
        BANNED_USERS.add(userId);
        const target = io.sockets.sockets.get(userId);
        if(target) {
            target.emit('error', `Banned: ${reason}`);
            target.disconnect(true);
        }
        syncAdminPlayerList();
    });

    socket.on('admin:refundPlayer', ({ userId, amount }) => {
        if(!socket.rooms.has('admin_room')) return;
        if(users[userId]) {
            users[userId].balance += parseFloat(amount);
            const target = io.sockets.sockets.get(userId);
            if(target) target.emit('balanceUpdate', users[userId].balance);
            console.log(`Admin refunded ${amount} to ${userId}`);
        }
    });

    // 3. CLEANUP
    socket.on('disconnect', () => {
        const user = users[socket.id];
        if (user && user.room) {
            const r = rooms[user.room];
            if(r) {
                r.players = r.players.filter(p => p.id !== socket.id);
                io.to(`room_${user.room}`).emit('lobbyUpdate', { room: user.room, count: r.players.length });
            }
        }
        delete users[socket.id];
        syncAdminPlayerList();
        updateGlobalStats();
    });
});

// --- GAME ENGINE ---

function startGameCountdown(roomVal) {
    const r = rooms[roomVal];
    r.gameState = 'countdown';
    let count = 5;

    let countdownInterval = setInterval(() => {
        io.to(`room_${roomVal}`).emit('gameCountdown', { room: roomVal, timer: count });
        count--;
        if(count < 0) {
            clearInterval(countdownInterval);
            startGameLoop(roomVal);
        }
    }, 1000);
}

function startGameLoop(roomVal) {
    const r = rooms[roomVal];
    r.gameState = 'playing';
    r.calledNumbers.clear();
    
    r.timer = setInterval(() => {
        if(r.gameState !== 'playing') {
            clearInterval(r.timer);
            return;
        }

        let num;
        if(r.calledNumbers.size >= 75) {
            clearInterval(r.timer);
            io.to(`room_${roomVal}`).emit('gameOver', { room: roomVal, winnerId: 'HOUSE', winnerName: 'System', prize: 0 });
            resetRoom(roomVal);
            return;
        }

        do {
            num = Math.floor(Math.random() * 75) + 1;
        } while (r.calledNumbers.has(num));

        r.calledNumbers.add(num);
        io.to(`room_${roomVal}`).emit('ballDrawn', { room: roomVal, num: num });
    
    }, 4000); 
}

function resetRoom(roomVal) {
    const r = rooms[roomVal];
    if(!r) return;
    r.gameState = 'waiting';
    r.players = [];
    r.pot = 0;
    r.calledNumbers.clear();
    io.to(`room_${roomVal}`).emit('lobbyUpdate', { room: roomVal, count: 0 });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Elite Bingo Server Running on Port ${PORT}`);
});
