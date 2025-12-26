const express = require("express");
const { createServer } = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());

// Basic health check endpoint for hosting providers
app.get("/", (req, res) => {
  res.send("Bingo Elite Server is Running");
});

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Game Configurations
const TAX_RATE = 0.10; // 10% House Fee
const MIN_PLAYERS = 2;
const LOBBY_TIME = 15; // Seconds to wait once 2 players join

let rooms = {}; 

io.on("connection", (socket) => {
  console.log("New Connection:", socket.id);

  // Send list of active game stakes to client
  socket.on("getRoomsStatus", () => {
    const activeRooms = Object.keys(rooms)
      .filter(r => rooms[r].status === 'playing')
      .map(Number);
    socket.emit("roomsStatusUpdate", activeRooms);
  });

  // Client requests taken boxes for a specific stake
  socket.on("getTakenBoxes", (data, callback) => {
    const { room } = data;
    if (rooms[room]) {
      const taken = rooms[room].players.map(p => p.box);
      callback(taken);
    } else {
      callback([]);
    }
  });

  socket.on("joinRoom", (data) => {
    const { room, box, userName } = data;

    if (!rooms[room]) {
      rooms[room] = { 
        players: [], 
        status: 'lobby', 
        timer: LOBBY_TIME, 
        drawnBalls: [],
        interval: null 
      };
    }

    const game = rooms[room];

    if (game.status === 'playing') {
      socket.emit("error", "Arena already in session");
      return;
    }

    // Add player to memory
    game.players.push({ id: socket.id, name: userName, box });
    socket.join(`room-${room}`);

    console.log(`${userName} joined ${room} ETB Arena with Box ${box}`);

    // Update everyone in the room about the new player count
    io.to(`room-${room}`).emit("lobbyUpdate", { 
      room, 
      count: game.players.length 
    });

    // Start countdown if minimum players reached
    if (game.players.length >= MIN_PLAYERS && !game.interval) {
      startLobbyCountdown(room);
    }
  });

  socket.on("claimBingo", (data) => {
    const { room, grid, marked } = data;
    const game = rooms[room];
    
    if (!game || game.status !== 'playing') return;

    // Validate if the player actually has a winning pattern
    const isWinner = validateBingo(grid, marked, game.drawnBalls);

    if (isWinner) {
      const totalPool = room * game.players.length;
      const prize = totalPool * (1 - TAX_RATE); // Deduct 10%
      
      io.to(`room-${room}`).emit("gameOver", {
        room,
        winnerId: socket.id,
        winnerName: game.players.find(p => p.id === socket.id).name,
        prize: prize,
        taxDeducted: totalPool * TAX_RATE
      });

      // Reset the room for the next round
      clearInterval(game.interval);
      delete rooms[room];
      
      // Update global room status for the stake selection screen
      io.emit("roomsStatusUpdate", Object.keys(rooms).filter(r => rooms[r].status === 'playing').map(Number));
    }
  });

  socket.on("disconnect", () => {
    for (let r in rooms) {
      const game = rooms[r];
      const playerIndex = game.players.findIndex(p => p.id === socket.id);
      
      if (playerIndex !== -1) {
        game.players.splice(playerIndex, 1);
        
        // If room is empty and in lobby, delete it
        if (game.players.length === 0 && game.status === 'lobby') {
          clearInterval(game.interval);
          delete rooms[r];
        } else {
          io.to(`room-${r}`).emit("lobbyUpdate", { room: r, count: game.players.length });
        }
      }
    }
    console.log("Disconnected:", socket.id);
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
  
  // Update stakes screen to show this room is now "Busy"
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
  }, 4000); // New ball every 4 seconds
}

function validateBingo(grid, marked, drawnBalls) {
  // 1. Cross-reference marked numbers with actual drawn balls
  const validMarks = marked.every(num => num === 'FREE' || drawnBalls.includes(num));
  if (!validMarks) return false;

  const rows = [];
  for (let i = 0; i < 25; i += 5) rows.push(grid.slice(i, i + 5));

  // Rows check
  for (let row of rows) {
    if (row.every(cell => marked.includes(cell))) return true;
  }

  // Columns check
  for (let col = 0; col < 5; col++) {
    let count = 0;
    for (let row = 0; row < 5; row++) {
      if (marked.includes(rows[row][col])) count++;
    }
    if (count === 5) return true;
  }

  // Diagonals check
  const d1 = [rows[0][0], rows[1][1], rows[2][2], rows[3][3], rows[4][4]];
  const d2 = [rows[0][4], rows[1][3], rows[2][2], rows[3][1], rows[4][0]];
  if (d1.every(cell => marked.includes(cell)) || d2.every(cell => marked.includes(cell))) return true;

  return false;
}

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
