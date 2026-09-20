const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 3000);
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('GOLDUP ERROR: DATABASE_URL environment variable is missing.');
  process.exit(1);
}

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '12mb' }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'CHANGE_ME_GOLDUP_SESSION_SECRET',
  resave: false,
  saveUninitialized: false,
  proxy: true,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 1000 * 60 * 60 * 24 * 30 }
}));

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

const svg = (label) => 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect width="100%" height="100%" rx="28" fill="#20263a"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="#ffd447" font-family="Arial" font-size="42" font-weight="700">${label}</text></svg>`);

function seedState() {
  let s = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed.json'), 'utf8'));
  s.users = Array.isArray(s.users) ? s.users : [];
  s.cases = Array.isArray(s.cases) ? s.cases : [];
  s.codes = Array.isArray(s.codes) ? s.codes : [];
  s.promoCodes = Array.isArray(s.promoCodes) ? s.promoCodes : [];
  s.stats = s.stats || { totalOpens: 0, totalSpent: 0, totalSkinsWon: 0, byCase: {}, lastOpens: [] };
  s.users[0] = s.users[0] || { id: '100001', name: 'Admin', email: 'admin@goldup.local', balance: 0, admin: true, inventory: [], usedCodes: [], usedPromoCodes: [], luck2x: false };
  s.users[0].id = '100001'; s.users[0].email = 'admin@goldup.local'; s.users[0].admin = true;
  s.users[0].inventory = Array.isArray(s.users[0].inventory) ? s.users[0].inventory : [];
  s.users[0].usedCodes = Array.isArray(s.users[0].usedCodes) ? s.users[0].usedCodes : [];
  s.users[0].usedPromoCodes = Array.isArray(s.users[0].usedPromoCodes) ? s.users[0].usedPromoCodes : [];
  s.users[0].luck2x = !!s.users[0].luck2x;
  const labels = { c1: ['GOLD CASE', ['GLOCK', 'AKR', 'M4', 'USP']], c2: ['PREMIUM', ['AWM', 'AKR', 'M4 GOLD']] };
  s.cases.forEach(c => {
    const z = labels[c.id];
    c.skins = Array.isArray(c.skins) ? c.skins : [];
    if (z) { c.image = c.image || svg(z[0]); c.skins.forEach((x, i) => { if (!x.image) x.image = svg(z[1][i] || x.name || 'SKIN'); }); }
  });
  return s;
}

function userById(s, id) { return s.users.find(u => String(u.id) === String(id)); }
function publicState(s, current) {
  const copy = JSON.parse(JSON.stringify(s));
  copy.current = current || null;
  copy.users = copy.users.map(u => { const x = { ...u }; delete x.pass; return x; });
  return copy;
}
async function getState(client = pool) {
  const r = await client.query('SELECT json FROM app_state WHERE id=1');
  return JSON.parse(r.rows[0].json);
}
async function setState(s, client = pool) {
  await client.query('UPDATE app_state SET json=$1 WHERE id=1', [JSON.stringify(s)]);
}

async function initDb() {
  await pool.query(`CREATE TABLE IF NOT EXISTS app_state (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS users_auth (id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,pass_hash TEXT NOT NULL,admin INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS code_redemptions (user_id TEXT NOT NULL,code TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),PRIMARY KEY(user_id,code));
    CREATE TABLE IF NOT EXISTS promo_redemptions (user_id TEXT NOT NULL,code TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),PRIMARY KEY(user_id,code));`);
  const r = await pool.query('SELECT 1 FROM app_state WHERE id=1');
  if (!r.rowCount) {
    await pool.query('INSERT INTO app_state(id,json) VALUES(1,$1)', [JSON.stringify(seedState())]);
  }
  await ensureAdmin();
}

async function ensureAdmin() {
  const id = '100001', email = 'admin@goldup.local', password = 'admin123';
  const hash = bcrypt.hashSync(password, 12);
  const row = await pool.query('SELECT id FROM users_auth WHERE email=$1', [email]);
  if (row.rowCount) await pool.query('UPDATE users_auth SET id=$1,pass_hash=$2,admin=1 WHERE email=$3', [id, hash, email]);
  else await pool.query('INSERT INTO users_auth(id,email,pass_hash,admin) VALUES($1,$2,$3,1) ON CONFLICT(id) DO UPDATE SET email=EXCLUDED.email,pass_hash=EXCLUDED.pass_hash,admin=1', [id, email, hash]);
  const s = await getState();
  let u = userById(s, id);
  if (!u) { u = { id, name: 'Admin', email, balance: 0, admin: true, inventory: [], avatar: svg('ADMIN'), usedCodes: [], usedPromoCodes: [], luck2x: false }; s.users.push(u); }
  u.id = id; u.email = email; u.admin = true;
  u.inventory = Array.isArray(u.inventory) ? u.inventory : [];
  u.usedCodes = Array.isArray(u.usedCodes) ? u.usedCodes : [];
  u.usedPromoCodes = Array.isArray(u.usedPromoCodes) ? u.usedPromoCodes : [];
  await setState(s);
}

function auth(req, res, next) { if (!req.session.userId) return res.status(401).json({ error: 'Kirish talab qilinadi.' }); next(); }
async function admin(req, res, next) {
  const a = await pool.query('SELECT admin FROM users_auth WHERE id=$1', [req.session.userId]);
  if (!a.rows[0]?.admin) return res.status(403).json({ error: 'Admin huquqi kerak.' });
  next();
}

app.get('/api/health', async (req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true, service: 'GOLDUP', database: 'postgres', time: new Date().toISOString() }); }
  catch (e) { res.status(500).json({ ok: false, error: 'Database ulanmagan.' }); }
});

app.get('/api/bootstrap', async (req, res) => {
  try {
    let s;
    try {
      s = await getState();
    } catch (readErr) {
      console.error('GOLDUP /api/bootstrap state read error:', readErr);
      await pool.query(`CREATE TABLE IF NOT EXISTS app_state (
        id INTEGER PRIMARY KEY CHECK(id=1),
        json TEXT NOT NULL
      )`);
      const row = await pool.query('SELECT json FROM app_state WHERE id=1');
      if (!row.rowCount) {
        s = seedState();
        await pool.query(
          'INSERT INTO app_state(id,json) VALUES(1,$1) ON CONFLICT(id) DO NOTHING',
          [JSON.stringify(s)]
        );
        s = await getState();
      } else {
        try {
          s = JSON.parse(row.rows[0].json);
        } catch (parseErr) {
          console.error('GOLDUP /api/bootstrap invalid state JSON:', parseErr);
          s = seedState();
          await pool.query('UPDATE app_state SET json=$1 WHERE id=1', [JSON.stringify(s)]);
        }
      }
    }
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.json({ ok: true, state: publicState(s, req.session.userId || null) });
  } catch (e) {
    console.error('GOLDUP /api/bootstrap fatal error:', e);
    res.status(500).json({
      ok: false,
      error: 'Server state yuklanmadi.',
      detail: process.env.NODE_ENV === 'production' ? undefined : String(e.message || e)
    });
  }
});

app.post('/api/migrate', auth, async (req, res) => {
  const incoming = req.body;
  if (!incoming || typeof incoming !== 'object') return res.json({ ok: true });
  const s = await getState();
  if (Array.isArray(incoming.cases)) {
    const byId = new Map(s.cases.map(x => [String(x.id), x]));
    for (const c of incoming.cases) {
      if (!c?.id) continue;
      const old = byId.get(String(c.id));
      if (!old) byId.set(String(c.id), JSON.parse(JSON.stringify(c)));
      else if (Array.isArray(c.skins)) {
        const sm = new Map((old.skins || []).map(x => [String(x.id), x]));
        for (const sk of c.skins) if (sk?.id && !sm.has(String(sk.id))) sm.set(String(sk.id), sk);
        old.skins = [...sm.values()];
      }
    }
    s.cases = [...byId.values()];
  }
  if (Array.isArray(incoming.codes)) for (const c of incoming.codes) if (c?.code && !s.codes.some(x => x.code === c.code)) s.codes.push({ ...c, uses: 0 });
  if (Array.isArray(incoming.promoCodes)) for (const p of incoming.promoCodes) if (p?.code && !s.promoCodes.some(x => x.code === p.code)) s.promoCodes.push({ ...p, uses: 0 });
  if (Array.isArray(incoming.users)) for (const u of incoming.users) {
    if (!u?.email || u.admin || s.users.some(x => x.email === u.email)) continue;
    const id = String(u.id || Math.floor(100000 + Math.random() * 899999));
    const nu = { ...u, id, admin: false }; delete nu.pass; s.users.push(nu);
    if (u.pass) await pool.query('INSERT INTO users_auth(id,email,pass_hash,admin) VALUES($1,$2,$3,0) ON CONFLICT(email) DO NOTHING', [id, u.email, bcrypt.hashSync(u.pass, 12)]);
  }
  await setState(s); res.json({ ok: true });
});

app.post('/api/register', async (req, res) => {
  const { name, email, password } = req.body || {};
  const e = String(email || '').trim().toLowerCase();
  if (!name || !/^\S+@\S+\.\S+$/.test(e) || String(password || '').length < 6) return res.status(400).json({ error: 'Ma’lumotlarni to‘g‘ri kiriting.' });
  if ((await pool.query('SELECT id FROM users_auth WHERE email=$1', [e])).rowCount) return res.status(409).json({ error: 'Bu email allaqachon mavjud.' });
  const s = await getState(); let id; do { id = String(Math.floor(100000 + Math.random() * 899999)); } while (userById(s, id));
  const u = { id, name: String(name).trim(), email: e, balance: 0, admin: false, inventory: [], avatar: svg('USER'), usedCodes: [], usedPromoCodes: [], luck2x: false };
  s.users.push(u);
  await pool.query('INSERT INTO users_auth(id,email,pass_hash,admin) VALUES($1,$2,$3,0)', [id, e, bcrypt.hashSync(password, 12)]);
  await setState(s); req.session.userId = id; res.json({ state: publicState(s, id) });
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body || {};
  const a = (await pool.query('SELECT * FROM users_auth WHERE email=$1', [String(email || '').trim().toLowerCase()])).rows[0];
  if (!a || !bcrypt.compareSync(String(password || ''), a.pass_hash)) return res.status(401).json({ error: 'Email yoki parol noto‘g‘ri.' });
  req.session.userId = a.id; res.json({ state: publicState(await getState(), a.id) });
});
app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));

app.post('/api/redeem-code', auth, async (req, res) => {
  const code = String(req.body?.code || '').trim().toUpperCase();
  if (!code) return res.status(400).json({ error: 'Kodni kiriting.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const s = await getState(client); const u = userById(s, req.session.userId);
    if (!u) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Mijoz topilmadi.' }); }
    const c = s.codes.find(x => x.code === code);
    if (!c || Number(c.uses || 0) >= Number(c.max || 0)) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Kod noto‘g‘ri yoki foydalanish limiti tugagan.' }); }
    try { await client.query('INSERT INTO code_redemptions(user_id,code) VALUES($1,$2)', [u.id, code]); }
    catch (e) { if (e.code === '23505') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Bu promokodni siz allaqachon ishlatgansiz.' }); } throw e; }
    c.uses = Number(c.uses || 0) + 1; u.balance = Number(u.balance || 0) + Number(c.amount || 0); u.usedCodes = Array.isArray(u.usedCodes) ? u.usedCodes : []; if (!u.usedCodes.includes(code)) u.usedCodes.push(code);
    await setState(s, client); await client.query('COMMIT'); res.json({ ok: true, state: publicState(s, u.id), amount: Number(c.amount || 0) });
  } catch (e) { await client.query('ROLLBACK'); console.error(e); res.status(500).json({ error: 'Server xatosi.' }); }
  finally { client.release(); }
});

app.post('/api/redeem-case-promo', auth, async (req, res) => {
  const code = String(req.body?.code || '').trim().toUpperCase(), caseId = String(req.body?.caseId || '');
  const client = await pool.connect();
  try {
    await client.query('BEGIN'); const s = await getState(client); const u = userById(s, req.session.userId); const p = s.promoCodes.find(x => x.code === code && String(x.caseId) === caseId);
    if (!u || !p || Number(p.uses || 0) >= Number(p.max || 0)) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Kod noto‘g‘ri, boshqa keyga tegishli yoki limiti tugagan.' }); }
    try { await client.query('INSERT INTO promo_redemptions(user_id,code) VALUES($1,$2)', [u.id, code]); }
    catch (e) { if (e.code === '23505') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Bu promokodni siz allaqachon ishlatgansiz.' }); } throw e; }
    p.uses = Number(p.uses || 0) + 1; u.usedPromoCodes = Array.isArray(u.usedPromoCodes) ? u.usedPromoCodes : []; if (!u.usedPromoCodes.includes(code)) u.usedPromoCodes.push(code); u.caseDiscounts = u.caseDiscounts || {}; u.caseDiscounts[caseId] = Math.max(Number(u.caseDiscounts[caseId] || 0), Math.min(100, Number(p.discount) || 0));
    await setState(s, client); await client.query('COMMIT'); res.json({ ok: true, state: publicState(s, u.id), discount: Number(p.discount || 0) });
  } catch (e) { await client.query('ROLLBACK'); console.error(e); res.status(500).json({ error: 'Server xatosi.' }); }
  finally { client.release(); }
});

app.post('/api/admin/balance', auth, admin, async (req, res) => {
  const id = String(req.body?.id || ''), amount = Number(req.body?.amount || 0), sign = String(req.body?.sign || '+');
  if (!id || !Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'Miqdor noto‘g‘ri.' });
  const s = await getState(), u = userById(s, id); if (!u || u.admin) return res.status(404).json({ error: 'Mijoz topilmadi.' });
  const delta = sign === '-' ? -Math.abs(amount) : Math.abs(amount), next = Number(u.balance || 0) + delta; if (next < 0) return res.status(400).json({ error: 'Balans 0 dan past bo‘lishi mumkin emas.' });
  u.balance = +next.toFixed(2); await setState(s); res.json({ state: publicState(s, req.session.userId) });
});

app.post('/api/sync', auth, async (req, res) => {
  const incoming = req.body; if (!incoming || typeof incoming !== 'object') return res.status(400).json({ error: 'Noto‘g‘ri ma’lumot.' });
  const s = await getState(), me = userById(s, req.session.userId), isAdmin = !!me?.admin; if (!me) return res.status(401).json({ error: 'Kirish talab qilinadi.' });
  if (isAdmin) {
    if (Array.isArray(incoming.cases)) {
      const byId = new Map(s.cases.map(c => [String(c.id), c]));
      for (const incomingCase of incoming.cases) {
        if (!incomingCase?.id) continue; const id = String(incomingCase.id); const existing = byId.get(id);
        if (!existing) { byId.set(id, JSON.parse(JSON.stringify(incomingCase))); continue; }
        const skins = Array.isArray(incomingCase.skins) ? incomingCase.skins : []; Object.assign(existing, incomingCase);
        const oldSkins = new Map((existing.skins || []).map(x => [String(x.id), x]));
        for (const incomingSkin of skins) if (incomingSkin?.id) oldSkins.set(String(incomingSkin.id), JSON.parse(JSON.stringify(incomingSkin)));
        existing.skins = [...oldSkins.values()];
      }
      s.cases = [...byId.values()];
    }
    if (Array.isArray(incoming.codes)) s.codes = incoming.codes;
    if (Array.isArray(incoming.promoCodes)) s.promoCodes = incoming.promoCodes;
    if (incoming.stats && typeof incoming.stats === 'object') s.stats = incoming.stats;
  }
  if (Array.isArray(incoming.users)) for (const inc of incoming.users) {
    if (String(inc.id) !== String(req.session.userId) && !isAdmin) continue; const u = userById(s, inc.id); if (!u) continue;
    if (isAdmin) { const allowed = { ...inc }; delete allowed.pass; delete allowed.id; delete allowed.email; if (u.admin) allowed.admin = true; Object.assign(u, allowed); }
    else { const allowed = { name: inc.name, avatar: inc.avatar, inventory: inc.inventory, usedCodes: inc.usedCodes, usedPromoCodes: inc.usedPromoCodes, caseDiscounts: inc.caseDiscounts }; Object.keys(allowed).forEach(k => { if (allowed[k] !== undefined) u[k] = allowed[k]; }); }
  }
  await setState(s); res.json({ ok: true, state: publicState(s, req.session.userId) });
});

app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

initDb().then(() => {
  app.listen(PORT, () => console.log(`GOLDUP PostgreSQL server: http://localhost:${PORT}`));
}).catch(err => {
  console.error('GOLDUP database startup error:', err);
  process.exit(1);
});
