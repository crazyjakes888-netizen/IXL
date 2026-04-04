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
const recentlyLeft = {};        // name -> timestamp
const recentlyLeftTimers = {};  // name -> clearTimeout handle
const mutedIPs = {}; // ip -> expiry or 'perm'
const bannedIPs = {}; // ip -> expiry or 'perm'
const bannedNames = {}; // username -> expiry or 'perm'
let ADMIN_PASSWORD = '1648';
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

const BAD_WORDS = ['fuck','shit','bitch','dick','cock','pussy','cunt','fag','slut','whore','nigger','nigga','retard','kys'];

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
    } else if (acc.hash !== hash) {
      socket.emit('auth_result', { ok: false, msg: 'Wrong password.' });
      return;
    }

    // Kick any existing session for this username to prevent duplication
    io.sockets.sockets.forEach((existingSock, sid) => {
      if (sid !== socket.id && existingSock._authedName === uname) {
        existingSock.emit('force_logout', 'You were logged in from another location.');
        if (players[sid]) delete players[sid];
        existingSock.disconnect(true);
      }
    });

    socket._authedName = uname;
    const finalAcc = accounts[uname];
    socket.emit('auth_result', { ok: true, username: uname, cookies: finalAcc.cookies || 0, owned: finalAcc.owned || {} });
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
    const uname = (players[socket.id] && players[socket.id].name) || socket._authedName;
    if (!uname) return;
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
    if (isBlocked(safeName, bannedNames)) {
      const val = bannedNames[safeName];
      socket.emit('banned', val === 'perm' ? 'permanent' : Math.ceil((val - Date.now()) / 1000) + 's');
      socket.disconnect();
      return;
    }
    const isRejoining = !!recentlyLeft[safeName];
    // Don't delete — keep suppressing until the 30s timer expires naturally
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
    players[socket.id].lastActive = Date.now();
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

  // Pay a player
  socket.on('pay_player', ({ targetName, amount }) => {
    if (!players[socket.id]) return;
    const amt = Math.max(1, Math.floor(Number(amount) || 0));
    if (players[socket.id].cookies < amt) {
      socket.emit('pay_result', { ok: false, msg: 'Not enough cookies.' });
      return;
    }
    const target = Object.entries(players).find(([, p]) => p.name === targetName);
    if (!target) {
      socket.emit('pay_result', { ok: false, msg: `${targetName} is not online.` });
      return;
    }
    if (target[0] === socket.id) {
      socket.emit('pay_result', { ok: false, msg: "You can't pay yourself." });
      return;
    }
    players[socket.id].cookies -= amt;
    players[target[0]].cookies += amt;
    const fromName = players[socket.id].name;
    const amtStr = amt >= 1e12 ? (amt / 1e12).toFixed(1) + 'T'
                 : amt >= 1e9  ? (amt / 1e9).toFixed(1)  + 'B'
                 : amt >= 1e6  ? (amt / 1e6).toFixed(1)  + 'M'
                 : amt >= 1e3  ? (amt / 1e3).toFixed(1)  + 'K'
                 : String(amt);
    io.to(target[0]).emit('pay_received', { fromName, amount: amt });
    socket.emit('pay_result', { ok: true, msg: `Sent 🍪 ${amtStr} to ${targetName}!` });
    io.emit('chat', { system: true, msg: `💸 ${fromName} paid ${amtStr} cookies to ${targetName}!`, time: Date.now() });
  });

  // Attack
  socket.on('attack', ({ attackId, targetName }) => {
    if (!players[socket.id]) return;
    const COSTS = { freeze10: 3000, freeze20: 12000, freeze30: 35000, curse: 15000, virus: 30000, drain: 50000, timetheft: 200000, steal10k: 10000, steal100k: 100000, steal1m: 1000000 };
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

  socket.on('admin_cookies', ({ name, amount, action }) => {
    if (!admins.has(socket.id)) return;
    const entry = Object.entries(players).find(([,p]) => p.name === name);
    if (!entry) { socket.emit('admin_action_result', { ok: false, msg: `"${name}" not found.` }); return; }
    const amt = Math.max(0, parseInt(amount) || 0);
    io.to(entry[0]).emit('admin_cookie_change', { amount: amt, action });
    socket.emit('admin_action_result', { ok: true, msg: `${action === 'add' ? 'Added' : 'Removed'} ${amt} cookies ${action === 'add' ? 'to' : 'from'} ${name}.` });
  });

  socket.on('admin_setpassword', (newPassword) => {
    if (!admins.has(socket.id)) return;
    if (!newPassword || newPassword.length < 4) { socket.emit('admin_action_result', { ok: false, msg: 'Password must be at least 4 characters.' }); return; }
    ADMIN_PASSWORD = String(newPassword);
    socket.emit('admin_action_result', { ok: true, msg: `Admin password changed.` });
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

  socket.on('admin_ipban', ({ ip, duration }) => {
    if (!admins.has(socket.id)) return;
    const isPerm = duration === 'perm';
    const safeIp = String(ip).slice(0, 100);
    bannedIPs[safeIp] = isPerm ? 'perm' : Date.now() + (parseInt(duration) || 60) * 1000;
    // Kick any currently connected player with this IP
    Object.entries(players).forEach(([sid, p]) => {
      if (p.ip === safeIp) {
        io.to(sid).emit('banned', isPerm ? 'permanent' : duration + 's');
      }
    });
    const msg = isPerm ? `🔨 IP ${safeIp} permanently banned.` : `🔨 IP ${safeIp} banned for ${duration}s.`;
    socket.emit('admin_action_result', { ok: true, msg });
  });

  socket.on('admin_ban', ({ name, duration }) => {
    if (!admins.has(socket.id)) return;
    const isPerm = duration === 'perm';
    const entry = Object.entries(players).find(([,p]) => p.name === name);
    if (!entry) { socket.emit('admin_action_result', { ok: false, msg: `"${name}" not found.` }); return; }
    bannedNames[name] = isPerm ? 'perm' : Date.now() + (parseInt(duration) || 60) * 1000;
    io.to(entry[0]).emit('banned', isPerm ? 'permanent' : duration + 's');
    const msg = isPerm ? `🔨 ${name} permanently banned.` : `🔨 ${name} banned for ${duration}s.`;
    io.emit('chat', { system: true, msg, time: Date.now() });
    socket.emit('admin_action_result', { ok: true, msg });
  });

  socket.on('disconnect', () => {
    if (players[socket.id]) {
      const name = players[socket.id].name;
      // Persist latest cookie count so it isn't lost if save_progress didn't arrive
      if (accounts[name]) {
        accounts[name].cookies = Math.max(accounts[name].cookies || 0, players[socket.id].cookies || 0);
        saveAccounts();
      }
      recentlyLeft[name] = Date.now();
      if (recentlyLeftTimers[name]) clearTimeout(recentlyLeftTimers[name]);
      recentlyLeftTimers[name] = setTimeout(() => {
        delete recentlyLeft[name];
        delete recentlyLeftTimers[name];
      }, 30000);
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
  // Deduplicate online players by name (take highest cookie count per name)
  const onlineMap = {};
  Object.values(players).forEach(p => {
    if (!onlineMap[p.name] || p.cookies > onlineMap[p.name].cookies) {
      onlineMap[p.name] = p;
    }
  });

  // Start with all saved accounts as base entries
  const entryMap = {};
  Object.entries(accounts).forEach(([name, acc]) => {
    entryMap[name] = { name, cookies: acc.cookies || 0, cps: 0, online: false };
  });

  // Overlay live data for online players
  Object.entries(onlineMap).forEach(([name, p]) => {
    if (entryMap[name]) {
      entryMap[name].cookies = Math.max(entryMap[name].cookies, p.cookies);
      entryMap[name].cps = p.cps;
      entryMap[name].online = true;
    } else {
      entryMap[name] = { name, cookies: p.cookies, cps: p.cps, online: true };
    }
  });

  return Object.values(entryMap)
    .sort((a, b) => b.cookies - a.cookies);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`IXL Math running at http://localhost:${PORT}`);
});
