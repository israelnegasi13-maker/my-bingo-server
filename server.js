const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');

// Initialize app
const app = express();
const server = http.createServer(app);

// Basic middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Simple root route
app.get('/', (req, res) => {
  res.send('Bingo Elite Server is running');
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Serve game files
app.get('/game', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'game.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Initialize Socket.io
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  pingTimeout: 60000,
  pingInterval: 25000
});

// Game state
const rooms = {
  10: { players: [], takenBoxes: [], status: 'waiting', calledNumbers: [] },
  20: { players: [], takenBoxes: [], status: 'waiting', calledNumbers: [] },
  50: { players: [], takenBoxes: [], status: 'waiting', calledNumbers: [] },
  100: { players: [], takenBoxes: [], status: 'waiting', calledNumbers: [] }
};

const players = new Map();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";

// Socket.io connection
io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);
  
  // Initialize player
  socket.on('init', (data) => {
    const { userId, userName } = data;
    
    players.set(socket.id, {
      socketId: socket.id,
      userId: userId,
      userName: userName || 'Guest',
      balance: 1000.00, // Default balance for testing
      currentRoom: null,
      box: null
    });
    
    socket.emit('balanceUpdate', 1000.00);
    socket.emit('joinedRoom');
  });
  
  // Get available boxes
  socket.on('getTakenBoxes', (data, callback) => {
    const { room } = data;
    callback(rooms[room] ? rooms[room].takenBoxes : []);
  });
  
  // Join room
  socket.on('joinRoom', (data) => {
    const { room, box, userName } = data;
    const player = players.get(socket.id);
    
    if (!player) return;
    
    // Check if box is taken
    if (rooms[room].takenBoxes.includes(box)) {
      socket.emit('boxTaken');
      return;
    }
    
    // Check balance
    if (player.balance < room) {
      socket.emit('insufficientFunds');
      return;
    }
    
    // Deduct stake
    player.balance -= room;
    player.currentRoom = room;
    player.box = box;
    
    // Add to room
    rooms[room].players.push({
      socketId: socket.id,
      userId: player.userId,
      userName: player.userName,
      box: box
    });
    
    rooms[room].takenBoxes.push(box);
    
    // Update lobby
    const playerCount = rooms[room].players.length;
    io.to(getRoomSockets(room)).emit('lobbyUpdate', {
      room: room,
      count: playerCount
    });
    
    socket.emit('balanceUpdate', player.balance);
    socket.emit('joinedRoom');
    
    // Start game if 2+ players
    if (playerCount >= 2 && rooms[room].status === 'waiting') {
      startGameCountdown(room);
    }
  });
  
  // Claim bingo
  socket.on('claimBingo', (data) => {
    const { room, grid, marked } = data;
    const player = players.get(socket.id);
    
    if (!player || player.currentRoom !== room) return;
    
    const prize = room * 1.8; // 80% return
    player.balance += prize;
    
    // Notify all players
    io.to(getRoomSockets(room)).emit('gameOver', {
      room: room,
      winnerId: socket.id,
      winnerName: player.userName,
      prize: prize
    });
    
    socket.emit('balanceUpdate', player.balance);
    resetRoom(room);
  });
  
  // Refresh balance
  socket.on('refreshBalance', () => {
    const player = players.get(socket.id);
    if (player) {
      socket.emit('balanceUpdate', player.balance);
    }
  });
  
  // Admin authentication
  socket.on('admin:auth', (password) => {
    if (password === ADMIN_PASSWORD) {
      socket.emit('admin:authSuccess');
    } else {
      socket.emit('admin:authError', 'Invalid password');
    }
  });
  
  // Admin get data
  socket.on('admin:getData', () => {
    const totalPlayers = players.size;
    const activeGames = Object.values(rooms).filter(r => r.status === 'playing').length;
    
    socket.emit('admin:update', {
      totalPlayers,
      activeGames,
      houseBalance: 0,
      totalWagered: 0
    });
    
    socket.emit('admin:players', Array.from(players.values()));
    socket.emit('admin:rooms', rooms);
  });
  
  // Admin add funds
  socket.on('admin:addFunds', (data) => {
    const { playerId, amount } = data;
    
    // Find player by socket ID
    const player = players.get(playerId);
    if (player) {
      player.balance += parseFloat(amount);
      io.to(playerId).emit('balanceUpdate', player.balance);
      socket.emit('admin:success', `Added ${amount} ETB to player`);
    }
  });
  
  // Disconnect
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    const player = players.get(socket.id);
    
    if (player && player.currentRoom) {
      const room = rooms[player.currentRoom];
      if (room) {
        room.players = room.players.filter(p => p.socketId !== socket.id);
        room.takenBoxes = room.takenBoxes.filter(b => b !== player.box);
        
        io.to(getRoomSockets(player.currentRoom)).emit('lobbyUpdate', {
          room: player.currentRoom,
          count: room.players.length
        });
        
        if (room.players.length === 0) {
          resetRoom(player.currentRoom);
        }
      }
    }
    
    players.delete(socket.id);
  });
});

// Helper functions
function getRoomSockets(room) {
  if (!rooms[room]) return [];
  return rooms[room].players.map(p => p.socketId);
}

function startGameCountdown(room) {
  rooms[room].status = 'countdown';
  let countdown = 10;
  
  const interval = setInterval(() => {
    io.to(getRoomSockets(room)).emit('gameCountdown', {
      room: room,
      timer: countdown
    });
    
    countdown--;
    
    if (countdown < 0) {
      clearInterval(interval);
      startGame(room);
    }
  }, 1000);
}

function startGame(room) {
  rooms[room].status = 'playing';
  
  // Start drawing balls
  let ballCount = 0;
  const drawInterval = setInterval(() => {
    if (ballCount >= 20 || rooms[room].players.length < 2) {
      clearInterval(drawInterval);
      endGameNoWinner(room);
      return;
    }
    
    const ball = Math.floor(Math.random() * 75) + 1;
    rooms[room].calledNumbers.push(ball);
    
    io.to(getRoomSockets(room)).emit('ballDrawn', {
      room: room,
      num: ball
    });
    
    ballCount++;
  }, 5000);
}

function endGameNoWinner(room) {
  io.to(getRoomSockets(room)).emit('gameOver', {
    room: room,
    winnerId: 'HOUSE',
    winnerName: 'House',
    prize: 0
  });
  
  resetRoom(room);
}

function resetRoom(room) {
  rooms[room].players = [];
  rooms[room].takenBoxes = [];
  rooms[room].status = 'waiting';
  rooms[room].calledNumbers = [];
}

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📊 Game rooms: 10, 20, 50, 100 ETB`);
  console.log(`🔐 Admin password: ${ADMIN_PASSWORD}`);
});
