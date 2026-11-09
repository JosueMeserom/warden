// End-to-end test of the lazymc fork (`node gate/lazymc.test.mjs [binary]`, default: `lazymc` on the PATH):
// player → (PROXY header with their IP) → lazymc → (PROXY header with the same IP) → fake server.
// The fake server announces a colored MOTD (as an object, like Paper): lazymc must still see it as started.
// No real server is touched. Upstream lazymc fails it: that's what the fork fixes.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { proxyHeader } from './gate.mjs';

const BIN = process.argv[2] ?? 'lazymc';
const SIGNATURE = Buffer.from('0d0a0d0a000d0a515549540a', 'hex');
const varint = n => { const b = []; do { let x = n & 0x7f; n >>>= 7; if (n) x |= 0x80; b.push(x); } while (n); return Buffer.from(b); };
const readVarint = (b, i) => { let n = 0, s = 0, x; do { if (i >= b.length) return null; x = b[i++]; n |= (x & 0x7f) << s; s += 7; } while (x & 0x80); return [n, i]; };
const frame = c => Buffer.concat([varint(c.length), c]);
const str = t => { const x = Buffer.from(t); return Buffer.concat([varint(x.length), x]); };
const freePort = () => new Promise(ok => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });

// Reads a PROXY v2 header (if any): { local } or { ip, port }, and the rest of the buffer.
function header(b) {
  if (b.length < 16 || !b.subarray(0, 12).equals(SIGNATURE)) return [null, b];
  const end = 16 + b.readUInt16BE(14);
  if ((b[12] & 0x0f) === 0) return [{ local: true }, b.subarray(end)];
  const ip = b[13] >> 4 === 1 ? [...b.subarray(16, 20)].join('.') : null;
  return [{ ip, port: b.readUInt16BE(16 + 8) }, b.subarray(end)];
}

const serverPort = await freePort(), lazymcPort = await freePort();
const seen = [];                                              // what reaches the fake server
const status = JSON.stringify({ version: { name: 'Paper 26.3', protocol: 777 }, players: { max: 20, online: 0 },
  description: { text: '', extra: [{ text: 'Cookie', color: 'gold', bold: true }, { text: ' MC', color: 'aqua' }] } });
const server = net.createServer(c => {
  let b = Buffer.alloc(0), conn = null;
  c.on('data', d => {
    b = Buffer.concat([b, d]);
    if (!conn) { if (b.length < 16) return; const [h, r] = header(b); conn = { header: h }; seen.push(conn); b = r; }
    for (;;) {
      const l = readVarint(b, 0); if (!l || b.length < l[1] + l[0]) return;
      const p = b.subarray(l[1], l[1] + l[0]); b = b.subarray(l[1] + l[0]);
      const [id] = readVarint(p, 0);
      if (conn.next === undefined && id === 0) { conn.next = p[p.length - 1]; if (conn.next === 2) return c.destroy(); continue; }
      if (id === 0) c.write(frame(Buffer.concat([varint(0), str(status)])));
      else if (id === 1) c.write(frame(p));                   // ping: echoed back
    }
  });
  c.on('error', () => {});
}).listen(serverPort, '127.0.0.1');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lazymc-test-'));
fs.writeFileSync(path.join(dir, 'lazymc.toml'), `
[public]
address = "127.0.0.1:${lazymcPort}"
version = "26.3"
protocol = 777
receive_proxy_v2 = true
[server]
address = "127.0.0.1:${serverPort}"
directory = "${dir}"
command = "true"
wake_on_start = false
send_proxy_v2 = true
[config]
version = "0.2.11"
`);
const lz = spawn(BIN, ['start', '-c', path.join(dir, 'lazymc.toml')], { stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
lz.stdout.on('data', d => { log += d; }); lz.stderr.on('data', d => { log += d; });
lz.on('error', e => { log += e.message; });

const login = (withHeader, name) => new Promise(ok => {
  const s = net.connect(lazymcPort, '127.0.0.1', () => s.write(Buffer.concat([
    ...(withHeader ? [proxyHeader('203.0.113.7', 4444, '127.0.0.1', 25580)] : []),
    frame(Buffer.concat([varint(0), varint(777), str('lobby.example.net'), Buffer.from([0x64, 0xec]), varint(2)])),
    frame(Buffer.concat([varint(0), str(name), Buffer.alloc(16)]))])));
  s.on('error', () => {}); s.on('close', ok); s.setTimeout(3000, () => s.destroy());
});

try {
  // A «player» from 203.0.113.7:4444 joins through lazymc, as the gate would do it.
  const deadline = Date.now() + 20e3;
  let player;
  while (Date.now() < deadline && !(player = seen.find(v => v.next === 2))) {
    await new Promise(r => setTimeout(r, 1000));
    if (seen.some(v => v.next === 1)) await login(true, 'Probe');    // it has seen it awake: join
  }
  assert(seen.some(v => v.next === 1), `lazymc never asked for the status:\n${log}`);
  assert.deepEqual(seen.find(v => v.next === 1).header, { local: true }, 'lazymc\'s probe carries a LOCAL header');
  assert(player, `with a colored MOTD, lazymc never saw the server as started:\n${log}`);
  assert.deepEqual(player.header, { ip: '203.0.113.7', port: 4444 }, 'the server gets the real IP');

  // No header from loopback (the panel's ping, probe.mjs): still works, with the local IP.
  const before = seen.length;
  await login(false, 'Local');
  assert.equal(seen[before]?.header?.ip, '127.0.0.1', 'no header: the connection\'s IP');
  console.log('lazymc fork: ok (real IP up to the server, colored MOTD, no header too)');
} finally {
  lz.kill(); server.close(); fs.rmSync(dir, { recursive: true, force: true });
}
