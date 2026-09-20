const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 3000);
const app = express();

// Render runs the app behind a reverse proxy.
// Trusting the proxy lets secure session cookies work correctly on HTTPS.
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

const dataDir = path.join(__dirname, 'data');
fs.mkdirSync(dataDir, {recursive:true});

const sql = new Database(
  path.join(dataDir, 'goldup.sqlite')
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
       width="600" height="400">
    <rect width="100%" height="100%"
          rx="28" fill="#20263a"/>
    <text x="50%" y="50%"
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

  s.users = Array.isArray(s.users)
    ? s.users
    : [];

  s.cases = Array.isArray(s.cases)
    ? s.cases
    : [];

  s.codes = Array.isArray(s.codes)
    ? s.codes
    : [];

  s.promoCodes = Array.isArray(s.promoCodes)
    ? s.promoCodes
    : [];

  s.stats = s.stats || {
    totalOpens:0,
    totalSpent:0,
    totalSkinsWon:0,
    byCase:{},
    lastOpens:[]
  };

  s.users[0] = s.users[0] || {
    id:'100001',
    name:'Admin',
    email:'admin@goldup.local',
    balance:0,
    admin:true,
    inventory:[],
    usedCodes:[],
    usedPromoCodes:[],
    luck2x:false
  };

  s.users[0].id = '100001';
  s.users[0].email = 'admin@goldup.local';
  s.users[0].admin = true;

  s.users[0].inventory =
    Array.isArray(s.users[0].inventory)
      ? s.users[0].inventory
      : [];

  s.users[0].usedCodes =
    Array.isArray(s.users[0].usedCodes)
      ? s.users[0].usedCodes
      : [];

  s.users[0].usedPromoCodes =
    Array.isArray(s.users[0].usedPromoCodes)
      ? s.users[0].usedPromoCodes
      : [];

  s.users[0].luck2x =
    !!s.users[0].luck2x;

  const labels = {
    c1: [
      'GOLD CASE',
      ['GLOCK','AKR','M4','USP']
    ],
    c2: [
      'PREMIUM',
      ['AWM','AKR','M4 GOLD']
    ]
  };

  s.cases.forEach(c => {
    const z = labels[c.id];

    c.skins = Array.isArray(c.skins)
      ? c.skins
      : [];

    if(z){
      c.image = c.image || svg(z[0]);

      c.skins.forEach((x,i) => {
        if(!x.image){
          x.image = svg(
            z[1][i] ||
            x.name ||
            'SKIN'
          );
        }
      });
    }
  });

  return s;
}

if(
  !sql.prepare(
    'SELECT 1 FROM app_state WHERE id=1'
  ).get()
){
  const s = seedState();

  sql.prepare(
    'INSERT INTO app_state(id,json) VALUES(1,?)'
  ).run(JSON.stringify(s));
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

function ensureAdmin(){

  const id = '100001';
  const email = 'admin@goldup.local';
  const password = 'admin123';

  const hash = bcrypt.hashSync(
    password,
    12
  );

  const row = sql.prepare(
    'SELECT id FROM users_auth WHERE email=?'
  ).get(email);

  if(row){

    if(String(row.id) !== id){

      sql.prepare(
        'UPDATE users_auth SET id=?,pass_hash=?,admin=1 WHERE email=?'
      ).run(
        id,
        hash,
        email
      );

    }else{

      sql.prepare(
        'UPDATE users_auth SET pass_hash=?,admin=1 WHERE email=?'
      ).run(
        hash,
        email
      );

    }

  }else{

    const idRow = sql.prepare(
      'SELECT email FROM users_auth WHERE id=?'
    ).get(id);

    if(
      idRow &&
      idRow.email !== email
    ){

      sql.prepare(
        'DELETE FROM users_auth WHERE id=?'
      ).run(id);

    }

    sql.prepare(
      'INSERT OR REPLACE INTO users_auth(id,email,pass_hash,admin) VALUES(?,?,?,1)'
    ).run(
      id,
      email,
      hash
    );
  }

  const s = getState();

  let u = userById(
    s,
    id
  );

  if(!u){

    u = {
      id,
      name:'Admin',
      email,
      balance:0,
      admin:true,
      inventory:[],
      avatar:svg('ADMIN'),
      usedCodes:[],
      usedPromoCodes:[],
      luck2x:false
    };

    s.users.push(u);
  }

  u.id = id;
  u.email = email;
  u.admin = true;

  u.inventory =
    Array.isArray(u.inventory)
      ? u.inventory
      : [];

  u.usedCodes =
    Array.isArray(u.usedCodes)
      ? u.usedCodes
      : [];

  u.usedPromoCodes =
    Array.isArray(u.usedPromoCodes)
      ? u.usedPromoCodes
      : [];

  setState(s);
}

ensureAdmin();

function auth(req,res,next){

  if(!req.session.userId){

    return res.status(401).json({
      error:'Kirish talab qilinadi.'
    });

  }

  next();
}

function admin(req,res,next){

  const a = sql.prepare(
    'SELECT admin FROM users_auth WHERE id=?'
  ).get(req.session.userId);

  if(!a?.admin){

    return res.status(403).json({
      error:'Admin huquqi kerak.'
    });

  }

  next();
}

function userById(s,id){

  return s.users.find(
    u =>
      String(u.id) ===
      String(id)
  );
}

// Render/browser health check
app.get(
  '/api/health',
  (req,res) =>
    res.json({
      ok:true,
      service:'GOLDUP',
      time:new Date().toISOString()
    })
);

app.get(
  '/api/bootstrap',
  (req,res) => {

    try{

      const s = getState();

      res.json({
        ok:true,
        state:publicState(
          s,
          req.session.userId || null
        )
      });

    }catch(e){

      console.error(
        'GOLDUP /api/bootstrap error:',
        e
      );

      res.status(500).json({
        error:'Server state yuklanmadi.'
      });

    }

  }
);
app.post('/api/migrate',(req,res)=>{

  const incoming = req.body;

  if(
    !incoming ||
    typeof incoming !== 'object'
  ){
    return res.json({ok:true});
  }

  const s = getState();

  // Eski browserdagi keys/skins ma'lumotlarini
  // serverdagi ma'lumotlar bilan birlashtiradi.
  if(Array.isArray(incoming.cases)){

    const byId = new Map(
      s.cases.map(
        x => [String(x.id),x]
      )
    );

    for(const c of incoming.cases){

      if(!c?.id) continue;

      const old =
        byId.get(String(c.id));

      if(!old){

        byId.set(
          String(c.id),
          c
        );

      }else if(
        Array.isArray(c.skins)
      ){

        const sm = new Map(
          (old.skins || []).map(
            x => [String(x.id),x]
          )
        );

        for(const sk of c.skins){

          if(
            sk?.id &&
            !sm.has(String(sk.id))
          ){
            sm.set(
              String(sk.id),
              sk
            );
          }

        }

        old.skins = [
          ...sm.values()
        ];
      }
    }

    s.cases = [
      ...byId.values()
    ];
  }

  // Oddiy promokodlarni birlashtirish
  if(Array.isArray(incoming.codes)){

    for(const c of incoming.codes){

      if(
        c?.code &&
        !s.codes.some(
          x => x.code === c.code
        )
      ){

        s.codes.push({
          ...c,
          uses:0
        });

      }

    }
  }

  // Case promokodlarini birlashtirish
  if(Array.isArray(incoming.promoCodes)){

    for(const p of incoming.promoCodes){

      if(
        p?.code &&
        !s.promoCodes.some(
          x => x.code === p.code
        )
      ){

        s.promoCodes.push({
          ...p,
          uses:0
        });

      }

    }
  }

  // Eski mijozlarni serverga o'tkazish.
  // Admin huquqi hech qachon import qilinmaydi.
  if(Array.isArray(incoming.users)){

    for(const u of incoming.users){

      if(
        !u?.email ||
        u.admin ||
        s.users.some(
          x => x.email === u.email
        )
      ){
        continue;
      }

      const id = String(
        u.id ||
        Math.floor(
          100000 +
          Math.random() * 899999
        )
      );

      const nu = {
        ...u,
        id,
        admin:false
      };

      delete nu.pass;

      s.users.push(nu);

      if(u.pass){

        sql.prepare(
          'INSERT OR IGNORE INTO users_auth(id,email,pass_hash,admin) VALUES(?,?,?,0)'
        ).run(
          id,
          u.email,
          bcrypt.hashSync(
            u.pass,
            12
          )
        );

      }

    }

  }

  setState(s);

  res.json({
    ok:true
  });

});


app.post('/api/register',(req,res)=>{

  const {
    name,
    email,
    password
  } = req.body || {};

  const e = String(
    email || ''
  )
  .trim()
  .toLowerCase();

  if(
    !name ||
    !/^\S+@\S+\.\S+$/.test(e) ||
    String(password || '').length < 6
  ){

    return res.status(400).json({
      error:'Ma’lumotlarni to‘g‘ri kiriting.'
    });

  }

  if(
    sql.prepare(
      'SELECT id FROM users_auth WHERE email=?'
    ).get(e)
  ){

    return res.status(409).json({
      error:'Bu email allaqachon mavjud.'
    });

  }

  const s = getState();

  let id;

  do{

    id = String(
      Math.floor(
        100000 +
        Math.random() * 899999
      )
    );

  }while(
    userById(s,id)
  );

  const u = {
    id,
    name:String(name).trim(),
    email:e,
    balance:0,
    admin:false,
    inventory:[],
    avatar:svg('USER'),
    usedCodes:[],
    usedPromoCodes:[],
    luck2x:false
  };

  s.users.push(u);

  sql.prepare(
    'INSERT INTO users_auth(id,email,pass_hash,admin) VALUES(?,?,?,0)'
  ).run(
    id,
    e,
    bcrypt.hashSync(
      password,
      12
    )
  );

  setState(s);

  req.session.userId = id;

  res.json({
    state:publicState(
      s,
      id
    )
  });

});


app.post('/api/login',(req,res)=>{

  const {
    email,
    password
  } = req.body || {};

  const a = sql.prepare(
    'SELECT * FROM users_auth WHERE email=?'
  ).get(
    String(email || '')
      .trim()
      .toLowerCase()
  );

  if(
    !a ||
    !bcrypt.compareSync(
      String(password || ''),
      a.pass_hash
    )
  ){

    return res.status(401).json({
      error:'Email yoki parol noto‘g‘ri.'
    });

  }

  req.session.userId = a.id;

  res.json({
    state:publicState(
      getState(),
      a.id
    )
  });

});


app.post('/api/logout',(req,res)=>{

  req.session.destroy(
    () => res.json({
      ok:true
    })
  );

});


app.post('/api/redeem-code',auth,(req,res)=>{

  const code = String(
    req.body?.code || ''
  )
  .trim()
  .toUpperCase();

  if(!code){

    return res.status(400).json({
      error:'Kodni kiriting.'
    });

  }

  const tx = sql.transaction(()=>{

    const s = getState();

    const u = userById(
      s,
      req.session.userId
    );

    if(!u){

      return {
        err:'Mijoz topilmadi.'
      };

    }

    const c = s.codes.find(
      x => x.code === code
    );

    if(
      !c ||
      Number(c.uses || 0) >=
      Number(c.max || 0)
    ){

      return {
        err:'Kod noto‘g‘ri yoki foydalanish limiti tugagan.'
      };

    }

    if(
      sql.prepare(
        'SELECT 1 FROM code_redemptions WHERE user_id=? AND code=?'
      ).get(
        u.id,
        code
      )
    ){

      return {
        err:'Bu promokodni siz allaqachon ishlatgansiz.'
      };

    }

    c.uses =
      Number(c.uses || 0) + 1;

    u.balance =
      Number(u.balance || 0) +
      Number(c.amount || 0);

    u.usedCodes =
      Array.isArray(u.usedCodes)
        ? u.usedCodes
        : [];

    if(
      !u.usedCodes.includes(code)
    ){

      u.usedCodes.push(code);

    }

    sql.prepare(
      'INSERT INTO code_redemptions(user_id,code) VALUES(?,?)'
    ).run(
      u.id,
      code
    );

    setState(s);

    return {
      ok:true,
      state:publicState(
        s,
        u.id
      ),
      amount:Number(
        c.amount || 0
      )
    };

  })();

  if(tx.err){

    return res.status(400).json({
      error:tx.err
    });

  }

  res.json(tx);

});
app.post('/api/redeem-case-promo',auth,(req,res)=>{

  const code = String(
    req.body?.code || ''
  )
  .trim()
  .toUpperCase();

  const caseId = String(
    req.body?.caseId || ''
  );

  const tx = sql.transaction(()=>{

    const s = getState();

    const u = userById(
      s,
      req.session.userId
    );

    const p = s.promoCodes.find(
      x =>
        x.code === code &&
        String(x.caseId) === caseId
    );

    if(
      !u ||
      !p ||
      Number(p.uses || 0) >=
      Number(p.max || 0)
    ){

      return {
        err:'Kod noto‘g‘ri, boshqa keyga tegishli yoki limiti tugagan.'
      };

    }

    if(
      sql.prepare(
        'SELECT 1 FROM promo_redemptions WHERE user_id=? AND code=?'
      ).get(
        u.id,
        code
      )
    ){

      return {
        err:'Bu promokodni siz allaqachon ishlatgansiz.'
      };

    }

    p.uses =
      Number(p.uses || 0) + 1;

    u.usedPromoCodes =
      Array.isArray(u.usedPromoCodes)
        ? u.usedPromoCodes
        : [];

    u.usedPromoCodes.push(code);

    u.caseDiscounts =
      u.caseDiscounts || {};

    u.caseDiscounts[caseId] =
      Math.max(
        Number(
          u.caseDiscounts[caseId] || 0
        ),
        Math.min(
          100,
          Number(p.discount) || 0
        )
      );

    sql.prepare(
      'INSERT INTO promo_redemptions(user_id,code) VALUES(?,?)'
    ).run(
      u.id,
      code
    );

    setState(s);

    return {
      ok:true,
      state:publicState(
        s,
        u.id
      ),
      discount:Number(
        p.discount || 0
      )
    };

  })();

  if(tx.err){

    return res.status(400).json({
      error:tx.err
    });

  }

  res.json(tx);

});


app.post(
  '/api/admin/balance',
  auth,
  admin,
  (req,res)=>{

    const id = String(
      req.body?.id || ''
    );

    const amount = Number(
      req.body?.amount || 0
    );

    if(
      !id ||
      !Number.isFinite(amount) ||
      amount === 0
    ){

      return res.status(400).json({
        error:'Miqdor noto‘g‘ri.'
      });

    }

    const s = getState();

    const u = userById(
      s,
      id
    );

    if(
      !u ||
      u.admin
    ){

      return res.status(404).json({
        error:'Mijoz topilmadi.'
      });

    }

    const next =
      Number(u.balance || 0) +
      amount;

    if(next < 0){

      return res.status(400).json({
        error:'Balans 0 dan past bo‘lishi mumkin emas.'
      });

    }

    u.balance =
      +next.toFixed(2);

    setState(s);

    res.json({
      state:publicState(
        s,
        req.session.userId
      )
    });

  }
);


app.post(
  '/api/sync',
  auth,
  (req,res)=>{

    const incoming = req.body;

    if(
      !incoming ||
      typeof incoming !== 'object'
    ){

      return res.status(400).json({
        error:'Noto‘g‘ri ma’lumot.'
      });

    }

    const s = getState();

    const me = userById(
      s,
      req.session.userId
    );

    const isAdmin =
      !!me?.admin;

    if(!me){

      return res.status(401).json({
        error:'Kirish talab qilinadi.'
      });

    }

    // Faqat admin:
    // keys, promokodlar va statistikani o‘zgartira oladi.
    if(isAdmin){

      if(
        Array.isArray(
          incoming.cases
        )
      ){

        s.cases =
          incoming.cases;

      }

      if(
        Array.isArray(
          incoming.codes
        )
      ){

        s.codes =
          incoming.codes;

      }

      if(
        Array.isArray(
          incoming.promoCodes
        )
      ){

        s.promoCodes =
          incoming.promoCodes;

      }

      if(
        incoming.stats &&
        typeof incoming.stats === 'object'
      ){

        s.stats =
          incoming.stats;

      }

    }

    // Oddiy mijoz faqat o‘z profilini yangilay oladi.
    if(
      Array.isArray(
        incoming.users
      )
    ){

      for(
        const inc of incoming.users
      ){

        if(
          String(inc.id) !==
          String(req.session.userId) &&
          !isAdmin
        ){

          continue;

        }

        const u = userById(
          s,
          inc.id
        );

        if(!u) continue;

        const allowed = {
          ...inc
        };

        delete allowed.pass;
        delete allowed.admin;

        // Admin statusini oddiy mijoz
        // o‘zgartira olmaydi.
        if(
          isAdmin &&
          u.admin
        ){

          allowed.admin = true;

        }

        Object.assign(
          u,
          allowed
        );

      }

    }

    setState(s);

    res.json({
      ok:true,
      state:publicState(
        s,
        req.session.userId
      )
    });

  }
);
app.use(express.static(path.join(__dirname,'public')));

app.use((req,res)=>
  res.sendFile(
    path.join(__dirname,'public','index.html')
  )
);

app.listen(
  PORT,
  ()=>console.log(
    `GOLDUP server: http://localhost:${PORT}`
  )
);
