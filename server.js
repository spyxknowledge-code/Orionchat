const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  transports: ['websocket', 'polling']
});

app.use(express.static('public'));
app.use(express.json());

// ---------- In‑memory stores ----------
const users = new Map();      // userId -> user object
const rooms = new Map();      // roomId -> { name, creator, participants: Set }
const messages = new Map();   // roomId -> [ { id, userId, text, timestamp, unsent } ]

// ---------- Default user for demo ----------
users.set('u1', {
  id: 'u1',
  name: 'John Doe',
  username: '@johndoe',
  joined: '15 March 2026',
  country: 'India',
  bio: 'Tech & Music Lover',
  verified: true,
  friends: 248,
  status: 'online',
  lastActive: 'Just Now',
  socketId: null,
  rooms: []
});

// ---------- Socket.io events ----------
io.on('connection', (socket) => {
  console.log(`Socket ${socket.id} connected`);

  // Identify user
  socket.on('identify', (userId) => {
    let user = users.get(userId);
    if (!user) {
      // auto‑create new user
      const newId = `u${Date.now()}`;
      user = {
        id: newId,
        name: 'New User',
        username: `@user${Math.floor(Math.random() * 10000)}`,
        joined: new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
        country: 'Unknown',
        bio: 'Hello, Orion!',
        verified: false,
        friends: 0,
        status: 'online',
        lastActive: 'Just Now',
        socketId: socket.id,
        rooms: []
      };
      users.set(newId, user);
    } else {
      user.socketId = socket.id;
      user.status = 'online';
      user.lastActive = 'Just Now';
    }
    socket.join(`user-${user.id}`);
    socket.emit('identity-confirmed', user);
    io.emit('user-status', { userId: user.id, status: 'online' });
  });

  // Create room
  socket.on('create-room', (roomName, userId) => {
    const roomId = `r_${uuidv4().slice(0, 6)}`;
    rooms.set(roomId, {
      name: roomName || 'General',
      creator: userId,
      participants: new Set([userId])
    });
    const user = users.get(userId);
    if (user && !user.rooms.includes(roomId)) {
      user.rooms.push(roomId);
    }
    socket.join(roomId);
    socket.emit('room-created', { roomId, roomName: roomName || 'General' });
    // broadcast updated room list to all users (simplified – we'll emit to the creator)
    io.to(`user-${userId}`).emit('room-list-update', getRoomListForUser(userId));
  });

  // Join room
  socket.on('join-room', (roomId, userId) => {
    const room = rooms.get(roomId);
    if (!room) {
      socket.emit('error', 'Room not found');
      return;
    }
    room.participants.add(userId);
    const user = users.get(userId);
    if (user && !user.rooms.includes(roomId)) {
      user.rooms.push(roomId);
    }
    socket.join(roomId);
    socket.emit('room-joined', { roomId, roomName: room.name });
    // send participants
    const participantList = Array.from(room.participants).map(id => users.get(id));
    io.to(roomId).emit('participant-update', participantList);
    // send last 50 messages
    const msgs = (messages.get(roomId) || []).filter(m => !m.unsent).slice(-50);
    socket.emit('room-messages', msgs);
    // update room list for this user
    io.to(`user-${userId}`).emit('room-list-update', getRoomListForUser(userId));
  });

  // Send message
  socket.on('send-message', ({ roomId, userId, text }) => {
    const msg = {
      id: `m_${Date.now()}`,
      userId,
      text,
      timestamp: new Date().toISOString(),
      unsent: false
    };
    if (!messages.has(roomId)) messages.set(roomId, []);
    messages.get(roomId).push(msg);
    io.to(roomId).emit('new-message', msg);
  });

  // Unsend message (only author)
  socket.on('unsend-message', ({ roomId, messageId, userId }) => {
    const msgs = messages.get(roomId);
    if (!msgs) return;
    const idx = msgs.findIndex(m => m.id === messageId && m.userId === userId);
    if (idx !== -1) {
      msgs[idx].unsent = true;
      io.to(roomId).emit('message-unsent', { messageId });
    }
  });

  // Search user by id or username (with or without @)
  socket.on('search-user', (query, requestorId) => {
    const found = Array.from(users.values()).find(u =>
      u.id === query ||
      u.username === query ||
      u.username === `@${query}`
    );
    if (found) {
      // remove socketId from profile
      const { socketId, ...profile } = found;
      socket.emit('search-result', profile);
    } else {
      socket.emit('search-result', null);
    }
  });

  // Request meeting
  socket.on('request-meeting', ({ targetUserId, requestorId, message }) => {
    const requestor = users.get(requestorId);
    if (!requestor) return;
    io.to(`user-${targetUserId}`).emit('meeting-request', {
      from: requestorId,
      message,
      fromUser: { name: requestor.name, username: requestor.username }
    });
  });

  // Approve/decline meeting
  socket.on('approve-meeting', ({ targetUserId, requestorId, approved }) => {
    io.to(`user-${targetUserId}`).emit('meeting-response', {
      from: requestorId,
      approved
    });
  });

  // Edit profile
  socket.on('edit-profile', (userId, updates) => {
    const user = users.get(userId);
    if (!user) return;
    // sanitize username
    if (updates.username) {
      let uname = updates.username.trim();
      if (!uname.startsWith('@')) uname = '@' + uname;
      updates.username = uname;
    }
    Object.assign(user, updates);
    // broadcast updated profile to all rooms user is in
    io.to(`user-${userId}`).emit('profile-updated', user);
    user.rooms.forEach(roomId => {
      const room = rooms.get(roomId);
      if (room) {
        const participants = Array.from(room.participants).map(id => users.get(id));
        io.to(roomId).emit('participant-update', participants);
      }
    });
  });

  // Disconnect
  socket.on('disconnect', () => {
    for (const [id, user] of users) {
      if (user.socketId === socket.id) {
        user.status = 'offline';
        user.lastActive = 'Just now';
        user.socketId = null;
        io.emit('user-status', { userId: id, status: 'offline' });
        break;
      }
    }
  });
});

// Helper: get room list for a user (with names)
function getRoomListForUser(userId) {
  const user = users.get(userId);
  if (!user) return [];
  return user.rooms.map(roomId => {
    const room = rooms.get(roomId);
    return room ? { id: roomId, name: room.name } : null;
  }).filter(Boolean);
}

// ---------- Start server ----------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Orion Chats running on port ${PORT}`);
});
