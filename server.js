const express = require('express');
const mongoose = require('mongoose');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    transports: ['websocket', 'polling']
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// MongoDB Connection
const mongoURI = 'mongodb+srv://israelnegasi:mikejava@cluster0.b2hukwx.mongodb.net/bingo_elite?retryWrites=true&w=majority';

mongoose.connect(mongoURI, {
    useNewUrlParser: true,
    useUnifiedTopology: true
})
.then(() => console.log('✅ MongoDB Connected Successfully'))
.catch(err => console.error('❌ MongoDB Connection Error:', err));

// MongoDB Schemas
const playerSchema = new mongoose.Schema({
    userId: String,
    userName: String,
    balance: { type: Number, default: 0 },
    socketId: String,
    currentRoom: String,
    box: Number,
    isBanned: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now }
});

const roomSchema = new mongoose.Schema({
    stakeAmount: Number,
    players: [{
        socketId: String,
        userId: String,
        userName: String,
        box: Number,
        grid: Array,
        markedNumbers: Array
    }],
    takenBoxes: [Number],
    status: { type: String, default: 'waiting' }, // waiting, playing, ended
    currentNumbers: [Number],
    winner: String,
    prize: Number,
    countdownTimer: Number,
    createdAt: { type: Date, default: Date.now }
});

const transactionSchema = new mongoose.Schema({
    playerId: String,
    playerName: String,
    type: String, // deposit, withdraw, game_won, game_lost, admin_add
    amount: Number,
    room: String,
    admin: { type: Boolean, default: false },
    timestamp: { type: Date, default: Date.now }
});

const adminSchema = new mongoose.Schema({
    username: String,
    password: String,
    lastLogin: Date
});

// Models
const Player = mongoose.model('Player', playerSchema);
const Room = mongoose.model('Room', roomSchema);
const Transaction = mongoose.model('Transaction', transactionSchema);
const Admin = mongoose.model('Admin', adminSchema);

// In-memory storage for active games (optional, can use Redis in production)
const activeRooms = {};
const roomTimers = {};

// Serve HTML files
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// API Routes for Admin
app.get('/api/players', async (req, res) => {
    try {
        const players = await Player.find({});
        res.json(players);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/add-funds', async (req, res) => {
    try {
        const { playerId, amount } = req.body;
        
        const player = await Player.findOne({ socketId: playerId });
        if (!player) {
            return res.status(404).json({ error: 'Player not found' });
        }
        
        player.balance += parseFloat(amount);
        await player.save();
        
        // Record transaction
        await Transaction.create({
            playerId: player.socketId,
            playerName: player.userName,
            type: 'admin_add',
            amount: parseFloat(amount),
            admin: true
        });
        
        // Notify player via socket if connected
        io.to(playerId).emit('fundsAdded', {
            amount: parseFloat(amount),
            newBalance: player.balance
        });
        
        res.json({ success: true, newBalance: player.balance });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Socket.io Connection Handling
io.on('connection', (socket) => {
    console.log('New client connected:', socket.id);
    
    // Player initialization
    socket.on('init', async (data) => {
        try {
            const { userId, userName } = data;
            
            let player = await Player.findOne({ userId });
            
            if (!player) {
                player = await Player.create({
                    userId,
                    userName,
                    balance: 0, // Start with 0 balance
                    socketId: socket.id
                });
            } else {
                player.socketId = socket.id;
                await player.save();
            }
            
            socket.emit('balanceUpdate', player.balance);
            
            // Update admin panel
            updateAdminData();
        } catch (error) {
            console.error('Init error:', error);
        }
    });
    
    // Refresh balance
    socket.on('refreshBalance', async () => {
        try {
            const player = await Player.findOne({ socketId: socket.id });
            if (player) {
                socket.emit('balanceUpdate', player.balance);
                socket.emit('balanceRefreshed', player.balance);
            }
        } catch (error) {
            console.error('Refresh balance error:', error);
        }
    });
    
    // Get taken boxes for a room
    socket.on('getTakenBoxes', async (data, callback) => {
        try {
            const room = await Room.findOne({ stakeAmount: data.room });
            if (room) {
                callback(room.takenBoxes || []);
            } else {
                callback([]);
            }
        } catch (error) {
            console.error('Get taken boxes error:', error);
            callback([]);
        }
    });
    
    // Join a room
    socket.on('joinRoom', async (data) => {
        try {
            const { room, box, userName } = data;
            
            // Check player balance
            const player = await Player.findOne({ socketId: socket.id });
            if (!player || player.balance < room) {
                socket.emit('insufficientFunds');
                return;
            }
            
            // Find or create room
            let gameRoom = await Room.findOne({ stakeAmount: room });
            if (!gameRoom) {
                gameRoom = await Room.create({
                    stakeAmount: room,
                    players: [],
                    takenBoxes: [],
                    status: 'waiting'
                });
                activeRooms[room] = gameRoom;
            }
            
            // Check if box is already taken
            if (gameRoom.takenBoxes.includes(box)) {
                socket.emit('boxTaken');
                return;
            }
            
            // Deduct stake from player balance
            player.balance -= room;
            player.currentRoom = room;
            player.box = box;
            await player.save();
            
            // Add player to room
            gameRoom.players.push({
                socketId: socket.id,
                userId: player.userId,
                userName,
                box,
                grid: [],
                markedNumbers: []
            });
            
            gameRoom.takenBoxes.push(box);
            await gameRoom.save();
            
            activeRooms[room] = gameRoom;
            
            // Notify player
            socket.emit('joinedRoom');
            
            // Update lobby count for all players in this room
            io.emit('lobbyUpdate', {
                room: room,
                count: gameRoom.players.length
            });
            
            // Start countdown if 2+ players
            if (gameRoom.players.length >= 2 && gameRoom.status === 'waiting') {
                startGameCountdown(room);
            }
            
            updateAdminData();
        } catch (error) {
            console.error('Join room error:', error);
        }
    });
    
    // Claim bingo
    socket.on('claimBingo', async (data) => {
        try {
            const { room, grid, marked } = data;
            const gameRoom = await Room.findOne({ stakeAmount: room });
            
            if (!gameRoom) return;
            
            // Verify bingo (simplified check)
            const playerInRoom = gameRoom.players.find(p => p.socketId === socket.id);
            if (playerInRoom && isBingoValid(marked, gameRoom.currentNumbers)) {
                
                // End game
                gameRoom.status = 'ended';
                gameRoom.winner = socket.id;
                gameRoom.prize = gameRoom.players.length * gameRoom.stakeAmount * 0.9; // 90% payout
                await gameRoom.save();
                
                // Award prize
                const winner = await Player.findOne({ socketId: socket.id });
                if (winner) {
                    winner.balance += gameRoom.prize;
                    await winner.save();
                    
                    // Record transaction
                    await Transaction.create({
                        playerId: socket.id,
                        playerName: winner.userName,
                        type: 'game_won',
                        amount: gameRoom.prize,
                        room: room
                    });
                }
                
                // Notify all players
                io.to(room).emit('gameOver', {
                    room: room,
                    winnerId: socket.id,
                    winnerName: winner.userName,
                    prize: gameRoom.prize
                });
                
                // Reset players' room status
                for (const player of gameRoom.players) {
                    const p = await Player.findOne({ socketId: player.socketId });
                    if (p) {
                        p.currentRoom = null;
                        p.box = null;
                        await p.save();
                    }
                }
                
                // Clear active room
                delete activeRooms[room];
                clearTimeout(roomTimers[room]);
                delete roomTimers[room];
                
                updateAdminData();
            }
        } catch (error) {
            console.error('Bingo claim error:', error);
        }
    });
    
    // Admin authentication
    socket.on('admin:auth', (password) => {
        // In production, use environment variables and hash passwords
        if (password === 'admin123') {
            socket.emit('admin:authSuccess');
            sendAdminData(socket);
        } else {
            socket.emit('admin:authError', 'Invalid password');
        }
    });
    
    // Get admin data
    socket.on('admin:getData', () => {
        sendAdminData(socket);
    });
    
    // Admin: Add funds
    socket.on('admin:addFunds', async (data) => {
        try {
            const { playerId, amount } = data;
            const player = await Player.findOne({ socketId: playerId });
            
            if (!player) {
                socket.emit('admin:error', 'Player not found');
                return;
            }
            
            player.balance += parseFloat(amount);
            await player.save();
            
            // Record transaction
            await Transaction.create({
                playerId: playerId,
                playerName: player.userName,
                type: 'admin_add',
                amount: parseFloat(amount),
                admin: true
            });
            
            // Notify player
            io.to(playerId).emit('fundsAdded', {
                amount: parseFloat(amount),
                newBalance: player.balance
            });
            
            socket.emit('admin:success', `Added ${amount} ETB to ${player.userName}`);
            updateAdminData();
        } catch (error) {
            socket.emit('admin:error', error.message);
        }
    });
    
    // Admin: Ban player
    socket.on('admin:banPlayer', async (playerId) => {
        try {
            const player = await Player.findOne({ socketId: playerId });
            if (player) {
                player.isBanned = true;
                await player.save();
                
                // Kick player if connected
                io.to(playerId).emit('banned');
                socket.emit('admin:success', `Banned ${player.userName}`);
                
                updateAdminData();
            }
        } catch (error) {
            socket.emit('admin:error', error.message);
        }
    });
    
    // Disconnect
    socket.on('disconnect', async () => {
        console.log('Client disconnected:', socket.id);
        
        // Remove player from rooms
        const player = await Player.findOne({ socketId: socket.id });
        if (player && player.currentRoom) {
            const room = await Room.findOne({ stakeAmount: player.currentRoom });
            if (room) {
                room.players = room.players.filter(p => p.socketId !== socket.id);
                await room.save();
                
                // Update lobby count
                io.emit('lobbyUpdate', {
                    room: player.currentRoom,
                    count: room.players.length
                });
            }
            
            player.currentRoom = null;
            player.box = null;
            await player.save();
        }
        
        updateAdminData();
    });
});

// Helper functions
function startGameCountdown(room) {
    let countdown = 10;
    roomTimers[room] = setInterval(async () => {
        io.emit('gameCountdown', {
            room: room,
            timer: countdown
        });
        
        countdown--;
        
        if (countdown < 0) {
            clearInterval(roomTimers[room]);
            delete roomTimers[room];
            
            // Start game
            const gameRoom = activeRooms[room];
            if (gameRoom) {
                gameRoom.status = 'playing';
                gameRoom.currentNumbers = [];
                
                // Draw first ball after 1 second
                setTimeout(() => {
                    drawBall(room);
                }, 1000);
            }
        }
    }, 1000);
}

function drawBall(room) {
    const gameRoom = activeRooms[room];
    if (!gameRoom) return;
    
    // Generate random number 1-75
    const drawnNumber = Math.floor(Math.random() * 75) + 1;
    
    if (!gameRoom.currentNumbers.includes(drawnNumber)) {
        gameRoom.currentNumbers.push(drawnNumber);
        
        // Emit to all players in room
        io.emit('ballDrawn', {
            room: room,
            num: drawnNumber
        });
        
        // Enable bingo button after 5 balls
        if (gameRoom.currentNumbers.length >= 5) {
            io.emit('enableBingo');
        }
        
        // Draw next ball after 5 seconds if game still active
        if (gameRoom.status === 'playing' && gameRoom.currentNumbers.length < 75) {
            setTimeout(() => {
                drawBall(room);
            }, 5000);
        } else if (gameRoom.currentNumbers.length >= 75) {
            // No one claimed bingo
            endGameWithNoWinner(room);
        }
    } else {
        // Number already drawn, try again
        setTimeout(() => {
            drawBall(room);
        }, 100);
    }
}

function endGameWithNoWinner(room) {
    const gameRoom = activeRooms[room];
    if (!gameRoom) return;
    
    gameRoom.status = 'ended';
    gameRoom.winner = 'HOUSE';
    gameRoom.prize = 0;
    
    io.emit('gameOver', {
        room: room,
        winnerId: 'HOUSE',
        winnerName: 'House',
        prize: 0
    });
    
    // Return stakes to players
    gameRoom.players.forEach(async (player) => {
        const p = await Player.findOne({ socketId: player.socketId });
        if (p) {
            p.balance += gameRoom.stakeAmount;
            p.currentRoom = null;
            p.box = null;
            await p.save();
        }
    });
    
    delete activeRooms[room];
}

function isBingoValid(markedNumbers, calledNumbers) {
    // Simplified bingo validation
    // In production, implement proper bingo pattern checking
    return true;
}

async function sendAdminData(socket) {
    try {
        const totalPlayers = await Player.countDocuments();
        const activePlayers = await Player.countDocuments({ currentRoom: { $ne: null } });
        const rooms = await Room.find({});
        const activeGames = rooms.filter(room => room.status === 'playing').length;
        
        // Calculate total wagered (sum of all stakes)
        const totalWagered = rooms.reduce((sum, room) => {
            return sum + (room.players.length * room.stakeAmount);
        }, 0);
        
        // Calculate house balance (total deposits - total winnings)
        const winningTransactions = await Transaction.aggregate([
            { $match: { type: 'game_won' } },
            { $group: { _id: null, total: { $sum: '$amount' } } }
        ]);
        
        const depositTransactions = await Transaction.aggregate([
            { $match: { type: 'admin_add' } },
            { $group: { _id: null, total: { $sum: '$amount' } } }
        ]);
        
        const houseBalance = (depositTransactions[0]?.total || 0) - (winningTransactions[0]?.total || 0);
        
        // Get players data
        const players = await Player.find({});
        const playerData = players.map(p => ({
            socketId: p.socketId,
            userName: p.userName,
            balance: p.balance,
            currentRoom: p.currentRoom,
            box: p.box
        }));
        
        // Get transactions
        const transactions = await Transaction.find({}).sort({ timestamp: -1 }).limit(50);
        
        socket.emit('admin:update', {
            totalPlayers,
            activeGames,
            houseBalance,
            totalWagered
        });
        
        socket.emit('admin:players', playerData);
        socket.emit('admin:rooms', activeRooms);
        socket.emit('admin:transactions', transactions);
        
    } catch (error) {
        console.error('Admin data error:', error);
    }
}

function updateAdminData() {
    io.emit('admin:getData');
}

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🌐 Admin Panel: http://localhost:${PORT}/admin`);
    console.log(`🎮 Game: http://localhost:${PORT}/`);
});
