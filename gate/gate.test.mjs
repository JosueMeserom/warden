// node gate/gate.test.mjs — handshake parsing, server choice, whitelist, Discord bot, Bedrock waker, PROXY header.
// Runs anywhere: it uses a temporary WARDEN_HOME and made-up servers. GEOLITE=<path to GeoLite2-Country.mmdb>
// also checks the country lookup against a real database.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-gate-'));
const servers = path.join(tmp, 'servers');
for (const [n, addr] of [['lobby', '127.0.0.1:45580'], ['survival', '0.0.0.0:25575']]) {
  fs.mkdirSync(path.join(servers, `mc-${n}`), { recursive: true });
  fs.writeFileSync(path.join(servers, `mc-${n}`, 'lazymc.toml'), `[public]\naddress = "${addr}"\n[server]\naddress = "127.0.0.1:35580"\n`);
}
process.env.WARDEN_HOME = path.join(tmp, 'home');
fs.mkdirSync(process.env.WARDEN_HOME);
fs.writeFileSync(path.join(process.env.WARDEN_HOME, 'config.json'),
  JSON.stringify({ serversDir: servers, domain: 'example.net', rootServer: 'lobby', language: 'en', owner: 'Alex' }));
const G = await import('./gate.mjs');
const { openMMDB, countryOf } = await import('./geo.mjs');

const vi = n => { const b = []; do { let x = n & 0x7f; n >>>= 7; if (n) x |= 0x80; b.push(x); } while (n); return Buffer.from(b); };
const frame = c => Buffer.concat([vi(c.length), c]);
const str = t => { const h = Buffer.from(t); return Buffer.concat([vi(h.length), h]); };
const hello = (address, state = 2) => frame(Buffer.concat([vi(0), vi(774), str(address), Buffer.from([0x63, 0xdd]), vi(state)]));
const login = player => frame(Buffer.concat([vi(0), str(player), Buffer.alloc(16)]));

// Handshake
const p = hello('lobby.example.net'), l = login('Steve_1');
assert.deepEqual(G.handshake(hello('lobby.example.net', 1)), { address: 'lobby.example.net', state: 1 }, 'status does not wait for the login');
assert.equal(G.handshake(p), null, 'joining waits for the player name');
assert.equal(G.handshake(Buffer.concat([p, l.subarray(0, 4)])), null, 'arrives in pieces: wait');
assert.deepEqual(G.handshake(Buffer.concat([p, l])), { address: 'lobby.example.net', state: 2, player: 'Steve_1' });
assert.equal(G.handshake(p.subarray(0, 10)), null);
assert.throws(() => G.handshake(Buffer.from([0xfe, 0x01])), /legacy/);
assert.throws(() => G.handshake(Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0x0f])), /too long/);
assert.throws(() => G.handshake(Buffer.from([3, 5, 0, 0])), /not a handshake/);

// Which server
assert.equal(G.serverFor('example.net'), 'lobby', 'bare domain: the root server');
assert.equal(G.serverFor('Survival.Example.Net.'), 'survival');
assert.equal(G.serverFor('survival.example.net\0FML3\0'), 'survival', 'Forge');
assert.equal(G.serverFor('203.0.113.9'), null, 'by IP: nothing');
assert.equal(G.serverFor('xexample.net'), null);
assert.equal(G.serverFor('a.example.net', null, null), null, 'no domain configured');

// Routes: lazymc on loopback → the gate serves its public port (internal − offset)
const r = G.readRoutes();
assert.deepEqual(r.get('lobby'), { internal: 45580, public: 25580 });
assert.deepEqual(r.get('survival'), { internal: 25575, public: null }, 'lazymc still public: no own port at the gate');

// Bots
const fb = path.join(tmp, 'bots.txt');
fs.writeFileSync(fb, '# comment\nshepan\n.ifthColumnMC  # with a dot\n/^(Brave|Silly)[A-Z][a-z]+\\d{4}$/\n/[/\n');
const b = G.readBots(fb);
assert(G.isBot('SHEPAN', b) && G.isBot('.ifthColumnMC', b) && G.isBot('BraveTiger9642', b));
assert(!G.isBot('xifthColumnMC', b), 'the dot is literal'); assert(!G.isBot('shepan2', b), 'exact name');
assert(!G.isBot('Steve_1', b) && !G.isBot('BraveTiger', b));
assert.equal(b.length, 3, 'a broken pattern is ignored without breaking anything');

// Central whitelist
const wl = { servers: { lobby: true, survival: false }, players: { steve_1: { name: 'Steve_1', servers: ['*'] }, alex: { name: 'Alex', servers: ['creative'] } } };
assert(G.allowed(wl, 'STEVE_1', 'lobby'), 'all servers, case-insensitive');
assert(!G.allowed(wl, 'Alex', 'lobby') && !G.allowed(wl, 'nobody', 'lobby'));
assert(G.allowed(wl, 'nobody', 'survival') && G.allowed(wl, 'nobody', 'creative'), 'where it is not required, anyone joins');
const k = G.codeFor('Alex', 'lobby');
assert.match(k, /^\d{6}$/); assert.equal(G.codeFor('Alex', 'lobby'), k, 'the same while valid');
assert.notEqual(G.codeFor('Alex', 'creative'), k);
assert.notEqual(G.codeFor('Alex', 'lobby', Date.now() + 31 * 60e3), k, 'expires after half an hour');
const x = G.disconnect([{ text: 'hi' }]);
assert.equal(x[1], 0, 'packet 0x00 (login Disconnect)'); assert(x.toString().includes('"text":"hi"'));
assert.match(G.notListedMessage('lobby', '123456').toString(), /not on the whitelist of lobby.*123456.*\/verify 123456/s);
assert.match(G.notListedMessage('lobby', '123456', 'es').toString(), /No estás en la lista blanca de lobby.*\/verificar 123456/s);

// Discord bot: /verify links the Discord account and grants that server; one Discord, one name
let saved = 0; const notices = [];
const deps = { l: structuredClone(wl), save: () => saved++, notify: t => notices.push(t) };
const k2 = G.codeFor('Newbie', 'lobby');
const verify = (code, uid = '1', locale = 'en-US') => G.interaction({ locale, data: { name: 'verify', options: [{ name: 'code', value: code }] }, member: { user: { id: uid } } }, deps);
assert.match(verify('000000'), /doesn't exist/);
assert.match(verify('000000', '1', 'es-ES'), /no existe/, 'answers in the user\'s language');
assert.match(verify(k2), /✅/); assert(G.allowed(deps.l, 'newbie', 'lobby')); assert.equal(deps.l.players.newbie.discord, '1');
assert.equal(saved, 1); assert.match(notices[0], /<b>Newbie<\/b> joins the whitelist of lobby/, 'the owner is told, in the site language');
assert.match(verify(k2), /doesn't exist/, 'each code works once');
assert.match(verify(G.codeFor('Other', 'lobby')), /another Minecraft name \(Newbie\).*tell Alex/, 'one Discord, one name');
assert.match(verify(G.codeFor('Newbie', 'creative'), '2'), /another Discord account/);
assert.match(G.interaction({ data: { name: 'verify', options: [] } }, deps), /inside the Discord server/);
const admin = (sub, ops = [], perms = '8') => G.interaction({ data: { name: 'whitelist', options: [{ name: sub, options: ops }] }, member: { user: { id: '9' }, permissions: perms } }, deps);
assert.match(admin('list', [], '0'), /Only admins/);
assert.match(admin('add', [{ name: 'name', value: '.Bedro' }, { name: 'server', value: 'lobby' }]), /✅/);
assert(G.allowed(deps.l, '.bedro', 'lobby'));
assert.match(admin('remove', [{ name: 'name', value: '.Bedro' }]), /✅/); assert(!deps.l.players['.bedro']);
assert.match(admin('add', [{ name: 'name', value: 'a b' }]), /isn't a valid/);
assert.match(admin('list'), /Steve_1: all/);

// Discord signature (Ed25519)
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const hex = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex');
const body = Buffer.from('{"type":1}'), sig = crypto.sign(null, Buffer.concat([Buffer.from('123'), body]), privateKey).toString('hex');
assert(G.signatureValid(G.discordKey(hex), sig, '123', body));
assert(!G.signatureValid(G.discordKey(hex), sig, '124', body) && !G.signatureValid(G.discordKey(hex), 'zz', '123', body));

// Bedrock waker: the name asked for in a real TLS hello, and Geyser with NetherNet
const tlsHello = await new Promise(ok => {
  const srv = net.createServer(c => c.once('data', d => { ok(d); c.destroy(); srv.close(); })).listen(0, '127.0.0.1', () => {
    tls.connect({ host: '127.0.0.1', port: srv.address().port, servername: 'survival.example.net' }).on('error', () => {});
  });
});
assert.equal(G.sni(tlsHello), 'survival.example.net');
assert.equal(G.sni(tlsHello.subarray(0, 40)), null, 'in pieces: wait');
assert.throws(() => G.sni(Buffer.from('GET / HTTP/1.1')), /not TLS/);
const geyser = path.join(tmp, 'mc-x');
fs.mkdirSync(path.join(geyser, 'serverfiles/plugins/Geyser-Spigot'), { recursive: true });
const cfg = t => fs.writeFileSync(path.join(geyser, 'serverfiles/plugins/Geyser-Spigot/config.yml'), t);
cfg('bedrock:\n  # x\n  port: 25579   # TCP and UDP\n  transport: nethernet\n  signaling:\n    # how\n    mode: builtin\njava:\n  port: 1\n');
assert.equal(G.bedrockPort(geyser), 25579);
cfg('bedrock:\n  port: 19132\n  transport: raknet\n');
assert.equal(G.bedrockPort(geyser), null, 'RakNet has no TCP signaling');
assert.equal(G.bedrockPort('/does/not/exist'), null);
const q = new URLSearchParams('version=1.26.60&protocol=900&platform=1');
const pong = G.bedrockReply('GET', '/v1/join', q, { waking: false, server: 'lobby' });
assert.equal(pong.status, 200); assert.match(pong.json.name, /Sleeping/); assert.equal(pong.json.protocol, 900, 'its own protocol: no «incompatible»');
assert.match(G.bedrockReply('GET', '/v1/join', q, { waking: true }, 'es').json.name, /Despertándose/);
assert.deepEqual(G.bedrockReply('POST', '/v1/join/abc', q, {}), { status: 503, wake: true }, 'joining wakes it');
assert.equal(G.bedrockReply('GET', '/v1/join/abc', q, {}).status, 404); assert(!G.bedrockReply('POST', '/v1/join', q, {}).wake, 'the list query does not wake it');

// Players' country: only the code, per player
const fc = path.join(tmp, 'countries.json');
G.recordCountry('Alex', 'ES', 1000, fc); G.recordCountry('alex', 'ES', 2000, fc); G.recordCountry('Alex', 'DE', 3000, fc); G.recordCountry('Alex', null, 4000, fc);
const ca = JSON.parse(fs.readFileSync(fc, 'utf8')).alex;
assert.deepEqual(ca.countries.ES, { first: 1000, count: 2, last: 2000 }); assert.equal(ca.countries.DE.count, 1); assert(!JSON.stringify(ca).includes('.'), 'no IPs');
assert.equal((fs.statSync(fc).mode & 0o777).toString(8), '600');
if (process.env.GEOLITE) { const g = openMMDB(process.env.GEOLITE); assert.equal(countryOf(g, '8.8.8.8'), 'US'); assert.equal(countryOf(g, '192.168.1.40'), null); assert.equal(countryOf(g, '::ffff:8.8.8.8'), 'US'); }

// PROXY v2 header for lazymc
const hx = buf => buf.toString('hex');
const SIG = '0d0a0d0a000d0a515549540a';
assert.equal(hx(G.proxyHeader('83.45.1.2', 51234, '127.0.0.1', 25565)), `${SIG}2111000c532d0102 7f000001 c822 63dd`.replace(/ /g, ''));
assert.equal(hx(G.proxyHeader('::ffff:83.45.1.2', 51234, '::ffff:127.0.0.1', 25565)).slice(24, 32), '2111000c', 'IPv4 inside IPv6: sent as IPv4');
const six = G.proxyHeader('2a01:4f8::1', 4000, '::ffff:192.168.1.5', 25565);
assert.equal(hx(six.subarray(12, 16)), '21210024', 'TCP6, 36 bytes');
assert.equal(hx(six.subarray(16, 32)), '2a0104f8000000000000000000000001');
assert.equal(hx(six.subarray(32, 48)), '00000000000000000000ffffc0a80105', 'IPv4 destination as IPv6');
assert.equal(hx(G.LOCAL_HEADER), `${SIG}20000000`);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`gate: ok${process.env.GEOLITE ? ' (with GeoLite2)' : ''}`);
