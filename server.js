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
    isOnline: { type: Boolean, default: false },
    lastSeen: { type: Date, default: Date.now },
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
    startedAt: Date,
    endedAt: Date,
    createdAt: { type: Date, default: Date.now }
});

const transactionSchema = new mongoose.Schema({
    playerId: String,
    playerName: String,
    socketId: String,
    type: String, // deposit, withdraw, game_won, game_lost, admin_add, join_room, leave_room
    amount: Number,
    room: String,
    details: String,
    admin: { type: Boolean, default: false },
    timestamp: { type: Date, default: Date.now }
});

// Models
const Player = mongoose.model('Player', playerSchema);
const Room = mongoose.model('Room', roomSchema);
const Transaction = mongoose.model('Transaction', transactionSchema);

// In-memory storage for active connections
const activeSockets = new Map(); // socket.id -> player data
const activeRooms = new Map(); // room amount -> room data
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
            socketId: player.socketId,
            type: 'admin_add',
            amount: parseFloat(amount),
            details: `Admin added ${amount} ETB`,
            admin: true
        });
        
        // Notify player via socket if connected
        const socket = Array.from(io.sockets.sockets.values())
            .find(s => s.id === playerId);
        if (socket) {
            socket.emit('fundsAdded', {
                amount: parseFloat(amount),
                newBalance: player.balance
            });
            socket.emit('balanceUpdate', player.balance);
        }
        
        // Update admin panel
        updateAdminData();
        
        res.json({ success: true, newBalance: player.balance });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Socket.io Connection Handling
io.on('connection', (socket) => {
    console.log('✅ New client connected:', socket.id);
    activeSockets.set(socket.id, { connectedAt: new Date() });
    
    // Player initialization
    socket.on('init', async (data) => {
        try {
            const { userId, userName } = data;
            
            let player = await Player.findOne({ userId });
            
            if (!player) {
                // Create new player
                player = new Player({
                    userId,
                    userName: userName || `Player_${Math.random().toString(36).substr(2, 9)}`,
                    balance: 0,
                    socketId: socket.id,
                    isOnline: true,
                    lastSeen: new Date()
                });
                await player.save();
                
                // Record transaction for new player
                await Transaction.create({
                    playerId: socket.id,
                    playerName: player.userName,
                    socketId: socket.id,
                    type: 'player_joined',
                    amount: 0,
                    details: 'New player joined the system'
                });
            } else {
                // Update existing player
                player.socketId = socket.id;
                player.isOnline = true;
                player.lastSeen = new Date();
                await player.save();
            }
            
            // Store in active sockets
            activeSockets.set(socket.id, {
                ...activeSockets.get(socket.id),
                userId: player.userId,
                userName: player.userName,
                playerId: player._id
            });
            
            // Send balance to player
            socket.emit('balanceUpdate', player.balance);
            socket.emit('balanceRefreshed', player.balance);
            
            console.log(`👤 Player initialized: ${player.userName} (${socket.id})`);
            
            // Update admin panel
            updateAdminData();
        } catch (error) {
            console.error('❌ Init error:', error);
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
            console.error('❌ Refresh balance error:', error);
        }
    });
    
    // Get taken boxes for a room
    socket.on('getTakenBoxes', async (data, callback) => {
        try {
            const { room } = data;
            const gameRoom = await Room.findOne({ stakeAmount: room, status: { $in: ['waiting', 'playing'] } });
            if (gameRoom) {
                callback(gameRoom.takenBoxes || []);
            } else {
                callback([]);
            }
        } catch (error) {
            console.error('❌ Get taken boxes error:', error);
            callback([]);
        }
    });
    
    // Join a room
    socket.on('joinRoom', async (data) => {
        try {
            const { room, box, userName } = data;
            
            // Check if player exists
            let player = await Player.findOne({ socketId: socket.id });
            if (!player) {
                socket.emit('error', 'Player not found. Please reconnect.');
                return;
            }
            
            // Check player balance
            if (player.balance < room) {
                socket.emit('insufficientFunds');
                return;
            }
            
            // Find or create room
            let gameRoom = await Room.findOne({ stakeAmount: room, status: { $in: ['waiting', 'playing'] } });
            if (!gameRoom) {
                gameRoom = new Room({
                    stakeAmount: room,
                    players: [],
                    takenBoxes: [],
                    status: 'waiting',
                    currentNumbers: []
                });
                await gameRoom.save();
            }
            
            // Check if box is already taken
            if (gameRoom.takenBoxes.includes(box)) {
                socket.emit('boxTaken');
                return;
            }
            
            // Check if player is already in a room
            if (player.currentRoom) {
                socket.emit('error', 'You are already in a room.');
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
                userName: player.userName || userName,
                box,
                grid: [],
                markedNumbers: []
            });
            
            gameRoom.takenBoxes.push(box);
            await gameRoom.save();
            
            // Store in memory
            activeRooms.set(room, gameRoom);
            
            // Join socket room
            socket.join(`room_${room}`);
            
            // Notify player
            socket.emit('joinedRoom');
            
            // Update lobby count for all players in this room
            io.to(`room_${room}`).emit('lobbyUpdate', {
                room: room,
                count: gameRoom.players.length
            });
            
            // Record transaction
            await Transaction.create({
                playerId: socket.id,
                playerName: player.userName,
                socketId: socket.id,
                type: 'join_room',
                amount: -room,
                room: room,
                details: `Joined ${room} ETB room with box ${box}`
            });
            
            // Start countdown if 2+ players
            if (gameRoom.players.length >= 2 && gameRoom.status === 'waiting') {
                startGameCountdown(room);
            }
            
            console.log(`🎮 Player ${player.userName} joined room ${room} ETB with box ${box}`);
            
            // Update admin panel
            updateAdminData();
        } catch (error) {
            console.error('❌ Join room error:', error);
            socket.emit('error', 'Failed to join room. Please try again.');
        }
    });
    
    // Claim bingo
    socket.on('claimBingo', async (data) => {
        try {
            const { room, grid, marked } = data;
            const gameRoom = await Room.findOne({ stakeAmount: room, status: 'playing' });
            
            if (!gameRoom) {
                socket.emit('error', 'Game not found or not in progress.');
                return;
            }
            
            // Find player in room
            const playerInRoom = gameRoom.players.find(p => p.socketId === socket.id);
            if (!playerInRoom) {
                socket.emit('error', 'You are not in this game.');
                return;
            }
            
            // Simplified bingo validation (in production, implement proper validation)
            const isValidBingo = validateBingo(marked, gameRoom.currentNumbers);
            
            if (isValidBingo) {
                // End game
                gameRoom.status = 'ended';
                gameRoom.winner = socket.id;
                gameRoom.prize = gameRoom.players.length * gameRoom.stakeAmount * 0.9; // 90% payout
                gameRoom.endedAt = new Date();
                await gameRoom.save();
                
                // Award prize to winner
                const winner = await Player.findOne({ socketId: socket.id });
                if (winner) {
                    winner.balance += gameRoom.prize;
                    winner.currentRoom = null;
                    winner.box = null;
                    await winner.save();
                    
                    // Record transaction
                    await Transaction.create({
                        playerId: socket.id,
                        playerName: winner.userName,
                        socketId: socket.id,
                        type: 'game_won',
                        amount: gameRoom.prize,
                        room: room,
                        details: `Won Bingo in ${room} ETB room`
                    });
                }
                
                // Notify all players in room
                io.to(`room_${room}`).emit('gameOver', {
                    room: room,
                    winnerId: socket.id,
                    winnerName: winner.userName,
                    prize: gameRoom.prize
                });
                
                // Return stakes to other players
                for (const player of gameRoom.players) {
                    if (player.socketId !== socket.id) {
                        const p = await Player.findOne({ socketId: player.socketId });
                        if (p) {
                            p.balance += gameRoom.stakeAmount;
                            p.currentRoom = null;
                            p.box = null;
                            await p.save();
                            
                            // Record transaction
                            await Transaction.create({
                                playerId: player.socketId,
                                playerName: player.userName,
                                socketId: player.socketId,
                                type: 'game_lost',
                                amount: gameRoom.stakeAmount,
                                room: room,
                                details: `Lost Bingo in ${room} ETB room, stake returned`
                            });
                        }
                    }
                }
                
                // Clear active room
                activeRooms.delete(room);
                if (roomTimers[room]) {
                    clearTimeout(roomTimers[room]);
                    delete roomTimers[room];
                }
                
                console.log(`🏆 Player ${winner.userName} won Bingo in room ${room} ETB with prize ${gameRoom.prize} ETB`);
                
                updateAdminData();
            } else {
                socket.emit('error', 'Invalid Bingo claim.');
            }
        } catch (error) {
            console.error('❌ Bingo claim error:', error);
            socket.emit('error', 'Failed to process Bingo claim.');
        }
    });
    
    // Admin authentication
    socket.on('admin:auth', (password) => {
        // In production, use environment variables and hash passwords
        const ADMIN_PASSWORD = 'admin123'; // Change this in production!
        if (password === ADMIN_PASSWORD) {
            socket.emit('admin:authSuccess');
            sendAdminData(socket);
            console.log(`🔐 Admin logged in via socket ${socket.id}`);
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
            
            if (!playerId || !amount || amount <= 0) {
                socket.emit('admin:error', 'Invalid player ID or amount');
                return;
            }
            
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
                socketId: playerId,
                type: 'admin_add',
                amount: parseFloat(amount),
                details: `Admin added ${amount} ETB`,
                admin: true
            });
            
            // Notify player if connected
            const playerSocket = io.sockets.sockets.get(playerId);
            if (playerSocket) {
                playerSocket.emit('fundsAdded', {
                    amount: parseFloat(amount),
                    newBalance: player.balance
                });
                playerSocket.emit('balanceUpdate', player.balance);
            }
            
            socket.emit('admin:success', `Added ${amount} ETB to ${player.userName}`);
            updateAdminData();
            
            console.log(`💰 Admin added ${amount} ETB to ${player.userName}`);
        } catch (error) {
            console.error('❌ Admin add funds error:', error);
            socket.emit('admin:error', error.message);
        }
    });
    
    // Admin: Ban player
    socket.on('admin:banPlayer', async (playerId) => {
        try {
            const player = await Player.findOne({ socketId: playerId });
            if (player) {
                player.isBanned = true;
                player.isOnline = false;
                await player.save();
                
                // Kick player if connected
                const playerSocket = io.sockets.sockets.get(playerId);
                if (playerSocket) {
                    playerSocket.emit('banned');
                    playerSocket.disconnect();
                }
                
                socket.emit('admin:success', `Banned ${player.userName}`);
                updateAdminData();
                
                console.log(`🔨 Admin banned player ${player.userName}`);
            } else {
                socket.emit('admin:error', 'Player not found');
            }
        } catch (error) {
            console.error('❌ Admin ban player error:', error);
            socket.emit('admin:error', error.message);
        }
    });
    
    // Admin: Force draw ball
    socket.on('admin:forceDraw', async (roomAmount) => {
        try {
            const room = activeRooms.get(parseInt(roomAmount));
            if (room && room.status === 'playing') {
                drawBall(parseInt(roomAmount));
                socket.emit('admin:success', `Force-drawn ball in ${roomAmount} ETB room`);
            } else {
                socket.emit('admin:error', 'Room not found or not in playing state');
            }
        } catch (error) {
            console.error('❌ Force draw error:', error);
            socket.emit('admin:error', error.message);
        }
    });
    
    // Disconnect
    socket.on('disconnect', async () => {
        console.log('❌ Client disconnected:', socket.id);
        
        try {
            // Get player info from active sockets
            const socketInfo = activeSockets.get(socket.id);
            
            // Update player status in database
            const player = await Player.findOne({ socketId: socket.id });
            if (player) {
                player.isOnline = false;
                player.lastSeen = new Date();
                
                // If player was in a room, remove them
                if (player.currentRoom) {
                    const roomAmount = player.currentRoom;
                    const gameRoom = await Room.findOne({ 
                        stakeAmount: roomAmount, 
                        status: { $in: ['waiting', 'playing'] } 
                    });
                    
                    if (gameRoom) {
                        // Remove player from room
                        gameRoom.players = gameRoom.players.filter(p => p.socketId !== socket.id);
                        gameRoom.takenBoxes = gameRoom.takenBoxes.filter(b => b !== player.box);
                        
                        // Update lobby count
                        io.to(`room_${roomAmount}`).emit('lobbyUpdate', {
                            room: roomAmount,
                            count: gameRoom.players.length
                        });
                        
                        // If room becomes empty or only 1 player left, cancel countdown
                        if (gameRoom.players.length < 2 && roomTimers[roomAmount]) {
                            clearTimeout(roomTimers[roomAmount]);
                            delete roomTimers[roomAmount];
                            gameRoom.status = 'waiting';
                        }
                        
                        await gameRoom.save();
                        
                        // Record transaction
                        await Transaction.create({
                            playerId: socket.id,
                            playerName: player.userName,
                            socketId: socket.id,
                            type: 'leave_room',
                            amount: 0,
                            room: roomAmount,
                            details: 'Player disconnected from room'
                        });
                    }
                    
                    player.currentRoom = null;
                    player.box = null;
                }
                
                await player.save();
            }
            
            // Remove from active sockets
            activeSockets.delete(socket.id);
            
            console.log(`👋 Player ${player ? player.userName : 'Unknown'} disconnected`);
            
            // Update admin panel
            updateAdminData();
        } catch (error) {
            console.error('❌ Disconnect error:', error);
        }
    });
});

// Helper functions
function startGameCountdown(room) {
    let countdown = 10;
    
    // Clear any existing timer
    if (roomTimers[room]) {
        clearInterval(roomTimers[room]);
    }
    
    roomTimers[room] = setInterval(async () => {
        // Emit countdown to all players in room
        io.to(`room_${room}`).emit('gameCountdown', {
            room: room,
            timer: countdown
        });
        
        countdown--;
        
        if (countdown < 0) {
            clearInterval(roomTimers[room]);
            delete roomTimers[room];
            
            // Start game
            const gameRoom = await Room.findOne({ stakeAmount: room, status: 'waiting' });
            if (gameRoom) {
                gameRoom.status = 'playing';
                gameRoom.startedAt = new Date();
                gameRoom.currentNumbers = [];
                await gameRoom.save();
                
                activeRooms.set(room, gameRoom);
                
                // Notify players game is starting
                io.to(`room_${room}`).emit('gameCountdown', {
                    room: room,
                    timer: 0
                });
                
                // Draw first ball after 1 second
                setTimeout(() => {
                    drawBall(room);
                }, 1000);
                
                console.log(`🚀 Game started in room ${room} ETB with ${gameRoom.players.length} players`);
            }
        }
    }, 1000);
}

function drawBall(room) {
    const gameRoom = activeRooms.get(room);
    if (!gameRoom || gameRoom.status !== 'playing') return;
    
    // Generate random number 1-75 (excluding already drawn numbers)
    let drawnNumber;
    do {
        drawnNumber = Math.floor(Math.random() * 75) + 1;
    } while (gameRoom.currentNumbers.includes(drawnNumber));
    
    gameRoom.currentNumbers.push(drawnNumber);
    
    // Save to database
    Room.updateOne(
        { stakeAmount: room },
        { $push: { currentNumbers: drawnNumber } }
    ).exec();
    
    // Emit to all players in room
    io.to(`room_${room}`).emit('ballDrawn', {
        room: room,
        num: drawnNumber
    });
    
    // Enable bingo button after 5 balls
    if (gameRoom.currentNumbers.length >= 5) {
        io.to(`room_${room}`).emit('enableBingo');
    }
    
    console.log(`🎱 Ball drawn in room ${room} ETB: ${drawnNumber}`);
    
    // Draw next ball after 5 seconds if game still active and not all balls drawn
    if (gameRoom.status === 'playing' && gameRoom.currentNumbers.length < 75) {
        setTimeout(() => {
            drawBall(room);
        }, 5000);
    } else if (gameRoom.currentNumbers.length >= 75) {
        // No one claimed bingo
        endGameWithNoWinner(room);
    }
}

async function endGameWithNoWinner(room) {
    const gameRoom = await Room.findOne({ stakeAmount: room, status: 'playing' });
    if (!gameRoom) return;
    
    gameRoom.status = 'ended';
    gameRoom.winner = 'HOUSE';
    gameRoom.prize = 0;
    gameRoom.endedAt = new Date();
    await gameRoom.save();
    
    // Notify all players
    io.to(`room_${room}`).emit('gameOver', {
        room: room,
        winnerId: 'HOUSE',
        winnerName: 'House',
        prize: 0
    });
    
    // Return stakes to all players
    for (const player of gameRoom.players) {
        const p = await Player.findOne({ socketId: player.socketId });
        if (p) {
            p.balance += gameRoom.stakeAmount;
            p.currentRoom = null;
            p.box = null;
            await p.save();
            
            // Record transaction
            await Transaction.create({
                playerId: player.socketId,
                playerName: player.userName,
                socketId: player.socketId,
                type: 'game_tied',
                amount: gameRoom.stakeAmount,
                room: room,
                details: 'No winner, stake returned'
            });
        }
    }
    
    activeRooms.delete(room);
    console.log(`🏠 House wins in room ${room} ETB - no bingo claimed`);
    
    updateAdminData();
}

function validateBingo(markedNumbers, calledNumbers) {
    // Simplified bingo validation
    // In production, implement proper 5x5 grid pattern checking
    // For now, just check if all marked numbers (except FREE) are in called numbers
    const filteredMarked = markedNumbers.filter(num => num !== 'FREE');
    return filteredMarked.every(num => calledNumbers.includes(num));
}

async function sendAdminData(socket) {
    try {
        // Get online players (isOnline = true)
        const onlinePlayers = await Player.find({ isOnline: true });
        const totalPlayers = await Player.countDocuments();
        
        // Get active rooms
        const activeRoomsList = await Room.find({ status: { $in: ['waiting', 'playing'] } });
        
        // Calculate house balance
        const transactions = await Transaction.aggregate([
            { $group: { _id: null, total: { $sum: '$amount' } } }
        ]);
        const houseBalance = transactions[0]?.total || 0;
        
        // Calculate total wagered
        const wageredTransactions = await Transaction.aggregate([
            { $match: { type: { $in: ['join_room', 'game_won', 'game_lost', 'game_tied'] } } },
            { $group: { _id: null, total: { $sum: { $abs: '$amount' } } } }
        ]);
        const totalWagered = wageredTransactions[0]?.total || 0;
        
        // Prepare player data for admin
        const playerData = onlinePlayers.map(p => ({
            socketId: p.socketId,
            userName: p.userName,
            balance: p.balance,
            currentRoom: p.currentRoom,
            box: p.box,
            isOnline: p.isOnline,
            lastSeen: p.lastSeen
        }));
        
        // Prepare room data for admin
        const roomData = {};
        activeRoomsList.forEach(room => {
            roomData[room.stakeAmount] = {
                stakeAmount: room.stakeAmount,
                playerCount: room.players.length,
                takenBoxes: room.takenBoxes || [],
                status: room.status,
                currentNumbers: room.currentNumbers || []
            };
        });
        
        // Get recent transactions
        const recentTransactions = await Transaction.find({})
            .sort({ timestamp: -1 })
            .limit(50)
            .lean();
        
        // Send data to admin socket
        socket.emit('admin:update', {
            totalPlayers: onlinePlayers.length,
            activeGames: activeRoomsList.filter(r => r.status === 'playing').length,
            houseBalance: houseBalance.toFixed(2),
            totalWagered: totalWagered.toFixed(2)
        });
        
        socket.emit('admin:players', playerData);
        socket.emit('admin:rooms', roomData);
        socket.emit('admin:transactions', recentTransactions);
        
    } catch (error) {
        console.error('❌ Admin data error:', error);
    }
}

function updateAdminData() {
    // Send updated data to all admin sockets
    io.emit('admin:getData');
}

// Periodic cleanup of inactive players
setInterval(async () => {
    try {
        const cutoffTime = new Date(Date.now() - 5 * 60 * 1000); // 5 minutes ago
        await Player.updateMany(
            { lastSeen: { $lt: cutoffTime }, isOnline: true },
            { $set: { isOnline: false } }
        );
        
        // Update admin panel if any changes
        updateAdminData();
    } catch (error) {
        console.error('❌ Cleanup error:', error);
    }
}, 60000); // Run every minute

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🌐 Admin Panel: http://localhost:${PORT}/admin`);
    console.log(`🎮 Game: http://localhost:${PORT}/`);
    console.log(`🔑 Admin password: admin123`);
    console.log(`📊 MongoDB: Connected`);
});
