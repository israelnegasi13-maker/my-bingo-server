const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const admin = require('firebase-admin');
const path = require('path');

// Initialize Firebase Admin SDK
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://bingo-elite-default-rtdb.firebaseio.com"
});

const db = admin.database();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Server state
const rooms = {
  10: { players: [], takenBoxes: [], status: 'waiting', calledNumbers: [], currentBall: null, gameTimer: null, drawInterval: null, countdown: 60 },
  20: { players: [], takenBoxes: [], status: 'waiting', calledNumbers: [], currentBall: null, gameTimer: null, drawInterval: null, countdown: 60 },
  50: { players: [], takenBoxes: [], status: 'waiting', calledNumbers: [], currentBall: null, gameTimer: null, drawInterval: null, countdown: 60 },
  100: { players: [], takenBoxes: [], status: 'waiting', calledNumbers: [], currentBall: null, gameTimer: null, drawInterval: null, countdown: 60 }
};

const players = new Map(); // socket.id -> player data
const admins = new Set(); // Set of admin socket IDs
const ADMIN_PASSWORD = "bingo2024"; // Change this in production

// House balance (stored in Firebase)
let houseBalance = 0;

// Initialize house balance from Firebase
async function initHouseBalance() {
  try {
    const snapshot = await db.ref('admin/houseBalance').once('value');
    if (snapshot.exists()) {
      houseBalance = snapshot.val();
    } else {
      await db.ref('admin/houseBalance').set(0);
    }
  } catch (error) {
    console.error('Error loading house balance:', error);
  }
}

// Update house balance in Firebase
async function updateHouseBalance(change) {
  houseBalance += change;
  await db.ref('admin/houseBalance').set(houseBalance);
  return houseBalance;
}

// Get player balance from Firebase
async function getPlayerBalance(userId) {
  try {
    const snapshot = await db.ref(`players/${userId}/balance`).once('value');
    return snapshot.exists() ? parseFloat(snapshot.val()) : 0;
  } catch (error) {
    console.error('Error getting player balance:', error);
    return 0;
  }
}

// Update player balance in Firebase
async function updatePlayerBalance(userId, amount, operation = 'add') {
  try {
    const balanceRef = db.ref(`players/${userId}/balance`);
    const snapshot = await balanceRef.once('value');
    let currentBalance = snapshot.exists() ? parseFloat(snapshot.val()) : 0;
    
    if (operation === 'add') {
      currentBalance += amount;
    } else if (operation === 'subtract') {
      currentBalance -= amount;
      if (currentBalance < 0) currentBalance = 0;
    } else if (operation === 'set') {
      currentBalance = amount;
    }
    
    await balanceRef.set(currentBalance);
    
    // Update player stats
    if (operation === 'subtract' && amount > 0) {
      await db.ref(`players/${userId}/totalWagered`).transaction((current) => {
        return (current || 0) + amount;
      });
    }
    
    return currentBalance;
  } catch (error) {
    console.error('Error updating player balance:', error);
    return 0;
  }
}

// Log transaction to Firebase
async function logTransaction(playerId, type, amount, room = null, details = {}) {
  try {
    const transactionRef = db.ref('transactions').push();
    await transactionRef.set({
      playerId,
      type, // 'deposit', 'withdrawal', 'win', 'loss', 'bet', 'admin'
      amount,
      room,
      timestamp: Date.now(),
      ...details
    });
  } catch (error) {
    console.error('Error logging transaction:', error);
  }
}

// Create/update player in Firebase
async function createOrUpdatePlayer(userId, userName) {
  try {
    const playerRef = db.ref(`players/${userId}`);
    const snapshot = await playerRef.once('value');
    
    if (!snapshot.exists()) {
      await playerRef.set({
        userName,
        balance: 0.00,
        telegramId: userId.includes('telegram_') ? userId.replace('telegram_', '') : userId,
        createdAt: Date.now(),
        lastLogin: Date.now(),
        totalWagered: 0.00,
        totalWins: 0,
        totalGames: 0
      });
    } else {
      await playerRef.update({
        lastLogin: Date.now()
      });
    }
    
    return await getPlayerBalance(userId);
  } catch (error) {
    console.error('Error creating/updating player:', error);
    return 0;
  }
}

// Socket.io connection handler
io.on('connection', (socket) => {
  console.log('New connection:', socket.id);
  
  socket.on('init', async (data) => {
    const { userId, userName } = data;
    
    // Create Firebase ID for Telegram users
    const firebaseId = userId.toString().startsWith('telegram_') ? userId : `telegram_${userId}`;
    
    // Create/update player in Firebase
    const balance = await createOrUpdatePlayer(firebaseId, userName);
    
    // Store player in memory
    players.set(socket.id, {
      socketId: socket.id,
      userId: firebaseId,
      userName: userName || 'Guest',
      balance: balance,
      currentRoom: null,
      box: null,
      lastActivity: Date.now()
    });
    
    // Send initial balance
    socket.emit('balanceUpdate', balance);
    socket.emit('joinedRoom');
    
    // Send initial house balance
    socket.emit('houseBalance', houseBalance);
  });
  
  socket.on('getTakenBoxes', (data, callback) => {
    const { room } = data;
    if (rooms[room]) {
      callback(rooms[room].takenBoxes || []);
    } else {
      callback([]);
    }
  });
  
  socket.on('joinRoom', async (data) => {
    const { room, box, userName } = data;
    const player = players.get(socket.id);
    
    if (!player) {
      socket.emit('error', 'Player not initialized');
      return;
    }
    
    // Check if box is already taken
    if (rooms[room] && rooms[room].takenBoxes.includes(box)) {
      socket.emit('boxTaken');
      return;
    }
    
    // Check player balance
    if (player.balance < room) {
      socket.emit('insufficientFunds');
      return;
    }
    
    // Deduct stake from balance
    const newBalance = await updatePlayerBalance(player.userId, room, 'subtract');
    player.balance = newBalance;
    
    // Log bet transaction
    await logTransaction(player.userId, 'bet', -room, room, {
      gameType: 'bingo',
      box: box
    });
    
    // Update house balance
    await updateHouseBalance(room * 0.1); // 10% house fee
    
    // Update player in memory
    player.currentRoom = room;
    player.box = box;
    
    // Add player to room
    if (!rooms[room].players.find(p => p.socketId === socket.id)) {
      rooms[room].players.push({
        socketId: socket.id,
        userId: player.userId,
        userName: player.userName,
        box: box,
        grid: [],
        markedNumbers: new Set()
      });
      
      rooms[room].takenBoxes.push(box);
    }
    
    // Update player count
    const playerCount = rooms[room].players.length;
    io.to(getRoomSockets(room)).emit('lobbyUpdate', {
      room: room,
      count: playerCount
    });
    
    socket.emit('balanceUpdate', newBalance);
    socket.emit('joinedRoom');
    
    // Start countdown if we have at least 2 players
    if (playerCount >= 2 && rooms[room].status === 'waiting') {
      startGameCountdown(room);
    }
  });
  
  socket.on('claimBingo', async (data) => {
    const { room, grid, marked } = data;
    const player = players.get(socket.id);
    
    if (!player || player.currentRoom !== room) {
      return;
    }
    
    // Verify bingo (simple check - in production should be more robust)
    const isValid = verifyBingo(grid, marked, rooms[room].calledNumbers);
    
    if (isValid) {
      // Calculate prize (80% of total pool, 10% house fee already taken)
      const totalPool = room * rooms[room].players.length;
      const prize = totalPool * 0.8;
      
      // Update player balance
      const newBalance = await updatePlayerBalance(player.userId, prize, 'add');
      player.balance = newBalance;
      
      // Log win transaction
      await logTransaction(player.userId, 'win', prize, room, {
        gameType: 'bingo',
        winningPattern: 'verified'
      });
      
      // Update player stats
      await db.ref(`players/${player.userId}/totalWins`).transaction((current) => {
        return (current || 0) + 1;
      });
      
      // Update house balance (remaining 10%)
      await updateHouseBalance(totalPool * 0.1);
      
      // Notify all players in room
      io.to(getRoomSockets(room)).emit('gameOver', {
        room: room,
        winnerId: socket.id,
        winnerName: player.userName,
        prize: prize
      });
      
      // Reset room
      resetRoom(room);
    } else {
      socket.emit('invalidBingo');
    }
  });
  
  socket.on('refreshBalance', async () => {
    const player = players.get(socket.id);
    if (player) {
      const balance = await getPlayerBalance(player.userId);
      player.balance = balance;
      socket.emit('balanceUpdate', balance);
    }
  });
  
  // Admin events
  socket.on('admin:auth', (password) => {
    if (password === ADMIN_PASSWORD) {
      admins.add(socket.id);
      socket.emit('admin:authSuccess');
      console.log('Admin authenticated:', socket.id);
    } else {
      socket.emit('admin:authError', 'Invalid password');
    }
  });
  
  socket.on('admin:getData', () => {
    if (!admins.has(socket.id)) return;
    
    const totalPlayers = players.size;
    const activeGames = Object.values(rooms).filter(r => r.status === 'playing').length;
    
    // Calculate total wagered from Firebase
    db.ref('players').once('value').then((snapshot) => {
      let totalWagered = 0;
      snapshot.forEach((child) => {
        totalWagered += child.val().totalWagered || 0;
      });
      
      socket.emit('admin:update', {
        totalPlayers,
        activeGames,
        houseBalance,
        totalWagered
      });
    });
    
    // Send player list
    const playerList = Array.from(players.values());
    socket.emit('admin:players', playerList);
    
    // Send room list
    socket.emit('admin:rooms', rooms);
    
    // Send recent transactions from Firebase
    db.ref('transactions').orderByChild('timestamp').limitToLast(50).once('value').then((snapshot) => {
      const transactions = [];
      snapshot.forEach((child) => {
        transactions.push(child.val());
      });
      socket.emit('admin:transactions', transactions.reverse());
    });
  });
  
  socket.on('admin:addFunds', async (data) => {
    if (!admins.has(socket.id)) return;
    
    const { playerId, amount } = data;
    const amountNum = parseFloat(amount);
    
    if (!playerId || isNaN(amountNum)) {
      socket.emit('admin:error', 'Invalid player ID or amount');
      return;
    }
    
    try {
      // Update player balance in Firebase
      const newBalance = await updatePlayerBalance(playerId, amountNum, 'add');
      
      // Log transaction
      await logTransaction(playerId, 'deposit', amountNum, null, {
        admin: true,
        adminAction: 'manual_add'
      });
      
      // Update in-memory player if online
      for (let [sockId, player] of players.entries()) {
        if (player.userId === playerId) {
          player.balance = newBalance;
          io.to(sockId).emit('balanceUpdate', newBalance);
          io.to(sockId).emit('fundsAdded', {
            amount: amountNum,
            newBalance: newBalance
          });
          break;
        }
      }
      
      socket.emit('admin:success', `Added ${amount} ETB to player ${playerId}`);
    } catch (error) {
      socket.emit('admin:error', 'Failed to add funds: ' + error.message);
    }
  });
  
  socket.on('admin:banPlayer', (playerSocketId) => {
    if (!admins.has(socket.id)) return;
    
    const player = players.get(playerSocketId);
    if (player) {
      // Kick player from room if in one
      if (player.currentRoom) {
        const room = rooms[player.currentRoom];
        if (room) {
          room.players = room.players.filter(p => p.socketId !== playerSocketId);
          room.takenBoxes = room.takenBoxes.filter(b => b !== player.box);
        }
      }
      
      // Disconnect player
      io.to(playerSocketId).emit('banned');
      io.to(playerSocketId).disconnect();
      players.delete(playerSocketId);
      
      socket.emit('admin:success', `Player banned: ${player.userName}`);
    } else {
      socket.emit('admin:error', 'Player not found');
    }
  });
  
  socket.on('admin:forceDraw', (room) => {
    if (!admins.has(socket.id)) return;
    
    if (rooms[room] && rooms[room].status === 'playing') {
      drawBall(room);
      socket.emit('admin:success', `Drawn ball in ${room} ETB room`);
    } else {
      socket.emit('admin:error', 'Room not in playing state');
    }
  });
  
  socket.on('admin:forceStart', (room) => {
    if (!admins.has(socket.id)) return;
    
    if (rooms[room] && rooms[room].status === 'waiting') {
      startGameCountdown(room);
      socket.emit('admin:success', `Game force started in ${room} ETB room`);
    } else {
      socket.emit('admin:error', 'Cannot start game');
    }
  });
  
  socket.on('admin:forceEnd', (room) => {
    if (!admins.has(socket.id)) return;
    
    if (rooms[room]) {
      // End game with no winner
      io.to(getRoomSockets(room)).emit('gameOver', {
        room: room,
        winnerId: 'HOUSE',
        winnerName: 'House',
        prize: 0
      });
      
      resetRoom(room);
      socket.emit('admin:success', `Game force ended in ${room} ETB room`);
    }
  });
  
  socket.on('admin:syncFirebase', async (data, callback) => {
    if (!admins.has(socket.id)) return;
    
    try {
      // Sync all online players' balances from Firebase
      for (let [sockId, player] of players.entries()) {
        const balance = await getPlayerBalance(player.userId);
        player.balance = balance;
        io.to(sockId).emit('balanceUpdate', balance);
      }
      
      callback({ success: true, message: 'Firebase sync completed' });
    } catch (error) {
      callback({ success: false, message: error.message });
    }
  });
  
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    
    const player = players.get(socket.id);
    if (player) {
      // Remove player from room
      if (player.currentRoom) {
        const room = rooms[player.currentRoom];
        if (room) {
          room.players = room.players.filter(p => p.socketId !== socket.id);
          room.takenBoxes = room.takenBoxes.filter(b => b !== player.box);
          
          // Update remaining players
          io.to(getRoomSockets(player.currentRoom)).emit('lobbyUpdate', {
            room: player.currentRoom,
            count: room.players.length
          });
          
          // If room becomes empty, reset it
          if (room.players.length === 0) {
            resetRoom(player.currentRoom);
          }
        }
      }
      
      players.delete(socket.id);
    }
    
    // Remove admin privileges
    admins.delete(socket.id);
  });
});

// Helper functions
function getRoomSockets(room) {
  if (!rooms[room]) return [];
  return rooms[room].players.map(p => p.socketId);
}

function startGameCountdown(room) {
  if (!rooms[room] || rooms[room].status !== 'waiting') return;
  
  rooms[room].status = 'countdown';
  rooms[room].countdown = 60;
  
  const countdownInterval = setInterval(() => {
    rooms[room].countdown--;
    
    io.to(getRoomSockets(room)).emit('gameCountdown', {
      room: room,
      timer: rooms[room].countdown
    });
    
    if (rooms[room].countdown <= 0) {
      clearInterval(countdownInterval);
      startGame(room);
    }
    
    // If players drop below 2, cancel countdown
    if (rooms[room].players.length < 2) {
      clearInterval(countdownInterval);
      rooms[room].status = 'waiting';
      rooms[room].countdown = 60;
      io.to(getRoomSockets(room)).emit('gameCountdown', {
        room: room,
        timer: rooms[room].countdown
      });
    }
  }, 1000);
  
  rooms[room].gameTimer = countdownInterval;
}

function startGame(room) {
  if (!rooms[room]) return;
  
  rooms[room].status = 'playing';
  rooms[room].calledNumbers = [];
  rooms[room].currentBall = null;
  
  // Enable bingo claiming after 5 seconds
  setTimeout(() => {
    io.to(getRoomSockets(room)).emit('enableBingo');
  }, 5000);
  
  // Start drawing balls every 10 seconds
  rooms[room].drawInterval = setInterval(() => {
    drawBall(room);
  }, 10000);
  
  // Draw first ball immediately
  drawBall(room);
}

function drawBall(room) {
  if (!rooms[room] || rooms[room].status !== 'playing') return;
  
  // Generate random ball (1-75) that hasn't been called
  let ball;
  do {
    ball = Math.floor(Math.random() * 75) + 1;
  } while (rooms[room].calledNumbers.includes(ball));
  
  rooms[room].calledNumbers.push(ball);
  rooms[room].currentBall = ball;
  
  io.to(getRoomSockets(room)).emit('ballDrawn', {
    room: room,
    num: ball
  });
  
  // Auto-end game if all balls drawn (should rarely happen)
  if (rooms[room].calledNumbers.length >= 75) {
    endGameNoWinner(room);
  }
}

function verifyBingo(grid, markedNumbers, calledNumbers) {
  // Simple verification - in production should verify full bingo pattern
  // For now, check that all marked numbers are in called numbers
  const marked = new Set(markedNumbers.map(n => n === 'FREE' ? 'FREE' : parseInt(n)));
  const called = new Set(calledNumbers);
  
  for (let num of marked) {
    if (num !== 'FREE' && !called.has(num)) {
      return false;
    }
  }
  
  // Check for at least one bingo pattern (5 in a row)
  // This is a simplified check - implement full bingo pattern checking
  return marked.size >= 5; // At least 5 marked numbers (including FREE)
}

function endGameNoWinner(room) {
  if (!rooms[room]) return;
  
  // House wins all
  const totalPool = room * rooms[room].players.length;
  updateHouseBalance(totalPool * 0.9); // House keeps 90% (10% already taken as fee)
  
  io.to(getRoomSockets(room)).emit('gameOver', {
    room: room,
    winnerId: 'HOUSE',
    winnerName: 'House',
    prize: 0
  });
  
  resetRoom(room);
}

function resetRoom(room) {
  if (!rooms[room]) return;
  
  // Clear intervals
  if (rooms[room].gameTimer) {
    clearInterval(rooms[room].gameTimer);
  }
  if (rooms[room].drawInterval) {
    clearInterval(rooms[room].drawInterval);
  }
  
  // Reset room state
  rooms[room].players = [];
  rooms[room].takenBoxes = [];
  rooms[room].status = 'waiting';
  rooms[room].calledNumbers = [];
  rooms[room].currentBall = null;
  rooms[room].gameTimer = null;
  rooms[room].drawInterval = null;
  rooms[room].countdown = 60;
}

// API endpoints
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    players: players.size,
    timestamp: Date.now()
  });
});

app.get('/api/player/:id', async (req, res) => {
  try {
    const snapshot = await db.ref(`players/${req.params.id}`).once('value');
    if (snapshot.exists()) {
      res.json(snapshot.val());
    } else {
      res.status(404).json({ error: 'Player not found' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/admin/add-funds', async (req, res) => {
  const { password, playerId, amount } = req.body;
  
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  try {
    const newBalance = await updatePlayerBalance(playerId, parseFloat(amount), 'add');
    
    await logTransaction(playerId, 'deposit', amount, null, {
      admin: true,
      adminAction: 'api_add'
    });
    
    res.json({
      success: true,
      newBalance,
      message: `Added ${amount} ETB to player ${playerId}`
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/stats', async (req, res) => {
  try {
    const playersSnapshot = await db.ref('players').once('value');
    const playersData = playersSnapshot.val() || {};
    
    const totalPlayers = Object.keys(playersData).length;
    const totalBalance = Object.values(playersData).reduce((sum, p) => sum + (p.balance || 0), 0);
    const totalWagered = Object.values(playersData).reduce((sum, p) => sum + (p.totalWagered || 0), 0);
    const totalWins = Object.values(playersData).reduce((sum, p) => sum + (p.totalWins || 0), 0);
    
    res.json({
      totalPlayers,
      totalBalance,
      totalWagered,
      totalWins,
      houseBalance,
      onlinePlayers: players.size,
      activeGames: Object.values(rooms).filter(r => r.status === 'playing').length
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Serve admin panel
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Initialize house balance and start server
initHouseBalance().then(() => {
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Firebase connected to: ${serviceAccount.project_id}`);
    console.log(`Admin password: ${ADMIN_PASSWORD}`);
    console.log(`House balance: ${houseBalance} ETB`);
  });
}).catch(error => {
  console.error('Failed to initialize server:', error);
  process.exit(1);
});
