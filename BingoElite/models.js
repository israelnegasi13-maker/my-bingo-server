// models.js - MongoDB schemas
const mongoose = require('mongoose');

// User Schema
const userSchema = new mongoose.Schema({
    userId: { type: String, required: true, unique: true },
    userName: { type: String, required: true },
    balance: { type: Number, default: 0.00 },
    currentRoom: { type: Number, default: null },
    box: { type: Number, default: null },
    totalWagered: { type: Number, default: 0 },
    totalWins: { type: Number, default: 0 },
    totalBingos: { type: Number, default: 0 },
    joinedAt: { type: Date, default: Date.now },
    lastSeen: { type: Date, default: Date.now },
    isOnline: { type: Boolean, default: false },
    referralCode: { type: String },
    sessionCount: { type: Number, default: 1 }
});

// Game Room Schema
const roomSchema = new mongoose.Schema({
    stake: { type: Number, required: true },
    players: [{ type: String }], // Array of userIds
    takenBoxes: [{ type: Number }],
    status: { type: String, default: 'waiting' }, // waiting, starting, playing, ended
    calledNumbers: [{ type: Number }],
    currentBall: { type: Number, default: null },
    ballsDrawn: { type: Number, default: 0 },
    startTime: { type: Date },
    endTime: { type: Date },
    winner: { type: String, default: null },
    prizeAmount: { type: Number, default: 0 },
    isFourCornersWin: { type: Boolean, default: false }
}, { timestamps: true });

// Transaction Schema
const transactionSchema = new mongoose.Schema({
    type: { type: String, required: true }, // STAKE, WIN, WIN_FOUR_CORNERS, ADMIN_ADD, HOUSE_EARNINGS
    userId: { type: String, required: true },
    userName: { type: String, required: true },
    amount: { type: Number, required: true },
    room: { type: Number },
    admin: { type: Boolean, default: false },
    description: { type: String }
}, { timestamps: true });

// System Stats Schema
const statsSchema = new mongoose.Schema({
    date: { type: String, required: true, unique: true }, // YYYY-MM-DD format
    totalWagered: { type: Number, default: 0 },
    totalEarnings: { type: Number, default: 0 },
    totalGames: { type: Number, default: 0 },
    totalUsers: { type: Number, default: 0 },
    newUsers: { type: Number, default: 0 },
    totalBingos: { type: Number, default: 0 },
    totalFourCorners: { type: Number, default: 0 }
});

// Create models
const User = mongoose.model('User', userSchema);
const Room = mongoose.model('Room', roomSchema);
const Transaction = mongoose.model('Transaction', transactionSchema);
const Stats = mongoose.model('Stats', statsSchema);

module.exports = { User, Room, Transaction, Stats };