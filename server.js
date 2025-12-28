const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const admin = require('firebase-admin');
const cors = require('cors');

// 1. Initialize Firebase
const serviceAccount = require("./service-account-key.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://bingo-elite-default-rtdb.firebaseio.com/"
});

const db = admin.database();
const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// Game Rooms State
let rooms = {
  "10": { players: {}, status: 'waiting', drawnBalls: [], timer: null },
  "20": { players: {}, status: 'waiting', drawnBalls: [], timer: null },
  "50": { players: {}, status: 'waiting', drawnBalls: [], timer: null },
  "100": { players: {}, status: 'waiting', drawnBalls: [], timer: null }
};

// --- HELPER: SYNC ADMIN PANEL ---
async function syncAdmin() {
  const playersSnap = await db.ref('players').get();
  const players = [];
  playersSnap.forEach(snap => { players.push(snap.val()); });
  
  io.emit('admin:players', players); // Send list to Admin Panel
  io.emit('admin:update', {
    totalPlayers: players.length,
    activeGames: Object.values(rooms).filter(r => r.status === 'playing').length
  });
}

// 2. Socket Connection
io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  // --- ADMIN LOGIN ---
  socket.on('admin:auth', (password) => {
    if (password === "YOUR_PASSWORD") { // SET YOUR PASSWORD HERE
      socket.isAdmin = true;
      socket.emit('admin:authSuccess');
      syncAdmin();
    }
  });

  // --- PLAYER INITIALIZATION ---
  socket.on('init', async (data) => {
    const userId = data.userId || socket.id;
    const userRef = db.ref(`players/${userId}`);
    let snapshot = await userRef.get();
    
    let userData = snapshot.exists() ? snapshot.val() : {
      userId, userName: data.userName || "Player", balance: 0, isBanned: false
    };

    userData.socketId = socket.id; // Update current socket
    await userRef.set(userData);
    
    socket.userId = userId;
    socket.emit('balanceUpdate', userData.balance);
    syncAdmin();
  });

  // --- ADMIN: ADD FUNDS ---
  socket.on('admin:addFunds', async (data) => {
    if (!socket.isAdmin) return;
    const { playerId, amount } = data; // playerId here is the socketId from Admin Panel
    
    // Find user by socketId in Firebase
    const playersRef = db.ref('players');
    const snap = await playersRef.orderByChild('socketId').equalTo(playerId).once('value');
    
    if (snap.exists()) {
      const uid = Object.keys(snap.val())[0];
      const userRef = db.ref(`players/${uid}`);
      
      await userRef.transaction(user => {
        if (user) user.balance = (parseFloat(user.balance) || 0) + parseFloat(amount);
        return user;
      });

      const updated = (await userRef.get()).val();
      // Send to Game Client (matches your HTML event name)
      io.to(updated.socketId).emit('fundsAdded', { amount, newBalance: updated.balance });
      io.to(updated.socketId).emit('balanceUpdate', updated.balance);
      syncAdmin();
    }
  });

  // --- GAME LOGIC: JOIN ROOM ---
  socket.on('joinRoom', async (data) => {
    const { room, box, userName } = data;
    const userRef = db.ref(`players/${socket.userId}`);
    const user = (await userRef.get()).val();

    if (user.balance < parseFloat(room)) {
      return socket.emit('insufficientFunds');
    }

    const newBalance = user.balance - parseFloat(room);
    await userRef.update({ balance: newBalance });

    rooms[room].players[socket.id] = { userId: socket.userId, userName, box };
    socket.join(`room_${room}`);

    socket.emit('balanceUpdate', newBalance);
    io.to(`room_${room}`).emit('lobbyUpdate', { room, count: Object.keys(rooms[room].players).length });

    // Start Game if 2 or more players
    if (Object.keys(rooms[room].players).length >= 2 && rooms[room].status === 'waiting') {
      startBingoGame(room);
    }
    syncAdmin();
  });

  socket.on('disconnect', () => {
    for (let r in rooms) {
      if (rooms[r].players[socket.id]) {
        delete rooms[r].players[socket.id];
        io.to(`room_${r}`).emit('lobbyUpdate', { room: r, count: Object.keys(rooms[r].players).length });
      }
    }
    syncAdmin();
  });
});

// --- BINGO ENGINE ---
function startBingoGame(room) {
  rooms[room].status = 'starting';
  let countdown = 10;
  
  const timer = setInterval(() => {
    io.to(`room_${room}`).emit('gameCountdown', { room, timer: countdown });
    countdown--;

    if (countdown < 0) {
      clearInterval(timer);
      rooms[room].status = 'playing';
      rooms[room].drawnBalls = [];
      runBallDrawer(room);
    }
  }, 1000);
}

function runBallDrawer(room) {
  const ballInterval = setInterval(() => {
    if (!rooms[room] || rooms[room].status !== 'playing') {
      clearInterval(ballInterval);
      return;
    }

    let ball;
    do { ball = Math.floor(Math.random() * 75) + 1; } 
    while (rooms[room].drawnBalls.includes(ball));

    rooms[room].drawnBalls.push(ball);
    io.to(`room_${room}`).emit('ballDrawn', { room, num: ball });

    if (rooms[room].drawnBalls.length >= 75) clearInterval(ballInterval);
  }, 4000);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
