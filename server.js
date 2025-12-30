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
  GAME_TIMER: 30, // seconds between balls
  MIN_PLAYERS_TO_START: 2,
  HOUSE_COMMISSION: 0.05, // 5% commission
  BINGO_PRIZE_MULTIPLIER: 4.75
};

// ========== DATA STORAGE ==========
let players = new Map(); // socket.id -> player data
let rooms = new Map(); // stake -> room data
let transactions = [];
let adminSockets = new Set();

// Initialize rooms
CONFIG.ROOM_STAKES.forEach(stake => {
  rooms.set(stake, {
    stake: stake,
    players: new Set(),
    takenBoxes: new Set(),
    status: 'waiting', // waiting, playing, ended
    calledNumbers: new Set(),
    gameTimer: null,
    startTime: null,
    currentBall: null,
    ballsDrawn: 0
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

function logTransaction(type, playerId, amount, room, admin = false) {
  const tx = {
    id: Date.now().toString(),
    timestamp: new Date().toISOString(),
    type: type,
    playerId: playerId,
    playerName: players.get(playerId)?.userName || 'System',
    amount: amount,
    room: room,
    admin: admin
  };
  transactions.unshift(tx);
  return tx;
}

function updateAdminPanel() {
  const totalPlayers = Array.from(players.values()).filter(p => p.socket.connected).length;
  const activeGames = Array.from(rooms.values()).filter(r => r.status === 'playing').length;
  
  let houseBalance = 0;
  let totalWagered = 0;
  
  // Calculate house balance (all player balances are held by house)
  players.forEach(player => {
    houseBalance += player.balance;
    totalWagered += player.totalWagered || 0;
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
      
      socket.emit('admin:players', Array.from(players.values()).map(p => ({
        socketId: p.socket.id,
        userName: p.userName,
        balance: p.balance,
        currentRoom: p.currentRoom,
        box: p.box,
        joinedAt: p.joinedAt
      })));
      
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
    room.players.forEach(playerSocketId => {
      const socket = io.sockets.sockets.get(playerSocketId);
      if (socket) {
        socket.emit('ballDrawn', {
          room: room.stake,
          num: ball
        });
      }
    });
    
    // Enable bingo claiming after 5 balls
    if (room.ballsDrawn >= 5) {
      room.players.forEach(playerSocketId => {
        const socket = io.sockets.sockets.get(playerSocketId);
        if (socket) {
          socket.emit('enableBingo');
        }
      });
    }
    
    updateAdminPanel();
    
  }, CONFIG.GAME_TIMER * 1000);
}

function endGame(roomStake, winnerSocketId) {
  const room = rooms.get(roomStake);
  if (!room || room.status !== 'playing') return;
  
  clearInterval(room.gameTimer);
  room.status = 'ended';
  
  let winnerName = 'HOUSE';
  let prize = 0;
  
  if (winnerSocketId !== 'HOUSE') {
    const winner = players.get(winnerSocketId);
    if (winner) {
      winnerName = winner.userName;
      prize = calculatePrize(room);
      winner.balance += prize;
      winner.totalWins = (winner.totalWins || 0) + 1;
      
      // Notify winner
      const winnerSocket = io.sockets.sockets.get(winnerSocketId);
      if (winnerSocket) {
        winnerSocket.emit('balanceUpdate', winner.balance);
      }
      
      logTransaction('WIN', winnerSocketId, prize, roomStake);
    }
  }
  
  // Notify all players in room
  room.players.forEach(playerSocketId => {
    const socket = io.sockets.sockets.get(playerSocketId);
    if (socket) {
      socket.emit('gameOver', {
        room: roomStake,
        winnerId: winnerSocketId,
        winnerName: winnerName,
        prize: prize
      });
      
      // Reset player room status
      const player = players.get(playerSocketId);
      if (player) {
        player.currentRoom = null;
        player.box = null;
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
  }, 5000);
}

// ========== SOCKET.IO EVENT HANDLERS ==========
io.on('connection', (socket) => {
  console.log(`New connection: ${socket.id}`);
  
  // Initialize player
  socket.on('init', (data) => {
    const { userId, userName } = data;
    
    // Check if player already exists
    let player = players.get(socket.id);
    if (!player) {
      player = {
        socket: socket,
        userId: userId,
        userName: userName || 'Guest',
        balance: CONFIG.INITIAL_BALANCE,
        currentRoom: null,
        box: null,
        joinedAt: new Date(),
        totalWagered: 0,
        totalWins: 0
      };
      players.set(socket.id, player);
    }
    
    socket.emit('balanceUpdate', player.balance);
    updateAdminPanel();
  });
  
  // Refresh balance
  socket.on('refreshBalance', () => {
    const player = players.get(socket.id);
    if (player) {
      socket.emit('balanceUpdate', player.balance);
      socket.emit('balanceRefreshed', player.balance);
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
    const player = players.get(socket.id);
    
    if (!player) {
      socket.emit('error', 'Player not initialized');
      return;
    }
    
    // Check if player has enough balance
    if (player.balance < room) {
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
    
    // Deduct stake from balance
    player.balance -= room;
    player.totalWagered = (player.totalWagered || 0) + room;
    player.currentRoom = room;
    player.box = box;
    
    // Add to room
    roomData.players.add(socket.id);
    roomData.takenBoxes.add(box);
    
    // Update player count
    const playerCount = roomData.players.size;
    
    // Notify all players in room
    roomData.players.forEach(playerSocketId => {
      const s = io.sockets.sockets.get(playerSocketId);
      if (s) {
        s.emit('lobbyUpdate', {
          room: room,
          count: playerCount
        });
      }
    });
    
    // Start game if enough players
    if (playerCount >= CONFIG.MIN_PLAYERS_TO_START && roomData.status === 'waiting') {
      roomData.status = 'starting';
      
      // Start countdown
      let countdown = 5;
      const countdownInterval = setInterval(() => {
        roomData.players.forEach(playerSocketId => {
          const s = io.sockets.sockets.get(playerSocketId);
          if (s) {
            s.emit('gameCountdown', {
              room: room,
              timer: countdown
            });
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
    socket.emit('balanceUpdate', player.balance);
    
    logTransaction('STAKE', socket.id, -room, room);
    updateAdminPanel();
  });
  
  // Claim bingo
  socket.on('claimBingo', (data) => {
    const { room, grid, marked } = data;
    const player = players.get(socket.id);
    
    if (!player || player.currentRoom !== room) {
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
      endGame(room, socket.id);
    } else {
      socket.emit('error', 'Invalid bingo claim');
    }
  });
  
  // ========== ADMIN EVENTS ==========
  socket.on('admin:auth', (password) => {
    if (password === CONFIG.ADMIN_PASSWORD) {
      adminSockets.add(socket.id);
      socket.emit('admin:authSuccess');
      socket.emit('admin:getData'); // Trigger data fetch
      console.log(`Admin authenticated: ${socket.id}`);
    } else {
      socket.emit('admin:authError', 'Invalid password');
    }
  });
  
  socket.on('admin:getData', () => {
    updateAdminPanel();
  });
  
  socket.on('admin:addFunds', ({ playerId, amount }) => {
    if (!adminSockets.has(socket.id)) {
      socket.emit('admin:error', 'Unauthorized');
      return;
    }
    
    const player = players.get(playerId);
    if (!player) {
      socket.emit('admin:error', 'Player not found');
      return;
    }
    
    player.balance += parseFloat(amount);
    
    // Notify player if online
    const playerSocket = io.sockets.sockets.get(playerId);
    if (playerSocket) {
      playerSocket.emit('balanceUpdate', player.balance);
      playerSocket.emit('fundsAdded', {
        amount: amount,
        newBalance: player.balance
      });
    }
    
    logTransaction('ADMIN_ADD', playerId, amount, null, true);
    socket.emit('admin:success', `Added ${amount} ETB to ${player.userName}`);
    updateAdminPanel();
  });
  
  socket.on('admin:banPlayer', (playerId) => {
    if (!adminSockets.has(socket.id)) {
      socket.emit('admin:error', 'Unauthorized');
      return;
    }
    
    const player = players.get(playerId);
    if (player) {
      // Kick player from any room
      if (player.currentRoom) {
        const room = rooms.get(player.currentRoom);
        if (room) {
          room.players.delete(playerId);
          room.takenBoxes.delete(player.box);
        }
      }
      
      // Notify player
      const playerSocket = io.sockets.sockets.get(playerId);
      if (playerSocket) {
        playerSocket.emit('banned');
        playerSocket.disconnect();
      }
      
      players.delete(playerId);
      socket.emit('admin:success', `Player ${player.userName} banned`);
      updateAdminPanel();
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
      
      room.players.forEach(playerSocketId => {
        const s = io.sockets.sockets.get(playerSocketId);
        if (s) {
          s.emit('ballDrawn', {
            room: room.stake,
            num: ball
          });
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
    const player = players.get(socket.id);
    if (player) {
      // Remove from room if in one
      if (player.currentRoom) {
        const room = rooms.get(player.currentRoom);
        if (room) {
          room.players.delete(socket.id);
          room.takenBoxes.delete(player.box);
          
          // Update remaining players
          room.players.forEach(playerSocketId => {
            const s = io.sockets.sockets.get(playerSocketId);
            if (s) {
              s.emit('lobbyUpdate', {
                room: room.stake,
                count: room.players.size
              });
            }
          });
        }
      }
      
      players.delete(socket.id);
    }
    
    updateAdminPanel();
  });
});

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
        <p>Connected Players: ${Array.from(players.values()).filter(p => p.socket.connected).length}</p>
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
    players: players.size,
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
});
