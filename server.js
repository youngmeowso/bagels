'use strict';
// Bagel Royale online server - zero dependencies (Node 18+)
// no accounts: players only enter a name + room code. item codes live ONLY on the server.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto'), zlib = require('zlib');
const PORT = +process.env.PORT || 3000;
const PUB = path.join(__dirname, 'public');
// add more codes with CODES_JSON='{"mycode":"bag"}'  (items: bag, meow, pup)
const CODES = Object.assign({ craigmorrisonbugbag: 'bag', meowsi: 'meow', puppet: 'pup' }, safeJSON(process.env.CODES_JSON) || {});
function safeJSON(s) { try { return JSON.parse(s) } catch (e) { return null } }
const hits = new Map();
function limited(ip) { const n = Date.now(), a = (hits.get(ip) || []).filter(t => n - t < 300000); a.push(n); hits.set(ip, a); return a.length > 20 }
setInterval(() => { const n = Date.now(); for (const [k, a] of hits) if (!a.some(t => n - t < 300000)) hits.delete(k) }, 600000).unref();
const cleanName = n => String(n || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 12) || 'player';

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
    if (url === '/api/redeem' && req.method === 'POST') {
      if (limited(ip + 'r')) return sendJSON(res, 429, { error: 'slow down' });
      const b = await body(req), code = String(b.code || '').trim().toLowerCase(), it = CODES[code];
      if (!it) return sendJSON(res, 400, { error: 'invalid code' });
      return sendJSON(res, 200, { item: it });
    }
    if (url.startsWith('/api/')) return sendJSON(res, 404, { error: 'unknown endpoint' });
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
  const nm = cleanName(u.searchParams.get('name')), code = (u.searchParams.get('room') || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 16), key = req.headers['sec-websocket-key'];
  if (!code || !key) { sock.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return sock.destroy() }
  let room = rooms.get(code); if (!room) rooms.set(code, room = { code, started: false, timer: null, clients: new Map(), nid: 1, taken: new Set(), opened: new Set(), pieces: new Map(), drops: new Map() });
  if (room.clients.size >= MAXP) { sock.write('HTTP/1.1 503 Room Full\r\n\r\n'); return sock.destroy() }
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + crypto.createHash('sha1').update(key + GUID).digest('base64') + '\r\n\r\n');
  sock.setNoDelay(true);
  const c = { sock, name: nm, id: room.nid++, room, look: null, st: null, buf: Buffer.alloc(0), frag: null, dead: false, rate: 0, alive: true };
  room.clients.set(c.id, c);
  send(c, { t: 'welcome', id: c.id, players: [...room.clients.values()].filter(o => o !== c).map(o => ({ id: o.id, name: o.name, look: o.look, st: o.st, ready: !!o.ready })), started: room.started,
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
  if (m.t === 'hello') { if (m.look && typeof m.look === 'object') { c.look = m.look; bcast(room, { t: 'join', id: c.id, name: c.name, look: c.look }, c); checkStart(room) } return }
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
    if (!room.timer) { bcast(room, { t: 'cd', s: 3 }); room.timer = setTimeout(() => { room.timer = null; if ([...room.clients.values()].every(c => c.ready) && room.clients.size) { room.started = true; bcast(room, { t: 'start' }) } }, 3000) }
  } else if (room.timer) { clearTimeout(room.timer); room.timer = null; bcast(room, { t: 'cd', s: 0 }) }
}
server.listen(PORT, () => console.log('bagel royale online on :' + PORT));
