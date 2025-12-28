const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3000;
// Your specific MongoDB Atlas string
const MONGODB_URI = "mongodb+srv://israelnegasi:mikejava@cluster0.b2hukwx.mongodb.net/bingo_elite?retryWrites=true&w=majority&appName=Cluster0";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

const app = express();
app.use(cors());
app.use(express.json());

// Serve static files from 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

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
const rooms = {}; 
const playerState = {}; // socketId -> data

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

    // Auth triggered by initData from Telegram
    socket.on('auth', async (userData) => {
        try {
            const tId = userData.id ? userData.id.toString() : null;
            if (!tId) return;

            let user = await User.findOne({ telegramId: tId });
            
            if (!user) {
                user = await User.create({
                    telegramId: tId,
                    userName: userData.username || userData.first_name || "Guest",
                    balance: 100 // Welcome Bonus
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

            // Trigger UI balance update
            socket.emit('balanceRefreshed', user.balance);
            io.emit('statsUpdate', { online: Object.keys(playerState).length });
            
            // If admin is connected, update their list
            io.emit('playerListUpdate', Object.values(playerState));
        } catch (err) {
            console.error('Auth Error:', err);
        }
    });

    socket.on('joinRoom', async (data) => {
        const { stake } = data;
        const player = playerState[socket.id];
        
        if (!player || player.balance < stake) {
            return socket.emit('error', 'Insufficient balance');
        }

        if (!rooms[stake]) {
            rooms[stake] = { players: [], gameStatus: 'waiting' };
        }

        const room = rooms[stake];
        if (room.gameStatus === 'playing') return;

        player.currentRoom = stake;
        room.players.push(socket.id);
        socket.join(`room_${stake}`);

        io.to(`room_${stake}`).emit('playerJoined', {
            count: room.players.length,
            players: room.players.map(id => playerState[id].userName)
        });

        // Matchmaking: Start game when 2 players join
        if (room.players.length === 2) {
            room.gameStatus = 'playing';
            for (const pid of room.players) {
                const p = playerState[pid];
                const newBal = await updateBalance(p.userId, -stake);
                p.balance = newBal;
                io.to(pid).emit('balanceRefreshed', newBal);
            }
            io.to(`room_${stake}`).emit('gameStart', {
                opponent: "Opponent Found",
                prize: stake * 1.8 
            });
        }
        io.emit('playerListUpdate', Object.values(playerState));
    });

    socket.on('selectBox', (boxNumber) => {
        const player = playerState[socket.id];
        if (!player || !player.currentRoom) return;

        player.box = boxNumber;
        const room = rooms[player.currentRoom];
        const selections = room.players.filter(pid => playerState[pid].box !== null);
        
        if (selections.length === 2) {
            const winnerIdx = Math.floor(Math.random() * 2);
            const winnerId = room.players[winnerIdx];
            const loserId = room.players[1 - winnerIdx];
            const prize = player.currentRoom * 1.8;

            updateBalance(playerState[winnerId].userId, prize).then(newBal => {
                playerState[winnerId].balance = newBal;
                io.to(winnerId).emit('gameResult', { status: 'win', prize, newBalance: newBal });
                io.to(winnerId).emit('balanceRefreshed', newBal);
            });

            io.to(loserId).emit('gameResult', { 
                status: 'lose', 
                msg: `Box ${playerState[winnerId].box} was the winner.` 
            });

            // Cleanup
            room.players.forEach(pid => {
                if (playerState[pid]) {
                    playerState[pid].currentRoom = null;
                    playerState[pid].box = null;
                }
            });
            delete rooms[player.currentRoom];
        }
        io.emit('playerListUpdate', Object.values(playerState));
    });

    // --- ADMIN PANEL EVENTS ---
    socket.on('adminLogin', (pass) => {
        if (pass === ADMIN_PASSWORD) {
            socket.emit('adminAuthSuccess');
            socket.emit('playerListUpdate', Object.values(playerState));
        } else {
            socket.emit('error', 'Invalid Password');
        }
    });

    socket.on('addFunds', async (data) => {
        const targetPlayer = playerState[data.socketId];
        if (targetPlayer) {
            const amountToAdd = parseFloat(data.amount);
            const newBal = await updateBalance(targetPlayer.userId, amountToAdd);
            targetPlayer.balance = newBal;
            
            // Notify player
            io.to(data.socketId).emit('fundsAdded', { amount: amountToAdd, newBalance: newBal });
            io.to(data.socketId).emit('balanceRefreshed', newBal);
            
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

    socket.on('disconnect', () => {
        if (playerState[socket.id]) {
            const player = playerState[socket.id];
            if (player.currentRoom && rooms[player.currentRoom]) {
                const room = rooms[player.currentRoom];
                room.players = room.players.filter(id => id !== socket.id);
                if (room.players.length === 0) delete rooms[player.currentRoom];
            }
            delete playerState[socket.id];
        }
        io.emit('statsUpdate', { online: Object.keys(playerState).length });
        io.emit('playerListUpdate', Object.values(playerState));
    });
});

// --- START SERVER ---
mongoose.connect(MONGODB_URI)
    .then(() => {
        console.log('✅ Connected to MongoDB Atlas');
        server.listen(PORT, () => console.log(`🚀 Bingo Server running on port ${PORT}`));
    })
    .catch(err => console.error('❌ MongoDB Connection Error:', err));
