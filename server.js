// Add at the top of server.js (after other requires)
const connectDB = require('./db');
const { User, Room, Transaction, Stats } = require('./models');

// Connect to MongoDB at the start
connectDB();

// ========== UPDATED HELPER FUNCTIONS FOR MONGODB ==========

// Get or create user with MongoDB
async function getUser(userId, userName) {
    try {
        let user = await User.findOne({ userId: userId });
        
        if (!user) {
            user = new User({
                userId: userId,
                userName: userName || 'Guest',
                balance: CONFIG.INITIAL_BALANCE,
                referralCode: generateReferralCode(userId)
            });
            await user.save();
            
            // Update daily stats
            await updateDailyStats('newUsers', 1);
        } else {
            user.lastSeen = new Date();
            user.sessionCount = (user.sessionCount || 0) + 1;
            user.isOnline = true;
            
            if (userName && user.userName !== userName) {
                user.userName = userName;
            }
            
            await user.save();
        }
        
        return user;
    } catch (error) {
        console.error('Error getting user:', error);
        return null;
    }
}

// Update user balance
async function updateUserBalance(userId, amount) {
    try {
        const user = await User.findOne({ userId: userId });
        if (user) {
            user.balance += amount;
            await user.save();
            return user.balance;
        }
        return null;
    } catch (error) {
        console.error('Error updating user balance:', error);
        return null;
    }
}

// Create transaction
async function createTransaction(type, userId, amount, room = null, admin = false) {
    try {
        const user = await User.findOne({ userId: userId });
        
        const transaction = new Transaction({
            type: type,
            userId: userId,
            userName: user ? user.userName : 'Unknown',
            amount: amount,
            room: room,
            admin: admin,
            description: getTransactionDescription(type, amount, room)
        });
        
        await transaction.save();
        
        // Update daily stats
        if (type === 'STAKE') {
            await updateDailyStats('totalWagered', Math.abs(amount));
        } else if (type === 'HOUSE_EARNINGS') {
            await updateDailyStats('totalEarnings', amount);
        }
        
        return transaction;
    } catch (error) {
        console.error('Error creating transaction:', error);
        return null;
    }
}

// Get room from MongoDB
async function getRoom(stake) {
    try {
        let room = await Room.findOne({ stake: stake, status: { $in: ['waiting', 'starting', 'playing'] } });
        
        if (!room) {
            room = new Room({
                stake: stake,
                players: [],
                takenBoxes: [],
                status: 'waiting'
            });
            await room.save();
        }
        
        return room;
    } catch (error) {
        console.error('Error getting room:', error);
        return null;
    }
}

// Update room
async function updateRoom(room) {
    try {
        await Room.findByIdAndUpdate(room._id, room);
        return true;
    } catch (error) {
        console.error('Error updating room:', error);
        return false;
    }
}

// Update daily stats
async function updateDailyStats(field, value) {
    try {
        const today = new Date().toISOString().split('T')[0];
        await Stats.findOneAndUpdate(
            { date: today },
            { $inc: { [field]: value } },
            { upsert: true, new: true }
        );
        return true;
    } catch (error) {
        console.error('Error updating daily stats:', error);
        return false;
    }
}

// Get system stats
async function getSystemStats() {
    try {
        const today = new Date().toISOString().split('T')[0];
        const stats = await Stats.findOne({ date: today });
        
        const totalUsers = await User.countDocuments();
        const totalTransactions = await Transaction.countDocuments();
        const totalRooms = await Room.countDocuments();
        
        return {
            todayStats: stats || {
                date: today,
                totalWagered: 0,
                totalEarnings: 0,
                totalGames: 0,
                totalUsers: 0,
                newUsers: 0,
                totalBingos: 0,
                totalFourCorners: 0
            },
            totalUsers: totalUsers,
            totalTransactions: totalTransactions,
            totalRooms: totalRooms
        };
    } catch (error) {
        console.error('Error getting system stats:', error);
        return null;
    }
}

// Helper function for transaction description
function getTransactionDescription(type, amount, room) {
    const descriptions = {
        'STAKE': `Staked ${Math.abs(amount)} ETB in ${room} ETB room`,
        'WIN': `Won ${amount} ETB in ${room} ETB room`,
        'WIN_FOUR_CORNERS': `Won ${amount} ETB (Four Corners Bonus!)`,
        'ADMIN_ADD': `Admin added ${amount} ETB`,
        'HOUSE_EARNINGS': `House earned ${amount} ETB`
    };
    
    return descriptions[type] || type;
}

// ========== UPDATED SOCKET.IO EVENT HANDLERS ==========

// Update the 'init' event handler:
socket.on('init', async (data) => {
    const { userId, userName } = data;
    
    const user = await getUser(userId, userName);
    
    if (user) {
        socketToUser.set(socket.id, userId);
        
        socket.emit('balanceUpdate', user.balance);
        socket.emit('userData', {
            userId: userId,
            userName: user.userName,
            referralCode: user.referralCode,
            joinedAt: user.joinedAt
        });
        
        // Update admin panel
        updateAdminPanel();
        broadcastRoomStatus();
    } else {
        socket.emit('error', 'Failed to initialize user');
    }
});

// Update the 'joinRoom' event handler (partial example):
socket.on('joinRoom', async (data) => {
    const { room, box, userName } = data;
    const userId = socketToUser.get(socket.id);
    
    if (!userId) {
        socket.emit('error', 'Player not initialized');
        return;
    }
    
    const user = await User.findOne({ userId: userId });
    if (!user) {
        socket.emit('error', 'User not found');
        return;
    }
    
    if (user.balance < room) {
        socket.emit('insufficientFunds');
        return;
    }
    
    const roomData = await getRoom(room);
    if (!roomData) {
        socket.emit('error', 'Invalid room');
        return;
    }
    
    // Check if box is taken
    if (roomData.takenBoxes.includes(box)) {
        socket.emit('boxTaken');
        return;
    }
    
    // Update user balance
    user.balance -= room;
    user.currentRoom = room;
    user.box = box;
    user.totalWagered = (user.totalWagered || 0) + room;
    await user.save();
    
    // Update room
    roomData.players.push(userId);
    roomData.takenBoxes.push(box);
    await roomData.save();
    
    // Create transaction
    await createTransaction('STAKE', userId, -room, room);
    
    // Continue with game logic...
    // [Rest of your existing joinRoom logic]
});

// Update the 'admin:addFunds' event handler:
socket.on('admin:addFunds', async ({ userId, amount }) => {
    if (!adminSockets.has(socket.id)) {
        socket.emit('admin:error', 'Unauthorized');
        return;
    }
    
    const user = await User.findOne({ userId: userId });
    if (!user) {
        socket.emit('admin:error', 'User not found');
        return;
    }
    
    const oldBalance = user.balance;
    user.balance += parseFloat(amount);
    await user.save();
    
    // Create transaction
    await createTransaction('ADMIN_ADD', userId, amount, null, true);
    
    // Emit to player if online
    for (const [sId, uId] of socketToUser.entries()) {
        if (uId === userId) {
            const playerSocket = io.sockets.sockets.get(sId);
            if (playerSocket) {
                playerSocket.emit('balanceUpdate', user.balance);
                playerSocket.emit('fundsAdded', {
                    amount: amount,
                    newBalance: user.balance
                });
            }
        }
    }
    
    socket.emit('admin:success', `Added ${amount} ETB to ${user.userName}`);
    updateAdminPanel();
});

// ========== NEW FUNCTION TO LOAD ALL ONLINE USERS FOR ADMIN PANEL ==========

async function getAllUsersForAdmin() {
    try {
        const users = await User.find({}).sort({ balance: -1 }).limit(100);
        
        const userArray = users.map(user => {
            let isOnline = false;
            // Check if user has active socket connection
            for (const [socketId, userId] of socketToUser.entries()) {
                if (userId === user.userId && io.sockets.sockets.get(socketId)?.connected) {
                    isOnline = true;
                    break;
                }
            }
            
            return {
                userId: user.userId,
                userName: user.userName,
                balance: user.balance,
                currentRoom: user.currentRoom,
                box: user.box,
                joinedAt: user.joinedAt,
                isOnline: isOnline,
                totalWagered: user.totalWagered || 0,
                totalWins: user.totalWins || 0,
                lastSeen: user.lastSeen || user.joinedAt
            };
        });
        
        return userArray;
    } catch (error) {
        console.error('Error getting users for admin:', error);
        return [];
    }
}

// ========== UPDATE ADMIN PANEL FUNCTION ==========

async function updateAdminPanel() {
    try {
        const totalPlayers = Array.from(socketToUser.keys()).length;
        const activeGames = await Room.countDocuments({ status: 'playing' });
        const systemStats = await getSystemStats();
        
        // Get all users for admin panel
        const userArray = await getAllUsersForAdmin();
        
        // Get recent transactions
        const recentTransactions = await Transaction.find({})
            .sort({ createdAt: -1 })
            .limit(100)
            .lean();
        
        // Get room data
        const roomsData = {};
        const stakes = [10, 20, 50, 100];
        
        for (const stake of stakes) {
            const room = await Room.findOne({ stake: stake, status: { $in: ['waiting', 'starting', 'playing'] } });
            if (room) {
                const commissionPerPlayer = CONFIG.HOUSE_COMMISSION[stake] || 0;
                const contributionPerPlayer = stake - commissionPerPlayer;
                const potentialPrize = contributionPerPlayer * room.players.length;
                const houseFee = commissionPerPlayer * room.players.length;
                
                roomsData[stake] = {
                    stake: stake,
                    playerCount: room.players.length,
                    takenBoxes: room.takenBoxes,
                    status: room.status,
                    currentBall: room.currentBall,
                    ballsDrawn: room.ballsDrawn,
                    commissionPerPlayer: commissionPerPlayer,
                    contributionPerPlayer: contributionPerPlayer,
                    potentialPrize: potentialPrize,
                    houseFee: houseFee
                };
            }
        }
        
        // Send data to all admin sockets
        adminSockets.forEach(socketId => {
            const socket = io.sockets.sockets.get(socketId);
            if (socket) {
                socket.emit('admin:update', {
                    totalPlayers,
                    activeGames,
                    houseBalance: calculateHouseBalance(), // You might want to calculate this from transactions
                    totalUsers: userArray.length,
                    dailyStats: systemStats?.todayStats || {}
                });
                
                socket.emit('admin:players', userArray);
                socket.emit('admin:rooms', roomsData);
                socket.emit('admin:transactions', recentTransactions);
            }
        });
    } catch (error) {
        console.error('Error updating admin panel:', error);
    }
}

// ========== UPDATE DISCONNECT HANDLER ==========

socket.on('disconnect', async () => {
    console.log(`Disconnected: ${socket.id}`);
    
    adminSockets.delete(socket.id);
    
    const userId = socketToUser.get(socket.id);
    if (userId) {
        // Update user's online status
        await User.findOneAndUpdate(
            { userId: userId },
            { 
                isOnline: false,
                lastSeen: new Date() 
            }
        );
        
        socketToUser.delete(socket.id);
        updateAdminPanel();
    }
});
