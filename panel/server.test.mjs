// node panel/server.test.mjs — permissions, actions, whitelist, when a server will sleep, the log, investigating, MOTD
// and server discovery. No network, no real servers: a temporary WARDEN_HOME and made-up servers.
import assert from 'node:assert';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-panel-'));
const servers = path.join(tmp, 'servers'), caddy = path.join(tmp, 'Caddyfile');
fs.mkdirSync(path.join(servers, 'mc-lobby', 'serverfiles'), { recursive: true });
fs.writeFileSync(path.join(servers, 'mc-lobby', 'lazymc.toml'),
  '[public]\naddress = "127.0.0.1:45580"\nversion = "26.3"\nprotocol = 777\n[server]\naddress = "127.0.0.1:35580"\nsend_proxy_v2 = true\n[time]\nsleep_after = 600\n');
fs.writeFileSync(path.join(servers, 'mc-lobby', 'serverfiles', 'paper.jar'), '');
fs.writeFileSync(caddy, 'bm-lobby.example.net {\n\timport /etc/caddy/bluemap.caddy mc-lobby 8100\n}\npl-lobby.example.net {\n\treverse_proxy 127.0.0.1:25582\n}\n');
process.env.WARDEN_HOME = path.join(tmp, 'home');
fs.mkdirSync(process.env.WARDEN_HOME);
fs.writeFileSync(path.join(process.env.WARDEN_HOME, 'config.json'),
  JSON.stringify({ serversDir: servers, domain: 'example.net', rootServer: 'lobby', owner: 'Alex', panel: { caddyfile: caddy } }));
const S = await import('./server.mjs');
const I = await import('./investigation.mjs');

// Permissions
const mod = { permissions: { '*': ['view'], lobby: S.PROFILES.moderator } };
assert.deepEqual(S.permissionsOf(mod, 'survival'), ['view']);
assert(S.permissionsOf(mod, 'lobby').includes('moderate') && !S.permissionsOf(mod, 'lobby').includes('console'));
assert.equal(S.permissionsOf({ permissions: { lobby: ['console'] } }, 'lobby').length, 11, 'console includes everything');
assert.equal(S.permissionsOf({ owner: true }, 'x').length, 11);
assert.match(S.randomPassword(), /^[A-Za-z2-9]{14}$/); assert(!/[01lIO]/.test(S.randomPassword(200)));

// Actions: one console line, nothing smuggled in
assert.deepEqual(S.ACTIONS.kick.commands({ player: 'Steve', reason: 'bye\ntp @a 0 0 0' }), ['kick Steve bye tp @a 0 0 0']);
assert.deepEqual(S.ACTIONS.tp.commands({ player: 'Steve', target: 'Alex' }), ['tp Steve Alex']);
assert.deepEqual(S.ACTIONS.tp.commands({ player: 'Steve', x: '10.6', y: 64, z: -3 }), ['tp Steve 11 64 -3']);
assert.throws(() => S.ACTIONS.tp.commands({ player: 'Steve', x: 'a', y: 1, z: 1 }));
assert.throws(() => S.ACTIONS.mode.commands({ player: 'Steve', mode: 'god' }));
assert.throws(() => S.ACTIONS.give.commands({ player: 'Steve', item: 'diamond 64\nop Steve' }));
assert.deepEqual(S.ACTIONS.give.commands({ player: 'Steve', item: 'minecraft:diamond', amount: 99999 }), ['give Steve minecraft:diamond 6400']);
const chat = S.ACTIONS.chat.commands({ text: 'hi "world"' }, 'Alex')[0];
assert(chat.startsWith('tellraw @a [') && JSON.parse(chat.slice(11))[1].text === 'hi "world"');
assert.deepEqual(S.ACTIONS.rule.commands({ name: 'keep_inventory', value: 'true' }), ['gamerule keep_inventory true']);
assert.throws(() => S.ACTIONS.rule.commands({ name: 'keep_inventory', value: 'true\nop x' }));
assert.throws(() => S.ACTIONS.difficulty.commands({ value: 'impossible' }));

// Central whitelist from the panel
const l = { servers: { lobby: true, survival: true }, players: { steve_1: { name: 'Steve_1', servers: ['*'] } } };
S.changeWhitelist(l, 'lobby', 'Alex', true); assert.deepEqual(l.players.alex.servers, ['lobby']);
S.changeWhitelist(l, 'lobby', 'alex', false); assert(!l.players.alex, 'no servers left: out');
S.changeWhitelist(l, 'lobby', 'Steve_1', false); assert.deepEqual(l.players.steve_1.servers, ['survival'], 'from «all» to the others');

// When it will sleep
const s = { name: 'x', sf: '/nope', sleepAfter: 600, minimum: 120 };
const now = new Date('2026-11-07T12:00:00').getTime();
assert.deepEqual(S.sleepsAt({ ...s, sleepAfter: 315360000 }, 0, now), { never: true });
assert.deepEqual(S.sleepsAt(s, 2, now), { afterEmpty: 600 });
const d = S.sleepsAt(s, 0, now, '2026-11-07T11:58:00:  INFO  lazymc::monitor > Server is now online\n', '[11:59:00] [Server thread/INFO]: Steve left the game\n');
assert.equal(d.at, new Date('2026-11-07T12:09:00').getTime(), '10 min after the last one left');

// What happens, read from the log (Fabric)
const ev = S.eventsFromLog('[10:00:00] [Server thread/INFO]: Steve joined the game\n[10:00:05] [Server thread/INFO]: <Steve> hi\n[10:01:00] [Server thread/INFO]: Steve has made the advancement [Stone Age]\n[10:02:00] [Server thread/INFO]: Steve left the game\n');
assert.deepEqual(ev.map(e => e.type), ['join', 'chat', 'advancement', 'leave']); assert.equal(ev[1].text, 'hi');

// Investigating
assert.equal(I.miningSuspicion(5, 1000), null, 'few diamonds: nothing'); assert.equal(I.miningSuspicion(12, 1000), 'medium'); assert.equal(I.miningSuspicion(40, 1000), 'high');
assert.equal(I.miningSuspicion(30, 20000), null, '1.5 per 1000: normal');
const t0 = Date.now(), zones = { 'world|0|0': { Alex: [300, 5], Steve: [2, 250] }, 'world|1|0': { Alex: [100, 0] }, 'world|9|9': { Steve: [10, 0] } };
const bs = I.bases(zones);
assert.equal(bs.length, 1); assert.equal(bs[0].owner, 'Alex'); assert.equal(bs[0].zones, 2, 'neighbouring zones make one base');
const evs = [
  { type: 'take', player: 'Steve', world: 'world', x: 5, y: 64, z: 5, t: t0, text: '3 minecraft:diamond' },
  { type: 'lava', player: 'Steve', world: 'world', x: 20, y: 64, z: 3, t: t0 },
  { type: 'fire', player: 'Alex', world: 'world', x: 1, y: 64, z: 1, t: t0, text: 'minecraft:obsidian' },
  { type: 'command', player: 'Steve', world: 'world', x: 0, y: 64, z: 0, t: t0, text: '/op Steve' },
  ...Array.from({ length: 25 }, (_, i) => ({ type: 'ore', player: 'Mole', t: t0 + i, text: 'minecraft:deepslate_diamond_ore|hidden', world: 'world', x: 0, y: -50, z: 0 })),
];
const ms = I.miners(evs, { Mole: 900, Steve: 5000 }, {});
assert.equal(ms.find(m => m.player === 'Mole').suspicion, 'high', '25 hidden diamonds in 900 stone');
assert.equal(I.miners([{ type: 'ore', player: 'Caver', t: 1, text: 'minecraft:diamond_ore' }], { Caver: 10 }, { Caver: { diamonds: 500, stoneMined: 1000 } })[0].suspicion, null, 'cave diamonds and all-time stats accuse nobody');
const al = I.alerts({ events: evs, zones, heat: { 'world|0|0': { Steve: 40 } }, miners: ms });
const kinds = al.map(a => a.kind);
for (const k of ['looting', 'lava', 'breakage', 'visit', 'xray', 'command']) assert(kinds.includes(k), `missing alert ${k}`);
assert(I.alerts({ events: [], zones: {}, countries: { Alex: [{ country: 'ES', last: 2, count: 3 }, { country: 'DE', last: 1, count: 1 }], Max: [{ country: 'ES', last: 1, count: 9 }] } }).map(a => a.player).join() === 'Alex', 'several countries: only Alex');
assert(!kinds.includes('fire'), 'lighting a portal is not suspicious fire');
assert.equal(al.find(a => a.kind === 'looting').severity, 'high', 'diamonds from someone else\'s base');
assert.equal(al[0].severity, 'high', 'the serious ones first');
assert(al.every(a => Array.isArray(a.text) && typeof a.text[0] === 'string'), 'texts are [template, ...values]');
const rel = I.relations([{ player: 'Alex', start: 0, end: 3600e3 }, { player: 'Steve', start: 1800e3, end: 5400e3 }, { player: 'Max', start: 9e6, end: 9.1e6 }]);
assert.deepEqual(rel.links, [{ a: 'Alex', b: 'Steve', minutes: 30 }]);
assert.deepEqual(I.sessionsFromEvents([{ type: 'join', player: 'A', t: 10 }, { type: 'leave', player: 'A', t: 50 }]), [{ player: 'A', start: 10, end: 50 }]);

// MOTD: colors with & or §, and in server.properties with its escapes
assert.equal(S.motdText('§aHi &Lworld\x07'), '§aHi §lworld');
assert.equal(S.motdText('Tom & Jerry §z&'), 'Tom & Jerry z&', 'what isn\'t a code stays (a lone § goes)');
assert.equal(S.motdText('&a' + 'x'.repeat(70) + '\n&b' + 'y'.repeat(5) + '&c\nthird'), '§a' + 'x'.repeat(60) + '\n§b' + 'yyyyy', '60 visible, two lines, no dangling codes');
const dm = path.join(tmp, 'motd'); fs.mkdirSync(dm);
fs.writeFileSync(path.join(dm, 'server.properties'), 'pvp=true\nmotd=old\nmax-players=10\n');
S.saveMotd({ sf: dm }, '&6Año ñandú\nline 2');
const props = fs.readFileSync(path.join(dm, 'server.properties'), 'utf8');
assert(props.includes('motd=\\u00a76A\\u00f1o \\u00f1and\\u00fa\\nline 2') && props.includes('max-players=10'), props);
assert.equal(S.propertiesMotd({}, props), '§6Año ñandú\nline 2', 'round trip');

// Faces by UUID only for official accounts (v4); offline ones (v3), by name
const dc = path.join(tmp, 'faces'); fs.mkdirSync(dc);
fs.writeFileSync(path.join(dc, 'usercache.json'), JSON.stringify([{ name: 'Official', uuid: '92bf50a6-a8e7-4484-b167-966a8258ade2' },
  { name: 'Offline', uuid: '5e1d2c3b-4a59-3e8f-9d7c-6b5a4f3e2d1c' }, { name: '.Bedrock', uuid: '00000000-0000-0000-0009-01f2e3d4c5b6' }]));
assert.deepEqual(S.faces({ sf: dc }), { official: '92bf50a6a8e74484b167966a8258ade2' });
assert.deepEqual(S.faces({ sf: '/does/not/exist' }), {});

// SSO signature (the other site computes the same)
assert.equal(S.ssoSignature('k', 'owner', 'n', 1).length, 43);

// Server discovery: lazymc.toml + the Caddyfile
const sv = S.servers();
assert.equal(sv.length, 1);
assert.deepEqual({ ...sv[0], dir: undefined, sf: undefined }, { name: 'lobby', dir: undefined, sf: undefined, script: 'pmcserver', type: 'paper', real: 35580,
  proxy: true, lazymc: 45580, public: 25580, version: '26.3', protocol: 777, sleepAfter: 600, minimum: 0,
  map: 'https://bm-lobby.example.net', plan: 'https://pl-lobby.example.net', webconsole: null });

fs.rmSync(tmp, { recursive: true, force: true });
console.log('panel server: ok');
