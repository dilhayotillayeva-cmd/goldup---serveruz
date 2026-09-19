const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const PORT = Number(process.env.PORT || 3000);
const app = express();
// Render reverse proxy
app.set('trust proxy', 1);
app.use(express.json({limit:'12mb'}));
app.use(session({
  secret: process.env.SESSION_SECRET || 'CHANGE_ME_GOLDUP_SESSION_SECRET',
  resave: false,
  saveUninitialized: false,
  proxy: true,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24 * 30
  }
}));
const dataDir = path.join(__dirname,'data');
fs.mkdirSync(dataDir,{recursive:true});
const sql = new Database(
  path.join(dataDir,'goldup.sqlite')
);
sql.pragma('journal_mode = WAL');
sql.exec(`
CREATE TABLE IF NOT EXISTS app_state (
  id INTEGER PRIMARY KEY CHECK(id=1),
  json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users_auth (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  pass_hash TEXT NOT NULL,
  admin INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS code_redemptions (
  user_id TEXT NOT NULL,
  code TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(user_id,code)
);

CREATE TABLE IF NOT EXISTS promo_redemptions (
  user_id TEXT NOT NULL,
  code TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(user_id,code)
);
`);

const svg = (label) =>
  'data:image/svg+xml;charset=UTF-8,' +
  encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg"
         width="600"
         height="400">
      <rect width="100%"
            height="100%"
            rx="28"
            fill="#20263a"/>
      <text x="50%"
            y="50%"
            dominant-baseline="middle"
            text-anchor="middle"
            fill="#ffd447"
            font-family="Arial"
            font-size="42"
            font-weight="700">
        ${label}
      </text>
    </svg>
  `);

function seedState(){
  let s = JSON.parse(
    fs.readFileSync(
      path.join(__dirname,'seed.json'),
      'utf8'
    )
  );

  s.users[0].avatar = svg('USER');

  const labels = {
    c1:['GOLD CASE',['GLOCK','AKR','M4','USP']],
    c2:['PREMIUM',['AWM','AKR','M4 GOLD']]
  };

  s.cases.forEach(c => {
    c.image = svg(labels[c.id][0]);

    c.skins.forEach((x,i) => {
      x.image = svg(labels[c.id][1][i]);
    });
  });

  return s;
}

if(!sql.prepare(
  'SELECT 1 FROM app_state WHERE id=1'
).get()){

  const s = seedState();

  sql.prepare(
    'INSERT INTO app_state(id,json) VALUES(1,?)'
  ).run(JSON.stringify(s));

  const hash = bcrypt.hashSync('admin123',12);

  sql.prepare(
    'INSERT INTO users_auth(id,email,pass_hash,admin) VALUES(?,?,?,1)'
  ).run(
    '100001',
    'admin@goldup.local',
    hash
  );
}

function getState(){
  return JSON.parse(
    sql.prepare(
      'SELECT json FROM app_state WHERE id=1'
    ).get().json
  );
}

function setState(s){
  sql.prepare(
    'UPDATE app_state SET json=? WHERE id=1'
  ).run(JSON.stringify(s));
}

function publicState(s,current){
  const copy = JSON.parse(
    JSON.stringify(s)
  );

  copy.current = current || null;

  copy.users = copy.users.map(u => {
    const x = {...u};
    delete x.pass;
    return x;
  });

  return copy;
}
function requireAuth(req,res,next){
  if(!req.session.userId){
    return res.status(401).json({
      ok:false,
      error:'AUTH_REQUIRED'
    });
  }

  next();
}

function requireAdmin(req,res,next){
  if(!req.session.userId){
    return res.status(401).json({
      ok:false,
      error:'AUTH_REQUIRED'
    });
  }

  const row = sql.prepare(
    'SELECT admin FROM users_auth WHERE id=?'
  ).get(req.session.userId);

  if(!row || !row.admin){
    return res.status(403).json({
      ok:false,
      error:'ADMIN_REQUIRED'
    });
  }

  next();
}


/* =========================
   HEALTH CHECK
========================= */

app.get('/api/health',(req,res)=>{
  res.json({
    ok:true,
    service:'GOLDUP',
    time:new Date().toISOString()
  });
});


/* =========================
   BOOTSTRAP
========================= */

app.get('/api/bootstrap',(req,res)=>{
  try{
    const state = getState();

    let current = null;

    if(req.session.userId){
      current = state.users.find(
        u => String(u.id) === String(req.session.userId)
      ) || null;
    }

    res.json({
      ok:true,
      state:publicState(state,current)
    });

  }catch(e){

    console.error('BOOTSTRAP ERROR:',e);

    res.status(500).json({
      ok:false,
      error:'BOOTSTRAP_FAILED',
      message:e.message
    });
  }
});


/* =========================
   MIGRATE OLD LOCAL DATA
========================= */

app.post('/api/migrate',requireAuth,(req,res)=>{

  try{

    const incoming = req.body || {};
    const state = getState();

    if(Array.isArray(incoming.cases)){
      state.cases = incoming.cases;
    }

    if(Array.isArray(incoming.skins)){
      state.skins = incoming.skins;
    }

    if(Array.isArray(incoming.codes)){
      state.codes = incoming.codes;
    }

    if(Array.isArray(incoming.promoCodes)){
      state.promoCodes = incoming.promoCodes;
    }

    if(incoming.stats &&
       typeof incoming.stats === 'object'){
      state.stats = incoming.stats;
    }

    setState(state);

    res.json({
      ok:true,
      state:publicState(
        state,
        state.users.find(
          u => String(u.id) === String(req.session.userId)
        )
      )
    });

  }catch(e){

    console.error('MIGRATE ERROR:',e);

    res.status(500).json({
      ok:false,
      error:'MIGRATE_FAILED'
    });
  }
});


/* =========================
   REGISTER
========================= */

app.post('/api/register',async(req,res)=>{

  try{

    const {
      id,
      email,
      pass
    } = req.body || {};

    if(!id || !email || !pass){
      return res.status(400).json({
        ok:false,
        error:'MISSING_FIELDS'
      });
    }

    const exists = sql.prepare(
      'SELECT id FROM users_auth WHERE email=?'
    ).get(String(email).trim().toLowerCase());

    if(exists){
      return res.status(409).json({
        ok:false,
        error:'EMAIL_EXISTS'
      });
    }

    const passHash = await bcrypt.hash(
      String(pass),
      12
    );

    sql.prepare(`
      INSERT INTO users_auth
      (id,email,pass_hash,admin)
      VALUES(?,?,?,0)
    `).run(
      String(id),
      String(email).trim().toLowerCase(),
      passHash
    );

    const state = getState();

    if(!state.users.some(
      u => String(u.id) === String(id)
    )){

      state.users.push({
        id:String(id),
        email:String(email).trim().toLowerCase(),
        balance:0,
        keys:0,
        avatar:svg('USER')
      });

      setState(state);
    }

    req.session.userId = String(id);

    res.json({
      ok:true,
      user:state.users.find(
        u => String(u.id) === String(id)
      )
    });

  }catch(e){

    console.error('REGISTER ERROR:',e);

    res.status(500).json({
      ok:false,
      error:'REGISTER_FAILED'
    });
  }
});


/* =========================
   LOGIN
========================= */

app.post('/api/login',async(req,res)=>{

  try{

    const {
      email,
      pass
    } = req.body || {};

    const row = sql.prepare(`
      SELECT id,email,pass_hash,admin
      FROM users_auth
      WHERE email=?
    `).get(
      String(email || '').trim().toLowerCase()
    );

    if(!row){

      return res.status(401).json({
        ok:false,
        error:'INVALID_LOGIN'
      });
    }

    const valid = await bcrypt.compare(
      String(pass || ''),
      row.pass_hash
    );

    if(!valid){

      return res.status(401).json({
        ok:false,
        error:'INVALID_LOGIN'
      });
    }

    req.session.userId = String(row.id);

    const state = getState();

    const user = state.users.find(
      u => String(u.id) === String(row.id)
    );

    res.json({
      ok:true,
      user:user || {
        id:String(row.id),
        email:row.email,
        admin:!!row.admin
      }
    });

  }catch(e){

    console.error('LOGIN ERROR:',e);

    res.status(500).json({
      ok:false,
      error:'LOGIN_FAILED'
    });
  }
});


/* =========================
   LOGOUT
========================= */

app.post('/api/logout',(req,res)=>{

  req.session.destroy(()=>{
    res.json({
      ok:true
    });
  });/* =========================
   REDEEM NORMAL PROMO CODE
========================= */

app.post('/api/redeem-code',requireAuth,(req,res)=>{

  try{

    const {
      code
    } = req.body || {};

    const cleanCode = String(code || '')
      .trim()
      .toUpperCase();

    if(!cleanCode){
      return res.status(400).json({
        ok:false,
        error:'CODE_REQUIRED'
      });
    }

    const state = getState();

    const user = state.users.find(
      u => String(u.id) === String(req.session.userId)
    );

    if(!user){
      return res.status(404).json({
        ok:false,
        error:'USER_NOT_FOUND'
      });
    }

    const promo = (state.codes || []).find(
      c => String(c.code || '').toUpperCase() === cleanCode
    );

    if(!promo){
      return res.status(400).json({
        ok:false,
        error:'INVALID_CODE'
      });
    }

    /* Bir foydalanuvchi bir kodni faqat 1 marta ishlatadi */
    const already = sql.prepare(`
      SELECT 1
      FROM code_redemptions
      WHERE user_id=? AND code=?
    `).get(
      String(req.session.userId),
      cleanCode
    );

    if(already){
      return res.status(400).json({
        ok:false,
        error:'CODE_ALREADY_USED'
      });
    }

    const amount = Number(
      promo.amount ||
      promo.value ||
      0
    );

    user.balance =
      Number(user.balance || 0) + amount;

    sql.prepare(`
      INSERT INTO code_redemptions
      (user_id,code)
      VALUES(?,?)
    `).run(
      String(req.session.userId),
      cleanCode
    );

    setState(state);

    res.json({
      ok:true,
      user
    });

  }catch(e){

    console.error('REDEEM CODE ERROR:',e);

    res.status(500).json({
      ok:false,
      error:'REDEEM_FAILED'
    });
  }
});


/* =========================
   REDEEM CASE PROMO
========================= */

app.post('/api/redeem-case-promo',requireAuth,(req,res)=>{

  try{

    const {
      id,
      code
    } = req.body || {};

    const cleanCode = String(code || '')
      .trim()
      .toUpperCase();

    const state = getState();

    const user = state.users.find(
      u => String(u.id) === String(req.session.userId)
    );

    if(!user){
      return res.status(404).json({
        ok:false,
        error:'USER_NOT_FOUND'
      });
    }

    const promo = (state.promoCodes || []).find(
      p =>
        String(p.id) === String(id) ||
        String(p.code || '').toUpperCase() === cleanCode
    );

    if(!promo){
      return res.status(400).json({
        ok:false,
        error:'INVALID_PROMO'
      });
    }

    const promoCode = String(
      promo.code || cleanCode
    ).toUpperCase();

    /* Bir foydalanuvchi promo-kodni qayta ishlata olmaydi */
    const already = sql.prepare(`
      SELECT 1
      FROM promo_redemptions
      WHERE user_id=? AND code=?
    `).get(
      String(req.session.userId),
      promoCode
    );

    if(already){
      return res.status(400).json({
        ok:false,
        error:'PROMO_ALREADY_USED'
      });
    }

    const reward = Number(
      promo.reward ||
      promo.amount ||
      promo.value ||
      0
    );

    user.balance =
      Number(user.balance || 0) + reward;

    sql.prepare(`
      INSERT INTO promo_redemptions
      (user_id,code)
      VALUES(?,?)
    `).run(
      String(req.session.userId),
      promoCode
    );

    setState(state);

    res.json({
      ok:true,
      user
    });

  }catch(e){

    console.error('CASE PROMO ERROR:',e);

    res.status(500).json({
      ok:false,
      error:'PROMO_REDEEM_FAILED'
    });
  }
});


/* =========================
   ADMIN BALANCE
========================= */

app.post('/api/admin/balance',requireAdmin,(req,res)=>{

  try{

    const {
      id,
      sign
    } = req.body || {};

    const state = getState();

    const user = state.users.find(
      u => String(u.id) === String(id)
    );

    if(!user){
      return res.status(404).json({
        ok:false,
        error:'USER_NOT_FOUND'
      });
    }

    const amount = Number(
      req.body.amount || 0
    );

    if(!Number.isFinite(amount) || amount <= 0){
      return res.status(400).json({
        ok:false,
        error:'INVALID_AMOUNT'
      });
    }

    if(sign === '-'){
      user.balance =
        Math.max(
          0,
          Number(user.balance || 0) - amount
        );
    }else{
      user.balance =
        Number(user.balance || 0) + amount;
    }

    setState(state);

    res.json({
      ok:true,
      user
    });

  }catch(e){

    console.error('ADMIN BALANCE ERROR:',e);

    res.status(500).json({
      ok:false,
      error:'BALANCE_FAILED'
    });
  }
});


/* =========================
   SYNC STATE
========================= */

app.post('/api/sync',requireAuth,(req,res)=>{

  try{

    const incoming = req.body || {};
    const state = getState();

    const me = state.users.find(
      u => String(u.id) === String(req.session.userId)
    );

    if(!me){
      return res.status(404).json({
        ok:false,
        error:'USER_NOT_FOUND'
      });
    }

    const isAdmin = sql.prepare(
      'SELECT admin FROM users_auth WHERE id=?'
    ).get(req.session.userId);

    if(isAdmin && isAdmin.admin){

      if(Array.isArray(incoming.cases)){
        state.cases = incoming.cases;
      }

      if(Array.isArray(incoming.skins)){
        state.skins = incoming.skins;
      }

      if(Array.isArray(incoming.codes)){
        state.codes = incoming.codes;
      }

      if(Array.isArray(incoming.promoCodes)){
        state.promoCodes = incoming.promoCodes;
      }

      if(incoming.stats &&
         typeof incoming.stats === 'object'){
        state.stats = incoming.stats;
      }

    }else{

      const incomingUser =
        incoming.user || incoming.current;

      if(incomingUser){

        const target = state.users.find(
          u =>
            String(u.id) ===
            String(req.session.userId)
        );

        if(target){

          if(incomingUser.name !== undefined)
            target.name = incomingUser.name;

          if(incomingUser.avatar !== undefined)
            target.avatar = incomingUser.avatar;
        }
      }
    }

    setState(state);

    res.json({
      ok:true,
      state:publicState(
        state,
        state.users.find(
          u =>
            String(u.id) ===
            String(req.session.userId)
        )
      )
    });

  }catch(e){

    console.error('SYNC ERROR:',e);

    res.status(500).json({
      ok:false,
      error:'SYNC_FAILED'
    });
  }
});


/* =========================
   STATIC WEBSITE
========================= */

app.use(
  express.static(
    path.join(__dirname,'public')
  )
);


/* =========================
   SPA FALLBACK
========================= */

app.use((req,res)=>{

  res.sendFile(
    path.join(
      __dirname,
      'public',
      'index.html'
    )
  );

});


/* =========================
   START SERVER
========================= */

app.listen(PORT,()=>{
  console.log(
    `GOLDUP server: http://localhost:${PORT}`
  );
});

});
