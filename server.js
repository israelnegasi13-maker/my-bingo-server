const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// CORS middleware for API endpoints
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    next();
});

app.use(express.json());

// Serve the single HTML file
const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Keno Casino - Real Multiplayer</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <style>
        :root {
            --primary-red: #e53935;
            --primary-dark-red: #b71c1c;
            --accent-yellow: #ffeb3b;
            --accent-gold: #ffd700;
            --success-green: #4caf50;
            --dark-bg: #0a0a0a;
            --card-bg: #1a1a1a;
            --card-border: #333;
            --text-primary: #ffffff;
            --text-secondary: #b0b0b0;
        }
        
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            -webkit-tap-highlight-color: transparent;
        }
        
        body {
            background: linear-gradient(135deg, var(--dark-bg) 0%, #1a0a0a 100%);
            color: var(--text-primary);
            min-height: 100vh;
            overflow-x: hidden;
        }
        
        .container {
            max-width: 100%;
            padding: 15px;
            margin: 0 auto;
        }
        
        /* Header */
        .app-header {
            padding: 15px 0;
            display: flex;
            justify-content: space-between;
            align-items: center;
            border-bottom: 2px solid var(--primary-red);
            margin-bottom: 20px;
            background: rgba(181, 28, 28, 0.1);
            border-radius: 10px;
            padding: 15px;
        }
        
        .logo-section {
            display: flex;
            align-items: center;
            gap: 12px;
        }
        
        .logo-icon {
            width: 45px;
            height: 45px;
            background: linear-gradient(135deg, var(--primary-red), var(--primary-dark-red));
            border-radius: 10px;
            display: flex;
            align-items: center;
            justify-content: center;
            color: var(--accent-gold);
            font-size: 22px;
        }
        
        .logo-text h1 {
            font-size: 24px;
            font-weight: 800;
            background: linear-gradient(to right, var(--accent-gold), var(--accent-yellow));
            -webkit-background-clip: text;
            background-clip: text;
            color: transparent;
            letter-spacing: 1px;
        }
        
        .logo-text p {
            font-size: 12px;
            color: var(--text-secondary);
            font-weight: 500;
        }
        
        /* User Info */
        .user-info {
            display: flex;
            gap: 10px;
        }
        
        .balance-card {
            background: linear-gradient(145deg, #222, #1a1a1a);
            border-radius: 10px;
            padding: 12px 18px;
            border: 2px solid var(--card-border);
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
            min-width: 130px;
        }
        
        .balance-label {
            font-size: 11px;
            color: var(--text-secondary);
            text-transform: uppercase;
            letter-spacing: 0.5px;
            margin-bottom: 4px;
            font-weight: 600;
        }
        
        .balance-amount {
            font-size: 20px;
            font-weight: 800;
            color: var(--accent-gold);
        }
        
        /* Connection Status */
        .connection-status {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 8px 16px;
            border-radius: 20px;
            font-size: 13px;
            font-weight: 600;
            margin-bottom: 15px;
            justify-content: center;
        }
        
        .status-connected {
            background: rgba(76, 175, 80, 0.15);
            color: var(--success-green);
            border: 1px solid rgba(76, 175, 80, 0.3);
        }
        
        .status-disconnected {
            background: rgba(229, 57, 53, 0.15);
            color: var(--primary-red);
            border: 1px solid rgba(229, 57, 53, 0.3);
        }
        
        .status-dot {
            width: 10px;
            height: 10px;
            border-radius: 50%;
        }
        
        .dot-connected {
            background: var(--success-green);
            animation: pulse 2s infinite;
        }
        
        .dot-disconnected {
            background: var(--primary-red);
        }
        
        @keyframes pulse {
            0% { opacity: 1; }
            50% { opacity: 0.5; }
            100% { opacity: 1; }
        }
        
        /* Game Layout */
        .game-container {
            display: flex;
            flex-direction: column;
            gap: 15px;
            margin-bottom: 20px;
        }
        
        /* Game Board */
        .game-board {
            background: linear-gradient(145deg, #1e1e1e, #151515);
            border-radius: 15px;
            padding: 20px;
            border: 2px solid var(--card-border);
            box-shadow: 0 6px 20px rgba(0, 0, 0, 0.4);
        }
        
        .board-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
        }
        
        .board-title h2 {
            font-size: 18px;
            font-weight: 700;
            color: var(--accent-gold);
            margin-bottom: 5px;
        }
        
        .board-title p {
            font-size: 13px;
            color: var(--text-secondary);
            font-weight: 500;
        }
        
        .selection-info {
            background: rgba(229, 57, 53, 0.2);
            border-radius: 8px;
            padding: 10px 15px;
            border: 1px solid rgba(229, 57, 53, 0.4);
            font-weight: 700;
            font-size: 15px;
            color: var(--primary-red);
        }
        
        /* Numbers Grid */
        .numbers-grid {
            display: grid;
            grid-template-columns: repeat(8, 1fr);
            gap: 8px;
            margin-bottom: 20px;
        }
        
        @media (min-width: 480px) {
            .numbers-grid {
                grid-template-columns: repeat(10, 1fr);
            }
        }
        
        .keno-number {
            aspect-ratio: 1;
            display: flex;
            align-items: center;
            justify-content: center;
            background: rgba(255, 255, 255, 0.05);
            border-radius: 8px;
            font-weight: 700;
            font-size: 15px;
            cursor: pointer;
            transition: all 0.2s ease;
            user-select: none;
            border: 2px solid transparent;
            color: var(--text-primary);
        }
        
        .keno-number:hover {
            background: rgba(255, 255, 255, 0.1);
            transform: translateY(-2px);
        }
        
        .keno-number.selected {
            background: linear-gradient(135deg, var(--primary-red), #c62828);
            color: white;
            border-color: var(--accent-yellow);
            transform: scale(1.05);
            box-shadow: 0 0 15px rgba(229, 57, 53, 0.6);
        }
        
        .keno-number.drawn {
            background: var(--accent-yellow);
            color: #333;
            font-weight: 900;
            box-shadow: 0 0 20px rgba(255, 235, 59, 0.8);
            animation: popIn 0.5s ease-out;
        }
        
        .keno-number.matched {
            background: linear-gradient(135deg, var(--success-green), #2e7d32);
            color: white;
            box-shadow: 0 0 20px rgba(76, 175, 80, 0.8);
        }
        
        @keyframes popIn {
            0% { transform: scale(0); opacity: 0; }
            70% { transform: scale(1.1); opacity: 1; }
            100% { transform: scale(1); opacity: 1; }
        }
        
        /* Quick Pick Button */
        .quick-pick-btn {
            width: 100%;
            padding: 14px;
            background: rgba(255, 235, 59, 0.1);
            border: 2px solid rgba(255, 235, 59, 0.3);
            border-radius: 10px;
            color: var(--accent-yellow);
            font-weight: 700;
            font-size: 15px;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 10px;
            cursor: pointer;
            transition: all 0.2s;
        }
        
        .quick-pick-btn:hover {
            background: rgba(255, 235, 59, 0.2);
            transform: translateY(-2px);
        }
        
        /* Control Panel */
        .control-panel {
            background: linear-gradient(145deg, #1e1e1e, #151515);
            border-radius: 15px;
            padding: 20px;
            border: 2px solid var(--card-border);
            box-shadow: 0 6px 20px rgba(0, 0, 0, 0.4);
            position: relative;
        }
        
        /* Round Timer */
        .round-timer {
            background: linear-gradient(135deg, var(--primary-red), var(--primary-dark-red));
            border-radius: 12px;
            padding: 18px;
            text-align: center;
            margin-bottom: 20px;
            border: 2px solid var(--accent-gold);
            box-shadow: 0 4px 15px rgba(229, 57, 53, 0.4);
        }
        
        .timer-label {
            font-size: 13px;
            color: rgba(255, 255, 255, 0.9);
            margin-bottom: 8px;
            text-transform: uppercase;
            letter-spacing: 1px;
            font-weight: 700;
        }
        
        .timer-display {
            font-size: 36px;
            font-weight: 900;
            font-family: 'Courier New', monospace;
            color: var(--accent-yellow);
            margin: 10px 0;
            text-shadow: 0 0 10px rgba(255, 235, 59, 0.5);
        }
        
        .game-stats {
            display: flex;
            justify-content: space-around;
            margin-top: 15px;
            font-size: 12px;
            color: rgba(255, 255, 255, 0.8);
            font-weight: 600;
        }
        
        .stat-item {
            display: flex;
            flex-direction: column;
            align-items: center;
        }
        
        .stat-value {
            font-size: 18px;
            font-weight: 900;
            color: white;
        }
        
        /* Bet Controls */
        .bet-controls {
            margin-bottom: 20px;
        }
        
        .bet-amount-display {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 18px;
        }
        
        .bet-amount-display label {
            font-size: 14px;
            color: var(--text-secondary);
            font-weight: 600;
        }
        
        .current-bet {
            font-size: 26px;
            font-weight: 900;
            color: var(--accent-gold);
            text-shadow: 0 0 5px rgba(255, 215, 0, 0.3);
        }
        
        .chips-grid {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 10px;
            margin-bottom: 20px;
        }
        
        .chip {
            padding: 15px;
            background: rgba(255, 255, 255, 0.05);
            border-radius: 10px;
            border: 2px solid var(--card-border);
            color: var(--text-primary);
            font-weight: 700;
            text-align: center;
            cursor: pointer;
            transition: all 0.2s;
            font-size: 15px;
        }
        
        .chip:hover {
            background: rgba(255, 255, 255, 0.1);
            transform: translateY(-2px);
        }
        
        .chip.selected {
            background: linear-gradient(135deg, var(--primary-red), #c62828);
            color: white;
            border-color: var(--accent-yellow);
            transform: scale(1.05);
            box-shadow: 0 4px 12px rgba(229, 57, 53, 0.4);
        }
        
        /* Action Buttons */
        .action-buttons {
            display: flex;
            flex-direction: column;
            gap: 12px;
        }
        
        .btn {
            padding: 16px;
            border: none;
            border-radius: 12px;
            font-weight: 800;
            font-size: 16px;
            cursor: pointer;
            transition: all 0.3s;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 12px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        
        .btn-primary {
            background: linear-gradient(135deg, var(--primary-red), var(--primary-dark-red));
            color: white;
            border: 2px solid var(--accent-yellow);
        }
        
        .btn-primary:hover:not(:disabled) {
            transform: translateY(-3px);
            box-shadow: 0 8px 25px rgba(229, 57, 53, 0.5);
        }
        
        .btn-primary:disabled {
            opacity: 0.5;
            cursor: not-allowed;
            transform: none !important;
        }
        
        .btn-secondary {
            background: rgba(255, 255, 255, 0.05);
            color: var(--text-primary);
            border: 2px solid var(--card-border);
        }
        
        .btn-secondary:hover {
            background: rgba(255, 255, 255, 0.1);
            transform: translateY(-2px);
        }
        
        /* Results Panel */
        .results-panel {
            background: linear-gradient(145deg, #1e1e1e, #151515);
            border-radius: 15px;
            padding: 20px;
            border: 2px solid var(--card-border);
            box-shadow: 0 6px 20px rgba(0, 0, 0, 0.4);
            margin-top: 15px;
        }
        
        .results-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 18px;
        }
        
        .results-title {
            font-size: 17px;
            font-weight: 800;
            color: var(--accent-gold);
        }
        
        .round-number {
            font-size: 14px;
            color: var(--text-secondary);
            background: rgba(255, 255, 255, 0.05);
            padding: 6px 14px;
            border-radius: 20px;
            font-weight: 700;
        }
        
        .drawn-numbers-container {
            background: rgba(0, 0, 0, 0.3);
            border-radius: 12px;
            padding: 18px;
            margin-bottom: 20px;
            min-height: 85px;
            border: 1px solid rgba(255, 255, 255, 0.1);
        }
        
        .drawn-numbers {
            display: flex;
            flex-wrap: wrap;
            gap: 10px;
            justify-content: center;
        }
        
        .win-result {
            background: linear-gradient(135deg, rgba(76, 175, 80, 0.15), rgba(76, 175, 80, 0.25));
            border-radius: 12px;
            padding: 22px;
            border-left: 5px solid var(--success-green);
            animation: slideIn 0.6s ease-out;
            box-shadow: 0 4px 15px rgba(76, 175, 80, 0.2);
        }
        
        @keyframes slideIn {
            from {
                opacity: 0;
                transform: translateY(15px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
        }
        
        .win-title {
            color: var(--success-green);
            font-size: 20px;
            font-weight: 900;
            margin-bottom: 10px;
            text-transform: uppercase;
            letter-spacing: 1px;
        }
        
        .win-amount {
            font-size: 38px;
            font-weight: 900;
            color: var(--accent-gold);
            margin-bottom: 12px;
            text-shadow: 0 0 10px rgba(255, 215, 0, 0.5);
        }
        
        .match-details {
            font-size: 15px;
            color: var(--text-secondary);
            font-weight: 600;
        }
        
        .match-details span {
            color: var(--success-green);
            font-weight: 800;
        }
        
        /* Game History */
        .game-history {
            margin-top: 20px;
        }
        
        .history-title {
            font-size: 14px;
            color: var(--accent-yellow);
            margin-bottom: 12px;
            text-transform: uppercase;
            letter-spacing: 1px;
            font-weight: 800;
        }
        
        .history-list {
            display: flex;
            flex-direction: column;
            gap: 10px;
            max-height: 220px;
            overflow-y: auto;
            padding-right: 5px;
        }
        
        .history-item {
            background: rgba(255, 255, 255, 0.05);
            border-radius: 10px;
            padding: 14px 18px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            border: 1px solid transparent;
            transition: all 0.2s;
        }
        
        .history-item:hover {
            background: rgba(255, 255, 255, 0.08);
            transform: translateX(5px);
        }
        
        .history-item.win {
            border-left: 5px solid var(--success-green);
            background: rgba(76, 175, 80, 0.1);
        }
        
        .history-item.loss {
            border-left: 5px solid var(--primary-red);
            background: rgba(229, 57, 53, 0.1);
        }
        
        .history-round {
            font-size: 12px;
            color: var(--text-secondary);
            font-weight: 700;
        }
        
        .history-numbers {
            font-size: 14px;
            color: var(--text-primary);
            font-weight: 700;
        }
        
        .history-result {
            font-size: 14px;
            font-weight: 900;
        }
        
        .history-result.win {
            color: var(--success-green);
        }
        
        .history-result.loss {
            color: var(--primary-red);
        }
        
        /* Footer */
        .app-footer {
            text-align: center;
            padding: 20px 0;
            margin-top: 25px;
            border-top: 2px solid rgba(229, 57, 53, 0.3);
            font-size: 12px;
            color: var(--text-secondary);
            font-weight: 600;
        }
        
        /* Loading Spinner */
        .spinner {
            width: 22px;
            height: 22px;
            border: 3px solid rgba(255, 255, 255, 0.3);
            border-radius: 50%;
            border-top-color: var(--accent-yellow);
            animation: spin 1s linear infinite;
        }
        
        @keyframes spin {
            to { transform: rotate(360deg); }
        }
        
        /* Waiting Overlay */
        .waiting-overlay {
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0, 0, 0, 0.85);
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            border-radius: 15px;
            z-index: 100;
            backdrop-filter: blur(5px);
        }
        
        .waiting-text {
            font-size: 20px;
            font-weight: 900;
            color: var(--accent-yellow);
            margin-bottom: 20px;
            text-align: center;
            text-transform: uppercase;
            letter-spacing: 1px;
        }
        
        .waiting-timer {
            font-size: 52px;
            font-weight: 900;
            color: var(--primary-red);
            font-family: 'Courier New', monospace;
            text-shadow: 0 0 15px rgba(229, 57, 53, 0.7);
        }
        
        /* Notification */
        .notification {
            position: fixed;
            top: 20px;
            left: 50%;
            transform: translateX(-50%) translateY(-30px);
            padding: 14px 24px;
            border-radius: 12px;
            font-weight: 700;
            font-size: 14px;
            z-index: 1000;
            opacity: 0;
            transition: all 0.3s ease;
            text-align: center;
            max-width: 90%;
            box-shadow: 0 8px 30px rgba(0, 0, 0, 0.5);
        }
        
        .notification.show {
            opacity: 1;
            transform: translateX(-50%) translateY(0);
        }
        
        .notification.success {
            background: linear-gradient(135deg, var(--success-green), #2e7d32);
            color: white;
            border: 2px solid #4caf50;
        }
        
        .notification.error {
            background: linear-gradient(135deg, var(--primary-red), #c62828);
            color: white;
            border: 2px solid #e53935;
        }
        
        .notification.info {
            background: linear-gradient(135deg, #2196F3, #0d47a1);
            color: white;
            border: 2px solid #2196F3;
        }
        
        /* Responsive */
        @media (max-width: 360px) {
            .numbers-grid {
                grid-template-columns: repeat(6, 1fr);
            }
            
            .chips-grid {
                grid-template-columns: repeat(2, 1fr);
            }
            
            .user-info {
                flex-direction: column;
                gap: 8px;
            }
            
            .balance-card {
                min-width: 100%;
            }
            
            .timer-display {
                font-size: 32px;
            }
            
            .win-amount {
                font-size: 32px;
            }
        }
        
        @media (min-width: 768px) {
            .container {
                max-width: 500px;
            }
        }
        
        /* Scrollbar */
        ::-webkit-scrollbar {
            width: 8px;
        }
        
        ::-webkit-scrollbar-track {
            background: rgba(0, 0, 0, 0.2);
            border-radius: 4px;
        }
        
        ::-webkit-scrollbar-thumb {
            background: var(--primary-red);
            border-radius: 4px;
        }
        
        ::-webkit-scrollbar-thumb:hover {
            background: var(--accent-yellow);
        }
    </style>
</head>
<body>
    <div class="container">
        <!-- Connection Status -->
        <div class="connection-status status-connected" id="connection-status">
            <div class="status-dot dot-connected"></div>
            <span id="status-text">Connected to Server</span>
        </div>
        
        <!-- Header -->
        <header class="app-header">
            <div class="logo-section">
                <div class="logo-icon">
                    <i class="fas fa-dice"></i>
                </div>
                <div class="logo-text">
                    <h1>KENO CASINO</h1>
                    <p>REAL MULTIPLAYER</p>
                </div>
            </div>
            <div class="user-info">
                <div class="balance-card">
                    <div class="balance-label">BALANCE</div>
                    <div class="balance-amount" id="balance">10,000 ETB</div>
                </div>
                <div class="balance-card">
                    <div class="balance-label">WINNINGS</div>
                    <div class="balance-amount" id="total-winnings">0 ETB</div>
                </div>
            </div>
        </header>
        
        <!-- Main Game -->
        <div class="game-container">
            <!-- Game Board -->
            <div class="game-board">
                <div class="board-header">
                    <div class="board-title">
                        <h2>SELECT YOUR NUMBERS</h2>
                        <p>Choose 1-10 numbers from 1-80</p>
                    </div>
                    <div class="selection-info">
                        SELECTED: <span id="selected-count">0</span>/10
                    </div>
                </div>
                
                <div class="numbers-grid" id="keno-grid">
                    <!-- Numbers 1-80 will be generated here -->
                </div>
                
                <button class="quick-pick-btn" id="quick-pick">
                    <i class="fas fa-random"></i> QUICK PICK
                </button>
            </div>
            
            <!-- Control Panel -->
            <div class="control-panel" id="control-panel">
                <!-- Round Timer -->
                <div class="round-timer">
                    <div class="timer-label">NEXT DRAW IN</div>
                    <div class="timer-display" id="countdown">00:30</div>
                    <div class="game-stats">
                        <div class="stat-item">
                            <div class="stat-value" id="players-count">0</div>
                            <div>PLAYERS</div>
                        </div>
                        <div class="stat-item">
                            <div class="stat-value" id="bets-count">0</div>
                            <div>BETS</div>
                        </div>
                        <div class="stat-item">
                            <div class="stat-value" id="round-number">1</div>
                            <div>ROUND</div>
                        </div>
                    </div>
                </div>
                
                <!-- Bet Controls -->
                <div class="bet-controls">
                    <div class="bet-amount-display">
                        <label>BET AMOUNT</label>
                        <div class="current-bet"><span id="current-bet">10</span> ETB</div>
                    </div>
                    
                    <div class="chips-grid">
                        <div class="chip selected" data-value="1">1 ETB</div>
                        <div class="chip" data-value="5">5 ETB</div>
                        <div class="chip" data-value="10">10 ETB</div>
                        <div class="chip" data-value="25">25 ETB</div>
                        <div class="chip" data-value="50">50 ETB</div>
                        <div class="chip" data-value="100">100 ETB</div>
                    </div>
                </div>
                
                <!-- Action Buttons -->
                <div class="action-buttons">
                    <button class="btn btn-primary" id="play-btn">
                        <i class="fas fa-play"></i> PLACE BET
                    </button>
                    <button class="btn btn-secondary" id="clear-btn">
                        <i class="fas fa-times"></i> CLEAR SELECTION
                    </button>
                </div>
            </div>
            
            <!-- Results Panel -->
            <div class="results-panel" id="results-panel">
                <div class="results-header">
                    <div class="results-title">DRAWN NUMBERS</div>
                    <div class="round-number">ROUND #<span id="current-round">1</span></div>
                </div>
                
                <div class="drawn-numbers-container">
                    <div class="drawn-numbers" id="drawn-numbers">
                        <div style="color: var(--text-secondary); text-align: center; padding: 25px; font-weight: 600;">
                            Waiting for next draw...
                        </div>
                    </div>
                </div>
                
                <!-- Winning Result -->
                <div class="win-result" id="win-result" style="display: none;">
                    <div class="win-title">🎉 YOU WON! 🎉</div>
                    <div class="win-amount"><span id="win-amount">0</span> ETB</div>
                    <div class="match-details">
                        Matched <span id="match-count">0</span> of <span id="selected-count-2">0</span> numbers
                    </div>
                </div>
            </div>
            
            <!-- Game History -->
            <div class="game-history">
                <div class="history-title">RECENT GAMES</div>
                <div class="history-list" id="history-list">
                    <div style="color: var(--text-secondary); text-align: center; padding: 25px; font-weight: 600;">
                        Game history will appear here
                    </div>
                </div>
            </div>
        </div>
        
        <!-- Footer -->
        <footer class="app-footer">
            <p>KENO MULTIPLAYER CASINO • FOR ENTERTAINMENT PURPOSES ONLY</p>
            <p style="margin-top: 8px; font-size: 11px;">Powered by Real-Time Gaming Server</p>
        </footer>
    </div>
    
    <script>
        // Configuration
        const WS_URL = window.location.protocol === 'https:' 
            ? 'wss://' + window.location.host
            : 'ws://' + window.location.host;
        
        // Game State
        let gameState = {
            playerId: null,
            selectedNumbers: [],
            betAmount: 10,
            balance: 10000,
            totalWinnings: 0,
            roundActive: false,
            currentRound: 1,
            countdown: 30,
            drawnNumbers: [],
            playersCount: 0,
            betsCount: 0,
            roundHistory: [],
            ws: null,
            reconnectAttempts: 0,
            maxReconnectAttempts: 5,
            isConnected: false
        };
        
        // DOM Elements
        const elements = {
            kenoGrid: document.getElementById('keno-grid'),
            selectedCount: document.getElementById('selected-count'),
            balance: document.getElementById('balance'),
            totalWinnings: document.getElementById('total-winnings'),
            currentBet: document.getElementById('current-bet'),
            countdown: document.getElementById('countdown'),
            playersCount: document.getElementById('players-count'),
            betsCount: document.getElementById('bets-count'),
            roundNumber: document.getElementById('round-number'),
            currentRound: document.getElementById('current-round'),
            playBtn: document.getElementById('play-btn'),
            clearBtn: document.getElementById('clear-btn'),
            quickPickBtn: document.getElementById('quick-pick'),
            drawnNumbers: document.getElementById('drawn-numbers'),
            winResult: document.getElementById('win-result'),
            winAmount: document.getElementById('win-amount'),
            matchCount: document.getElementById('match-count'),
            selectedCount2: document.getElementById('selected-count-2'),
            historyList: document.getElementById('history-list'),
            connectionStatus: document.getElementById('connection-status'),
            statusText: document.getElementById('status-text'),
            controlPanel: document.getElementById('control-panel'),
            resultsPanel: document.getElementById('results-panel')
        };
        
        // Initialize Game
        function initGame() {
            createNumberGrid();
            setupEventListeners();
            connectWebSocket();
        }
        
        // Create Number Grid
        function createNumberGrid() {
            elements.kenoGrid.innerHTML = '';
            for (let i = 1; i <= 80; i++) {
                const numElement = document.createElement('div');
                numElement.className = 'keno-number';
                numElement.textContent = i;
                numElement.dataset.number = i;
                numElement.addEventListener('click', () => toggleNumberSelection(i));
                elements.kenoGrid.appendChild(numElement);
            }
        }
        
        // Setup Event Listeners
        function setupEventListeners() {
            // Bet Chips
            document.querySelectorAll('.chip').forEach(chip => {
                chip.addEventListener('click', function() {
                    if (!gameState.roundActive || gameState.isConnected === false) return;
                    
                    document.querySelectorAll('.chip').forEach(c => c.classList.remove('selected'));
                    this.classList.add('selected');
                    
                    gameState.betAmount = parseInt(this.dataset.value);
                    elements.currentBet.textContent = gameState.betAmount;
                });
            });
            
            // Play Button
            elements.playBtn.addEventListener('click', placeBet);
            
            // Clear Button
            elements.clearBtn.addEventListener('click', clearSelection);
            
            // Quick Pick Button
            elements.quickPickBtn.addEventListener('click', requestQuickPick);
        }
        
        // WebSocket Connection
        function connectWebSocket() {
            try {
                gameState.ws = new WebSocket(WS_URL);
                
                gameState.ws.onopen = handleWebSocketOpen;
                gameState.ws.onmessage = handleWebSocketMessage;
                gameState.ws.onclose = handleWebSocketClose;
                gameState.ws.onerror = handleWebSocketError;
                
            } catch (error) {
                console.error('Failed to connect:', error);
                updateConnectionStatus(false, 'Connection Failed');
                setTimeout(attemptReconnect, 5000);
            }
        }
        
        // WebSocket Event Handlers
        function handleWebSocketOpen() {
            console.log('Connected to game server');
            gameState.isConnected = true;
            gameState.reconnectAttempts = 0;
            updateConnectionStatus(true, 'Connected to Server');
            
            // Start heartbeat
            setInterval(() => {
                if (gameState.ws && gameState.ws.readyState === WebSocket.OPEN) {
                    gameState.ws.send(JSON.stringify({ type: 'ping' }));
                }
            }, 30000);
        }
        
        function handleWebSocketMessage(event) {
            try {
                const data = JSON.parse(event.data);
                console.log('Received:', data.type);
                
                switch (data.type) {
                    case 'welcome':
                        handleWelcome(data);
                        break;
                        
                    case 'round_start':
                        handleRoundStart(data);
                        break;
                        
                    case 'countdown_update':
                        updateCountdown(data.countdown);
                        break;
                        
                    case 'draw_start':
                        handleDrawStart(data);
                        break;
                        
                    case 'round_results':
                        handleRoundResults(data);
                        break;
                        
                    case 'round_result':
                        handlePersonalResult(data);
                        break;
                        
                    case 'bet_confirmed':
                        handleBetConfirmed(data);
                        break;
                        
                    case 'quick_pick_numbers':
                        handleQuickPickNumbers(data);
                        break;
                        
                    case 'players_update':
                        updatePlayersCount(data.count, data.totalBets);
                        break;
                        
                    case 'waiting_period':
                        startWaitingPeriod(data.duration);
                        break;
                        
                    case 'error':
                        showNotification(data.message, 'error');
                        break;
                }
            } catch (error) {
                console.error('Error processing message:', error);
            }
        }
        
        function handleWebSocketClose() {
            console.log('Disconnected from server');
            gameState.isConnected = false;
            updateConnectionStatus(false, 'Disconnected');
            attemptReconnect();
        }
        
        function handleWebSocketError(error) {
            console.error('WebSocket error:', error);
            updateConnectionStatus(false, 'Connection Error');
        }
        
        // Reconnect Logic
        function attemptReconnect() {
            if (gameState.reconnectAttempts < gameState.maxReconnectAttempts) {
                gameState.reconnectAttempts++;
                const delay = Math.min(1000 * Math.pow(2, gameState.reconnectAttempts), 30000);
                
                updateConnectionStatus(false, `Reconnecting in ${Math.round(delay/1000)}s...`);
                
                setTimeout(() => {
                    if (!gameState.ws || gameState.ws.readyState === WebSocket.CLOSED) {
                        connectWebSocket();
                    }
                }, delay);
            } else {
                updateConnectionStatus(false, 'Failed to connect. Please refresh.');
            }
        }
        
        // Update Connection Status
        function updateConnectionStatus(connected, message) {
            if (connected) {
                elements.connectionStatus.className = 'connection-status status-connected';
                elements.connectionStatus.innerHTML = `
                    <div class="status-dot dot-connected"></div>
                    <span id="status-text">${message}</span>
                `;
                elements.statusText = elements.connectionStatus.querySelector('#status-text');
            } else {
                elements.connectionStatus.className = 'connection-status status-disconnected';
                elements.connectionStatus.innerHTML = `
                    <div class="status-dot dot-disconnected"></div>
                    <span id="status-text">${message}</span>
                `;
                elements.statusText = elements.connectionStatus.querySelector('#status-text');
            }
        }
        
        // Game Message Handlers
        function handleWelcome(data) {
            gameState.playerId = data.playerId;
            gameState.balance = data.balance;
            gameState.currentRound = data.currentRound;
            gameState.roundActive = data.isRoundActive;
            gameState.playersCount = data.playersCount || 0;
            gameState.roundHistory = data.roundHistory || [];
            
            updateBalance();
            updateRoundNumber();
            updatePlayersCount(gameState.playersCount, 0);
            
            if (data.nextDrawTime) {
                const timeLeft = Math.max(0, Math.floor((data.nextDrawTime - Date.now()) / 1000));
                gameState.countdown = timeLeft;
                updateCountdown(timeLeft);
            }
        }
        
        function handleRoundStart(data) {
            gameState.roundActive = true;
            gameState.currentRound = data.round;
            gameState.countdown = data.duration;
            gameState.drawnNumbers = [];
            
            updateRoundNumber();
            clearDrawnNumbers();
            elements.winResult.style.display = 'none';
            
            // Enable controls
            elements.playBtn.disabled = false;
            elements.playBtn.innerHTML = '<i class="fas fa-play"></i> PLACE BET';
            
            // Clear selection
            clearSelection();
            
            showNotification(`Round ${data.round} started! Place your bets!`, 'info');
        }
        
        function handleDrawStart(data) {
            showNotification('Drawing numbers...', 'info');
        }
        
        function handleRoundResults(data) {
            gameState.roundActive = false;
            gameState.drawnNumbers = data.drawnNumbers;
            
            // Display numbers with animation
            displayNumbersWithAnimation(data.drawnNumbers);
            
            // Update stats
            updatePlayersCount(data.playersCount || gameState.playersCount, 0);
            
            showNotification(`Round ${data.round} completed!`, 'info');
        }
        
        function handlePersonalResult(data) {
            gameState.balance = data.newBalance;
            gameState.totalWinnings += data.winnings;
            
            updateBalance();
            
            if (data.winnings > 0) {
                // Show win result after animation
                setTimeout(() => {
                    elements.winAmount.textContent = data.winnings.toLocaleString();
                    elements.matchCount.textContent = data.matches;
                    elements.selectedCount2.textContent = data.selectedNumbers.length;
                    elements.winResult.style.display = 'block';
                    
                    // Scroll to results
                    elements.resultsPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                    
                    showNotification(`🎉 You won ${data.winnings.toLocaleString()} ETB! 🎉`, 'success');
                    
                    // Add to history
                    addToHistory(data);
                }, (data.drawnNumbers.length * 400) + 500);
            } else {
                setTimeout(() => {
                    showNotification('Better luck next round!', 'info');
                }, (data.drawnNumbers.length * 400) + 500);
            }
        }
        
        function handleBetConfirmed(data) {
            gameState.balance = data.balance;
            updateBalance();
            
            showNotification(`Bet placed: ${data.betAmount} ETB`, 'info');
            
            // Disable bet button
            elements.playBtn.disabled = true;
            elements.playBtn.innerHTML = '<i class="fas fa-check"></i> BET PLACED';
        }
        
        function handleQuickPickNumbers(data) {
            clearSelection();
            data.numbers.forEach(number => {
                toggleNumberSelection(number);
            });
        }
        
        // Game Functions
        function toggleNumberSelection(number) {
            if (!gameState.roundActive || !gameState.isConnected) return;
            
            const index = gameState.selectedNumbers.indexOf(number);
            const element = document.querySelector(`.keno-number[data-number="${number}"]`);
            
            if (index === -1) {
                if (gameState.selectedNumbers.length < 10) {
                    gameState.selectedNumbers.push(number);
                    element.classList.add('selected');
                }
            } else {
                gameState.selectedNumbers.splice(index, 1);
                element.classList.remove('selected');
            }
            
            elements.selectedCount.textContent = gameState.selectedNumbers.length;
        }
        
        function clearSelection() {
            if (!gameState.roundActive || !gameState.isConnected) return;
            
            gameState.selectedNumbers.forEach(number => {
                const element = document.querySelector(`.keno-number[data-number="${number}"]`);
                if (element) element.classList.remove('selected');
            });
            
            gameState.selectedNumbers = [];
            elements.selectedCount.textContent = '0';
        }
        
        function requestQuickPick() {
            if (!gameState.roundActive || !gameState.isConnected || !gameState.ws || 
                gameState.ws.readyState !== WebSocket.OPEN) {
                showNotification('Not connected to server', 'error');
                return;
            }
            
            gameState.ws.send(JSON.stringify({
                type: 'quick_pick',
                count: 10
            }));
        }
        
        function placeBet() {
            if (!gameState.roundActive || !gameState.isConnected || !gameState.ws || 
                gameState.ws.readyState !== WebSocket.OPEN) {
                showNotification('Not connected to server', 'error');
                return;
            }
            
            if (gameState.selectedNumbers.length === 0) {
                showNotification('Please select at least one number!', 'error');
                return;
            }
            
            if (gameState.balance < gameState.betAmount) {
                showNotification('Insufficient balance!', 'error');
                return;
            }
            
            // Send bet to server
            gameState.ws.send(JSON.stringify({
                type: 'place_bet',
                numbers: gameState.selectedNumbers,
                betAmount: gameState.betAmount
            }));
        }
        
        // Display Functions
        function displayNumbersWithAnimation(drawnNumbers) {
            elements.drawnNumbers.innerHTML = '';
            
            // Clear grid highlights
            document.querySelectorAll('.keno-number').forEach(el => {
                el.classList.remove('drawn', 'matched');
            });
            
            // Animate numbers one by one
            drawnNumbers.forEach((num, index) => {
                setTimeout(() => {
                    // Highlight in grid
                    const gridNum = document.querySelector(`.keno-number[data-number="${num}"]`);
                    if (gridNum) {
                        gridNum.classList.add('drawn');
                        if (gameState.selectedNumbers.includes(num)) {
                            gridNum.classList.add('matched');
                        }
                    }
                    
                    // Add to display
                    const numEl = document.createElement('div');
                    numEl.className = 'keno-number drawn';
                    numEl.textContent = num;
                    
                    if (gameState.selectedNumbers.includes(num)) {
                        numEl.classList.add('matched');
                    }
                    
                    elements.drawnNumbers.appendChild(numEl);
                    
                }, index * 400); // 400ms delay between numbers
            });
        }
        
        function clearDrawnNumbers() {
            document.querySelectorAll('.keno-number').forEach(el => {
                el.classList.remove('drawn', 'matched');
            });
            
            elements.drawnNumbers.innerHTML = `
                <div style="color: var(--text-secondary); text-align: center; padding: 25px; font-weight: 600;">
                    Waiting for next draw...
                </div>
            `;
            elements.winResult.style.display = 'none';
        }
        
        function startWaitingPeriod(duration) {
            const overlay = document.createElement('div');
            overlay.className = 'waiting-overlay';
            overlay.innerHTML = `
                <div class="waiting-text">NEXT ROUND STARTS IN</div>
                <div class="waiting-timer" id="wait-timer">${duration}</div>
                <div style="color: var(--text-secondary); margin-top: 20px; font-weight: 600;">
                    Please wait for the next round
                </div>
            `;
            
            elements.controlPanel.style.position = 'relative';
            elements.controlPanel.appendChild(overlay);
            
            const waitTimer = overlay.querySelector('#wait-timer');
            let timeLeft = duration;
            
            const timer = setInterval(() => {
                timeLeft--;
                waitTimer.textContent = timeLeft;
                
                if (timeLeft <= 0) {
                    clearInterval(timer);
                    overlay.remove();
                    elements.controlPanel.style.position = '';
                }
            }, 1000);
        }
        
        // Update Functions
        function updateCountdown(seconds) {
            gameState.countdown = seconds;
            const minutes = Math.floor(seconds / 60);
            const secs = seconds % 60;
            elements.countdown.textContent = `${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
            
            if (seconds <= 10) {
                elements.countdown.style.color = '#ff4444';
                elements.countdown.style.textShadow = '0 0 10px rgba(255, 68, 68, 0.7)';
            } else {
                elements.countdown.style.color = 'var(--accent-yellow)';
                elements.countdown.style.textShadow = '0 0 10px rgba(255, 235, 59, 0.5)';
            }
        }
        
        function updatePlayersCount(players, bets) {
            gameState.playersCount = players;
            gameState.betsCount = bets || gameState.betsCount;
            
            elements.playersCount.textContent = players.toLocaleString();
            elements.betsCount.textContent = (bets || gameState.betsCount).toLocaleString();
        }
        
        function updateRoundNumber() {
            elements.roundNumber.textContent = gameState.currentRound;
            elements.currentRound.textContent = gameState.currentRound;
        }
        
        function updateBalance() {
            elements.balance.textContent = gameState.balance.toLocaleString() + ' ETB';
            elements.totalWinnings.textContent = gameState.totalWinnings.toLocaleString() + ' ETB';
        }
        
        function addToHistory(data) {
            const historyItem = document.createElement('div');
            historyItem.className = `history-item ${data.winnings > 0 ? 'win' : 'loss'}`;
            
            const firstFive = data.drawnNumbers.slice(0, 5).join(', ');
            
            historyItem.innerHTML = `
                <div>
                    <div class="history-round">#${data.round}</div>
                    <div class="history-numbers">${firstFive}</div>
                </div>
                <div class="history-result ${data.winnings > 0 ? 'win' : 'loss'}">
                    ${data.winnings > 0 ? `+${data.winnings} ETB` : '-' + data.bet + ' ETB'}
                </div>
            `;
            
            elements.historyList.insertBefore(historyItem, elements.historyList.firstChild);
            
            // Limit to 10 items
            if (elements.historyList.children.length > 10) {
                elements.historyList.removeChild(elements.historyList.lastChild);
            }
        }
        
        // Notification System
        function showNotification(message, type = 'info') {
            const notification = document.createElement('div');
            notification.className = `notification ${type}`;
            notification.textContent = message;
            
            document.body.appendChild(notification);
            
            setTimeout(() => {
                notification.classList.add('show');
            }, 10);
            
            setTimeout(() => {
                notification.classList.remove('show');
                setTimeout(() => {
                    if (notification.parentNode) {
                        notification.parentNode.removeChild(notification);
                    }
                }, 300);
            }, 3000);
        }
        
        // Initialize when page loads
        document.addEventListener('DOMContentLoaded', initGame);
        
        // Prevent accidental refresh
        window.addEventListener('beforeunload', (e) => {
            if (gameState.roundActive) {
                e.preventDefault();
                e.returnValue = 'You have an active bet. Are you sure you want to leave?';
            }
        });
    </script>
</body>
</html>
`;

// Game state management
const gameState = {
    currentRound: 1,
    isRoundActive: false,
    drawnNumbers: [],
    roundStartTime: null,
    roundDuration: 30, // seconds for betting
    players: new Map(),
    bets: new Map(),
    roundHistory: [],
    nextDrawTime: null,
    roundTimer: null,
    totalBetsAmount: 0,
    totalWinningsAmount: 0,
    playerConnections: new Map()
};

// Game constants
const TOTAL_NUMBERS = 80;
const NUMBERS_DRAWN = 20;
const MIN_BET = 1;
const MAX_BET = 1000;
const MAX_SELECT = 10;
const STARTING_BALANCE = 10000;

// Payout table (multiplier of bet)
const PAYOUT_TABLE = {
    0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0,
    6: 10,   // 6 matches: 10x bet
    7: 50,   // 7 matches: 50x bet
    8: 200,  // 8 matches: 200x bet
    9: 1000, // 9 matches: 1000x bet
    10: 10000 // 10 matches: 10000x bet
};

// Helper functions
function generatePlayerId() {
    return 'player_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

function generateDrawnNumbers() {
    const numbers = [];
    while (numbers.length < NUMBERS_DRAWN) {
        const num = Math.floor(Math.random() * TOTAL_NUMBERS) + 1;
        if (!numbers.includes(num)) {
            numbers.push(num);
        }
    }
    return numbers.sort((a, b) => a - b);
}

function calculateWinnings(betAmount, selectedNumbers, drawnNumbers) {
    const matches = selectedNumbers.filter(num => drawnNumbers.includes(num)).length;
    const multiplier = PAYOUT_TABLE[matches] || 0;
    const winnings = betAmount * multiplier;
    return { matches, multiplier, winnings };
}

// Start a new round
function startNewRound() {
    if (gameState.isRoundActive) return;
    
    gameState.isRoundActive = true;
    gameState.currentRound++;
    gameState.drawnNumbers = [];
    gameState.bets.clear();
    gameState.totalBetsAmount = 0;
    gameState.roundStartTime = Date.now();
    gameState.nextDrawTime = Date.now() + (gameState.roundDuration * 1000);
    
    console.log(`🎰 Starting Round ${gameState.currentRound}`);
    console.log(`👥 Players online: ${gameState.players.size}`);
    console.log(`⏰ Round ends: ${new Date(gameState.nextDrawTime).toLocaleTimeString()}`);
    
    // Clear previous timer
    if (gameState.roundTimer) {
        clearTimeout(gameState.roundTimer);
    }
    
    // Notify all players
    broadcast({
        type: 'round_start',
        round: gameState.currentRound,
        startTime: gameState.roundStartTime,
        duration: gameState.roundDuration,
        nextDrawTime: gameState.nextDrawTime,
        playersCount: gameState.players.size
    });
    
    // Start countdown updates
    let countdown = gameState.roundDuration;
    const countdownInterval = setInterval(() => {
        countdown--;
        
        broadcast({
            type: 'countdown_update',
            countdown: countdown,
            nextDrawTime: gameState.nextDrawTime
        });
        
        if (countdown <= 0) {
            clearInterval(countdownInterval);
        }
    }, 1000);
    
    // Schedule number drawing
    gameState.roundTimer = setTimeout(drawNumbers, gameState.roundDuration * 1000);
}

// Draw numbers for current round
function drawNumbers() {
    if (!gameState.isRoundActive) return;
    
    console.log(`🎲 Drawing numbers for Round ${gameState.currentRound}`);
    
    // Generate drawn numbers
    const drawnNumbers = generateDrawnNumbers();
    gameState.drawnNumbers = drawnNumbers;
    
    console.log(`🔢 Drawn numbers: ${drawnNumbers.join(', ')}`);
    console.log(`💰 Total bets placed: ${gameState.bets.size}`);
    
    // Notify players that drawing is starting
    broadcast({
        type: 'draw_start',
        round: gameState.currentRound,
        totalNumbers: drawnNumbers.length
    });
    
    // Calculate results for all players
    const results = [];
    let roundWinnings = 0;
    
    for (const [playerId, player] of gameState.players.entries()) {
        const bet = gameState.bets.get(playerId);
        if (bet) {
            const { matches, multiplier, winnings } = calculateWinnings(
                bet.amount,
                bet.numbers,
                drawnNumbers
            );
            
            const playerResult = {
                playerId,
                round: gameState.currentRound,
                bet: bet.amount,
                selectedNumbers: bet.numbers,
                drawnNumbers,
                matches,
                multiplier,
                winnings,
                newBalance: player.balance - bet.amount + winnings
            };
            
            // Update player balance
            player.balance = playerResult.newBalance;
            roundWinnings += winnings;
            
            results.push(playerResult);
            
            // Send individual result with delay
            setTimeout(() => {
                const ws = player.ws;
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({
                        type: 'round_result',
                        ...playerResult
                    }));
                }
            }, Math.random() * 1000);
        }
    }
    
    gameState.totalWinningsAmount += roundWinnings;
    
    // Add to round history
    const roundResult = {
        round: gameState.currentRound,
        drawnNumbers,
        timestamp: Date.now(),
        totalBets: gameState.bets.size,
        totalBetsAmount: gameState.totalBetsAmount,
        totalWinnings: roundWinnings,
        results: results.map(r => ({
            playerId: r.playerId,
            matches: r.matches,
            winnings: r.winnings,
            bet: r.bet
        }))
    };
    
    gameState.roundHistory.unshift(roundResult);
    
    // Keep only last 50 rounds
    if (gameState.roundHistory.length > 50) {
        gameState.roundHistory.pop();
    }
    
    // Broadcast results after delay
    setTimeout(() => {
        broadcast({
            type: 'round_results',
            round: gameState.currentRound,
            drawnNumbers,
            totalBets: gameState.bets.size,
            totalBetsAmount: gameState.totalBetsAmount,
            totalWinnings: roundWinnings,
            results: results.map(r => ({
                playerId: r.playerId,
                matches: r.matches,
                winnings: r.winnings
            }))
        });
        
        // End round
        gameState.isRoundActive = false;
        
        console.log(`✅ Round ${gameState.currentRound} completed`);
        console.log(`🏆 Total winnings: ${roundWinnings} ETB`);
        console.log(`⏳ Next round in 30 seconds...\n`);
        
        // Start next round after 30 seconds
        setTimeout(startNewRound, 30000);
        
        // Broadcast waiting period
        broadcast({
            type: 'waiting_period',
            duration: 30,
            nextRoundStart: Date.now() + 30000
        });
        
    }, 2000);
}

// Broadcast to all players
function broadcast(message) {
    const data = JSON.stringify(message);
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(data);
        }
    });
}

// Send to specific player
function sendToPlayer(playerId, message) {
    const player = gameState.players.get(playerId);
    if (player && player.ws && player.ws.readyState === WebSocket.OPEN) {
        player.ws.send(JSON.stringify(message));
    }
}

// WebSocket server
wss.on('connection', (ws, req) => {
    const playerId = generatePlayerId();
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    
    const player = {
        id: playerId,
        ws,
        balance: STARTING_BALANCE,
        connectedAt: Date.now(),
        lastSeen: Date.now(),
        ip: ip,
        totalBets: 0,
        totalWinnings: 0
    };
    
    gameState.players.set(playerId, player);
    
    console.log(`🟢 Player connected: ${playerId} (${ip})`);
    console.log(`👥 Total players: ${gameState.players.size}`);
    
    // Send welcome message
    ws.send(JSON.stringify({
        type: 'welcome',
        playerId,
        balance: player.balance,
        currentRound: gameState.currentRound,
        isRoundActive: gameState.isRoundActive,
        roundStartTime: gameState.roundStartTime,
        roundDuration: gameState.roundDuration,
        nextDrawTime: gameState.nextDrawTime,
        roundHistory: gameState.roundHistory.slice(0, 10),
        playersCount: gameState.players.size,
        payoutTable: PAYOUT_TABLE
    }));
    
    // Broadcast player count update
    broadcast({
        type: 'players_update',
        count: gameState.players.size,
        totalBets: gameState.bets.size
    });
    
    // Handle messages
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            player.lastSeen = Date.now();
            
            switch (data.type) {
                case 'place_bet':
                    handlePlaceBet(playerId, data);
                    break;
                    
                case 'quick_pick':
                    handleQuickPick(playerId, data);
                    break;
                    
                case 'ping':
                    ws.send(JSON.stringify({ 
                        type: 'pong',
                        timestamp: Date.now()
                    }));
                    break;
                    
                default:
                    console.warn(`Unknown message type from ${playerId}: ${data.type}`);
            }
        } catch (error) {
            console.error(`Error processing message from ${playerId}:`, error);
            ws.send(JSON.stringify({
                type: 'error',
                message: 'Invalid message format'
            }));
        }
    });
    
    // Handle disconnection
    ws.on('close', () => {
        // Remove player's bet if round hasn't started
        if (gameState.isRoundActive) {
            const bet = gameState.bets.get(playerId);
            if (bet) {
                gameState.totalBetsAmount -= bet.amount;
                gameState.bets.delete(playerId);
            }
        }
        
        gameState.players.delete(playerId);
        console.log(`🔴 Player disconnected: ${playerId}`);
        console.log(`👥 Total players: ${gameState.players.size}`);
        
        // Broadcast updated player count
        broadcast({
            type: 'players_update',
            count: gameState.players.size,
            totalBets: gameState.bets.size
        });
    });
    
    // Handle errors
    ws.on('error', (error) => {
        console.error(`WebSocket error for ${playerId}:`, error);
    });
});

// Handle bet placement
function handlePlaceBet(playerId, data) {
    const player = gameState.players.get(playerId);
    if (!player) {
        console.error(`Player ${playerId} not found`);
        return;
    }
    
    // Check if round is active
    if (!gameState.isRoundActive) {
        sendToPlayer(playerId, {
            type: 'error',
            message: 'Round is not active. Please wait for next round.',
            code: 'ROUND_NOT_ACTIVE'
        });
        return;
    }
    
    // Check if player already placed a bet
    if (gameState.bets.has(playerId)) {
        sendToPlayer(playerId, {
            type: 'error',
            message: 'You have already placed a bet for this round.',
            code: 'ALREADY_BET'
        });
        return;
    }
    
    const { numbers, betAmount } = data;
    
    // Validate numbers
    if (!numbers || !Array.isArray(numbers) || numbers.length < 1 || numbers.length > MAX_SELECT) {
        sendToPlayer(playerId, {
            type: 'error',
            message: `Please select 1-${MAX_SELECT} numbers.`,
            code: 'INVALID_NUMBERS_COUNT'
        });
        return;
    }
    
    // Validate bet amount
    if (typeof betAmount !== 'number' || betAmount < MIN_BET || betAmount > MAX_BET) {
        sendToPlayer(playerId, {
            type: 'error',
            message: `Bet amount must be between ${MIN_BET} and ${MAX_BET} ETB.`,
            code: 'INVALID_BET_AMOUNT'
        });
        return;
    }
    
    // Validate balance
    if (player.balance < betAmount) {
        sendToPlayer(playerId, {
            type: 'error',
            message: 'Insufficient balance.',
            code: 'INSUFFICIENT_BALANCE'
        });
        return;
    }
    
    // Check for duplicate numbers
    const uniqueNumbers = [...new Set(numbers)];
    if (uniqueNumbers.length !== numbers.length) {
        sendToPlayer(playerId, {
            type: 'error',
            message: 'Duplicate numbers are not allowed.',
            code: 'DUPLICATE_NUMBERS'
        });
        return;
    }
    
    // Check number range
    if (numbers.some(n => n < 1 || n > TOTAL_NUMBERS)) {
        sendToPlayer(playerId, {
            type: 'error',
            message: `Numbers must be between 1 and ${TOTAL_NUMBERS}.`,
            code: 'INVALID_NUMBER_RANGE'
        });
        return;
    }
    
    // Place bet
    const sortedNumbers = uniqueNumbers.sort((a, b) => a - b);
    gameState.bets.set(playerId, {
        numbers: sortedNumbers,
        amount: betAmount,
        placedAt: Date.now(),
        playerId: playerId
    });
    
    gameState.totalBetsAmount += betAmount;
    player.totalBets++;
    
    // Deduct from balance
    player.balance -= betAmount;
    
    console.log(`💰 Bet placed: ${playerId} - ${betAmount} ETB on [${sortedNumbers.join(', ')}]`);
    
    // Send confirmation
    sendToPlayer(playerId, {
        type: 'bet_confirmed',
        betAmount,
        numbers: sortedNumbers,
        balance: player.balance,
        round: gameState.currentRound,
        placedAt: Date.now()
    });
    
    // Broadcast updated stats
    broadcast({
        type: 'players_update',
        count: gameState.players.size,
        totalBets: gameState.bets.size
    });
}

// Handle quick pick
function handleQuickPick(playerId, data) {
    const player = gameState.players.get(playerId);
    if (!player) return;
    
    const { count = MAX_SELECT } = data;
    const numbers = [];
    const maxCount = Math.min(count, MAX_SELECT);
    
    while (numbers.length < maxCount) {
        const num = Math.floor(Math.random() * TOTAL_NUMBERS) + 1;
        if (!numbers.includes(num)) {
            numbers.push(num);
        }
    }
    
    sendToPlayer(playerId, {
        type: 'quick_pick_numbers',
        numbers: numbers.sort((a, b) => a - b),
        count: numbers.length
    });
}

// Start first round after server starts
setTimeout(() => {
    console.log('========================================');
    console.log('🎰 KENO MULTIPLAYER CASINO SERVER 🎰');
    console.log('========================================');
    console.log('Starting first round in 5 seconds...');
    startNewRound();
}, 5000);

// Clean up disconnected players
setInterval(() => {
    const now = Date.now();
    let disconnected = 0;
    
    for (const [playerId, player] of gameState.players.entries()) {
        if (now - player.lastSeen > 120000) { // 2 minutes
            player.ws.close();
            gameState.players.delete(playerId);
            gameState.bets.delete(playerId);
            disconnected++;
        }
    }
    
    if (disconnected > 0) {
        console.log(`🧹 Cleaned up ${disconnected} disconnected players`);
    }
}, 60000); // Every minute

// Serve HTML page
app.get('/', (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.send(htmlContent);
});

// API endpoints
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        serverTime: new Date().toISOString(),
        players: gameState.players.size,
        currentRound: gameState.currentRound,
        roundActive: gameState.isRoundActive,
        totalBets: gameState.bets.size,
        uptime: process.uptime()
    });
});

app.get('/stats', (req, res) => {
    res.json({
        totalPlayers: gameState.players.size,
        currentRound: gameState.currentRound,
        roundActive: gameState.isRoundActive,
        totalBets: gameState.bets.size,
        totalBetsAmount: gameState.totalBetsAmount,
        totalWinningsAmount: gameState.totalWinningsAmount,
        roundHistory: gameState.roundHistory.length,
        nextDrawTime: gameState.nextDrawTime
    });
});

app.get('/history', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);
    res.json({
        rounds: gameState.roundHistory.slice(0, limit),
        totalRounds: gameState.roundHistory.length
    });
});

// Admin reset endpoint (protected)
app.post('/admin/reset', (req, res) => {
    const { secret } = req.body;
    
    // In production, use environment variable
    if (secret !== process.env.ADMIN_SECRET && secret !== 'dev123') {
        return res.status(403).json({ error: 'Unauthorized' });
    }
    
    // Reset game state
    gameState.currentRound = 1;
    gameState.isRoundActive = false;
    gameState.drawnNumbers = [];
    gameState.bets.clear();
    gameState.roundHistory = [];
    gameState.totalBetsAmount = 0;
    gameState.totalWinningsAmount = 0;
    
    // Reset all player balances
    for (const player of gameState.players.values()) {
        player.balance = STARTING_BALANCE;
        player.totalBets = 0;
        player.totalWinnings = 0;
    }
    
    // Clear timers
    if (gameState.roundTimer) {
        clearTimeout(gameState.roundTimer);
    }
    
    // Start new round
    setTimeout(startNewRound, 5000);
    
    res.json({ 
        message: 'Game reset successfully',
        players: gameState.players.size 
    });
});

// Handle 404
app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
});

// Error handling
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

// Graceful shutdown
function gracefulShutdown() {
    console.log('🛑 Shutting down server gracefully...');
    
    // Notify all players
    broadcast({
        type: 'server_shutdown',
        message: 'Server is restarting. Please reconnect in a moment.',
        timestamp: Date.now()
    });
    
    // Close WebSocket connections
    wss.clients.forEach(client => {
        client.close();
    });
    
    // Close server
    server.close(() => {
        console.log('✅ Server closed');
        process.exit(0);
    });
    
    // Force shutdown after 10 seconds
    setTimeout(() => {
        console.log('⏰ Forcing shutdown...');
        process.exit(1);
    }, 10000);
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log('========================================');
    console.log('🚀 Server is running on port', PORT);
    console.log('🌐 WebSocket ready for real-time gameplay');
    console.log('📱 Game available at: http://localhost:' + PORT);
    console.log('📊 Stats at: http://localhost:' + PORT + '/stats');
    console.log('🏥 Health at: http://localhost:' + PORT + '/health');
    console.log('========================================\n');
    
    console.log('Game Configuration:');
    console.log('- Round Duration: 30 seconds');
    console.log('- Break Between Rounds: 30 seconds');
    console.log('- Numbers Drawn: 20');
    console.log('- Total Numbers: 80');
    console.log('- Max Selection: 10');
    console.log('- Min Bet: 1 ETB');
    console.log('- Max Bet: 1000 ETB');
    console.log('- Starting Balance: 10,000 ETB');
    console.log('========================================\n');
});