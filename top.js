// ----- Imports -----
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const path = require("path");
const https = require('https');
const { receipt, utils: { loadReceipt, parseFromHTML } } = require('telebirr-receipt');
const { v4: uuid } = require("uuid");
const { Low } = require("lowdb");
const { JSONFile } = require("lowdb/node");
const fs = require('fs');
let fixedCardsSet = [];
// ----- Lowdb Setup -----
const adapter = new JSONFile("bingo.json");
const db = new Low(adapter, { rooms: [], players: [], requests: [] });
process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = 0;

const allClients = new Set();

// ----------------------
// 🔹 1. Parse Telebirr Message
// ----------------------
function parseTelebirrMessage(message) {
  if (!message) return { amount: null, transactionNumber: null, toName: null };

  // Match amount like "ETB 150.00" or "ETB150.00"
  const amountMatch = message.match(/ETB\s*([\d,.]+)/i);

  // Match transaction number like "Your transaction number is CJ90DLPKBK"
  const txnMatch = message.match(/transaction number is\s*([A-Z0-9]+)/i);

  // Match recipient name like "to NATNAEL GIRMA"
  const toMatch = message.match(/to\s+([A-Z\s]+)\s*\(/i);

  return {
    amount: amountMatch ? parseFloat(amountMatch[1].replace(/,/g, "")) : null,
    transactionNumber: txnMatch ? txnMatch[1].trim() : null,
    toName: toMatch ? toMatch[1].trim() : null
  };
}
 

// ----- Initialize DB -----
const adminPhones = ["0912735222"];

async function initDB() {
  await db.read();

  if (!db.data.rooms || db.data.rooms.length === 0) {
    db.data.rooms = [
      { roomId: "room_10", cost: 10, jackpot: 0, numbersCalled: [], gameStarted: 0, currentCountdown: 60 },
      { roomId: "room_20", cost: 20, jackpot: 0, numbersCalled: [], gameStarted: 0, currentCountdown: 60 },
      { roomId: "room_50", cost: 50, jackpot: 0, numbersCalled: [], gameStarted: 0, currentCountdown: 60 },
      { roomId: "room_100", cost: 100, jackpot: 0, numbersCalled: [], gameStarted: 0, currentCountdown: 60 },
    ];
  }

  if (!db.data.players) db.data.players = [];

  // Create admin users
  for (const phone of adminPhones) {
    let adminUser = db.data.players.find(u => u.phone === phone);
    if (!adminUser) {
      db.data.players.push({
        phone: phone,
        username: "Admin",
        balance: 1000,
        wins: 0,
        gamesPlayed: 0
      });
      console.log(`✅ Admin created with phone: ${phone}`);
    }
  }

  await db.write();
}

function loadFixedCards() {
  try {
    const data = fs.readFileSync('fixed_bingo_cards.json', 'utf-8');
    fixedCardsSet = JSON.parse(data);
    console.log(`Loaded ${fixedCardsSet.length} fixed bingo cards`);
  } catch (err) {
    console.error('Failed to load fixed bingo cards:', err);
  }
}
// ----- Express + WebSocket -----
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ----- In-memory rooms -----
const rooms = {};
const players = new Map(); // ws -> player info

// ----- Load rooms into memory -----
async function loadRooms() {
  await db.read();
  db.data.rooms.forEach(r => {
    rooms[r.roomId] = {
      players: [],
      cards: fixedCardsSet.map((data, idx) => ({
        id: idx + 1,
        data,
        takenBy: null
      })),
      gameStarted: !!r.gameStarted,
      numbersCalled: r.numbersCalled || [],
      cost: r.cost,
      jackpot: r.jackpot,
      gameInterval: null,
      countdown: null,
      countdownTime: r.currentCountdown || 60,
      currentCountdown: r.currentCountdown || 60,
    };
  });
}

// ----- Card Sending -----

function sendRoomCards(ws, roomId, phase = "selection") {
  const room = rooms[roomId];
  if (!room) return;

  if (phase === "selection") {
    // Only send card IDs for selection phase
    ws.send(JSON.stringify({
      type: "show_cards",
      phase: "selection",
      roomId,
      allCards: room.cards.map(c => ({
        id: c.id,
        takenBy: c.takenBy
      }))
    }));
  } else if (phase === "game") {
    // Send the player's actual cards (with full 5x5 numbers)
    ws.send(JSON.stringify({
      type: "show_cards",
      phase: "game",
      roomId,
      cards: ws.cards // ws.cards contains full formatted 5x5 grids
    }));
  }
}

function formatCardForClient(card) {
  // card.data is flat 25 elements (see generateBingoCard)
  // Convert values to numeric when possible; ensure free cell becomes 0.
  const sliceToNums = (arr) => arr.map(n => (n === "FREE" || n === null || n === undefined) ? 0 : Number(n));

  const B = sliceToNums(card.data.slice(0, 5));
  const I = sliceToNums(card.data.slice(5, 10));
  const N = sliceToNums(card.data.slice(10, 15));
  const G = sliceToNums(card.data.slice(15, 20));
  const O = sliceToNums(card.data.slice(20, 25));

  return { B, I, N, G, O }; // client expects this shape
}
// ----- Utilities -----
function calcJackpot(room) {
  return Math.floor(room.players.length * room.cost * 0.9);
}

function generateBingoCard() {
  const card = [];
  const columns = { B: [1, 15], I: [16, 30], N: [31, 45], G: [46, 60], O: [61, 75] };

  for (const [_, [min, max]] of Object.entries(columns)) {
    const nums = [];
    while (nums.length < 5) {
      const n = Math.floor(Math.random() * (max - min + 1)) + min;
      if (!nums.includes(n)) nums.push(n);
    }
    card.push(...nums);
  }

  // center free cell should be numeric 0 so checkBingo/extractWinningPattern work
  card[12] = 0;
  return card; // flat 25-element array: B[0..4], I[0..4], N[0..4], G[0..4], O[0..4]
}
function generateRoomCards() {
  return Array.from({ length: 100 }, (_, i) => ({ id: i + 1, data: generateBingoCard(), takenBy: null }));
}

function updateRoomStatus() {
  const status = {};
  for (const id in rooms) {
    const room = rooms[id];
    status[id] = {
      players: room.players.length,
      jackpot: calcJackpot(room),
      cost: room.cost,
      gameStarted: room.gameStarted,
      calledNumbersCount: room.numbersCalled.length,
    };
  }
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: "room_status_update", room_status: status }));
    }
  });
}

// ----- Broadcast helper -----
function broadcastToRoom(roomId, message) {
  const room = rooms[roomId];
  if (!room) return;

  room.players.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  });
}

function broadcastToAll(message) {
  allClients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  });
}

function sendRequestsToAll() {
  const requests = db.data.requests || [];

  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      if (client.isAdmin) {
        // Admin sees all
        client.send(JSON.stringify({
          type: "requests_data",
          requests
        }));
      } else if (client.userId) {
        // Normal users see only their requests
        const userRequests = requests.filter(r => r.userId === client.userId);
        client.send(JSON.stringify({
          type: "requests_data",
          requests: userRequests
        }));
      }
    }
  });
}

function checkBingo(card, numbersCalled) {
  const BINGO = ["B", "I", "N", "G", "O"];
  const isLineMarked = line => line.every(num => num === 0 || numbersCalled.includes(num));

  // Check each column
  for (const l of BINGO) {
    if (isLineMarked(card[l])) return true;
  }

  // Check each row
  for (let row = 0; row < 5; row++) {
    const rowNums = BINGO.map(l => card[l][row]);
    if (isLineMarked(rowNums)) return true;
  }

  // Check diagonals
  const diag1 = BINGO.map((l, i) => card[l][i]);
  const diag2 = BINGO.map((l, i) => card[BINGO[4 - i]][i]);
  if (isLineMarked(diag1) || isLineMarked(diag2)) return true;

  return false;
}
function extractWinningPattern(card, numbersCalled) {
  const BINGO = ["B", "I", "N", "G", "O"];
  const isMarked = n => n === 0 || numbersCalled.includes(n);

  // Columns
  for (let c = 0; c < 5; c++) {
    const colNums = card[BINGO[c]];
    if (colNums.every(isMarked))
      return colNums.map((n, r) => [r, c]); // [row, col]
  }

  // Rows
  for (let r = 0; r < 5; r++) {
    const rowNums = BINGO.map(l => card[l][r]);
    if (rowNums.every(isMarked))
      return rowNums.map((n, c) => [r, c]);
  }

  // Diagonals
  const diag1 = BINGO.map((l, i) => card[l][i]);
  if (diag1.every(isMarked)) return diag1.map((n, i) => [i, i]);

  const diag2 = BINGO.map((l, i) => card[BINGO[4 - i]][i]);
  if (diag2.every(isMarked)) return diag2.map((n, i) => [i, 4 - i]);

  return null;
}
  
// ----- Game Loop -----

function startGame(roomId) {
const room = rooms[roomId];
if (!room || room.gameStarted) return;

room.gameStarted = true;
room.numbersCalled = [];

const availableNumbers = Array.from({ length: 75 }, (_, i) => i + 1);

room.gameInterval = setInterval(() => {
if (!availableNumbers.length || !room.players.length) {
clearInterval(room.gameInterval);
room.gameStarted = false;
 // 🔥 RESET CARDS FOR NEXT GAME
      room.cards.forEach(card => {
        card.takenBy = null;
      });
room.players.forEach(p => p.send(JSON.stringify({ type: "game_end" })));
return;
}

const num = availableNumbers.splice(Math.floor(Math.random() * availableNumbers.length), 1)[0];  
room.numbersCalled.push(num);  

room.players.forEach(p => {  
  if (p.readyState === WebSocket.OPEN) {  
    p.send(JSON.stringify({  
      type: "number_called",  
      number: num,  
      calledNumbers: room.numbersCalled,  
      countdown: false  
    }));  
  }  
});

}, 3000);
}


    
      
function startRoomCountdown(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  // Prevent multiple countdowns for same room
  if (room.countdown) return;

  // Use room's currentCountdown if it exists, otherwise default to 60
  let countdownTime = room.currentCountdown || 60;

  // Save countdown interval reference
  room.countdown = setInterval(() => {

    // 1️⃣ Broadcast to players inside the room (called number circle)
    broadcastToRoom(roomId, {
      type: "countdown",
      roomId,
      timeLeft: countdownTime
    });

    // 2️⃣ Broadcast to ALL clients for front page room selection
    broadcastToAll({
      type: "room_countdown",
      roomId,
      timeLeft: countdownTime
    });

    // Update room's current countdown so new joiners see correct time
    room.currentCountdown = countdownTime;

    countdownTime--;

    // Countdown finished
    if (countdownTime < 0) {
      clearInterval(room.countdown);
      room.countdown = null;
      room.currentCountdown = 60; // reset for next game

      // Notify front page that countdown finished
      broadcastToAll({
        type: "room_countdown",
        roomId,
        timeLeft: 0
      });
      
      // Important reset
  room.cards.forEach(card => {
    card.takenBy = null;
  });

      // Start the actual game
      startGame(roomId);
    }
  }, 1000);

  // 3️⃣ Send cards immediately for review phase
  room.players.forEach(ws => {
    const assignedCards = room.cards.filter(c => c.takenBy === ws.phone);
    ws.cards = assignedCards.map(c => formatCardForClient(c));
    ws.send(JSON.stringify({
      type: "show_cards",
      phase: "review",
      roomId,
      cards: ws.cards
    }));
  });
}
  
    
            
// ----- WebSocket -----
wss.on("connection", ws => {
  ws.id = uuid();
  console.log(`Client connected: ${ws.id}`);
  // Add to global set
  allClients.add(ws);

  ws.on("close", () => {
    // Remove when disconnected
    allClients.delete(ws);
    console.log(`Client disconnected: ${ws.id}`);
  }); 

  ws.on("message", async msg => {
    let data;
    try { data = JSON.parse(msg); } catch { return; }

    switch (data.type) {
  
      case "get_player_data": {
  await db.read();

  // 🔹 Expect phone number instead of userId
  const phone = data.phone;

  if (!phone) {
    ws.send(JSON.stringify({
      type: "error",
      message: "Phone number required."
    }));
    break;
  }

  // 🔹 Find or create the user
  let user = db.data.players.find(u => u.phone === phone);
  if (!user) {
    user = {
      phone,
      username: `Player_${phone}`,
      balance: 1000,
      wins: 0,
      gamesPlayed: 0
    };
    db.data.players.push(user);
    await db.write();
  }

  // ✅ Save phone and admin status on socket
  ws.phone = phone;
  ws.isAdmin = adminPhones.includes(phone);

  // ✅ Prepare data to send back to client
  const playerData = {
    type: "player_data",
    phone: user.phone,
    username: user.username,
    balance: user.balance,
    wins: user.wins,
    gamesPlayed: user.gamesPlayed,
    isAdmin: ws.isAdmin, // ✅ use ws.isAdmin instead of isAdmin
    requests: ws.isAdmin ? db.data.requests || [] : [] // ✅ only send requests to admins
  };

  // 🧾 Log it for debugging
  //console.log("📤 Sending player data to client:", playerData);

  // ✅ Send to client
  ws.send(JSON.stringify(playerData));

  break;
}
  
                   
case "join_room": {
  const { roomId, phone } = data;
  const room = rooms[roomId];
  if (!room) break;

  // Attach phone to socket
  ws.phone = phone;

  // Ensure the room has players and cards arrays
  if (!room.players) room.players = [];
  if (!room.cards) {
    // Create bingo cards if not yet initialized
    room.cards = generateBingoCards(); // <-- Replace with your existing card creation logic
  }

  // Initialize player's own cards array (for safety)
  ws.cards = [];

  // Add player socket to room
  room.players.push(ws);

  // If player rejoined, restore any previous cards assigned to their phone
  const previousCards = room.cards.filter(c => c.takenBy === phone);
  if (previousCards.length > 0) {
    ws.cards = previousCards;
    console.log(`♻️ Restored ${previousCards.length} cards for ${phone}`);
  }

  // Send room join confirmation with all card info
  ws.send(JSON.stringify({
    type: "room_joined",
    roomId,
    phone,
    allCards: room.cards.map(c => ({
      id: c.id,
      takenBy: c.takenBy || null
    }))
  }));

  console.log(`✅ ${phone} joined ${roomId}`);
  break;
}
case "get_user_requests": {
  await db.read();

  const userRequests = db.data.requests.filter(r => r.phone === data.phone);
  ws.send(JSON.stringify({
    type: "requests_data",
    requests: userRequests
  }));

  break;
}
case "request_withdrawal": {
  const { phone, amount } = data;
  await db.read();

  const user = db.data.players.find(u => u.phone === phone);
  if (!user) {
    ws.send(JSON.stringify({
      type: "withdraw_response",
      success: false,
      message: "User not found."
    }));
    break;
  }

  // Validation
  if (amount <= 0) {
    ws.send(JSON.stringify({
      type: "withdraw_response",
      success: false,
      message: "Invalid withdrawal amount."
    }));
    break;
  }

  if (user.balance < amount) {
    ws.send(JSON.stringify({
      type: "withdraw_response",
      success: false,
      message: "❌ Insufficient balance for withdrawal."
    }));
    break;
  }

  // Create pending withdrawal request
  const withdrawRequest = {
    id: uuid(),
    phone,
    type: "withdrawal",
    amount,
    status: "pending",
    createdAt: new Date().toISOString()
  };

  db.data.requests.push(withdrawRequest);
  await db.write();

  // ✅ Send confirmation to user
  ws.send(JSON.stringify({
    type: "withdraw_response",
    success: true,
    message: `✅ Withdrawal request for ETB ${amount} submitted. Awaiting approval.`,
    balance: user.balance
  }));

   
   
  // ✅ Broadcast updated requests to all connected clients (admin + user)
  sendRequestsToAll();
  
  console.log(`💸 Withdrawal request created for phone ${phone}, amount ETB ${amount}`);
  break;
}
 
  
  // Send card IDs and takenBy for selection pha        

      case "get_cards": {
  const { roomId } = data;
  const room = rooms[roomId];
  if (!room) break;

  // Send all cards (id + takenBy) for selection
  ws.send(JSON.stringify({
    type: "room_cards",
    roomId,
    cards: room.cards.map(c => ({
      id: c.id,
      takenBy: c.takenBy || null
    }))
  }));
  break;
}

     case "select_card": {
  const room = rooms[data.roomId];
  if (!room) break;

  const card = room.cards.find(c => c.id === data.cardId);
  if (!card) {
    ws.send(JSON.stringify({ type: "card_rejected", reason: "Card not found" }));
    break;
  }

  if (card.takenBy && card.takenBy !== data.phone) {
    ws.send(JSON.stringify({ type: "card_rejected", reason: "Already taken" }));
    break;
  }

  const userCards = room.cards.filter(c => c.takenBy === data.phone);
  if (userCards.length >= 4) {
    ws.send(JSON.stringify({ type: "card_rejected", reason: "Max 4 cards reached" }));
    break;
  }

  // ✅ Assign the card to the user
  card.takenBy = data.phone;

  // ✅ Store card reference on the socket
  if (!ws.cards) ws.cards = [];
  const formatted = formatCardForClient(card);
  ws.cards.push(formatted);

  // ✅ ALSO store player cards inside the room for persistence
  if (!room.playerCards) room.playerCards = {};
  if (!room.playerCards[data.phone]) room.playerCards[data.phone] = [];
  room.playerCards[data.phone].push(card);

  // ✅ Notify only this user
  ws.send(JSON.stringify({
    type: "card_selected",
    roomId: data.roomId,
    cardId: card.id,
    phone: data.phone
  }));

  // ✅ Notify everyone else the card is now taken
  room.players.forEach(p => {
    if (p.readyState === WebSocket.OPEN) {
      p.send(JSON.stringify({
        type: "card_taken",
        roomId: data.roomId,
        cardId: card.id,
        phone: data.phone
      }));
    }
  });

  updateRoomStatus();
  break;
}
        case "claim_bingo": {
  const room = rooms[data.roomId];
  if (!room) {
    console.log("❌ claim_bingo: no room for id", data.roomId);
    return;
  }

  const playerPhone = data.phone; // ✅ use phone from client
  console.log("🎯 claim_bingo request from socket:", ws.phone || ws.id, "for player:", playerPhone);

  // find the player's socket in the room (room.players holds ws objects)
  const player = room.players.find(p => p.phone === playerPhone);
  if (!player) {
    console.log("❌ claim_bingo: player not found in room:", playerPhone, "players:", room.players.map(p => p.phone));
    ws.send(JSON.stringify({ type: "invalid_bingo" }));
    return;
  }

  if (!player.cards || !Array.isArray(player.cards) || player.cards.length === 0) {
    console.log("❌ claim_bingo: no cards for player:", playerPhone);
    ws.send(JSON.stringify({ type: "invalid_bingo" }));
    return;
  }

  console.log("✅ claim_bingo: checking player.cards for player:", playerPhone);
  console.log("Player cards:", player.cards);
  console.log("Numbers called:", room.numbersCalled);

  let winningCard = null;
  let winningPattern = null;

  for (const card of player.cards) {
    if (checkBingo(card, room.numbersCalled)) {
      winningCard = card;
      winningPattern = extractWinningPattern(card, room.numbersCalled);
      break;
    }
  }

  if (!winningCard) {
    console.log("❌ claim_bingo: no winning card found for player:", playerPhone);
    ws.send(JSON.stringify({ type: "invalid_bingo" }));
    return;
  }

  // winningCard found: award jackpot, update DB
  const jackpot = calcJackpot(room);
  await db.read();
  const user = db.data.players.find(u => u.phone === playerPhone);
  if (user) {
    user.balance += jackpot;
    user.wins++;
    await db.write();
    console.log("💾 claim_bingo: updated user balance and wins for", playerPhone);
  }

  // broadcast result using keys the client expects:
  room.players.forEach(p => {
    if (p.readyState === WebSocket.OPEN) {
      p.send(JSON.stringify({
        type: "bingo_win",
        winnerPhone: playerPhone, // ✅ renamed field
        winningCard,
        winningPattern
      }));
      p.send(JSON.stringify({ type: "game_end" }));
    }
  });

  clearInterval(room.gameInterval);
  room.gameStarted = false;
  room.numbersCalled = [];
  updateRoomStatus();
  break;
}
  
  
     
      case "start_game": {
  const { roomId, phone } = data;
  const room = rooms[roomId];
  if (!room) return;

  // Ensure the player actually has cards selected
  const playerCards = room.cards.filter(c => c.takenBy === phone);
  if (!playerCards.length) {
    ws.send(JSON.stringify({
      type: "error",
      message: "No cards selected"
    }));
    return;
  }

  // 💰 Deduct balance before countdown
  await db.read();
  const user = db.data.players.find(u => u.phone === phone);
  if (user) {
    if (user.balance >= room.cost) {
      user.balance -= room.cost;
      await db.write();
      ws.send(JSON.stringify({ type: "balance_update", newBalance: user.balance }));
    } else {
      ws.send(JSON.stringify({ type: "error", message: "Insufficient balance to start game" }));
      return;
    }
  }

  // Assign formatted cards to the player object
    ws.cards = playerCards.map(c => formatCardForClient(c));
    
    // Also store cards in the room object (for validation later)
if (!room.playerCards) room.playerCards = {};
room.playerCards[phone] = playerCards;
    
    // Notify player with their cards
    ws.send(JSON.stringify({
        type: "show_cards",
        phase: "game",
        roomId,
        cards: ws.cards
    }));

 if (!room.gameStarted && !room.countdown) {
  startRoomCountdown(roomId);
} 
  
  break;
}

case "get_admin_requests": {
  await db.read();
  if (!ws.isAdmin) return;
  const adminRequests = db.data.requests.filter(r => r.type === "withdrawal");
  ws.send(JSON.stringify({
    type: "requests_data",
    requests: adminRequests
  }));
  break;
}
// ----------------------
// 🔹 2. Handle Deposit Request
// ----------------------
case 'request_deposit': {
  const { phone, telebirrMessage } = data;  // ✅ use phone instead of userId
  await db.read(); // make sure DB is loaded

  // Parse the Telebirr message
  const { amount, transactionNumber, toName } = parseTelebirrMessage(telebirrMessage);

  // Validate amount and transaction
  if (!amount || !transactionNumber || !toName) {
    ws.send(JSON.stringify({
      type: 'deposit_response',
      success: false,
      message: '❌ Invalid Telebirr message. Please paste the full SMS.'
    }));
    return;
  }

  // Validate recipient
  if (toName.toUpperCase() !== 'NATNAEL GIRMA') {
    ws.send(JSON.stringify({
      type: 'deposit_response',
      success: false,
      message: `⚠️ This payment was sent to ${toName}, not NATNAEL GIRMA. Deposit rejected.`
    }));
    return;
  }

  // Check for duplicate transaction
  const existingTxn = db.data.requests.find(r => r.telebirrTransactionNumber === transactionNumber);
  if (existingTxn) {
    ws.send(JSON.stringify({
      type: 'deposit_response',
      success: false,
      message: '⚠️ This Telebirr transaction was already used.'
    }));
    return;
  }

  // ✅ Find user by phone
  let user = db.data.players.find(u => u.phone === phone);
  if (!user) {
    ws.send(JSON.stringify({
      type: 'deposit_response',
      success: false,
      message: 'User not found. Please make sure your phone number is correct.'
    }));
    return;
  }

  // ✅ Credit user balance
  user.balance = (user.balance || 0) + amount;

  // ✅ Log request
  db.data.requests.push({
    id: uuid(),
    phone,  // store phone instead of userId
    type: 'deposit',
    amount,
    telebirrMessage,
    telebirrTransactionNumber: transactionNumber,
    status: 'approved',
    createdAt: new Date().toISOString()
  });

  await db.write();

  // ✅ Send success response
  ws.send(JSON.stringify({
    type: 'deposit_response',
    success: true,
    message: `✅ Telebirr deposit of ETB ${amount} credited successfully!`,
    newBalance: user.balance
  }));

  console.log(`💰 Credited ETB ${amount} to user ${phone} (Txn: ${transactionNumber})`);
  break;
}
  
 case "approve_request":
case "reject_request": {
  await db.read();

  // Find the request by ID
  const req = db.data.requests.find(r => r.id === data.requestId);
  if (!req) {
    ws.send(JSON.stringify({ type: "error", message: "Request not found." }));
    break;
  }

  if (req.type !== "withdrawal") {
    ws.send(JSON.stringify({ type: "error", message: "Only withdrawal requests can be approved/rejected." }));
    break;
  }

  // Update request status
  req.status = data.type === "approve_request" ? "approved" : "rejected";
  await db.write();

  // If approved: deduct user's balance
  if (req.status === "approved") {
    const user = db.data.players.find(u => u.phone === req.phone);
    if (user) {
      user.balance = (user.balance || 0) - req.amount;
      await db.write();
    }
  }

  // Notify admin who performed the action
  ws.send(JSON.stringify({
    type: "request_action_success",
    requestId: req.id,
    status: req.status
  }));

  // Notify all admins with updated requests list
  sendRequestsToAll();

  // Notify the user who made the request (if connected)
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && client.phone === req.phone) {
      // Send updated request entry
      client.send(JSON.stringify({
        type: "request_update",
        request: req
      }));

      // Send updated balance if approved
      if (req.status === "approved") {
        const user = db.data.players.find(u => u.phone === req.phone);
        if (user) {
          client.send(JSON.stringify({ type: "balance_update", newBalance: user.balance }));
        }
      }
    }
  });

  break;
}
  
    
 // close message listener
}  

}); 
     
  ws.on("close", () => {
    const player = players.get(ws);
    if (player && player.roomId) {
      const room = rooms[player.roomId];
      room.players = room.players.filter(p => p.phone !== ws.phone);
      updateRoomStatus();
    }
    players.delete(ws);
  });
});

// ----- Serve frontend -----
app.use(express.static(__dirname)); // serve static files like banner2.jpg
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ----- Start server -----
(async () => {
  await initDB();
  loadFixedCards();
  await loadRooms();
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
})();
