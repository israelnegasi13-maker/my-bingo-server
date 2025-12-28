const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.use(cors());
app.use(express.static('public'));

// Game Configuration
const ROOM_STAKES = [10, 20, 50, 100];
const MAX_PLAYERS_PER_ROOM = 50;
const GAME_COUNTDOWN = 10; // seconds
const BALL_DRAW_INTERVAL = 5; // seconds
const TOTAL_BALLS = 75;
const BINGO_LETTERS = ['B', 'I', 'N', 'G', 'O'];
const BINGO_RANGES = {
    'B': { min: 1, max: 15 },
    'I': { min: 16, max: 30 },
    'N': { min: 31, max: 45 },
    'G': { min: 46, max: 60 },
    'O': { min: 61, max: 75 }
};

// Game State
let players = new Map(); // socketId -> player data
let rooms = new Map(); // stake amount -> room data
let transactions = [];
let houseBalance = 100000; // Starting house balance
let adminPassword = "admin123"; // Change this in production

// Initialize rooms
ROOM_STAKES.forEach(stake => {
    rooms.set(stake, {
        stake: stake,
        players: new Set(),
        takenBoxes: new Set(),
        status: 'waiting', // waiting, countdown, playing, ended
        countdown: null,
        calledNumbers: [],
        gameInterval: null,
        startTime: null,
        winner: null
    });
});

// Helper Functions
function generateBingoGrid(seed) {
    const columns = {
        'B': Array.from({length: 15}, (_, i) => i + 1),
        'I': Array.from({length: 15}, (_, i) => i + 16),
        'N': Array.from({length: 15}, (_, i) => i + 31),
        'G': Array.from({length: 15}, (_, i) => i + 46),
        'O': Array.from({length: 15}, (_, i) => i + 61)
    };

    // Seeded shuffle
    function seededRandom(s) {
        let seed = s % 2147483647;
        return function() {
            seed = seed * 16807 % 2147483647;
            return (seed - 1) / 2147483646;
        };
    }

    const random = seededRandom(seed);
    
    // Shuffle each column
    Object.keys(columns).forEach(col => {
        const arr = columns[col];
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(random() * (i + 1));
            [arr[i], arr[j]] = [arr[j], arr[i]];
        }
    });

    // Create 5x5 grid
    const grid = [];
    const letters = ['B', 'I', 'N', 'G', 'O'];
    
    for (let row = 0; row < 5; row++) {
        for (let col = 0; col < 5; col++) {
            const letter = letters[col];
            if (row === 2 && col === 2) {
                grid.push('FREE');
            } else {
                grid.push(columns[letter][row]);
            }
        }
    }
    
    return grid;
}

function checkWinningPattern(grid, markedNumbers) {
    // Convert marked numbers to positions (0-24)
    const markedPositions = new Set();
    grid.forEach((num, index) => {
        if (markedNumbers.includes(num) || num === 'FREE') {
            markedPositions.add(index);
        }
    });

    // Check rows
    for (let row = 0; row < 5; row++) {
        let rowComplete = true;
        for (let col = 0; col < 5; col++) {
            if (!markedPositions.has(row * 5 + col)) {
                rowComplete = false;
                break;
            }
        }
        if (rowComplete) return true;
    }

    // Check columns
    for (let col = 0; col < 5; col++) {
        let colComplete = true;
        for (let row = 0; row < 5; row++) {
            if (!markedPositions.has(row * 5 + col)) {
                colComplete = false;
                break;
            }
        }
        if (colComplete) return true;
    }

    // Check diagonals
    let diag1Complete = true;
    let diag2Complete = true;
    for (let i = 0; i < 5; i++) {
        if (!markedPositions.has(i * 5 + i)) diag1Complete = false;
        if (!markedPositions.has(i * 5 + (4 - i))) diag2Complete = false;
    }

    return diag1Complete || diag2Complete;
}

function drawBall(room) {
    const availableNumbers = Array.from({length: TOTAL_BALLS}, (_, i) => i + 1)
        .filter(num => !room.calledNumbers.includes(num));
    
    if (availableNumbers.length === 0) return null;
    
    const randomIndex = Math.floor(Math.random() * availableNumbers.length);
    const ball = availableNumbers[randomIndex];
    
    room.calledNumbers.push(ball);
    
    // Determine letter for the ball
    let letter = '';
    if (ball <= 15) letter = 'B';
    else if (ball <= 30) letter = 'I';
    else if (ball <= 45) letter = 'N';
    else if (ball <= 60) letter = 'G';
    else letter = 'O';
    
    return { number: ball, letter };
}

function startGame(room) {
    if (room.players.size < 2) return;
    
    room.status = 'countdown';
    let countdown = GAME_COUNTDOWN;
    
    // Notify players about countdown
    room.players.forEach(socketId => {
        const player = players.get(socketId);
        if (player) {
            io.to(socketId).emit('gameCountdown', {
                room: room.stake,
                timer: countdown
            });
        }
    });
    
    const countdownInterval = setInterval(() => {
        countdown--;
        
        room.players.forEach(socketId => {
            const player = players.get(socketId);
            if (player) {
                io.to(socketId).emit('gameCountdown', {
                    room: room.stake,
                    timer: countdown
                });
            }
        });
        
        if (countdown <= 0) {
            clearInterval(countdownInterval);
            room.status = 'playing';
            room.startTime = Date.now();
            room.calledNumbers = [];
            
            // Start drawing balls
            room.gameInterval = setInterval(() => {
                if (room.status !== 'playing') {
                    clearInterval(room.gameInterval);
                    return;
                }
                
                const ball = drawBall(room);
                if (!ball) {
                    endGame(room, 'HOUSE'); // No balls left
                    return;
                }
                
                // Broadcast drawn ball
                room.players.forEach(socketId => {
                    io.to(socketId).emit('ballDrawn', {
                        room: room.stake,
                        num: ball.number
                    });
                });
                
                // Enable bingo claiming after each ball
                setTimeout(() => {
                    room.players.forEach(socketId => {
                        io.to(socketId).emit('enableBingo');
                    });
                }, 500);
                
                // Check if game should end (75 balls drawn)
                if (room.calledNumbers.length >= TOTAL_BALLS) {
                    endGame(room, 'HOUSE');
                }
                
            }, BALL_DRAW_INTERVAL * 1000);
            
            // Draw first ball immediately
            const firstBall = drawBall(room);
            if (firstBall) {
                room.players.forEach(socketId => {
                    io.to(socketId).emit('ballDrawn', {
                        room: room.stake,
                        num: firstBall.number
                    });
                });
                
                setTimeout(() => {
                    room.players.forEach(socketId => {
                        io.to(socketId).emit('enableBingo');
                    });
                }, 500);
            }
        }
    }, 1000);
}

function endGame(room, winnerId, winnerName = 'House') {
    if (room.status === 'ended') return;
    
    room.status = 'ended';
    room.winner = { id: winnerId, name: winnerName };
    
    if (room.gameInterval) {
        clearInterval(room.gameInterval);
    }
    
    // Calculate prize
    const totalStake = room.players.size * room.stake;
    const houseFee = totalStake * 0.05; // 5% house fee
    const prize = totalStake - houseFee;
    
    // Update house balance
    houseBalance += houseFee;
    
    // Add transaction
    transactions.push({
        timestamp: Date.now(),
        type: 'GAME_PRIZE',
        playerName: winnerName,
        amount: prize,
        room: room.stake,
        admin: false
    });
    
    // Award prize to winner
    if (winnerId !== 'HOUSE') {
        const winner = players.get(winnerId);
        if (winner) {
            winner.balance += prize;
            io.to(winnerId).emit('balanceUpdate', winner.balance);
            
            transactions.push({
                timestamp: Date.now(),
                type: 'WINNING',
                playerName: winner.userName,
                amount: prize,
                room: room.stake,
                admin: false
            });
        }
    }
    
    // Notify all players in room
    room.players.forEach(socketId => {
        const player = players.get(socketId);
        if (player) {
            const isWinner = socketId === winnerId;
            io.to(socketId).emit('gameOver', {
                room: room.stake,
                winnerId: winnerId,
                winnerName: winnerName,
                prize: prize,
                isWinner: isWinner
            });
            
            // Reset player room status
            player.currentRoom = null;
            player.box = null;
        }
    });
    
    // Reset room after delay
    setTimeout(() => {
        resetRoom(room);
    }, 5000);
}

function resetRoom(room) {
    room.players.clear();
    room.takenBoxes.clear();
    room.status = 'waiting';
    room.calledNumbers = [];
    room.gameInterval = null;
    room.startTime = null;
    room.winner = null;
    room.countdown = null;
}

// Socket.IO Event Handlers
io.on('connection', (socket) => {
    console.log('New connection:', socket.id);
    
    // Player initialization
    socket.on('init', (data) => {
        const player = {
            socketId: socket.id,
            userId: data.userId,
            userName: data.userName,
            balance: 0.00, // Starting balance is 0
            currentRoom: null,
            box: null,
            joinedAt: Date.now(),
            isBanned: false
        };
        
        players.set(socket.id, player);
        
        // Send initial balance
        socket.emit('balanceUpdate', player.balance);
        
        // Update admin panel
        updateAdminData();
    });
    
    // Refresh balance
    socket.on('refreshBalance', () => {
        const player = players.get(socket.id);
        if (player) {
            socket.emit('balanceUpdate', player.balance);
        }
    });
    
    // Get taken boxes for a room
    socket.on('getTakenBoxes', (data, callback) => {
        const room = rooms.get(parseInt(data.room));
        if (room) {
            callback(Array.from(room.takenBoxes));
        } else {
            callback([]);
        }
    });
    
    // Join a room
    socket.on('joinRoom', (data) => {
        const player = players.get(socket.id);
        if (!player) return;
        
        const stake = parseInt(data.room);
        const room = rooms.get(stake);
        
        if (!room) {
            socket.emit('error', { message: 'Invalid room' });
            return;
        }
        
        // Check if player has enough balance
        if (player.balance < stake) {
            socket.emit('insufficientFunds');
            return;
        }
        
        // Check if box is taken
        const box = parseInt(data.box);
        if (room.takenBoxes.has(box)) {
            socket.emit('boxTaken');
            return;
        }
        
        // Deduct stake from balance
        player.balance -= stake;
        player.currentRoom = stake;
        player.box = box;
        
        // Add to room
        room.players.add(socket.id);
        room.takenBoxes.add(box);
        
        // Send balance update
        socket.emit('balanceUpdate', player.balance);
        socket.emit('joinedRoom');
        
        // Update lobby count
        const playerCount = room.players.size;
        room.players.forEach(playerId => {
            io.to(playerId).emit('lobbyUpdate', {
                room: stake,
                count: playerCount
            });
        });
        
        // Start game if enough players
        if (room.players.size >= 2 && room.status === 'waiting') {
            startGame(room);
        }
        
        // Add transaction
        transactions.push({
            timestamp: Date.now(),
            type: 'STAKE',
            playerName: player.userName,
            amount: -stake,
            room: stake,
            admin: false
        });
        
        updateAdminData();
    });
    
    // Claim bingo
    socket.on('claimBingo', (data) => {
        const player = players.get(socket.id);
        if (!player || !player.currentRoom) return;
        
        const room = rooms.get(player.currentRoom);
        if (!room || room.status !== 'playing') return;
        
        // Verify the claim
        const grid = data.grid;
        const markedNumbers = data.marked;
        
        // Check if all marked numbers have been called (except FREE)
        const validClaim = markedNumbers.every(num => {
            return num === 'FREE' || room.calledNumbers.includes(num);
        });
        
        if (!validClaim) {
            socket.emit('error', { message: 'Invalid claim - numbers not called' });
            return;
        }
        
        // Check if it's a winning pattern
        const isWinner = checkWinningPattern(grid, markedNumbers);
        
        if (isWinner) {
            endGame(room, socket.id, player.userName);
        } else {
            socket.emit('error', { message: 'Not a valid bingo pattern' });
        }
    });
    
    // Admin authentication
    socket.on('admin:auth', (password) => {
        if (password === adminPassword) {
            socket.emit('admin:authSuccess');
            // Send initial data
            updateAdminData(socket);
        } else {
            socket.emit('admin:authError', 'Invalid password');
        }
    });
    
    // Get admin data
    socket.on('admin:getData', () => {
        updateAdminData(socket);
    });
    
    // Add funds to player
    socket.on('admin:addFunds', (data) => {
        const { playerId, amount } = data;
        let player = null;
        
        // Find player by socketId or userId
        for (let [socketId, p] of players.entries()) {
            if (socketId === playerId || p.userId === playerId) {
                player = p;
                break;
            }
        }
        
        if (player && amount > 0) {
            player.balance += amount;
            io.to(player.socketId).emit('balanceUpdate', player.balance);
            io.to(player.socketId).emit('fundsAdded', {
                amount: amount,
                newBalance: player.balance
            });
            
            // Add transaction
            transactions.push({
                timestamp: Date.now(),
                type: 'ADMIN_ADD',
                playerName: player.userName,
                amount: amount,
                room: null,
                admin: true
            });
            
            socket.emit('admin:success', `Added ${amount} ETB to ${player.userName}`);
            updateAdminData();
        } else {
            socket.emit('admin:error', 'Player not found or invalid amount');
        }
    });
    
    // Ban player
    socket.on('admin:banPlayer', (playerId) => {
        const player = players.get(playerId);
        if (player) {
            player.isBanned = true;
            io.to(playerId).emit('banned');
            socket.emit('admin:success', `Banned player: ${player.userName}`);
            updateAdminData();
        } else {
            socket.emit('admin:error', 'Player not found');
        }
    });
    
    // Kick player
    socket.on('admin:kickPlayer', (playerId) => {
        const player = players.get(playerId);
        if (player) {
            // If player is in a room, remove them
            if (player.currentRoom) {
                const room = rooms.get(player.currentRoom);
                if (room) {
                    room.players.delete(playerId);
                    room.takenBoxes.delete(player.box);
                    
                    // Update other players in room
                    room.players.forEach(id => {
                        io.to(id).emit('lobbyUpdate', {
                            room: room.stake,
                            count: room.players.size
                        });
                    });
                }
            }
            
            socket.emit('admin:success', `Kicked player: ${player.userName}`);
            updateAdminData();
        } else {
            socket.emit('admin:error', 'Player not found');
        }
    });
    
    // Reset player balance
    socket.on('admin:resetBalance', (playerId) => {
        const player = players.get(playerId);
        if (player) {
            player.balance = 0;
            io.to(playerId).emit('balanceUpdate', 0);
            socket.emit('admin:success', `Reset balance for ${player.userName}`);
            updateAdminData();
        } else {
            socket.emit('admin:error', 'Player not found');
        }
    });
    
    // Force start game
    socket.on('admin:forceStart', (stake) => {
        const room = rooms.get(parseInt(stake));
        if (room && room.status === 'waiting') {
            startGame(room);
            socket.emit('admin:success', `Force started ${stake} ETB game`);
            updateAdminData();
        }
    });
    
    // Force draw ball
    socket.on('admin:forceDraw', (stake) => {
        const room = rooms.get(parseInt(stake));
        if (room && room.status === 'playing') {
            const ball = drawBall(room);
            if (ball) {
                room.players.forEach(socketId => {
                    io.to(socketId).emit('ballDrawn', {
                        room: room.stake,
                        num: ball.number
                    });
                });
                
                setTimeout(() => {
                    room.players.forEach(socketId => {
                        io.to(socketId).emit('enableBingo');
                    });
                }, 500);
                
                socket.emit('admin:success', `Force drew ball: ${ball.number}`);
                updateAdminData();
            }
        }
    });
    
    // Force end game
    socket.on('admin:forceEnd', (stake) => {
        const room = rooms.get(parseInt(stake));
        if (room && (room.status === 'playing' || room.status === 'countdown')) {
            endGame(room, 'HOUSE', 'Admin ended game');
            socket.emit('admin:success', `Force ended ${stake} ETB game`);
            updateAdminData();
        }
    });
    
    // Broadcast message
    socket.on('admin:broadcast', (message) => {
        io.emit('admin:broadcast', { message });
        socket.emit('admin:success', 'Message broadcasted');
    });
    
    // Adjust house balance
    socket.on('admin:adjustHouse', (amount) => {
        houseBalance += amount;
        socket.emit('admin:success', `Adjusted house balance by ${amount} ETB`);
        updateAdminData();
    });
    
    // Reset house balance
    socket.on('admin:resetHouse', () => {
        houseBalance = 0;
        socket.emit('admin:success', 'Reset house balance to 0');
        updateAdminData();
    });
    
    // Reset all games
    socket.on('admin:resetAllGames', () => {
        rooms.forEach(room => {
            if (room.status !== 'waiting') {
                endGame(room, 'HOUSE', 'Admin reset all games');
            }
        });
        socket.emit('admin:success', 'Reset all games');
        updateAdminData();
    });
    
    // Kick all players
    socket.on('admin:kickAllPlayers', () => {
        players.forEach((player, socketId) => {
            if (player.currentRoom) {
                const room = rooms.get(player.currentRoom);
                if (room) {
                    room.players.delete(socketId);
                    room.takenBoxes.delete(player.box);
                }
                player.currentRoom = null;
                player.box = null;
            }
            io.to(socketId).emit('error', { message: 'Kicked by admin' });
        });
        socket.emit('admin:success', 'Kicked all players');
        updateAdminData();
    });
    
    // Disconnection
    socket.on('disconnect', () => {
        const player = players.get(socket.id);
        if (player) {
            // Remove from room if in one
            if (player.currentRoom) {
                const room = rooms.get(player.currentRoom);
                if (room) {
                    room.players.delete(socket.id);
                    room.takenBoxes.delete(player.box);
                    
                    // Update other players in room
                    room.players.forEach(id => {
                        io.to(id).emit('lobbyUpdate', {
                            room: room.stake,
                            count: room.players.size
                        });
                    });
                    
                    // If room is empty, reset it
                    if (room.players.size === 0) {
                        resetRoom(room);
                    }
                }
            }
            
            players.delete(socket.id);
            updateAdminData();
        }
        
        console.log('Disconnected:', socket.id);
    });
});

// Update admin data function
function updateAdminData(socket = null) {
    const totalPlayers = players.size;
    const activeGames = Array.from(rooms.values()).filter(room => 
        room.status === 'playing' || room.status === 'countdown'
    ).length;
    
    const totalWagered = Array.from(players.values()).reduce((sum, player) => {
        return sum + (player.balance || 0);
    }, 0);
    
    const adminData = {
        totalPlayers,
        activeGames,
        houseBalance,
        totalWagered
    };
    
    const playersData = Array.from(players.values()).map(player => ({
        socketId: player.socketId,
        userId: player.userId,
        userName: player.userName,
        balance: player.balance,
        currentRoom: player.currentRoom,
        box: player.box,
        isBanned: player.isBanned
    }));
    
    const roomsData = {};
    rooms.forEach((room, stake) => {
        roomsData[stake] = {
            stake: room.stake,
            playerCount: room.players.size,
            status: room.status,
            takenBoxes: Array.from(room.takenBoxes),
            calledNumbers: room.calledNumbers,
            startTime: room.startTime,
            winner: room.winner
        };
    });
    
    // Send to specific socket or broadcast to all admin sockets
    if (socket) {
        socket.emit('admin:update', adminData);
        socket.emit('admin:players', playersData);
        socket.emit('admin:rooms', roomsData);
        socket.emit('admin:transactions', transactions.slice(-50)); // Last 50 transactions
    } else {
        io.emit('admin:update', adminData);
        io.emit('admin:players', playersData);
        io.emit('admin:rooms', roomsData);
        io.emit('admin:transactions', transactions.slice(-50));
    }
}

// Clean up old transactions periodically
setInterval(() => {
    const oneWeekAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
    transactions = transactions.filter(tx => tx.timestamp > oneWeekAgo);
}, 3600000); // Every hour

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log('Admin password:', adminPassword);
});
