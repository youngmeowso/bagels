'use strict';
// Bagel Royale online server - zero dependencies (Node 18+)
// accounts + cloud save + redeem codes + websocket rooms
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto'), zlib = require('zlib');
const PORT = +process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SECRET = process.env.SECRET || (console.warn('WARNING: SECRET env var missing - logins will reset on every restart'), crypto.randomBytes(32).toString('hex'));
const PUB = path.join(__dirname, 'public');
const TOKEN_DAYS = 60;
// item codes live ONLY on the server (add more with CODES_JSON='{"mycode":"bag"}')
const ITEMS = ['bag', 'meow', 'pup'];
const CODES = Object.assign({ craigmorrisonbugbag: 'bag', meowsi: 'meow', puppet: 'pup' }, safeJSON(process.env.CODES_JSON) || {});
const LOOK_KEYS = ['skin', 'top', 'sh', 'hair', 'hs', 'bag', 'meow', 'pup'];
const DEFLOOK = { skin: 0xf2c9a0, top: 0x111111, sh: 0xff4fa3, hair: null, hs: 0, bag: 0, pup: 0 };
function safeJSON(s) { try { return JSON.parse(s) } catch (e) { return null } }

// ---------- storage (json file, atomic writes) ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, 'users.json');
let users = safeJSON(fs.existsSync(DB_FILE) ? fs.readFileSync(DB_FILE, 'utf8') : '{}') || {};
let dirty = false, writing = false;
// optional free cloud storage (Upstash Redis REST) so accounts survive Render free-tier restarts
const RURL = process.env.UPSTASH_REDIS_REST_URL, RTOK = process.env.UPSTASH_REDIS_REST_TOKEN, RKEY = 'bagel_users';
const redis = cmd => fetch(RURL, { method: 'POST', headers: { Authorization: 'Bearer ' + RTOK }, body: JSON.stringify(cmd) }).then(r => r.json());
async function loadRemote() {
  if (!RURL || !RTOK) return console.log('storage: local file ' + DB_FILE + (process.env.RENDER ? '  (Render free = ephemeral! set UPSTASH_REDIS_REST_URL/TOKEN)' : ''));
  try { const r = await redis(['GET', RKEY]); if (r.error) throw new Error(r.error); if (r.result) users = safeJSON(r.result) || users; console.log('storage: Upstash Redis, ' + Object.keys(users).length + ' accounts loaded') }
  catch (e) { console.error('FATAL: cannot reach Upstash (' + e.message + ') - refusing to start so accounts are not overwritten'); process.exit(1) }
}
function markDirty() { dirty = true }
setInterval(flush, 3000).unref();
function flush() {
  if (!dirty || writing) return; dirty = false; writing = true;
  if (RURL && RTOK) redis(['SET', RKEY, JSON.stringify(users)]).then(r => { writing = false; if (r.error) { dirty = true; console.error('redis save error', r.error) } }).catch(e => { writing = false; dirty = true; console.error('redis save error', e.message) });
  const tmp = DB_FILE + '.tmp';
  fs.writeFile(tmp, JSON.stringify(users), err => {
    if (err) { dirty = true; writing = false; return console.error('save error', err) }
    fs.rename(tmp, DB_FILE, e => { writing = false; if (e) { dirty = true; console.error(e) } });
  });
}
function exitFlush() { try { if (dirty) fs.writeFileSync(DB_FILE, JSON.stringify(users)) } catch (e) {} if (RURL && RTOK && dirty) { redis(['SET', RKEY, JSON.stringify(users)]).catch(() => {}).finally(() => process.exit(0)); setTimeout(() => process.exit(0), 2500) } else process.exit(0) }
process.on('SIGTERM', exitFlush); process.on('SIGINT', exitFlush);

// ---------- auth ----------
const b64u = b => Buffer.from(b).toString('base64url');
function sign(s) { return crypto.createHmac('sha256', SECRET).update(s).digest('base64url') }
function makeToken(key) { const p = b64u(key + '|' + (Date.now() + TOKEN_DAYS * 864e5)); return p + '.' + sign(p) }
function verifyToken(tok) {
  if (typeof tok !== 'string') return null; const [p, s] = tok.split('.'); if (!p || !s) return null;
  const e = sign(p); if (e.length !== s.length || !crypto.timingSafeEqual(Buffer.from(e), Buffer.from(s))) return null;
  const [key, exp] = Buffer.from(p, 'base64url').toString().split('|'); if (+exp < Date.now()) return null;
  return users[key] ? { key, u: users[key] } : null;
}
function hashPw(pw, salt) { return crypto.scryptSync(pw, salt, 32).toString('hex') }
const hits = new Map();
function limited(ip) { const n = Date.now(), a = (hits.get(ip) || []).filter(t => n - t < 300000); a.push(n); hits.set(ip, a); return a.length > 20 }
setInterval(() => { const n = Date.now(); for (const [k, a] of hits) if (!a.some(t => n - t < 300000)) hits.delete(k) }, 600000).unref();
const cleanName = n => typeof n === 'string' && /^[A-Za-z0-9_-]{2,12}$/.test(n.trim()) ? n.trim() : null;
function cleanLook(l) {
  const o = Object.assign({}, DEFLOOK);
  if (l && typeof l === 'object') for (const k of LOOK_KEYS) { const v = l[k]; if (k === 'hair' ? (v === null || Number.isInteger(v)) : Number.isInteger(v)) o[k] = v }
  return o;
}
const lvl = xp => Math.floor((1 + Math.sqrt(1 + xp / 12.5)) / 2), xpFor = L => 50 * (L - 1) * L; // L2=100, L3=300, L4=600 ...
function pubSave(u) {
  const own = u.save.own.filter(x => ITEMS.includes(x)), look = cleanLook(u.save.look);
  for (const id of ITEMS) if (!own.includes(id)) look[id] = 0;
  const xp = Math.max(0, Math.floor(u.save.xp || 0)), level = lvl(xp);
  return { look, own, xp, level, xpCur: xpFor(level), xpNext: xpFor(level + 1) };
}

// ---------- http ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon' };
const cache = new Map();
function sendJSON(res, code, obj) { const b = JSON.stringify(obj); res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(b) }
function body(req) {
  return new Promise((ok, no) => { let n = 0; const c = []; req.on('data', d => { n += d.length; if (n > 20000) { no(new Error('big')); req.destroy() } else c.push(d) }); req.on('end', () => ok(safeJSON(Buffer.concat(c).toString()) || {})); req.on('error', no) });
}
function serveStatic(req, res, url) {
  let f = url === '/' ? '/index.html' : url; f = path.normalize(f).replace(/^(\.\.[\/\\])+/, '');
  const fp = path.join(PUB, f); if (!fp.startsWith(PUB) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) { res.writeHead(404); return res.end('not found') }
  const ext = path.extname(fp), mt = fs.statSync(fp).mtimeMs; let c = cache.get(fp);
  if (!c || c.mt !== mt) { const raw = fs.readFileSync(fp); c = { mt, raw, gz: zlib.gzipSync(raw, { level: 9 }) }; cache.set(fp, c) }
  const h = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=86400' };
  if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) { h['Content-Encoding'] = 'gzip'; res.writeHead(200, h); res.end(c.gz) } else { res.writeHead(200, h); res.end(c.raw) }
}
const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0], ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  try {
    if (url === '/healthz') return sendJSON(res, 200, { ok: 1, rooms: rooms.size });
    if (url.startsWith('/api/')) {
      const auth = (req.headers.authorization || '').replace(/^Bearer /, ''), me = verifyToken(auth);
      if (url === '/api/auth' && req.method === 'POST') {
        if (limited(ip)) return sendJSON(res, 429, { error: 'too many attempts, wait a few minutes' });
        const b = await body(req), name = cleanName(b.name), pw = typeof b.password === 'string' ? b.password : '';
        if (!name) return sendJSON(res, 400, { error: 'name: 2-12 letters, numbers, _ or -' });
        if (pw.length < 4 || pw.length > 64) return sendJSON(res, 400, { error: 'password must be 4-64 characters' });
        const key = name.toLowerCase(); let u = users[key], created = false;
        if (!u) { const salt = crypto.randomBytes(16).toString('hex'); u = users[key] = { name, salt, hash: hashPw(pw, salt), created: Date.now(), save: { look: DEFLOOK, own: [] } }; created = true }
        else if (!crypto.timingSafeEqual(Buffer.from(hashPw(pw, u.salt), 'hex'), Buffer.from(u.hash, 'hex'))) return sendJSON(res, 401, { error: 'wrong password for that name' });
        u.last = Date.now(); markDirty();
        return sendJSON(res, 200, { token: makeToken(key), name: u.name, created, save: pubSave(u) });
      }
      if (!me) return sendJSON(res, 401, { error: 'not logged in' });
      if (url === '/api/me' && req.method === 'GET') return sendJSON(res, 200, { name: me.u.name, save: pubSave(me.u) });
      if (url === '/api/save' && req.method === 'PUT') { const b = await body(req); me.u.save.look = cleanLook(b.look); markDirty(); return sendJSON(res, 200, { ok: 1 }) }
      if (url === '/api/redeem' && req.method === 'POST') {
        if (limited(ip + 'r')) return sendJSON(res, 429, { error: 'slow down' });
        const b = await body(req), code = String(b.code || '').trim().toLowerCase(), it = CODES[code];
        if (!it) return sendJSON(res, 400, { error: 'invalid code' });
        if (me.u.save.own.includes(it)) return sendJSON(res, 400, { error: 'already in your inventory' });
        me.u.save.own.push(it); me.u.save.look = Object.assign(cleanLook(me.u.save.look), { [it]: 1 }); markDirty();
        return sendJSON(res, 200, { item: it, save: pubSave(me.u) });
      }
      if (url === '/api/match' && req.method === 'POST') {
        // XP for a finished room match (only possible after the server itself started a match with 2+ players)
        const ms = me.u.matchStart; if (!ms || Date.now() - ms > 3 * 3600e3) return sendJSON(res, 200, { gain: 0, save: pubSave(me.u) });
        delete me.u.matchStart;
        const b = await body(req), el = Math.max(0, Math.min(15, b.elims | 0)), secs = Math.max(0, Math.min(1200, Math.min(b.secs | 0, (Date.now() - ms) / 1000)));
        const gain = Math.min(600, 20 + el * 25 + (b.won ? 150 : 0) + Math.floor(secs / 10)), before = lvl(me.u.save.xp || 0);
        me.u.save.xp = (me.u.save.xp || 0) + gain; markDirty();
        const sv = pubSave(me.u); return sendJSON(res, 200, { gain, leveled: sv.level > before, save: sv });
      }
      return sendJSON(res, 404, { error: 'unknown endpoint' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end() }
    serveStatic(req, res, url);
  } catch (e) { console.error(e); if (!res.headersSent) sendJSON(res, 500, { error: 'server error' }) }
});

// ---------- websocket rooms (raw RFC6455) ----------
const rooms = new Map(), GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11', MAXP = 12;
const RELAY = new Set(['st', 'sh', 'hit', 'dead', 'it', 'dr', 'ch', 'pc', 'ph']);
function frame(str) {
  const p = Buffer.from(str), n = p.length; let h;
  if (n < 126) h = Buffer.from([0x81, n]); else if (n < 65536) { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 126; h.writeUInt16BE(n, 2) } else { h = Buffer.alloc(10); h[0] = 0x81; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2) }
  return Buffer.concat([h, p]);
}
function send(c, obj) { if (!c.dead && c.sock.writable) c.sock.write(frame(JSON.stringify(obj))) }
function bcast(room, obj, except) { const f = frame(JSON.stringify(obj)); for (const c of room.clients.values()) if (c !== except && !c.dead && c.sock.writable) c.sock.write(f) }
server.on('upgrade', (req, sock) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname !== '/ws') return sock.destroy();
  const me = verifyToken(u.searchParams.get('token')), code = (u.searchParams.get('room') || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 16), key = req.headers['sec-websocket-key'];
  if (!me || !code || !key) { sock.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return sock.destroy() }
  let room = rooms.get(code); if (!room) rooms.set(code, room = { code, started: false, timer: null, clients: new Map(), nid: 1, taken: new Set(), opened: new Set(), pieces: new Map(), drops: new Map() });
  if (room.clients.size >= MAXP && ![...room.clients.values()].some(c => c.key === me.key)) { sock.write('HTTP/1.1 503 Room Full\r\n\r\n'); return sock.destroy() }
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + crypto.createHash('sha1').update(key + GUID).digest('base64') + '\r\n\r\n');
  sock.setNoDelay(true);
  for (const o of room.clients.values()) if (o.key === me.key) { o.sock.destroy() } // same account twice: kick the old one
  const c = { sock, key: me.key, name: me.u.name, lv: lvl(me.u.save.xp || 0), id: room.nid++, room, look: null, st: null, buf: Buffer.alloc(0), frag: null, dead: false, rate: 0, alive: true };
  room.clients.set(c.id, c); if (room.started && room.clients.size >= 2) { me.u.matchStart = Date.now(); markDirty() }
  send(c, { t: 'welcome', id: c.id, players: [...room.clients.values()].filter(o => o !== c).map(o => ({ id: o.id, name: o.name, lv: o.lv, look: o.look, st: o.st, ready: !!o.ready })), started: room.started,
    state: { taken: [...room.taken], opened: [...room.opened], pieces: [...room.pieces.values()].map(p => p.msg), drops: [...room.drops.values()] } });
  const rl = setInterval(() => { c.rate = 0 }, 1000); const pg = setInterval(() => { if (!c.alive) return c.sock.destroy(); c.alive = false; if (c.sock.writable) c.sock.write(Buffer.from([0x89, 0])) }, 20000);
  function close() { if (c.dead) return; c.dead = true; clearInterval(rl); clearInterval(pg); if (room.clients.get(c.id) === c) { room.clients.delete(c.id); bcast(room, { t: 'leave', id: c.id }) } if (!room.clients.size) { clearTimeout(room.timer); rooms.delete(code) } else checkStart(room) }
  sock.on('close', close); sock.on('error', close);
  sock.on('data', d => {
    c.buf = Buffer.concat([c.buf, d]); if (c.buf.length > 60000) return sock.destroy();
    for (;;) {
      const b = c.buf; if (b.length < 2) return; const op = b[0] & 15, fin = b[0] & 128, masked = b[1] & 128; let len = b[1] & 127, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4 } else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10 }
      if (len > 40000) return sock.destroy(); if (!masked) return sock.destroy();
      if (b.length < off + 4 + len) return;
      const mk = b.subarray(off, off + 4), pl = Buffer.from(b.subarray(off + 4, off + 4 + len)); for (let i = 0; i < len; i++) pl[i] ^= mk[i & 3];
      c.buf = b.subarray(off + 4 + len);
      if (op === 8) return sock.end(); if (op === 9) { sock.write(Buffer.concat([Buffer.from([0x8a, len]), pl])); continue } if (op === 10) { c.alive = true; continue }
      if (op === 0 || op === 1) { c.frag = op === 1 ? [pl] : (c.frag || []).concat([pl]); if (!fin) continue; const s = Buffer.concat(c.frag).toString(); c.frag = null; onMsg(c, s) }
    }
  });
});
function onMsg(c, s) {
  if (++c.rate > 90) return; const m = safeJSON(s), room = c.room; if (!m || typeof m.t !== 'string') return;
  c.alive = true;
  if (m.t === 'hello') { if (m.look && typeof m.look === 'object') { c.look = m.look; bcast(room, { t: 'join', id: c.id, name: c.name, lv: c.lv, look: c.look }, c); checkStart(room) } return }
  if (m.t === 'look') { if (m.look && typeof m.look === 'object') { c.look = m.look; bcast(room, { t: 'look', id: c.id, look: c.look }, c) } return }
  if (m.t === 'ready') { if (room.started) return; c.ready = !!m.r; bcast(room, { t: 'ready', id: c.id, r: c.ready ? 1 : 0 }, c); checkStart(room); return }
  if (!RELAY.has(m.t)) return;
  if (m.t === 'hit') { const to = room.clients.get(m.to); if (to && typeof m.d === 'number') send(to, { t: 'hit', from: c.id, d: Math.max(0, Math.min(500, m.d)) }); return }
  m.from = c.id;
  if (m.t === 'st') c.st = m;
  else if (m.t === 'it') { if (typeof m.id === 'string' && m.id[0] === 'w') room.taken.add(m.id); else room.drops.delete(m.id) }
  else if (m.t === 'dr') { if (room.drops.size < 1500) room.drops.set(m.id, m) }
  else if (m.t === 'ch') room.opened.add(m.i);
  else if (m.t === 'pc') { if (typeof m.k === 'string' && Array.isArray(m.tl) && m.tl.length <= 16 && room.pieces.size < 4000) room.pieces.set(m.k, { msg: m, hp: +m.hp || 100 }) }
  else if (m.t === 'ph') { const p = room.pieces.get(m.k); if (p) { p.hp -= +m.a || 0; if (p.hp <= 0) room.pieces.delete(m.k) } }
  bcast(room, m, c);
}
// lobby: when every player in the room is ready -> 3 s countdown -> match starts for everybody
function checkStart(room) {
  if (room.started) return;
  const all = [...room.clients.values()];
  if (all.length && all.every(c => c.ready)) {
    if (!room.timer) { bcast(room, { t: 'cd', s: 3 }); room.timer = setTimeout(() => { room.timer = null; if ([...room.clients.values()].every(c => c.ready) && room.clients.size) { room.started = true; if (room.clients.size >= 2) for (const c of room.clients.values()) users[c.key].matchStart = Date.now(); markDirty(); bcast(room, { t: 'start' }) } }, 3000) }
  } else if (room.timer) { clearTimeout(room.timer); room.timer = null; bcast(room, { t: 'cd', s: 0 }) }
}
loadRemote().then(() => server.listen(PORT, () => console.log('bagel royale online on :' + PORT)));
