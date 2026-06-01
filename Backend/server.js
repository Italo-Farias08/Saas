const express = require('express');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { Pool } = require('pg');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(__dirname));

// ─── PostgreSQL ───────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

const query = (text, params) => pool.query(text, params);

// ─── Multer — memória (sem disco) ─────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Apenas imagens são permitidas'));
  }
});
// ─── Pagamento PIX Manual ─────────────────────────────────────────────────────

const PIX_KEY = process.env.PIX_KEY || 'goldlinevsa@gmail.com';
const PIX_NAME = process.env.PIX_NAME || 'Italo Farias';
const PIX_VALUE = 29.90;
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'ZinksggZ2';

// Retorna os dados do PIX pro usuário
app.get('/api/payment/pix-info', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.user_id;
    const result = await query('SELECT paid, payment_status FROM users WHERE id = $1', [userId]);
    const user = result.rows[0];

    res.json({
      paid: user.paid,
      status: user.payment_status,
      pixKey: PIX_KEY,
      pixName: PIX_NAME,
      value: PIX_VALUE,
      userId: userId
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

// Você chama essa rota pra aprovar o pagamento de um usuário
app.post('/api/payment/approve', async (req, res) => {
  try {
    const { userId, secret } = req.body;

    if (secret !== ADMIN_SECRET) {
      return res.status(401).json({ error: 'Não autorizado' });
    }

    await query(
  'UPDATE users SET paid = TRUE, payment_status = $1 WHERE id = $2',
  ['approved', userId]
);
await query(
  'UPDATE site_configs SET published = TRUE WHERE user_id = $1',
  [userId]
);

    res.json({ success: true, message: `Usuário ${userId} aprovado!` });
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

// Usuário fica verificando se foi aprovado
app.get('/api/payment/status', authMiddleware, async (req, res) => {
  try {
    const result = await query(
      'SELECT paid, payment_status FROM users WHERE id = $1',
      [req.user.user_id]
    );
    res.json({
      paid: result.rows[0]?.paid ?? false,
      status: result.rows[0]?.payment_status ?? 'pending'
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function fileToBase64(file) {
  return `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;
}

// ─── Build Site Config ────────────────────────────────────────────────────────
async function buildSiteConfig(userId) {
  const [cfgRes, photosRes, milestonesRes, playlistRes, quizRes] = await Promise.all([
    query('SELECT * FROM site_configs WHERE user_id = $1', [userId]),
    query('SELECT * FROM photos WHERE user_id = $1 ORDER BY position', [userId]),
    query('SELECT * FROM milestones WHERE user_id = $1 ORDER BY position', [userId]),
    query('SELECT * FROM playlist WHERE user_id = $1 ORDER BY position', [userId]),
    query('SELECT * FROM quiz_questions WHERE user_id = $1 ORDER BY position', [userId]),
  ]);

  const c = cfgRes.rows[0];
  if (!c) return null;

  return {
    coupleNames:      c.couple_names,
    startDate:        c.start_date ? c.start_date.toISOString().split('T')[0] : '',
    heroSubtitle:     c.hero_subtitle,
    story:            c.story,
    primaryColor:     c.primary_color,
    secondaryColor:   c.secondary_color,
    accentColor:      c.accent_color,
    theme:            c.theme,
    profilePhoto:     c.profile_photo,
    message:          c.message,
    siteUrl:          c.site_url,
    published:        c.published,
    showCountdown:    c.show_countdown,
    countdownDate:    c.countdown_date ? c.countdown_date.toISOString().split('T')[0] : '',
    backgroundEffect: c.background_effect,
    musicEnabled:     c.music_enabled,
    quizEnabled:      c.quiz_enabled,
    photos: photosRes.rows.map(p => ({
      id: p.id, url: p.url, caption: p.caption, type: p.type
    })),
    milestones: milestonesRes.rows.map(m => ({
      id: m.id,
      date: m.date ? m.date.toISOString().split('T')[0] : '',
      title: m.title, description: m.description, icon: m.icon,
      photoUrl: m.photo_url || '',
      photoCaption: m.photo_caption || ''
    })),
    playlist: playlistRes.rows.map(p => ({
      id: p.id, title: p.title, artist: p.artist, youtubeId: p.youtube_id
    })),
    quizQuestions: quizRes.rows.map(q => ({
      id: q.id, question: q.question,
      options: Array.isArray(q.options) ? q.options : JSON.parse(q.options),
      correct: q.correct
    })),
  };
}

// ─── Save Site Config ─────────────────────────────────────────────────────────
async function saveSiteConfig(userId, body) {
  const cfg = body;

  await query(`
    UPDATE site_configs SET
      couple_names      = COALESCE($1, couple_names),
      start_date        = COALESCE($2::date, start_date),
      hero_subtitle     = COALESCE($3, hero_subtitle),
      story             = COALESCE($4, story),
      primary_color     = COALESCE($5, primary_color),
      secondary_color   = COALESCE($6, secondary_color),
      accent_color      = COALESCE($7, accent_color),
      theme             = COALESCE($8, theme),
      profile_photo     = COALESCE($9, profile_photo),
      message           = COALESCE($10, message),
      site_url          = COALESCE($11, site_url),
      published         = COALESCE($12, published),
      show_countdown    = COALESCE($13, show_countdown),
      countdown_date    = COALESCE($14::date, countdown_date),
      background_effect = COALESCE($15, background_effect),
      music_enabled     = COALESCE($16, music_enabled),
      quiz_enabled      = COALESCE($17, quiz_enabled),
      updated_at        = NOW()
    WHERE user_id = $18
  `, [
    cfg.coupleNames      ?? null,
    cfg.startDate        || null,
    cfg.heroSubtitle     ?? null,
    cfg.story            ?? null,
    cfg.primaryColor     ?? null,
    cfg.secondaryColor   ?? null,
    cfg.accentColor      ?? null,
    cfg.theme            ?? null,
    cfg.profilePhoto     ?? null,
    cfg.message          ?? null,
    cfg.siteUrl          ?? null,
    cfg.published        ?? null,
    cfg.showCountdown    ?? null,
    cfg.countdownDate    || null,
    cfg.backgroundEffect ?? null,
    cfg.musicEnabled     ?? null,
    cfg.quizEnabled      ?? null,
    userId,
  ]);

  // Fotos
  if (Array.isArray(cfg.photos)) {
    await query('DELETE FROM photos WHERE user_id = $1', [userId]);
    for (let i = 0; i < cfg.photos.length; i++) {
      const p = cfg.photos[i];
      await query(
        'INSERT INTO photos (user_id, url, caption, type, position) VALUES ($1,$2,$3,$4,$5)',
        [userId, p.url, p.caption || '', p.type || 'gallery', i + 1]
      );
    }
  }

  // Milestones
  if (Array.isArray(cfg.milestones)) {
    await query('DELETE FROM milestones WHERE user_id = $1', [userId]);
    for (let i = 0; i < cfg.milestones.length; i++) {
      const m = cfg.milestones[i];
      await query(
        'INSERT INTO milestones (user_id, date, title, description, icon, position, photo_url, photo_caption) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [userId, m.date, m.title, m.description || '', m.icon || '💘', i + 1, m.photoUrl || '', m.photoCaption || '']
      );
    }
  }

  // Playlist
  if (Array.isArray(cfg.playlist)) {
    await query('DELETE FROM playlist WHERE user_id = $1', [userId]);
    for (let i = 0; i < cfg.playlist.length; i++) {
      const p = cfg.playlist[i];
      await query(
        'INSERT INTO playlist (user_id, title, artist, youtube_id, position) VALUES ($1,$2,$3,$4,$5)',
        [userId, p.title, p.artist, p.youtubeId, i + 1]
      );
    }
  }

  // Quiz
  if (Array.isArray(cfg.quizQuestions)) {
    await query('DELETE FROM quiz_questions WHERE user_id = $1', [userId]);
    for (let i = 0; i < cfg.quizQuestions.length; i++) {
      const q = cfg.quizQuestions[i];
      await query(
        'INSERT INTO quiz_questions (user_id, question, options, correct, position) VALUES ($1,$2,$3,$4,$5)',
        [userId, q.question, JSON.stringify(q.options), q.correct, i + 1]
      );
    }
  }
}

// ─── Auth Middleware ──────────────────────────────────────────────────────────
async function authMiddleware(req, res, next) {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Não autorizado' });

    const result = await query('SELECT * FROM sessions WHERE token = $1', [token]);
    if (!result.rows.length) return res.status(401).json({ error: 'Não autorizado' });

    req.user = result.rows[0];
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno' });
  }
}

// ─── Auth Routes ──────────────────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const result = await query(
      'SELECT * FROM users WHERE email = $1 AND password = $2',
      [email, hashPassword(password)]
    );
    if (!result.rows.length) return res.status(401).json({ error: 'Email ou senha inválidos' });

    const user = result.rows[0];
    const token = generateToken();
    await query(
      'INSERT INTO sessions (token, user_id, email) VALUES ($1, $2, $3)',
      [token, user.id, user.email]
    );

    res.json({ token, user: { id: user.id, name: user.name, email: user.email, plan: user.plan } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;

    const exists = await query('SELECT id FROM users WHERE email = $1', [email]);
    if (exists.rows.length) return res.status(400).json({ error: 'Email já cadastrado' });

    const slug = name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-');

    let siteUrl = slug;
    const slugCheck = await query('SELECT id FROM site_configs WHERE site_url = $1', [slug]);
    if (slugCheck.rows.length) siteUrl = `${slug}-${Date.now()}`;

    const userRes = await query(
      'INSERT INTO users (name, email, password, plan) VALUES ($1,$2,$3,$4) RETURNING *',
      [name, email, hashPassword(password), 'free']
    );
    const user = userRes.rows[0];

    await query(`
      INSERT INTO site_configs (user_id, couple_names, start_date, site_url, published)
      VALUES ($1, $2, CURRENT_DATE, $3, FALSE)
    `, [user.id, name, siteUrl]);

    const token = generateToken();
    await query('INSERT INTO sessions (token, user_id, email) VALUES ($1,$2,$3)', [token, user.id, email]);

    res.json({ token, user: { id: user.id, name: user.name, email: user.email, plan: user.plan } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

app.post('/api/auth/logout', authMiddleware, async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    await query('DELETE FROM sessions WHERE token = $1', [token]);
    res.json({ message: 'Logout realizado' });
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ─── Upload — base64 no banco ─────────────────────────────────────────────────
app.post('/api/upload', authMiddleware, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhuma imagem enviada' });
  const url = fileToBase64(req.file);
  res.json({ url, filename: req.file.originalname });
});

app.post('/api/upload/profile', authMiddleware, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Nenhuma imagem enviada' });
    const url = fileToBase64(req.file);
    await query('UPDATE site_configs SET profile_photo = $1 WHERE user_id = $2', [url, req.user.user_id]);
    res.json({ url });
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ─── Site Config ──────────────────────────────────────────────────────────────
app.get('/api/site/config', authMiddleware, async (req, res) => {
  try {
    const config = await buildSiteConfig(req.user.user_id);
    if (!config) return res.status(404).json({ error: 'Configuração não encontrada' });
    res.json(config);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

app.put('/api/site/config', authMiddleware, async (req, res) => {
  try {
    await saveSiteConfig(req.user.user_id, req.body);
    const config = await buildSiteConfig(req.user.user_id);
    res.json({ success: true, config });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

app.post('/api/site/publish', authMiddleware, async (req, res) => {
  try {
    await query('UPDATE site_configs SET published = TRUE WHERE user_id = $1', [req.user.user_id]);
    const cfgRes = await query('SELECT site_url FROM site_configs WHERE user_id = $1', [req.user.user_id]);
    const siteUrl = cfgRes.rows[0]?.site_url;
    res.json({ success: true, url: `/site/${siteUrl}` });
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

app.get('/api/public/:siteUrl', async (req, res) => {
  try {
    const cfgRes = await query(
      'SELECT user_id, published FROM site_configs WHERE site_url = $1',
      [req.params.siteUrl]
    );
    if (!cfgRes.rows.length) return res.status(404).json({ error: 'Site não encontrado' });
    if (!cfgRes.rows[0].published) return res.status(403).json({ error: 'Site ainda não publicado' });

    const userId = cfgRes.rows[0].user_id;

    await query(`
      INSERT INTO site_views (site_url, count) VALUES ($1, 1)
      ON CONFLICT (site_url) DO UPDATE SET count = site_views.count + 1
    `, [req.params.siteUrl]);

    const config = await buildSiteConfig(userId);
    res.json(config);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ─── Stats ────────────────────────────────────────────────────────────────────
app.get('/api/stats', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.user_id;

    const [cfgRes, photosRes, milestonesRes, userRes] = await Promise.all([
      query('SELECT start_date, site_url FROM site_configs WHERE user_id = $1', [userId]),
      query('SELECT COUNT(*) FROM photos WHERE user_id = $1', [userId]),
      query('SELECT COUNT(*) FROM milestones WHERE user_id = $1', [userId]),
      query('SELECT plan FROM users WHERE id = $1', [userId]),
    ]);

    const cfg = cfgRes.rows[0];
    const startDate = cfg?.start_date ? new Date(cfg.start_date) : new Date();
    const diffMs = Date.now() - startDate.getTime();
    const days = Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));

    const viewsReal = cfg?.site_url
      ? await query('SELECT count FROM site_views WHERE site_url = $1', [cfg.site_url])
      : { rows: [] };

    res.json({
      daysTogetherr:   days,
      photosCount:     parseInt(photosRes.rows[0].count, 10),
      milestonesCount: parseInt(milestonesRes.rows[0].count, 10),
      siteViews:       parseInt(viewsReal.rows[0]?.count ?? 0, 10),
      plan:            userRes.rows[0]?.plan ?? 'free',
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ─── HTML Pages ───────────────────────────────────────────────────────────────
app.get('/',        (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.get('/login',   (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.get('/admin',   (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/site/:siteUrl', (req, res) => res.sendFile(path.join(__dirname, 'site.html')));
app.get('/payment/pending', (req, res) => res.sendFile(path.join(__dirname, 'payment.html')));
app.get('/painel', (req, res) => res.sendFile(path.join(__dirname, 'painel.html')));

app.get('/api/admin/pendentes', async (req, res) => {
  try {
    const { secret } = req.query;
    if (secret !== ADMIN_SECRET) return res.status(401).json({ error: 'Não autorizado' });
    const result = await query(`
      SELECT u.id, u.name, u.email, u.created_at, u.paid, u.payment_status
      FROM users u
      ORDER BY u.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

app.delete('/api/admin/site/:userId', async (req, res) => {
  try {
    const { secret } = req.query;
    if (secret !== ADMIN_SECRET) return res.status(401).json({ error: 'Não autorizado' });
    const { userId } = req.params;
    await query('DELETE FROM photos WHERE user_id = $1', [userId]);
    await query('DELETE FROM milestones WHERE user_id = $1', [userId]);
    await query('DELETE FROM playlist WHERE user_id = $1', [userId]);
    await query('DELETE FROM quiz_questions WHERE user_id = $1', [userId]);
    await query('DELETE FROM site_configs WHERE user_id = $1', [userId]);
    await query('DELETE FROM sessions WHERE user_id = $1', [userId]);
    await query('DELETE FROM users WHERE id = $1', [userId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

pool.connect()
  .then(() => {
    console.log('✅ PostgreSQL conectado!');
    app.listen(PORT, () => {
      console.log(`\n💕 AmorEterno rodando na porta ${PORT}`);
      console.log(`   → http://localhost:${PORT}`);
      console.log(`\n   Demo: demo@amor.com / 123456\n`);
    });
  })
  .catch(err => {
    console.error('❌ Falha ao conectar no PostgreSQL:', err.message);
    process.exit(1);
  });