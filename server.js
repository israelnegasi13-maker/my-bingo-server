const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/bingo_elite';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

// --- DATABASE MODELS ---
const userSchema = new mongoose.Schema({
    telegramId: { type: String, unique: true, required: true },
    userName: String,
    balance: { type: Number, default: 0 },
    isBanned: { type: Boolean, default: false },
    lastLogin: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);

// --- IN-MEMORY STATE ---
// Store active game rooms and transient socket data
const rooms = {}; // Format: { stakeAmount: { players: [socketId], gameStatus: 'waiting'|'playing' } }
const playerState = {}; // Format: { socketId: { userId, userName, currentRoom, box, ... } }

// --- HELPERS ---
const updateBalance = async (telegramId, amount) => {
    const user = await User.findOneAndUpdate(
        { telegramId },
        { $inc: { balance: amount } },
        { new: true }
    );
    return user ? user.balance : 0;
};

// --- SOCKET LOGIC ---
io.on('connection', (socket) => {
    console.log(`New connection: ${socket.id}`);

    // Authentication / Registration
    socket.on('auth', async (userData) => {
        try {
            let user = await User.findOne({ telegramId: userData.id.toString() });
            
            if (!user) {
                user = await User.create({
                    telegramId: userData.id.toString(),
                    userName: userData.username || userData.first_name,
                    balance: 100 // Starting bonus
                });
            }

            if (user.isBanned) {
                socket.emit('banned');
                socket.disconnect();
                return;
            }

            playerState[socket.id] = {
                userId: user.telegramId,
                userName: user.userName,
                balance: user.balance,
                socketId: socket.id,
                currentRoom: null,
                box: null
            };

            socket.emit('authSuccess', {
                balance: user.balance,
                userName: user.userName
            });

            // Send initial online count to player
            io.emit('statsUpdate', { online: Object.keys(playerState).length });
        } catch (err) {
            console.error('Auth Error:', err);
        }
    });

    // Matchmaking: Join Room
    socket.on('joinRoom', async (data) => {
        const { stake } = data;
        const player = playerState[socket.id];
        
        if (!player || player.balance < stake) {
            return socket.emit('error', 'Insufficient balance');
        }

        // Initialize room if not exists
        if (!rooms[stake]) {
            rooms[stake] = { players: [], gameStatus: 'waiting' };
        }

        const room = rooms[stake];

        if (room.gameStatus === 'playing') {
            return socket.emit('error', 'Game already in progress. Please wait.');
        }

        // Join room
        player.currentRoom = stake;
        room.players.push(socket.id);
        socket.join(`room_${stake}`);

        io.to(`room_${stake}`).emit('playerJoined', {
            count: room.players.length,
            players: room.players.map(id => playerState[id].userName)
        });

        // Start game logic when 2 players join
        if (room.players.length === 2) {
            room.gameStatus = 'playing';
            
            // Deduct stakes
            for (const pid of room.players) {
                const p = playerState[pid];
                const newBal = await updateBalance(p.userId, -stake);
                p.balance = newBal;
                io.to(pid).emit('balanceRefreshed', newBal);
            }

            io.to(`room_${stake}`).emit('gameStart', {
                opponent: "Opponent Found",
                prize: stake * 1.8 // House takes 10% from each player
            });
        }
    });

    // Box Selection
    socket.on('selectBox', (boxNumber) => {
        const player = playerState[socket.id];
        if (!player || !player.currentRoom) return;

        player.box = boxNumber;
        const room = rooms[player.currentRoom];
        
        // Check if both players have selected
        const selections = room.players.filter(pid => playerState[pid].box !== null);
        
        if (selections.length === 2) {
            // Determine winner (Simplified Bingo Logic)
            const winnerIdx = Math.floor(Math.random() * 2);
            const winnerId = room.players[winnerIdx];
            const loserId = room.players[1 - winnerIdx];
            
            const prize = player.currentRoom * 1.8;

            // Update Winner
            updateBalance(playerState[winnerId].userId, prize).then(newBal => {
                playerState[winnerId].balance = newBal;
                io.to(winnerId).emit('gameResult', { status: 'win', prize, newBalance: newBal });
            });

            // Notify Loser
            io.to(loserId).emit('gameResult', { 
                status: 'lose', 
                msg: `Better luck next time! Box ${playerState[winnerId].box} was the winner.` 
            });

            // Cleanup Room
            room.players.forEach(pid => {
                const p = playerState[pid];
                p.currentRoom = null;
                p.box = null;
            });
            delete rooms[player.currentRoom];
        }
    });

    // ADMIN ACTIONS
    socket.on('adminLogin', (pass) => {
        if (pass === ADMIN_PASSWORD) {
            socket.emit('adminAuthSuccess');
            // Send full player list to admin
            socket.emit('playerListUpdate', Object.values(playerState));
        } else {
            socket.emit('error', 'Invalid Admin Password');
        }
    });

    socket.on('addFunds', async (data) => {
        const targetPlayer = playerState[data.socketId];
        if (targetPlayer) {
            const newBal = await updateBalance(targetPlayer.userId, data.amount);
            targetPlayer.balance = newBal;
            io.to(data.socketId).emit('fundsAdded', { amount: data.amount, newBalance: newBal });
            // Refresh admin view
            io.emit('playerListUpdate', Object.values(playerState));
        }
    });

    socket.on('banPlayer', async (socketId) => {
        const targetPlayer = playerState[socketId];
        if (targetPlayer) {
            await User.findOneAndUpdate({ telegramId: targetPlayer.userId }, { isBanned: true });
            io.to(socketId).emit('banned');
            delete playerState[socketId];
            io.sockets.sockets.get(socketId)?.disconnect();
            io.emit('playerListUpdate', Object.values(playerState));
        }
    });

    // Disconnect handling
    socket.on('disconnect', () => {
        if (playerState[socket.id]) {
            const player = playerState[socket.id];
            // If in a room, handle forfeit/cleanup
            if (player.currentRoom && rooms[player.currentRoom]) {
                const room = rooms[player.currentRoom];
                room.players = room.players.filter(id => id !== socket.id);
                if (room.players.length === 0) delete rooms[player.currentRoom];
            }
            delete playerState[socket.id];
        }
        io.emit('statsUpdate', { online: Object.keys(playerState).length });
    });
});

// --- START SERVER ---
mongoose.connect(MONGODB_URI)
    .then(() => {
        console.log('Connected to MongoDB');
        server.listen(PORT, () => console.log(`Bingo Server running on port ${PORT}`));
    })
    .catch(err => console.error('MongoDB connection error:', err));
