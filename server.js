const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*", // In production, replace with your client URL
        methods: ["GET", "POST"]
    }
});

// Game State
let gameState = {
    isGameActive: false,
    ballsDrawn: [],
    players: new Map(), // userId -> { socketId, username, balance, stake, card, marked }
    currentBallInterval: null,
    drawSpeed: 5000, // 5 seconds per ball
    maxBalls: 75
};

io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    // Handle User Joining from Client
    socket.on('join', (data) => {
        const userId = data.user?.id || socket.id;
        const username = data.user?.first_name || "Guest";

        gameState.players.set(userId, {
            socketId: socket.id,
            username: username,
            balance: 1000.0, // Should be fetched from DB in production
            stake: 0,
            card: [],
            marked: []
        });

        // Send current game status to the newcomer
        socket.emit('roomUpdate', {
            isGameActive: gameState.isGameActive,
            history: gameState.ballsDrawn
        });

        console.log(`${username} joined the lobby.`);
        updateAdminStats();
    });

    // Handle Stake Placement
    socket.on('placeStake', (data) => {
        const player = Array.from(gameState.players.values()).find(p => p.socketId === socket.id);
        if (player) {
            player.stake = data.amount;
            player.card = data.card;
            console.log(`${player.username} staked ${data.amount} and received a card.`);
            updateAdminStats();
        }
    });

    // Handle Admin: Start Game
    socket.on('adminStartGame', () => {
        if (gameState.isGameActive) return;

        gameState.isGameActive = true;
        gameState.ballsDrawn = [];
        
        io.emit('gameReset'); // Clear client screens
        io.emit('log', { message: "Game Started!", type: "success" });

        gameState.currentBallInterval = setInterval(() => {
            if (gameState.ballsDrawn.length >= gameState.maxBalls) {
                stopGame("Draw Limit Reached");
                return;
            }

            let newBall;
            do {
                newBall = Math.floor(Math.random() * 75) + 1;
            } while (gameState.ballsDrawn.includes(newBall));

            gameState.ballsDrawn.push(newBall);
            io.emit('ballDrawn', newBall);
            updateAdminStats();

        }, gameState.drawSpeed);
    });

    // Handle Admin: Stop/Reset Game
    socket.on('adminStopGame', () => {
        stopGame("Admin terminated the session");
    });

    // Handle Bingo Claim
    socket.on('claimBingo', (data) => {
        const player = Array.from(gameState.players.values()).find(p => p.socketId === socket.id);
        if (!player) return;

        // SERVER-SIDE VALIDATION
        // 1. Verify all marked numbers were actually drawn
        const isValidMarking = data.marked.every(num => 
            num === "FREE" || gameState.ballsDrawn.includes(num)
        );

        // 2. Verify all marked numbers are on the player's card
        const isOwnCard = data.marked.every(num => 
            num === "FREE" || player.card.includes(num)
        );

        if (isValidMarking && isOwnCard) {
            io.emit('gameWinner', { 
                username: player.username, 
                prize: player.stake * 10 // Example multiplier
            });
            stopGame(`Winner: ${player.username}`);
        } else {
            socket.emit('log', { message: "Invalid Bingo Claim!", type: "error" });
        }
    });

    socket.on('disconnect', () => {
        // Find and remove player
        for (let [userId, player] of gameState.players) {
            if (player.socketId === socket.id) {
                gameState.players.delete(userId);
                break;
            }
        }
        updateAdminStats();
    });
});

function stopGame(reason) {
    clearInterval(gameState.currentBallInterval);
    gameState.isGameActive = false;
    io.emit('gameEnded', { reason });
    io.emit('log', { message: `Game Over: ${reason}`, type: "info" });
}

function updateAdminStats() {
    const stats = {
        onlinePlayers: gameState.players.size,
        activeStakes: Array.from(gameState.players.values()).filter(p => p.stake > 0).length,
        totalPool: Array.from(gameState.players.values()).reduce((sum, p) => sum + p.stake, 0),
        ballsDrawnCount: gameState.ballsDrawn.length
    };
    io.emit('adminStatsUpdate', stats);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Bingo Server running on port ${PORT}`);
});
