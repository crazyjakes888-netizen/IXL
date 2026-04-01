const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const players = {};
const recentlyLeft = {}; // name -> timestamp, suppress join spam on reconnect
const mutedIPs = {}; // ip -> expiry or 'perm'
const bannedIPs = {}; // ip -> expiry or 'perm'
const ADMIN_PASSWORD = '1648';
const admins = new Set();       // socket IDs
const adminNames = new Set();   // usernames (persists across reconnects)

const ACCOUNTS_FILE = path.join(__dirname, 'accounts.json');
let accounts = {};
try { accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8')); } catch(e) {}
function saveAccounts() {
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts));
}
function hashPw(pw) {
  return crypto.createHash('sha256').update(String(pw)).digest('hex');
}

function getIP(socket) {
  return socket.handshake.headers['x-forwarded-for']?.split(',')[0].trim() || socket.handshake.address;
}

function isBlocked(ip, store) {
  const val = store[ip];
  if (!val) return false;
  if (val === 'perm') return true;
  if (Date.now() < val) return true;
  delete store[ip];
  return false;
}

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

  socket.on('auth', ({ username, password, isRegister }) => {
    const uname = String(username).slice(0, 50).replace(/[<>&"']/g, '').trim();
    if (!uname || !password) { socket.emit('auth_result', { ok: false, msg: 'Invalid input.' }); return; }
    const hash = hashPw(password);
    const acc = accounts[uname];
    if (!acc) {
      // New account — auto-create
      accounts[uname] = { hash, cookies: 0, owned: {} };
      saveAccounts();
      socket.emit('auth_result', { ok: true, username: uname, cookies: 0, owned: {} });
    } else if (acc.hash !== hash) {
      socket.emit('auth_result', { ok: false, msg: 'Wrong password.' });
    } else {
      socket.emit('auth_result', { ok: true, username: uname, cookies: acc.cookies || 0, owned: acc.owned || {} });
    }
  });

  socket.on('autoclicker_report', ({ cps, ended, duration, locked, unlocked }) => {
    if (!players[socket.id]) return;
    const name = players[socket.id].name;
    let msg;
    if (locked) {
      msg = `🔒 [AUTOCLICKER] ${name} LOCKED for 10s — clicking ${cps} CPS`;
    } else if (unlocked) {
      msg = `🔓 [AUTOCLICKER] ${name} unlocked after 10s cooldown`;
    } else if (ended) {
      msg = `⚠️ [AUTOCLICKER] ${name} stopped — was clicking ${cps} CPS for ${duration}s`;
    } else {
      msg = `🚨 [AUTOCLICKER] ${name} suspicious! ${cps} CPS detected`;
    }
    console.log(msg);
    admins.forEach(adminId => {
      io.to(adminId).emit('admin_action_result', { ok: false, msg });
    });
  });

  socket.on('save_progress', ({ cookies, owned }) => {
    if (!players[socket.id]) return;
    const uname = players[socket.id].name;
    if (accounts[uname]) {
      accounts[uname].cookies = Math.max(0, Math.floor(Number(cookies) || 0));
      accounts[uname].owned = owned || {};
      saveAccounts();
    }
  });

  socket.on('join', (name) => {
    const ip = getIP(socket);
    if (isBlocked(ip, bannedIPs)) {
      const val = bannedIPs[ip];
      socket.emit('banned', val === 'perm' ? 'permanent' : Math.ceil((val - Date.now()) / 1000) + 's');
      socket.disconnect();
      return;
    }
    const safeName = String(name).slice(0, 50).replace(/[<>&"]/g, '') || 'Anonymous';
    const isRejoining = recentlyLeft[safeName] && (Date.now() - recentlyLeft[safeName] < 30000);
    delete recentlyLeft[safeName];
    players[socket.id] = { name: safeName, cookies: 0, cps: 0, lastChat: 0, ip };

    socket.emit('joined', { id: socket.id, name: safeName });
    io.emit('leaderboard', getLeaderboard());

    if (!isRejoining) {
      io.emit('chat', {
        system: true,
        msg: `${safeName} joined the game!`,
        time: Date.now()
      });
    }
    // Restore admin status if they were admin before
    if (adminNames.has(safeName)) admins.add(socket.id);
  });

  socket.on('update_score', ({ cookies, cps }) => {
    if (!players[socket.id]) return;
    players[socket.id].cookies = Math.max(0, Math.floor(Number(cookies) || 0));
    players[socket.id].cps = Math.max(0, Number(cps) || 0);
  });

  socket.on('chat_msg', (msg) => {
    if (!players[socket.id]) return;
    const ip = players[socket.id]?.ip || getIP(socket);
    if (isBlocked(ip, mutedIPs)) {
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

  // Attack
  socket.on('attack', ({ attackId, targetName }) => {
    if (!players[socket.id]) return;
    const COSTS = { freeze: 2000, curse: 15000, virus: 30000, drain: 50000, timetheft: 200000, confuse: 100000 };
    const cost = COSTS[attackId];
    if (!cost) return;
    if (players[socket.id].cookies < cost) return;
    const target = Object.entries(players).find(([,p]) => p.name === targetName);
    if (!target) return;
    players[socket.id].cookies -= cost;
    io.to(target[0]).emit('attack_hit', { attackId, attackerName: players[socket.id].name });
    io.emit('chat', {
      system: true,
      msg: `⚔️ ${players[socket.id].name} used ${attackId} on ${targetName}!`,
      time: Date.now()
    });
  });

  // Admin login
  socket.on('admin_login', (password) => {
    if (password === ADMIN_PASSWORD) {
      admins.add(socket.id);
      if (players[socket.id]) adminNames.add(players[socket.id].name);
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
    if (!entry) { socket.emit('admin_action_result', { ok: false, msg: `"${targetName}" not found.` }); return; }
    mutedIPs[entry[1].ip] = 'perm';
    io.emit('chat', { system: true, msg: `🔇 ${targetName} was permanently muted.`, time: Date.now() });
    socket.emit('admin_action_result', { ok: true, msg: `Permanently muted ${targetName} (IP-locked).` });
  });

  socket.on('admin_unmute', (targetName) => {
    if (!admins.has(socket.id)) return;
    const entry = Object.entries(players).find(([,p]) => p.name === targetName);
    if (!entry) { socket.emit('admin_action_result', { ok: false, msg: `"${targetName}" not found.` }); return; }
    delete mutedIPs[entry[1].ip];
    io.emit('chat', { system: true, msg: `🔊 ${targetName} was unmuted.`, time: Date.now() });
    socket.emit('admin_action_result', { ok: true, msg: `Unmuted ${targetName}.` });
  });

  socket.on('admin_clearchat', () => {
    if (!admins.has(socket.id)) return;
    io.emit('chat_clear');
    socket.emit('admin_action_result', { ok: true, msg: 'Chat cleared.' });
  });

  socket.on('admin_timeout', ({ name, seconds }) => {
    if (!admins.has(socket.id)) return;
    const secs = Math.max(1, parseInt(seconds) || 30);
    const entry = Object.entries(players).find(([,p]) => p.name === name);
    if (!entry) { socket.emit('admin_action_result', { ok: false, msg: `"${name}" not found.` }); return; }
    mutedIPs[entry[1].ip] = Date.now() + secs * 1000;
    io.emit('chat', { system: true, msg: `⏱️ ${name} timed out for ${secs}s.`, time: Date.now() });
    socket.emit('admin_action_result', { ok: true, msg: `Timed out ${name} for ${secs}s.` });
  });

  socket.on('admin_wipeaccount', (targetName) => {
    if (!admins.has(socket.id)) return;
    if (accounts[targetName]) {
      delete accounts[targetName];
      saveAccounts();
      socket.emit('admin_action_result', { ok: true, msg: `Wiped account: ${targetName}` });
    } else {
      socket.emit('admin_action_result', { ok: false, msg: `No account found: ${targetName}` });
    }
  });

  socket.on('admin_ban', ({ name, duration }) => {
    if (!admins.has(socket.id)) return;
    const isPerm = duration === 'perm';
    const entry = Object.entries(players).find(([,p]) => p.name === name);
    if (!entry) { socket.emit('admin_action_result', { ok: false, msg: `"${name}" not found.` }); return; }
    bannedIPs[entry[1].ip] = isPerm ? 'perm' : Date.now() + (parseInt(duration) || 60) * 1000;
    io.to(entry[0]).emit('banned', isPerm ? 'permanent' : duration + 's');
    const msg = isPerm ? `🔨 ${name} permanently banned.` : `🔨 ${name} banned for ${duration}s.`;
    io.emit('chat', { system: true, msg, time: Date.now() });
    socket.emit('admin_action_result', { ok: true, msg });
  });

  socket.on('disconnect', () => {
    if (players[socket.id]) {
      const name = players[socket.id].name;
      recentlyLeft[name] = Date.now();
      setTimeout(() => { if (recentlyLeft[name]) delete recentlyLeft[name]; }, 30000);
      delete players[socket.id];
      admins.delete(socket.id);
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
    name: p.name, cookies: p.cookies
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
