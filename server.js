const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const players = {}; // socketId -> { name, cookies, cps }

io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`);

  socket.on('join', (name) => {
    const safeName = String(name).slice(0, 20).replace(/[<>&"]/g, '') || 'Anonymous';
    players[socket.id] = { name: safeName, cookies: 0, cps: 0 };

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
    const safeMsg = String(msg).slice(0, 200).replace(/[<>&"]/g, (c) =>
      ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c])
    );
    if (!safeMsg.trim()) return;
    io.emit('chat', {
      name: players[socket.id].name,
      msg: safeMsg,
      time: Date.now()
    });
  });

  socket.on('disconnect', () => {
    if (players[socket.id]) {
      const name = players[socket.id].name;
      delete players[socket.id];
      io.emit('chat', { system: true, msg: `${name} left the game.`, time: Date.now() });
      io.emit('leaderboard', getLeaderboard());
    }
  });
});

// Push leaderboard to all clients every 2 seconds
setInterval(() => {
  io.emit('leaderboard', getLeaderboard());
}, 2000);

function getLeaderboard() {
  return Object.values(players)
    .sort((a, b) => b.cookies - a.cookies)
    .slice(0, 10)
    .map(p => ({ name: p.name, cookies: p.cookies, cps: p.cps }));
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Cookie Chat running at http://localhost:${PORT}`);
});
