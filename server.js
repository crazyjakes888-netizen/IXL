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
app.use(express.json());

// Beacon save — called by navigator.sendBeacon on page close, guaranteed delivery
app.post('/save', (req, res) => {
  const { username, cookies, owned } = req.body || {};
  if (username && accounts[username]) {
    accounts[username].cookies = Math.max(0, Math.floor(Number(cookies) || 0));
    if (owned) accounts[username].owned = owned;
    saveAccounts();
  }
  res.sendStatus(200);
});

const players = {};
const recentlyLeft = {};        // name -> timestamp
const recentlyLeftTimers = {};  // name -> clearTimeout handle
const mutedIPs = {}; // ip -> expiry or 'perm'
const mutedNames = new Set(); // name-based mutes
const bannedIPs = {}; // ip -> expiry or 'perm'
const bannedNames = {}; // username -> expiry or 'perm'
let ADMIN_PASSWORD = '1648';
const SUB_ADMIN_PASSWORD = '3148';
const subAdmins = new Set();
const subAdminBanned = new Set(); // usernames banned from using sub-admin
const admins = new Set();       // socket IDs
const adminNames = new Set();   // usernames (persists across reconnects)
const acWhitelist = new Set();  // usernames exempt from autoclicker detection

const DATA_DIR = process.env.DATA_DIR || __dirname;
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
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
      // Check for case-insensitive name collision
      const lname = uname.toLowerCase();
      const collision = Object.keys(accounts).find(k => k.toLowerCase() === lname);
      if (collision) {
        socket.emit('auth_result', { ok: false, msg: 'That username is already taken.' });
        return;
      }
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

  socket.on('autoclicker_report', ({ cps, ended, duration, locked, unlocked, reason }) => {
    if (!players[socket.id]) return;
    const name = players[socket.id].name;
    if (acWhitelist.has(name)) return;
    let msg;
    if (locked) {
      msg = `🔒 [AC] ${name} LOCKED 10s — ${cps} CPS${reason ? ' | reason: ' + reason : ''}`;
    } else if (unlocked) {
      msg = `🔓 [AC] ${name} unlocked`;
    } else if (ended) {
      msg = `⚠️ [AC] ${name} stopped — ${cps} CPS for ${duration}s`;
    } else {
      msg = `🚨 [AC] ${name} suspicious — ${cps} CPS${reason ? ' | ' + reason : ''}`;
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
    players[socket.id] = { name: safeName, cookies: 0, cps: 0, lastChat: 0, lastAttack: 0, ip };

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
    // Restore autoclicker whitelist status
    if (acWhitelist.has(safeName)) socket.emit('ac_whitelisted');
  });

  socket.on('update_score', ({ cookies, cps }) => {
    if (!players[socket.id]) return;
    players[socket.id].cookies = Math.max(0, Math.floor(Number(cookies) || 0));
    players[socket.id].cps = Math.max(0, Number(cps) || 0);
    players[socket.id].lastActive = Date.now();
  });

  socket.on('set_name_color', (color) => {
    if (!players[socket.id]) return;
    // Only allow valid hex colors
    const safe = /^#[0-9a-fA-F]{6}$/.test(String(color)) ? String(color) : null;
    players[socket.id].nameColor = safe;
  });

  socket.on('chat_msg', (msg) => {
    if (!players[socket.id]) return;
    const ip = players[socket.id]?.ip || getIP(socket);
    const playerName = players[socket.id].name;
    if (isBlocked(ip, mutedIPs) || mutedNames.has(playerName.toLowerCase())) {
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
    const filteredName = filterMsg(players[socket.id].name);
    io.emit('chat', {
      name: filteredName,
      nameColor: players[socket.id].nameColor || null,
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
    socket.emit('pay_result', { ok: true, msg: `Sent 🍪 ${amtStr} to ${targetName}!`, amount: amt });
  });

  // Attack
  const ATTACK_COOLDOWN_MS = 15000; // 15 seconds between attacks
  const ATTACK_MIN_CPS = 1000;       // must earn 1K/sec to attack
  socket.on('attack', ({ attackId, targetName }) => {
    if (!players[socket.id]) return;
    const COSTS = { freeze10: 3000, freeze20: 12000, freeze30: 35000, curse: 15000, virus: 30000, drain: 50000, timetheft: 200000, steal10k: 10000, steal100k: 100000, steal1m: 1000000 };
    const cost = COSTS[attackId];
    if (!cost) return;
    if (players[socket.id].cookies < cost) return;

    // CPS requirement
    if (players[socket.id].cps < ATTACK_MIN_CPS) {
      socket.emit('attack_error', { msg: '⚠️ You need at least 1K cookies/sec to attack!', refund: cost });
      return;
    }

    // Cooldown check
    const now = Date.now();
    const sinceLastAttack = now - (players[socket.id].lastAttack || 0);
    if (sinceLastAttack < ATTACK_COOLDOWN_MS) {
      const secsLeft = Math.ceil((ATTACK_COOLDOWN_MS - sinceLastAttack) / 1000);
      socket.emit('attack_error', { msg: `⏳ Attack on cooldown! Wait ${secsLeft}s.`, refund: cost });
      return;
    }

    const target = Object.entries(players).find(([,p]) => p.name === targetName);
    if (!target) { socket.emit('attack_error', { msg: '❌ Target not found.', refund: cost }); return; }

    players[socket.id].lastAttack = now;
    players[socket.id].cookies -= cost;
    io.to(target[0]).emit('attack_hit', { attackId, attackerName: players[socket.id].name });
  });

  // Admin login
  socket.on('admin_login', (password) => {
    if (password === ADMIN_PASSWORD) {
      admins.add(socket.id);
      if (players[socket.id]) adminNames.add(players[socket.id].name);
      socket.emit('admin_result', { success: true, role: 'admin' });
      socket.emit('admin_playerlist', getPlayerList());
    } else if (password === SUB_ADMIN_PASSWORD) {
      const name = players[socket.id] && players[socket.id].name;
      if (name && subAdminBanned.has(name.toLowerCase())) {
        socket.emit('admin_result', { success: false });
        return;
      }
      subAdmins.add(socket.id);
      socket.emit('admin_result', { success: true, role: 'subadmin' });
      socket.emit('admin_playerlist', getPlayerList());
    } else {
      socket.emit('admin_result', { success: false });
    }
  });

  // Admin actions
  socket.on('admin_mute', (targetName) => {
    if (!admins.has(socket.id) && !subAdmins.has(socket.id)) return;
    const entry = Object.entries(players).find(([,p]) => p.name.toLowerCase() === targetName.toLowerCase());
    if (!entry) { socket.emit('admin_action_result', { ok: false, msg: `"${targetName}" not found.` }); return; }
    mutedNames.add(entry[1].name.toLowerCase());
    io.emit('chat', { system: true, msg: `🔇 ${entry[1].name} was muted.`, time: Date.now() });
    socket.emit('admin_action_result', { ok: true, msg: `Muted ${entry[1].name} (name-based).` });
  });

  socket.on('admin_ipmute', (targetName) => {
    if (!admins.has(socket.id)) return;
    const entry = Object.entries(players).find(([,p]) => p.name.toLowerCase() === targetName.toLowerCase());
    if (!entry) { socket.emit('admin_action_result', { ok: false, msg: `"${targetName}" not found.` }); return; }
    mutedIPs[entry[1].ip] = 'perm';
    mutedNames.add(entry[1].name.toLowerCase());
    io.emit('chat', { system: true, msg: `🔇 ${entry[1].name} was permanently IP-muted.`, time: Date.now() });
    socket.emit('admin_action_result', { ok: true, msg: `IP-muted ${entry[1].name}.` });
  });

  socket.on('admin_unmute', (targetName) => {
    if (!admins.has(socket.id) && !subAdmins.has(socket.id)) return;
    const lower = targetName.toLowerCase();
    const entry = Object.entries(players).find(([,p]) => p.name.toLowerCase() === lower);
    mutedNames.delete(lower);
    if (entry) delete mutedIPs[entry[1].ip];
    io.emit('chat', { system: true, msg: `🔊 ${targetName} was unmuted.`, time: Date.now() });
    socket.emit('admin_action_result', { ok: true, msg: `Unmuted ${targetName}.` });
  });

  socket.on('admin_clearchat', () => {
    if (!admins.has(socket.id)) return;
    io.emit('chat_clear');
    socket.emit('admin_action_result', { ok: true, msg: 'Chat cleared.' });
  });

  socket.on('admin_timeout', ({ name, seconds }) => {
    if (!admins.has(socket.id) && !subAdmins.has(socket.id)) return;
    const secs = Math.max(1, parseInt(seconds) || 30);
    const entry = Object.entries(players).find(([,p]) => p.name.toLowerCase() === name.toLowerCase());
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
    if (!accounts[targetName]) {
      socket.emit('admin_action_result', { ok: false, msg: `No account found: ${targetName}` });
      return;
    }
    accounts[targetName].cookies = 0;
    accounts[targetName].owned = {};
    saveAccounts();
    // Reset live session if online
    const entry = Object.entries(players).find(([, p]) => p.name === targetName);
    if (entry) {
      players[entry[0]].cookies = 0;
      io.to(entry[0]).emit('admin_reset_you');
    }
    socket.emit('admin_action_result', { ok: true, msg: `Wiped cookies & upgrades for: ${targetName}` });
  });

  socket.on('admin_delaccount', (targetName) => {
    if (!admins.has(socket.id)) return;
    if (!accounts[targetName]) {
      socket.emit('admin_action_result', { ok: false, msg: `No account found: ${targetName}` });
      return;
    }
    delete accounts[targetName];
    saveAccounts();
    // Kick live session if online
    const entry = Object.entries(players).find(([, p]) => p.name === targetName);
    if (entry) {
      io.to(entry[0]).emit('force_logout', 'Your account has been deleted by an admin.');
      delete players[entry[0]];
      io.sockets.sockets.get(entry[0])?.disconnect(true);
    }
    socket.emit('admin_action_result', { ok: true, msg: `Deleted account: ${targetName}` });
    io.emit('leaderboard', getLeaderboard());
  });

  socket.on('admin_subadminban', (targetName) => {
    if (!admins.has(socket.id)) return;
    subAdminBanned.add(targetName.toLowerCase());
    // Kick them if currently logged in as sub-admin
    Object.entries(players).forEach(([sid, p]) => {
      if (p.name.toLowerCase() === targetName.toLowerCase() && subAdmins.has(sid)) {
        subAdmins.delete(sid);
        io.to(sid).emit('force_logout', 'Your sub-admin access has been revoked.');
      }
    });
    socket.emit('admin_action_result', { ok: true, msg: `${targetName} is banned from sub-admin.` });
  });

  socket.on('admin_subadminunban', (targetName) => {
    if (!admins.has(socket.id)) return;
    subAdminBanned.delete(targetName.toLowerCase());
    socket.emit('admin_action_result', { ok: true, msg: `${targetName} can use sub-admin again.` });
  });

  socket.on('admin_autowhite', (targetName) => {
    if (!admins.has(socket.id)) return;
    acWhitelist.add(targetName);
    const entry = Object.entries(players).find(([, p]) => p.name === targetName);
    if (entry) io.to(entry[0]).emit('ac_whitelisted');
    socket.emit('admin_action_result', { ok: true, msg: `${targetName} is now autoclicker-whitelisted.` });
  });

  socket.on('admin_autoblack', (targetName) => {
    if (!admins.has(socket.id)) return;
    acWhitelist.delete(targetName);
    const entry = Object.entries(players).find(([, p]) => p.name === targetName);
    if (entry) io.to(entry[0]).emit('ac_blacklisted');
    socket.emit('admin_action_result', { ok: true, msg: `${targetName} removed from autoclicker whitelist.` });
  });

  socket.on('admin_wipeall', () => {
    if (!admins.has(socket.id)) return;
    // Wipe every account in storage
    Object.keys(accounts).forEach(name => {
      accounts[name].cookies = 0;
      accounts[name].owned = {};
    });
    saveAccounts();
    // Reset all live sessions
    Object.keys(players).forEach(sid => {
      players[sid].cookies = 0;
      io.to(sid).emit('admin_reset_you');
    });
    socket.emit('admin_action_result', { ok: true, msg: `Wiped all ${Object.keys(accounts).length} accounts.` });
    io.emit('leaderboard', getLeaderboard());
  });

  socket.on('admin_wipe_upgrades', (targetName) => {
    if (!admins.has(socket.id)) return;
    if (!accounts[targetName]) {
      socket.emit('admin_action_result', { ok: false, msg: `No account found: ${targetName}` });
      return;
    }
    accounts[targetName].owned = {};
    saveAccounts();
    const entry = Object.entries(players).find(([, p]) => p.name === targetName);
    if (entry) io.to(entry[0]).emit('admin_wipe_upgrades_you');
    socket.emit('admin_action_result', { ok: true, msg: `Wiped all upgrades for: ${targetName}` });
  });

  socket.on('admin_flashbang', ({ targetName, volume }) => {
    if (!admins.has(socket.id) && !subAdmins.has(socket.id)) { socket.emit('admin_action_result', { ok: false, msg: 'Not logged in as admin. Re-enter your password.' }); return; }
    const entry = Object.entries(players).find(([, p]) => p.name.toLowerCase() === targetName.toLowerCase());
    if (!entry) { socket.emit('admin_action_result', { ok: false, msg: `"${targetName}" not found online.` }); return; }
    io.to(entry[0]).emit('flashbang', { volume: volume || 'medium' });
    socket.emit('admin_action_result', { ok: true, msg: `💀 Flashbanged ${targetName} (${volume || 'medium'})` });
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

  socket.on('admin_kick', (targetName) => {
    if (!admins.has(socket.id)) { socket.emit('admin_action_result', { ok: false, msg: 'Not logged in as admin.' }); return; }
    const entry = Object.entries(players).find(([, p]) => p.name.toLowerCase() === targetName.toLowerCase());
    if (!entry) { socket.emit('admin_action_result', { ok: false, msg: `"${targetName}" not found online.` }); return; }
    io.to(entry[0]).emit('kicked');
    socket.emit('admin_action_result', { ok: true, msg: `👢 Kicked ${targetName}` });
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
      // Persist latest cookie count on disconnect (save_progress fires every 1s so this is a safety net)
      if (accounts[name] && players[socket.id].cookies > 0) {
        accounts[name].cookies = players[socket.id].cookies;
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
      subAdmins.delete(socket.id);
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
