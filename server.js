const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// --- GAME STATE ---
const ADMIN_SECRET = "ELITE_PRO_ADMIN";
const players = {}; // stores player data by socket.id
const rooms = {
    "10": { players: new Set(), balls: [], gameStarted: false },
    "50": { players: new Set(), balls: [], gameStarted: false },
    "100": { players: new Set(), balls: [], gameStarted: false }
};

// --- HELPER FUNCTIONS ---

/**
 * Sends a structured data packet to all authenticated admins.
 * This matches the expected format in the admin_panel.html (Canvas).
 */
function sendAdminUpdate() {
    const playerArray = Object.values(players).map(p => ({
        id: p.id,
        name: p.name || 'Anonymous',
        balance: p.balance || 0,
        banned: p.banned || false
    }));

    const activeLobbies = Object.keys(rooms).filter(key => rooms[key].players.size > 0).length;

    const stats = {
        playerCount: playerArray.length,
        lobbyCount: activeLobbies,
        players: playerArray
    };

    io.to('admin_room').emit('admin_update_data', stats);
}

// --- SOCKET LOGIC ---

io.on('connection', (socket) => {
    console.log(`New connection: ${socket.id}`);

    // Standard player registration
    socket.on('register_player', (data) => {
        players[socket.id] = {
            id: socket.id,
            name: data.name || 'New Player',
            balance: 100, // Default starting balance
            banned: false
        };
        console.log(`Player Registered: ${players[socket.id].name}`);
        sendAdminUpdate();
    });

    // --- ADMIN PROTOCOLS ---

    // Admin Handshake
    socket.on('admin_login', (data) => {
        if (data.secret === ADMIN_SECRET) {
            socket.isAdmin = true;
            socket.join('admin_room');
            console.log(`Admin Authenticated: ${socket.id}`);
            sendAdminUpdate();
        } else {
            socket.emit('admin_error', 'Invalid Secret Key');
        }
    });

    // Manual data request from admin
    socket.on('admin_request_stats', () => {
        if (socket.isAdmin) sendAdminUpdate();
    });

    // Update player balance from admin
    socket.on('admin_update_balance', (data) => {
        if (socket.isAdmin) {
            const { targetId, amount } = data;
            if (players[targetId]) {
                players[targetId].balance += amount;
                // Notify the player of their new balance
                io.to(targetId).emit('update_balance', players[targetId].balance);
                sendAdminUpdate();
            }
        }
    });

    // Ban/Unban player from admin
    socket.on('admin_ban_player', (data) => {
        if (socket.isAdmin) {
            const { targetId } = data;
            if (players[targetId]) {
                players[targetId].banned = !players[targetId].banned;
                if (players[targetId].banned) {
                    io.to(targetId).emit('banned_notification', 'Your account has been restricted by an admin.');
                }
                sendAdminUpdate();
            }
        }
    });

    // --- CLEANUP ---
    socket.on('disconnect', () => {
        if (players[socket.id]) {
            console.log(`Player Disconnected: ${players[socket.id].name}`);
            delete players[socket.id];
        }
        sendAdminUpdate();
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Bingo Server running on port ${PORT}`);
});
