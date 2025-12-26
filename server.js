const { createServer } = require("http");
const { Server } = require("socket.io");

const httpServer = createServer();
const io = new Server(httpServer, {
  cors: { origin: "*" }
});

// Game Configurations
const TAX_RATE = 0.10; // 10% fee
const MIN_PLAYERS = 2;
const LOBBY_TIME = 15; // seconds to wait once 2 players join

let rooms = {}; 
// Structure: rooms[stake] = { 
//   players: [{id, name, box}], 
//   status: 'lobby' | 'playing', 
//   timer: 15, 
//   drawnBalls: [],
//   interval: null 
// }

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("getRoomsStatus", () => {
    const busyRooms = Object.keys(rooms).filter(r => rooms[r].status === 'playing').map(Number);
    socket.emit("roomsStatusUpdate", busyRooms);
  });

  socket.on("joinRoom", (data) => {
    const { room, box, userName } = data; // room is the stake (10, 20, etc)

    if (!rooms[room]) {
      rooms[room] = { 
        players: [], 
        status: 'lobby', 
        timer: LOBBY_TIME, 
        drawnBalls: [],
        interval: null 
      };
    }

    if (rooms[room].status === 'playing') {
        socket.emit("error", "Arena already in session");
        return;
    }

    rooms[room].players.push({ id: socket.id, name: userName, box });
    socket.join(`room-${room}`);

    console.log(`${userName} joined ${room} ETB Arena`);

    // Notify everyone in the lobby of the new player count
    io.to(`room-${room}`).emit("lobbyUpdate", { 
      room, 
      count: rooms[room].players.length 
    });

    // Start countdown if we hit the minimum requirement
    if (rooms[room].players.length >= MIN_PLAYERS && !rooms[room].interval) {
        startLobbyCountdown(room);
    }
  });

  socket.on("claimBingo", (data) => {
    const { room, grid, marked } = data;
    const game = rooms[room];
    if (!game || game.status !== 'playing') return;

    // Server-side validation
    const isWinner = validateBingo(grid, marked, game.drawnBalls);

    if (isWinner) {
        const totalPool = room * game.players.length;
        const prize = totalPool * (1 - TAX_RATE); // Deduct 10% tax
        
        io.to(`room-${room}`).emit("gameOver", {
            room,
            winnerId: socket.id,
            winnerName: game.players.find(p => p.id === socket.id).name,
            prize: prize,
            taxDeducted: totalPool * TAX_RATE
        });

        // Clean up room
        clearInterval(game.interval);
        delete rooms[room];
        io.emit("roomsStatusUpdate", Object.keys(rooms).filter(r => rooms[r].status === 'playing').map(Number));
    }
  });

  socket.on("disconnect", () => {
    // Cleanup logic for disconnected users in lobby
    for (let r in rooms) {
      rooms[r].players = rooms[r].players.filter(p => p.id !== socket.id);
      io.to(`room-${r}`).emit("lobbyUpdate", { room: r, count: rooms[r].players.length });
    }
  });
});

function startLobbyCountdown(room) {
    const game = rooms[room];
    game.interval = setInterval(() => {
        game.timer--;
        io.to(`room-${room}`).emit("gameCountdown", { room, timer: game.timer });

        if (game.timer <= 0) {
            clearInterval(game.interval);
            startGameLoop(room);
        }
    }, 1000);
}

function startGameLoop(room) {
    const game = rooms[room];
    game.status = 'playing';
    io.emit("roomsStatusUpdate", Object.keys(rooms).filter(r => rooms[r].status === 'playing').map(Number));

    const allBalls = Array.from({length: 75}, (_, i) => i + 1);
    const shuffled = allBalls.sort(() => Math.random() - 0.5);

    game.interval = setInterval(() => {
        if (shuffled.length === 0) {
            clearInterval(game.interval);
            return;
        }
        const ball = shuffled.pop();
        game.drawnBalls.push(ball);
        io.to(`room-${room}`).emit("ballDrawn", { room, num: ball });
    }, 4000); // Draw every 4 seconds
}

function validateBingo(grid, marked, drawnBalls) {
    // 1. Ensure all marked numbers were actually drawn
    const validMarks = marked.every(num => num === 'FREE' || drawnBalls.includes(num));
    if (!validMarks) return false;

    // 2. Convert grid to 2D for pattern checking
    const rows = [];
    for (let i = 0; i < 25; i += 5) rows.push(grid.slice(i, i + 5));

    // Check rows
    for (let row of rows) {
        if (row.every(cell => marked.includes(cell))) return true;
    }

    // Check columns
    for (let col = 0; col < 5; col++) {
        let count = 0;
        for (let row = 0; row < 5; row++) {
            if (marked.includes(rows[row][col])) count++;
        }
        if (count === 5) return true;
    }

    // Check diagonals
    const diag1 = [rows[0][0], rows[1][1], rows[2][2], rows[3][3], rows[4][4]];
    const diag2 = [rows[0][4], rows[1][3], rows[2][2], rows[3][1], rows[4][0]];
    if (diag1.every(cell => marked.includes(cell))) return true;
    if (diag2.every(cell => marked.includes(cell))) return true;

    return false;
}

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => console.log(`Server running on port ${PORT}`));
