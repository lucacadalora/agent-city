// Agent City state server.
// Tails Claude Code's session logs and serves the wallpaper page plus a small
// state object at http://127.0.0.1:4545/state. Run: node server.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const PORT = Number(process.env.AGENT_CITY_PORT || 4545);
const ROOT = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
const HERE = import.meta.dirname;
const PUBLIC = path.join(HERE, 'public');
const THREE = path.join(HERE, 'node_modules', 'three');
const ACTIVE_MS = 90_000;   // a log written in the last 90 s counts as a live agent
const RATE_MS = 60_000;     // "k / min" is a trailing 60-s sum, like the demo
const EVENT_MS = 5 * 60_000; // only responses logged in the last 5 min become meteors
const CHUNK = 4 << 20;

const files = new Map();    // path -> { offset, size, mtimeMs, cwd, sub, name }
const seen = new Map();     // message.id:requestId -> [all, fresh, cacheRead, usd] already counted
const emitted = new Set();  // responses already sent to the page as meteors
let recent = [];            // [timestamp ms, tokens]
let events = [];            // finished responses, newest last: { seq, out, sub, cwd, src }
let seq = 0;
let live = false;           // false while the startup pass reads today's backlog
let today = 0;              // every token: input + output + cache writes + cache reads
let freshToday = 0;         // new tokens only: input + output (what the Claude app's stats card counts)
let cacheReadToday = 0;
let usdToday = 0;           // what the same usage would cost at Claude API list prices

// API list prices, $ per million tokens: input, 5-minute cache write, 1-hour cache write, cache read, output.
// Models not listed are priced as Opus 5.5.
const PRICES = {
  'claude-opus-5-5':   [4, 5, 8, 0.20, 20],
  'claude-opus-5':     [5, 6.25, 10, 0.50, 25],
  'claude-opus-4-8':   [5, 6.25, 10, 0.50, 25],
  'claude-opus-4-7':   [5, 6.25, 10, 0.50, 25],
  'claude-opus-4-6':   [5, 6.25, 10, 0.50, 25],
  'claude-fable-5-1':  [10, 12.5, 20, 0.25, 50],
  'claude-mythos-5-1': [10, 12.5, 20, 0.25, 50],
  'claude-fable-5':    [10, 12.5, 20, 1.00, 50],
  'claude-mythos-5':   [10, 12.5, 20, 1.00, 50],
  'claude-sonnet-5-5': [2, 2.5, 4, 0.20, 10],
  'claude-sonnet-5':   [2, 2.5, 4, 0.20, 10],
  'claude-sonnet-4-6': [3, 3.75, 6, 0.30, 15],
  'claude-haiku-4-5':  [1, 1.25, 2, 0.10, 5],
};
function usd(model, u) {
  const [pin, pw5, pw1, pcr, pout] = PRICES[model] || PRICES['claude-opus-5-5'];
  const cw = u.cache_creation_input_tokens || 0;
  const w1 = (u.cache_creation && u.cache_creation.ephemeral_1h_input_tokens) || 0;
  return ((u.input_tokens || 0) * pin + (cw - w1) * pw5 + w1 * pw1
        + (u.cache_read_input_tokens || 0) * pcr + (u.output_tokens || 0) * pout) / 1e6;
}
let dayStart = startOfDay();

function startOfDay() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function handleLine(info, line) {
  let e;
  try { e = JSON.parse(line); } catch { return; }
  if (e.cwd) info.cwd = e.cwd;
  if (e.isSidechain) info.sub = true;
  const u = e.message && e.message.usage;
  if (!u) return;
  const t = Date.parse(e.timestamp) || Date.now();
  if (t < dayStart) return;
  const n = (u.input_tokens || 0) + (u.output_tokens || 0)
          + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
  // One response is written as several lines that repeat its usage; count it once,
  // topping up if a later line reports more output.
  const key = `${e.message.id || e.uuid}:${e.requestId || ''}`;
  // A response is finished on its first line that has a stop_reason (subagent logs stream
  // partial lines before that). Each finished response falls on the city as a meteor.
  if (e.message.stop_reason && n > 0 && live && !emitted.has(key) && Date.now() - t < EVENT_MS) {
    emitted.add(key);
    events.push({ seq: ++seq, out: u.output_tokens || 0, cwd: info.cwd,
                  sub: info.name.startsWith('agent-') || !!e.isSidechain, src: info.name });
    if (events.length > 300) events = events.slice(-200);
  }
  const fresh = (u.input_tokens || 0) + (u.output_tokens || 0), cr = u.cache_read_input_tokens || 0;
  const [prev, prevFresh, prevCr, prevUsd] = seen.get(key) || [0, 0, 0, 0];
  if (n <= prev) return;
  const cost = usd(e.message.model, u);
  seen.set(key, [n, Math.max(fresh, prevFresh), Math.max(cr, prevCr), Math.max(cost, prevUsd)]);
  usdToday += Math.max(0, cost - prevUsd);
  today += n - prev;
  freshToday += Math.max(0, fresh - prevFresh);
  cacheReadToday += Math.max(0, cr - prevCr);
  recent.push([t, n - prev]);
}

function readNew(file, st) {
  let info = files.get(file);
  if (!info) {
    info = { offset: st.mtimeMs < dayStart ? st.size : 0, size: 0, mtimeMs: 0, cwd: null,
             sub: path.basename(file).startsWith('agent-'), name: path.basename(file) };
    files.set(file, info);
  }
  info.mtimeMs = st.mtimeMs;
  if (st.size < info.offset) info.offset = 0;          // file was rewritten
  if (st.size === info.offset) return;
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(CHUNK);
    let pos = info.offset, rest = Buffer.alloc(0);
    while (pos < st.size) {
      const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, st.size - pos), pos);
      if (n <= 0) break;
      pos += n;
      const data = rest.length ? Buffer.concat([rest, buf.subarray(0, n)]) : buf.subarray(0, n);
      const nl = data.lastIndexOf(10);                   // split on newline bytes only
      if (nl === -1) { rest = Buffer.from(data); continue; }
      const text = data.toString('utf8', 0, nl);
      rest = Buffer.from(data.subarray(nl + 1));
      for (const line of text.split('\n')) if (line) handleLine(info, line);
    }
    info.offset = pos - rest.length;                     // leave a half-written line for later
  } finally {
    fs.closeSync(fd);
  }
}

function visit(file) {
  let st;
  try { st = fs.statSync(file); } catch { files.delete(file); return; }
  const info = files.get(file);
  if (info && info.mtimeMs === st.mtimeMs && info.offset === st.size) return;
  try { readNew(file, st); } catch { /* unreadable right now; retry on the next pass */ }
}

function walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.jsonl')) visit(p);
  }
}

function rollover() {
  const d = startOfDay();
  if (d !== dayStart) { dayStart = d; today = 0; freshToday = 0; cacheReadToday = 0; usdToday = 0; seen.clear(); emitted.clear(); recent = []; }
}

// Full walk now and every 10 s (new sessions), hot files every second, plus FSEvents.
walk(ROOT);
live = true;
setInterval(() => { rollover(); walk(ROOT); }, 10_000);
setInterval(() => {
  const now = Date.now();
  for (const [file, info] of files) if (now - info.mtimeMs < 10 * 60_000) visit(file);
}, 1000);
try {
  fs.watch(ROOT, { recursive: true }, (_type, name) => {
    if (name && name.endsWith('.jsonl')) visit(path.join(ROOT, name));
  });
} catch { /* polling above still works */ }

// `since` is the last event seq the page has seen; without it (a fresh page) no backlog is sent.
function state(since = null) {
  const now = Date.now();
  recent = recent.filter(([t]) => t > now - RATE_MS);
  const live = [...files.values()].filter(f => f.cwd && now - f.mtimeMs < ACTIVE_MS);
  live.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const perMin = recent.reduce((sum, [, n]) => sum + n, 0);
  return {
    projects: new Set(live.map(f => f.cwd)).size,
    agents: live.length,
    subagents: live.filter(f => f.sub).length,
    project: live.length ? path.basename(live[0].cwd) : null,
    working: perMin > 0,
    tokensToday: today,
    freshToday,
    cacheReadToday,
    usdToday: Math.round(usdToday * 100) / 100,
    tokensPerMin: perMin,
    seq,
    events: since === null ? [] : events.filter(ev => ev.seq > since).slice(-40),
    at: now,
  };
}

const beacons = {};         // last heartbeat from each wallpaper page (see /debug)

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

function sendFile(res, base, rel) {
  const file = path.normalize(path.join(base, rel));
  if (!file.startsWith(base + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
                         'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

// When started by the menu-bar app, exit if that app goes away.
if (process.env.AGENT_CITY_PARENT) {
  const parent = Number(process.env.AGENT_CITY_PARENT);
  setInterval(() => { try { process.kill(parent, 0); } catch { process.exit(0); } }, 3000);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/beacon') {
    beacons[url.searchParams.get('screen') || '0'] = { ...Object.fromEntries(url.searchParams), at: new Date().toISOString() };
    res.writeHead(204).end();
  } else if (url.pathname === '/debug') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ state: state(), wallpapers: beacons }, null, 2));
  } else if (url.pathname === '/state') {
    const since = url.searchParams.get('since');
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(state(since ? Number(since) : null)));
  } else if (url.pathname.startsWith('/vendor/three/')) {
    sendFile(res, THREE, decodeURIComponent(url.pathname.slice('/vendor/three/'.length)));
  } else {
    sendFile(res, PUBLIC, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1)));
  }
});
server.on('error', err => {
  console.error(err.code === 'EADDRINUSE' ? `agent-city: port ${PORT} already in use, another copy is serving` : err);
  process.exit(err.code === 'EADDRINUSE' ? 0 : 1);
});
server.listen(PORT, '127.0.0.1', () => {
  console.log(`agent-city: http://127.0.0.1:${PORT}  (reading ${ROOT})`);
});
