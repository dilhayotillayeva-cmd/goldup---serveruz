const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 3000);
const app = express();

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

const sql = new Database(path.join(dataDir, 'goldup.sqlite'));

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
          font-weight="700">${label}</text>
  </svg>`);

function seedState(){
  const file = path.join(__dirname,'seed.json');

  let s = JSON.parse(
    fs.readFileSync(file,'utf8')
  );

  s.users = s.users || [];
  s.cases = s.cases || [];
  s.codes = s.codes || [];
  s.promoCodes = s.promoCodes || [];

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
    usedPromoCodes:[]
  };

  s.users[0].id = '100001';
  s.users[0].email = 'admin@goldup.local';
  s.users[0].admin = true;
  s.users[0].avatar = svg('ADMIN');
    const labels = {
    c1: ['GOLD CASE', ['GLOCK','AKR','M4','USP']],
    c2: ['PREMIUM', ['AWM','AKR','M4 GOLD']]
  };

  s.cases.forEach(c => {
    const z = labels[c.id];

    if(z){
      c.image = c.image || svg(z[0]);

      (c.skins || []).forEach((x,i) => {
        if(!x.image){
          x.image = svg(z[1][i] || x.name || 'SKIN');
        }
      });
    }
  });

  return s;
}

if(!sql.prepare('SELECT 1 FROM app_state WHERE id=1').get()){
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

function userById(s,id){
  return s.users.find(
    u => String(u.id) === String(id)
  );
}

function publicState(s,current){
  const copy = JSON.parse(JSON.stringify(s));

  copy.current = current || null;

  copy.users = (copy.users || []).map(u => {
    const x = {...u};
    delete x.pass;
    return x;
  });

  return copy;
}

function ensureAdmin(){
  const email = 'admin@goldup.local';
  const password = 'admin123';
  const id = '100001';

  const hash = bcrypt.hashSync(password,12);

  const existing = sql.prepare(
    'SELECT id FROM users_auth WHERE email=?'
  ).get(email);

  if(existing){
    sql.prepare(
      'UPDATE users_auth SET id=?,pass_hash=?,admin=1,email=? WHERE email=?'
    ).run(id,hash,email,email);
  }else{
    sql.prepare(
      'INSERT INTO users_auth(id,email,pass_hash,admin) VALUES(?,?,?,1)'
    ).run(id,email,hash);
  }

  const s = getState();
  let u = userById(s,id);

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

  if(!u.name) u.name = 'Admin';
  if(!Array.isArray(u.inventory)) u.inventory = [];
  if(!Array.isArray(u.usedCodes)) u.usedCodes = [];
  if(!Array.isArray(u.usedPromoCodes)) u.usedPromoCodes = [];

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

app.get('/api/health',(req,res) =>
  res.json({
    ok:true,
    service:'GOLDUP',
    time:new Date().toISOString()
  })
);

app.get('/api/bootstrap',(req,res)=>{
  try{
    const s = getState();

    res.json(
      publicState(
        s,
        req.session.userId || null
      )
    );
  }catch(e){
    res.status(500).json({
      error:'STATE_ERROR'
    });
  }
});
app.post('/api/migrate',(req,res)=>{
  const incoming=req.body;

  if(!incoming || typeof incoming!=='object'){
    return res.json({ok:true});
  }

  const s=getState();

  if(Array.isArray(incoming.cases)){
    const byId=new Map(
      s.cases.map(x=>[String(x.id),x])
    );

    for(const c of incoming.cases){
      if(!c?.id) continue;

      const old=byId.get(String(c.id));

      if(!old){
        byId.set(String(c.id),c);
      }else if(Array.isArray(c.skins)){
        const sm=new Map(
          (old.skins||[]).map(
            x=>[String(x.id),x]
          )
        );

        for(const sk of c.skins){
          if(sk?.id && !sm.has(String(sk.id))){
            sm.set(String(sk.id),sk);
          }
        }

        old.skins=[...sm.values()];
      }
    }

    s.cases=[...byId.values()];
  }

  if(Array.isArray(incoming.codes)){
    for(const c of incoming.codes){
      if(
        c?.code &&
        !s.codes.some(x=>x.code===c.code)
      ){
        s.codes.push({...c,uses:0});
      }
    }
  }

  if(Array.isArray(incoming.promoCodes)){
    for(const p of incoming.promoCodes){
      if(
        p?.code &&
        !s.promoCodes.some(x=>x.code===p.code)
      ){
        s.promoCodes.push({...p,uses:0});
      }
    }
  }

  if(Array.isArray(incoming.users)){
    for(const u of incoming.users){
      if(
        !u?.email ||
        u.admin ||
        s.users.some(x=>x.email===u.email)
      ) continue;

      const id=String(
        u.id ||
        Math.floor(100000+Math.random()*899999)
      );

      const nu={
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
          bcrypt.hashSync(u.pass,12)
        );
      }
    }
  }

  setState(s);

  res.json({ok:true});
});


app.post('/api/register',(req,res)=>{
  const {name,email,password}=req.body||{};

  const e=String(email||'')
    .trim()
    .toLowerCase();

  if(
    !String(name||'').trim() ||
    !/^\S+@\S+\.\S+$/.test(e) ||
    String(password||'').length<6
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

  const s=getState();

  let id;

  do{
    id=String(
      Math.floor(100000+Math.random()*899999)
    );
  }while(userById(s,id));

  const u={
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
    bcrypt.hashSync(password,12)
  );

  setState(s);

  req.session.userId=id;

  res.json({
    state:publicState(s,id)
  });
});


app.post('/api/login',(req,res)=>{
  const {email,password}=req.body||{};

  const e=String(email||'')
    .trim()
    .toLowerCase();

  const a=sql.prepare(
    'SELECT * FROM users_auth WHERE email=?'
  ).get(e);

  if(
    !a ||
    !bcrypt.compareSync(
      String(password||''),
      a.pass_hash
    )
  ){
    return res.status(401).json({
      error:'Email yoki parol noto‘g‘ri.'
    });
  }

  req.session.userId=a.id;

  res.json({
    state:publicState(
      getState(),
      a.id
    )
  });
});


app.post('/api/logout',(req,res)=>{
  req.session.destroy(()=>{
    res.json({ok:true});
  });
});
