const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

/* ===============================
   GLOBAL STATE
================================= */

const players = new Map();     // socket.id -> { id, name, balance }
const bannedIPs = new Set();   // banned IP addresses

/* ===============================
   SOCKET HANDLER
================================= */

io.on("connection", (socket) => {

    const ip = socket.handshake.address;

    /* ---- BAN CHECK ---- */
    if (bannedIPs.has(ip)) {
        socket.disconnect(true);
        return;
    }

    /* ---- ROLE ---- */
    const isAdmin = socket.handshake.auth?.role === "admin";

    /* ---- REGISTER PLAYER ---- */
    if (!isAdmin) {
        const userName =
            socket.handshake.auth?.name ||
            socket.handshake.query?.name ||
            "PLAYER";

        players.set(socket.id, {
            id: socket.id,
            name: userName,
            balance: 0
        });

        socket.emit("balanceUpdate", 0);
        updateAdmins();
    }

    /* ===============================
       GAME EVENTS (EXISTING)
       Your current game logic stays
       exactly the same below this
    ================================= */

    socket.on("disconnect", () => {
        players.delete(socket.id);
        updateAdmins();
    });

    /* ===============================
       ADMIN EVENTS
    ================================= */

    if (isAdmin) {
        socket.emit("admin:players", Array.from(players.values()));
    }

    socket.on("admin:addFunds", ({ playerId, amount }) => {
        if (!isAdmin) return;

        const p = players.get(playerId);
        if (!p || amount <= 0) return;

        p.balance += amount;

        io.to(playerId).emit("balanceUpdate", p.balance);
        updateAdmins();
    });

    socket.on("admin:banPlayer", ({ playerId }) => {
        if (!isAdmin) return;

        const target = io.sockets.sockets.get(playerId);
        if (!target) return;

        bannedIPs.add(target.handshake.address);
        target.disconnect(true);

        players.delete(playerId);
        updateAdmins();
    });

});

/* ===============================
   ADMIN UPDATE HELPER
================================= */

function updateAdmins() {
    io.emit("admin:players", Array.from(players.values()));
}

/* ===============================
   SERVER START
================================= */

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Bingo Elite Server running on port ${PORT}`);
});
