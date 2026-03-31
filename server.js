const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const players = {}; // socketId -> { name, cookies, cps }
const muted = new Set(); // muted socket IDs
const ADMIN_PASSWORD = '1648';
const admins = new Set();

const BAD_WORDS = ['fuck','shit','bitch','dick','cock','pussy','cunt','fag','slut','whore','nigger','nigga','retard','kys','ass','piss','bastard','damn','hell','crap'];

// Normalize leetspeak and common substitutions for comparison only
function normalize(str, parenAs = 'i') {
  return str.toLowerCase()
    .replace(/[@4]/g,'a')
    .replace(/[38]/g,'e')
    .replace(/[1!|]/g,'i')
    .replace(/\(/g, parenAs)
    .replace(/[0]/g,'o')
    .replace(/[$5]/g,'s')
    .replace(/[7]/g,'t')
    .replace(/[^a-z]/g,'');
}

function isBad(norm) {
  return BAD_WORDS.some(bad => norm === bad || norm.includes(bad));
}

function filterMsg(text) {
  return text.replace(/\S+/g, word => {
    if (isBad(normalize(word, 'i')) || isBad(normalize(word, 'c'))) {
      return '*'.repeat(word.length);
    }
    return word;
  });
}

io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`);

  socket.on('join', (name) => {
    const safeName = String(name).slice(0, 20).replace(/[<>&"]/g, '') || 'Anonymous';
    players[socket.id] = { name: safeName, cookies: 0, cps: 0, lastChat: 0 };

    socket.emit('joined', { id: socket.id, name: safeName });

    // Send chat history + current leaderboard
    io.emit('leaderboard', getLeaderboard());

    io.emit('chat', {
      system: true,
      msg: `${safeName} joined the game!`,
      time: Date.now()
    });
  });

  socket.on('update_score', ({ cookies, cps }) => {
    if (!players[socket.id]) return;
    players[socket.id].cookies = Math.max(0, Math.floor(Number(cookies) || 0));
    players[socket.id].cps = Math.max(0, Number(cps) || 0);
  });

  socket.on('chat_msg', (msg) => {
    if (!players[socket.id]) return;
    if (muted.has(socket.id)) {
      socket.emit('chat_cooldown', 'muted');
      return;
    }
    const now = Date.now();
    if (now - players[socket.id].lastChat < 5000) {
      socket.emit('chat_cooldown', Math.ceil((5000 - (now - players[socket.id].lastChat)) / 1000));
      return;
    }
    players[socket.id].lastChat = now;
    const safeMsg = String(msg).slice(0, 200).replace(/[<>&"]/g, (c) =>
      ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c])
    );
    if (!safeMsg.trim()) return;
    const filteredMsg = filterMsg(safeMsg);
    io.emit('chat', {
      name: players[socket.id].name,
      msg: filteredMsg,
      time: Date.now()
    });
  });

  // Admin login
  socket.on('admin_login', (password) => {
    if (password === ADMIN_PASSWORD) {
      admins.add(socket.id);
      socket.emit('admin_result', { success: true });
      socket.emit('admin_playerlist', getPlayerList());
    } else {
      socket.emit('admin_result', { success: false });
    }
  });

  // Admin actions
  socket.on('admin_mute', (targetName) => {
    if (!admins.has(socket.id)) return;
    const entry = Object.entries(players).find(([,p]) => p.name === targetName);
    if (entry) {
      muted.add(entry[0]);
      io.emit('chat', { system: true, msg: `🔇 ${targetName} has been muted by admin.`, time: Date.now() });
      socket.emit('admin_playerlist', getPlayerList());
    }
  });

  socket.on('admin_unmute', (targetName) => {
    if (!admins.has(socket.id)) return;
    const entry = Object.entries(players).find(([,p]) => p.name === targetName);
    if (entry) {
      muted.delete(entry[0]);
      io.emit('chat', { system: true, msg: `🔊 ${targetName} has been unmuted by admin.`, time: Date.now() });
      socket.emit('admin_playerlist', getPlayerList());
    }
  });

  socket.on('admin_reset', (targetName) => {
    if (!admins.has(socket.id)) return;
    const entry = Object.entries(players).find(([,p]) => p.name === targetName);
    if (entry) {
      players[entry[0]].cookies = 0;
      players[entry[0]].cps = 0;
      io.to(entry[0]).emit('admin_reset_you');
      io.emit('chat', { system: true, msg: `🔄 ${targetName}'s score was reset by admin.`, time: Date.now() });
    }
  });

  socket.on('admin_clearchat', () => {
    if (!admins.has(socket.id)) return;
    io.emit('chat_clear');
    io.emit('chat', { system: true, msg: '🧹 Chat was cleared by admin.', time: Date.now() });
  });

  socket.on('disconnect', () => {
    if (players[socket.id]) {
      const name = players[socket.id].name;
      delete players[socket.id];
      admins.delete(socket.id);
      muted.delete(socket.id);
      io.emit('chat', { system: true, msg: `${name} left the game.`, time: Date.now() });
      io.emit('leaderboard', getLeaderboard());
    }
  });
});

// Push leaderboard to all clients every 2 seconds
setInterval(() => {
  io.emit('leaderboard', getLeaderboard());
}, 2000);

function getPlayerList() {
  return Object.entries(players).map(([id, p]) => ({
    name: p.name, muted: muted.has(id), cookies: p.cookies
  }));
}

function getLeaderboard() {
  return Object.values(players)
    .sort((a, b) => b.cookies - a.cookies)
    .slice(0, 10)
    .map(p => ({ name: p.name, cookies: p.cookies, cps: p.cps }));
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Cookie Chat running at http://localhost:${PORT}`);
});
