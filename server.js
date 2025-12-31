const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
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
app.use(helmet());
app.use(express.json());

// Serve static files for admin panel
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
  ROOM_STATUS_UPDATE_INTERVAL: 3000
};

// BINGO letter ranges
const BINGO_LETTERS = {
  'B': { min: 1, max: 15, color: '#3b82f6' },   // Blue
  'I': { min: 16, max: 30, color: '#8b5cf6' },  // Purple
  'N': { min: 31, max: 45, color: '#10b981' },  // Green
  'G': { min: 46, max: 60, color: '#f59e0b' },  // Yellow
  'O': { min: 61, max: 75, color: '#ef4444' }   // Red
};

// ========== DATA STORAGE ==========
let users = new Map(); // userId -> user data (persistent)
let socketToUser = new Map(); // socket.id -> userId
let rooms = new Map(); // stake -> room data
let transactions = [];
let adminSockets = new Set();

// Initialize rooms
CONFIG.ROOM_STAKES.forEach(stake => {
  rooms.set(stake, {
    stake: stake,
    players: new Set(), // Stores userIds
    takenBoxes: new Set(),
    status: 'waiting', // waiting, starting, playing, ended
    calledNumbers: new Set(),
    gameTimer: null,
    startTime: null,
    currentBall: null,
    ballsDrawn: 0,
    lastStatusUpdate: Date.now()
  });
});

// ========== HELPER FUNCTIONS ==========
function generateRandomNumbers(count, max) {
  const numbers = new Set();
  while (numbers.size < count) {
    numbers.add(Math.floor(Math.random() * max) + 1);
  }
  return Array.from(numbers);
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

// Generate traditional bingo card with letters
function generateBingoCard(seed) {
  const card = {
    letters: ['B', 'I', 'N', 'G', 'O'],
    numbers: []
  };
  
  // Create a seeded random generator
  function seededRandom(s) {
    var mask = 0xffffffff;
    var m_w = (123456789 + s) & mask;
    var m_z = (987654321 - s) & mask;

    return function() {
      m_z = (36969 * (m_z & 65535) + (m_z >> 16)) & mask;
      m_w = (18000 * (m_w & 65535) + (m_w >> 16)) & mask;
      var result = ((m_z << 16) + (m_w & 65535)) >>> 0;
      return result / 4294967296;
    }
  }

  const random = seededRandom(seed * 777);
  
  // Generate numbers for each column (letter)
  for (let col = 0; col < 5; col++) {
    const letter = card.letters[col];
    const range = BINGO_LETTERS[letter];
    let numbersInColumn = [];
    
    // Generate 5 unique numbers for this column
    for (let i = 0; i < 5; i++) {
      let num;
      do {
        num = Math.floor(random() * (range.max - range.min + 1)) + range.min;
      } while (numbersInColumn.includes(num));
      numbersInColumn.push(num);
    }
    
    // Sort numbers in column (optional, but traditional)
    numbersInColumn.sort((a, b) => a - b);
    
    // Add to card numbers
    for (let row = 0; row < 5; row++) {
      const index = row * 5 + col;
      if (col === 2 && row === 2) {
        card.numbers[index] = 'FREE'; // Center is FREE
      } else {
        card.numbers[index] = numbersInColumn[row];
      }
    }
  }
  
  return card;
}

// Check if the marked numbers form a four corners pattern
function checkFourCorners(grid, markedNumbers) {
  const marks = new Set(markedNumbers);
  
  // Four corners positions in a 5x5 grid (0-indexed):
  // Top-left: index 0 (B1)
  // Top-right: index 4 (B5)
  // Bottom-left: index 20 (O1)
  // Bottom-right: index 24 (O5)
  
  const topLeft = grid[0];
  const topRight = grid[4];
  const bottomLeft = grid[20];
  const bottomRight = grid[24];
  
  // Check if all four corners are marked (or FREE, which is always marked)
  const hasTopLeft = marks.has(topLeft) || topLeft === 'FREE';
  const hasTopRight = marks.has(topRight) || topRight === 'FREE';
  const hasBottomLeft = marks.has(bottomLeft) || bottomLeft === 'FREE';
  const hasBottomRight = marks.has(bottomRight) || bottomRight === 'FREE';
  
  return hasTopLeft && hasTopRight && hasBottomLeft && hasBottomRight;
}

function checkBingoPattern(grid, markedNumbers) {
  const marks = new Set(markedNumbers);
  
  // First check if it's a four corners win
  if (checkFourCorners(grid, markedNumbers)) {
    return { win: true, pattern: 'fourCorners' };
  }
  
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
  
  return { win: false, pattern: null };
}

function calculatePrize(room) {
  const playerCount = room.players.size;
  const stake = room.stake;
  const commissionPerPlayer = CONFIG.HOUSE_COMMISSION[stake] || 0;
  
  const contributionPerPlayer = stake - commissionPerPlayer;
  const totalPrize = contributionPerPlayer * playerCount;
  
  return totalPrize;
}

function calculateHouseEarnings(room) {
  const playerCount = room.players.size;
  const stake = room.stake;
  const commissionPerPlayer = CONFIG.HOUSE_COMMISSION[stake] || 0;
  
  return commissionPerPlayer * playerCount;
}

function logTransaction(type, userId, amount, room, admin = false) {
  const user = users.get(userId);
  const tx = {
    id: Date.now().toString(),
    timestamp: new Date().toISOString(),
    type: type,
    userId: userId,
    userName: user?.userName || 'System',
    amount: amount,
    room: room,
    admin: admin
  };
  transactions.unshift(tx);
  return tx;
}

function updateAdminPanel() {
  const totalPlayers = Array.from(socketToUser.keys()).length;
  const activeGames = Array.from(rooms.values()).filter(r => r.status === 'playing').length;
  
  let houseBalance = 0;
  let totalWagered = 0;
  
  users.forEach(user => {
    houseBalance += user.balance;
    totalWagered += user.totalWagered || 0;
  });
  
  adminSockets.forEach(socketId => {
    const socket = io.sockets.sockets.get(socketId);
    if (socket) {
      socket.emit('admin:update', {
        totalPlayers,
        activeGames,
        houseBalance,
        totalWagered,
        totalUsers: users.size
      });
      
      const userArray = [];
      users.forEach((user, userId) => {
        let isOnline = false;
        let userSocketId = null;
        for (const [sId, uId] of socketToUser.entries()) {
          if (uId === userId && io.sockets.sockets.get(sId)?.connected) {
            isOnline = true;
            userSocketId = sId;
            break;
          }
        }
        
        userArray.push({
          userId: userId,
          socketId: userSocketId,
          userName: user.userName,
          balance: user.balance,
          currentRoom: user.currentRoom,
          box: user.box,
          joinedAt: user.joinedAt,
          isOnline: isOnline,
          totalWagered: user.totalWagered || 0,
          totalWins: user.totalWins || 0
        });
      });
      
      socket.emit('admin:players', userArray);
      
      socket.emit('admin:rooms', Array.from(rooms.entries()).reduce((obj, [stake, room]) => {
        const commissionPerPlayer = CONFIG.HOUSE_COMMISSION[stake] || 0;
        const contributionPerPlayer = stake - commissionPerPlayer;
        const potentialPrize = contributionPerPlayer * room.players.size;
        
        obj[stake] = {
          stake: stake,
          playerCount: room.players.size,
          takenBoxes: Array.from(room.takenBoxes),
          status: room.status,
          currentBall: room.currentBall,
          ballsDrawn: room.ballsDrawn,
          commissionPerPlayer: commissionPerPlayer,
          contributionPerPlayer: contributionPerPlayer,
          potentialPrize: potentialPrize
        };
        return obj;
      }, {}));
      
      socket.emit('admin:transactions', transactions.slice(0, 50));
    }
  });
}

function broadcastRoomStatus() {
  const roomStatus = Array.from(rooms.entries()).reduce((obj, [stake, room]) => {
    const commissionPerPlayer = CONFIG.HOUSE_COMMISSION[stake] || 0;
    const contributionPerPlayer = stake - commissionPerPlayer;
    const potentialPrize = contributionPerPlayer * room.players.size;
    
    obj[stake] = {
      stake: stake,
      playerCount: room.players.size,
      status: room.status,
      takenBoxes: room.takenBoxes.size,
      commissionPerPlayer: commissionPerPlayer,
      contributionPerPlayer: contributionPerPlayer,
      potentialPrize: potentialPrize
    };
    return obj;
  }, {});
  
  io.emit('roomStatus', roomStatus);
}

function startGameTimer(room) {
  if (room.gameTimer) clearInterval(room.gameTimer);
  
  room.gameTimer = setInterval(() => {
    if (room.ballsDrawn >= 75) {
      endGame(room.stake, 'HOUSE');
      return;
    }
    
    let ball;
    let letter;
    do {
      ball = Math.floor(Math.random() * 75) + 1;
      letter = getBingoLetter(ball);
    } while (room.calledNumbers.has(ball));
    
    room.calledNumbers.add(ball);
    room.currentBall = ball;
    room.ballsDrawn++;
    
    // Emit ball with letter
    const ballData = {
      room: room.stake,
      num: ball,
      letter: letter,
      fullDisplay: `${letter}-${ball}`
    };
    
    // Emit to all players in room
    room.players.forEach(userId => {
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
    if (room.ballsDrawn >= 5) {
      room.players.forEach(userId => {
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
    
  }, CONFIG.GAME_TIMER * 1000);
}

function endGame(roomStake, winnerUserId, isFourCornersWin = false) {
  const room = rooms.get(roomStake);
  if (!room || room.status !== 'playing') return;
  
  clearInterval(room.gameTimer);
  room.status = 'ended';
  
  let winnerName = 'HOUSE';
  let prize = 0;
  let houseEarnings = 0;
  let bonus = 0;
  
  if (winnerUserId !== 'HOUSE') {
    const winner = users.get(winnerUserId);
    if (winner) {
      winnerName = winner.userName;
      prize = calculatePrize(room);
      
      // Apply 50 ETB bonus for four corners win
      if (isFourCornersWin) {
        bonus = CONFIG.FOUR_CORNERS_BONUS;
        prize += bonus;
      }
      
      houseEarnings = calculateHouseEarnings(room);
      
      winner.balance += prize;
      winner.totalWins = (winner.totalWins || 0) + 1;
      
      for (const [socketId, userId] of socketToUser.entries()) {
        if (userId === winnerUserId) {
          const winnerSocket = io.sockets.sockets.get(socketId);
          if (winnerSocket) {
            winnerSocket.emit('balanceUpdate', winner.balance);
          }
        }
      }
      
      // Log the win with pattern info
      logTransaction(isFourCornersWin ? 'WIN_FOUR_CORNERS' : 'WIN', winnerUserId, prize, roomStake);
    }
  } else {
    houseEarnings = calculateHouseEarnings(room);
  }
  
  if (houseEarnings > 0) {
    logTransaction('HOUSE_EARNINGS', 'HOUSE', houseEarnings, roomStake, false);
  }
  
  room.players.forEach(userId => {
    const user = users.get(userId);
    if (user) {
      user.currentRoom = null;
      user.box = null;
      
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
  });
  
  setTimeout(() => {
    room.players.clear();
    room.takenBoxes.clear();
    room.calledNumbers.clear();
    room.status = 'waiting';
    room.currentBall = null;
    room.ballsDrawn = 0;
    room.gameTimer = null;
    updateAdminPanel();
    broadcastRoomStatus();
  }, 5000);
}

// ========== SOCKET.IO EVENT HANDLERS ==========
io.on('connection', (socket) => {
  console.log(`New connection: ${socket.id}`);
  
  socket.on('init', (data) => {
    const { userId, userName } = data;
    
    let user = users.get(userId);
    if (!user) {
      user = {
        userId: userId,
        userName: userName || 'Guest',
        balance: CONFIG.INITIAL_BALANCE,
        currentRoom: null,
        box: null,
        joinedAt: new Date(),
        totalWagered: 0,
        totalWins: 0,
        lastSeen: new Date()
      };
      users.set(userId, user);
    } else {
      user.lastSeen = new Date();
      if (userName && user.userName !== userName) {
        user.userName = userName;
      }
    }
    
    socketToUser.set(socket.id, userId);
    
    socket.emit('balanceUpdate', user.balance);
    updateAdminPanel();
    broadcastRoomStatus();
  });
  
  socket.on('refreshBalance', () => {
    const userId = socketToUser.get(socket.id);
    if (userId) {
      const user = users.get(userId);
      if (user) {
        socket.emit('balanceUpdate', user.balance);
        socket.emit('balanceRefreshed', user.balance);
      }
    }
  });
  
  socket.on('getTakenBoxes', ({ room }, callback) => {
    const roomData = rooms.get(parseInt(room));
    if (roomData) {
      callback(Array.from(roomData.takenBoxes));
    } else {
      callback([]);
    }
  });
  
  socket.on('joinRoom', (data) => {
    const { room, box, userName } = data;
    const userId = socketToUser.get(socket.id);
    
    if (!userId) {
      socket.emit('error', 'Player not initialized');
      return;
    }
    
    const user = users.get(userId);
    if (!user) {
      socket.emit('error', 'User not found');
      return;
    }
    
    if (user.balance < room) {
      socket.emit('insufficientFunds');
      return;
    }
    
    const roomData = rooms.get(room);
    if (!roomData) {
      socket.emit('error', 'Invalid room');
      return;
    }
    
    if (box < 1 || box > 100) {
      socket.emit('error', 'Invalid box number. Must be between 1 and 100');
      return;
    }
    
    if (roomData.takenBoxes.has(box)) {
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
    
    user.balance -= room;
    user.totalWagered = (user.totalWagered || 0) + room;
    user.currentRoom = room;
    user.box = box;
    
    roomData.players.add(userId);
    roomData.takenBoxes.add(box);
    
    const playerCount = roomData.players.size;
    
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
      
      let countdown = CONFIG.COUNTDOWN_TIMER;
      const countdownInterval = setInterval(() => {
        roomData.players.forEach(playerUserId => {
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
          roomData.status = 'playing';
          startGameTimer(roomData);
        }
      }, 1000);
    }
    
    socket.emit('joinedRoom');
    socket.emit('balanceUpdate', user.balance);
    
    logTransaction('STAKE', userId, -room, room);
    updateAdminPanel();
    broadcastRoomStatus();
  });
  
  socket.on('claimBingo', (data) => {
    const { room, grid, marked } = data;
    const userId = socketToUser.get(socket.id);
    
    if (!userId) {
      socket.emit('error', 'Not authenticated');
      return;
    }
    
    const user = users.get(userId);
    if (!user || user.currentRoom !== room) {
      socket.emit('error', 'Not in this room');
      return;
    }
    
    const roomData = rooms.get(room);
    if (!roomData || roomData.status !== 'playing') {
      socket.emit('error', 'Game not in progress');
      return;
    }
    
    const bingoResult = checkBingoPattern(grid, marked);
    
    if (bingoResult.win) {
      const isFourCornersWin = bingoResult.pattern === 'fourCorners';
      endGame(room, userId, isFourCornersWin);
    } else {
      socket.emit('error', 'Invalid bingo claim');
    }
  });
  
  socket.on('admin:auth', (password) => {
    if (password === CONFIG.ADMIN_PASSWORD) {
      adminSockets.add(socket.id);
      socket.emit('admin:authSuccess');
      socket.emit('admin:getData');
      console.log(`Admin authenticated: ${socket.id}`);
    } else {
      socket.emit('admin:authError', 'Invalid password');
    }
  });
  
  socket.on('admin:getData', () => {
    updateAdminPanel();
  });
  
  socket.on('admin:addFunds', ({ userId, amount }) => {
    if (!adminSockets.has(socket.id)) {
      socket.emit('admin:error', 'Unauthorized');
      return;
    }
    
    const user = users.get(userId);
    if (!user) {
      socket.emit('admin:error', 'User not found');
      return;
    }
    
    user.balance += parseFloat(amount);
    
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
    
    logTransaction('ADMIN_ADD', userId, amount, null, true);
    socket.emit('admin:success', `Added ${amount} ETB to ${user.userName}`);
    updateAdminPanel();
  });
  
  socket.on('admin:banPlayer', (userId) => {
    if (!adminSockets.has(socket.id)) {
      socket.emit('admin:error', 'Unauthorized');
      return;
    }
    
    const user = users.get(userId);
    if (user) {
      if (user.currentRoom) {
        const room = rooms.get(user.currentRoom);
        if (room) {
          room.players.delete(userId);
          room.takenBoxes.delete(user.box);
        }
        user.currentRoom = null;
        user.box = null;
      }
      
      for (const [sId, uId] of socketToUser.entries()) {
        if (uId === userId) {
          const playerSocket = io.sockets.sockets.get(sId);
          if (playerSocket) {
            playerSocket.emit('banned');
            playerSocket.disconnect();
          }
        }
      }
      
      users.delete(userId);
      
      for (const [sId, uId] of socketToUser.entries()) {
        if (uId === userId) {
          socketToUser.delete(sId);
        }
      }
      
      socket.emit('admin:success', `Player ${user.userName} banned`);
      updateAdminPanel();
      broadcastRoomStatus();
    }
  });
  
  socket.on('admin:forceDraw', (roomStake) => {
    if (!adminSockets.has(socket.id)) {
      socket.emit('admin:error', 'Unauthorized');
      return;
    }
    
    const room = rooms.get(parseInt(roomStake));
    if (room && room.status === 'playing') {
      let ball;
      let letter;
      do {
        ball = Math.floor(Math.random() * 75) + 1;
        letter = getBingoLetter(ball);
      } while (room.calledNumbers.has(ball));
      
      room.calledNumbers.add(ball);
      room.currentBall = ball;
      room.ballsDrawn++;
      
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
      
      socket.emit('admin:success', `Ball ${letter}-${ball} drawn in ${roomStake} ETB room`);
      updateAdminPanel();
    }
  });
  
  socket.on('disconnect', () => {
    console.log(`Disconnected: ${socket.id}`);
    
    adminSockets.delete(socket.id);
    
    const userId = socketToUser.get(socket.id);
    if (userId) {
      const user = users.get(userId);
      
      if (user) {
        user.lastSeen = new Date();
      }
      
      socketToUser.delete(socket.id);
      
      let hasOtherConnections = false;
      for (const [sId, uId] of socketToUser.entries()) {
        if (uId === userId && io.sockets.sockets.get(sId)?.connected) {
          hasOtherConnections = true;
          break;
        }
      }
      
      if (!hasOtherConnections && user && user.currentRoom) {
        setTimeout(() => {
          let reconnected = false;
          for (const [sId, uId] of socketToUser.entries()) {
            if (uId === userId && io.sockets.sockets.get(sId)?.connected) {
              reconnected = true;
              break;
            }
          }
          
          if (!reconnected && user && user.currentRoom) {
            const room = rooms.get(user.currentRoom);
            if (room) {
              room.players.delete(userId);
              room.takenBoxes.delete(user.box);
              
              room.players.forEach(playerUserId => {
                for (const [sId, uId] of socketToUser.entries()) {
                  if (uId === playerUserId) {
                    const s = io.sockets.sockets.get(sId);
                    if (s) {
                      s.emit('lobbyUpdate', {
                        room: room.stake,
                        count: room.players.size
                      });
                    }
                  }
                }
              });
              
              user.currentRoom = null;
              user.box = null;
              broadcastRoomStatus();
            }
          }
        }, 10000);
      }
    }
    
    updateAdminPanel();
  });
});

setInterval(() => {
  broadcastRoomStatus();
}, CONFIG.ROOM_STATUS_UPDATE_INTERVAL);

// ========== EXPRESS ROUTES ==========
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Bingo Elite Server</title>
      <style>
        body { font-family: Arial, sans-serif; padding: 40px; text-align: center; }
        .status { padding: 20px; background: #f0f0f0; border-radius: 10px; margin: 20px auto; max-width: 600px; }
        .bingo-letters { display: flex; justify-content: center; gap: 20px; margin: 20px; }
        .bingo-letter { width: 60px; height: 60px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 24px; font-weight: bold; color: white; }
      </style>
    </head>
    <body>
      <h1>🎮 Bingo Elite Server</h1>
      <div class="status">
        <h2>Server Status: <span style="color: green;">RUNNING</span></h2>
        <p>Connected Players: ${Array.from(socketToUser.keys()).length}</p>
        <p>Total Users: ${users.size}</p>
        <p>Active Games: ${Array.from(rooms.values()).filter(r => r.status === 'playing').length}</p>
        <p>Server Time: ${new Date().toLocaleString()}</p>
        <p style="color: #f59e0b; font-weight: bold;">🎯 Four Corners Bonus: ${CONFIG.FOUR_CORNERS_BONUS} ETB!</p>
      </div>
      <div class="bingo-letters">
        <div class="bingo-letter" style="background: #3b82f6;">B</div>
        <div class="bingo-letter" style="background: #8b5cf6;">I</div>
        <div class="bingo-letter" style="background: #10b981;">N</div>
        <div class="bingo-letter" style="background: #f59e0b;">G</div>
        <div class="bingo-letter" style="background: #ef4444;">O</div>
      </div>
      <div>
        <h3>Access Points:</h3>
        <p><a href="/admin" target="_blank">Admin Panel</a></p>
        <p><a href="/game" target="_blank">Game Client</a></p>
      </div>
    </body>
    </html>
  `);
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'Admin panel (1).html'));
});

app.get('/game', (req, res) => {
  res.sendFile(path.join(__dirname, 'Finalized Chapter 2 (1).html'));
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    connectedPlayers: socketToUser.size,
    totalUsers: users.size,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    commissionStructure: CONFIG.HOUSE_COMMISSION,
    fourCornersBonus: CONFIG.FOUR_CORNERS_BONUS,
    bingoLetters: BINGO_LETTERS
  });
});

// ========== START SERVER ==========
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🌐 Admin Panel: http://localhost:${PORT}/admin`);
  console.log(`🎮 Game Client: http://localhost:${PORT}/game`);
  console.log(`🔑 Default Admin Password: ${CONFIG.ADMIN_PASSWORD}`);
  console.log(`⚠️  CHANGE THE ADMIN PASSWORD IN PRODUCTION!`);
  console.log(`⚡ Game Timing: ${CONFIG.COUNTDOWN_TIMER}s wait, ${CONFIG.GAME_TIMER}s between balls`);
  console.log(`🔤 BINGO Letters: B(1-15), I(16-30), N(31-45), G(46-60), O(61-75)`);
  console.log(`🎯 Four Corners Bonus: ${CONFIG.FOUR_CORNERS_BONUS} ETB extra for corner wins!`);
});
