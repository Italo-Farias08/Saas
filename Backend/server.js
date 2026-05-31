const express = require('express');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const fs = require('fs');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static('.'));

// Serve uploaded images
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
app.use('/uploads', express.static(uploadsDir));

// Multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Apenas imagens são permitidas'));
  }
});

// ─── FIX: parse de data sem desvio de fuso horário ──────────────────────────
// "2024-10-03" interpretado como UTC vira dia 2 no Brasil (UTC-3).
// Solução: adicionar T12:00:00 para tratar como horário local.
function parseLocalDate(str) {
  if (!str) return new Date();
  return new Date(str + 'T12:00:00');
}

// ─── In-memory database ───────────────────────────────────────────────────────
const db = {
  users: [
    {
      id: '1',
      name: 'Ana & João',
      email: 'demo@amor.com',
      password: hashPassword('123456'),
      plan: 'premium',
      createdAt: new Date('2024-01-01'),
      siteConfig: {
        coupleNames: 'Ana & João',
        startDate: '2022-02-14',
        heroSubtitle: 'Cada dia ao seu lado é um presente que o universo me deu.',
        story: 'Nos conhecemos numa tarde de domingo, quando o destino resolveu ser generoso. Desde então, cada amanhecer ficou mais bonito, cada risada ficou mais gostosa, e cada abraço virou lar.',
        primaryColor: '#e91e8c',
        secondaryColor: '#f06292',
        accentColor: '#ff4081',
        theme: 'rose',
        profilePhoto: '',
        photos: [
          { id: 1, url: 'https://images.unsplash.com/photo-1529333166437-7750a6dd5a70?w=600', caption: 'Aquele dia inesquecível', type: 'gallery' },
          { id: 2, url: 'https://images.unsplash.com/photo-1516589178581-6cd7833ae3b2?w=600', caption: 'Juntos para sempre', type: 'gallery' },
          { id: 3, url: 'https://images.unsplash.com/photo-1474552226712-ac0f0961a954?w=600', caption: 'Nosso amor em flor', type: 'gallery' },
        ],
        milestones: [
          { id: 1, date: '2022-02-14', title: 'Primeiro Encontro', description: 'O dia em que tudo começou 🌹', icon: '💘' },
          { id: 2, date: '2022-04-20', title: 'Primeiro Beijo', description: 'Embaixo da chuva, inesquecível', icon: '💋' },
          { id: 3, date: '2022-08-14', title: '6 Meses Juntos', description: 'Celebramos com jantar a luz de velas', icon: '🕯️' },
          { id: 4, date: '2023-02-14', title: '1 Ano de Amor', description: 'Uma viagem surpresa para o litoral', icon: '🏖️' },
        ],
        playlist: [
          { id: 1, title: 'Perfect', artist: 'Ed Sheeran', youtubeId: '2Vv-BfVoq4g' },
          { id: 2, title: 'All of Me', artist: 'John Legend', youtubeId: '450p7goxZqg' },
          { id: 3, title: 'A Thousand Years', artist: 'Christina Perri', youtubeId: 'rtOvBOTyX00' },
        ],
        message: 'Você é minha casa, meu lar, meu tudo. Obrigado por existir e por me escolher todos os dias.',
        siteUrl: 'demo',
        published: true,
        showCountdown: true,
        countdownDate: '2026-06-12',
        backgroundEffect: 'petals',
        musicEnabled: true,
        quizEnabled: true,
        quizQuestions: [
          { id: 1, question: 'Onde nos conhecemos?', options: ['Shopping', 'Faculdade', 'App de música', 'Casa de amigos'], correct: 2 },
          { id: 2, question: 'Qual a cor favorita dela?', options: ['Azul', 'Rosa', 'Roxo', 'Verde'], correct: 1 },
          { id: 3, question: 'Qual foi nosso primeiro filme juntos?', options: ['Titanic', 'La La Land', 'Divertida Mente', 'Avengers'], correct: 1 },
        ]
      }
    }
  ],
  sessions: {},
  views: {}
};

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token || !db.sessions[token]) {
    return res.status(401).json({ error: 'Não autorizado' });
  }
  req.user = db.sessions[token];
  next();
}

// ─── Auth Routes ─────────────────────────────────────────────────────────────
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  const user = db.users.find(u => u.email === email && u.password === hashPassword(password));
  if (!user) return res.status(401).json({ error: 'Email ou senha inválidos' });
  
  const token = generateToken();
  db.sessions[token] = { userId: user.id, email: user.email };
  
  res.json({
    token,
    user: { id: user.id, name: user.name, email: user.email, plan: user.plan }
  });
});

app.post('/api/auth/register', (req, res) => {
  const { name, email, password } = req.body;
  if (db.users.find(u => u.email === email)) {
    return res.status(400).json({ error: 'Email já cadastrado' });
  }
  
  const slug = name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-');
  
  const newUser = {
    id: Date.now().toString(),
    name, email,
    password: hashPassword(password),
    plan: 'free',
    createdAt: new Date(),
    siteConfig: {
      coupleNames: name,
      startDate: new Date().toISOString().split('T')[0],
      heroSubtitle: 'O amor que transforma tudo.',
      story: 'Escreva aqui a história de vocês...',
      primaryColor: '#e91e8c',
      secondaryColor: '#f06292',
      accentColor: '#ff4081',
      theme: 'rose',
      profilePhoto: '',
      photos: [],
      milestones: [],
      playlist: [],
      message: 'Escreva uma mensagem especial...',
      siteUrl: slug,
      published: false,
      showCountdown: true,
      countdownDate: '2026-06-12',
      backgroundEffect: 'petals',
      musicEnabled: false,
      quizEnabled: false,
      quizQuestions: []
    }
  };
  
  db.users.push(newUser);
  const token = generateToken();
  db.sessions[token] = { userId: newUser.id, email: newUser.email };
  
  res.json({
    token,
    user: { id: newUser.id, name: newUser.name, email: newUser.email, plan: newUser.plan }
  });
});

app.post('/api/auth/logout', authMiddleware, (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  delete db.sessions[token];
  res.json({ message: 'Logout realizado' });
});

// ─── Image Upload ─────────────────────────────────────────────────────────────
app.post('/api/upload', authMiddleware, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhuma imagem enviada' });
  const url = `/uploads/${req.file.filename}`;
  res.json({ url, filename: req.file.filename });
});

app.post('/api/upload/profile', authMiddleware, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhuma imagem enviada' });
  const user = db.users.find(u => u.id === req.user.userId);
  const url = `/uploads/${req.file.filename}`;
  user.siteConfig.profilePhoto = url;
  res.json({ url });
});

// ─── Site Config Routes ───────────────────────────────────────────────────────
app.get('/api/site/config', authMiddleware, (req, res) => {
  const user = db.users.find(u => u.id === req.user.userId);
  res.json(user.siteConfig);
});

app.put('/api/site/config', authMiddleware, (req, res) => {
  const user = db.users.find(u => u.id === req.user.userId);
  user.siteConfig = { ...user.siteConfig, ...req.body };
  res.json({ success: true, config: user.siteConfig });
});

app.post('/api/site/publish', authMiddleware, (req, res) => {
  const user = db.users.find(u => u.id === req.user.userId);
  user.siteConfig.published = true;
  res.json({ success: true, url: `/site/${user.siteConfig.siteUrl}` });
});

// ─── Public Site Route ────────────────────────────────────────────────────────
app.get('/api/public/:siteUrl', (req, res) => {
  const user = db.users.find(u =>
    u.siteConfig.siteUrl === req.params.siteUrl && u.siteConfig.published
  );
  if (!user) return res.status(404).json({ error: 'Site não encontrado' });
  
  const key = req.params.siteUrl;
  db.views[key] = (db.views[key] || 0) + 1;
  
  res.json(user.siteConfig);
});

// ─── Stats ────────────────────────────────────────────────────────────────────
app.get('/api/stats', authMiddleware, (req, res) => {
  const user = db.users.find(u => u.id === req.user.userId);

  // FIX: usa parseLocalDate para calcular dias corretamente no fuso do servidor
  // No servidor Node.js, new Date('2024-10-03') também interpreta como UTC midnight
  const startDate = parseLocalDate(user.siteConfig.startDate);
  const now = new Date();
  const diffMs = now - startDate;
  // Garante que não retorna negativo
  const days = Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
  
  res.json({
    daysTogetherr: days,
    photosCount: (user.siteConfig.photos || []).length,
    milestonesCount: (user.siteConfig.milestones || []).length,
    siteViews: db.views[user.siteConfig.siteUrl] || 0,
    plan: user.plan
  });
});

// ─── Serve HTML files ─────────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/site/:siteUrl', (req, res) => res.sendFile(path.join(__dirname, 'site.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n💕 AmorEterno rodando na porta ${PORT}`);
  console.log(`   → http://localhost:${PORT}`);
  console.log(`\n   Demo: demo@amor.com / 123456\n`);
  console.log(`   Nota: instale multer → npm install multer\n`);
});