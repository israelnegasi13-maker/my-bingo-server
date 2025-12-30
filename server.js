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
  ADMIN_PASSWORD: "admin1234", // Change this!
  INITIAL_BALANCE: 0.00,
  ROOM_STAKES: [10, 20, 50, 100],
  MAX_PLAYERS_PER_ROOM: 50,
  GAME_TIMER: 3, // 3 seconds between balls
  MIN_PLAYERS_TO_START: 2,
  HOUSE_COMMISSION: 0.05, // 5% commission
  BINGO_PRIZE_MULTIPLIER: 4.75,
  COUNTDOWN_TIMER: 30, // 30 seconds wait when 2 players join
  ROOM_STATUS_UPDATE_INTERVAL: 3000 // 3 seconds for room status updates
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

function checkBingoPattern(grid, markedNumbers) {
  const marks = new Set(markedNumbers);
  
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
    if (rowComplete) return true;
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
    if (colComplete) return true;
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
  
  return diag1Complete || diag2Complete;
}

function calculatePrize(room) {
  const totalPot = room.players.size * room.stake;
  const houseCut = totalPot * CONFIG.HOUSE_COMMISSION;
  return (totalPot - houseCut) * CONFIG.BINGO_PRIZE_MULTIPLIER;
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
  
  // Calculate house balance (all player balances are held by house)
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
        totalWagered
      });
      
      // Convert users to array for admin panel
      const userArray = [];
      users.forEach((user, userId) => {
        // Find if user is online
        let isOnline = false;
        let socketId = null;
        for (const [sId, uId] of socketToUser.entries()) {
          if (uId === userId && io.sockets.sockets.get(sId)?.connected) {
            isOnline = true;
            socketId = sId;
            break;
          }
        }
        
        userArray.push({
          userId: userId,
          socketId: socketId,
          userName: user.userName,
          balance: user.balance,
          currentRoom: user.currentRoom,
          box: user.box,
          joinedAt: user.joinedAt,
          isOnline: isOnline
        });
      });
      
      socket.emit('admin:players', userArray);
      
      socket.emit('admin:rooms', Array.from(rooms.entries()).reduce((obj, [stake, room]) => {
        obj[stake] = {
          stake: room.stake,
          playerCount: room.players.size,
          takenBoxes: Array.from(room.takenBoxes),
          status: room.status,
          currentBall: room.currentBall,
          ballsDrawn: room.ballsDrawn
        };
        return obj;
      }, {}));
      
      socket.emit('admin:transactions', transactions.slice(0, 50));
    }
  });
}

// NEW: Function to broadcast room status to all connected clients
function broadcastRoomStatus() {
  const roomStatus = Array.from(rooms.entries()).reduce((obj, [stake, room]) => {
    obj[stake] = {
      stake: room.stake,
      playerCount: room.players.size,
      status: room.status,
      takenBoxes: room.takenBoxes.size
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
    do {
      ball = Math.floor(Math.random() * 75) + 1;
    } while (room.calledNumbers.has(ball));
    
    room.calledNumbers.add(ball);
    room.currentBall = ball;
    room.ballsDrawn++;
    
    // Emit to all players in room
    room.players.forEach(userId => {
      // Find all sockets for this user
      for (const [socketId, uId] of socketToUser.entries()) {
        if (uId === userId) {
          const socket = io.sockets.sockets.get(socketId);
          if (socket) {
            socket.emit('ballDrawn', {
              room: room.stake,
              num: ball
            });
          }
        }
      }
    });
    
    // Enable bingo claiming after 5 balls
    if (room.ballsDrawn >= 5) {
      room.players.forEach(userId => {
        // Find all sockets for this user
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
    
  }, CONFIG.GAME_TIMER * 1000);
}

function endGame(roomStake, winnerUserId) {
  const room = rooms.get(roomStake);
  if (!room || room.status !== 'playing') return;
  
  clearInterval(room.gameTimer);
  room.status = 'ended';
  
  let winnerName = 'HOUSE';
  let prize = 0;
  
  if (winnerUserId !== 'HOUSE') {
    const winner = users.get(winnerUserId);
    if (winner) {
      winnerName = winner.userName;
      prize = calculatePrize(room);
      winner.balance += prize;
      winner.totalWins = (winner.totalWins || 0) + 1;
      
      // Notify winner through all their sockets
      for (const [socketId, userId] of socketToUser.entries()) {
        if (userId === winnerUserId) {
          const winnerSocket = io.sockets.sockets.get(socketId);
          if (winnerSocket) {
            winnerSocket.emit('balanceUpdate', winner.balance);
          }
        }
      }
      
      logTransaction('WIN', winnerUserId, prize, roomStake);
    }
  }
  
  // Notify all players in room through all their sockets
  room.players.forEach(userId => {
    const user = users.get(userId);
    if (user) {
      user.currentRoom = null;
      user.box = null;
      
      // Find all sockets for this user
      for (const [socketId, uId] of socketToUser.entries()) {
        if (uId === userId) {
          const socket = io.sockets.sockets.get(socketId);
          if (socket) {
            socket.emit('gameOver', {
              room: roomStake,
              winnerId: winnerUserId,
              winnerName: winnerName,
              prize: prize
            });
          }
        }
      }
    }
  });
  
  // Reset room after delay
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
  
  // Initialize player
  socket.on('init', (data) => {
    const { userId, userName } = data;
    
    // Create or get user
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
      // Update last seen and user info
      user.lastSeen = new Date();
      if (userName && user.userName !== userName) {
        user.userName = userName;
      }
    }
    
    // Map socket to user
    socketToUser.set(socket.id, userId);
    
    socket.emit('balanceUpdate', user.balance);
    updateAdminPanel();
    broadcastRoomStatus();
  });
  
  // Refresh balance
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
  
  // Get taken boxes for a room
  socket.on('getTakenBoxes', ({ room }, callback) => {
    const roomData = rooms.get(parseInt(room));
    if (roomData) {
      callback(Array.from(roomData.takenBoxes));
    } else {
      callback([]);
    }
  });
  
  // Join a room
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
    
    // Check if player has enough balance
    if (user.balance < room) {
      socket.emit('insufficientFunds');
      return;
    }
    
    const roomData = rooms.get(room);
    if (!roomData) {
      socket.emit('error', 'Invalid room');
      return;
    }
    
    // Check if box is available
    if (roomData.takenBoxes.has(box)) {
      socket.emit('boxTaken');
      return;
    }
    
    // Check if user is already in a room
    if (user.currentRoom) {
      socket.emit('error', 'Already in a room');
      return;
    }
    
    // Deduct stake from balance
    user.balance -= room;
    user.totalWagered = (user.totalWagered || 0) + room;
    user.currentRoom = room;
    user.box = box;
    
    // Add to room
    roomData.players.add(userId);
    roomData.takenBoxes.add(box);
    
    // Update player count
    const playerCount = roomData.players.size;
    
    // Notify all players in room through all their sockets
    roomData.players.forEach(playerUserId => {
      const playerUser = users.get(playerUserId);
      if (playerUser) {
        // Find all sockets for this user
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
      }
    });
    
    // Start game if enough players
    if (playerCount >= CONFIG.MIN_PLAYERS_TO_START && roomData.status === 'waiting') {
      roomData.status = 'starting';
      
      // Start countdown
      let countdown = CONFIG.COUNTDOWN_TIMER;
      const countdownInterval = setInterval(() => {
        roomData.players.forEach(playerUserId => {
          const playerUser = users.get(playerUserId);
          if (playerUser) {
            // Find all sockets for this user
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
  
  // Claim bingo
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
    
    // Verify bingo pattern
    const isValidBingo = checkBingoPattern(grid, marked);
    
    if (isValidBingo) {
      endGame(room, userId);
    } else {
      socket.emit('error', 'Invalid bingo claim');
    }
  });
  
  // ========== ADMIN EVENTS ==========
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
    
    // Notify user through all their sockets if online
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
      // Kick player from any room
      if (user.currentRoom) {
        const room = rooms.get(user.currentRoom);
        if (room) {
          room.players.delete(userId);
          room.takenBoxes.delete(user.box);
        }
        user.currentRoom = null;
        user.box = null;
      }
      
      // Notify user through all their sockets
      for (const [sId, uId] of socketToUser.entries()) {
        if (uId === userId) {
          const playerSocket = io.sockets.sockets.get(sId);
          if (playerSocket) {
            playerSocket.emit('banned');
            playerSocket.disconnect();
          }
        }
      }
      
      // Remove from users map
      users.delete(userId);
      
      // Remove socket mappings
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
      do {
        ball = Math.floor(Math.random() * 75) + 1;
      } while (room.calledNumbers.has(ball));
      
      room.calledNumbers.add(ball);
      room.currentBall = ball;
      room.ballsDrawn++;
      
      room.players.forEach(userId => {
        // Find all sockets for this user
        for (const [sId, uId] of socketToUser.entries()) {
          if (uId === userId) {
            const s = io.sockets.sockets.get(sId);
            if (s) {
              s.emit('ballDrawn', {
                room: room.stake,
                num: ball
              });
            }
          }
        }
      });
      
      socket.emit('admin:success', `Ball ${ball} drawn in ${roomStake} ETB room`);
      updateAdminPanel();
    }
  });
  
  // Handle disconnect
  socket.on('disconnect', () => {
    console.log(`Disconnected: ${socket.id}`);
    
    // Remove from admin sockets
    adminSockets.delete(socket.id);
    
    // Handle player disconnect
    const userId = socketToUser.get(socket.id);
    if (userId) {
      const user = users.get(userId);
      
      // Update last seen
      if (user) {
        user.lastSeen = new Date();
      }
      
      // Remove socket mapping
      socketToUser.delete(socket.id);
      
      // Check if user has any other active sockets
      let hasOtherConnections = false;
      for (const [sId, uId] of socketToUser.entries()) {
        if (uId === userId && io.sockets.sockets.get(sId)?.connected) {
          hasOtherConnections = true;
          break;
        }
      }
      
      // If no other connections, remove from room after timeout (in case of quick reconnect)
      if (!hasOtherConnections && user && user.currentRoom) {
        setTimeout(() => {
          // Check again if user reconnected
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
              
              // Update remaining players
              room.players.forEach(playerUserId => {
                // Find all sockets for this user
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
        }, 10000); // 10 second grace period for reconnection
      }
    }
    
    updateAdminPanel();
  });
});

// Start broadcasting room status to all clients
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
      </style>
    </head>
    <body>
      <h1>🎮 Bingo Elite Server</h1>
      <div class="status">
        <h2>Server Status: <span style="color: green;">RUNNING</span></h2>
        <p>Connected Players: ${Array.from(socketToUser.keys()).length}</p>
        <p>Total Users: ${users.size}</p>
        <p>Active Rooms: ${Array.from(rooms.values()).filter(r => r.status === 'playing').length}</p>
        <p>Server Time: ${new Date().toLocaleString()}</p>
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

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    connectedPlayers: socketToUser.size,
    totalUsers: users.size,
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
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
  console.log(`🔄 Room status updates every ${CONFIG.ROOM_STATUS_UPDATE_INTERVAL/1000}s`);
});
