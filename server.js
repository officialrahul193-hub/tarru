const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const UPLOAD_DIR = path.join(__dirname, 'storage');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// code -> { code, filename, size, type, createdAt, uploaded, filePath, expiresAt, senderWs, receiverWs }
const rooms = new Map();

const PEER_JOIN_GRACE_MS = 60 * 1000;       // how long an orphan (no upload, sender gone) room is kept around
const STORAGE_TTL_MS = 48 * 60 * 60 * 1000; // 48 hours

function generateCode() {
  let code;
  do {
    code = crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 6);
  } while (rooms.has(code));
  return code;
}

// ---------- REST: room creation + metadata ----------

app.post('/api/room', (req, res) => {
  const { filename, size, type } = req.body || {};
  if (!filename || !size) {
    return res.status(400).json({ error: 'filename and size are required' });
  }
  const code = generateCode();
  rooms.set(code, {
    code,
    filename,
    size,
    type: type || 'application/octet-stream',
    createdAt: Date.now(),
    uploaded: false,
    filePath: null,
    expiresAt: null,
    senderWs: null,
    receiverWs: null,
  });
  res.json({ code });
});

app.get('/api/meta/:code', (req, res) => {
  const room = rooms.get(req.params.code);
  if (!room) return res.status(404).json({ status: 'gone' });

  if (room.uploaded) {
    return res.json({
      status: 'stored',
      filename: room.filename,
      size: room.size,
      type: room.type,
      expiresAt: room.expiresAt,
    });
  }
  if (room.senderWs && room.senderWs.readyState === WebSocket.OPEN) {
    return res.json({
      status: 'live',
      filename: room.filename,
      size: room.size,
      type: room.type,
    });
  }
  return res.status(404).json({ status: 'gone' });
});

// ---------- REST: backup upload / download (temp storage fallback) ----------

app.put('/api/upload/:code', (req, res) => {
  const room = rooms.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'Link not found or expired' });

  const filePath = path.join(UPLOAD_DIR, room.code);
  const writeStream = fs.createWriteStream(filePath);

  req.pipe(writeStream);

  req.on('error', () => {
    writeStream.destroy();
    fs.unlink(filePath, () => {});
    if (!res.headersSent) res.status(500).json({ error: 'Upload failed' });
  });

  writeStream.on('error', () => {
    if (!res.headersSent) res.status(500).json({ error: 'Storage write failed' });
  });

  writeStream.on('finish', () => {
    room.uploaded = true;
    room.filePath = filePath;
    room.expiresAt = Date.now() + STORAGE_TTL_MS;
    res.json({ ok: true, expiresAt: room.expiresAt });
  });
});

app.get('/api/download/:code', (req, res) => {
  const room = rooms.get(req.params.code);
  if (!room || !room.uploaded || !fs.existsSync(room.filePath)) {
    return res.status(404).send('This link has expired or is invalid.');
  }
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(room.filename)}"`);
  res.setHeader('Content-Type', room.type);
  fs.createReadStream(room.filePath).pipe(res);
});

// ---------- WebSocket signaling (used only for the live P2P path) ----------

wss.on('connection', (ws) => {
  ws.roomCode = null;
  ws.role = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    switch (msg.type) {
      case 'register-sender': {
        const room = rooms.get(msg.code);
        if (!room) {
          ws.send(JSON.stringify({ type: 'error', message: 'Room not found' }));
          return;
        }
        room.senderWs = ws;
        ws.roomCode = msg.code;
        ws.role = 'sender';
        break;
      }

      case 'join-room': {
        const room = rooms.get(msg.code);
        if (!room || !room.senderWs || room.senderWs.readyState !== WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'error', message: 'Sender is not online for live transfer' }));
          return;
        }
        if (room.receiverWs) {
          ws.send(JSON.stringify({ type: 'error', message: 'This link is already in use' }));
          return;
        }
        room.receiverWs = ws;
        ws.roomCode = msg.code;
        ws.role = 'receiver';

        ws.send(JSON.stringify({
          type: 'joined',
          meta: { filename: room.filename, size: room.size, type: room.type },
        }));
        room.senderWs.send(JSON.stringify({ type: 'peer-joined' }));
        break;
      }

      case 'signal': {
        const room = rooms.get(ws.roomCode);
        if (!room) return;
        const target = ws.role === 'sender' ? room.receiverWs : room.senderWs;
        if (target && target.readyState === WebSocket.OPEN) {
          target.send(JSON.stringify({ type: 'signal', data: msg.data }));
        }
        break;
      }

      default: break;
    }
  });

  ws.on('close', () => {
    if (!ws.roomCode) return;
    const room = rooms.get(ws.roomCode);
    if (!room) return;

    const other = ws.role === 'sender' ? room.receiverWs : room.senderWs;
    if (other && other.readyState === WebSocket.OPEN) {
      other.send(JSON.stringify({ type: 'peer-left' }));
    }
    if (ws.role === 'sender') room.senderWs = null;
    if (ws.role === 'receiver') room.receiverWs = null;
  });
});

// ---------- Cleanup: keep storage from ever filling up ----------

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    if (room.uploaded && room.expiresAt && now > room.expiresAt) {
      fs.unlink(room.filePath, () => {});
      rooms.delete(code);
    } else if (!room.uploaded && (!room.senderWs || room.senderWs.readyState !== WebSocket.OPEN) && (now - room.createdAt > PEER_JOIN_GRACE_MS)) {
      // orphaned room: sender left, nothing ever uploaded
      rooms.delete(code);
    }
  }
}, 15 * 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Tarru server running on port ${PORT}`));
