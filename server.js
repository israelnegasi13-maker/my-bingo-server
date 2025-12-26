// --- SERVER SIDE LOGIC (Node.js) ---

const rooms = {
    10: { status: 'Lobby', takenBoxes: [], ballsDrawn: [], players: [] },
    20: { status: 'Lobby', takenBoxes: [], ballsDrawn: [], players: [] },
    50: { status: 'Lobby', takenBoxes: [], ballsDrawn: [], players: [] },
    100: { status: 'Lobby', takenBoxes: [], ballsDrawn: [], players: [] }
};

io.on('connection', (socket) => {
    
    // 1. Tell player which rooms are busy
    socket.on('getRoomsStatus', () => {
        const busyRooms = Object.keys(rooms)
            .filter(r => rooms[r].status === 'Playing')
            .map(Number);
        socket.emit('roomsStatusUpdate', busyRooms);
    });

    // 2. Prevent joining if status is 'Playing'
    socket.on('joinRoom', (data) => {
        const room = rooms[data.room];
        
        if (room.status === 'Playing') {
            return socket.emit('error', 'Game already in progress');
        }

        room.players.push(socket.id);
        room.takenBoxes.push(data.box);
        
        // If this is the first player, start a countdown to lock the room
        if (room.players.length === 1) {
            startRoomCountdown(data.room);
        }
    });
});

function startRoomCountdown(roomId) {
    let countdown = 15;
    const room = rooms[roomId];
    
    const timer = setInterval(() => {
        countdown--;
        if (countdown <= 0) {
            clearInterval(timer);
            room.status = 'Playing'; // LOCK THE ROOM
            io.emit('roomsStatusUpdate', getActiveRoomList()); // Notify all users
            startGameLoop(roomId);
        }
    }, 1000);
}

function startGameLoop(roomId) {
    const room = rooms[roomId];
    const interval = setInterval(() => {
        if (room.ballsDrawn.length >= 75 || room.status === 'Lobby') {
            clearInterval(interval);
            resetRoom(roomId);
            return;
        }
        
        // Generate unique ball
        let ball;
        do { ball = Math.floor(Math.random() * 75) + 1; } 
        while (room.ballsDrawn.includes(ball));
        
        room.ballsDrawn.push(ball);
        io.to(roomId).emit('ballDrawn', { room: roomId, num: ball });
        
    }, 4000); // Draw every 4 seconds
}

function resetRoom(roomId) {
    rooms[roomId] = { status: 'Lobby', takenBoxes: [], ballsDrawn: [], players: [] };
    io.emit('roomsStatusUpdate', getActiveRoomList());
    io.emit('boxUpdate', { room: roomId, takenBoxes: [] });
}

function getActiveRoomList() {
    return Object.keys(rooms).filter(r => rooms[r].status === 'Playing').map(Number);
}
