const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');

const app = express();

// 1. IMPROVED CORS: Allow all origins and methods
app.use(cors({
    origin: "*",
    methods: ["GET", "POST"]
}));

const server = http.createServer(app);

// 2. SOCKET.IO CORS: Explicitly allow connection from any origin
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"],
        credentials: true
    },
    allowEIO3: true // Compatibility for older clients
});

// 3. HEALTH CHECK: Visit your-url.onrender.com/ to check if it's alive
app.get('/', (req, res) => {
    res.send({ status: 'Server is running', time: new Date() });
});

// MongoDB Connection
const MONGO_URI = "mongodb+srv://isrealnegasi21:7138isreal@cluster0.h79no.mongodb.net/bingo_elite?retryWrites=true&w=majority";
mongoose.connect(MONGO_URI)
    .then(() => console.log("✅ MongoDB Connected"))
    .catch(err => console.error("❌ MongoDB Error:", err));

const UserSchema = new mongoose.Schema({
    userId: String,
    userName: String,
    balance: { type: Number, default: 0 },
    isBanned: { type: Boolean, default: false }
});
const User = mongoose.model('User', UserSchema);

const players = new Map();
const rooms = { 10: [], 20: [], 50: [], 100: [] };

io.on('connection', (socket) => {
    console.log('New connection:', socket.id);

    socket.on('auth', async (userData) => {
        let user = await User.findOne({ userId: userData.id.toString() });
        if (!user) {
            user = new User({ userId: userData.id.toString(), userName: userData.first_name, balance: 0 });
            await user.save();
        }

        if (user.isBanned) {
            socket.emit('banned');
            return socket.disconnect();
        }

        players.set(socket.id, {
            socketId: socket.id,
            userId: user.userId,
            userName: user.userName,
            balance: user.balance,
            currentRoom: null,
            box: null
        });

        socket.emit('authSuccess', { userName: user.userName });
        socket.emit('balanceRefreshed', user.balance);
        updateAdminList();
    });

    socket.on('adminLogin', (password) => {
        if (password === 'admin123') { // Change this to your preferred password
            socket.join('admin_room');
            socket.emit('adminAuthSuccess');
            updateAdminList();
        } else {
            socket.emit('error', 'Invalid password');
        }
    });

    socket.on('addFunds', async (data) => {
        const player = players.get(data.socketId);
        if (player) {
            const amount = parseFloat(data.amount);
            player.balance += amount;
            await User.findOneAndUpdate({ userId: player.userId }, { $inc: { balance: amount } });
            
            io.to(data.socketId).emit('balanceRefreshed', player.balance);
            io.to(data.socketId).emit('fundsAdded', { amount, newBalance: player.balance });
            updateAdminList();
        }
    });

    socket.on('joinRoom', (data) => {
        const player = players.get(socket.id);
        if (!player || player.balance < data.stake) return;

        player.currentRoom = data.stake;
        rooms[data.stake].push(socket.id);

        if (rooms[data.stake].length >= 2) {
            const p1Id = rooms[data.stake].shift();
            const p2Id = rooms[data.stake].shift();
            
            const prize = data.stake * 1.8;
            io.to(p1Id).to(p2Id).emit('gameStart', { prize });
        }
        updateAdminList();
    });

    socket.on('selectBox', async (num) => {
        const player = players.get(socket.id);
        if (!player) return;
        player.box = num;
        updateAdminList();

        // Simple win logic: 50% chance
        const isWinner = Math.random() > 0.5;
        const stake = player.currentRoom;
        const prize = stake * 1.8;

        if (isWinner) {
            player.balance += (prize - stake);
            await User.findOneAndUpdate({ userId: player.userId }, { balance: player.balance });
            socket.emit('gameResult', { status: 'win', prize });
        } else {
            player.balance -= stake;
            await User.findOneAndUpdate({ userId: player.userId }, { balance: player.balance });
            socket.emit('gameResult', { status: 'lose', msg: 'The winning box was ' + (num === 9 ? 1 : num + 1) });
        }

        player.currentRoom = null;
        player.box = null;
        socket.emit('balanceRefreshed', player.balance);
        updateAdminList();
    });

    socket.on('disconnect', () => {
        players.delete(socket.id);
        updateAdminList();
    });
});

function updateAdminList() {
    const playerList = Array.from(players.values());
    io.to('admin_room').emit('playerListUpdate', playerList);
    io.to('admin_room').emit('statsUpdate', { online: players.size });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
