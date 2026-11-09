// Country of an IP from the GeoLite2-Country database (MaxMind DB format) that Plan downloads once its license is
// accepted (plugins/Plan/GeoLite2-Country.mmdb). No dependencies: a binary tree over the IP bits plus a data section.
// The gate uses it: it is the first hop that sees the real IP.
import fs from 'node:fs';
import net from 'node:net';

const MARKER = Buffer.from([0xab, 0xcd, 0xef, ...Buffer.from('MaxMind.com')]);

export function openMMDB(f) {
  const b = fs.readFileSync(f), m = b.lastIndexOf(MARKER);
  if (m < 0) throw new Error('not a MaxMind database');
  const meta = decode(b, m + MARKER.length, m + MARKER.length)[0];
  const size = meta.record_size, nodeCount = meta.node_count, treeSize = nodeCount * size * 2 / 8, dataStart = treeSize + 16;
  const record = (n, side) => {
    const o = n * size * 2 / 8;
    if (size === 24) return side ? b.readUIntBE(o + 3, 3) : b.readUIntBE(o, 3);
    if (size === 28) return side ? ((b[o + 3] & 0x0f) << 24) | b.readUIntBE(o + 4, 3) : ((b[o + 3] & 0xf0) << 20) | b.readUIntBE(o, 3);
    return side ? b.readUInt32BE(o + 4) : b.readUInt32BE(o);
  };
  // In an IPv6 database, IPv4 lives under ::/96: 96 zero bits before the 32 of the IPv4 address.
  let ipv4Start = 0;
  if (meta.ip_version === 6) for (let i = 0; i < 96 && ipv4Start < nodeCount; i++) ipv4Start = record(ipv4Start, 0);
  return {
    meta,
    lookup(ip) {
      let bits, n;
      if (net.isIPv4(ip)) { bits = ip.split('.').flatMap(x => [...Number(x).toString(2).padStart(8, '0')]).map(Number); n = ipv4Start; }
      else if (net.isIPv6(ip) && /^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(ip)) return this.lookup(ip.split(':').pop());
      else return null;
      for (const bit of bits) { if (n >= nodeCount) break; n = record(n, bit); }
      if (n <= nodeCount) return null;                          // == nodeCount: no data
      return decode(b, dataStart + (n - nodeCount) - 16, dataStart)[0];
    },
  };
}

// Data section: each value starts with a control byte (type in the top 3 bits, size in the low 5).
function decode(b, o, base) {
  const c = b[o++];
  let type = c >> 5;
  if (type === 0) type = 7 + b[o++];                        // extended types
  if (type === 1) {                                         // pointer
    const s = (c >> 3) & 3, v = c & 7;
    let p;
    if (s === 0) { p = (v << 8) | b[o]; o += 1; }
    else if (s === 1) { p = ((v << 16) | b.readUInt16BE(o)) + 2048; o += 2; }
    else if (s === 2) { p = ((v << 24) | b.readUIntBE(o, 3)) + 526336; o += 3; }
    else { p = b.readUInt32BE(o); o += 4; }
    return [decode(b, base + p, base)[0], o];
  }
  let size = c & 0x1f;
  if (size === 29) size = 29 + b[o++];
  else if (size === 30) { size = 285 + b.readUInt16BE(o); o += 2; }
  else if (size === 31) { size = 65821 + b.readUIntBE(o, 3); o += 3; }
  switch (type) {
    case 2: return [b.toString('utf8', o, o + size), o + size];
    case 3: return [b.readDoubleBE(o), o + 8];
    case 4: return [b.subarray(o, o + size), o + size];
    case 5: case 6: case 9: case 10: { let v = 0; for (let i = 0; i < size; i++) v = v * 256 + b[o + i]; return [v, o + size]; }
    case 8: { let v = 0; for (let i = 0; i < size; i++) v = (v << 8) | b[o + i]; return [v, o + size]; }
    case 7: { const r = {}; for (let i = 0; i < size; i++) { const [k, o2] = decode(b, o, base); const [v, o3] = decode(b, o2, base); r[k] = v; o = o3; } return [r, o]; }
    case 11: { const r = []; for (let i = 0; i < size; i++) { const [v, o2] = decode(b, o, base); r.push(v); o = o2; } return [r, o]; }
    case 14: return [size !== 0, o];
    case 15: return [b.readFloatBE(o), o + 4];
    default: return [null, o + size];
  }
}

// The country code (ES, FR…) of an IP, or null (local network, no data, no database).
export function countryOf(db, ip) {
  try { const r = db?.lookup(ip); return r?.country?.iso_code ?? r?.registered_country?.iso_code ?? null; } catch { return null; }
}
