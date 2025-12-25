const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    cors: { origin: "*" } // Allows connections from any website
});

// IMPORTANT: Render will provide the PORT automatically
const PORT = process.env.PORT || 3000;

let state = {
    isGameActive: false,
    players: {},
    calledNumbers: [],
    callTimer: null,
    countdownRunning: false
};

// CONFIGURATION: Set this to 100 for your big game
const MIN_PLAYERS_TO_START = 2; 
const COUNTDOWN_SECONDS = 10;

io.on('connection', (socket) => {
    console.log('New player connected:', socket.id);

    socket.on('joinGame', (userData) => {
        if (state.isGameActive) {
            socket.emit('errorMsg', 'A game is already in progress. Please wait.');
            return;
        }

        state.players[socket.id] = {
            id: socket.id,
            name: "Player " + socket.id.substr(0,4),
            stake: userData.stake || 10
        };

        io.emit('updatePlayerCount', { count: Object.keys(state.players).length });
        checkStartCondition();
    });

    socket.on('disconnect', () => {
        delete state.players[socket.id];
        io.emit('updatePlayerCount', { count: Object.keys(state.players).length });
    });

    socket.on('declareBingo', () => {
        if (!state.isGameActive) return;
        const winner = state.players[socket.id];
        const prize = Object.keys(state.players).length * (winner ? winner.stake : 10);
        
        io.emit('gameOver', { 
            winnerName: winner ? winner.name : "Someone", 
            prize: prize, 
            winnerId: socket.id 
        });
        resetGame();
    });
});

function checkStartCondition() {
    const count = Object.keys(state.players).length;
    if (count >= MIN_PLAYERS_TO_START && !state.countdownRunning) {
        state.countdownRunning = true;
        let timeLeft = COUNTDOWN_SECONDS;
        const timer = setInterval(() => {
            io.emit('gameCountdown', timeLeft);
            timeLeft--;
            if (timeLeft < 0) {
                clearInterval(timer);
                startGame();
            }
        }, 1000);
    }
}

function startGame() {
    state.isGameActive = true;
    state.calledNumbers = [];
    state.countdownRunning = false;
    io.emit('gameStart', { totalPrize: Object.keys(state.players).length * 100 });
    callNextNumber();
}

function callNextNumber() {
    if (!state.isGameActive) return;
    if (state.calledNumbers.length >= 75) {
        resetGame();
        return;
    }

    let num;
    do { num = Math.floor(Math.random() * 75) + 1; } 
    while (state.calledNumbers.includes(num));

    state.calledNumbers.push(num);
    io.emit('numberCalled', num);
    state.callTimer = setTimeout(callNextNumber, 4000); // 4 seconds between numbers
}

function resetGame() {
    state.isGameActive = false;
    state.calledNumbers = [];
    state.countdownRunning = false;
    if (state.callTimer) clearTimeout(state.callTimer);
}

// Start the server
http.listen(PORT, () => {
    console.log(`Bingo Server is running on port ${PORT}`);
});
