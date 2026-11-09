// Speaks just enough of the Minecraft protocol to test a server (or lazymc, or the gate) without a client:
//   node probe.mjs status 127.0.0.1 25566          → version, MOTD and players online (JSON)
//   node probe.mjs join 127.0.0.1 25566 774        → tries to join (offline mode); it wakes a sleeping server
//   ADDRESS=lobby.example.net node probe.mjs status 127.0.0.1 25565   → through the gate, by name
// "join" stops right after the first login answer, before getting into the world: it leaves no player data
// and never shows up as connected.
import net from 'node:net';
import crypto from 'node:crypto';

const varint = n => { const b = []; n >>>= 0; do { let x = n & 0x7f; n >>>= 7; if (n) x |= 0x80; b.push(x); } while (n); return Buffer.from(b); };
const str = s => { const b = Buffer.from(s, 'utf8'); return Buffer.concat([varint(b.length), b]); };
const packet = (id, ...parts) => { const c = Buffer.concat([varint(id), ...parts]); return Buffer.concat([varint(c.length), c]); };
function readVarint(buf, i = 0) { let n = 0, s = 0, b; do { if (i >= buf.length) return null; b = buf[i++]; n |= (b & 0x7f) << s; s += 7; } while (b & 0x80); return [n, i]; }
const handshake = (proto, host, port, next) => packet(0x00, varint(proto), str(host), Buffer.from([port >> 8, port & 255]), varint(next));

function firstPacket(host, port, payload, wait = 40000) {
  return new Promise((ok, fail) => {
    const s = net.connect(port, host); let buf = Buffer.alloc(0);
    const t = setTimeout(() => { s.destroy(); fail(new Error(`no answer in ${wait / 1000} s`)); }, wait);
    s.on('connect', () => s.write(payload));
    s.on('data', d => {
      buf = Buffer.concat([buf, d]);
      const l = readVarint(buf); if (!l || buf.length < l[1] + l[0]) return;
      clearTimeout(t); s.destroy();
      const body = buf.subarray(l[1], l[1] + l[0]); const [id, j] = readVarint(body);
      ok({ id, data: body.subarray(j) });
    });
    s.on('error', e => { clearTimeout(t); fail(e); });
  });
}
const text = j => typeof j === 'string' ? j : (j.text ?? '') + (j.extra ?? []).map(text).join('');

const [mode, host = '127.0.0.1', portArg = '25565', proto = '-1'] = process.argv.slice(2);
const port = Number(portArg);
if (mode === 'status') {
  const r = await firstPacket(host, port, Buffer.concat([handshake(Number(proto), process.env.ADDRESS ?? host, port, 1), packet(0x00)]), 10000);
  const [len, i] = readVarint(r.data); const j = JSON.parse(r.data.subarray(i, i + len).toString());
  console.log(JSON.stringify({ version: j.version, motd: text(j.description).replace(/§./g, ''), players: j.players?.online }));
} else if (mode === 'join') {
  const name = process.env.PLAYER ?? 'probe_lazymc';
  const uuid = crypto.createHash('md5').update('OfflinePlayer:' + name).digest();
  const r = await firstPacket(host, port, Buffer.concat([handshake(Number(proto), process.env.ADDRESS ?? host, port, 2), packet(0x00, str(name), uuid)]));
  if (r.id === 0x00) { const [len, i] = readVarint(r.data); console.log('KICKED:', text(JSON.parse(r.data.subarray(i, i + len).toString())).replace(/§./g, '')); }
  else console.log({ 0x01: 'IN: the real server asks for encryption', 0x02: 'IN: login accepted by the real server', 0x03: 'IN: the real server negotiates compression' }[r.id] ?? `packet 0x${r.id.toString(16)}`);
} else { console.log('usage: node probe.mjs status|join host port [protocol]'); process.exit(2); }
