const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*", // Allow connections from your HTML file
        methods: ["GET", "POST"]
    }
});

// --- STATE MANAGEMENT ---
// In a real app, use a Database (MongoDB/PostgreSQL). 
// For this single file, we use memory.
let users = {}; // userId -> { socketId, balance, name, room }
let rooms = {}; // roomValue -> { players: [], gameState: 'waiting', timer: null, calledNumbers: Set(), drawnHistory: [] }
const BANNED_USERS = new Set(); 
const ADMIN_SECRET = "admin_secret"; // <--- CHANGE THIS PASSWORD FOR SECURITY

// Helper to init room
function getRoom(roomVal) {
    if (!rooms[roomVal]) {
        rooms[roomVal] = {
            players: [],
            gameState: 'waiting', // waiting, playing
            timer: null,
            calledNumbers: new Set(),
            drawnHistory: [],
            pot: 0
        };
    }
    return rooms[roomVal];
}

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // 1. INITIAL SETUP
    // ----------------
    // Give user a starting balance for testing
    let currentUser = {
        id: socket.id,
        balance: 1000.00, // Default starting money
        name: "Guest",
        room: null
    };
    users[socket.id] = currentUser;
    
    // Send initial balance
    socket.emit('balanceUpdate', currentUser.balance);

    // 2. GAME EVENTS
    // --------------

    socket.on('getTakenBoxes', ({ room }, callback) => {
        const r = getRoom(room);
        // Return list of 'box' numbers taken by players in this room
        const taken = r.players.map(p => p.box).filter(b => b !== undefined);
        callback(taken);
    });

    socket.on('joinRoom', ({ room, box, userName }) => {
        if(BANNED_USERS.has(userName) || BANNED_USERS.has(socket.id)) {
            socket.emit('error', 'You are banned.');
            socket.disconnect();
            return;
        }

        const r = getRoom(room);
        
        // Deduct Stake
        if(currentUser.balance < room) {
            socket.emit('error', 'Insufficient funds');
            return;
        }
        currentUser.balance -= room;
        currentUser.name = userName;
        currentUser.room = room;
        
        // Add to room
        socket.join(`room_${room}`);
        r.players.push({ id: socket.id, name: userName, box: box });
        r.pot += room;

        // Notify client of new balance
        socket.emit('balanceUpdate', currentUser.balance);

        // Broadcast Lobby Status
        io.to(`room_${room}`).emit('lobbyUpdate', { room: room, count: r.players.length });

        // Check if we can start (min 2 players)
        if(r.players.length >= 2 && r.gameState === 'waiting') {
            startGameCountdown(room);
        }
    });

    socket.on('claimBingo', ({ room, grid, marked }) => {
        const r = rooms[room];
        if(!r || r.gameState !== 'playing') return;

        // Validate Bingo (Simple check: is it in current game?)
        // In production, you must validate the grid logic server-side strictly.
        
        r.gameState = 'finished';
        clearInterval(r.timer);
        
        const prize = r.pot;
        currentUser.balance += prize;
        r.pot = 0; // Reset pot

        // Notify Winner
        socket.emit('balanceUpdate', currentUser.balance);
        
        // Broadcast Game Over
        io.to(`room_${room}`).emit('gameOver', {
            room: room,
            winnerId: socket.id,
            winnerName: currentUser.name,
            prize: prize
        });

        // Reset Room after delay
        setTimeout(() => resetRoom(room), 5000);
    });

    // 3. ADMIN EVENTS (NEW!)
    // ----------------------

    socket.on('admin:auth', ({ token }) => {
        if(token === ADMIN_SECRET) {
            socket.join('admin_room');
            socket.emit('admin:authSuccess');
            // Send initial stats
            updateAdminStats();
        }
    });

    socket.on('admin:banPlayer', ({ userId, reason }) => {
        if(!socket.rooms.has('admin_room')) return;

        console.log(`Admin banning: ${userId}`);
        BANNED_USERS.add(userId);
        
        // Find the socket and kick them
        // Note: In this simple example, we assume userId passed from Admin is socket.id or username
        // In a real app, use a persistent User ID (Database ID)
        const targetSocket = io.sockets.sockets.get(userId);
        if(targetSocket) {
            targetSocket.emit('error', `You have been banned: ${reason}`);
            targetSocket.disconnect(true);
        }
    });

    socket.on('admin:refundPlayer', ({ userId, amount }) => {
        if(!socket.rooms.has('admin_room')) return;

        console.log(`Refund ${amount} to ${userId}`);
        
        // Update user balance in memory
        if(users[userId]) {
            users[userId].balance += amount;
            // Notify the user live if they are online
            const targetSocket = io.sockets.sockets.get(userId);
            if(targetSocket) {
                targetSocket.emit('balanceUpdate', users[userId].balance);
            }
        }
    });

    // --- DISCONNECT ---
    socket.on('disconnect', () => {
        if (currentUser.room) {
            const r = rooms[currentUser.room];
            if(r) {
                r.players = r.players.filter(p => p.id !== socket.id);
                io.to(`room_${currentUser.room}`).emit('lobbyUpdate', { room: currentUser.room, count: r.players.length });
            }
        }
        delete users[socket.id];
        updateAdminStats(); // Update admin dashboard
    });
});

// --- GAME LOOP HELPERS ---

function startGameCountdown(roomVal) {
    const r = rooms[roomVal];
    r.gameState = 'countdown';
    let count = 5;

    let countdownInterval = setInterval(() => {
        io.to(`room_${roomVal}`).emit('gameCountdown', { room: roomVal, timer: count });
        count--;

        if(count < 0) {
            clearInterval(countdownInterval);
            startGameLoop(roomVal);
        }
    }, 1000);
}

function startGameLoop(roomVal) {
    const r = rooms[roomVal];
    r.gameState = 'playing';
    r.calledNumbers.clear();
    
    // Ball Calling Loop
    r.timer = setInterval(() => {
        if(r.gameState !== 'playing') {
            clearInterval(r.timer);
            return;
        }

        // Pick a random number 1-75 that hasn't been called
        let num;
        do {
            num = Math.floor(Math.random() * 75) + 1;
        } while (r.calledNumbers.has(num) && r.calledNumbers.size < 75);

        if(r.calledNumbers.size >= 75) {
            // Tie / End of game
            clearInterval(r.timer);
            resetRoom(roomVal);
            return;
        }

        r.calledNumbers.add(num);
        io.to(`room_${roomVal}`).emit('ballDrawn', { room: roomVal, num: num });
    
    }, 3000); // New ball every 3 seconds
}

function resetRoom(roomVal) {
    const r = rooms[roomVal];
    if(!r) return;
    r.gameState = 'waiting';
    r.players = []; // Kick everyone out to lobby
    r.pot = 0;
    r.calledNumbers.clear();
    // In a real app, you might keep players in the room, 
    // but for this logic, we reset them to "waiting" state.
}

function updateAdminStats() {
    // Calculate total active rooms
    const activeRooms = Object.values(rooms).filter(r => r.players.length > 0).length;
    const activePlayers = Object.keys(users).length;
    
    io.to('admin_room').emit('lobbyUpdate', { room: 'global', count: activePlayers }); // Reuse event or make new one
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
