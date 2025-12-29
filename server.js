const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    transports: ['websocket', 'polling']
});

app.use(cors());
app.use(express.json());

// In-memory storage (in production, use a database)
const users = new Map(); // userId -> { balance, socketId, name }
const rooms = new Map(); // roomId (stake) -> { players: Map, gameState, takenBoxes }
const activeGames = new Map(); // roomId -> game timer

// Game constants
const GAME_DURATION = 40; // seconds
const COUNTDOWN_DURATION = 10; // seconds for countdown
const REQUIRED_PLAYERS = 2;
const HOUSE_CUT = 0.1; // 10% house commission

// Initialize default rooms
const STAKE_LEVELS = [10, 20, 50, 100];
STAKE_LEVELS.forEach(stake => {
    rooms.set(stake, {
        players: new Map(), // socketId -> player data
        takenBoxes: new Set(),
        gameState: {
            status: 'waiting', // waiting, counting, active, finished
            calledNumbers: new Set(),
            currentBall: null,
            timer: null,
            startTime: null,
            winner: null,
            prizePool: 0
        },
        waitingRoom: [] // players waiting for game to start
    });
});

// Helper functions
function generateRandomNumber(min, max, exclude = new Set()) {
    let num;
    do {
        num = Math.floor(Math.random() * (max - min + 1)) + min;
    } while (exclude.has(num));
    return num;
}

function calculatePrizePool(players, stake) {
    const total = players.size * stake;
    const commission = total * HOUSE_CUT;
    return total - commission;
}

function generateBingoCard(seed) {
    // Create columns for B-I-N-G-O
    const columns = {
        'B': [1, 15],
        'I': [16, 30],
        'N': [31, 45],
        'G': [46, 60],
        'O': [61, 75]
    };
    
    // Use seed for deterministic random
    function seededRandom(s) {
        let seed = s % 2147483647;
        if (seed <= 0) seed += 2147483646;
        return () => {
            seed = seed * 16807 % 2147483647;
            return (seed - 1) / 2147483646;
        };
    }
    
    const random = seededRandom(seed);
    
    // Generate card
    const card = [];
    Object.values(columns).forEach(([min, max]) => {
        const colNumbers = [];
        while (colNumbers.length < 5) {
            const num = Math.floor(random() * (max - min + 1)) + min;
            if (!colNumbers.includes(num)) {
                colNumbers.push(num);
            }
        }
        colNumbers.sort((a, b) => a - b);
        card.push(...colNumbers);
    });
    
    // Middle cell is FREE
    card[12] = 'FREE';
    
    return card;
}

function checkBingo(markedNumbers, card) {
    // Check all bingo patterns
    const patterns = [
        // Rows
        [0, 1, 2, 3, 4],
        [5, 6, 7, 8, 9],
        [10, 11, 12, 13, 14],
        [15, 16, 17, 18, 19],
        [20, 21, 22, 23, 24],
        // Columns
        [0, 5, 10, 15, 20],
        [1, 6, 11, 16, 21],
        [2, 7, 12, 17, 22],
        [3, 8, 13, 18, 23],
        [4, 9, 14, 19, 24],
        // Diagonals
        [0, 6, 12, 18, 24],
        [4, 8, 12, 16, 20]
    ];
    
    for (const pattern of patterns) {
        const hasBingo = pattern.every(index => {
            const cell = card[index];
            return cell === 'FREE' || markedNumbers.has(cell);
        });
        
        if (hasBingo) {
            return true;
        }
    }
    
    return false;
}

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);
    
    // Initialize user
    socket.on('init', (data) => {
        const { userId, userName } = data;
        
        // Initialize user if not exists
        if (!users.has(userId)) {
            users.set(userId, {
                balance: 100, // Default starting balance for testing
                socketId: socket.id,
                name: userName || 'Guest',
                currentRoom: null,
                boxNumber: null
            });
        } else {
            // Update socket ID if reconnecting
            users.get(userId).socketId = socket.id;
        }
        
        const user = users.get(userId);
        socket.emit('balanceUpdate', user.balance);
        socket.emit('joinedRoom');
        
        console.log(`User ${userName} (${userId}) connected with balance ${user.balance}`);
    });
    
    // Join a room (stake level)
    socket.on('joinRoom', (data) => {
        const { room: stake, box, userName } = data;
        const userId = getUserIdBySocket(socket.id);
        
        if (!userId) {
            socket.emit('error', { message: 'User not initialized' });
            return;
        }
        
        const user = users.get(userId);
        const room = rooms.get(stake);
        
        if (!room) {
            socket.emit('error', { message: 'Invalid room' });
            return;
        }
        
        // Check balance
        if (user.balance < stake) {
            socket.emit('insufficientFunds');
            return;
        }
        
        // Check if box is taken
        if (room.takenBoxes.has(box)) {
            socket.emit('boxTaken');
            return;
        }
        
        // Deduct stake from balance
        user.balance -= stake;
        user.currentRoom = stake;
        user.boxNumber = box;
        
        // Generate unique bingo card for this box
        const card = generateBingoCard(box);
        
        // Add player to waiting room
        const playerData = {
            socketId: socket.id,
            userId,
            userName,
            box,
            card,
            markedNumbers: new Set(['FREE']),
            hasClaimedBingo: false
        };
        
        room.waitingRoom.push(playerData);
        room.takenBoxes.add(box);
        
        // Update player count in room
        const playerCount = room.waitingRoom.length + (room.players?.size || 0);
        io.to(stake.toString()).emit('lobbyUpdate', {
            room: stake,
            count: playerCount
        });
        
        // Start game if enough players
        if (playerCount >= REQUIRED_PLAYERS && room.gameState.status === 'waiting') {
            startGameCountdown(stake);
        }
        
        socket.emit('balanceUpdate', user.balance);
        socket.join(stake.toString());
        console.log(`${userName} joined room ${stake} with box ${box}`);
    });
    
    // Get taken boxes for a room
    socket.on('getTakenBoxes', (data, callback) => {
        const { room: stake } = data;
        const room = rooms.get(stake);
        
        if (room) {
            callback(Array.from(room.takenBoxes));
        } else {
            callback([]);
        }
    });
    
    // Claim bingo
    socket.on('claimBingo', (data) => {
        const { room: stake, grid, marked } = data;
        const userId = getUserIdBySocket(socket.id);
        
        if (!userId) return;
        
        const user = users.get(userId);
        const room = rooms.get(stake);
        
        if (!room || !room.gameState || room.gameState.status !== 'active') {
            socket.emit('error', { message: 'Game not active' });
            return;
        }
        
        const player = Array.from(room.players.values()).find(p => p.userId === userId);
        
        if (!player) {
            socket.emit('error', { message: 'Player not in game' });
            return;
        }
        
        // Convert marked array to Set
        const markedSet = new Set(marked);
        
        // Verify bingo
        if (checkBingo(markedSet, player.card)) {
            endGame(stake, userId, player.userName);
        } else {
            // Invalid bingo claim - penalize?
            console.log(`Invalid bingo claim by ${player.userName}`);
        }
    });
    
    // Refresh balance
    socket.on('refreshBalance', () => {
        const userId = getUserIdBySocket(socket.id);
        
        if (userId && users.has(userId)) {
            const user = users.get(userId);
            socket.emit('balanceUpdate', user.balance);
        }
    });
    
    // Admin: Add funds
    socket.on('admin:addFunds', (data) => {
        const { targetUserId, amount, adminKey } = data;
        
        // Simple admin authentication
        if (adminKey !== 'ADMIN_SECRET_KEY_123') {
            socket.emit('error', { message: 'Unauthorized' });
            return;
        }
        
        if (users.has(targetUserId)) {
            const user = users.get(targetUserId);
            user.balance += parseFloat(amount);
            
            // Notify the user
            const targetSocket = io.sockets.sockets.get(user.socketId);
            if (targetSocket) {
                targetSocket.emit('fundsAdded', {
                    amount: parseFloat(amount),
                    newBalance: user.balance
                });
                targetSocket.emit('balanceUpdate', user.balance);
            }
            
            socket.emit('admin:fundsAdded', { userId: targetUserId, newBalance: user.balance });
            console.log(`Admin added ${amount} ETB to user ${targetUserId}`);
        }
    });
    
    // Admin: Get user info
    socket.on('admin:getUserInfo', (data) => {
        const { userId, adminKey } = data;
        
        if (adminKey !== 'ADMIN_SECRET_KEY_123') {
            socket.emit('error', { message: 'Unauthorized' });
            return;
        }
        
        if (users.has(userId)) {
            const user = users.get(userId);
            socket.emit('admin:userInfo', {
                userId,
                name: user.name,
                balance: user.balance,
                currentRoom: user.currentRoom,
                boxNumber: user.boxNumber
            });
        } else {
            socket.emit('error', { message: 'User not found' });
        }
    });
    
    // Disconnect
    socket.on('disconnect', () => {
        const userId = getUserIdBySocket(socket.id);
        
        if (userId && users.has(userId)) {
            const user = users.get(userId);
            
            // Handle if user was in a game
            if (user.currentRoom) {
                const room = rooms.get(user.currentRoom);
                if (room) {
                    // Remove from waiting room
                    room.waitingRoom = room.waitingRoom.filter(p => p.userId !== userId);
                    
                    // Remove from active players
                    if (room.players.has(socket.id)) {
                        room.players.delete(socket.id);
                        room.takenBoxes.delete(user.boxNumber);
                        
                        // Update player count
                        const playerCount = room.players.size + room.waitingRoom.length;
                        io.to(user.currentRoom.toString()).emit('lobbyUpdate', {
                            room: user.currentRoom,
                            count: playerCount
                        });
                        
                        // If no players left, reset room
                        if (playerCount === 0 && room.gameState.status !== 'waiting') {
                            resetRoom(user.currentRoom);
                        }
                    }
                }
                
                user.currentRoom = null;
                user.boxNumber = null;
            }
            
            console.log(`User ${user.name} disconnected`);
        }
    });
});

// Game management functions
function startGameCountdown(stake) {
    const room = rooms.get(stake);
    if (!room || room.gameState.status !== 'waiting') return;
    
    room.gameState.status = 'counting';
    room.gameState.timer = COUNTDOWN_DURATION;
    
    // Move waiting players to active players
    room.waitingRoom.forEach(player => {
        room.players.set(player.socketId, player);
    });
    room.waitingRoom = [];
    
    // Start countdown
    const countdownInterval = setInterval(() => {
        room.gameState.timer--;
        
        io.to(stake.toString()).emit('gameCountdown', {
            room: stake,
            timer: room.gameState.timer
        });
        
        if (room.gameState.timer <= 0) {
            clearInterval(countdownInterval);
            startGame(stake);
        }
    }, 1000);
    
    console.log(`Starting countdown for room ${stake}`);
}

function startGame(stake) {
    const room = rooms.get(stake);
    if (!room) return;
    
    room.gameState.status = 'active';
    room.gameState.calledNumbers.clear();
    room.gameState.startTime = Date.now();
    room.gameState.prizePool = calculatePrizePool(room.players, stake);
    
    // Initialize each player's card
    room.players.forEach(player => {
        player.markedNumbers = new Set(['FREE']);
        player.hasClaimedBingo = false;
        
        const playerSocket = io.sockets.sockets.get(player.socketId);
        if (playerSocket) {
            playerSocket.emit('gameStarted', {
                room: stake,
                card: player.card,
                prizePool: room.gameState.prizePool
            });
        }
    });
    
    // Start drawing balls
    let ballInterval = null;
    let timeElapsed = 0;
    
    ballInterval = setInterval(() => {
        timeElapsed++;
        
        // Draw a new ball every 2 seconds
        if (timeElapsed % 2 === 0 && room.gameState.calledNumbers.size < 75) {
            drawBall(stake);
        }
        
        // Update timer for all players
        const timeLeft = GAME_DURATION - timeElapsed;
        io.to(stake.toString()).emit('gameTimerUpdate', {
            room: stake,
            timer: timeLeft
        });
        
        // End game if time's up or all numbers called
        if (timeLeft <= 0 || room.gameState.calledNumbers.size >= 75) {
            clearInterval(ballInterval);
            endGame(stake, 'HOUSE', 'House');
        }
    }, 1000);
    
    // Store interval reference
    activeGames.set(stake, ballInterval);
    
    console.log(`Game started in room ${stake} with ${room.players.size} players`);
}

function drawBall(stake) {
    const room = rooms.get(stake);
    if (!room || room.gameState.status !== 'active') return;
    
    const ball = generateRandomNumber(1, 75, room.gameState.calledNumbers);
    room.gameState.calledNumbers.add(ball);
    room.gameState.currentBall = ball;
    
    io.to(stake.toString()).emit('ballDrawn', {
        room: stake,
        num: ball,
        totalCalled: room.gameState.calledNumbers.size
    });
    
    // Check if this enables any bingos
    setTimeout(() => {
        io.to(stake.toString()).emit('enableBingo');
    }, 500);
    
    console.log(`Room ${stake}: Ball drawn - ${ball}`);
}

function endGame(stake, winnerId, winnerName = 'Unknown') {
    const room = rooms.get(stake);
    if (!room || room.gameState.status !== 'active') return;
    
    room.gameState.status = 'finished';
    room.gameState.winner = winnerId;
    
    // Clear game timer
    if (activeGames.has(stake)) {
        clearInterval(activeGames.get(stake));
        activeGames.delete(stake);
    }
    
    // Calculate prize
    const prize = winnerId === 'HOUSE' ? 0 : room.gameState.prizePool;
    
    // Award prize to winner
    if (winnerId !== 'HOUSE') {
        const winner = Array.from(room.players.values()).find(p => p.userId === winnerId);
        if (winner && users.has(winnerId)) {
            const user = users.get(winnerId);
            user.balance += prize;
            
            // Update winner's balance
            const winnerSocket = io.sockets.sockets.get(winner.socketId);
            if (winnerSocket) {
                winnerSocket.emit('balanceUpdate', user.balance);
            }
        }
    }
    
    // Notify all players
    io.to(stake.toString()).emit('gameOver', {
        room: stake,
        winnerId,
        winnerName,
        prize,
        calledNumbers: Array.from(room.gameState.calledNumbers)
    });
    
    // Reset room after delay
    setTimeout(() => {
        resetRoom(stake);
    }, 5000);
    
    console.log(`Game ended in room ${stake}. Winner: ${winnerName} (${winnerId}) Prize: ${prize}`);
}

function resetRoom(stake) {
    const room = rooms.get(stake);
    if (!room) return;
    
    // Clear all players from room
    room.players.clear();
    room.takenBoxes.clear();
    room.waitingRoom = [];
    
    // Reset game state
    room.gameState = {
        status: 'waiting',
        calledNumbers: new Set(),
        currentBall: null,
        timer: null,
        startTime: null,
        winner: null,
        prizePool: 0
    };
    
    // Clear any active interval
    if (activeGames.has(stake)) {
        clearInterval(activeGames.get(stake));
        activeGames.delete(stake);
    }
    
    console.log(`Room ${stake} reset`);
}

// Helper function to get user ID by socket ID
function getUserIdBySocket(socketId) {
    for (const [userId, user] of users.entries()) {
        if (user.socketId === socketId) {
            return userId;
        }
    }
    return null;
}

// Admin API endpoints
app.post('/api/admin/add-funds', (req, res) => {
    const { userId, amount, adminKey } = req.body;
    
    if (adminKey !== 'ADMIN_SECRET_KEY_123') {
        return res.status(403).json({ error: 'Unauthorized' });
    }
    
    if (!users.has(userId)) {
        return res.status(404).json({ error: 'User not found' });
    }
    
    const user = users.get(userId);
    user.balance += parseFloat(amount);
    
    // Notify user via socket if connected
    const userSocket = Array.from(io.sockets.sockets.values())
        .find(socket => getUserIdBySocket(socket.id) === userId);
    
    if (userSocket) {
        userSocket.emit('fundsAdded', {
            amount: parseFloat(amount),
            newBalance: user.balance
        });
        userSocket.emit('balanceUpdate', user.balance);
    }
    
    res.json({ success: true, newBalance: user.balance });
});

app.get('/api/stats', (req, res) => {
    const stats = {
        totalUsers: users.size,
        activeRooms: Array.from(rooms.entries())
            .filter(([stake, room]) => room.players.size > 0 || room.waitingRoom.length > 0)
            .map(([stake, room]) => ({
                stake,
                activePlayers: room.players.size,
                waitingPlayers: room.waitingRoom.length,
                gameStatus: room.gameState.status
            })),
        totalBalance: Array.from(users.values()).reduce((sum, user) => sum + user.balance, 0)
    };
    
    res.json(stats);
});

app.get('/api/rooms/:stake', (req, res) => {
    const stake = parseInt(req.params.stake);
    const room = rooms.get(stake);
    
    if (!room) {
        return res.status(404).json({ error: 'Room not found' });
    }
    
    res.json({
        stake,
        takenBoxes: Array.from(room.takenBoxes),
        playerCount: room.players.size + room.waitingRoom.length,
        gameStatus: room.gameState.status
    });
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

// Serve static files if needed
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    
    // Log all initialized rooms
    console.log('Initialized rooms:', Array.from(rooms.keys()).map(stake => `${stake} ETB`));
});
