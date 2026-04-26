/**
 * CoopÉnergie — Serveur Backend Node.js v4.0
 * Hackathon Miabe 2026 · Projet CM-02
 * Avec Socket.io, export PDF, rapport automatique
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const PDFDocument = require('pdfkit');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const compression = require('compression');
const http = require('http');
const socketIo = require('socket.io');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'coopenegie_secret_2026_hackathon_dtc';
const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const REPORTS_DIR = path.join(DATA_DIR, 'reports');

// ─── Dossiers ─────────────────────────────────────────────
[DATA_DIR, UPLOADS_DIR, REPORTS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ─── Web Push (optionnel) ─────────────────────────────────
let webpush = null;
let pushEnabled = false;
try {
  webpush = require('web-push');
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails('mailto:admin@coopenegie.cm', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
    pushEnabled = true;
    console.log('✅ Notifications push activées');
  }
} catch (e) {
  console.log('⚠️  web-push non installé — push désactivé');
}

// ─── Middleware ───────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PATCH', 'DELETE', 'PUT'] }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ─── Rate limiting ────────────────────────────────────────
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200, message: { error: 'Trop de requêtes.' } });
app.use('/api/', limiter);
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: { error: 'Trop de tentatives de connexion.' } });
app.use('/api/auth/', authLimiter);

// ─── Fichiers statiques ───────────────────────────────────
app.use('/uploads', express.static(UPLOADS_DIR));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Multer ───────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `upload_${Date.now()}_${uuidv4().substring(0, 8)}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.pdf'];
    cb(null, allowed.includes(path.extname(file.originalname).toLowerCase()));
  }
});

// ─── SSE ─────────────────────────────────────────────────
let sseClients = [];
function broadcastSSE(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients = sseClients.filter(client => {
    try { client.write(msg); return true; } catch { return false; }
  });
}

// ─── DB ───────────────────────────────────────────────────
function readDB() {
  try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); }
  catch { return initDB(); }
}

function initDB() {
  const db = {
    users: [
      {
        id: 'u1', nom: 'Admin CoopÉnergie', email: 'admin@coopenegie.cm', tel: '698123456',
        password: bcrypt.hashSync('admin123', 10), role: 'super_admin', avatar: null,
        createdAt: new Date().toISOString()
      },
      {
        id: 'u2', nom: 'Marie Ateba', email: 'marie@email.com', tel: '697111222',
        password: bcrypt.hashSync('marie123', 10), role: 'membre', avatar: null,
        createdAt: new Date().toISOString()
      },
      {
        id: 'u3', nom: 'Jean Ndongo', email: 'jean@email.com', tel: '699333444',
        password: bcrypt.hashSync('jean123', 10), role: 'membre', avatar: null,
        createdAt: new Date().toISOString()
      }
    ],
    chat_messages: [
      {
        id: 'msg1', userId: 'u1', nom: 'Admin CoopÉnergie',
        message: 'Bienvenue sur CoopÉnergie ! 🌿 Posez vos questions ici.',
        room: 'general', createdAt: new Date().toISOString()
      }
    ],
    chat_rooms: [
      { id: 'general', nom: '💬 Discussion générale', description: 'Tous les membres', isPrivate: false },
      { id: 'c1', nom: '🌿 Coopérative Bonamoussadi', description: 'Espace membres Bonamoussadi', isPrivate: true, coopId: 'c1' },
      { id: 'c2', nom: '⚡ Énergie Rurale Mbalmayo', description: 'Espace membres Mbalmayo', isPrivate: true, coopId: 'c2' },
      { id: 'c3', nom: '👩‍🌾 Femmes Solaires Biyem-Assi', description: 'Espace membres Biyem-Assi', isPrivate: true, coopId: 'c3' }
    ],
    cooperatives: [
      {
        id: 'c1', nom: 'Coopérative Solaire Bonamoussadi', objectif: 500000, collecte: 187000,
        lieu: 'Bonamoussadi, Douala', description: 'Achat groupé de panneaux solaires pour 15 foyers.',
        membres: 8, maxMembres: 15, cotMin: 5000, createdBy: 'u1', createdAt: '2026-03-01', statut: 'actif'
      },
      {
        id: 'c2', nom: 'Énergie Rurale Mbalmayo', objectif: 350000, collecte: 95000,
        lieu: 'Mbalmayo', description: 'Microgrid solaire pour 10 familles rurales.',
        membres: 6, maxMembres: 10, cotMin: 3000, createdBy: 'u1', createdAt: '2026-02-15', statut: 'actif'
      },
      {
        id: 'c3', nom: 'Femmes Solaires Biyem-Assi', objectif: 200000, collecte: 178000,
        lieu: 'Biyem-Assi, Yaoundé', description: 'Groupement de femmes pour éclairage solaire.',
        membres: 12, maxMembres: 12, cotMin: 4000, createdBy: 'u1', createdAt: '2026-01-10', statut: 'actif'
      }
    ],
    cotisations: [
      {
        id: 'ct1', userId: 'u2', nom: 'Marie Ateba', tel: '697111222', email: 'marie@email.com',
        coopId: 'c1', montant: 10000, txn: 'OM26890234', date: '2026-02-15',
        statut: 'confirme', message: 'Cotisation février', screenshot: null,
        createdAt: '2026-02-15T10:00:00Z', verifiedBy: 'u1', verifiedAt: '2026-02-16T10:00:00Z'
      },
      {
        id: 'ct2', userId: 'u3', nom: 'Jean Ndongo', tel: '699333444', email: 'jean@email.com',
        coopId: 'c2', montant: 5000, txn: 'OM26890567', date: '2026-03-18',
        statut: 'pending', message: '', screenshot: null,
        createdAt: '2026-03-18T14:00:00Z', verifiedBy: null, verifiedAt: null
      }
    ],
    membres: [
      { id: 'm1', userId: 'u2', nom: 'Marie Ateba', tel: '697111222', email: 'marie@email.com', coopId: 'c1', createdAt: '2026-02-10' },
      { id: 'm2', userId: 'u3', nom: 'Jean Ndongo', tel: '699333444', email: 'jean@email.com', coopId: 'c2', createdAt: '2026-02-20' }
    ],
    votes: [
      {
        id: 'v1', question: 'Quel équipement acheter en premier ?', coopId: 'c1',
        options: ['Panneau solaire 200W — 85 000 FCFA', 'Batterie 100Ah — 120 000 FCFA', 'Kit complet — 180 000 FCFA'],
        votes: [3, 1, 4], fin: '2026-05-30', seuil: 50, statut: 'actif',
        createdBy: 'u1', createdAt: '2026-04-01T00:00:00Z',
        voters: [] // Suivi des votants pour empêcher double vote
      }
    ],
    blockchain: [
      {
        id: 'b1', type: 'COOP_CRÉÉE', desc: 'Coopérative Solaire Bonamoussadi', montant: null,
        hash: 'a1b2c3d4e5f6a7b8', prev: '0000000000000000',
        date: '2026-03-01', createdAt: '2026-03-01T00:00:00Z', userId: 'u1'
      }
    ],
    notifications: [],
    push_subscriptions: [],
    config: {
      om_numero: '698 123 456',
      om_nom: 'CoopÉnergie Admin',
      admin_pin: bcrypt.hashSync('1234', 10),
      site_name: 'CoopÉnergie',
      sms: { service: 'none', twilio_sid: '', twilio_token: '', twilio_from: '' }
    }
  };
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
  return db;
}

function writeDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf8');
}

// ─── Hash blockchain simplifié ────────────────────────────
function hashMini(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0') + (h ^ 0xdeadbeef).toString(16).padStart(8, '0');
}

function addToBlockchain(type, desc, montant, userId, reference) {
  const db = readDB();
  const prev = db.blockchain.length ? db.blockchain[db.blockchain.length - 1].hash : '0000000000000000';
  const hash = hashMini(reference + Date.now() + prev + type);
  const entry = {
    id: 'b' + Date.now() + uuidv4().substring(0, 6),
    type, desc, montant: montant || null, hash, prev,
    date: new Date().toISOString().split('T')[0],
    createdAt: new Date().toISOString(),
    userId: userId || null
  };
  db.blockchain.push(entry);
  writeDB(db);
  broadcastSSE('blockchain', { type, desc, montant });
  io.emit('blockchain_update', entry);
  return entry;
}

// ─── Auth Middleware ──────────────────────────────────────
function authenticateToken(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ success: false, error: 'Accès non autorisé.' });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ success: false, error: 'Token invalide ou expiré.' });
    req.user = user;
    next();
  });
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ success: false, error: 'Non authentifié.' });
    if (!roles.includes(req.user.role)) return res.status(403).json({ success: false, error: 'Accès refusé — rôle insuffisant.' });
    next();
  };
}

// ─── Push Notification ───────────────────────────────────
async function sendPush(userId, title, body) {
  if (!pushEnabled || !webpush) return;
  const db = readDB();
  const sub = db.push_subscriptions.find(s => s.userId === userId);
  if (!sub) return;
  try {
    await webpush.sendNotification(sub, JSON.stringify({ title, body }));
    db.notifications.push({ id: 'n' + Date.now(), userId, title, body, read: false, createdAt: new Date().toISOString() });
    writeDB(db);
  } catch (e) { /* subscription expirée */ }
}

// ══════════════════════════════════════════════════════════
// AUTH
// ══════════════════════════════════════════════════════════

app.post('/api/auth/register', async (req, res) => {
  const { nom, email, tel, password, coopId } = req.body;
  if (!nom?.trim() || !tel?.trim() || !password) {
    return res.status(400).json({ success: false, error: 'Nom, téléphone et mot de passe sont requis.' });
  }
  const db = readDB();
  if (db.users.find(u => u.tel === tel)) {
    return res.status(400).json({ success: false, error: 'Ce numéro de téléphone est déjà utilisé.' });
  }
  if (email && db.users.find(u => u.email === email)) {
    return res.status(400).json({ success: false, error: 'Cet email est déjà utilisé.' });
  }
  const hashedPwd = await bcrypt.hash(password, 10);
  const newUser = {
    id: 'u' + uuidv4().replace(/-/g, '').substring(0, 8),
    nom: nom.trim(), email: email?.trim() || '', tel: tel.trim(),
    password: hashedPwd, role: 'membre', avatar: null,
    createdAt: new Date().toISOString()
  };
  db.users.push(newUser);
  if (coopId && db.cooperatives.find(c => c.id === coopId)) {
    db.membres.push({
      id: 'm' + uuidv4().replace(/-/g, '').substring(0, 8),
      userId: newUser.id, nom: newUser.nom, tel: newUser.tel,
      email: newUser.email, coopId, createdAt: new Date().toISOString().split('T')[0]
    });
    const coop = db.cooperatives.find(c => c.id === coopId);
    if (coop) coop.membres = (coop.membres || 0) + 1;
  }
  writeDB(db);
  const token = jwt.sign({ id: newUser.id, nom: newUser.nom, tel: newUser.tel, role: newUser.role }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ success: true, token, user: { id: newUser.id, nom: newUser.nom, email: newUser.email, tel: newUser.tel, role: newUser.role } });
});

app.post('/api/auth/login', async (req, res) => {
  const { identifiant, password } = req.body;
  if (!identifiant || !password) {
    return res.status(400).json({ success: false, error: 'Identifiant et mot de passe requis.' });
  }
  const db = readDB();
  const user = db.users.find(u => u.tel === identifiant || u.email === identifiant);
  if (!user) return res.status(401).json({ success: false, error: 'Identifiants incorrects.' });
  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ success: false, error: 'Identifiants incorrects.' });
  const token = jwt.sign({ id: user.id, nom: user.nom, tel: user.tel, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ success: true, token, user: { id: user.id, nom: user.nom, email: user.email, tel: user.tel, role: user.role } });
});

app.get('/api/auth/me', authenticateToken, (req, res) => {
  const db = readDB();
  const user = db.users.find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ success: false, error: 'Utilisateur non trouvé.' });
  const membre = db.membres.find(m => m.userId === user.id);
  const mesCots = db.cotisations.filter(c => c.userId === user.id || c.tel === user.tel);
  const totalCotise = mesCots.filter(c => c.statut === 'confirme').reduce((s, c) => s + c.montant, 0);
  res.json({
    id: user.id, nom: user.nom, email: user.email, tel: user.tel, role: user.role,
    coopId: membre?.coopId || null, totalCotise,
    nbCotisations: mesCots.filter(c => c.statut === 'confirme').length
  });
});

// ══════════════════════════════════════════════════════════
// CHAT
// ══════════════════════════════════════════════════════════

app.get('/api/chat/rooms', authenticateToken, (req, res) => {
  const db = readDB();
  const membre = db.membres.find(m => m.userId === req.user.id);
  const isAdmin = ['admin', 'super_admin'].includes(req.user.role);
  const rooms = db.chat_rooms.filter(r =>
    !r.isPrivate || isAdmin || (membre && r.coopId === membre.coopId)
  );
  res.json(rooms);
});

app.get('/api/chat/messages/:roomId', authenticateToken, (req, res) => {
  const db = readDB();
  const { roomId } = req.params;
  const membre = db.membres.find(m => m.userId === req.user.id);
  const room = db.chat_rooms.find(r => r.id === roomId);
  const isAdmin = ['admin', 'super_admin'].includes(req.user.role);
  if (room?.isPrivate && !isAdmin && (!membre || room.coopId !== membre.coopId)) {
    return res.status(403).json({ success: false, error: 'Accès non autorisé à ce salon.' });
  }
  const messages = db.chat_messages
    .filter(m => m.room === roomId)
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
    .slice(-100); // Limiter aux 100 derniers messages
  res.json(messages);
});

// ══════════════════════════════════════════════════════════
// SOCKET.IO
// ══════════════════════════════════════════════════════════

io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('Token manquant'));
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return next(new Error('Token invalide'));
    socket.user = user;
    next();
  });
});

io.on('connection', (socket) => {
  console.log(`🔌 Connecté: ${socket.user.nom}`);
  socket.join('general');

  socket.on('join_room', (roomId) => {
    socket.join(roomId);
    socket.emit('joined', { room: roomId });
  });

  socket.on('leave_room', (roomId) => socket.leave(roomId));

  socket.on('chat_message', (data) => {
    const { roomId, message } = data;
    if (!message?.trim()) return;
    const db = readDB();
    const membre = db.membres.find(m => m.userId === socket.user.id);
    const room = db.chat_rooms.find(r => r.id === roomId);
    const isAdmin = ['admin', 'super_admin'].includes(socket.user.role);
    if (room?.isPrivate && !isAdmin && (!membre || room.coopId !== membre.coopId)) {
      socket.emit('error_msg', 'Accès non autorisé à ce salon.');
      return;
    }
    const newMsg = {
      id: 'msg' + Date.now() + uuidv4().substring(0, 4),
      userId: socket.user.id, nom: socket.user.nom,
      message: message.trim().substring(0, 500),
      room: roomId, createdAt: new Date().toISOString()
    };
    db.chat_messages.push(newMsg);
    // Garder max 500 messages par salon
    if (db.chat_messages.filter(m => m.room === roomId).length > 500) {
      const idx = db.chat_messages.findIndex(m => m.room === roomId);
      db.chat_messages.splice(idx, 1);
    }
    writeDB(db);
    io.to(roomId).emit('new_message', newMsg);
  });

  socket.on('disconnect', () => {
    console.log(`🔌 Déconnecté: ${socket.user.nom}`);
  });
});

// ══════════════════════════════════════════════════════════
// COOPÉRATIVES
// ══════════════════════════════════════════════════════════

app.get('/api/cooperatives', (req, res) => {
  const db = readDB();
  res.json(db.cooperatives);
});

app.post('/api/cooperatives', authenticateToken, requireRole('admin', 'super_admin'), (req, res) => {
  const { nom, objectif, lieu, description, maxMembres, cotMin } = req.body;
  if (!nom?.trim() || !objectif || !lieu?.trim()) {
    return res.status(400).json({ success: false, error: 'Nom, objectif et localité sont requis.' });
  }
  const db = readDB();
  const newCoop = {
    id: 'c' + uuidv4().replace(/-/g, '').substring(0, 8),
    nom: nom.trim(), objectif: parseInt(objectif), collecte: 0,
    lieu: lieu.trim(), description: description?.trim() || '',
    membres: 0, maxMembres: parseInt(maxMembres) || 20,
    cotMin: parseInt(cotMin) || 5000,
    createdBy: req.user.id, createdAt: new Date().toISOString().split('T')[0], statut: 'actif'
  };
  db.cooperatives.push(newCoop);
  db.chat_rooms.push({
    id: newCoop.id, nom: `🌿 ${nom.trim()}`,
    description: `Espace des membres de ${nom.trim()}`,
    isPrivate: true, coopId: newCoop.id
  });
  writeDB(db);
  addToBlockchain('COOP_CRÉÉE', newCoop.nom, null, req.user.id, newCoop.id);
  broadcastSSE('update', { type: 'cooperatives' });
  res.json({ success: true, coop: newCoop });
});

app.get('/api/cooperatives/:id', (req, res) => {
  const db = readDB();
  const coop = db.cooperatives.find(c => c.id === req.params.id);
  if (!coop) return res.status(404).json({ success: false, error: 'Coopérative non trouvée.' });
  const cotisations = db.cotisations.filter(c => c.coopId === coop.id && c.statut === 'confirme');
  const membres = db.membres.filter(m => m.coopId === coop.id);
  const votes = db.votes.filter(v => v.coopId === coop.id);
  res.json({ ...coop, cotisations, membres, votes });
});

// ══════════════════════════════════════════════════════════
// COTISATIONS
// ══════════════════════════════════════════════════════════

app.get('/api/cotisations', authenticateToken, (req, res) => {
  const db = readDB();
  let list = db.cotisations;
  if (req.query.statut) list = list.filter(c => c.statut === req.query.statut);
  if (req.query.coopId) list = list.filter(c => c.coopId === req.query.coopId);
  if (!['admin', 'super_admin'].includes(req.user.role)) {
    list = list.filter(c => c.userId === req.user.id || c.tel === req.user.tel);
  }
  res.json(list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
});

app.post('/api/cotisations', authenticateToken, upload.single('screenshot'), async (req, res) => {
  const { nom, tel, email, coopId, montant, txn, message } = req.body;
  if (!nom?.trim() || !tel?.trim() || !coopId || !montant || !txn?.trim()) {
    return res.status(400).json({ success: false, error: 'Tous les champs obligatoires doivent être remplis.' });
  }
  const db = readDB();
  if (db.cotisations.find(c => c.txn === txn.trim())) {
    return res.status(400).json({ success: false, error: `La transaction ${txn} a déjà été enregistrée.` });
  }
  const coop = db.cooperatives.find(c => c.id === coopId);
  if (!coop) return res.status(404).json({ success: false, error: 'Coopérative non trouvée.' });

  const newCot = {
    id: 'ct' + uuidv4().replace(/-/g, '').substring(0, 8),
    userId: req.user.id, nom: nom.trim(), tel: tel.trim(),
    email: email?.trim() || '', coopId, montant: parseInt(montant),
    txn: txn.trim(), message: message?.trim() || '',
    screenshot: req.file?.filename || null,
    statut: 'pending', date: new Date().toISOString().split('T')[0],
    createdAt: new Date().toISOString(), verifiedBy: null, verifiedAt: null
  };
  db.cotisations.push(newCot);

  if (!db.membres.find(m => m.tel === tel.trim() || m.userId === req.user.id)) {
    db.membres.push({
      id: 'm' + uuidv4().replace(/-/g, '').substring(0, 8),
      userId: req.user.id, nom: nom.trim(), tel: tel.trim(),
      email: email?.trim() || '', coopId,
      createdAt: new Date().toISOString().split('T')[0]
    });
    coop.membres = (coop.membres || 0) + 1;
  }
  writeDB(db);
  await sendPush(req.user.id, '💰 Cotisation soumise', `${parseInt(montant).toLocaleString()} FCFA en attente de validation.`);
  broadcastSSE('update', { type: 'cotisations', action: 'nouvelle', nom: nom.trim(), montant: parseInt(montant) });
  res.json({ success: true, cotisation: newCot });
});

app.patch('/api/cotisations/:id/valider', authenticateToken, requireRole('admin', 'super_admin'), async (req, res) => {
  const { action, adminNote } = req.body;
  if (!['confirm', 'reject'].includes(action)) {
    return res.status(400).json({ success: false, error: 'Action invalide. Utilisez "confirm" ou "reject".' });
  }
  const db = readDB();
  const ct = db.cotisations.find(c => c.id === req.params.id);
  if (!ct) return res.status(404).json({ success: false, error: 'Cotisation non trouvée.' });
  if (ct.statut !== 'pending') return res.status(400).json({ success: false, error: 'Cette cotisation a déjà été traitée.' });

  ct.statut = action === 'confirm' ? 'confirme' : 'rejected';
  ct.adminNote = adminNote?.trim() || '';
  ct.verifiedBy = req.user.id;
  ct.verifiedAt = new Date().toISOString();

  if (action === 'confirm') {
    const coop = db.cooperatives.find(c => c.id === ct.coopId);
    if (coop) coop.collecte = (coop.collecte || 0) + ct.montant;
    addToBlockchain('COTISATION_OK', `${ct.nom} → ${coop?.nom || ct.coopId}`, ct.montant, req.user.id, ct.id);
    await sendPush(ct.userId, '✅ Cotisation validée !', `${ct.montant.toLocaleString()} FCFA confirmé pour ${coop?.nom || ''}.`);
    io.emit('cotisation_validated', { nom: ct.nom, montant: ct.montant, coop: coop?.nom });
  } else {
    await sendPush(ct.userId, '❌ Cotisation rejetée', `${ct.montant.toLocaleString()} FCFA rejeté. Vérifiez votre numéro de transaction.`);
  }
  writeDB(db);
  broadcastSSE('update', { type: 'cotisations', action: ct.statut, nom: ct.nom });
  res.json({ success: true, cotisation: ct });
});

// ══════════════════════════════════════════════════════════
// VOTES
// ══════════════════════════════════════════════════════════

app.get('/api/votes', (req, res) => {
  const db = readDB();
  let votes = db.votes;
  if (req.query.coopId) votes = votes.filter(v => v.coopId === req.query.coopId);
  if (req.query.statut) votes = votes.filter(v => v.statut === req.query.statut);
  res.json(votes.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
});

app.post('/api/votes', authenticateToken, requireRole('admin', 'super_admin'), (req, res) => {
  const { question, coopId, options, fin, seuil } = req.body;
  if (!question?.trim() || !coopId || !options || !fin) {
    return res.status(400).json({ success: false, error: 'Tous les champs sont requis.' });
  }
  const optArr = Array.isArray(options)
    ? options.filter(o => o?.trim())
    : options.split('\n').map(o => o.trim()).filter(Boolean);
  if (optArr.length < 2) return res.status(400).json({ success: false, error: 'Minimum 2 options requises.' });

  const db = readDB();
  if (!db.cooperatives.find(c => c.id === coopId)) {
    return res.status(404).json({ success: false, error: 'Coopérative non trouvée.' });
  }
  const newVote = {
    id: 'v' + uuidv4().replace(/-/g, '').substring(0, 8),
    question: question.trim(), coopId, options: optArr,
    votes: optArr.map(() => 0), voters: [],
    fin, seuil: parseInt(seuil) || 50, statut: 'actif',
    createdBy: req.user.id, createdAt: new Date().toISOString()
  };
  db.votes.push(newVote);
  writeDB(db);
  addToBlockchain('VOTE_CRÉÉ', question.trim(), null, req.user.id, newVote.id);
  broadcastSSE('update', { type: 'votes' });
  io.emit('vote_created', { question: newVote.question, id: newVote.id });
  res.json({ success: true, vote: newVote });
});

app.post('/api/votes/:id/voter', authenticateToken, (req, res) => {
  const { optionIndex } = req.body;
  const db = readDB();
  const vote = db.votes.find(v => v.id === req.params.id);
  if (!vote) return res.status(404).json({ success: false, error: 'Vote non trouvé.' });
  if (vote.statut !== 'actif') return res.status(400).json({ success: false, error: 'Ce vote est clôturé.' });
  if (new Date() > new Date(vote.fin)) {
    vote.statut = 'cloture';
    writeDB(db);
    return res.status(400).json({ success: false, error: 'Ce vote a expiré.' });
  }
  const idx = parseInt(optionIndex);
  if (isNaN(idx) || idx < 0 || idx >= vote.options.length) {
    return res.status(400).json({ success: false, error: 'Option invalide.' });
  }
  if (!vote.voters) vote.voters = [];
  if (vote.voters.includes(req.user.id)) {
    return res.status(400).json({ success: false, error: 'Vous avez déjà voté pour ce scrutin.' });
  }
  vote.votes[idx]++;
  vote.voters.push(req.user.id);
  writeDB(db);
  addToBlockchain('VOTE', `"${vote.question.substring(0, 50)}"`, null, req.user.id, vote.id + '-' + idx + '-' + req.user.id);
  broadcastSSE('update', { type: 'votes' });
  io.emit('vote_cast', { voteId: vote.id, optionIndex: idx });
  res.json({ success: true, vote });
});

app.patch('/api/votes/:id/cloturer', authenticateToken, requireRole('admin', 'super_admin'), (req, res) => {
  const db = readDB();
  const vote = db.votes.find(v => v.id === req.params.id);
  if (!vote) return res.status(404).json({ success: false, error: 'Vote non trouvé.' });
  vote.statut = 'cloture';
  const total = vote.votes.reduce((s, x) => s + x, 0);
  const winnerIdx = vote.votes.indexOf(Math.max(...vote.votes));
  addToBlockchain('VOTE_CLOS', `Résultat: "${vote.options[winnerIdx]}" (${total} votes)`, null, req.user.id, vote.id + '-close');
  writeDB(db);
  io.emit('vote_closed', { voteId: vote.id, winner: vote.options[winnerIdx] });
  res.json({ success: true, vote, winner: vote.options[winnerIdx] });
});

// ══════════════════════════════════════════════════════════
// MEMBRES
// ══════════════════════════════════════════════════════════

app.get('/api/membres', authenticateToken, requireRole('admin', 'super_admin'), (req, res) => {
  const db = readDB();
  let membres = db.membres;
  if (req.query.coopId) membres = membres.filter(m => m.coopId === req.query.coopId);
  res.json(membres);
});

// ══════════════════════════════════════════════════════════
// EXPORT PDF — RAPPORT AUTOMATIQUE
// ══════════════════════════════════════════════════════════

app.get('/api/export/rapport/:coopId?', authenticateToken, async (req, res) => {
  const db = readDB();
  const coopId = req.params.coopId;
  const coop = coopId ? db.cooperatives.find(c => c.id === coopId) : null;
  const cotisations = db.cotisations.filter(c => !coopId || c.coopId === coopId);
  const confirmees = cotisations.filter(c => c.statut === 'confirme');
  const pending = cotisations.filter(c => c.statut === 'pending');
  const totalCollected = confirmees.reduce((s, c) => s + c.montant, 0);

  const filename = `rapport_${coop ? coop.nom.replace(/\s+/g, '_') : 'global'}_${Date.now()}.pdf`;
  const filepath = path.join(REPORTS_DIR, filename);
  const doc = new PDFDocument({ margin: 50, size: 'A4', info: { Title: 'Rapport CoopÉnergie', Author: 'CoopÉnergie v4.0' } });
  const stream = fs.createWriteStream(filepath);
  doc.pipe(stream);

  // En-tête
  doc.rect(0, 0, 595, 120).fill('#0D1F16');
  doc.fillColor('#F5A623').fontSize(28).font('Helvetica-Bold').text('CoopÉnergie', 50, 30);
  doc.fillColor('white').fontSize(12).font('Helvetica').text('Rapport Financier & Décisionnel', 50, 65);
  doc.text(`Généré le : ${new Date().toLocaleDateString('fr-FR', { weekday:'long', year:'numeric', month:'long', day:'numeric' })}`, 50, 85);
  doc.fillColor('#0D1F16').moveDown(4);

  if (coop) {
    const pct = Math.round(coop.collecte / coop.objectif * 100);
    doc.fillColor('#1A7A4A').fontSize(18).font('Helvetica-Bold').text(`📍 ${coop.nom}`, 50, 140);
    doc.fillColor('#4A6655').fontSize(11).font('Helvetica');
    doc.text(`Localité : ${coop.lieu}`, 50, 165);
    doc.text(`Objectif : ${coop.objectif.toLocaleString()} FCFA`, 50, 180);
    doc.text(`Collecté : ${coop.collecte.toLocaleString()} FCFA (${pct}% de l'objectif)`, 50, 195);
    doc.text(`Membres : ${coop.membres} / ${coop.maxMembres}`, 50, 210);
    doc.text(`Cotisation minimale : ${coop.cotMin?.toLocaleString()} FCFA`, 50, 225);
    if (coop.description) doc.text(`Description : ${coop.description}`, 50, 240);

    // Barre de progression
    doc.rect(50, 265, 495, 12).fill('#E6F7EE');
    doc.rect(50, 265, Math.min(495 * pct / 100, 495), 12).fill('#2DB36B');
    doc.fillColor('#0D1F16').fontSize(10).text(`${pct}% atteint`, 50, 282);

    // Plan d'achat recommandé
    const restant = coop.objectif - coop.collecte;
    const membresRestants = coop.maxMembres - coop.membres;
    doc.fillColor('#1A7A4A').fontSize(14).font('Helvetica-Bold').text('📊 Plan d\'achat recommandé', 50, 305);
    doc.fillColor('#4A6655').fontSize(11).font('Helvetica');
    doc.text(`• Fonds encore à collecter : ${restant.toLocaleString()} FCFA`, 60, 325);
    if (membresRestants > 0) {
      doc.text(`• Places disponibles : ${membresRestants} membre(s) supplémentaire(s)`, 60, 340);
      doc.text(`• Cotisation moyenne par membre manquant : ${Math.ceil(restant / Math.max(membresRestants, 1)).toLocaleString()} FCFA`, 60, 355);
    }
    if (pct >= 100) {
      doc.fillColor('#1A7A4A').text('✅ Objectif atteint ! Procéder à l\'achat de l\'équipement.', 60, 370);
    } else if (pct >= 75) {
      doc.fillColor('#F5A623').text('⚡ Objectif presque atteint — accélérer la collecte.', 60, 370);
    }
    doc.moveDown(4);
  } else {
    // Rapport global
    const totalObj = db.cooperatives.reduce((s, c) => s + c.objectif, 0);
    const pctGlobal = Math.round(totalCollected / totalObj * 100);
    doc.fillColor('#1A7A4A').fontSize(18).font('Helvetica-Bold').text('Rapport Global CoopÉnergie', 50, 140);
    doc.fillColor('#4A6655').fontSize(11).font('Helvetica');
    doc.text(`Coopératives actives : ${db.cooperatives.length}`, 50, 165);
    doc.text(`Membres totaux : ${db.membres.length}`, 50, 180);
    doc.text(`Objectif global : ${totalObj.toLocaleString()} FCFA`, 50, 195);
    doc.text(`Total collecté : ${totalCollected.toLocaleString()} FCFA (${pctGlobal}%)`, 50, 210);
    doc.text(`Votes actifs : ${db.votes.filter(v => v.statut === 'actif').length}`, 50, 225);
    doc.text(`Transactions blockchain : ${db.blockchain.length}`, 50, 240);
    doc.moveDown(3);

    // Résumé par coopérative
    doc.fillColor('#1A7A4A').fontSize(14).font('Helvetica-Bold').text('Résumé par coopérative :', 50, 270);
    let yy = 290;
    db.cooperatives.forEach(c => {
      const p = Math.round(c.collecte / c.objectif * 100);
      doc.fillColor('#0D1F16').fontSize(11).font('Helvetica-Bold').text(c.nom, 60, yy);
      doc.font('Helvetica').fillColor('#4A6655').text(`${c.collecte.toLocaleString()} / ${c.objectif.toLocaleString()} FCFA — ${p}% — ${c.membres} membres`, 60, yy + 14);
      yy += 35;
    });
  }

  // Tableau des cotisations
  const startY = coop ? 400 : 420;
  doc.fillColor('#1A7A4A').fontSize(14).font('Helvetica-Bold').text('💰 Détail des cotisations validées', 50, startY);
  let y = startY + 24;
  doc.rect(50, y, 495, 18).fill('#E6F7EE');
  doc.fillColor('#0D1F16').fontSize(9).font('Helvetica-Bold');
  doc.text('Membre', 55, y + 4);
  doc.text('Montant', 200, y + 4);
  doc.text('Date', 300, y + 4);
  doc.text('Transaction', 370, y + 4);
  y += 20;

  doc.font('Helvetica').fontSize(9);
  confirmees.slice(0, 25).forEach((c, i) => {
    if (y > 720) {
      doc.addPage();
      y = 50;
      doc.rect(50, y, 495, 18).fill('#E6F7EE');
      doc.fillColor('#0D1F16').font('Helvetica-Bold');
      doc.text('Membre', 55, y + 4); doc.text('Montant', 200, y + 4); doc.text('Date', 300, y + 4); doc.text('Transaction', 370, y + 4);
      y += 20;
      doc.font('Helvetica');
    }
    if (i % 2 === 0) doc.rect(50, y - 2, 495, 16).fill('#FAFAFA');
    doc.fillColor('#0D1F16').text(c.nom.substring(0, 22), 55, y);
    doc.text(`${c.montant.toLocaleString()} FCFA`, 200, y);
    doc.text(c.date, 300, y);
    doc.text(c.txn, 370, y);
    y += 16;
  });

  if (pending.length > 0) {
    y += 16;
    doc.fillColor('#F5A623').fontSize(12).font('Helvetica-Bold').text(`⏳ ${pending.length} cotisation(s) en attente de validation`, 50, y);
  }

  // Footer
  doc.fillColor('#8A9A8F').fontSize(9).font('Helvetica');
  doc.text('CoopÉnergie · Projet CM-02 · Miabe Hackathon 2026 · DTC — Darollo Technologies Corporation', 50, 790, { align: 'center' });

  doc.end();
  stream.on('finish', () => {
    res.download(filepath, filename, () => {
      setTimeout(() => { try { fs.unlinkSync(filepath); } catch (e) {} }, 60000);
    });
  });
  stream.on('error', (err) => res.status(500).json({ success: false, error: 'Erreur génération PDF.' }));
});

// ══════════════════════════════════════════════════════════
// API PUBLIQUES
// ══════════════════════════════════════════════════════════

app.get('/api/data', (req, res) => {
  const db = readDB();
  const { users, config, ...safeDB } = db;
  res.json({ ...safeDB, config: { om_numero: config?.om_numero, om_nom: config?.om_nom } });
});

app.get('/api/blockchain', (req, res) => {
  const db = readDB();
  res.json([...db.blockchain].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
});

app.get('/api/stats', (req, res) => {
  const db = readDB();
  const confirmed = db.cotisations.filter(c => c.statut === 'confirme');
  const parMois = {};
  confirmed.forEach(c => {
    const m = (c.date || '').substring(0, 7);
    if (m) parMois[m] = (parMois[m] || 0) + c.montant;
  });
  res.json({
    cooperatives: db.cooperatives.length,
    membres: db.membres.length,
    utilisateurs: db.users.length,
    cotisations: {
      total: db.cotisations.length,
      pending: db.cotisations.filter(c => c.statut === 'pending').length,
      confirme: confirmed.length,
      rejected: db.cotisations.filter(c => c.statut === 'rejected').length
    },
    collecte: {
      total: confirmed.reduce((s, c) => s + c.montant, 0),
      objectif: db.cooperatives.reduce((s, c) => s + c.objectif, 0)
    },
    votes: {
      actifs: db.votes.filter(v => v.statut === 'actif').length,
      clotures: db.votes.filter(v => v.statut === 'cloture').length
    },
    blockchain: db.blockchain.length,
    parMois
  });
});

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();
  res.write(`event: connected\ndata: {"status":"ok","timestamp":"${new Date().toISOString()}"}\n\n`);
  sseClients.push(res);
  req.on('close', () => { sseClients = sseClients.filter(c => c !== res); });
});

app.get('/api/config', (req, res) => {
  const db = readDB();
  res.json({ om_numero: db.config?.om_numero, om_nom: db.config?.om_nom });
});

app.post('/api/config', authenticateToken, requireRole('super_admin'), (req, res) => {
  const { adminPin, ...updates } = req.body;
  const db = readDB();
  if (!bcrypt.compareSync(adminPin, db.config.admin_pin)) {
    return res.status(403).json({ success: false, error: 'PIN admin incorrect.' });
  }
  const allowed = ['om_numero', 'om_nom', 'site_name'];
  allowed.forEach(key => { if (updates[key] !== undefined) db.config[key] = updates[key]; });
  writeDB(db);
  res.json({ success: true });
});

app.get('/api/notifications', authenticateToken, (req, res) => {
  const db = readDB();
  const notifs = db.notifications.filter(n => n.userId === req.user.id).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(notifs);
});

app.post('/api/push/subscribe', authenticateToken, (req, res) => {
  const db = readDB();
  const { subscription } = req.body;
  if (!subscription) return res.status(400).json({ success: false, error: 'Subscription manquante.' });
  const idx = db.push_subscriptions.findIndex(s => s.userId === req.user.id);
  if (idx >= 0) db.push_subscriptions[idx] = { userId: req.user.id, ...subscription };
  else db.push_subscriptions.push({ userId: req.user.id, ...subscription });
  writeDB(db);
  res.json({ success: true });
});

// ─── Route par défaut ─────────────────────────────────────
app.get('*', (req, res) => {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(indexPath)) res.sendFile(indexPath);
  else res.json({ message: 'CoopÉnergie API v4.0', status: 'running', version: '4.0.0', hackathon: 'Miabe 2026 · CM-02' });
});

// ─── Gestion erreurs ──────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Erreur serveur:', err);
  res.status(500).json({ success: false, error: 'Erreur interne du serveur.' });
});

// ─── Démarrage ────────────────────────────────────────────
server.listen(PORT, () => {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  ☀️  CoopÉnergie Backend v4.0 — Miabe Hackathon 2026         ║');
  console.log(`║  🌐 http://localhost:${PORT}                                    ║`);
  console.log('║  💬 Chat temps réel — Socket.io                              ║');
  console.log('║  📄 Export PDF — Rapports automatiques                       ║');
  console.log('║  ⛓️  Blockchain simulée — Traçabilité complète                ║');
  console.log('║                                                              ║');
  console.log('║  🔐 Comptes de test :                                        ║');
  console.log('║     Super Admin : 698123456 / admin123                       ║');
  console.log('║     Marie Ateba : 697111222 / marie123                       ║');
  console.log('║     Jean Ndongo : 699333444 / jean123                        ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');
});
