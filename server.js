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

// Game State Management
let rooms = {
  "10": { players: {}, status: 'waiting', drawnBalls: [] },
  "20": { players: {}, status: 'waiting', drawnBalls: [] },
  "50": { players: {}, status: 'waiting', drawnBalls: [] },
  "100": { players: {}, status: 'waiting', drawnBalls: [] }
};

// 2. Main Socket Connection
io.on('connection', (socket) => {
  console.log('New connection:', socket.id);

  // --- ADMIN AUTHENTICATION ---
  socket.on('admin:auth', (password) => {
    if (password === "YOUR_SECRET_ADMIN_PASSWORD") { 
      socket.isAdmin = true;
      socket.emit('admin:authSuccess');
      syncAdminData();
    } else {
      socket.emit('admin:authError', "Invalid Password");
    }
  });

  // --- PLAYER INITIALIZATION ---
  socket.on('init', async (data) => {
    const userId = data.userId || socket.id;
    const userRef = db.ref(`players/${userId}`);
    
    let snapshot = await userRef.get();
    let userData;

    if (!snapshot.exists()) {
      userData = {
        userId: userId,
        userName: data.userName || "Guest",
        balance: 0.00,
        socketId: socket.id,
        isBanned: false
      };
      await userRef.set(userData);
    } else {
      userData = snapshot.val();
      if (userData.isBanned) return socket.emit('banned');
      await userRef.update({ socketId: socket.id });
    }

    socket.userId = userId;
    socket.emit('balanceUpdate', userData.balance);
    syncAdminData();
  });

  // --- ADMIN ACTIONS (ADD FUNDS / BAN) ---
  socket.on('admin:addFunds', async (data) => {
    if (!socket.isAdmin) return;
    const userRef = db.ref(`players/${data.playerId}`);
    
    await userRef.transaction((current) => {
      if (current) {
        current.balance = (parseFloat(current.balance) || 0) + parseFloat(data.amount);
      }
      return current;
    });

    const updated = (await userRef.get()).val();
    // Notify the player immediately if they are online
    io.to(updated.socketId).emit('balanceUpdate', updated.balance);
    syncAdminData();
  });

  // --- GAMEPLAY: JOINING A ROOM ---
  socket.on('joinRoom', async (data) => {
    const { room, box, userName } = data;
    const userRef = db.ref(`players/${socket.userId}`);
    const snap = await userRef.get();
    const user = snap.val();

    if (user.balance < parseFloat(room)) {
      return socket.emit('insufficientFunds');
    }

    // Deduct from Firebase
    const newBalance = user.balance - parseFloat(room);
    await userRef.update({ balance: newBalance });

    // Join Socket Room
    rooms[room].players[socket.id] = { userId: socket.userId, userName, box };
    socket.join(`room_${room}`);

    socket.emit('balanceUpdate', newBalance);
    io.to(`room_${room}`).emit('lobbyUpdate', { 
        room, 
        count: Object.keys(rooms[room].players).length 
    });

    syncAdminData();
  });

  socket.on('disconnect', () => {
    // Cleanup: Remove from rooms
    for (let r in rooms) {
      if (rooms[r].players[socket.id]) {
        delete rooms[r].players[socket.id];
        io.to(`room_${r}`).emit('lobbyUpdate', { room: r, count: Object.keys(rooms[r].players).length });
      }
    }
    syncAdminData();
  });
});

// Helper to push updates to Admin Panel
async function syncAdminData() {
  const playersSnap = await db.ref('players').get();
  const players = [];
  playersSnap.forEach(snap => { players.push(snap.val()); });
  
  io.emit('admin:players', players);
  io.emit('admin:update', {
    totalPlayers: players.length,
    activeGames: Object.values(rooms).filter(r => r.status === 'playing').length
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
