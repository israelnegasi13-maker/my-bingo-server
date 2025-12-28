const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const admin = require('firebase-admin');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Initialize Firebase with your database
admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://bingo-elite-default-rtdb.firebaseio.com/"
});

const db = admin.database();

// Store active connections in memory (for performance)
const activePlayers = new Map(); // socket.id -> player data
const rooms = {
  10: { players: new Map(), takenBoxes: new Set(), status: 'waiting', calledNumbers: [], gameTimer: null },
  20: { players: new Map(), takenBoxes: new Set(), status: 'waiting', calledNumbers: [], gameTimer: null },
  50: { players: new Map(), takenBoxes: new Set(), status: 'waiting', calledNumbers: [], gameTimer: null },
  100: { players: new Map(), takenBoxes: new Set(), status: 'waiting', calledNumbers: [], gameTimer: null }
};

// Admin authentication
const ADMIN_PASSWORD = "admin123"; // Change this!

// ===================== FIREBASE FUNCTIONS =====================

async function initializeUser(userId, userName) {
  try {
    const userRef = db.ref(`users/${userId}`);
    const snapshot = await userRef.once('value');
    
    if (!snapshot.exists()) {
      // Create new user
      await userRef.set({
        userId: userId,
        userName: userName,
        balance: 100.00, // Starting balance
        registrationDate: new Date().toISOString(),
        totalWagered: 0,
        totalWon: 0,
        gamesPlayed: 0,
        isBanned: false
      });
      console.log(`New user created: ${userId}`);
    }
    
    return await getUserBalance(userId);
  } catch (error) {
    console.error("Error initializing user:", error);
    return 100.00; // Default balance
  }
}

async function getUserBalance(userId) {
  try {
    const snapshot = await db.ref(`users/${userId}/balance`).once('value');
    return snapshot.exists() ? snapshot.val() : 100.00;
  } catch (error) {
    console.error("Error getting balance:", error);
    return 100.00;
  }
}

async function updateBalance(userId, amount, type, room = null, description = "") {
  try {
    const userRef = db.ref(`users/${userId}`);
    const snapshot = await userRef.once('value');
    const userData = snapshot.val() || {};
    
    const currentBalance = userData.balance || 100.00;
    const newBalance = currentBalance + amount;
    
    // Update user balance
    await userRef.update({ balance: newBalance });
    
    // Update stats
    if (type === 'game_wagered') {
      await userRef.update({
        totalWagered: (userData.totalWagered || 0) + Math.abs(amount),
        gamesPlayed: (userData.gamesPlayed || 0) + 1
      });
    } else if (type === 'game_won') {
      await userRef.update({
        totalWon: (userData.totalWon || 0) + amount
      });
    }
    
    // Log transaction
    const txRef = db.ref('transactions').push();
    await txRef.set({
      userId: userId,
      userName: userData.userName || 'Guest',
      type: type,
      amount: amount,
      room: room,
      timestamp: new Date().toISOString(),
      description: description,
      admin: type.includes('admin')
    });
    
    // Update house stats
    await updateHouseStats(amount, type);
    
    return newBalance;
  } catch (error) {
    console.error("Error updating balance:", error);
    return null;
  }
}

async function updateHouseStats(amount, type) {
  try {
    const statsRef = db.ref('system');
    const snapshot = await statsRef.once('value');
    const stats = snapshot.val() || { houseBalance: 10000, totalWagered: 0, totalGames: 0 };
    
    if (type === 'game_wagered') {
      stats.houseBalance = (stats.houseBalance || 10000) + Math.abs(amount);
      stats.totalWagered = (stats.totalWagered || 0) + Math.abs(amount);
      stats.totalGames = (stats.totalGames || 0) + 1;
    } else if (type === 'game_won') {
      stats.houseBalance = (stats.houseBalance || 10000) - Math.abs(amount);
    } else if (type === 'admin_add') {
      stats.houseBalance = (stats.houseBalance || 10000) - Math.abs(amount);
    }
    
    await statsRef.set(stats);
  } catch (error) {
    console.error("Error updating house stats:", error);
  }
}

async function logAdminAction(adminId, action, targetUser, amount = 0) {
  try {
    const logRef = db.ref('admin/logs').push();
    await logRef.set({
      adminId: adminId,
      action: action,
      targetUser: targetUser,
      amount: amount,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error("Error logging admin action:", error);
  }
}

async function getSystemStats() {
  try {
    const statsRef = db.ref('system');
    const snapshot = await statsRef.once('value');
    return snapshot.val() || { houseBalance: 10000, totalWagered: 0, totalGames: 0 };
  } catch (error) {
    console.error("Error getting system stats:", error);
    return { houseBalance: 10000, totalWagered: 0, totalGames: 0 };
  }
}

// ===================== SOCKET.IO EVENTS =====================

io.on('connection', (socket) => {
  console.log('New connection:', socket.id);
  
  // Player initialization
  socket.on('init', async (data) => {
    const { userId, userName } = data;
    
    // Initialize user in Firebase
    const balance = await initializeUser(userId, userName);
    
    // Store in active players
    activePlayers.set(socket.id, {
      socketId: socket.id,
      userId: userId,
      userName: userName,
      balance: balance,
      currentRoom: null,
      box: null
    });
    
    // Send balance to player
    socket.emit('balanceUpdate', balance);
    socket.emit('joinedRoom');
  });
  
  // Refresh balance
  socket.on('refreshBalance', async () => {
    const player = activePlayers.get(socket.id);
    if (player) {
      const balance = await getUserBalance(player.userId);
      player.balance = balance;
      socket.emit('balanceRefreshed', balance);
    }
  });
  
  // Get taken boxes for a room
  socket.on('getTakenBoxes', (data, callback) => {
    const room = rooms[data.room];
    if (room) {
      callback(Array.from(room.takenBoxes));
    } else {
      callback([]);
    }
  });
  
  // Join room
  socket.on('joinRoom', async (data) => {
    const { room, box, userName } = data;
    const player = activePlayers.get(socket.id);
    
    if (!player) return;
    
    // Check if player has enough balance
    if (player.balance < room) {
      socket.emit('insufficientFunds');
      return;
    }
    
    const roomObj = rooms[room];
    
    // Check if box is available
    if (roomObj.takenBoxes.has(box)) {
      socket.emit('boxTaken');
      return;
    }
    
    // Deduct stake
    const newBalance = await updateBalance(
      player.userId, 
      -room, 
      'game_wagered', 
      room,
      `Joined ${room} ETB room, box ${box}`
    );
    
    if (newBalance === null) {
      socket.emit('insufficientFunds');
      return;
    }
    
    // Update player data
    player.balance = newBalance;
    player.currentRoom = room;
    player.box = box;
    
    // Join the room
    roomObj.players.set(socket.id, player);
    roomObj.takenBoxes.add(box);
    socket.join(`room_${room}`);
    
    // Update player's balance
    socket.emit('balanceUpdate', newBalance);
    
    // Send lobby update to all in room
    io.to(`room_${room}`).emit('lobbyUpdate', {
      room: room,
      count: roomObj.players.size
    });
    
    // Start countdown if 2+ players
    if (roomObj.players.size >= 2 && roomObj.status === 'waiting') {
      startGameCountdown(room);
    }
  });
  
  // Claim Bingo
  socket.on('claimBingo', async (data) => {
    const { room, grid, marked } = data;
    const player = activePlayers.get(socket.id);
    
    if (!player || player.currentRoom !== parseInt(room)) return;
    
    const roomObj = rooms[room];
    
    // Calculate prize (90% of total stakes)
    const totalStakes = roomObj.players.size * room;
    const prize = Math.floor(totalStakes * 0.9);
    
    // Update player balance
    const newBalance = await updateBalance(
      player.userId,
      prize,
      'game_won',
      room,
      `Won Bingo in ${room} ETB room`
    );
    
    player.balance = newBalance;
    
    // Send win notification to winner
    socket.emit('gameOver', {
      room: room,
      winnerId: socket.id,
      winnerName: player.userName,
      prize: prize
    });
    
    // Send lose notification to other players
    socket.to(`room_${room}`).emit('gameOver', {
      room: room,
      winnerId: socket.id,
      winnerName: player.userName,
      prize: prize
    });
    
    // Reset room
    resetRoom(room);
  });
  
  // Admin authentication
  socket.on('admin:auth', (password) => {
    if (password === ADMIN_PASSWORD) {
      socket.admin = true;
      socket.emit('admin:authSuccess');
      
      // Send initial data
      sendAdminData(socket);
    } else {
      socket.emit('admin:authError', 'Invalid password');
    }
  });
  
  // Admin get data
  socket.on('admin:getData', () => {
    if (socket.admin) {
      sendAdminData(socket);
    }
  });
  
  // Admin add funds
  socket.on('admin:addFunds', async (data) => {
    if (!socket.admin) return;
    
    const { playerId, amount } = data;
    
    // Find player by socket ID
    let targetSocket = null;
    for (let [sockId, player] of activePlayers) {
      if (sockId === playerId) {
        targetSocket = io.sockets.sockets.get(sockId);
        break;
      }
    }
    
    if (!targetSocket) {
      socket.emit('admin:error', 'Player not found');
      return;
    }
    
    const player = activePlayers.get(playerId);
    if (!player) {
      socket.emit('admin:error', 'Player not found');
      return;
    }
    
    // Update balance
    const newBalance = await updateBalance(
      player.userId,
      amount,
      'admin_add',
      null,
      `Admin added funds`
    );
    
    if (newBalance) {
      player.balance = newBalance;
      
      // Notify player
      targetSocket.emit('fundsAdded', {
        amount: amount,
        newBalance: newBalance
      });
      
      targetSocket.emit('balanceUpdate', newBalance);
      
      // Log admin action
      await logAdminAction(socket.id, 'add_funds', player.userId, amount);
      
      socket.emit('admin:success', `Added ${amount} ETB to ${player.userName}`);
      sendAdminData(socket);
    } else {
      socket.emit('admin:error', 'Failed to add funds');
    }
  });
  
  // Admin ban player
  socket.on('admin:banPlayer', async (playerId) => {
    if (!socket.admin) return;
    
    const player = activePlayers.get(playerId);
    if (player) {
      try {
        await db.ref(`users/${player.userId}`).update({ isBanned: true });
        
        // Disconnect player
        const playerSocket = io.sockets.sockets.get(playerId);
        if (playerSocket) {
          playerSocket.emit('banned');
          playerSocket.disconnect();
        }
        
        await logAdminAction(socket.id, 'ban_player', player.userId);
        socket.emit('admin:success', `Banned ${player.userName}`);
        sendAdminData(socket);
      } catch (error) {
        socket.emit('admin:error', 'Failed to ban player');
      }
    }
  });
  
  // Admin force draw ball
  socket.on('admin:forceDraw', (room) => {
    if (!socket.admin) return;
    
    drawBall(room);
  });
  
  // Disconnect
  socket.on('disconnect', () => {
    const player = activePlayers.get(socket.id);
    if (player && player.currentRoom) {
      const room = rooms[player.currentRoom];
      if (room) {
        room.players.delete(socket.id);
        if (player.box) room.takenBoxes.delete(player.box);
        
        io.to(`room_${player.currentRoom}`).emit('lobbyUpdate', {
          room: player.currentRoom,
          count: room.players.size
        });
      }
    }
    
    activePlayers.delete(socket.id);
    console.log('Client disconnected:', socket.id);
  });
});

// ===================== GAME FUNCTIONS =====================

function startGameCountdown(room) {
  const roomObj = rooms[room];
  roomObj.status = 'counting_down';
  
  let countdown = 5;
  
  const timer = setInterval(() => {
    io.to(`room_${room}`).emit('gameCountdown', {
      room: room,
      timer: countdown
    });
    
    if (countdown <= 0) {
      clearInterval(timer);
      startGame(room);
    }
    
    countdown--;
  }, 1000);
  
  roomObj.gameTimer = timer;
}

function startGame(room) {
  const roomObj = rooms[room];
  roomObj.status = 'playing';
  roomObj.calledNumbers = [];
  
  // Enable bingo for all players
  io.to(`room_${room}`).emit('enableBingo');
  
  // Start drawing balls every 5 seconds
  const ballInterval = setInterval(() => {
    if (roomObj.status === 'playing') {
      drawBall(room);
    } else {
      clearInterval(ballInterval);
    }
  }, 5000);
}

function drawBall(room) {
  const roomObj = rooms[room];
  
  // Generate random number 1-75
  let ball;
  do {
    ball = Math.floor(Math.random() * 75) + 1;
  } while (roomObj.calledNumbers.includes(ball));
  
  roomObj.calledNumbers.push(ball);
  
  // Send to all players in room
  io.to(`room_${room}`).emit('ballDrawn', {
    room: room,
    num: ball
  });
}

function resetRoom(room) {
  const roomObj = rooms[room];
  
  if (roomObj.gameTimer) clearInterval(roomObj.gameTimer);
  
  roomObj.players.clear();
  roomObj.takenBoxes.clear();
  roomObj.status = 'waiting';
  roomObj.calledNumbers = [];
  roomObj.gameTimer = null;
}

// ===================== ADMIN FUNCTIONS =====================

async function sendAdminData(socket) {
  try {
    // Get players
    const players = Array.from(activePlayers.values());
    
    // Get rooms
    const roomsData = {};
    for (const [stake, room] of Object.entries(rooms)) {
      roomsData[stake] = {
        playerCount: room.players.size,
        status: room.status,
        takenBoxes: Array.from(room.takenBoxes)
      };
    }
    
    // Get system stats
    const stats = await getSystemStats();
    
    // Get recent transactions (last 20)
    const txSnapshot = await db.ref('transactions')
      .orderByChild('timestamp')
      .limitToLast(20)
      .once('value');
    
    const transactions = [];
    txSnapshot.forEach(child => {
      transactions.push(child.val());
    });
    
    // Send to admin
    socket.emit('admin:update', {
      totalPlayers: players.length,
      activeGames: Object.values(rooms).filter(r => r.status === 'playing').length,
      houseBalance: stats.houseBalance || 10000,
      totalWagered: stats.totalWagered || 0
    });
    
    socket.emit('admin:players', players);
    socket.emit('admin:rooms', roomsData);
    socket.emit('admin:transactions', transactions);
    
  } catch (error) {
    console.error("Error sending admin data:", error);
  }
}

// ===================== EXPRESS ROUTES =====================

app.get('/health', (req, res) => {
  res.json({ status: 'ok', players: activePlayers.size });
});

app.get('/admin/stats', async (req, res) => {
  try {
    const stats = await getSystemStats();
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Firebase connected: bingo-elite-default-rtdb.firebaseio.com`);
});
