// Las Cabras — servidor multijugador (Node.js + WebSocket)
// Sirve la página y lleva todas las partidas: estado, temporizadores y reglas.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const INDEX_PATH = path.join(__dirname, 'public', 'index.html');

const K = Number(process.env.TIME_SCALE) || 1; // solo para pruebas
const SPIN_MS = 4500 * K, TURN_MS = 10000 * K, SOLD_MS = 5000 * K, PRE_MS = 3000 * K, PRED_MS = 60000 * K, RATE_PER = 10000 * K;
const HOST_HANDOVER_MS = 20000 * K;          // si el anfitrión se va 20 s, otro hereda los botones
const GAME_IDLE_MS = 3 * 60 * 60 * 1000; // partidas sin nadie conectado se borran a las 3 h

const uid = () => Math.random().toString(36).slice(2, 10);
const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const r9 = x => Math.round(x * 1e9) / 1e9;

const games = new Map();
function genCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c; do { c = ''; for (let i = 0; i < 5; i++) c += A[Math.floor(Math.random() * A.length)]; } while (games.has(c));
  return c;
}

class Game {
  constructor(hostName, cid) {
    this.code = genCode();
    this.priv = { ratings: {}, notes: {}, preds: {} };
    this.cids = {};            // id de jugador -> token secreto del dispositivo (nunca se envía)
    this.sockets = new Set();
    this.lastActive = Date.now();
    const hid = uid();
    this.cids[hid] = cid;
    this.st = {
      phase: 'lobby', code: this.code, round: 1, paused: false, pausedAt: 0, hostId: hid,
      config: { people: [], teamSize: 3, goats: 21 },
      players: [this.newPlayer(hid, hostName)],
      order: [], openerIdx: 0, ratingEndsAt: 0, predictEndsAt: 0, auction: null, history: [], results: null, warn: null, excluded: 0
    };
    games.set(this.code, this);
  }
  newPlayer(id, name) { return { id, name, connected: true, discAt: 0, goats: 0, team: [], ratedDone: false, predDone: false }; }
  P(id) { return this.st.players.find(p => p.id === id); }
  holes(p) { return this.st.config.teamSize - p.team.length; }
  maxBid(p) { return this.holes(p) > 0 ? p.goats - (this.holes(p) - 1) : p.goats; }

  broadcast() {
    const now = Date.now(); this.lastActive = now;
    for (const ws of this.sockets) send(ws, { t: 'state', s: this.st, now, you: ws.pid });
  }
  toast(msg, except) { for (const ws of this.sockets) if (ws !== except) send(ws, { t: 'toast', msg }); }

  // ---------- entrar / salir ----------
  join(ws, rawName, cid) {
    const st = this.st; const name = String(rawName || '').trim().slice(0, 20);
    let p = Object.keys(this.cids).map(id => this.cids[id] === cid ? this.P(id) : null).find(Boolean);
    if (!p) {
      if (!name) return send(ws, { t: 'error', code: 'name', msg: 'Escribe un nombre para entrar.' });
      const same = st.players.find(x => x.name.toLowerCase() === name.toLowerCase());
      if (same) {
        if (same.connected) return send(ws, { t: 'error', code: 'name', msg: 'Ya hay alguien con ese nombre en la partida. Usa otro.' });
        p = same; // retoma su sitio desde otro dispositivo
      } else {
        if (st.phase !== 'lobby') return send(ws, { t: 'error', code: 'started', msg: 'La partida ya ha empezado. Solo pueden volver los jugadores que ya estaban.' });
        if (st.players.length >= 20) return send(ws, { t: 'error', code: 'full', msg: 'La partida está llena (20 jugadores).' });
        p = this.newPlayer(uid(), name); st.players.push(p);
        this.toast(name + ' se ha unido', ws);
      }
      this.cids[p.id] = cid;
    } else if (!p.connected) this.toast(p.name + ' ha vuelto', ws);
    if (ws.game && ws.game !== this) ws.game.drop(ws);
    p.connected = true; p.discAt = 0;
    ws.game = this; ws.pid = p.id; this.sockets.add(ws);
    this.broadcast();
  }
  drop(ws) {
    this.sockets.delete(ws);
    const pid = ws.pid; ws.game = null; ws.pid = null;
    if ([...this.sockets].some(x => x.pid === pid)) return;
    const p = this.P(pid); if (!p) return;
    p.connected = false; p.discAt = Date.now();
    const a = this.st.auction;
    if (this.st.phase === 'auction' && a && a.stage === 'bidding' && a.turn === pid && !this.st.paused) this.turnTimeout();
    if (this.checkAllDone()) return;
    this.broadcast();
  }
  leave(ws) {
    const pid = ws.pid; this.drop(ws);
    if (this.st.phase === 'lobby' || this.st.phase === 'results') {
      this.st.players = this.st.players.filter(p => p.id !== pid); delete this.cids[pid];
      if (this.st.hostId === pid) this.handOver();
      if (!this.st.players.length) { games.delete(this.code); return; }
      this.broadcast();
    }
  }
  handOver() {
    const next = this.st.players.find(p => p.connected && p.id !== this.st.hostId) || this.st.players.find(p => p.id !== this.st.hostId);
    if (next) { this.st.hostId = next.id; this.toast(next.name + ' es ahora el anfitrión'); }
  }

  // ---------- acciones de jugador ----------
  handle(pid, m) {
    const st = this.st; const p = this.P(pid); if (!p) return;
    const isHost = st.hostId === pid;
    switch (m.t) {
      case 'config': {
        if (!isHost || st.phase !== 'lobby') return;
        const seen = new Set();
        const people = (Array.isArray(m.people) ? m.people : []).map(s => String(s).trim().slice(0, 40))
          .filter(s => s && !seen.has(s.toLowerCase()) && seen.add(s.toLowerCase())).slice(0, 100);
        st.config = {
          people,
          teamSize: Math.max(1, Math.min(10, parseInt(m.teamSize) || 1)),
          goats: Math.max(1, Math.min(999, parseInt(m.goats) || 1))
        };
        return this.broadcast();
      }
      case 'host': if (isHost) this.hostAction(m.act); return;
      case 'rate': {
        if (st.phase !== 'rating' || p.ratedDone) return;
        const r = {}; const src = m.r || {};
        for (const n of st.config.people) { const v = src[n]; if (typeof v === 'number' && v >= 0 && v <= 10) r[n] = Math.round(v); }
        this.priv.ratings[pid] = r;
        if (m.done) { p.ratedDone = true; if (!this.checkAllDone()) this.broadcast(); }
        return;
      }
      case 'bid': if (!st.paused) this.placeBid(pid, Number(m.amount)); return;
      case 'withdraw': if (!st.paused) this.withdraw(pid); return;
      case 'pred': {
        if (st.phase !== 'predict' || p.predDone) return;
        const g = {}; const src = m.g || {};
        for (const q of st.players) { if (q.id === pid || !q.team.length) continue; const v = Number(src[q.id]); g[q.id] = isFinite(v) ? Math.min(10, Math.max(0, Math.round(v * 10) / 10)) : 5; }
        this.priv.preds[pid] = g; p.predDone = true;
        if (!this.checkAllDone()) this.broadcast();
        return;
      }
    }
  }

  // cierra la fase en cuanto todos los jugadores conectados han enviado
  checkAllDone() {
    const st = this.st, on = st.players.filter(x => x.connected);
    if (!on.length || st.paused) return false;
    if (st.phase === 'rating' && on.every(x => x.ratedDone)) { this.endRating(); return true; }
    if (st.phase === 'predict' && on.every(x => x.predDone)) { this.endPredict(); return true; }
    return false;
  }
  hostAction(act) {
    const st = this.st;
    if (act === 'pause') {
      if (!['rating', 'auction', 'predict'].includes(st.phase)) return;
      if (!st.paused) { st.paused = true; st.pausedAt = Date.now(); }
      else { const d = Date.now() - st.pausedAt; st.ratingEndsAt += d; st.predictEndsAt += d; if (st.auction) st.auction.deadline += d; if (st.auction && st.auction.spin) st.auction.spin.endsAt += d; st.paused = false; }
      this.broadcast();
    } else if (act === 'start') {
      if (st.phase !== 'lobby') return;
      st.players = st.players.filter(p => p.connected);
      if (!this.lobbyOk()) return this.broadcast();
      this.startRating();
    } else if (act === 'new-game') {
      if (st.phase !== 'results') return;
      st.round++; st.players = st.players.filter(p => p.connected);
      if (!this.lobbyOk()) { this.toLobby(); return; }
      this.startRating();
    } else if (act === 'to-lobby') {
      if (st.phase !== 'results') return;
      this.toLobby();
    }
  }
  toLobby() {
    const st = this.st;
    st.round++; st.phase = 'lobby'; st.results = null; st.auction = null; st.history = []; st.paused = false;
    st.players = st.players.filter(p => p.connected);
    st.players.forEach(p => { p.team = []; p.goats = 0; p.ratedDone = false; p.predDone = false; });
    this.broadcast();
  }
  lobbyOk() {
    const c = this.st.config, n = this.st.players.length;
    return n >= 2 && c.teamSize >= 1 && c.goats >= c.teamSize && c.people.length >= n * c.teamSize;
  }

  // ---------- fases ----------
  startRating() {
    const st = this.st, c = st.config;
    st.players.forEach(p => { p.goats = c.goats; p.team = []; p.ratedDone = false; p.predDone = false; });
    this.priv = { ratings: {}, notes: {}, preds: {} };
    st.history = []; st.results = null; st.auction = null; st.warn = null; st.paused = false;
    st.phase = 'rating'; st.ratingEndsAt = Date.now() + c.people.length * RATE_PER;
    st.order = shuffle(st.players.map(p => p.id)); st.openerIdx = 0;
    this.broadcast();
  }
  endRating() {
    const st = this.st, notes = {};
    for (const n of st.config.people) {
      const vals = Object.values(this.priv.ratings).map(r => r[n]).filter(v => typeof v === 'number');
      if (vals.length) notes[n] = avg(vals);
    }
    this.priv.notes = notes;
    const wheel = st.config.people.filter(n => notes[n] != null);
    st.excluded = st.config.people.length - wheel.length;
    st.phase = 'auction';
    st.auction = { wheel, stage: 'pre', deadline: Date.now() + PRE_MS, spin: null, lot: null, bid: 0, leader: null, turn: null, opener: null, withdrawn: [], last: null };
    this.broadcast();
  }
  tick(t) {
    const st = this.st;
    if (st.hostId && !st.paused) {
      const h = this.P(st.hostId);
      if (h && !h.connected && h.discAt && t - h.discAt > HOST_HANDOVER_MS && st.players.some(p => p.connected)) { this.handOver(); this.broadcast(); }
    }
    if (st.paused) return;
    if (st.phase === 'rating' && t >= st.ratingEndsAt) this.endRating();
    else if (st.phase === 'predict' && t >= st.predictEndsAt) this.endPredict();
    else if (st.phase === 'auction') {
      const a = st.auction; if (t < a.deadline) return;
      if (a.stage === 'pre' || a.stage === 'sold') this.nextLot();
      else if (a.stage === 'spinning') this.startBidding();
      else if (a.stage === 'bidding') this.turnTimeout();
    }
  }
  nextLot() {
    const st = this.st, a = st.auction;
    const incomplete = st.players.filter(p => p.team.length < st.config.teamSize);
    if (!incomplete.length || !a.wheel.length) return this.endAuction();
    const idx = Math.floor(Math.random() * a.wheel.length);
    a.spin = { key: uid(), names: a.wheel.slice(), index: idx, endsAt: Date.now() + SPIN_MS };
    a.lot = a.wheel[idx]; a.wheel.splice(idx, 1);
    Object.assign(a, { stage: 'spinning', deadline: Date.now() + SPIN_MS, bid: 0, leader: null, turn: null, opener: null, withdrawn: [] });
    this.broadcast();
  }
  startBidding() {
    const st = this.st, a = st.auction, o = st.order, n = o.length;
    let opener = null;
    for (let k = 0; k < n; k++) {
      const id = o[(st.openerIdx + k) % n]; const p = this.P(id);
      if (p && p.team.length < st.config.teamSize) { opener = id; st.openerIdx = (st.openerIdx + k + 1) % n; break; }
    }
    if (!opener) return this.endAuction();
    Object.assign(a, { stage: 'bidding', opener, turn: opener, deadline: Date.now() + TURN_MS });
    if (!this.P(opener).connected) return this.forceBid(opener, 1);
    this.broadcast();
  }
  placeBid(pid, amount) {
    const st = this.st, a = st.auction;
    if (st.phase !== 'auction' || !a || a.stage !== 'bidding' || a.turn !== pid) return;
    amount = Math.floor(amount); const p = this.P(pid);
    if (!(amount >= a.bid + 1 && amount <= this.maxBid(p))) return;
    this.forceBid(pid, amount);
  }
  forceBid(pid, amount) { const a = this.st.auction; a.bid = amount; a.leader = pid; this.advanceTurn(pid); }
  withdraw(pid) {
    const st = this.st, a = st.auction;
    if (st.phase !== 'auction' || !a || a.stage !== 'bidding' || a.turn !== pid || a.leader === null) return;
    a.withdrawn.push(pid); this.advanceTurn(pid);
  }
  turnTimeout() {
    const a = this.st.auction;
    if (a.leader === null) this.forceBid(a.turn, 1);
    else { a.withdrawn.push(a.turn); this.advanceTurn(a.turn); }
  }
  advanceTurn(fromId) {
    const st = this.st, a = st.auction, o = st.order, n = o.length;
    const start = o.indexOf(fromId);
    for (let k = 1; k <= n; k++) {
      const id = o[(start + k) % n];
      if (id === a.leader || a.withdrawn.includes(id)) continue;
      const p = this.P(id);
      if (!p || this.maxBid(p) <= a.bid || !p.connected) { a.withdrawn.push(id); continue; }
      a.turn = id; a.deadline = Date.now() + TURN_MS; this.broadcast(); return;
    }
    this.sell();
  }
  sell() {
    const st = this.st, a = st.auction, w = this.P(a.leader);
    w.goats -= a.bid;
    let discarded = false;
    if (w.team.length < st.config.teamSize) w.team.push(a.lot); else discarded = true;
    const rec = { lot: a.lot, by: w.id, amount: a.bid, discarded };
    st.history.unshift(rec); a.last = rec;
    Object.assign(a, { stage: 'sold', turn: null, deadline: Date.now() + SOLD_MS });
    this.broadcast();
  }
  endAuction() {
    const st = this.st;
    const inc = st.players.filter(p => p.team.length < st.config.teamSize);
    st.warn = inc.length ? `Se acabaron las personas de la ruleta y no han completado su equipo: ${inc.map(p => p.name).join(', ')}.` : null;
    st.phase = 'predict'; st.predictEndsAt = Date.now() + PRED_MS;
    this.broadcast();
  }
  endPredict() {
    const st = this.st, notes = this.priv.notes;
    const teamAvg = {};
    st.players.forEach(p => { const v = p.team.map(n => notes[n]).filter(x => x != null); teamAvg[p.id] = v.length ? avg(v) : null; });
    const err = {}; const sent = st.players.filter(p => p.predDone);
    sent.forEach(p => {
      const g = this.priv.preds[p.id] || {}; const d = [];
      st.players.forEach(q => { if (q.id === p.id || teamAvg[q.id] == null) return; d.push(Math.abs((typeof g[q.id] === 'number' ? g[q.id] : 5) - teamAvg[q.id])); });
      err[p.id] = d.length ? avg(d) : 0;
    });
    const worst = sent.length ? Math.max(...sent.map(p => err[p.id])) : 0;
    st.players.forEach(p => { if (!p.predDone) err[p.id] = worst; });
    const rows = st.players.map(p => ({ id: p.id, name: p.name, team: p.team.slice(), avg: teamAvg[p.id], err: err[p.id], final: r9((teamAvg[p.id] ?? 0) - err[p.id]), sent: p.predDone }));
    rows.sort((x, y) => (y.final - x.final) || ((y.avg ?? 0) - (x.avg ?? 0)));
    let best = [];
    if (sent.length) { const m = Math.min(...sent.map(p => r9(err[p.id]))); best = sent.filter(p => r9(err[p.id]) === m).map(p => p.id); }
    const preds = {}; sent.forEach(p => preds[p.id] = this.priv.preds[p.id] || {});
    st.results = { key: uid(), rows, best, preds, teamAvg, worst };
    st.phase = 'results';
    this.broadcast();
  }
}

function send(ws, obj) { if (ws.readyState === 1) { try { ws.send(JSON.stringify(obj)); } catch (e) {} } }

// ---------- HTTP + WebSocket ----------
const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return; }
  fs.readFile(INDEX_PATH, (err, buf) => {
    if (err) { res.writeHead(500); res.end('Falta public/index.html'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });
wss.on('connection', ws => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    const cid = String(m.cid || '').slice(0, 64);
    if (m.t === 'create') {
      if (!cid) return;
      const name = String(m.name || '').trim().slice(0, 20);
      if (!name) return send(ws, { t: 'error', code: 'name', msg: 'Escribe un nombre para entrar.' });
      if (ws.game) ws.game.drop(ws);
      const g = new Game(name, cid);
      ws.game = g; ws.pid = g.st.hostId; g.sockets.add(ws); g.broadcast();
    } else if (m.t === 'join') {
      if (!cid) return;
      const g = games.get(String(m.code || '').toUpperCase());
      if (!g) return send(ws, { t: 'error', code: 'notfound', msg: 'No hay ninguna partida abierta con el código ' + String(m.code || '').toUpperCase() + '.' });
      g.join(ws, m.name, cid);
    } else if (m.t === 'leave') {
      if (ws.game) ws.game.leave(ws);
    } else if (ws.game) {
      ws.game.handle(ws.pid, m);
    }
  });
  ws.on('close', () => { if (ws.game) ws.game.drop(ws); });
});

// temporizadores de todas las partidas
setInterval(() => { const t = Date.now(); for (const g of games.values()) { try { g.tick(t); } catch (e) { console.error(e); } } }, 200);
// detectar móviles que se han quedado colgados
setInterval(() => { for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; try { ws.ping(); } catch (e) {} } }, 15000);
// limpiar partidas abandonadas
setInterval(() => { const t = Date.now(); for (const [c, g] of games) if (!g.sockets.size && t - g.lastActive > GAME_IDLE_MS) games.delete(c); }, 60000);

server.listen(PORT, () => console.log('Las Cabras escuchando en el puerto ' + PORT));
