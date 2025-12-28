const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// Game State
const players = new Map();
const rooms = {
    25: { players: [], balls: [], interval: null, gameId: null },
    50: { players: [], balls: [], interval: null, gameId: null },
    100: { players: [], balls: [], interval: null, gameId: null },
    200: { players: [], balls: [], interval: null, gameId: null }
};

const ADMIN_PASSWORD = "your_admin_password_here"; // Keep this synced with your admin login

io.on('connection', (socket) => {
    // 1. Initial Auth
    socket.on('auth', (data) => {
        players.set(socket.id, {
            socketId: socket.id,
            tgId: data.tgId,
            userName: data.userName,
            balance: 100.00, // Default for new, should link to DB in production
            currentRoom: null,
            box: null
        });
        socket.emit('init', { balance: players.get(socket.id).balance });
        broadcastStats();
    });

    // 2. Admin Logic (Supports your Admin panel.html)
    socket.on('adminLogin', (pass) => {
        if (pass === ADMIN_PASSWORD) {
            socket.emit('adminAuthSuccess');
            broadcastStats();
        } else {
            socket.emit('adminAuthFailure');
        }
    });

    socket.on('addFunds', (data) => {
        const target = players.get(data.socketId);
        if (target) {
            target.balance += parseFloat(data.amount);
            io.to(data.socketId).emit('fundsAdded', { 
                amount: data.amount, 
                newBalance: target.balance 
            });
            broadcastStats();
        }
    });

    socket.on('banPlayer', (socketId) => {
        io.to(socketId).emit('banned');
        players.delete(socketId);
        broadcastStats();
    });

    // 3. Game Logic (Fixed Problems 2 & 3)
    socket.on('joinRoom', (data) => {
        const player = players.get(socket.id);
        const room = rooms[data.stake];

        // Problem 3 Fix: Server-side validation for race conditions
        if (!player || player.balance < data.stake || player.currentRoom) return;

        player.balance -= data.stake;
        player.currentRoom = data.stake;
        player.box = data.box;
        room.players.push(socket.id);

        socket.emit('balanceRefreshed', player.balance);
        
        if (room.players.length === 1) {
            socket.emit('waiting', { count: 1 });
        } else if (room.players.length === 2) {
            startBingoGame(data.stake);
        }
        broadcastStats();
    });

    socket.on('claimBingo', (data) => {
        const room = rooms[data.room];
        if (room && room.gameId) {
            endGame(data.room, socket.id);
        }
    });

    socket.on('disconnect', () => {
        players.delete(socket.id);
        // Logic to remove from rooms if game not started...
        broadcastStats();
    });
});

function startBingoGame(stake) {
    const room = rooms[stake];
    // Problem 2 Fix: Generate a unique Game ID to serve as a seed component
    room.gameId = Date.now() + Math.floor(Math.random() * 1000);
    room.balls = [];
    
    io.to(room.players).emit('gameStart', { 
        gameId: room.gameId, 
        stake: stake 
    });

    let countdown = 5;
    room.interval = setInterval(() => {
        if (countdown > 0) {
            io.to(room.players).emit('timer', { seconds: countdown });
            countdown--;
        } else {
            drawBall(stake);
            countdown = 5;
        }
    }, 1000);
}

function drawBall(stake) {
    const room = rooms[stake];
    let num;
    do {
        num = Math.floor(Math.random() * 75) + 1;
    } while (room.balls.includes(num));
    
    room.balls.push(num);
    io.to(room.players).emit('nextBall', { number: num });
    
    if (room.balls.length >= 75) endGame(stake, null);
}

function endGame(stake, winnerId) {
    const room = rooms[stake];
    clearInterval(room.interval);
    
    let winnerName = "";
    const prize = stake * 1.8; // House takes 10% from each (2 stake * 0.9)

    if (winnerId) {
        const winner = players.get(winnerId);
        winner.balance += prize;
        winnerName = winner.userName;
    }

    io.to(room.players).emit('gameOver', {
        winner: winnerId,
        winnerName: winnerName,
        prize: prize
    });

    // Reset Room & Players
    room.players.forEach(pid => {
        const p = players.get(pid);
        if (p) {
            p.currentRoom = null;
            p.box = null;
            io.to(pid).emit('balanceRefreshed', p.balance);
        }
    });
    room.players = [];
    room.balls = [];
    room.gameId = null;
    broadcastStats();
}

function broadcastStats() {
    const stats = {
        online: players.size,
        activeGames: Object.values(rooms).filter(r => r.players.length > 0).length,
        players: Array.from(players.values())
    };
    io.emit('adminStats', stats);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
