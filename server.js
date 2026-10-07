// Las Cabras — servidor multijugador (Node.js + WebSocket)
// Sirve la página y lleva todas las partidas: estado, temporizadores, reglas, poderes secretos y chat.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const INDEX_PATH = path.join(__dirname, 'public', 'index.html');

const K = Number(process.env.TIME_SCALE) || 1; // solo para pruebas
const SPIN_MS = 2500 * K, VETO_MS = 5000 * K, SOLD_MS = 4000 * K, PRE_MS = 3000 * K;
const SWAP_MS = 40000 * K, SWAP_CONFIRM_MS = 20000 * K, RESPIN_ASK_MS = 15000 * K, SWAP_DONE_MS = 6000 * K;
const VOTE_MIN_MS = 60000 * K, VOTE_PER_TEAM_MS = 15000 * K;
const HOST_HANDOVER_MS = 20000 * K;
const GAME_IDLE_MS = 3 * 60 * 60 * 1000;
const MAX_TURN_SECS = 10;
const REACTIONS = ['🐐', '🔥', '😂', '💸', '😱', '👏'];

const uid = () => Math.random().toString(36).slice(2, 10);
const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const pick = a => a[Math.floor(Math.random() * a.length)];

const games = new Map();
function genCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c; do { c = ''; for (let i = 0; i < 5; i++) c += A[Math.floor(Math.random() * A.length)]; } while (games.has(c));
  return c;
}

class Game {
  constructor(hostName, cid) {
    this.code = genCode();
    this.priv = this.freshPriv();
    this.cids = {};
    this.sockets = new Set();
    this.chat = [];
    this.lastActive = Date.now();
    const hid = uid();
    this.cids[hid] = cid;
    this.st = {
      phase: 'lobby', code: this.code, round: 1, paused: false, pausedAt: 0, hostId: hid,
      config: { people: [], teamSize: 3, goats: 21, turnSecs: 10 },
      players: [this.newPlayer(hid, hostName)],
      order: [], openerIdx: 0, auction: null, history: [], leftovers: [], swap: null,
      voteEndsAt: 0, results: null, warn: null, vetoed: []
    };
    games.set(this.code, this);
  }
  freshPriv() { return { vetoHolder: null, swapHolder: null, swapOffer: null, swapSkipped: false, votes: {}, bids: {} }; }
  newPlayer(id, name) { return { id, name, connected: true, discAt: 0, goats: 0, team: [], voteDone: false }; }
  P(id) { return this.st.players.find(p => p.id === id); }
  holes(p) { return this.st.config.teamSize - p.team.length; }
  maxBid(p) { return this.holes(p) > 0 ? p.goats - (this.holes(p) - 1) : p.goats; }
  turnMs() { return Math.min(MAX_TURN_SECS, this.st.config.turnSecs) * 1000 * K; }

  // lo que solo ve cada jugador (poderes secretos)
  mine(pid) {
    const pr = this.priv, out = {};
    if (pr.vetoHolder === pid) out.veto = true;
    if (pr.swapHolder === pid) out.swap = { offer: pr.swapOffer, skipped: pr.swapSkipped };
    return out;
  }
  broadcast() {
    const now = Date.now(); this.lastActive = now;
    for (const ws of this.sockets) send(ws, { t: 'state', s: this.st, now, you: ws.pid, mine: this.mine(ws.pid) });
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
        p = same;
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
    send(ws, { t: 'chatlog', list: this.chat });
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

  // ---------- chat ----------
  say(ws, text) {
    const t = Date.now();
    if (ws.lastChat && t - ws.lastChat < 300) return;
    ws.lastChat = t;
    text = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!text) return;
    const m = { id: uid(), by: ws.pid, text, at: t };
    this.chat.push(m); if (this.chat.length > 60) this.chat.shift();
    for (const s of this.sockets) send(s, { t: 'chat', m });
  }

  // ---------- reacciones ----------
  react(ws, e) {
    const t = Date.now();
    if (!REACTIONS.includes(e) || (ws.lastReact && t - ws.lastReact < 180)) return;
    ws.lastReact = t;
    for (const s of this.sockets) send(s, { t: 'react', e, by: ws.pid });
  }

  // ---------- acciones ----------
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
          goats: Math.max(1, Math.min(999, parseInt(m.goats) || 1)),
          turnSecs: Math.max(5, Math.min(MAX_TURN_SECS, parseInt(m.turnSecs) || MAX_TURN_SECS))
        };
        return this.broadcast();
      }
      case 'host': if (isHost) this.hostAction(m.act); return;
      case 'bid': if (!st.paused) this.placeBid(pid, Number(m.amount)); return;
      case 'withdraw': if (!st.paused) this.withdraw(pid); return;
      case 'veto': if (!st.paused) this.useVeto(pid, m.target); return;
      case 'swap-pick': if (!st.paused) this.swapPick(pid, m.mine, m.target); return;
      case 'swap-decide': if (!st.paused) this.swapDecide(pid, !!m.accept); return;
      case 'swap-skip': if (!st.paused) this.swapSkip(pid); return;
      case 'respin': if (!st.paused) this.respinDecide(pid, !!m.go); return;
      case 'vote': {
        if (st.phase !== 'vote' || p.voteDone) return;
        const rivals = st.players.filter(q => q.id !== pid && q.team.length).map(q => q.id);
        const order = Array.isArray(m.order) ? m.order.map(String) : [];
        if (order.length !== rivals.length || new Set(order).size !== order.length || !order.every(id => rivals.includes(id))) return;
        this.priv.votes[pid] = order; p.voteDone = true;
        if (!this.checkAllDone()) this.broadcast();
        return;
      }
    }
  }

  checkAllDone() {
    const st = this.st, on = st.players.filter(x => x.connected);
    if (!on.length || st.paused) return false;
    if (st.phase === 'vote') {
      const voters = on.filter(x => st.players.some(q => q.id !== x.id && q.team.length));
      if (voters.every(x => x.voteDone)) { this.endVote(); return true; }
    }
    return false;
  }

  hostAction(act) {
    const st = this.st;
    if (act === 'pause') {
      if (!['auction', 'swap', 'vote'].includes(st.phase)) return;
      if (!st.paused) { st.paused = true; st.pausedAt = Date.now(); }
      else {
        const d = Date.now() - st.pausedAt;
        st.voteEndsAt += d;
        if (st.auction) { st.auction.deadline += d; if (st.auction.spin) st.auction.spin.endsAt += d; }
        if (st.swap) { st.swap.deadline += d; if (st.swap.spin) st.swap.spin.endsAt += d; }
        st.paused = false;
      }
      this.broadcast();
    } else if (act === 'start') {
      if (st.phase !== 'lobby') return;
      st.players = st.players.filter(p => p.connected);
      if (!this.lobbyOk()) return this.broadcast();
      this.startAuction();
    } else if (act === 'new-game') {
      if (st.phase !== 'results') return;
      st.round++; st.players = st.players.filter(p => p.connected);
      if (!this.lobbyOk()) { this.toLobby(); return; }
      this.startAuction();
    } else if (act === 'to-lobby') {
      if (st.phase !== 'results') return;
      this.toLobby();
    }
  }
  toLobby() {
    const st = this.st;
    st.round++; st.phase = 'lobby'; st.results = null; st.auction = null; st.swap = null; st.history = []; st.leftovers = []; st.vetoed = []; st.paused = false;
    st.players = st.players.filter(p => p.connected);
    st.players.forEach(p => { p.team = []; p.goats = 0; p.voteDone = false; });
    this.priv = this.freshPriv();
    this.broadcast();
  }
  lobbyOk() {
    const c = this.st.config, n = this.st.players.length;
    return n >= 2 && c.teamSize >= 1 && c.goats >= c.teamSize && c.people.length >= n * c.teamSize + n; // una de margen por jugador para los descartes
  }

  // ---------- subasta ----------
  startAuction() {
    const st = this.st, c = st.config;
    st.players.forEach(p => { p.goats = c.goats; p.team = []; p.voteDone = false; });
    this.priv = this.freshPriv();
    const ids = st.players.map(p => p.id);
    // poderes secretos: el veto solo tiene sentido con 3 o más jugadores
    if (ids.length >= 3) this.priv.vetoHolder = pick(ids);
    const swapPool = ids.filter(id => id !== this.priv.vetoHolder);
    this.priv.swapHolder = pick(swapPool.length ? swapPool : ids);
    st.history = []; st.results = null; st.warn = null; st.paused = false; st.swap = null; st.leftovers = []; st.vetoed = [];
    st.order = shuffle(ids); st.openerIdx = 0;
    st.phase = 'auction';
    st.auction = { wheel: c.people.slice(), stage: 'pre', deadline: Date.now() + PRE_MS, spin: null, lot: null, bid: 0, leader: null, turn: null, opener: null, vetoed: null, withdrawn: [], last: null };
    this.broadcast();
  }
  tick(t) {
    const st = this.st;
    if (st.hostId && !st.paused) {
      const h = this.P(st.hostId);
      if (h && !h.connected && h.discAt && t - h.discAt > HOST_HANDOVER_MS && st.players.some(p => p.connected)) { this.handOver(); this.broadcast(); }
    }
    if (st.paused) return;
    if (st.phase === 'vote' && t >= st.voteEndsAt) this.endVote();
    else if (st.phase === 'auction') {
      const a = st.auction; if (t < a.deadline) return;
      if (a.stage === 'pre' || a.stage === 'sold') this.nextLot();
      else if (a.stage === 'spinning') this.startVeto();
      else if (a.stage === 'veto') this.startBidding();
      else if (a.stage === 'bidding') this.turnTimeout();
    } else if (st.phase === 'swap') {
      const s = st.swap; if (t < s.deadline) return;
      if (s.stage === 'secret') this.startVote();
      else if (s.stage === 'respin-ask') { s.stage = 'done'; s.deadline = t + SWAP_DONE_MS; this.broadcast(); }
      else if (s.stage === 'spinning') this.applyRespin();
      else if (s.stage === 'done') this.startVote();
    }
  }
  nextLot() {
    const st = this.st, a = st.auction;
    const incomplete = st.players.filter(p => p.team.length < st.config.teamSize);
    if (!incomplete.length || !a.wheel.length) return this.endAuction();
    const idx = Math.floor(Math.random() * a.wheel.length);
    a.spin = { key: uid(), names: a.wheel.slice(), index: idx, endsAt: Date.now() + SPIN_MS };
    a.lot = a.wheel[idx]; a.wheel.splice(idx, 1);
    Object.assign(a, { stage: 'spinning', deadline: Date.now() + SPIN_MS, bidCount: 0, bid: 0, leader: null, turn: null, opener: null, vetoed: null, withdrawn: [] });
    this.broadcast();
  }
  pickOpener() {
    const st = this.st, o = st.order, n = o.length;
    for (let k = 0; k < n; k++) {
      const id = o[(st.openerIdx + k) % n]; const p = this.P(id);
      if (p && p.team.length < st.config.teamSize) { st.openerIdx = (st.openerIdx + k + 1) % n; return id; }
    }
    return null;
  }
  startVeto() {
    const a = this.st.auction;
    const opener = this.pickOpener();
    if (!opener) return this.endAuction();
    a.opener = opener;
    if (!this.priv.vetoHolder) return this.startBidding();
    a.stage = 'veto'; a.deadline = Date.now() + VETO_MS;
    this.broadcast();
  }
  vetoTargets() {
    const st = this.st, a = st.auction, h = this.priv.vetoHolder;
    return st.players.filter(p => p.id !== h && p.id !== a.opener && !st.vetoed.includes(p.id)).map(p => p.id);
  }
  useVeto(pid, target) {
    const st = this.st, a = st.auction;
    if (st.phase !== 'auction' || !a || a.stage !== 'veto' || this.priv.vetoHolder !== pid || a.vetoed) return;
    if (!this.vetoTargets().includes(target)) return;
    a.vetoed = target; st.vetoed.push(target);
    this.broadcast();
  }
  startBidding() {
    const st = this.st, a = st.auction;
    const opener = a.opener || this.pickOpener();
    if (!opener) return this.endAuction();
    Object.assign(a, { stage: 'bidding', opener, turn: opener, deadline: Date.now() + this.turnMs(), withdrawn: a.vetoed ? [a.vetoed] : [] });
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
  forceBid(pid, amount) { const a = this.st.auction; a.bid = amount; a.leader = pid; a.bidCount = (a.bidCount || 0) + 1; this.priv.bids[pid] = (this.priv.bids[pid] || 0) + 1; this.advanceTurn(pid); }
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
      a.turn = id; a.deadline = Date.now() + this.turnMs(); this.broadcast(); return;
    }
    this.sell();
  }
  sell() {
    const st = this.st, a = st.auction, w = this.P(a.leader);
    w.goats -= a.bid;
    let discarded = false;
    if (w.team.length < st.config.teamSize) w.team.push(a.lot); else discarded = true;
    const rec = { lot: a.lot, by: w.id, amount: a.bid, discarded, vetoed: a.vetoed, bids: a.bidCount || 1 };
    st.history.unshift(rec); a.last = rec;
    Object.assign(a, { stage: 'sold', turn: null, deadline: Date.now() + SOLD_MS });
    this.broadcast();
  }
  endAuction() {
    const st = this.st;
    const inc = st.players.filter(p => p.team.length < st.config.teamSize);
    st.warn = inc.length ? `Se acabaron las personas de la ruleta y no han completado su equipo: ${inc.map(p => p.name).join(', ')}.` : null;
    st.leftovers = st.auction.wheel.concat(st.history.filter(h => h.discarded).map(h => h.lot));
    this.startSwap();
  }

  // ---------- intercambio ----------
  startSwap() {
    const st = this.st, h = this.P(this.priv.swapHolder);
    if (!h) return this.startVote();
    const usable = h.team.length && st.players.some(q => q.id !== h.id && q.team.length);
    st.phase = 'swap';
    st.swap = { stage: 'secret', deadline: Date.now() + (h.connected && usable ? SWAP_MS : 5000 * K), info: null, spin: null };
    this.priv.swapOffer = null; this.priv.swapSkipped = false;
    this.broadcast();
  }
  swapPick(pid, mineName, target) {
    const st = this.st, s = st.swap;
    if (st.phase !== 'swap' || !s || s.stage !== 'secret' || this.priv.swapHolder !== pid || this.priv.swapOffer) return;
    const h = this.P(pid), t = this.P(target);
    if (!h || !t || t.id === pid || !t.team.length || !h.team.includes(mineName)) return;
    this.priv.swapOffer = { mine: mineName, target, theirs: pick(t.team) };
    s.deadline = Math.max(s.deadline, Date.now() + SWAP_CONFIRM_MS);
    this.broadcast();
  }
  swapSkip(pid) {
    const st = this.st, s = st.swap;
    if (st.phase !== 'swap' || !s || s.stage !== 'secret' || this.priv.swapHolder !== pid) return;
    this.priv.swapSkipped = true;
    this.startVote();
  }
  swapDecide(pid, accept) {
    const st = this.st, s = st.swap, o = this.priv.swapOffer;
    if (st.phase !== 'swap' || !s || s.stage !== 'secret' || this.priv.swapHolder !== pid || !o) return;
    if (!accept) { this.priv.swapOffer = null; this.priv.swapSkipped = true; return this.startVote(); }
    const h = this.P(pid), t = this.P(o.target);
    const i = h.team.indexOf(o.mine), j = t.team.indexOf(o.theirs);
    if (i < 0 || j < 0) return this.startVote();
    h.team[i] = o.theirs; t.team[j] = o.mine;
    s.info = { by: pid, target: o.target, gave: o.mine, got: o.theirs, respin: null };
    this.priv.swapOffer = null;
    if (st.leftovers.length && t.connected) { s.stage = 'respin-ask'; s.deadline = Date.now() + RESPIN_ASK_MS; }
    else { s.stage = 'done'; s.deadline = Date.now() + SWAP_DONE_MS; }
    this.broadcast();
  }
  respinDecide(pid, go) {
    const st = this.st, s = st.swap;
    if (st.phase !== 'swap' || !s || s.stage !== 'respin-ask' || s.info.target !== pid) return;
    if (!go) { s.info.respin = { declined: true }; s.stage = 'done'; s.deadline = Date.now() + SWAP_DONE_MS; return this.broadcast(); }
    const idx = Math.floor(Math.random() * st.leftovers.length);
    s.spin = { key: uid(), names: st.leftovers.slice(), index: idx, endsAt: Date.now() + SPIN_MS };
    s.stage = 'spinning'; s.deadline = Date.now() + SPIN_MS;
    this.broadcast();
  }
  applyRespin() {
    const st = this.st, s = st.swap, t = this.P(s.info.target);
    const got = s.spin.names[s.spin.index];
    const j = t.team.indexOf(s.info.gave);
    if (j >= 0) {
      t.team[j] = got;
      st.leftovers = st.leftovers.filter(n => n !== got).concat([s.info.gave]);
      s.info.respin = { out: s.info.gave, in: got };
    }
    s.stage = 'done'; s.deadline = Date.now() + SWAP_DONE_MS;
    this.broadcast();
  }

  // ---------- ranking final ----------
  startVote() {
    const st = this.st;
    const teams = st.players.filter(p => p.team.length).length;
    st.players.forEach(p => { p.voteDone = false; });
    this.priv.votes = {};
    st.phase = 'vote'; st.voteEndsAt = Date.now() + Math.max(VOTE_MIN_MS, teams * VOTE_PER_TEAM_MS);
    this.broadcast();
  }
  // premios de la noche: se calculan con lo que ha pasado en la partida
  awards(rows, votes) {
    const st = this.st, H = st.history, out = [];
    // si lo gana todo el mundo, el premio no tiene gracia: m = 0 lo descarta
    const maxBy = (items, val) => { const m = Math.max(...items.map(val)); const who = items.filter(x => val(x) === m); return { m: items.length > 1 && who.length === items.length ? 0 : m, who }; };
    const posOf = id => (rows.find(r => r.id === id) || {}).pos || 99;
    const bought = H.filter(h => !h.discarded);
    if (bought.length) {
      const top = bought.reduce((a, b) => b.amount > a.amount ? b : a);
      out.push({ icon: '💎', title: 'Fichaje más caro', who: [top.by], text: `${top.lot}, por ${top.amount} 🐐` });
      const min = Math.min(...bought.map(h => h.amount));
      const cheap = bought.filter(h => h.amount === min).sort((a, b) => posOf(a.by) - posOf(b.by))[0];
      out.push({ icon: '🏷️', title: 'Ganga de la noche', who: [cheap.by], text: `${cheap.lot}, por solo ${cheap.amount} 🐐` });
    }
    const hot = H.slice().sort((a, b) => (b.bids || 0) - (a.bids || 0))[0];
    if (hot && hot.bids >= 3) out.push({ icon: '🔥', title: 'La más deseada', who: hot.discarded ? [] : [hot.by], text: `${hot.lot}: ${hot.bids} pujas${hot.discarded ? ', y al final nadie se la llevó' : ''}` });
    const pl = st.players;
    if (pl.length) {
      const spent = maxBy(pl, p => st.config.goats - p.goats);
      if (spent.m > 0) out.push({ icon: '💸', title: 'El derrochador', who: spent.who.map(p => p.id), text: `${spent.m} 🐐 gastadas` });
      const left = maxBy(pl, p => p.goats);
      if (left.m > 0) out.push({ icon: '🐷', title: 'La hucha', who: left.who.map(p => p.id), text: `le ${left.who.length > 1 ? 'sobraron a cada uno' : 'sobraron'} ${left.m} 🐐 sin usar` });
      const block = maxBy(pl, p => H.filter(h => h.discarded && h.by === p.id).reduce((s, h) => s + h.amount, 0));
      if (block.m > 0) out.push({ icon: '🧱', title: 'Rey del bloqueo', who: block.who.map(p => p.id), text: `quemó ${block.m} 🐐 en chicas que nadie se llevó` });
      const bids = maxBy(pl, p => this.priv.bids[p.id] || 0);
      if (bids.m > 0) out.push({ icon: '🔨', title: 'Pujador compulsivo', who: bids.who.map(p => p.id), text: `${bids.m} pujas en toda la partida` });
    }
    // ojo de halcón: el ranking más parecido al resultado final
    const errs = Object.entries(votes).map(([vid, order]) => {
      const ideal = order.slice().sort((a, b) => posOf(a) - posOf(b));
      return { vid, e: order.reduce((s, id, i) => s + Math.abs(i - ideal.indexOf(id)), 0) };
    });
    if (errs.length) {
      const m = Math.min(...errs.map(x => x.e));
      out.push({ icon: '🦅', title: 'Ojo de halcón', who: errs.filter(x => x.e === m).map(x => x.vid), text: m === 0 ? 'clavó el ranking final' : 'el ranking más parecido al resultado final' });
    }
    return out;
  }
  endVote() {
    const st = this.st, votes = this.priv.votes;
    const teams = st.players.filter(p => p.team.length);
    const pts = {}, cnt = {};
    teams.forEach(t => { pts[t.id] = 0; cnt[t.id] = 0; });
    for (const order of Object.values(votes)) {
      const n = order.length;
      order.forEach((id, i) => { if (id in pts) { pts[id] += n - i; cnt[id]++; } });
    }
    // desempate: puntos medios por ranking recibido
    const rows = st.players.map(p => {
      const has = p.team.length > 0;
      return { id: p.id, name: p.name, team: p.team.slice(), points: has ? pts[p.id] : null, votes: has ? cnt[p.id] : 0, avg: has && cnt[p.id] ? pts[p.id] / cnt[p.id] : 0 };
    });
    const r6 = x => Math.round(x * 1e6);
    rows.sort((x, y) => ((y.points ?? -1) - (x.points ?? -1)) || (r6(y.avg) - r6(x.avg)));
    let tiedBroken = false;
    rows.forEach((r, i) => {
      const prev = rows[i - 1];
      if (prev && prev.points === r.points && r6(prev.avg) === r6(r.avg)) r.pos = prev.pos;
      else { r.pos = i + 1; if (prev && prev.points === r.points) { r.byTiebreak = true; prev.byTiebreak = true; tiedBroken = true; } }
    });
    st.results = {
      key: uid(), rows, ballots: votes, tiedBroken, awards: this.awards(rows, votes),
      reveal: { veto: this.priv.vetoHolder, vetoed: st.vetoed.slice(), swap: this.priv.swapHolder, swapUsed: !!(st.swap && st.swap.info) }
    };
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
    } else if (m.t === 'chat') {
      if (ws.game) ws.game.say(ws, m.text);
    } else if (m.t === 'react') {
      if (ws.game) ws.game.react(ws, m.e);
    } else if (ws.game) {
      ws.game.handle(ws.pid, m);
    }
  });
  ws.on('close', () => { if (ws.game) ws.game.drop(ws); });
});

setInterval(() => { const t = Date.now(); for (const g of games.values()) { try { g.tick(t); } catch (e) { console.error(e); } } }, 200);
setInterval(() => { for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; try { ws.ping(); } catch (e) {} } }, 15000);
setInterval(() => { const t = Date.now(); for (const [c, g] of games) if (!g.sockets.size && t - g.lastActive > GAME_IDLE_MS) games.delete(c); }, 60000);

server.listen(PORT, () => console.log('Las Cabras escuchando en el puerto ' + PORT));
