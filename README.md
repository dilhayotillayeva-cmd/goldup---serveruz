# GOLDUP — Server + SQLite

Bu versiya mavjud GOLDUP HTML dizaynini saqlaydi va server/database bilan ishlaydi.

## Nimalar o‘zgardi
- SQLite database: `data/goldup.sqlite`
- Server-side login/registration va parol hash (bcrypt)
- Promokod/balans kodi bir mijoz tomonidan qayta ishlatilsa server rad etadi
- Kod limitlari server transaction orqali tekshiriladi
- Admin mijoz ID orqali balans qo‘shishi/ayirishi mumkin
- Admin qo‘shgan keys/skinlar localStorage migratsiyasida saqlanadi
- Keys, skinlar, random live, inventar va mavjud UI saqlab qolingan
- Admin katalog o‘zgarishlari database’ga sync qilinadi

## Ishga tushirish
1. Node.js 18+ o‘rnating.
2. Papkada `npm install` qiling.
3. `npm start` ni ishga tushiring.
4. Brauzerda `http://localhost:3000` ni oching.

### Demo admin
- Email: `admin@goldup.local`
- Parol: `admin123`

**Internetga chiqarishdan oldin admin parolini almashtiring va `SESSION_SECRET` ni o‘rnating.**

## Internetga joylash
Node.js qo‘llaydigan VPS/hosting kerak. Domen (`goldup.uz`) alohida masala: domen tekin bo‘lishi shart emas, hosting va SSL ham kerak bo‘lishi mumkin.
