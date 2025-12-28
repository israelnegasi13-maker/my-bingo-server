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
app.use(express.json());

// ========== GAME STATE ==========
let gameState = {
  players: new Map(), // socket.id -> player data
  rooms: new Map(), // room amount -> room data
  takenBoxes: new Map(), // room amount -> Set of taken boxes (1-50)
  activeGames: new Map(), // room amount -> game data
  bannedPlayers: new Set(), // banned user IDs
  transactions: [], // transaction history
  houseBalance: 1000000, // Unlimited house money
};

// Initialize rooms with box tracking
[10, 20, 50, 100].forEach(amount => {
  gameState.rooms.set(amount, {
    amount: amount,
    players: new Set(),
    status: 'waiting',
    countdown: null,
    calledNumbers: new Set(),
    winner: null,
    gameInterval: null,
    takenBoxes: new Set(),
  });
});

// ========== HELPER FUNCTIONS ==========
function generateGrid(seed) {
  let nums = Array.from({length: 75}, (_, i) => i + 1);
  
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
  
  for (let i = nums.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [nums[i], nums[j]] = [nums[j], nums[i]];
  }

  const grid = [];
  for(let i=0; i<25; i++) {
    grid.push(i === 12 ? 'FREE' : nums[i]);
  }
  return grid;
}

function checkWinningPattern(grid, marked) {
  const markedSet = new Set(marked);
  const isM = (idx) => markedSet.has(grid[idx]);
  
  for(let i=0; i<5; i++) {
    // Horizontal
    if(isM(i*5) && isM(i*5+1) && isM(i*5+2) && isM(i*5+3) && isM(i*5+4)) return true;
    // Vertical
    if(isM(i) && isM(i+5) && isM(i+10) && isM(i+15) && isM(i+20)) return true;
  }
  // Diagonals
  if(isM(0) && isM(6) && isM(12) && isM(18) && isM(24)) return true;
  if(isM(4) && isM(8) && isM(12) && isM(16) && isM(20)) return true;
  
  return false;
}

function startGame(roomAmount) {
  const room = gameState.rooms.get(roomAmount);
  if (!room || room.players.size < 2) return;
  
  room.status = 'playing';
  room.calledNumbers = new Set();
  room.winner = null;
  
  // Assign grids to players based on their selected box
  room.players.forEach(socketId => {
    const player = gameState.players.get(socketId);
    if (player) {
      player.grid = generateGrid(player.box);
      player.marked = new Set(['FREE']);
    }
  });
  
  // Start countdown
  let countdown = 5;
  const countdownInterval = setInterval(() => {
    room.players.forEach(socketId => {
      io.to(socketId).emit('gameCountdown', { room: roomAmount, timer: countdown });
    });
    
    if (countdown <= 0) {
      clearInterval(countdownInterval);
      room.players.forEach(socketId => {
        io.to(socketId).emit('gameCountdown', { room: roomAmount, timer: 0 });
      });
      startDrawingBalls(roomAmount);
    }
    countdown--;
  }, 1000);
}

function startDrawingBalls(roomAmount) {
  const room = gameState.rooms.get(roomAmount);
  if (!room) return;
  
  const numbers = Array.from({length: 75}, (_, i) => i + 1);
  const drawnNumbers = new Set();
  
  room.gameInterval = setInterval(() => {
    if (drawnNumbers.size >= 75 || room.winner) {
      clearInterval(room.gameInterval);
      if (!room.winner) {
        // House wins - no bingo claimed
        endGame(roomAmount, 'HOUSE', null);
      }
      return;
    }
    
    let num;
    do {
      num = Math.floor(Math.random() * 75) + 1;
    } while (drawnNumbers.has(num));
    
    drawnNumbers.add(num);
    room.calledNumbers.add(num);
    
    // Send ball to all players in room
    room.players.forEach(socketId => {
      io.to(socketId).emit('ballDrawn', { room: roomAmount, num: num });
    });
    
    // Check if any player can claim bingo
    room.players.forEach(socketId => {
      const player = gameState.players.get(socketId);
      if (player && player.grid) {
        // Get player's marked numbers
        const markedNumbers = Array.from(player.marked);
        // Check if they have a winning pattern
        if (checkWinningPattern(player.grid, markedNumbers)) {
          io.to(socketId).emit('enableBingo');
        }
      }
    });
    
  }, 3000); // Draw every 3 seconds
}

function endGame(roomAmount, winnerSocketId, winnerName) {
  const room = gameState.rooms.get(roomAmount);
  if (!room) return;
  
  const prize = room.amount * room.players.size;
  
  if (winnerSocketId === 'HOUSE') {
    // House wins all
    gameState.houseBalance += prize;
    room.players.forEach(socketId => {
      io.to(socketId).emit('gameOver', {
        room: roomAmount,
        winnerId: 'HOUSE',
        winnerName: 'HOUSE',
        prize: 0
      });
    });
  } else {
    // Player wins
    const winner = gameState.players.get(winnerSocketId);
    if (winner) {
      winner.balance += prize;
      gameState.houseBalance -= prize;
      
      io.to(winnerSocketId).emit('gameOver', {
        room: roomAmount,
        winnerId: winnerSocketId,
        winnerName: winner.userName,
        prize: prize
      });
      
      // Notify losers
      room.players.forEach(socketId => {
        if (socketId !== winnerSocketId) {
          io.to(socketId).emit('gameOver', {
            room: roomAmount,
            winnerId: winnerSocketId,
            winnerName: winner.userName,
            prize: 0
          });
        }
      });
    }
  }
  
  // Clear room for next game
  if (room.gameInterval) {
    clearInterval(room.gameInterval);
  }
  
  // Clear taken boxes for this room
  room.takenBoxes.clear();
  room.players.clear();
  room.status = 'waiting';
  room.winner = null;
  room.calledNumbers.clear();
  
  // Record transaction
  gameState.transactions.push({
    type: winnerSocketId === 'HOUSE' ? 'house_win' : 'player_win',
    amount: prize,
    winner: winnerSocketId,
    winnerName: winnerName,
    room: roomAmount,
    timestamp: new Date()
  });
  
  updateAdminDashboard();
}

// ========== SOCKET.IO HANDLERS ==========
io.on('connection', (socket) => {
  console.log('New connection:', socket.id);
  
  // Initialize player WITH 0 BALANCE
  socket.on('init', (data) => {
    const userId = data.userId;
    
    // Check if banned
    if (gameState.bannedPlayers.has(userId)) {
      socket.emit('banned');
      socket.disconnect();
      return;
    }
    
    // Initialize or update player WITH 0 BALANCE
    let player = gameState.players.get(socket.id);
    if (!player) {
      player = {
        socketId: socket.id,
        userId: userId,
        userName: data.userName || 'Guest',
        balance: 0.00, // CHANGED FROM 100.00 TO 0.00
        currentRoom: null,
        box: null,
        grid: null,
        marked: new Set(),
        joinedAt: new Date()
      };
      gameState.players.set(socket.id, player);
    }
    
    socket.emit('balanceUpdate', player.balance);
    console.log(`Player ${player.userName} (${socket.id}) connected with balance: ${player.balance}`);
  });
  
  // Refresh balance request
  socket.on('refreshBalance', () => {
    const player = gameState.players.get(socket.id);
    if (player) {
      socket.emit('balanceRefreshed', player.balance);
    }
  });
  
  // Get taken boxes for a room (FIXED: Now properly returns array of taken boxes)
  socket.on('getTakenBoxes', (data, callback) => {
    const room = gameState.rooms.get(data.room);
    if (room && callback) {
      // Return array of taken boxes (1-50)
      callback(Array.from(room.takenBoxes));
    } else {
      callback([]);
    }
  });
  
  // Join room
  socket.on('joinRoom', (data) => {
    const { room: amount, box, userName } = data;
    const room = gameState.rooms.get(amount);
    let player = gameState.players.get(socket.id);
    
    if (!player) {
      // Create player if doesn't exist WITH 0 BALANCE
      player = {
        socketId: socket.id,
        userId: socket.id,
        userName: userName,
        balance: 0.00, // CHANGED FROM 100.00 TO 0.00
        currentRoom: null,
        box: null,
        grid: null,
        marked: new Set(),
        joinedAt: new Date()
      };
      gameState.players.set(socket.id, player);
    }
    
    if (!room) {
      socket.emit('error', 'Room not found');
      return;
    }
    
    // Check if player has enough balance
    if (player.balance < amount) {
      socket.emit('insufficientFunds');
      return;
    }
    
    // Check if box (1-50) is already taken in this room
    if (room.takenBoxes.has(box)) {
      socket.emit('boxTaken');
      return;
    }
    
    // Deduct stake from player
    player.balance -= amount;
    gameState.houseBalance += amount;
    
    // Update player state
    player.currentRoom = amount;
    player.box = box;
    player.userName = userName;
    
    // Add player to room
    room.players.add(socket.id);
    room.takenBoxes.add(box);
    
    // Send updated balance
    socket.emit('balanceUpdate', player.balance);
    socket.emit('joinedRoom');
    
    // Update lobby for all players in room
    const playerCount = room.players.size;
    room.players.forEach(playerSocketId => {
      io.to(playerSocketId).emit('lobbyUpdate', {
        room: amount,
        count: playerCount
      });
    });
    
    // Record transaction
    gameState.transactions.push({
      type: 'stake',
      playerId: socket.id,
      playerName: userName,
      amount: amount,
      room: amount,
      timestamp: new Date()
    });
    
    // Start game if we have 2+ players and game isn't already running
    if (playerCount >= 2 && room.status === 'waiting') {
      setTimeout(() => startGame(amount), 2000);
    }
    
    updateAdminDashboard();
  });
  
  // Claim bingo
  socket.on('claimBingo', (data) => {
    const { room: amount, grid, marked } = data;
    const room = gameState.rooms.get(amount);
    const player = gameState.players.get(socket.id);
    
    if (!room || !player || room.status !== 'playing') {
      return;
    }
    
    // Verify winning pattern
    if (checkWinningPattern(grid, marked)) {
      room.winner = socket.id;
      endGame(amount, socket.id, player.userName);
    }
  });
  
  // Disconnection
  socket.on('disconnect', () => {
    const player = gameState.players.get(socket.id);
    if (player && player.currentRoom) {
      const room = gameState.rooms.get(player.currentRoom);
      if (room) {
        room.players.delete(socket.id);
        if (player.box) {
          room.takenBoxes.delete(player.box);
        }
        
        // Update remaining players
        const playerCount = room.players.size;
        if (playerCount > 0) {
          room.players.forEach(playerSocketId => {
            io.to(playerSocketId).emit('lobbyUpdate', {
              room: player.currentRoom,
              count: playerCount
            });
          });
        } else {
          // No players left, reset room
          if (room.gameInterval) {
            clearInterval(room.gameInterval);
          }
          room.status = 'waiting';
          room.takenBoxes.clear();
        }
      }
    }
    
    gameState.players.delete(socket.id);
    updateAdminDashboard();
  });
  
  // ========== ADMIN EVENTS ==========
  socket.on('admin:auth', (password) => {
    // Simple password check - change this in production!
    if (password === 'admin123') {
      socket.admin = true;
      socket.join('admins');
      socket.emit('admin:authSuccess');
      updateAdminDashboard();
    } else {
      socket.emit('admin:authError', 'Invalid password');
    }
  });
  
  socket.on('admin:getData', () => {
    if (!socket.admin) return;
    updateAdminDashboard();
  });
  
  socket.on('admin:addFunds', (data) => {
    if (!socket.admin) return;
    
    const { playerId, amount } = data;
    let player = null;
    
    // Find player by socket ID or user ID
    for (let [socketId, p] of gameState.players) {
      if (socketId === playerId || p.userId === playerId) {
        player = p;
        break;
      }
    }
    
    if (player) {
      player.balance += parseFloat(amount);
      
      // Notify player of funds added
      io.to(player.socketId).emit('fundsAdded', {
        amount: amount,
        newBalance: player.balance
      });
      
      // Also send balance update
      io.to(player.socketId).emit('balanceUpdate', player.balance);
      
      // Record transaction
      gameState.transactions.push({
        type: 'admin_add',
        admin: socket.id,
        playerId: player.socketId,
        playerName: player.userName,
        amount: amount,
        timestamp: new Date()
      });
      
      socket.emit('admin:success', `Added ${amount} ETB to ${player.userName} (New balance: ${player.balance})`);
      updateAdminDashboard();
    } else {
      socket.emit('admin:error', 'Player not found');
    }
  });
  
  socket.on('admin:banPlayer', (playerId) => {
    if (!socket.admin) return;
    
    let player = null;
    for (let [socketId, p] of gameState.players) {
      if (socketId === playerId || p.userId === playerId) {
        player = p;
        break;
      }
    }
    
    if (player) {
      gameState.bannedPlayers.add(player.userId);
      io.to(player.socketId).emit('banned');
      setTimeout(() => {
        const sock = io.sockets.sockets.get(player.socketId);
        if (sock) sock.disconnect();
      }, 1000);
      
      socket.emit('admin:success', `Banned ${player.userName}`);
      updateAdminDashboard();
    }
  });
  
  socket.on('admin:forceDraw', (roomAmount) => {
    if (!socket.admin) return;
    
    const room = gameState.rooms.get(parseInt(roomAmount));
    if (room && room.status === 'playing') {
      // Force draw a random number
      let num;
      do {
        num = Math.floor(Math.random() * 75) + 1;
      } while (room.calledNumbers.has(num));
      
      room.calledNumbers.add(num);
      room.players.forEach(socketId => {
        io.to(socketId).emit('ballDrawn', { room: roomAmount, num: num });
      });
    }
  });
  
  socket.on('admin:forceStart', (roomAmount) => {
    if (!socket.admin) return;
    
    const room = gameState.rooms.get(parseInt(roomAmount));
    if (room && room.players.size >= 1) {
      startGame(parseInt(roomAmount));
    }
  });
  
  socket.on('admin:forceEnd', (roomAmount) => {
    if (!socket.admin) return;
    
    const room = gameState.rooms.get(parseInt(roomAmount));
    if (room) {
      endGame(parseInt(roomAmount), 'HOUSE', null);
    }
  });
  
  socket.on('admin:kickPlayer', (playerId) => {
    if (!socket.admin) return;
    
    const player = gameState.players.get(playerId);
    if (player) {
      const sock = io.sockets.sockets.get(playerId);
      if (sock) {
        sock.disconnect();
        socket.emit('admin:success', `Kicked ${player.userName}`);
      }
    }
  });
  
  socket.on('admin:adjustHouse', (amount) => {
    if (!socket.admin) return;
    
    gameState.houseBalance += parseFloat(amount);
    socket.emit('admin:success', `Adjusted house balance by ${amount} ETB`);
    updateAdminDashboard();
  });
  
  socket.on('admin:setPlayerBalance', (data) => {
    if (!socket.admin) return;
    
    const { playerId, balance } = data;
    let player = null;
    
    for (let [socketId, p] of gameState.players) {
      if (socketId === playerId || p.userId === playerId) {
        player = p;
        break;
      }
    }
    
    if (player) {
      player.balance = parseFloat(balance);
      io.to(player.socketId).emit('balanceUpdate', player.balance);
      socket.emit('admin:success', `Set ${player.userName} balance to ${balance} ETB`);
      updateAdminDashboard();
    }
  });
});

function updateAdminDashboard() {
  const activePlayers = Array.from(gameState.players.values());
  const roomsData = {};
  
  gameState.rooms.forEach((room, amount) => {
    roomsData[amount] = {
      amount: amount,
      players: Array.from(room.players),
      playerCount: room.players.size,
      status: room.status,
      takenBoxes: Array.from(room.takenBoxes),
      calledNumbers: Array.from(room.calledNumbers)
    };
  });
  
  // Calculate total wagered
  const totalWagered = gameState.transactions
    .filter(t => t.type === 'stake')
    .reduce((sum, t) => sum + t.amount, 0);
  
  // Calculate active games
  const activeGames = Array.from(gameState.rooms.values())
    .filter(r => r.status === 'playing').length;
  
  io.to('admins').emit('admin:update', {
    totalPlayers: activePlayers.length,
    activeGames: activeGames,
    houseBalance: gameState.houseBalance,
    totalWagered: totalWagered
  });
  
  io.to('admins').emit('admin:players', activePlayers);
  io.to('admins').emit('admin:rooms', roomsData);
  io.to('admins').emit('admin:transactions', gameState.transactions.slice(-50));
}

// ========== HTTP ROUTES ==========
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Bingo Elite Server</title>
      <style>
        body { font-family: Arial, sans-serif; padding: 40px; text-align: center; }
        .container { max-width: 600px; margin: 0 auto; }
        .status { background: #f0f0f0; padding: 20px; border-radius: 10px; margin: 20px 0; }
        .online { color: green; font-weight: bold; }
        .zero-balance { color: red; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>🎮 Bingo Elite Server</h1>
        <div class="status">
          <p>Status: <span class="online">RUNNING</span></p>
          <p>Players Online: ${gameState.players.size}</p>
          <p>House Balance: ${gameState.houseBalance.toFixed(2)} ETB</p>
          <p>Players with 0 balance: ${Array.from(gameState.players.values()).filter(p => p.balance === 0).length}</p>
        </div>
        <div>
          <h3>Available Endpoints:</h3>
          <ul style="text-align: left;">
            <li><strong>Game:</strong> Connect via WebSocket</li>
            <li><strong>Admin Panel:</strong> <a href="/admin" target="_blank">/admin</a></li>
            <li><strong>Health Check:</strong> <a href="/health">/health</a></li>
          </ul>
        </div>
        <div style="margin-top: 20px; padding: 15px; background: #ffebee; border-radius: 5px;">
          <strong>⚠️ IMPORTANT:</strong> New players start with <span class="zero-balance">0 ETB balance</span><br>
          Admin must add funds for players to play
        </div>
      </div>
    </body>
    </html>
  `);
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    players: gameState.players.size,
    playersWithZeroBalance: Array.from(gameState.players.values()).filter(p => p.balance === 0).length,
    uptime: process.uptime(),
    timestamp: new Date()
  });
});

app.get('/admin', (req, res) => {
  res.sendFile(__dirname + '/admin.html');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`🎮 Game URL: http://localhost:${PORT}`);
  console.log(`🔧 Admin Panel: http://localhost:${PORT}/admin`);
  console.log(`🔐 Admin Password: admin123`);
  console.log(`💰 NEW PLAYERS START WITH: 0 ETB (Admin must add funds)`);
});
