// WardenGate: the Java front door of every server.
// · On the main port (25565) it reads the address the player typed (it's in the first packet) and hands the
//   connection to that server's lazymc: <name>.<domain> → mc-<name>; the bare domain → rootServer.
//   Anything else (scanners connecting by IP, made-up names) is closed without an answer.
// · On each server's own public port, the same but by port: lazymc listens only on loopback, on that port +
//   lazymcOffset, so nobody can get around what follows.
// · On joining, it checks the player's name: names in bots.txt are cut (they don't even wake the server), and on
//   servers that require the central whitelist, whoever isn't on it gets a code for the Discord bot. The bot
//   answers /verify over HTTP interactions, right here: no libraries and no permanent connection.
// · It passes the player's real IP to lazymc in a PROXY v2 header (lazymc fork with receive_proxy_v2).
// · Bedrock (NetherNet): while a server sleeps, it serves its Geyser's TCP signaling port; when a Bedrock client
//   asks for that server (TLS SNI), it wakes it through lazymc and frees the port for Geyser.
//   node gate.mjs          node gate.test.mjs
import net from 'node:net';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config, file, notifyOwner, readEnv, writeJSON, translator } from '../lib/config.mjs';
import { openMMDB, countryOf } from './geo.mjs';

const C = config();
const WHITELIST = file('whitelist.json'), COUNTRIES = file('countries.json'), BOTS = file('bots.txt');
const CODE_VALID = C.gate.codeMinutes * 60e3;

const msg = translator({
  en: {
    notListed: 'You are not on the whitelist of {}.\n\n', yourCode: 'Your code: ', onDiscord: '\n\nOn Discord, tell the bot:\n',
    verifyCmd: '/verify {}', validFor: '\n(valid for {} minutes)', notInDiscord: '\n\nIf you are not on that Discord server, ask the server admin to add you.',
    bedrockWaking: '⏳ Waking up: join in a minute', bedrockSleeping: '💤 Sleeping · join to wake it up',
    joinedList: '🧱 <b>{}</b> joins the whitelist of {} (verified on Discord)',
  },
  es: {
    notListed: 'No estás en la lista blanca de {}.\n\n', yourCode: 'Tu código: ', onDiscord: '\n\nEn el Discord, escríbele al bot:\n',
    verifyCmd: '/verificar {}', validFor: '\n(vale {} minutos)', notInDiscord: '\n\nSi no estás en ese Discord, pide al administrador del servidor que te añada.',
    bedrockWaking: '⏳ Despertándose: entra en un minuto', bedrockSleeping: '💤 Durmiendo · entra y se despierta',
    joinedList: '🧱 <b>{}</b> entra en la lista blanca de {} (verificado por Discord)',
  },
});

// ─────────────────────── Players' countries ───────────────────────

// Only the country (never the IP), per player: { «lowercase name»: { name, countries: { ES: { first, last, count } } } }.
// The database is the GeoLite2 that Plan downloads (the first one found); it's looked up again daily.
let geo = null, geoRead = 0;
function geoDatabase() {
  if (Date.now() - geoRead < 864e5) return geo;
  geoRead = Date.now(); geo = null;
  for (const d of serverFolders()) {
    const f = path.join(C.serversDir, d, 'serverfiles/plugins/Plan/GeoLite2-Country.mmdb');
    if (fs.existsSync(f)) { try { geo = openMMDB(f); break; } catch (e) { console.log(`GeoLite2 (${d}): ${e.message}`); } }
  }
  return geo;
}
export function recordCountry(player, country, t = Date.now(), f = COUNTRIES) {
  if (!country) return;
  let l = {}; try { l = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
  const j = l[player.toLowerCase()] ??= { name: player, countries: {} };
  const p = j.countries[country] ??= { first: t, count: 0 };
  p.last = t; p.count++; j.name = player;
  writeJSON(f, l);
}

// ─────────────────────── Servers, bots and whitelist ───────────────────────

const serverFolders = (dir = C.serversDir) => { try { return fs.readdirSync(dir).filter(d => d.startsWith('mc-')); } catch { return []; } };

// name → { internal: lazymc's port, public: the port the gate serves (null if lazymc still listens publicly) }
export function readRoutes(dir = C.serversDir, offset = C.gate.lazymcOffset) {
  const r = new Map();
  for (const d of serverFolders(dir)) {
    try {
      const toml = fs.readFileSync(path.join(dir, d, 'lazymc.toml'), 'utf8');
      const m = /\[public\][^[]*?address\s*=\s*"([^"]*):(\d+)"/.exec(toml);
      if (m) r.set(d.slice(3), { internal: Number(m[2]), public: m[1] === '127.0.0.1' ? Number(m[2]) - offset : null });
    } catch {}
  }
  return r;
}

// bots.txt: one name per line (case-insensitive), «/regex/» for patterns, «#» comments.
export function readBots(f = BOTS) {
  let text = '';
  try { text = fs.readFileSync(f, 'utf8'); } catch {}
  return text.split('\n').map(l => l.replace(/#.*/, '').trim()).filter(Boolean).flatMap(l => {
    if (!/^\/.+\/$/.test(l)) return [new RegExp(`^${l.replace(/[^A-Za-z0-9_]/g, '\\$&')}$`, 'i')];
    try { return [new RegExp(l.slice(1, -1))]; } catch { console.log(`bots.txt: invalid pattern, ignored: ${l}`); return []; }
  });
}
export const isBot = (player, list) => list.some(r => r.test(player));

// whitelist.json: { servers: { lobby: true, … } (those that require it), players: { «lowercase name»:
// { name, servers: ["lobby"] or ["*"], discord } } }. The WardenList plugin reads it too (for Bedrock).
let whitelist = { servers: {}, players: {} }, whitelistRead = 0;
export function readWhitelist(f = WHITELIST) {
  try {
    const t = fs.statSync(f).mtimeMs;
    if (t !== whitelistRead) { whitelist = JSON.parse(fs.readFileSync(f, 'utf8')); whitelistRead = t; }
  } catch (e) { if (e.code !== 'ENOENT') console.log(`whitelist.json can't be read: ${e.message}`); }
  return whitelist;
}
export const saveWhitelist = (l, f = WHITELIST) => writeJSON(f, l);
export function allowed(l, player, server) {
  if (!l.servers?.[server]) return true;                // that server doesn't require the list
  const j = l.players?.[player.toLowerCase()];
  return Boolean(j) && (j.servers.includes('*') || j.servers.includes(server));
}

// Codes for the Discord bot: one per player and server, 6 digits, valid for codeMinutes. In memory only.
const pending = new Map();
export function codeFor(player, server, now = Date.now()) {
  for (const [k, p] of pending) if (now - p.t > CODE_VALID) pending.delete(k);
  for (const [k, p] of pending) if (p.player === player && p.server === server) return k;
  let k;
  do k = String(crypto.randomInt(100000, 1000000)); while (pending.has(k));
  pending.set(k, { player, server, t: now });
  return k;
}

// ─────────────────────── Protocol ───────────────────────

function varint(b, i) {
  let n = 0;
  for (let s = 0; s < 35; s += 7) {
    if (i >= b.length) return null;
    const x = b[i++]; n |= (x & 0x7f) << s;
    if (!(x & 0x80)) return [n >>> 0, i];
  }
  throw new Error('varint too long');
}
const toVarint = n => { const b = []; n >>>= 0; do { let x = n & 0x7f; n >>>= 7; if (n) x |= 0x80; b.push(x); } while (n); return Buffer.from(b); };
function packet(b, i, max) {
  const l = varint(b, i); if (!l) return null;
  if (l[0] > max) throw new Error('packet too long');
  if (b.length < l[1] + l[0]) return null;
  const [id, j] = varint(b, l[1]);
  return { id, j, end: l[1] + l[0] };
}
const string = (b, i) => { const [len, j] = varint(b, i); if (len > 1024) throw new Error('string too long');
                           return [b.subarray(j, j + len).toString('utf8'), j + len]; };
// The handshake: protocol, server address, port, next state (1 status, 2 login, 3 transfer).
// For logins, «Login Start» follows, starting with the player's name.
export function handshake(b) {
  if (b[0] === 0xfe) throw new Error('legacy ping (1.6 or older)');
  const p = packet(b, 0, 1100); if (!p) return null;
  if (p.id !== 0) throw new Error('not a handshake');
  const [, i] = varint(b, p.j);                // protocol
  const [address, j] = string(b, i);
  const [state] = varint(b, j + 2);
  if (state === 1) return { address, state };
  const q = packet(b.subarray(p.end), 0, 1100); if (!q) return null;
  const [player] = string(b.subarray(p.end), q.j);
  return { address, state, player };
}
// Forge appends «\0FML3\0» to the address, and some people type the trailing dot or capitals.
export function serverFor(address, domain = C.domain, root = C.rootServer) {
  const n = address.split('\0')[0].replace(/\.$/, '').toLowerCase();
  if (!domain) return null;
  if (n === domain) return root;
  return n.endsWith('.' + domain) ? n.slice(0, -domain.length - 1) : null;
}
// Login «Disconnect»: the text is JSON in every version.
export function disconnect(parts) {
  const j = Buffer.from(JSON.stringify({ text: '', extra: parts }), 'utf8');
  const c = Buffer.concat([toVarint(0), toVarint(j.length), j]);
  return Buffer.concat([toVarint(c.length), c]);
}
export function notListedMessage(server, code, lang = C.language) {
  return disconnect([
    { text: msg(lang, 'notListed', server), color: 'yellow' },
    { text: msg(lang, 'yourCode'), color: 'gray' }, { text: code, color: 'aqua', bold: true },
    { text: msg(lang, 'onDiscord'), color: 'gray' }, { text: msg(lang, 'verifyCmd', code), color: 'white' },
    { text: msg(lang, 'validFor', C.gate.codeMinutes), color: 'dark_gray' },
    { text: msg(lang, 'notInDiscord'), color: 'gray' }]);
}

// ─────────────────────── Connections ───────────────────────

let routes = new Map(), bots = [], read = 0;
function refresh() {
  if (Date.now() - read < 60e3) return;
  routes = readRoutes(); bots = readBots(); read = Date.now();
  openPorts();
}

function serve(c, fixed) {
  let buf = Buffer.alloc(0);
  c.setTimeout(5000, () => c.destroy());      // no handshake in 5 s: out
  c.on('error', () => {});
  c.on('data', function onData(d) {
    buf = Buffer.concat([buf, d]);
    let h;
    try { h = handshake(buf); } catch { return c.destroy(); }
    if (!h) return buf.length > 2400 && c.destroy();
    c.off('data', onData); c.pause(); c.setTimeout(0);
    refresh();
    const name = fixed ?? serverFor(h.address), r = name && routes.get(name);
    if (!r) return c.destroy();
    const ip = c.remoteAddress;
    if (h.player !== undefined) {
      if (isBot(h.player, bots)) { console.log(`bot ${h.player} cut (${name}, from ${ip})`); return c.destroy(); }
      if (!allowed(readWhitelist(), h.player, name)) {
        const k = codeFor(h.player, name);
        console.log(`${h.player} is not on the whitelist of ${name}: code ${k} (from ${ip})`);
        return c.end(notListedMessage(name, k));
      }
      console.log(`${h.player} joins ${name} from ${ip}`);
      try { recordCountry(h.player, countryOf(geoDatabase(), ip)); } catch (e) { console.log(`country: ${e.message}`); }
    }
    // lazymc (fork, `receive_proxy_v2`) gets the real IP in a PROXY v2 header and passes it on to the server.
    const s2 = net.connect(r.internal, '127.0.0.1', () => {
      s2.write(Buffer.concat([proxyHeader(c.remoteAddress, c.remotePort, c.localAddress, c.localPort), buf]));
      c.pipe(s2); s2.pipe(c); c.resume();
    });
    s2.setNoDelay(true); c.setNoDelay(true);
    s2.on('error', () => c.destroy()); c.on('close', () => s2.destroy()); s2.on('close', () => c.destroy());
  });
}

// ─────────────────────── PROXY v2 header (the player's real IP) ───────────────────────

// Tells the next hop (lazymc → server) who the player really is. HAProxy's binary format: signature,
// version 2 + PROXY, family TCP4/TCP6, length and the addresses. If the families differ, everything goes as IPv6.
const PROXY_SIGNATURE = Buffer.from('0d0a0d0a000d0a515549540a', 'hex');
// Without addresses (LOCAL): for connections made from this machine, like the panel's ping.
export const LOCAL_HEADER = Buffer.concat([PROXY_SIGNATURE, Buffer.from([0x20, 0x00, 0, 0])]);
const ipv4 = ip => ip.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');
function ipv6Bytes(ip) {
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip);
  if (v4) ip = ip.slice(0, v4.index) + [[1, 2], [3, 4]].map(([a, b]) => ((v4[a] << 8) | v4[b]).toString(16)).join(':');
  const [head, tail = null] = ip.split('::'), a = head ? head.split(':') : [], b = tail === null ? [] : tail ? tail.split(':') : [];
  const groups = [...a, ...Array(8 - a.length - b.length).fill('0'), ...b];
  return Buffer.from(groups.flatMap(g => { const n = parseInt(g, 16); return [n >> 8, n & 255]; }));
}
export function proxyHeader(srcIp, srcPort, dstIp, dstPort) {
  const o = ipv4(srcIp), d = ipv4(dstIp), four = net.isIPv4(o) && net.isIPv4(d);
  const ip = x => four ? Buffer.from(x.split('.').map(Number)) : ipv6Bytes(net.isIPv4(x) ? `::ffff:${x}` : x);
  const ports = Buffer.alloc(4); ports.writeUInt16BE(srcPort, 0); ports.writeUInt16BE(dstPort, 2);
  const addrs = Buffer.concat([ip(o), ip(d), ports]), len = Buffer.alloc(2); len.writeUInt16BE(addrs.length);
  return Buffer.concat([PROXY_SIGNATURE, Buffer.from([0x21, four ? 0x11 : 0x21]), len, addrs]);
}

// ─────────────────────── Bedrock waker (NetherNet) ───────────────────────

// Geyser with NetherNet and its own signaling: Bedrock first opens a TLS (TCP) connection to that port, asking for
// the server by name. While the server is up the port belongs to Geyser; asleep, nobody serves it and lazymc only
// speaks Java. So while it sleeps, this serves it: it can't answer like Geyser (that would mean speaking all of
// NetherNet), but it wakes the server and the player gets in on retrying.
export function bedrockPort(serverDir) {
  let y;
  try { y = fs.readFileSync(path.join(serverDir, 'serverfiles/plugins/Geyser-Spigot/config.yml'), 'utf8'); } catch { return null; }
  const transport = /^\s*transport:\s*(\w+)/m.exec(y)?.[1], mode = /^\s*signaling:\s*\n(?:\s*#.*\n)*\s*mode:\s*(\w+)/m.exec(y)?.[1];
  const port = /^bedrock:[\s\S]*?^\s+port:\s*(\d+)/m.exec(y)?.[1];
  if (!port || !['nethernet', 'both'].includes(transport) || !['builtin', 'hybrid'].includes(mode)) return null;
  return Number(port);
}
// Name asked for in the TLS «ClientHello» (SNI). null if it hasn't fully arrived yet; '' if there is none.
export function sni(b) {
  if (b.length < 5) return null;
  if (b[0] !== 0x16) throw new Error('not TLS');
  const end = 5 + b.readUInt16BE(3);
  if (end > 16389) throw new Error('too long');
  if (b.length < end || b[5] !== 1) return b.length < end ? null : '';
  let i = 5 + 4 + 2 + 32;                                    // header, version and random
  i += 1 + b[i]; i += 2 + b.readUInt16BE(i); i += 1 + b[i];   // session, ciphers, compression
  const extEnd = i + 2 + b.readUInt16BE(i); i += 2;
  while (i + 4 <= extEnd) {
    const type = b.readUInt16BE(i), len = b.readUInt16BE(i + 2);
    if (type === 0) return b.subarray(i + 9, i + 9 + b.readUInt16BE(i + 7)).toString('latin1').toLowerCase();
    i += 4 + len;
  }
  return '';
}
// As if a Java player were joining (named «bedrock» by default): lazymc starts the server. The panel uses it too.
export function wake(r, proto, who = 'bedrock') {
  const str = t => { const x = Buffer.from(t); return Buffer.concat([toVarint(x.length), x]); };
  const frame = c => Buffer.concat([toVarint(c.length), c]);
  const s = net.connect(r.internal, '127.0.0.1', () => s.end(Buffer.concat([
    frame(Buffer.concat([toVarint(0), toVarint(proto), str('127.0.0.1'), Buffer.from([r.internal >> 8, r.internal & 255]), toVarint(2)])),
    frame(Buffer.concat([toVarint(0), str(who), Buffer.alloc(16)]))])));
  s.on('error', () => {}); s.setTimeout(30e3, () => s.destroy());
}
const javaUp = port => new Promise(ok => {                  // is the real server listening?
  const s = net.connect(port, '127.0.0.1', () => { s.destroy(); ok(true); });
  s.on('error', () => ok(false)); s.setTimeout(1500, () => { s.destroy(); ok(false); });
});

// What the waker answers over HTTPS, like Geyser's signaling: GET /v1/join is the server list query (a JSON with
// the MOTD; its own version and protocol are echoed back so it doesn't show «incompatible») and POST /v1/join/<id>
// is joining, which wakes the server and is refused (the client retries).
export function bedrockReply(method, route, query, state, lang = C.language) {
  if (route === '/v1/join') {
    if (method !== 'GET') return { status: 405 };
    return { status: 200, json: { dataVersion: 7, name: msg(lang, state.waking ? 'bedrockWaking' : 'bedrockSleeping'),
      protocol: Number(query.get('protocol')) || 0, version: query.get('version') ?? '', level: state.server, players: 0,
      maxPlayers: 10, gameType: 0, editor: false, hardcore: false, onlineAuth: true, selfSignedAuth: false,
      nonce: crypto.randomBytes(8).toString('hex'), transportLayer: 2, connection: 4 } };
  }
  if (route.startsWith('/v1/join/') && method === 'POST') return { status: 503, wake: true };   // 503: «full», try again
  return { status: 404 };
}

const waker = new Map();                                     // name → { srv, since }
const WAKING_MAX = 5 * 60e3;                                 // if it hasn't started in 5 min, offer to wake it again
async function watchBedrock() {
  for (const [name, r] of routes) {
    const d = path.join(C.serversDir, `mc-${name}`), e = waker.get(name) ?? {};
    waker.set(name, e);
    let port = bedrockPort(d);
    if (port === C.gate.port || [...routes.values()].some(x => x.public === port)) port = null;   // that TCP port is Java's
    const toml = (() => { try { return fs.readFileSync(path.join(d, 'lazymc.toml'), 'utf8'); } catch { return ''; } })();
    const never = Number(/^sleep_after\s*=\s*(\d+)/m.exec(toml)?.[1] ?? 0) > 31536000;
    const real = Number(/\[server\][^[]*?address\s*=\s*"[^"]*:(\d+)"/.exec(toml)?.[1]);
    // Awake = the server already listens for Java (it opens within seconds; Geyser takes its port ~25 s later).
    const awake = !port || never || await javaUp(real);
    if (e.since && Date.now() - e.since > WAKING_MAX) { console.log(`Bedrock ${name}: never finished starting`); e.since = 0; }
    if (awake && e.srv) { e.srv.close(); e.srv = null; e.since = 0; console.log(`Bedrock ${name}: freeing ${port} for Geyser`); }
    if (awake || e.srv) continue;
    const proto = Number(/^protocol\s*=\s*(\d+)/m.exec(toml)?.[1] ?? 767);
    const names = [`${name}.${C.domain}`, ...(name === C.rootServer ? [C.domain] : [])];
    const g = path.join(d, 'serverfiles/plugins/Geyser-Spigot');
    const wakeNow = ip => {
      if (e.since) return;
      console.log(`Bedrock ${name}: waking it (from ${ip}); it can be joined in a minute`);
      e.since = Date.now(); wake(r, proto);
    };
    let srv;
    try {
      // With Geyser's certificate (tools/cert-geyser.sh) it answers like Geyser: «Sleeping» / «Waking up».
      const tls = { cert: fs.readFileSync(path.join(g, 'https.crt')), key: fs.readFileSync(path.join(g, 'https.key')) };
      srv = https.createServer(tls, (req, res) => {
        const ip = req.socket.remoteAddress, host = String(req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
        if (!names.includes(host)) { res.writeHead(404); return res.end(); }
        const u = new URL(req.url, 'https://x'), a = bedrockReply(req.method, u.pathname, u.searchParams, { waking: Boolean(e.since), server: name });
        if (a.wake) wakeNow(ip);
        res.writeHead(a.status, a.json ? { 'content-type': 'application/json' } : {});
        res.end(a.json ? JSON.stringify(a.json) : undefined);
        req.resume();
      });
      srv.on('tlsClientError', () => {});
    } catch {
      // Without a certificate: it can only see what's asked for (SNI), without answering; it wakes on the first try.
      srv = net.createServer(c => {
        let b = Buffer.alloc(0); const ip = c.remoteAddress;
        c.setTimeout(5000, () => c.destroy()); c.on('error', () => {});
        c.on('data', d2 => {
          b = Buffer.concat([b, d2]);
          let n; try { n = sni(b); } catch { return c.destroy(); }
          if (n === null) return;
          c.destroy();
          if (!names.includes(n)) return console.log(`Bedrock ${name}: connection for «${n || 'no name'}» from ${ip}, ignored`);
          wakeNow(ip);
        });
      });
    }
    srv.on('error', er => { console.log(`Bedrock ${name}: can't listen on ${port} (${er.code})`); if (e.srv === srv) e.srv = null; });
    e.srv = srv;
    srv.listen(port, '0.0.0.0', () => console.log(`Bedrock ${name}: asleep, serving ${port} (${srv instanceof https.Server ? 'HTTPS' : 'TCP, no certificate'}) to wake it`));
  }
}

// A new server (or one just moved to loopback) gets its port on the next pass, within a minute.
const listening = new Map();
function openPorts() {
  for (const [name, r] of routes) {
    if (!r.public || listening.has(r.public)) continue;
    const srv = net.createServer(c => serve(c, name));
    listening.set(r.public, srv);
    srv.on('error', e => { console.log(`can't listen on ${r.public} (${name}): ${e.code}; retrying`); listening.delete(r.public); });
    srv.listen(r.public, '0.0.0.0', () => console.log(`on ${r.public}: ${name}`));
  }
}

// ─────────────────────── The Discord bot ───────────────────────

const API = 'https://discord.com/api/v10';
const ADMIN = 1n << 3n;
const es = (name, description) => ({ name_localizations: { 'es-ES': name, 'es-419': name }, description_localizations: { 'es-ES': description, 'es-419': description } });
const COMMANDS = [
  { name: 'verify', description: 'Join the whitelist of a Minecraft server', contexts: [0],
    ...es('verificar', 'Entra en la lista blanca de un servidor de Minecraft'),
    options: [{ type: 3, name: 'code', description: 'The code the game gave you when you tried to join', required: true,
      ...es('codigo', 'El código que te dio el juego al intentar entrar') }] },
  { name: 'whitelist', description: 'See or change the Minecraft whitelist', contexts: [0], default_member_permissions: String(ADMIN),
    ...es('lista-blanca', 'Ver o cambiar la lista blanca de Minecraft'),
    options: [
      { type: 1, name: 'list', description: 'Who is on the list', ...es('ver', 'Quién está en la lista') },
      { type: 1, name: 'add', description: 'Add someone', ...es('añadir', 'Añadir a alguien'), options: [
        { type: 3, name: 'name', description: 'Minecraft name (Bedrock ones with the leading dot)', required: true,
          ...es('nombre', 'Nombre de Minecraft (los de Bedrock, con el punto delante)') },
        { type: 3, name: 'server', description: 'Server (leave empty for all)', ...es('servidor', 'Servidor (sin poner nada, todos)') }] },
      { type: 1, name: 'remove', description: 'Remove someone', ...es('quitar', 'Quitar a alguien'), options: [
        { type: 3, name: 'name', description: 'Minecraft name', required: true, ...es('nombre', 'Nombre de Minecraft') },
        { type: 3, name: 'server', description: 'Server (leave empty for all)', ...es('servidor', 'Servidor (sin poner nada, de todos)') }] }] },
];

const reply = translator({
  en: {
    insideServer: 'Use it inside the Discord server.', badCode: '❌ That code doesn\'t exist or has expired. Try joining again and the game will give you a new one.',
    otherName: '❌ Your Discord is already linked to another Minecraft name ({}). If that\'s a mistake, tell {}.',
    otherDiscord: '❌ That Minecraft name is already linked to another Discord account.', done: '✅ Done: you can now join **{}** as **{}**.',
    unknown: 'I don\'t know that command.', adminsOnly: 'Only admins can do that.', requiredBy: '**Required on:** {}', none: 'none',
    all: 'all', empty: '(empty)', noServers: '(none)', badName: '❌ That isn\'t a valid Minecraft name.', canJoin: '✅ {} can join {}.',
    allServers: 'every server', notOnList: '{} wasn\'t on the list.', onAll: '{} is on all of them: remove them completely (no server) and add them to the ones you want.',
    removed: '✅ {} removed{}.', removedFrom: ' from {}', removedList: ' from the list', failed: 'Something went wrong; tell {}.', theAdmin: 'the admin',
  },
  es: {
    insideServer: 'Úsalo dentro del servidor de Discord.', badCode: '❌ Ese código no existe o ha caducado. Vuelve a intentar entrar y el juego te dará otro.',
    otherName: '❌ Tu Discord ya está enlazado a otro nombre de Minecraft ({}). Si es un error, díselo a {}.',
    otherDiscord: '❌ Ese nombre de Minecraft ya está enlazado a otra cuenta de Discord.', done: '✅ Listo: ya puedes entrar en **{}** con **{}**.',
    unknown: 'No conozco esa orden.', adminsOnly: 'Eso solo lo pueden hacer los administradores.', requiredBy: '**Exigen la lista:** {}', none: 'ninguno',
    all: 'todos', empty: '(vacía)', noServers: '(ninguno)', badName: '❌ Ese no es un nombre de Minecraft válido.', canJoin: '✅ {} puede entrar en {}.',
    allServers: 'todos los servidores', notOnList: '{} no estaba en la lista.', onAll: '{} está en todos: quítalo del todo (sin servidor) y añádelo a los que quieras.',
    removed: '✅ {} quitado{}.', removedFrom: ' de {}', removedList: ' de la lista', failed: 'Algo ha fallado; díselo a {}.', theAdmin: 'el administrador',
  },
});
const discordLang = i => String(i.locale ?? i.guild_locale ?? '').startsWith('es') ? 'es' : 'en';

export function signatureValid(key, signature, timestamp, body) {
  try { return crypto.verify(null, Buffer.concat([Buffer.from(timestamp ?? ''), body]), key, Buffer.from(signature ?? '', 'hex')); }
  catch { return false; }
}
export const discordKey = hex => crypto.createPublicKey({
  key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(hex, 'hex')]), format: 'der', type: 'spki' });

const html = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// What the bot answers. Returns the text (always visible only to whoever asked).
export function interaction(i, { l = readWhitelist(), save = saveWhitelist, notify = notifyOwner } = {}) {
  const lang = discordLang(i), t = (k, ...a) => reply(lang, k, ...a), owner = C.owner ?? t('theAdmin');
  const uid = i.member?.user?.id;
  if (!uid) return t('insideServer');
  const op = Object.fromEntries((i.data.options?.[0]?.options ?? i.data.options ?? []).map(o => [o.name, String(o.value).trim()]));
  l.players ??= {};
  if (i.data.name === 'verify') {
    const k = op.code?.replace(/\D/g, ''), p = pending.get(k);
    if (!p || Date.now() - p.t > CODE_VALID) return t('badCode');
    const other = Object.values(l.players).find(j => j.discord === uid && j.name.toLowerCase() !== p.player.toLowerCase());
    if (other) return t('otherName', other.name, owner);
    const j = l.players[p.player.toLowerCase()] ??= { name: p.player, servers: [] };
    if (j.discord && j.discord !== uid) return t('otherDiscord');
    j.discord = uid;
    if (!j.servers.includes('*') && !j.servers.includes(p.server)) j.servers.push(p.server);
    save(l); pending.delete(k);
    notify(msg(C.language, 'joinedList', html(p.player), html(p.server)));
    return t('done', p.server, p.player);
  }
  if (i.data.name !== 'whitelist') return t('unknown');
  if (!(BigInt(i.member.permissions ?? 0) & ADMIN)) return t('adminsOnly');
  const sub = i.data.options?.[0]?.name;
  if (sub === 'list') {
    const required = Object.keys(l.servers ?? {}).filter(s => l.servers[s]).join(', ') || t('none');
    const rows = Object.values(l.players).sort((a, b) => a.name.localeCompare(b.name))
      .map(j => `• ${j.name}: ${j.servers.includes('*') ? t('all') : j.servers.join(', ') || t('noServers')}${j.discord ? ' · Discord ✓' : ''}`);
    return `${t('requiredBy', required)}\n${rows.join('\n') || t('empty')}`.slice(0, 1900);
  }
  const name = op.name, key = name?.toLowerCase(), srv = op.server?.toLowerCase();
  if (!/^\.?[A-Za-z0-9_]{1,16}$/.test(name ?? '')) return t('badName');
  if (sub === 'add') {
    const j = l.players[key] ??= { name, servers: [] };
    j.servers = srv ? [...new Set([...j.servers.filter(s => s !== '*'), srv])] : ['*'];
    save(l);
    return t('canJoin', name, srv ?? t('allServers'));
  }
  if (sub === 'remove') {
    const j = l.players[key];
    if (!j) return t('notOnList', name);
    if (srv && !j.servers.includes('*')) j.servers = j.servers.filter(s => s !== srv);
    if (!srv || !j.servers.length) delete l.players[key];
    else if (j.servers.includes('*')) return t('onAll', name);
    save(l);
    return t('removed', name, srv ? t('removedFrom', srv) : t('removedList'));
  }
  return t('unknown');
}

async function startBot() {
  const { WARDEN_TOKEN: token } = readEnv(file('discord.env'));
  if (!token) return console.log('Discord bot off: no WARDEN_TOKEN in discord.env');
  const head = { authorization: `Bot ${token}`, 'content-type': 'application/json' };
  const app = await (await fetch(`${API}/applications/@me`, { headers: head })).json();
  if (!app.verify_key) return console.log(`Discord bot off: Discord rejects the token (${app.message ?? 'no answer'})`);
  const r = await fetch(`${API}/applications/${app.id}/commands`, { method: 'PUT', headers: head, body: JSON.stringify(COMMANDS) });
  if (!r.ok) console.log(`Discord bot: couldn't register the commands (${r.status} ${await r.text()})`);
  const key = discordKey(app.verify_key);
  http.createServer((req, res) => {
    const chunks = []; let len = 0;
    req.on('data', d => { len += d.length; if (len > 65536) req.destroy(); else chunks.push(d); });
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      if (req.method !== 'POST' || !signatureValid(key, req.headers['x-signature-ed25519'], req.headers['x-signature-timestamp'], body)) {
        res.writeHead(401); return res.end('invalid signature');
      }
      let i; try { i = JSON.parse(body); } catch { res.writeHead(400); return res.end(); }
      let data = { type: 1 };                                    // 1: Discord's PING when saving the endpoint
      if (i.type === 2) {
        let text; try { text = interaction(i); } catch (e) { console.log(`Discord bot: ${e.stack}`); text = reply(discordLang(i), 'failed', C.owner ?? reply(discordLang(i), 'theAdmin')); }
        data = { type: 4, data: { content: text, flags: 64 } };
      }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(data));
    });
  }).listen(C.gate.discordPort, '127.0.0.1', () => console.log(`Discord bot listening on 127.0.0.1:${C.gate.discordPort} (${app.name}; Discord calls ${app.interactions_endpoint_url || '(not set in the Developer Portal)'})`));
}

// Under pm2, argv[1] is its wrapper: the script path is in pm_exec_path.
if ([process.argv[1], process.env.pm_exec_path].includes(fileURLToPath(import.meta.url))) {
  if (!C.domain) console.log('no domain in config.json: only the servers\' own ports will work');
  refresh();
  net.createServer(c => serve(c)).listen(C.gate.port, '0.0.0.0', () =>
    console.log(`on ${C.gate.port}, by name: ${[...routes.keys()].join(' ')}; bare ${C.domain} → ${C.rootServer}`));
  setInterval(refresh, 60e3).unref?.();
  let watching = false;                                      // every 3 s, never overlapping
  setInterval(async () => { if (watching) return; watching = true; try { await watchBedrock(); } finally { watching = false; } }, 3000);
  startBot().catch(e => console.log(`Discord bot off: ${e.message}`));
}
