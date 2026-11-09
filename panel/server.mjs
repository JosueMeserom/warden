// WardenPanel (web): the panel for the Minecraft servers. One process, on 127.0.0.1 behind a reverse proxy with HTTPS,
// separate from the gate: if this fails, the servers carry on.
// · Data: lazymc (asleep/awake, when it will sleep), the Java process (RAM, CPU), the WardenPanel plugin on Paper (players
//   with position, health…, TPS and what happens) and, without the plugin (Fabric), the status ping and the log.
// · Actions: plain console commands (LinuxGSM's tmux), the same on Paper and on Fabric; the central whitelist (the
//   gate's and the Discord bot's); wake/sleep like lazymc.
// · Access: the owner signs in through another site they trust (panel.sso); everyone else with a user and password the
//   owner creates, with permissions per server. Everything is logged; sensitive things notify the owner right away,
//   the rest goes in one message per session that keeps being updated.
//   node panel/server.mjs        node panel/server.test.mjs
import http from 'node:http';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { config, file, writeJSON, translator } from '../lib/config.mjs';
import { readRoutes, readWhitelist, saveWhitelist, wake, LOCAL_HEADER } from '../gate/gate.mjs';
import * as P from './players.mjs';
import * as I from './investigation.mjs';

const C = config();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = file('panel');
const PUBLIC = path.join(HERE, 'public');
const OWNER = C.owner ?? 'owner';

// Error texts (the page translates them).
const T = {
  noSession: 'You have to sign in.', noPermission: 'You are not allowed to do that.', notFound: 'It doesn\'t exist.',
  wrong: 'Wrong user or password.', blocked: 'Too many attempts: wait 15 minutes.',
  asleep: 'The server is asleep: wake it up first.', shortPassword: 'The new password must be at least 10 characters long.',
  badName: 'That isn\'t a valid Minecraft name.', badData: 'Something is missing or invalid.',
};

const PERMISSIONS = ['view', 'chat', 'moderate', 'ban', 'whitelist', 'investigate', 'inventories', 'items', 'world', 'power', 'console'];
export const PROFILES = {
  viewer: ['view'], moderator: ['view', 'chat', 'moderate', 'whitelist', 'investigate'],
  admin: PERMISSIONS.filter(p => p !== 'console'), console: [...PERMISSIONS],
};
const MC_NAME = /^\.?[A-Za-z0-9_]{1,16}$/;

fs.mkdirSync(DATA, { recursive: true, mode: 0o700 });
const df = n => path.join(DATA, n);
const readJSON = (n, def) => { try { return JSON.parse(fs.readFileSync(df(n), 'utf8')); } catch { return def; } };
const saveJSON = (n, o) => writeJSON(df(n), o);
const readJSONFile = (f, def) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return def; } };
const secret = n => {                                         // keys the panel creates the first time (600)
  try { return fs.readFileSync(df(n), 'utf8').trim(); } catch {}
  const k = crypto.randomBytes(32).toString('hex'); fs.writeFileSync(df(n), k + '\n', { mode: 0o600 }); return k;
};

// ─────────────────────── Users, permissions and sessions ───────────────────────

// users.json: { «name»: { hash, salt, mustChange, minecraft, permissions: { "*": [...], "lobby": [...] }, created } }
const users = () => readJSON('users.json', {});
const hashPassword = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');
export function randomPassword(n = 14) {
  const abc = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no 0/O, 1/l/I
  return Array.from(crypto.randomBytes(n), b => abc[b % abc.length]).join('');
}
// What someone may do on a server: what they have on «*» plus on that server; console includes everything.
export function permissionsOf(u, srv) {
  if (u.owner) return [...PERMISSIONS];
  const p = new Set([...(u.permissions?.['*'] ?? []), ...(u.permissions?.[srv] ?? [])]);
  return p.has('console') ? [...PERMISSIONS] : PERMISSIONS.filter(x => p.has(x));
}
const can = (u, srv, perm) => permissionsOf(u, srv).includes(perm);

// sessions.json: { sha256(token): { user, owner, created, last, ip } }. Only the browser has the token.
let sessions = readJSON('sessions.json', {});
const DAY = 864e5, EXPIRES = 30 * DAY, IDLE = 7 * DAY;
const sha = t => crypto.createHash('sha256').update(String(t)).digest('hex');
function newSession(res, user, owner, ip) {
  const token = crypto.randomBytes(32).toString('base64url');
  sessions[sha(token)] = { user, owner, created: Date.now(), last: Date.now(), ip };
  saveJSON('sessions.json', sessions);
  res.setHeader('set-cookie', `warden=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${EXPIRES / 1e3}`);
}
function session(req) {
  const token = /(?:^|;\s*)warden=([\w-]+)/.exec(req.headers.cookie ?? '')?.[1];
  const s = token && sessions[sha(token)], now = Date.now();
  if (!s || now - s.created > EXPIRES || now - s.last > IDLE) return null;
  if (!s.owner && !users()[s.user]) return null;              // removed
  if (now - s.last > 60e3) { s.last = now; saveJSON('sessions.json', sessions); }
  const u = s.owner ? { name: OWNER, owner: true } : { name: s.user, ...users()[s.user] };
  return { ...u, id: sha(token), ip: s.ip };
}
function closeSessions(user) {
  for (const [k, s] of Object.entries(sessions)) if (s.user === user) delete sessions[k];
  saveJSON('sessions.json', sessions);
}

// Brakes: 5 failures in a row from an IP or against a user → 15 minutes without trying.
const failures = new Map();
const braked = k => (failures.get(k)?.until ?? 0) > Date.now();
function failure(k) {
  const f = failures.get(k) ?? { n: 0 };
  f.n++; if (f.n >= 5) { f.until = Date.now() + 15 * 60e3; f.n = 0; }
  failures.set(k, f);
  return Boolean(f.until && f.until > Date.now());
}

// ─────────────────────── Log and notifications ───────────────────────

const settings = () => ({ notices: { console: 'now', ban: 'now', power: 'now', whitelist: 'now', world: 'now',
  failures: 'now', users: 'now', other: 'summary', ...(readJSON('settings.json', {}).notices ?? {}) } });
const CATEGORY = { console: 'console', ban: 'ban', unban: 'ban', wake: 'power', sleep: 'power', restart: 'power',
  'whitelist-add': 'whitelist', 'whitelist-remove': 'whitelist', failures: 'failures', 'user-created': 'users', 'user-permissions': 'users',
  'user-password': 'users', 'user-removed': 'users', rule: 'world', difficulty: 'world', time: 'world', weather: 'world', motd: 'world' };
const label = translator({
  en: { on: ' on {}', summary: '🛡 <b>{}</b> on the panel ({}):', failedFor: 'failed attempts for «{}» from {}' },
  es: { on: ' en {}', summary: '🛡 <b>{}</b> en el panel ({}):', failedFor: 'intentos fallidos para «{}» desde {}',
    console: 'consola', ban: 'banear', unban: 'desbanear', wake: 'despertar', sleep: 'dormir', restart: 'reiniciar', 'whitelist-add': 'lista: añadir',
    'whitelist-remove': 'lista: quitar', failures: 'fallos', 'user-created': 'usuarios: alta', 'user-permissions': 'usuarios: permisos',
    'user-password': 'usuarios: contraseña nueva', 'user-removed': 'usuarios: baja', rule: 'regla', difficulty: 'dificultad', time: 'hora',
    weather: 'clima', motd: 'motd', chat: 'chat', message: 'mensaje', kick: 'echar', tp: 'tp', mode: 'modo', heal: 'curar', give: 'dar',
    login: 'entra', 'password-changed': 'cambia su contraseña', 'reviewed': 'investigación: revisada', settings: 'ajustes' },
});
const L = (k, ...a) => label(C.language, k, ...a);
const html = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// Notify the owner; with panel.notifyEditFlag, the command can edit an earlier message (its id, printed last on stdout).
const notify = (text, edit) => new Promise(ok => {
  const c = C.notify; if (!Array.isArray(c) || !c.length) return ok(null);
  const flag = C.panel.notifyEditFlag, args = [...c.slice(1), ...(flag && edit ? [flag, String(edit)] : []), text];
  execFile(c[0], args, { timeout: 30e3 }, (e, out) => ok(e || !flag ? null : Number(String(out).trim().split('\n').pop()) || null));
});

// One message per session that keeps being updated, at most once a minute.
const summaries = new Map();
function toSummary(u, srv, type) {
  const r = summaries.get(u.id) ?? { user: u.name, counts: {}, msg: null, sent: 0, timer: null };
  summaries.set(u.id, r);
  const k = `${type}|${srv ?? ''}`; r.counts[k] = (r.counts[k] ?? 0) + 1;
  if (r.timer) return;
  r.timer = setTimeout(async () => {
    r.timer = null; r.sent = Date.now();
    const lines = Object.entries(r.counts).map(([k2, n]) => { const [t, s] = k2.split('|'); return `• ${html(L(t))}${s ? html(L('on', s)) : ''}: ${n}`; });
    const time = new Date().toLocaleTimeString(C.language === 'es' ? 'es-ES' : 'en-GB', { hour: '2-digit', minute: '2-digit' });
    const text = `${L('summary', html(r.user), time)}\n${lines.join('\n')}${C.panel.url ? `\n<i>${C.panel.url}/#log</i>` : ''}`;
    r.msg = (await notify(text, r.msg)) ?? r.msg;
  }, Math.max(0, 60e3 - (Date.now() - r.sent)));
}
// log.jsonl: everything done from the panel. The owner's own actions don't notify them.
function record(u, srv, type, detail, ip) {
  fs.appendFileSync(df('log.jsonl'), JSON.stringify({ t: Date.now(), user: u.name, server: srv, type, detail, ip }) + '\n', { mode: 0o600 });
  if (u.owner) return;
  const mode = settings().notices[CATEGORY[type]] ?? settings().notices.other;
  if (mode === 'now') notify(`🛡 <b>${html(u.name)}</b>${srv ? ` · <b>${html(srv)}</b>` : ''}: ${html(L(type))}${detail ? ` · <code>${html(String(detail).slice(0, 300))}</code>` : ''}`);
  else if (mode === 'summary') toSummary(u, srv, type);
}

// ─────────────────────── Servers ───────────────────────

const read = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
function webs() {                                             // from the Caddyfile: each server's map, Plan and WebConsole
  const cf = C.panel.caddyfile ?? C.caddy?.file, c = cf ? read(cf) : '', w = {};
  if (!C.domain) return w;
  const dom = C.domain.replace(/\./g, '\\.');
  for (const m of c.matchAll(new RegExp(`^([a-z0-9.-]+\\.${dom})\\s*\\{([\\s\\S]*?)^\\}`, 'gm'))) {
    const b = /bluemap\.caddy (mc-[a-z0-9]+)/.exec(m[2]); if (b) (w[b[1]] ??= {}).map = `https://${m[1]}`;
    const p = /reverse_proxy [\d.]+:(\d+)/.exec(m[2]); if (p) w[`:${p[1]}`] = `https://${m[1]}`;
    const k = /webconsole\.caddy (\d+)/.exec(m[2]); if (k) w[`:${k[1]}`] = `https://${m[1]}`;
  }
  return w;
}
export function servers(dir = C.serversDir) {
  const w = webs(), list = [];
  for (const [name, r] of readRoutes(dir)) {
    const d = path.join(dir, `mc-${name}`), sf = path.join(d, 'serverfiles'), toml = read(path.join(d, 'lazymc.toml'));
    let script = 'pmcserver'; try { script = fs.readdirSync(path.join(d, 'lgsm/config-lgsm'))[0]; } catch {}
    const type = fs.existsSync(path.join(sf, 'paper.jar')) ? 'paper' : fs.existsSync(path.join(sf, 'fabric-server-launch.jar')) ? 'fabric' : 'vanilla';
    const real = Number(/\[server\][^[]*?address\s*=\s*"[^"]*:(\d+)"/.exec(toml)?.[1]);
    const pub = r.public ?? r.internal;
    // If lazymc passes the real IP on (PROXY v2), the server requires that header on every connection: the ping too.
    const proxy = /\[server\][^[]*?send_proxy_v2\s*=\s*true/.test(toml);
    list.push({ name, dir: d, sf, script, type, real, proxy, lazymc: r.internal, public: pub,
      version: /\[public\][^[]*?version\s*=\s*"([^"]+)"/.exec(toml)?.[1] ?? '?',
      protocol: Number(/^protocol\s*=\s*(\d+)/m.exec(toml)?.[1] ?? 767),
      sleepAfter: Number(/^sleep_after\s*=\s*(\d+)/m.exec(toml)?.[1] ?? 600),
      minimum: Number(/^minimum_online_time\s*=\s*(\d+)/m.exec(toml)?.[1] ?? 0),
      map: w[`mc-${name}`]?.map ?? null, plan: w[`:${pub + 2}`] ?? null, webconsole: w[`:${pub + 3}`] ?? null });
  }
  return list;
}
const server = n => servers().find(s => s.name === n);

const open = (port, host = '127.0.0.1') => new Promise(ok => {
  const s = net.connect(port, host, () => { s.destroy(); ok(true); });
  s.on('error', () => ok(false)); s.setTimeout(1500, () => { s.destroy(); ok(false); });
});
const tmuxSocket = s => `${s.script}-${read(path.join(s.dir, `lgsm/data/${s.script}.uid`)).trim()}`;
const run = (prog, args, opts = {}) => new Promise(ok => execFile(prog, args, { timeout: 60e3, ...opts },
  (e, out, err) => ok({ ok: !e, code: e?.code ?? 0, output: `${out}${err}`.trim() })));
const tmuxAlive = async s => (await run('tmux', ['-L', tmuxSocket(s), 'has-session', '-t', s.script])).ok;

// Java status ping (what the server list shows): works without the plugin.
function ping(port, proxy = false) {
  return new Promise(ok => {
    const v = n => { const b = []; do { let x = n & 0x7f; n >>>= 7; if (n) x |= 0x80; b.push(x); } while (n); return Buffer.from(b); };
    const frame = c => Buffer.concat([v(c.length), c]), h = Buffer.from('127.0.0.1');
    const s = net.connect(port, '127.0.0.1', () => s.write(Buffer.concat([...(proxy ? [LOCAL_HEADER] : []),
      frame(Buffer.concat([v(0), v(767), v(h.length), h, Buffer.from([port >> 8, port & 255]), v(1)])), frame(v(0))])));
    let b = Buffer.alloc(0);
    const end = r => { s.destroy(); ok(r); };
    s.setTimeout(3000, () => end(null)); s.on('error', () => end(null));
    s.on('data', d => {
      b = Buffer.concat([b, d]);
      try { const j = b.indexOf(0x7b), k = b.lastIndexOf(0x7d); if (j >= 0 && k > j) end(JSON.parse(b.subarray(j, k + 1).toString('utf8'))); } catch {}
    });
  });
}

// The server's Java: the process whose working directory is its serverfiles. RAM and CPU (of one core) from /proc.
const samples = new Map();
function processOf(s) {
  for (const pid of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      if (fs.readlinkSync(`/proc/${pid}/cwd`) !== s.sf || !read(`/proc/${pid}/comm`).startsWith('java')) continue;
      const st = read(`/proc/${pid}/stat`).split(') ')[1].split(' ');
      const ticks = Number(st[11]) + Number(st[12]), now = Date.now(), m = samples.get(pid);
      samples.set(pid, { ticks, now });
      const cpu = m ? Math.round((ticks - m.ticks) / ((now - m.now) / 1e3) / 100 * 1000) / 10 : null;   // 100 ticks/s
      return { pid: Number(pid), mb: Math.round(Number(read(`/proc/${pid}/statm`).split(' ')[1]) * 4096 / 1048576), cpu };
    } catch {}
  }
  return null;
}

// When lazymc will put it to sleep: sleep_after since it emptied (or woke up), never before minimum_online_time.
function tail(f, n = 262144) {
  try { const fd = fs.openSync(f, 'r'), t = fs.fstatSync(fd).size, b = Buffer.alloc(Math.min(n, t));
    fs.readSync(fd, b, 0, b.length, t - b.length); fs.closeSync(fd); return b.toString('utf8'); } catch { return ''; }
}
export function sleepsAt(s, players, now = Date.now(), lazymcLog = null, serverLog = null) {
  if (s.sleepAfter > 31536000) return { never: true };
  if (players > 0) return { afterEmpty: s.sleepAfter };
  const lz = lazymcLog ?? tail(path.join(process.env.HOME ?? '/', `.pm2/logs/mc-${s.name}-error.log`));
  const on = [...lz.matchAll(/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d).*Server is now online/gm)].pop()?.[1];
  const awake = on ? new Date(on.replace('T', ' ')).getTime() : now;
  const sv = serverLog ?? tail(path.join(s.sf, 'logs/latest.log'));
  const h = [...sv.matchAll(/^\[(\d\d):(\d\d):(\d\d)\].*left the game/gm)].pop();
  let left = 0;
  if (h) { const d = new Date(now); d.setHours(+h[1], +h[2], +h[3], 0); left = d.getTime(); if (left > now) left -= DAY; }
  return { at: Math.max(Math.max(left, awake) + s.sleepAfter * 1e3, awake + s.minimum * 1e3) };
}

// WardenPanel plugin: 127.0.0.1:<real port + 20000>, with the key it leaves in its folder.
async function plugin(s, route) {
  const key = (read(path.join(s.sf, 'plugins/WardenPanel/key')) || read(path.join(s.sf, 'plugins/WardenPanel/clave'))).trim();
  if (!key) return null;
  try {
    const r = await fetch(`http://127.0.0.1:${s.real + 20000}${route}`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(3000) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

// The MOTD in server.properties (Java properties format: \uXXXX, \n, \\…). It can carry § codes.
export function propertiesMotd(s, text = read(path.join(s.sf, 'server.properties'))) {
  const m = /^motd=(.*)$/m.exec(text); if (!m) return null;
  return m[1].replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\n/g, '\n').replace(/\\(.)/g, '$1');
}
// Colors and formats with & or § (stored as §; the lazymc fork understands a colored status). Two lines of 60 visible
// characters at most (codes don't count), no control characters.
const MC_CODE = /[&§]([0-9a-fk-or])/gi;
function cutVisible(line, n) {
  let out = '', vis = 0;
  for (let i = 0; i < line.length && vis < n; i++) {
    if (line[i] === '§' && i + 1 < line.length) { out += line[i] + line[++i]; continue; }
    out += line[i]; vis++;
  }
  return out;
}
export function motdText(t) {
  return String(t ?? '').replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '').replace(MC_CODE, (_, c) => '§' + c.toLowerCase())
    .replace(/§(?![0-9a-fk-or])/g, '').split('\n').slice(0, 2).map(l => cutVisible(l, 60).replace(/(§.)+$/, '')).join('\n').trim();
}
export function saveMotd(s, value) {
  const t = motdText(value), f = path.join(s.sf, 'server.properties');
  const prop = t.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[^\x20-\x7e]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  const txt = read(f);
  fs.writeFileSync(f, /^motd=.*$/m.test(txt) ? txt.replace(/^motd=.*$/m, () => `motd=${prop}`) : `${txt}motd=${prop}\n`);
  return t;
}
// Name → UUID of the official accounts (version 4 UUID) that have joined: the panel asks for faces by UUID, because
// mc-heads.net by name sometimes can't find the account and returns Steve. Offline accounts' UUIDs (version 3) are
// made up by the server: those go by name.
export function faces(s) {
  const r = {};
  for (const u of readJSONFile(path.join(s.sf, 'usercache.json'), [])) if (/^[0-9a-f]{8}-[0-9a-f]{4}-4/i.test(u?.uuid ?? '') && u.name) r[u.name.toLowerCase()] = u.uuid.replace(/-/g, '');
  return r;
}
async function status(s) {
  const up = await open(s.real);
  const e = { name: s.name, type: s.type, version: s.version, texturesVersion: s.version, public: s.public, map: s.map, plan: s.plan, webconsole: s.webconsole,
    icon: fs.existsSync(path.join(s.sf, 'server-icon.png')),
    state: up ? 'awake' : (await tmuxAlive(s)) ? 'starting' : 'asleep', players: [], max: null, process: up ? processOf(s) : null,
    motd: propertiesMotd(s), faces: faces(s) };
  if (up) {
    const p = s.type === 'paper' ? await plugin(s, '/status') : null;
    if (p) Object.assign(e, { plugin: true, version: p.version, tps: p.tps, mspt: p.mspt, max: p.max, motd: p.motd, memory: p.memory,
      worlds: p.worlds, startedAt: p.startedAt, players: p.players, defaultMode: p.defaultMode, rules: p.rules });
    else {
      const j = await ping(s.real, s.proxy);
      if (j) Object.assign(e, { plugin: false, version: j.version?.name ?? s.version, max: j.players?.max,
        players: (j.players?.sample ?? []).map(x => ({ name: x.name, uuid: x.id })), online: j.players?.online ?? 0 });
    }
  }
  e.online ??= e.players.length;
  e.sleeps = e.state === 'awake' ? sleepsAt(s, e.online) : null;
  return e;
}

// ─────────────────────── What happens: plugin (Paper) or log (Fabric) ───────────────────────

const events = new Map();                                     // server → { list (last 1000), id, pluginSince, logPos }
function eventsOf(n) {
  if (!events.has(n)) {
    const lines = tail(df(`events-${n}.jsonl`), 400000).split('\n').filter(Boolean).slice(-1000);
    const list = lines.flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
    events.set(n, { list, id: list.at(-1)?.id ?? 0, pluginSince: 0, logPos: null });
  }
  return events.get(n);
}
function addEvent(n, e) {
  const ev = eventsOf(n), o = { id: ++ev.id, t: e.t ?? Date.now(), type: e.type, player: e.player, text: e.text ?? null,
    ...(e.x != null ? { world: e.world, x: e.x, y: e.y, z: e.z } : {}) };
  ev.list.push(o); if (ev.list.length > 1000) ev.list.shift();
  fs.appendFileSync(df(`events-${n}.jsonl`), JSON.stringify(o) + '\n', { mode: 0o600 });
}
// Without the plugin: joins, leaves, chat and advancements from latest.log (deaths come in a thousand shapes: no).
export function eventsFromLog(text) {
  const r = [];
  for (const l of text.split('\n')) {
    const m = /^\[\d\d:\d\d:\d\d\] \[[^\]]+\]: (.*)$/.exec(l); if (!m) continue;
    let x;
    if ((x = /^([.\w]{1,17}) joined the game$/.exec(m[1]))) r.push({ type: 'join', player: x[1] });
    else if ((x = /^([.\w]{1,17}) left the game$/.exec(m[1]))) r.push({ type: 'leave', player: x[1] });
    else if ((x = /^<([.\w]{1,17})> (.*)$/.exec(m[1]))) r.push({ type: 'chat', player: x[1], text: x[2] });
    else if ((x = /^([.\w]{1,17}) has (?:made the advancement|completed the challenge|reached the goal) \[(.+)\]$/.exec(m[1]))) r.push({ type: 'advancement', player: x[1], text: x[2] });
  }
  return r;
}
// investigation-<server>.json: { stone: {player: n}, zones: {«world|cx|cz»: {player: [placed, broken]}},
// heat: {«world|cx|cz»: {player: 30 s samples}} }, accumulated since the plugin is there.
const investigation = new Map(), lastCollect = new Map();
function invData(n) {
  if (!investigation.has(n)) investigation.set(n, { stone: {}, zones: {}, heat: {}, ...(readJSON(`investigation-${n}.json`, {})) });
  return investigation.get(n);
}
async function collectInvestigation(s) {
  const now = Date.now(), u = lastCollect.get(s.name) ?? { counters: 0, heat: 0 }, d = invData(s.name);
  let changed = false;
  if (now - u.heat >= 30e3) {
    u.heat = now;
    const e = await plugin(s, '/status');
    for (const j of e?.players ?? []) {
      const k = `${j.world}|${Math.floor(j.x / 16)}|${Math.floor(j.z / 16)}`;
      (d.heat[k] ??= {})[j.name] = (d.heat[k][j.name] ?? 0) + 1; changed = true;
    }
  }
  if (now - u.counters >= 60e3) {
    u.counters = now;
    const c = await plugin(s, '/counters');
    for (const [j, n] of Object.entries(c?.stone ?? {})) { d.stone[j] = (d.stone[j] ?? 0) + n; changed = true; }
    for (const [k, js] of Object.entries(c?.zones ?? {})) for (const [j, [p, r]] of Object.entries(js)) {
      const v = ((d.zones[k] ??= {})[j] ??= [0, 0]); v[0] += p; v[1] += r; changed = true;
    }
  }
  lastCollect.set(s.name, u);
  if (changed) saveJSON(`investigation-${s.name}.json`, d);
}
// Every stored event of a server (for investigating, not only the last 1000).
const allEvents = n => tail(df(`events-${n}.jsonl`), 32e6).split('\n').filter(Boolean).flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });

async function collectEvents() {
  for (const s of servers()) {
    const ev = eventsOf(s.name);
    if (!(await open(s.real))) { ev.logPos = null; continue; }
    const p = s.type === 'paper' ? await plugin(s, `/events?since=${ev.pluginSince}`) : null;
    if (p) {
      await collectInvestigation(s);
      if (p.last < ev.pluginSince) { ev.pluginSince = 0; continue; }     // the plugin has restarted
      for (const e of p.events) addEvent(s.name, e);
      ev.pluginSince = p.last;
      continue;
    }
    const log = path.join(s.sf, 'logs/latest.log');
    let t; try { t = fs.statSync(log).size; } catch { continue; }
    if (ev.logPos === null || ev.logPos > t) { ev.logPos = t; continue; }  // at start or after rotation: from now on
    if (t === ev.logPos) continue;
    const fd = fs.openSync(log, 'r'), b = Buffer.alloc(Math.min(t - ev.logPos, 1 << 20));
    fs.readSync(fd, b, 0, b.length, ev.logPos); fs.closeSync(fd);
    const text = b.toString('utf8'), cut = text.lastIndexOf('\n') + 1;
    ev.logPos += Buffer.byteLength(text.slice(0, cut));
    for (const e of eventsFromLog(text.slice(0, cut))) addEvent(s.name, e);
  }
}

// ─────────────────────── Console and actions ───────────────────────

const clean = (t, n = 300) => String(t ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, n);
const noColors = t => t.replace(/\x1b\[[0-9;]*m/g, '');
function consoleLog(s, since) {
  const log = path.join(s.sf, 'logs/latest.log');
  let t; try { t = fs.statSync(log).size; } catch { return { end: 0, text: '' }; }
  const start = Number.isFinite(since) && since >= 0 && since <= t ? since : Math.max(0, t - 65536);
  if (start === t) return { end: t, text: '' };
  const fd = fs.openSync(log, 'r'), b = Buffer.alloc(Math.min(t - start, 1 << 20));
  fs.readSync(fd, b, 0, b.length, start); fs.closeSync(fd);
  let text = b.toString('utf8');
  if (start > 0 && !(since >= 0)) text = text.slice(text.indexOf('\n') + 1);   // the first time, from a whole line
  return { end: start + b.length, text: noColors(text) };
}
// One line to the Minecraft console (not a shell): literal and without control characters.
async function send(s, command) {
  const c = clean(command, 1000).replace(/^\/+/, '');
  if (!c) return { ok: false, error: T.badData };
  if (!(await tmuxAlive(s))) return { ok: false, error: T.asleep };
  const sock = tmuxSocket(s);
  const a = await run('tmux', ['-L', sock, 'send-keys', '-t', s.script, '-l', '--', c]);
  const b = a.ok && await run('tmux', ['-L', sock, 'send-keys', '-t', s.script, 'Enter']);
  return a.ok && b.ok ? { ok: true, command: c } : { ok: false, error: a.output || b.output };
}

const tellraw = (who, parts) => `tellraw ${who} ${JSON.stringify(parts)}`;
const MODES = ['survival', 'creative', 'adventure', 'spectator'];
const DIFFICULTIES = ['peaceful', 'easy', 'normal', 'hard'], TIMES = ['day', 'noon', 'night', 'midnight'], WEATHERS = ['clear', 'rain', 'thunder'];
const toYou = { en: 'you', es: 'ti' };
// Each action: the permission it needs and the commands it sends. a.player has already been checked.
export const ACTIONS = {
  rule:       { permission: 'world', noPlayer: true, commands: a => {
    if (!/^[a-z0-9_:]{1,64}$/.test(a.name ?? '') || !/^(true|false|-?\d{1,9})$/.test(String(a.value))) throw new Error(T.badData);
    return [`gamerule ${a.name} ${a.value}`];
  } },
  difficulty: { permission: 'world', noPlayer: true, commands: a => { if (!DIFFICULTIES.includes(a.value)) throw new Error(T.badData); return [`difficulty ${a.value}`]; } },
  time:       { permission: 'world', noPlayer: true, commands: a => { if (!TIMES.includes(a.value)) throw new Error(T.badData); return [`time set ${a.value}`]; } },
  weather:    { permission: 'world', noPlayer: true, commands: a => { if (!WEATHERS.includes(a.value)) throw new Error(T.badData); return [`weather ${a.value}`]; } },
  chat:       { permission: 'chat', noPlayer: true, commands: (a, u) => [tellraw('@a', [{ text: `[Panel · ${u}] `, color: 'light_purple' }, { text: clean(a.text), color: 'white' }])] },
  message:    { permission: 'moderate', commands: (a, u) => [tellraw(a.player, [{ text: `[Panel · ${u} → ${toYou[C.language] ?? 'you'}] `, color: 'light_purple' }, { text: clean(a.text), color: 'white' }])] },
  kick:       { permission: 'moderate', commands: a => [`kick ${a.player} ${clean(a.reason, 120)}`.trim()] },
  tp:         { permission: 'moderate', commands: a => [MC_NAME.test(a.target ?? '') ? `tp ${a.player} ${a.target}`
                : `tp ${a.player} ${[a.x, a.y, a.z].map(n => { if (!Number.isFinite(Number(n)) || n === '' || n === null) throw new Error(T.badData); return Math.round(Number(n)); }).join(' ')}`] },
  mode:       { permission: 'moderate', commands: a => { if (!MODES.includes(a.mode)) throw new Error(T.badData); return [`gamemode ${a.mode} ${a.player}`]; } },
  heal:       { permission: 'moderate', commands: a => [`effect give ${a.player} minecraft:instant_health 1 10 true`, `effect give ${a.player} minecraft:saturation 1 20 true`] },
  ban:        { permission: 'ban', commands: a => [`ban ${a.player} ${clean(a.reason, 120)}`.trim()] },
  unban:      { permission: 'ban', commands: a => [`pardon ${a.player}`] },
  give:       { permission: 'items', commands: a => {
    if (!/^[a-z0-9_.:-]{1,64}$/.test(a.item ?? '')) throw new Error(T.badData);
    const n = Math.min(6400, Math.max(1, Math.round(Number(a.amount) || 1)));
    return [`give ${a.player} ${a.item} ${n}`];
  } },
};

// The central whitelist for one server (the same as the Discord bot's /whitelist).
export function changeWhitelist(l, srv, name, add) {
  l.players ??= {};
  const k = name.toLowerCase(), j = l.players[k];
  if (add) {
    const n = l.players[k] ??= { name, servers: [] };
    if (!n.servers.includes('*') && !n.servers.includes(srv)) n.servers.push(srv);
    return true;
  }
  if (!j) return false;
  if (j.servers.includes('*')) j.servers = Object.keys(l.servers ?? {}).filter(x => l.servers[x] && x !== srv);
  else j.servers = j.servers.filter(x => x !== srv);
  if (!j.servers.length) delete l.players[k];
  return true;
}

function sleep(s) {
  // If lazymc started it, stop its wrapper (which runs ./script stop) and lazymc goes back to waiting; otherwise by hand.
  return run('pkill', ['-TERM', '-f', `lgsm.sh ${s.dir} `]).then(r => r.ok ? r
    : run(path.join(s.dir, s.script), ['stop'], { cwd: s.dir, env: { ...process.env, TMUX: '', TMUX_PANE: '' } }));
}
async function power(s, what) {
  if (what === 'wake') { wake({ internal: s.lazymc }, s.protocol, 'panel'); return { ok: true }; }
  if (what === 'sleep') return sleep(s);
  if (what === 'restart') {
    await sleep(s);
    for (let i = 0; i < 90 && await open(s.real); i++) await new Promise(r => setTimeout(r, 1000));
    await new Promise(r => setTimeout(r, 3000));
    wake({ internal: s.lazymc }, s.protocol, 'panel');
    return { ok: true };
  }
  return { ok: false, error: T.badData };
}

// Ops and bans, from the server's files: they show with it asleep too.
function lists(s, l = readWhitelist()) {
  const json = f => { try { return JSON.parse(read(path.join(s.sf, f))); } catch { return []; } };
  return {
    ops: json('ops.json').map(o => ({ name: o.name, level: o.level })),
    banned: json('banned-players.json').map(b => ({ name: b.name, reason: b.reason, since: b.created, by: b.source })),
    requiresList: Boolean(l.servers?.[s.name]),
    whitelist: Object.values(l.players ?? {}).filter(j => j.servers.includes('*') || j.servers.includes(s.name))
      .map(j => ({ name: j.name, all: j.servers.includes('*'), discord: Boolean(j.discord) })).sort((a, b) => a.name.localeCompare(b.name)),
  };
}

// ─────────────────────── Players ───────────────────────

// The in-game name of an item, block, mob or enchantment in the user's language («minecraft:diamond_sword» → «Diamond Sword»).
const gameName = (lang, id, kinds = ['item', 'block']) => { const [ns, n] = String(id).includes(':') ? String(id).split(':') : ['minecraft', id];
  for (const c of kinds) { const t = lang[`${c}.${ns}.${n}`]; if (t) return t; } return n?.replace(/_/g, ' '); };
const withNames = (lang, inv) => {
  if (!inv) return inv;
  for (const k of ['inventory', 'armor', 'offhand', 'ender']) for (const o of inv[k] ?? []) {
    o.gameName = gameName(lang, o.id);
    if (o.enchantments) o.enchantments = Object.fromEntries(Object.entries(o.enchantments).map(([e, n]) => [gameName(lang, e, ['enchantment']), n]));
  }
  return inv;
};

export const accountType = u => u.startsWith('00000000-0000-0000-0009-') ? 'bedrock' : u[14] === '4' ? 'official' : u[14] === '3' ? 'offline' : 'other';
// Countries each player has joined from (recorded by the gate: only the code, never the IP).
const countries = () => readJSONFile(file('countries.json'), {});
const countriesOf = (all, name) => Object.entries(all[(name ?? '').toLowerCase()]?.countries ?? {})
  .map(([country, v]) => ({ country, ...v })).sort((a, b) => b.last - a.last);
async function playerRows(s) {
  const geo = countries();
  const [plan, e, l] = [await P.planPlayers(s), await status(s), lists(s)];
  const online = new Set(e.players.map(j => j.name.toLowerCase())), ops = new Set(l.ops.map(o => o.name.toLowerCase()));
  const banned = new Set(l.banned.map(b => b.name.toLowerCase())), listed = new Set(l.whitelist.map(j => j.name.toLowerCase()));
  const r = new Map(P.known(s));
  for (const [uuid, p] of plan) if (!r.has(uuid) || !r.get(uuid).name) r.set(uuid, { uuid, name: p.name });
  const repeated = new Set([...r.values()].map(j => (j.name ?? '').toLowerCase()).filter((n, i, a) => n && a.indexOf(n) !== i));
  return [...r.values()].map(j => {
    const st = P.stats(s, j.uuid), p = plan.get(j.uuid), n = (j.name ?? '').toLowerCase();
    return { uuid: j.uuid, name: j.name ?? P.mojangName(DATA, j.uuid) ?? j.uuid.slice(0, 8), online: online.has(n), op: ops.has(n), banned: banned.has(n), listed: listed.has(n),
      played: Math.max(p?.played ? Math.round(p.played / 1e3) : 0, st?.played ?? 0), sessions: p?.sessions ?? null, first: p?.registered ?? null,
      last: online.has(n) ? Date.now() : p?.last ?? st?.saved ?? null, deaths: st?.deaths ?? 0, mobKills: st?.mobKills ?? 0,
      playerKills: st?.playerKills ?? 0, distance: st?.distance ?? 0, mined: st?.mined ?? 0, diamonds: st?.diamonds ?? 0,
      traded: st?.traded ?? 0, sinceDeath: st?.sinceDeath ?? 0, otherAccount: repeated.has(n) ? j.uuid.slice(0, 8) : null, account: accountType(j.uuid),
      countries: countriesOf(geo, j.name), advancements: P.advancements(s, j.uuid)?.done.length ?? 0 };
  });
}
// Each user's language (preferences; otherwise the browser's): for the game's names (items, advancements, rules).
const languageOf = u => readJSON('preferences.json', {})[u.name]?.language ?? null;
const gameLocale = (u, req) => (languageOf(u) ?? (/(^|,)\s*es\b/i.test(req.headers['accept-language'] ?? '') ? 'es' : 'en')) === 'es' ? 'es_es' : 'en_us';
async function profile(s, uuid, u, locale) {
  const lang = await P.gameLanguage(DATA, s.version, locale), list = await playerRows(s), base = list.find(j => j.uuid === uuid);
  if (!base) return null;
  const st = P.stats(s, uuid), sess = await P.planSessions(s, uuid);
  if (st) for (const k of ['topMined', 'topUsed']) for (const o of st[k]) o.name = gameName(lang, o.id);
  if (st) for (const k of ['topKilled', 'topKilledBy']) for (const o of st[k]) o.name = gameName(lang, o.id, ['entity']);
  const r = { ...base, stats: st, sessionList: sess, advancements: P.advancements(s, uuid, lang) };
  if (sess?.length) {
    const longest = sess.reduce((a, x) => (x.end - x.start > a.end - a.start ? x : a));
    r.longestSession = { duration: longest.end - longest.start, start: longest.start };
  }
  if (can(u, s.name, 'inventories')) {
    let inv = null;
    if (base.online && s.type === 'paper') inv = await plugin(s, `/inventory?uuid=${uuid}`);
    inv ??= P.inventory(s, uuid);
    r.inventory = withNames(lang, inv);
  }
  return r;
}

// ─────────────────────── HTTP ───────────────────────

const json = (res, code, o) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(o)); };
const body = req => new Promise((ok, fail) => {
  let b = ''; req.on('data', d => { b += d; if (b.length > 65536) { fail(new Error('too large')); req.destroy(); } });
  req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch (e) { fail(e); } });
});
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
const CSP = `default-src 'self'; img-src 'self' https://mc-heads.net https://flagcdn.com data:; style-src 'self' 'unsafe-inline'; frame-src ${C.domain ? `https://*.${C.domain}` : "'none'"}; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`;

// Owner sign-in through another site: it checks it's the owner and comes back with HMAC(sso.key, «subject|nonce|expiry»).
export const ssoSignature = (key, subject, n, e) => crypto.createHmac('sha256', key).update(`${subject}|${n}|${e}`).digest('base64url');
const userSummary = (n, u) => ({ name: n, minecraft: u.minecraft ?? null, permissions: u.permissions ?? {}, mustChange: Boolean(u.mustChange), created: u.created });

async function api(req, res, route, ip) {
  const u = session(req), method = req.method;
  if (method !== 'GET' && req.headers['x-warden'] !== '1') return json(res, 403, { error: 'missing x-warden' });   // CSRF

  if (route === '/api/login' && method === 'POST') {
    const { user = '', password = '' } = await body(req);
    const name = String(user).trim();
    if (braked(ip) || braked(`u:${name.toLowerCase()}`)) return json(res, 429, { error: T.blocked });
    const x = users()[name];
    if (!x || !crypto.timingSafeEqual(Buffer.from(hashPassword(String(password), x.salt), 'hex'), Buffer.from(x.hash, 'hex'))) {
      const a = failure(ip), b = failure(`u:${name.toLowerCase()}`);
      if (a || b) record({ name: name || '?' }, null, 'failures', L('failedFor', name, ip), ip);
      return json(res, 401, { error: T.wrong });
    }
    failures.delete(ip); failures.delete(`u:${name.toLowerCase()}`);
    newSession(res, name, false, ip);
    record({ name }, null, 'login', null, ip);
    return json(res, 200, { ok: true, mustChange: Boolean(x.mustChange) });
  }
  if (route === '/api/logout' && method === 'POST') {
    if (u) { delete sessions[u.id]; saveJSON('sessions.json', sessions); }
    res.setHeader('set-cookie', 'warden=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0');
    return json(res, 200, { ok: true });
  }
  if (route === '/api/config') return json(res, 200, { sso: C.panel.sso?.url ? C.panel.sso.label ?? 'SSO' : null, owner: OWNER, domain: C.domain, rootServer: C.rootServer });
  if (!u) return json(res, 401, { error: T.noSession });

  if (route === '/api/me') return json(res, 200, { name: u.name, owner: Boolean(u.owner), mustChange: Boolean(u.mustChange), minecraft: u.minecraft ?? null, language: languageOf(u) });
  // Each user's preferences (tab order, language…), in panel/preferences.json.
  if (route === '/api/preferences') {
    const all = readJSON('preferences.json', {});
    if (method === 'PUT') {
      const b = await body(req), p = all[u.name] ?? {};
      if (Array.isArray(b.tabs)) p.tabs = b.tabs.filter(x => /^[a-z]{1,20}$/.test(x)).slice(0, 20);
      if (b.tabs === null) delete p.tabs;
      if (typeof b.language === 'string' && ['es', 'en'].includes(b.language)) p.language = b.language;
      all[u.name] = p; saveJSON('preferences.json', all);
    }
    return json(res, 200, all[u.name] ?? {});
  }
  if (route === '/api/password' && method === 'POST') {
    if (u.owner) return json(res, 400, { error: T.badData });
    const { current = '', next = '' } = await body(req), us = users(), x = us[u.name];
    if (hashPassword(String(current), x.salt) !== x.hash) return json(res, 401, { error: T.wrong });
    if (String(next).length < 10) return json(res, 400, { error: T.shortPassword });
    x.salt = crypto.randomBytes(16).toString('hex'); x.hash = hashPassword(String(next), x.salt); x.mustChange = false;
    saveJSON('users.json', us);
    record(u, null, 'password-changed', null, ip);
    return json(res, 200, { ok: true });
  }
  if (u.mustChange) return json(res, 403, { error: 'Change your password first.', mustChange: true });

  // ── Servers ──
  if (route === '/api/servers') {
    const r = [];
    for (const s of servers()) {
      const p = permissionsOf(u, s.name);
      if (!p.includes('view')) continue;
      r.push({ ...(await status(s)), permissions: p });
    }
    return json(res, 200, r);
  }
  const mt = /^\/api\/texture\/([\d.]+)\/([a-z0-9_:]+)$/.exec(route);   // an item's image (game textures)
  if (mt) {
    const d = await P.textures(DATA, mt[1]), f = d && P.texture(d, mt[2]);
    if (!f) { res.writeHead(404, { 'cache-control': 'private, max-age=86400' }); return res.end(); }
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'private, max-age=604800' });
    return fs.createReadStream(f).pipe(res);
  }
  const m = /^\/api\/server\/([a-z0-9]+)(?:\/(\w+)(?:\/([0-9a-f-]{36}))?)?$/.exec(route);
  if (m) {
    const s = server(m[1]);
    if (!s || !can(u, s.name, 'view')) return json(res, 404, { error: T.notFound });
    const what = m[2] ?? '';
    const q = new URL(req.url, 'http://x').searchParams;
    if (!what && method === 'GET') return json(res, 200, { ...(await status(s)), ...lists(s), permissions: permissionsOf(u, s.name) });
    if (what === 'investigation') {
      if (!can(u, s.name, 'investigate')) return json(res, 403, { error: T.noPermission });
      const reviewed = new Set(readJSON(`reviewed-${s.name}.json`, []));
      if (method === 'POST') {
        const { review, unreview } = await body(req);
        if (review) reviewed.add(String(review).slice(0, 300)); if (unreview) reviewed.delete(String(unreview));
        saveJSON(`reviewed-${s.name}.json`, [...reviewed]);
        record(u, s.name, 'reviewed', review ?? unreview, ip);
        return json(res, 200, { ok: true });
      }
      const d = invData(s.name), ev = allEvents(s.name), rows = await playerRows(s);
      const st = Object.fromEntries(rows.map(j => [j.name, P.stats(s, j.uuid)]).filter(([, x]) => x?.diamonds || x?.debris));
      const ms = I.miners(ev, d.stone, st);
      const al = I.alerts({ events: ev, zones: d.zones, heat: d.heat, miners: ms, countries: Object.fromEntries(rows.map(j => [j.name, j.countries])) }).map(a => ({ ...a, reviewed: reviewed.has(a.id) }));
      return json(res, 200, { alerts: al, miners: ms.slice(0, 50), bases: I.bases(d.zones), commands: ev.filter(e => e.type === 'command').slice(-200).reverse(),
        since: ev.find(e => e.x != null)?.t ?? null });
    }
    if (what === 'relations') {
      const plan = P.planDB(s) ? await P.planAllSessions(s) : null;
      return json(res, 200, { ...I.relations(plan ?? I.sessionsFromEvents(allEvents(s.name))), source: plan ? 'plan' : 'panel' });
    }
    if (what === 'heat') {
      const d = invData(s.name), ev = allEvents(s.name), ws = I.worlds(d.heat, ev), world = q.get('world') ?? ws[0] ?? 'world';
      return json(res, 200, { worlds: ws, world, cells: I.heatOf(d.heat, world), bases: I.bases(d.zones).filter(b => b.world === world),
        deaths: ev.filter(e => e.type === 'death' && e.world === world).slice(-300), map: s.map });
    }
    if (what === 'world') {                                   // rules (with their name in the user's language), difficulty, time, weather
      const e = await status(s), lang = await P.gameLanguage(DATA, s.version, gameLocale(u, req));
      const camel = n => n.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      const t = (n, suf = '') => lang[`gamerule.minecraft.${n}${suf}`] ?? lang[`gamerule.${camel(n)}${suf}`] ?? null;
      return json(res, 200, { state: e.state, plugin: Boolean(e.plugin), worlds: e.worlds ?? [], motd: propertiesMotd(s),
        rules: (e.rules ?? []).map(r => ({ ...r, title: t(r.name) ?? r.name.replace(/_/g, ' '), description: t(r.name, '.description') ?? '' }))
          .sort((a2, b) => a2.title.localeCompare(b.title)) });
    }
    if (what === 'players') return json(res, 200, await playerRows(s));
    if (what === 'leaderboard') return json(res, 200, P.rank((await playerRows(s)).filter(j => j.played > 0)));
    if (what === 'charts') return json(res, 200, await P.planCharts(s, Math.min(90, Math.max(1, Number(q.get('days')) || 7))));
    if (what === 'player' && m[3]) { const p = await profile(s, m[3], u, gameLocale(u, req)); return p ? json(res, 200, p) : json(res, 404, { error: T.notFound }); }
    if (what === 'icon') {                                    // the server's server-icon.png
      const f = path.join(s.sf, 'server-icon.png');
      if (!fs.existsSync(f)) return json(res, 404, { error: T.notFound });
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'private, max-age=3600' });
      return fs.createReadStream(f).pipe(res);
    }
    if (what === 'events') { const d = Number(q.get('since') ?? 0); return json(res, 200, eventsOf(s.name).list.filter(e => e.id > d).slice(-500)); }
    if (what === 'console') {
      if (!can(u, s.name, 'console')) return json(res, 403, { error: T.noPermission });
      if (method === 'GET') return json(res, 200, consoleLog(s, q.has('since') ? Number(q.get('since')) : NaN));
      const { command } = await body(req), r = await send(s, command);
      if (r.ok) record(u, s.name, 'console', r.command, ip);
      return json(res, r.ok ? 200 : 409, r);
    }
    if (what === 'action' && method === 'POST') {
      const a = await body(req), type = String(a.type ?? '');
      if (['wake', 'sleep', 'restart'].includes(type)) {
        if (!can(u, s.name, 'power')) return json(res, 403, { error: T.noPermission });
        record(u, s.name, type, null, ip);
        const r = await power(s, type);
        return json(res, 200, { ok: true, ...r });
      }
      if (type === 'motd') {                                    // in server.properties: applies on restart
        if (!can(u, s.name, 'world')) return json(res, 403, { error: T.noPermission });
        const saved = saveMotd(s, a.value);
        record(u, s.name, 'motd', saved, ip);
        return json(res, 200, { ok: true, motd: saved });
      }
      if (type === 'whitelist-add' || type === 'whitelist-remove') {
        if (!can(u, s.name, 'whitelist')) return json(res, 403, { error: T.noPermission });
        if (!MC_NAME.test(a.player ?? '')) return json(res, 400, { error: T.badName });
        const l = readWhitelist(); changeWhitelist(l, s.name, a.player, type === 'whitelist-add'); saveWhitelist(l);
        record(u, s.name, type, a.player, ip);
        return json(res, 200, { ok: true, ...lists(s, l) });
      }
      const ac = ACTIONS[type];
      if (!ac) return json(res, 400, { error: T.badData });
      if (!can(u, s.name, ac.permission)) return json(res, 403, { error: T.noPermission });
      if (!ac.noPlayer && !MC_NAME.test(a.player ?? '')) return json(res, 400, { error: T.badName });
      let cmds; try { cmds = ac.commands(a, u.minecraft ?? u.name); } catch (e) { return json(res, 400, { error: e.message }); }
      for (const c of cmds) { const r = await send(s, c); if (!r.ok) return json(res, 409, r); }
      record(u, s.name, type, [a.player, a.text ?? a.reason ?? a.item ?? a.target ?? a.mode, a.name, a.value].filter(x => x != null && x !== '').join(' · '), ip);
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: T.notFound });
  }

  // ── Owner only: users, log and settings ──
  if (!u.owner) return json(res, 403, { error: T.noPermission });
  if (route === '/api/users' && method === 'GET')
    return json(res, 200, { users: Object.entries(users()).map(([n, x]) => userSummary(n, x)), profiles: PROFILES, permissions: PERMISSIONS, servers: servers().map(s => s.name) });
  const mu = /^\/api\/users\/([\w.-]{1,32})(?:\/(password))?$/.exec(route);
  if (mu) {
    const us = users(), n = mu[1];
    if (method === 'PUT' && !mu[2]) {                         // create, or change permissions / Minecraft name
      const b = await body(req), isNew = !us[n];
      const perms = Object.fromEntries(Object.entries(b.permissions ?? {}).map(([k, v]) => [k, (v ?? []).filter(p => PERMISSIONS.includes(p))]).filter(([, v]) => v.length));
      if (b.minecraft && !MC_NAME.test(b.minecraft)) return json(res, 400, { error: T.badName });
      let pw = null;
      if (isNew) { pw = randomPassword(); const salt = crypto.randomBytes(16).toString('hex'); us[n] = { salt, hash: hashPassword(pw, salt), mustChange: true, created: Date.now() }; }
      us[n].permissions = perms; us[n].minecraft = b.minecraft || null;
      saveJSON('users.json', us);
      record(u, null, isNew ? 'user-created' : 'user-permissions', `${n} ${JSON.stringify(perms)}`, ip);
      return json(res, 200, { ok: true, password: pw, user: userSummary(n, us[n]) });
    }
    if (!us[n]) return json(res, 404, { error: T.notFound });
    if (method === 'POST' && mu[2] === 'password') {          // a new temporary password (the owner sees it once)
      const pw = randomPassword(); us[n].salt = crypto.randomBytes(16).toString('hex'); us[n].hash = hashPassword(pw, us[n].salt); us[n].mustChange = true;
      saveJSON('users.json', us); closeSessions(n);
      record(u, null, 'user-password', n, ip);
      return json(res, 200, { ok: true, password: pw });
    }
    if (method === 'DELETE') { delete us[n]; saveJSON('users.json', us); closeSessions(n); record(u, null, 'user-removed', n, ip); return json(res, 200, { ok: true }); }
  }
  if (route === '/api/log') {
    const l = tail(df('log.jsonl'), 2e6).split('\n').filter(Boolean).slice(-2000).flatMap(x => { try { return [JSON.parse(x)]; } catch { return []; } });
    return json(res, 200, l.reverse());
  }
  if (route === '/api/settings') {
    if (method === 'PUT') {
      const b = await body(req), a = readJSON('settings.json', {});
      a.notices = Object.fromEntries(Object.entries(b.notices ?? {}).filter(([, v]) => ['now', 'summary', 'off'].includes(v)));
      saveJSON('settings.json', a); record(u, null, 'settings', JSON.stringify(a.notices), ip);
    }
    return json(res, 200, settings());
  }
  return json(res, 404, { error: T.notFound });
}

async function handle(req, res) {
  // Behind the reverse proxy: the real IP comes in X-Forwarded-For (only trusted from loopback).
  const ip = req.socket.remoteAddress === '127.0.0.1' ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || '127.0.0.1' : req.socket.remoteAddress;
  const url = new URL(req.url, 'http://x'), route = url.pathname;
  res.setHeader('content-security-policy', CSP); res.setHeader('x-content-type-options', 'nosniff'); res.setHeader('referrer-policy', 'same-origin');
  try {
    if (route.startsWith('/api/')) return await api(req, res, route, ip);
    const sso = C.panel.sso;
    if (route === '/login/sso' && sso?.url) {
      const n = crypto.randomBytes(18).toString('base64url');
      res.writeHead(302, { location: `${sso.url}?n=${n}`, 'set-cookie': `warden_sso=${n}; HttpOnly; Secure; SameSite=Lax; Path=/login; Max-Age=600` });
      return res.end();
    }
    if (route === '/login/sso/return' && sso?.url) {
      const n = url.searchParams.get('n') ?? '', e = Number(url.searchParams.get('e')), f = url.searchParams.get('f') ?? '';
      const cookie = /(?:^|;\s*)warden_sso=([\w-]+)/.exec(req.headers.cookie ?? '')?.[1];
      const good = cookie && cookie === n && e > Date.now() && e < Date.now() + 120e3 && f.length === 43
        && crypto.timingSafeEqual(Buffer.from(f), Buffer.from(ssoSignature(secret('sso.key'), sso.subject ?? 'owner', n, e)));
      if (!good) { res.writeHead(302, { location: '/#bad' }); return res.end(); }
      newSession(res, OWNER, true, ip);
      res.writeHead(302, { location: '/', 'set-cookie': ['warden_sso=; Path=/login; Max-Age=0', res.getHeader('set-cookie')] });
      return res.end();
    }
    const f = path.join(PUBLIC, route === '/' ? 'index.html' : path.basename(route));
    if (!f.startsWith(PUBLIC) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    fs.createReadStream(f).pipe(res);
  } catch (e) {
    console.log(`${req.method} ${route}: ${e.stack}`);
    if (!res.headersSent) json(res, 500, { error: 'Something went wrong.' });
  }
}

if ([process.argv[1], process.env.pm_exec_path].includes(fileURLToPath(import.meta.url))) {
  if (C.panel.sso?.url) secret('sso.key');
  http.createServer(handle).listen(C.panel.port, '127.0.0.1', () => console.log(`WardenPanel on 127.0.0.1:${C.panel.port}`));
  let collecting = false;
  setInterval(async () => { if (collecting) return; collecting = true; try { await collectEvents(); } catch (e) { console.log(e.stack); } finally { collecting = false; } }, 2000);
}
