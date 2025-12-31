// db.js - MongoDB connection setup
const mongoose = require('mongoose');
require('dotenv').config();

// Your MongoDB connection string
const MONGODB_URI = "mongodb+srv://israelnegasi:mikejava@cluster0.b2hukwx.mongodb.net/bingo_elite?retryWrites=true&w=majority";

// Connect to MongoDB
const connectDB = async () => {
    try {
        await mongoose.connect(MONGODB_URI, {
            useNewUrlParser: true,
            useUnifiedTopology: true
        });
        console.log('✅ MongoDB connected successfully!');
    } catch (error) {
        console.error('❌ MongoDB connection error:', error.message);
        process.exit(1); // Exit if can't connect
    }
};

module.exports = connectDB;