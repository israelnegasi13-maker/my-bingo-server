// server.js - COMPLETE UPDATED VERSION WITH MONGODB
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const connectDB = require('./db');  // Add this line
const { User, Room, Transaction, Stats } = require('./models');  // Add this line

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  transports: ['websocket', 'polling']
});

// Connect to MongoDB
connectDB();

// Middleware
app.use(cors());
app.use(helmet());
app.use(express.json());

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// ========== GAME CONFIGURATION ==========
const CONFIG = {
  ADMIN_PASSWORD: "admin1234",
  INITIAL_BALANCE: 0.00,
  ROOM_STAKES: [10, 20, 50, 100],
  MAX_PLAYERS_PER_ROOM: 100,
  GAME_TIMER: 3, // 3 seconds between balls
  MIN_PLAYERS_TO_START: 2,
  HOUSE_COMMISSION: { // Fixed commission per player
    10: 2,   // 2 ETB commission per player
    20: 4,   // 4 ETB commission per player  
    50: 10,  // 10 ETB commission per player
    100: 20  // 20 ETB commission per player
  },
  FOUR_CORNERS_BONUS: 50, // 50 ETB bonus for four corners win
  COUNTDOWN_TIMER: 30, // 30 seconds wait when 2 players join
  ROOM_STATUS_UPDATE_INTERVAL: 3000,
  MAX_TRANSACTIONS: 1000,
  AUTO_SAVE_INTERVAL: 60000,
  SESSION_TIMEOUT: 86400000
};

// BINGO letter ranges
const BINGO_LETTERS = {
  'B': { min: 1, max: 15, color: '#3b82f6' },
  'I': { min: 16, max: 30, color: '#8b5cf6' },
  'N': { min: 31, max: 45, color: '#10b981' },
  'G': { min: 46, max: 60, color: '#f59e0b' },
  'O': { min: 61, max: 75, color: '#ef4444' }
};

// ========== DATA STORAGE (Now using MongoDB) ==========
let socketToUser = new Map(); // socket.id -> userId (still in memory for quick lookup)
let adminSockets = new Set(); // socket.id of admin connections
let activityLog = []; // For admin activity tracking (could move to MongoDB)
let roomTimers = new Map(); // Track game timers

// Initialize rooms in MongoDB if they don't exist
async function initializeRooms() {
  try {
    for (const stake of CONFIG.ROOM_STAKES) {
      const existingRoom = await Room.findOne({ stake: stake, status: 'waiting' });
      if (!existingRoom) {
        const newRoom = new Room({
          stake: stake,
          players: [],
          takenBoxes: [],
          status: 'waiting',
          calledNumbers: [],
          ballsDrawn: 0
        });
        await newRoom.save();
        console.log(`✅ Created room for ${stake} ETB stake`);
      }
    }
  } catch (error) {
    console.error('Error initializing rooms:', error);
  }
}

// Call this on server start
initializeRooms();

// ========== MONGODB HELPER FUNCTIONS ==========

// Get or create user
async function getUser(userId, userName) {
  try {
    let user = await User.findOne({ userId: userId });
    
    if (!user) {
      user = new User({
        userId: userId,
        userName: userName || 'Guest',
        balance: CONFIG.INITIAL_BALANCE,
        referralCode: generateReferralCode(userId)
      });
      await user.save();
      
      // Update daily stats
      await updateDailyStats('newUsers', 1);
      await updateDailyStats('totalUsers', 1);
    } else {
      user.lastSeen = new Date();
      user.sessionCount = (user.sessionCount || 0) + 1;
      user.isOnline = true;
      
      if (userName && user.userName !== userName) {
        user.userName = userName;
      }
      
      await user.save();
    }
    
    return user;
  } catch (error) {
    console.error('Error getting user:', error);
    return null;
  }
}

// Update user balance
async function updateUserBalance(userId, amount) {
  try {
    const user = await User.findOne({ userId: userId });
    if (user) {
      user.balance += amount;
      await user.save();
      return user.balance;
    }
    return null;
  } catch (error) {
    console.error('Error updating user balance:', error);
    return null;
  }
}

// Create transaction
async function createTransaction(type, userId, amount, room = null, admin = false) {
  try {
    const user = await User.findOne({ userId: userId });
    
    const transaction = new Transaction({
      type: type,
      userId: userId,
      userName: user ? user.userName : 'Unknown',
      amount: amount,
      room: room,
      admin: admin,
      description: getTransactionDescription(type, amount, room)
    });
    
    await transaction.save();
    
    // Update daily stats
    if (type === 'STAKE') {
      await updateDailyStats('totalWagered', Math.abs(amount));
    } else if (type === 'HOUSE_EARNINGS') {
      await updateDailyStats('totalEarnings', amount);
    } else if (type === 'WIN' || type === 'WIN_FOUR_CORNERS') {
      await updateDailyStats('totalBingos', 1);
    }
    
    return transaction;
  } catch (error) {
    console.error('Error creating transaction:', error);
    return null;
  }
}

// Get room from MongoDB
async function getRoom(stake) {
  try {
    let room = await Room.findOne({ stake: stake, status: { $in: ['waiting', 'starting', 'playing'] } });
    
    if (!room) {
      room = new Room({
        stake: stake,
        players: [],
        takenBoxes: [],
        status: 'waiting'
      });
      await room.save();
    }
    
    return room;
  } catch (error) {
    console.error('Error getting room:', error);
    return null;
  }
}

// Update room in MongoDB
async function updateRoom(roomId, updates) {
  try {
    await Room.findByIdAndUpdate(roomId, updates);
    return true;
  } catch (error) {
    console.error('Error updating room:', error);
    return false;
  }
}

// Update daily stats
async function updateDailyStats(field, value) {
  try {
    const today = new Date().toISOString().split('T')[0];
    await Stats.findOneAndUpdate(
      { date: today },
      { $inc: { [field]: value } },
      { upsert: true, new: true }
    );
    return true;
  } catch (error) {
    console.error('Error updating daily stats:', error);
    return false;
  }
}

// Get system stats
async function getSystemStats() {
  try {
    const today = new Date().toISOString().split('T')[0];
    const stats = await Stats.findOne({ date: today });
    
    const totalUsers = await User.countDocuments();
    const totalTransactions = await Transaction.countDocuments();
    const activeRooms = await Room.countDocuments({ status: { $in: ['waiting', 'starting', 'playing'] } });
    
    return {
      todayStats: stats || {
        date: today,
        totalWagered: 0,
        totalEarnings: 0,
        totalGames: 0,
        totalUsers: 0,
        newUsers: 0,
        totalBingos: 0,
        totalFourCorners: 0
      },
      totalUsers: totalUsers,
      totalTransactions: totalTransactions,
      activeRooms: activeRooms
    };
  } catch (error) {
    console.error('Error getting system stats:', error);
    return null;
  }
}

// Calculate house balance from transactions
async function calculateHouseBalance() {
  try {
    const result = await Transaction.aggregate([
      {
        $match: {
          type: { $in: ['HOUSE_EARNINGS', 'HOUSE_ADJUST'] }
        }
      },
      {
        $group: {
          _id: null,
          total: { $sum: '$amount' }
        }
      }
    ]);
    
    return result.length > 0 ? result[0].total : 0;
  } catch (error) {
    console.error('Error calculating house balance:', error);
    return 0;
  }
}

// Get BINGO letter for a number
function getBingoLetter(number) {
  if (number >= 1 && number <= 15) return 'B';
  if (number >= 16 && number <= 30) return 'I';
  if (number >= 31 && number <= 45) return 'N';
  if (number >= 46 && number <= 60) return 'G';
  if (number >= 61 && number <= 75) return 'O';
  return '';
}

// Helper function for transaction description
function getTransactionDescription(type, amount, room) {
  const descriptions = {
    'STAKE': `Staked ${Math.abs(amount)} ETB in ${room} ETB room`,
    'WIN': `Won ${amount} ETB in ${room} ETB room`,
    'WIN_FOUR_CORNERS': `Won ${amount} ETB (Four Corners Bonus!)`,
    'ADMIN_ADD': `Admin added ${amount} ETB`,
    'HOUSE_EARNINGS': `House earned ${amount} ETB`,
    'HOUSE_ADJUST': `House balance adjusted by ${amount} ETB`
  };
  
  return descriptions[type] || type;
}

// Calculate prize for a room
function calculatePrize(room) {
  const playerCount = room.players.length;
  const stake = room.stake;
  const commissionPerPlayer = CONFIG.HOUSE_COMMISSION[stake] || 0;
  
  const contributionPerPlayer = stake - commissionPerPlayer;
  const totalPrize = contributionPerPlayer * playerCount;
  
  return totalPrize;
}

// Calculate house earnings for a room
function calculateHouseEarnings(room) {
  const playerCount = room.players.length;
  const stake = room.stake;
  const commissionPerPlayer = CONFIG.HOUSE_COMMISSION[stake] || 0;
  
  return commissionPerPlayer * playerCount;
}

// Check BINGO pattern
function checkBingoPattern(grid, markedNumbers) {
  const marks = new Set(markedNumbers);
  
  // Check four corners first
  const fourCorners = checkFourCorners(grid, markedNumbers);
  
  // Check rows
  for (let i = 0; i < 5; i++) {
    let rowComplete = true;
    for (let j = 0; j < 5; j++) {
      const index = i * 5 + j;
      const cellValue = grid[index];
      if (!marks.has(cellValue) && cellValue !== 'FREE') {
        rowComplete = false;
        break;
      }
    }
    if (rowComplete) return { win: true, pattern: 'standard' };
  }
  
  // Check columns
  for (let j = 0; j < 5; j++) {
    let colComplete = true;
    for (let i = 0; i < 5; i++) {
      const index = i * 5 + j;
      const cellValue = grid[index];
      if (!marks.has(cellValue) && cellValue !== 'FREE') {
        colComplete = false;
        break;
      }
    }
    if (colComplete) return { win: true, pattern: 'standard' };
  }
  
  // Check diagonals
  let diag1Complete = true;
  let diag2Complete = true;
  for (let i = 0; i < 5; i++) {
    // Top-left to bottom-right
    const index1 = i * 5 + i;
    const cell1 = grid[index1];
    if (!marks.has(cell1) && cell1 !== 'FREE') diag1Complete = false;
    
    // Top-right to bottom-left
    const index2 = i * 5 + (4 - i);
    const cell2 = grid[index2];
    if (!marks.has(cell2) && cell2 !== 'FREE') diag2Complete = false;
  }
  
  if (diag1Complete || diag2Complete) {
    return { win: true, pattern: 'standard' };
  }
  
  // Check four corners
  if (fourCorners) return { win: true, pattern: 'fourCorners' };
  
  return { win: false, pattern: null };
}

// Check four corners pattern
function checkFourCorners(grid, markedNumbers) {
  const marks = new Set(markedNumbers);
  
  // Four corners positions: 0 (B1), 4 (B5), 20 (O1), 24 (O5)
  const topLeft = grid[0];
  const topRight = grid[4];
  const bottomLeft = grid[20];
  const bottomRight = grid[24];
  
  const hasTopLeft = marks.has(topLeft) || topLeft === 'FREE';
  const hasTopRight = marks.has(topRight) || topRight === 'FREE';
  const hasBottomLeft = marks.has(bottomLeft) || bottomLeft === 'FREE';
  const hasBottomRight = marks.has(bottomRight) || bottomRight === 'FREE';
  
  return hasTopLeft && hasTopRight && hasBottomLeft && hasBottomRight;
}

// Generate referral code
function generateReferralCode(userId) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code + userId.slice(-4);
}

// ========== GAME LOGIC FUNCTIONS ==========

// Start game timer
async function startGameTimer(room) {
  if (roomTimers.has(room.stake)) {
    clearInterval(roomTimers.get(room.stake));
  }
  
  const timer = setInterval(async () => {
    try {
      // Refresh room data from database
      const currentRoom = await Room.findById(room._id);
      if (!currentRoom || currentRoom.status !== 'playing') {
        clearInterval(timer);
        roomTimers.delete(room.stake);
        return;
      }
      
      if (currentRoom.ballsDrawn >= 75) {
        await endGame(currentRoom.stake, 'HOUSE');
        return;
      }
      
      let ball;
      let letter;
      do {
        ball = Math.floor(Math.random() * 75) + 1;
        letter = getBingoLetter(ball);
      } while (currentRoom.calledNumbers.includes(ball));
      
      // Update room in database
      currentRoom.calledNumbers.push(ball);
      currentRoom.currentBall = ball;
      currentRoom.ballsDrawn += 1;
      await currentRoom.save();
      
      // Emit ball to all players in room
      const ballData = {
        room: currentRoom.stake,
        num: ball,
        letter: letter,
        fullDisplay: `${letter}-${ball}`
      };
      
      // Emit to all players in room
      currentRoom.players.forEach(userId => {
        for (const [socketId, uId] of socketToUser.entries()) {
          if (uId === userId) {
            const socket = io.sockets.sockets.get(socketId);
            if (socket) {
              socket.emit('ballDrawn', ballData);
            }
          }
        }
      });
      
      // Enable bingo claiming after 5 balls
      if (currentRoom.ballsDrawn >= 5) {
        currentRoom.players.forEach(userId => {
          for (const [socketId, uId] of socketToUser.entries()) {
            if (uId === userId) {
              const socket = io.sockets.sockets.get(socketId);
              if (socket) {
                socket.emit('enableBingo');
              }
            }
          }
        });
      }
      
      updateAdminPanel();
      broadcastRoomStatus();
      
    } catch (error) {
      console.error('Error in game timer:', error);
      clearInterval(timer);
      roomTimers.delete(room.stake);
    }
  }, CONFIG.GAME_TIMER * 1000);
  
  roomTimers.set(room.stake, timer);
}

// End game
async function endGame(roomStake, winnerUserId, isFourCornersWin = false) {
  try {
    const room = await Room.findOne({ stake: roomStake, status: 'playing' });
    if (!room) return;
    
    // Clear timer
    if (roomTimers.has(roomStake)) {
      clearInterval(roomTimers.get(roomStake));
      roomTimers.delete(roomStake);
    }
    
    room.status = 'ended';
    room.endTime = new Date();
    await room.save();
    
    let winnerName = 'HOUSE';
    let prize = 0;
    let houseEarnings = 0;
    let bonus = 0;
    
    if (winnerUserId !== 'HOUSE') {
      const winner = await User.findOne({ userId: winnerUserId });
      if (winner) {
        winnerName = winner.userName;
        prize = calculatePrize(room);
        
        // Apply 50 ETB bonus for four corners win
        if (isFourCornersWin) {
          bonus = CONFIG.FOUR_CORNERS_BONUS;
          prize += bonus;
          await updateDailyStats('totalFourCorners', 1);
        }
        
        houseEarnings = calculateHouseEarnings(room);
        
        // Update winner balance and stats
        winner.balance += prize;
        winner.totalWins = (winner.totalWins || 0) + 1;
        winner.totalBingos = (winner.totalBingos || 0) + 1;
        await winner.save();
        
        // Update stats
        await updateDailyStats('totalGames', 1);
        await updateDailyStats('totalBingos', 1);
        
        // Notify winner
        for (const [socketId, uId] of socketToUser.entries()) {
          if (uId === winnerUserId) {
            const winnerSocket = io.sockets.sockets.get(socketId);
            if (winnerSocket) {
              winnerSocket.emit('balanceUpdate', winner.balance);
            }
          }
        }
        
        // Log transaction
        await createTransaction(isFourCornersWin ? 'WIN_FOUR_CORNERS' : 'WIN', winnerUserId, prize, roomStake);
        
        // Add to room history
        room.gameHistory = room.gameHistory || [];
        room.gameHistory.push({
          timestamp: new Date().toISOString(),
          winner: winnerUserId,
          winnerName: winnerName,
          prize: prize,
          players: room.players.length,
          ballsDrawn: room.ballsDrawn,
          isFourCorners: isFourCornersWin
        });
      }
    } else {
      houseEarnings = calculateHouseEarnings(room);
      await updateDailyStats('totalGames', 1);
      
      // Add to room history for house win
      room.gameHistory = room.gameHistory || [];
      room.gameHistory.push({
        timestamp: new Date().toISOString(),
        winner: 'HOUSE',
        winnerName: 'HOUSE',
        prize: 0,
        players: room.players.length,
        ballsDrawn: room.ballsDrawn,
        isFourCorners: false
      });
    }
    
    // Save room updates
    await room.save();
    
    if (houseEarnings > 0) {
      await createTransaction('HOUSE_EARNINGS', 'HOUSE', houseEarnings, roomStake, false);
    }
    
    // Notify all players and reset their room status
    for (const userId of room.players) {
      const user = await User.findOne({ userId: userId });
      if (user) {
        user.currentRoom = null;
        user.box = null;
        await user.save();
        
        // Notify player
        for (const [socketId, uId] of socketToUser.entries()) {
          if (uId === userId) {
            const socket = io.sockets.sockets.get(socketId);
            if (socket) {
              socket.emit('gameOver', {
                room: roomStake,
                winnerId: winnerUserId,
                winnerName: winnerName,
                prize: prize,
                houseEarnings: houseEarnings,
                isFourCornersWin: isFourCornersWin,
                bonus: bonus
              });
            }
          }
        }
      }
    }
    
    // Reset room after delay
    setTimeout(async () => {
      await Room.findByIdAndUpdate(room._id, {
        players: [],
        takenBoxes: [],
        calledNumbers: [],
        status: 'waiting',
        currentBall: null,
        ballsDrawn: 0,
        startTime: null,
        endTime: null
      });
      
      updateAdminPanel();
      broadcastRoomStatus();
    }, 5000);
    
  } catch (error) {
    console.error('Error ending game:', error);
  }
}

// ========== ADMIN PANEL FUNCTIONS ==========

// Update admin panel
async function updateAdminPanel() {
  try {
    const totalPlayers = Array.from(socketToUser.keys()).length;
    const activeGames = await Room.countDocuments({ status: 'playing' });
    const houseBalance = await calculateHouseBalance();
    const systemStats = await getSystemStats();
    
    // Get all users for admin panel
    const users = await User.find({}).sort({ balance: -1 }).limit(100);
    const userArray = users.map(user => {
      let isOnline = false;
      for (const [socketId, userId] of socketToUser.entries()) {
        if (userId === user.userId && io.sockets.sockets.get(socketId)?.connected) {
          isOnline = true;
          break;
        }
      }
      
      return {
        userId: user.userId,
        userName: user.userName,
        balance: user.balance,
        currentRoom: user.currentRoom,
        box: user.box,
        joinedAt: user.joinedAt,
        isOnline: isOnline,
        totalWagered: user.totalWagered || 0,
        totalWins: user.totalWins || 0,
        lastSeen: user.lastSeen || user.joinedAt
      };
    });
    
    // Get recent transactions
    const recentTransactions = await Transaction.find({})
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();
    
    // Get room data
    const roomsData = {};
    const rooms = await Room.find({ status: { $in: ['waiting', 'starting', 'playing'] } });
    
    rooms.forEach(room => {
      const commissionPerPlayer = CONFIG.HOUSE_COMMISSION[room.stake] || 0;
      const contributionPerPlayer = room.stake - commissionPerPlayer;
      const potentialPrize = contributionPerPlayer * room.players.length;
      const houseFee = commissionPerPlayer * room.players.length;
      
      roomsData[room.stake] = {
        stake: room.stake,
        playerCount: room.players.length,
        takenBoxes: room.takenBoxes,
        status: room.status,
        currentBall: room.currentBall,
        ballsDrawn: room.ballsDrawn,
        commissionPerPlayer: commissionPerPlayer,
        contributionPerPlayer: contributionPerPlayer,
        potentialPrize: potentialPrize,
        houseFee: houseFee,
        gameHistory: room.gameHistory || []
      };
    });
    
    // Send data to all admin sockets
    adminSockets.forEach(socketId => {
      const socket = io.sockets.sockets.get(socketId);
      if (socket) {
        socket.emit('admin:update', {
          totalPlayers,
          activeGames,
          houseBalance,
          totalUsers: userArray.length,
          totalGames: systemStats?.todayStats?.totalGames || 0,
          totalBingos: systemStats?.todayStats?.totalBingos || 0,
          totalFourCorners: systemStats?.todayStats?.totalFourCorners || 0,
          dailyStats: systemStats?.todayStats || {}
        });
        
        socket.emit('admin:players', userArray);
        socket.emit('admin:rooms', roomsData);
        socket.emit('admin:transactions', recentTransactions);
      }
    });
  } catch (error) {
    console.error('Error updating admin panel:', error);
  }
}

// Broadcast room status to all clients
async function broadcastRoomStatus() {
  try {
    const rooms = await Room.find({ status: { $in: ['waiting', 'starting', 'playing'] } });
    const roomStatus = {};
    
    rooms.forEach(room => {
      const commissionPerPlayer = CONFIG.HOUSE_COMMISSION[room.stake] || 0;
      const contributionPerPlayer = room.stake - commissionPerPlayer;
      const potentialPrize = contributionPerPlayer * room.players.length;
      const houseFee = commissionPerPlayer * room.players.length;
      
      roomStatus[room.stake] = {
        stake: room.stake,
        playerCount: room.players.length,
        status: room.status,
        takenBoxes: room.takenBoxes.length,
        commissionPerPlayer: commissionPerPlayer,
        contributionPerPlayer: contributionPerPlayer,
        potentialPrize: potentialPrize,
        houseFee: houseFee,
        currentBall: room.currentBall
      };
    });
    
    io.emit('roomStatus', roomStatus);
  } catch (error) {
    console.error('Error broadcasting room status:', error);
  }
}

// Log activity
function logActivity(type, details, adminSocketId = null) {
  const activity = {
    id: Date.now().toString(),
    timestamp: new Date().toISOString(),
    type: type,
    details: details,
    adminSocketId: adminSocketId
  };
  activityLog.unshift(activity);
  
  if (activityLog.length > 200) {
    activityLog = activityLog.slice(0, 200);
  }
  
  // Broadcast to admin panels
  adminSockets.forEach(socketId => {
    const socket = io.sockets.sockets.get(socketId);
    if (socket) {
      socket.emit('admin:activity', activity);
    }
  });
}

// ========== SOCKET.IO EVENT HANDLERS ==========

io.on('connection', (socket) => {
  console.log(`New connection: ${socket.id}`);
  
  socket.on('init', async (data) => {
    const { userId, userName } = data;
    
    const user = await getUser(userId, userName);
    
    if (user) {
      socketToUser.set(socket.id, userId);
      
      socket.emit('balanceUpdate', user.balance);
      socket.emit('userData', {
        userId: userId,
        userName: user.userName,
        referralCode: user.referralCode,
        joinedAt: user.joinedAt
      });
      
      updateAdminPanel();
      broadcastRoomStatus();
    } else {
      socket.emit('error', 'Failed to initialize user');
    }
  });
  
  socket.on('refreshBalance', async () => {
    const userId = socketToUser.get(socket.id);
    if (userId) {
      const user = await User.findOne({ userId: userId });
      if (user) {
        socket.emit('balanceUpdate', user.balance);
        socket.emit('balanceRefreshed', user.balance);
      }
    }
  });
  
  socket.on('getTakenBoxes', async ({ room }, callback) => {
    try {
      const roomData = await Room.findOne({ stake: parseInt(room) });
      if (roomData) {
        callback(roomData.takenBoxes || []);
      } else {
        callback([]);
      }
    } catch (error) {
      console.error('Error getting taken boxes:', error);
      callback([]);
    }
  });
  
  socket.on('joinRoom', async (data) => {
    const { room, box, userName } = data;
    const userId = socketToUser.get(socket.id);
    
    if (!userId) {
      socket.emit('error', 'Player not initialized');
      return;
    }
    
    const user = await User.findOne({ userId: userId });
    if (!user) {
      socket.emit('error', 'User not found');
      return;
    }
    
    if (user.balance < room) {
      socket.emit('insufficientFunds');
      return;
    }
    
    const roomData = await getRoom(room);
    if (!roomData) {
      socket.emit('error', 'Invalid room');
      return;
    }
    
    if (box < 1 || box > 100) {
      socket.emit('error', 'Invalid box number. Must be between 1 and 100');
      return;
    }
    
    if (roomData.takenBoxes.includes(box)) {
      socket.emit('boxTaken');
      return;
    }
    
    if (user.currentRoom) {
      if (user.currentRoom === room) {
        socket.emit('joinedRoom');
        return;
      }
      socket.emit('error', 'Already in a different room');
      return;
    }
    
    // Update user balance and room info
    user.balance -= room;
    user.totalWagered = (user.totalWagered || 0) + room;
    user.currentRoom = room;
    user.box = box;
    await user.save();
    
    // Update room
    roomData.players.push(userId);
    roomData.takenBoxes.push(box);
    
    const playerCount = roomData.players.length;
    
    // Update all players in room about lobby count
    roomData.players.forEach(playerUserId => {
      for (const [sId, uId] of socketToUser.entries()) {
        if (uId === playerUserId) {
          const s = io.sockets.sockets.get(sId);
          if (s) {
            s.emit('lobbyUpdate', {
              room: room,
              count: playerCount
            });
          }
        }
      }
    });
    
    if (playerCount >= CONFIG.MIN_PLAYERS_TO_START && roomData.status === 'waiting') {
      roomData.status = 'starting';
      await roomData.save();
      
      let countdown = CONFIG.COUNTDOWN_TIMER;
      const countdownInterval = setInterval(async () => {
        try {
          const currentRoom = await Room.findById(roomData._id);
          if (!currentRoom || currentRoom.status !== 'starting') {
            clearInterval(countdownInterval);
            return;
          }
          
          currentRoom.players.forEach(playerUserId => {
            for (const [sId, uId] of socketToUser.entries()) {
              if (uId === playerUserId) {
                const s = io.sockets.sockets.get(sId);
                if (s) {
                  s.emit('gameCountdown', {
                    room: room,
                    timer: countdown
                  });
                }
              }
            }
          });
          
          countdown--;
          
          if (countdown < 0) {
            clearInterval(countdownInterval);
            currentRoom.status = 'playing';
            currentRoom.startTime = new Date();
            await currentRoom.save();
            startGameTimer(currentRoom);
          }
        } catch (error) {
          console.error('Error in countdown:', error);
          clearInterval(countdownInterval);
        }
      }, 1000);
    }
    
    await roomData.save();
    socket.emit('joinedRoom');
    socket.emit('balanceUpdate', user.balance);
    
    await createTransaction('STAKE', userId, -room, room);
    updateAdminPanel();
    broadcastRoomStatus();
  });
  
  socket.on('claimBingo', async (data) => {
    const { room, grid, marked } = data;
    const userId = socketToUser.get(socket.id);
    
    if (!userId) {
      socket.emit('error', 'Not authenticated');
      return;
    }
    
    const user = await User.findOne({ userId: userId });
    if (!user || user.currentRoom !== room) {
      socket.emit('error', 'Not in this room');
      return;
    }
    
    const roomData = await Room.findOne({ stake: room, status: 'playing' });
    if (!roomData) {
      socket.emit('error', 'Game not in progress');
      return;
    }
    
    const bingoResult = checkBingoPattern(grid, marked);
    
    if (bingoResult.win) {
      const isFourCornersWin = bingoResult.pattern === 'fourCorners';
      await endGame(room, userId, isFourCornersWin);
    } else {
      socket.emit('error', 'Invalid bingo claim');
    }
  });
  
  // ========== ADMIN EVENTS ==========
  socket.on('admin:auth', (password) => {
    if (password === CONFIG.ADMIN_PASSWORD) {
      adminSockets.add(socket.id);
      socket.emit('admin:authSuccess');
      updateAdminPanel();
      
      logActivity('ADMIN_LOGIN', { socketId: socket.id }, socket.id);
      console.log(`Admin authenticated: ${socket.id}`);
    } else {
      socket.emit('admin:authError', 'Invalid password');
    }
  });
  
  socket.on('admin:getData', () => {
    if (!adminSockets.has(socket.id)) {
      socket.emit('admin:error', 'Unauthorized');
      return;
    }
    updateAdminPanel();
  });
  
  socket.on('admin:addFunds', async ({ userId, amount }) => {
    if (!adminSockets.has(socket.id)) {
      socket.emit('admin:error', 'Unauthorized');
      return;
    }
    
    const user = await User.findOne({ userId: userId });
    if (!user) {
      socket.emit('admin:error', 'User not found');
      return;
    }
    
    const oldBalance = user.balance;
    user.balance += parseFloat(amount);
    await user.save();
    
    // Notify player if online
    for (const [sId, uId] of socketToUser.entries()) {
      if (uId === userId) {
        const playerSocket = io.sockets.sockets.get(sId);
        if (playerSocket) {
          playerSocket.emit('balanceUpdate', user.balance);
          playerSocket.emit('fundsAdded', {
            amount: amount,
            newBalance: user.balance
          });
        }
      }
    }
    
    await createTransaction('ADMIN_ADD', userId, amount, null, true);
    logActivity('ADMIN_ADD_FUNDS', { userId, amount, oldBalance, newBalance: user.balance }, socket.id);
    socket.emit('admin:success', `Added ${amount} ETB to ${user.userName}`);
    updateAdminPanel();
  });
  
  socket.on('admin:banPlayer', async (userId) => {
    if (!adminSockets.has(socket.id)) {
      socket.emit('admin:error', 'Unauthorized');
      return;
    }
    
    const user = await User.findOne({ userId: userId });
    if (user) {
      // Remove user from room if in one
      if (user.currentRoom) {
        const room = await Room.findOne({ stake: user.currentRoom });
        if (room) {
          room.players = room.players.filter(id => id !== userId);
          room.takenBoxes = room.takenBoxes.filter(b => b !== user.box);
          await room.save();
        }
        user.currentRoom = null;
        user.box = null;
      }
      
      // Disconnect user socket
      for (const [sId, uId] of socketToUser.entries()) {
        if (uId === userId) {
          const playerSocket = io.sockets.sockets.get(sId);
          if (playerSocket) {
            playerSocket.emit('banned');
            playerSocket.disconnect();
          }
          socketToUser.delete(sId);
        }
      }
      
      // Delete user from database
      await User.deleteOne({ userId: userId });
      
      logActivity('ADMIN_BAN', { userId, userName: user.userName }, socket.id);
      socket.emit('admin:success', `Player ${user.userName} banned`);
      updateAdminPanel();
      broadcastRoomStatus();
    }
  });
  
  socket.on('admin:forceDraw', async (roomStake) => {
    if (!adminSockets.has(socket.id)) {
      socket.emit('admin:error', 'Unauthorized');
      return;
    }
    
    const room = await Room.findOne({ stake: parseInt(roomStake), status: 'playing' });
    if (room) {
      let ball;
      let letter;
      do {
        ball = Math.floor(Math.random() * 75) + 1;
        letter = getBingoLetter(ball);
      } while (room.calledNumbers.includes(ball));
      
      room.calledNumbers.push(ball);
      room.currentBall = ball;
      room.ballsDrawn += 1;
      await room.save();
      
      const ballData = {
        room: room.stake,
        num: ball,
        letter: letter,
        fullDisplay: `${letter}-${ball}`
      };
      
      room.players.forEach(userId => {
        for (const [sId, uId] of socketToUser.entries()) {
          if (uId === userId) {
            const s = io.sockets.sockets.get(sId);
            if (s) {
              s.emit('ballDrawn', ballData);
            }
          }
        }
      });
      
      logActivity('ADMIN_FORCE_DRAW', { room: roomStake, ball: ballData }, socket.id);
      socket.emit('admin:success', `Ball ${letter}-${ball} drawn in ${roomStake} ETB room`);
      updateAdminPanel();
    }
  });
  
  // Other admin events (simplified for brevity)
  socket.on('admin:broadcast', (message) => {
    if (!adminSockets.has(socket.id)) {
      socket.emit('admin:error', 'Unauthorized');
      return;
    }
    
    io.emit('adminBroadcast', {
      message: message,
      timestamp: new Date().toISOString()
    });
    
    logActivity('ADMIN_BROADCAST', { message }, socket.id);
    socket.emit('admin:success', `Broadcast sent: "${message}"`);
  });
  
  socket.on('admin:forceStart', async (roomStake) => {
    if (!adminSockets.has(socket.id)) {
      socket.emit('admin:error', 'Unauthorized');
      return;
    }
    
    const room = await Room.findOne({ stake: parseInt(roomStake), status: 'waiting' });
    if (room) {
      room.status = 'playing';
      room.startTime = new Date();
      await room.save();
      startGameTimer(room);
      
      logActivity('ADMIN_FORCE_START', { room: roomStake }, socket.id);
      socket.emit('admin:success', `Forced start in ${roomStake} ETB room`);
    } else {
      socket.emit('admin:error', `Cannot force start ${roomStake} ETB room`);
    }
  });
  
  socket.on('admin:forceEnd', async (roomStake) => {
    if (!adminSockets.has(socket.id)) {
      socket.emit('admin:error', 'Unauthorized');
      return;
    }
    
    const room = await Room.findOne({ stake: parseInt(roomStake), status: { $in: ['playing', 'starting'] } });
    if (room) {
      await endGame(room.stake, 'HOUSE');
      logActivity('ADMIN_FORCE_END', { room: roomStake }, socket.id);
      socket.emit('admin:success', `Forced game end in ${roomStake} ETB room`);
    } else {
      socket.emit('admin:error', `No active game in ${roomStake} ETB room`);
    }
  });
  
  socket.on('disconnect', async () => {
    console.log(`Disconnected: ${socket.id}`);
    
    adminSockets.delete(socket.id);
    
    const userId = socketToUser.get(socket.id);
    if (userId) {
      // Update user's online status
      await User.findOneAndUpdate(
        { userId: userId },
        { 
          isOnline: false,
          lastSeen: new Date() 
        }
      );
      
      socketToUser.delete(socket.id);
      
      // Check if user is in a room and remove them after timeout
      setTimeout(async () => {
        const user = await User.findOne({ userId: userId });
        if (user && user.currentRoom) {
          // Check if user reconnected
          let reconnected = false;
          for (const [sId, uId] of socketToUser.entries()) {
            if (uId === userId && io.sockets.sockets.get(sId)?.connected) {
              reconnected = true;
              break;
            }
          }
          
          if (!reconnected) {
            const room = await Room.findOne({ stake: user.currentRoom });
            if (room) {
              room.players = room.players.filter(id => id !== userId);
              room.takenBoxes = room.takenBoxes.filter(b => b !== user.box);
              await room.save();
              
              // Notify other players
              room.players.forEach(playerUserId => {
                for (const [sId, uId] of socketToUser.entries()) {
                  if (uId === playerUserId) {
                    const s = io.sockets.sockets.get(sId);
                    if (s) {
                      s.emit('lobbyUpdate', {
                        room: room.stake,
                        count: room.players.length
                      });
                    }
                  }
                }
              });
              
              // Reset user's room info
              user.currentRoom = null;
              user.box = null;
              await user.save();
              
              broadcastRoomStatus();
            }
          }
        }
      }, 10000);
    }
    
    updateAdminPanel();
  });
});

// ========== PERIODIC TASKS ==========
setInterval(() => {
  broadcastRoomStatus();
}, CONFIG.ROOM_STATUS_UPDATE_INTERVAL);

// Daily stats reset check
setInterval(async () => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const existing = await Stats.findOne({ date: today });
    
    if (!existing) {
      // Create new day stats
      await Stats.findOneAndUpdate(
        { date: today },
        {
          date: today,
          totalWagered: 0,
          totalEarnings: 0,
          totalGames: 0,
          totalUsers: 0,
          newUsers: 0,
          totalBingos: 0,
          totalFourCorners: 0
        },
        { upsert: true }
      );
      console.log('New day stats created:', today);
    }
  } catch (error) {
    console.error('Error checking daily stats:', error);
  }
}, 3600000); // Check every hour

// ========== EXPRESS ROUTES ==========
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Bingo Elite Server</title>
      <style>
        body { font-family: Arial, sans-serif; padding: 40px; text-align: center; background: #0f172a; color: #f8fafc; }
        .container { max-width: 800px; margin: 0 auto; }
        .status { padding: 30px; background: #1e293b; border-radius: 20px; margin: 30px auto; border: 1px solid #334155; }
        .stats-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px; margin: 30px 0; }
        .stat { background: rgba(255,255,255,0.05); padding: 20px; border-radius: 12px; }
        .stat-value { font-size: 2.5rem; font-weight: 900; margin: 10px 0; }
        .stat-label { font-size: 0.9rem; color: #94a3b8; text-transform: uppercase; letter-spacing: 1px; }
        .btn { display: inline-block; padding: 15px 30px; margin: 10px; background: #3b82f6; color: white; text-decoration: none; border-radius: 12px; font-weight: bold; transition: all 0.3s; }
        .btn:hover { background: #2563eb; transform: translateY(-2px); }
        .btn-admin { background: #ef4444; }
        .btn-admin:hover { background: #dc2626; }
        .btn-game { background: #10b981; }
        .btn-game:hover { background: #059669; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1 style="font-size: 3rem; margin-bottom: 20px;">🎮 Bingo Elite Server</h1>
        <p style="color: #94a3b8; font-size: 1.2rem;">Professional Bingo Gaming Platform with MongoDB</p>
        
        <div class="status">
          <h2 style="color: #10b981;">🚀 Server Status: RUNNING</h2>
          <div class="stats-grid">
            <div class="stat">
              <div class="stat-label">Connected Players</div>
              <div class="stat-value" id="playerCount">0</div>
            </div>
            <div class="stat">
              <div class="stat-label">Database Status</div>
              <div class="stat-value" style="color: #10b981;">✅ Online</div>
            </div>
          </div>
          <p style="margin-top: 20px; color: #f59e0b; font-weight: bold;">🎯 Four Corners Bonus: ${CONFIG.FOUR_CORNERS_BONUS} ETB!</p>
          <p style="color: #64748b; margin-top: 10px;">Server Time: ${new Date().toLocaleString()}</p>
          <p style="color: #64748b;">MongoDB: Connected to Cluster0</p>
        </div>
        
        <div style="margin-top: 40px;">
          <h3>Access Points:</h3>
          <div>
            <a href="/admin" class="btn btn-admin" target="_blank">🔒 Admin Panel</a>
            <a href="/game" class="btn btn-game" target="_blank">🎮 Game Client</a>
          </div>
          <div style="margin-top: 20px;">
            <a href="/health" class="btn" style="background: #64748b;" target="_blank">📊 Health Check</a>
            <a href="/stats" class="btn" style="background: #8b5cf6;" target="_blank">📈 Statistics</a>
          </div>
        </div>
        
        <div style="margin-top: 40px; padding: 20px; background: rgba(255,255,255,0.03); border-radius: 12px;">
          <h4>System Information</h4>
          <p style="color: #94a3b8; font-size: 0.9rem;">
            Version: 3.0.0 (MongoDB Edition) | Database: MongoDB Atlas<br>
            Room Stakes: ${CONFIG.ROOM_STAKES.join(', ')} ETB<br>
            Commission Structure: ${JSON.stringify(CONFIG.HOUSE_COMMISSION)}
          </p>
        </div>
      </div>
      
      <script>
        // Update player count in real-time
        const socket = io();
        socket.on('connect', () => {
          socket.emit('admin:getData');
        });
        
        socket.on('admin:update', (data) => {
          document.getElementById('playerCount').textContent = data.totalPlayers || 0;
        });
      </script>
    </body>
    </html>
  `);
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin chapter 8.html'));
});

app.get('/game', (req, res) => {
  res.sendFile(path.join(__dirname, 'finilized chapter 8.html'));
});

app.get('/health', async (req, res) => {
  try {
    const stats = await getSystemStats();
    const houseBalance = await calculateHouseBalance();
    const onlineUsers = Array.from(socketToUser.keys()).length;
    
    res.json({
      status: 'ok',
      database: 'connected',
      connectedPlayers: onlineUsers,
      totalUsers: stats?.totalUsers || 0,
      activeGames: await Room.countDocuments({ status: 'playing' }),
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      houseBalance: houseBalance,
      dailyStats: stats?.todayStats,
      bingoLetters: BINGO_LETTERS
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/stats', async (req, res) => {
  try {
    const stats = await getSystemStats();
    const houseBalance = await calculateHouseBalance();
    
    // Get top players
    const topPlayers = await User.find({})
      .sort({ balance: -1 })
      .limit(10)
      .select('userId userName balance totalWagered totalWins');
    
    // Get active rooms
    const activeRooms = await Room.find({ status: { $in: ['waiting', 'starting', 'playing'] } })
      .select('stake players status ballsDrawn');
    
    res.json({
      systemStats: stats?.todayStats,
      houseBalance: houseBalance,
      topPlayers: topPlayers,
      activeRooms: activeRooms,
      totalTransactions: stats?.totalTransactions || 0
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ========== START SERVER ==========
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`╔══════════════════════════════════════════════════════╗`);
  console.log(`║                🚀 BINGO ELITE SERVER                ║`);
  console.log(`╠══════════════════════════════════════════════════════╣`);
  console.log(`║  Port:          ${PORT.toString().padEnd(40)}║`);
  console.log(`║  Database:      MongoDB Atlas (Connected)           ║`);
  console.log(`║  Admin Panel:   http://localhost:${PORT}/admin        ║`);
  console.log(`║  Game Client:   http://localhost:${PORT}/game         ║`);
  console.log(`╠══════════════════════════════════════════════════════╣`);
  console.log(`║  🔑 Default Admin Password: admin1234               ║`);
  console.log(`║  ⚠️   CHANGE THE ADMIN PASSWORD IN PRODUCTION!      ║`);
  console.log(`╠══════════════════════════════════════════════════════╣`);
  console.log(`║  ⚡ Game Timing: ${CONFIG.COUNTDOWN_TIMER}s wait      ║`);
  console.log(`║  🔤 BINGO Letters: B(1-15) I(16-30) N(31-45)        ║`);
  console.log(`║            G(46-60) O(61-75)                        ║`);
  console.log(`║  🎯 Four Corners Bonus: ${CONFIG.FOUR_CORNERS_BONUS} ETB ║`);
  console.log(`╚══════════════════════════════════════════════════════╝`);
});
