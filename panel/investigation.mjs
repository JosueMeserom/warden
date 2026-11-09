// Investigating (x-ray, bases, who breaks or loots other people's bases, lava/fire/TNT/withers, powerful commands),
// relations between players and the heat map. Pure functions: server.mjs collects the data (events from the
// WardenPanel plugin, its per-16×16-zone counters and every player's position every 30 s).

// ─────────────────────── X-ray ───────────────────────

// HIDDEN diamonds (no face touching air, water or lava: the ones only someone seeing through stone finds) per 1000 stone
// blocks mined. Mining blind gives ~1-4; with x-ray, many more. Cave diamonds don't count: since 1.18 there are huge
// caves with diamonds in plain sight, and explorers get plenty while barely mining any stone (that's legitimate).
export const THRESHOLD = { medium: { n: 10, per1000: 8 }, high: { n: 20, per1000: 15 } };
export function miningSuspicion(valuable, common) {
  const r = common ? valuable * 1000 / common : (valuable ? Infinity : 0);
  if (valuable >= THRESHOLD.high.n && r >= THRESHOLD.high.per1000) return 'high';
  if (valuable >= THRESHOLD.medium.n && r >= THRESHOLD.medium.per1000) return 'medium';
  return null;
}
// miners: per player, what has been seen since the plugin is there («ore» events + counted stone) and the game's
// all-time statistics (st: { diamonds, stoneMined, debris, netherrackMined }).
export function miners(events, stone, stats) {
  const r = new Map(), of = n => r.get(n) ?? r.set(n, { player: n, diamonds: 0, hidden: 0, debris: 0, emeralds: 0, stone: 0, last: 0 }).get(n);
  for (const e of events) {
    if (e.type !== 'ore') continue;
    const j = of(e.player); j.last = Math.max(j.last, e.t);
    if (/diamond/.test(e.text)) { j.diamonds++; if (/\|hidden$/.test(e.text)) j.hidden++; } else if (/ancient_debris/.test(e.text)) j.debris++; else if (/emerald/.test(e.text)) j.emeralds++;
  }
  for (const [n, v] of Object.entries(stone ?? {})) of(n).stone += v;
  for (const [n, st] of Object.entries(stats ?? {})) Object.assign(of(n), { allTime: st });
  for (const j of r.values()) {
    j.per1000 = j.stone ? Math.round(j.hidden * 10000 / j.stone) / 10 : null;
    const h = j.allTime;                                     // the game's: informative only (it can't tell caves apart)
    j.allTimePer1000 = h?.stoneMined ? Math.round(h.diamonds * 10000 / h.stoneMined) / 10 : null;
    j.suspicion = miningSuspicion(j.hidden, j.stone);
  }
  return [...r.values()].sort((a, b) => (b.diamonds + (b.allTime?.diamonds ?? 0)) - (a.diamonds + (a.allTime?.diamonds ?? 0)));
}

// ─────────────────────── Bases ───────────────────────

// zones: { «world|cx|cz»: { player: [placed, broken] } }. A zone belongs to whoever placed the most there (64 blocks at
// least, and more than anyone else); neighbouring zones with the same owner make up a base.
export const MIN_BASE = 64;
export function owners(zones) {
  const d = new Map();
  for (const [k, js] of Object.entries(zones ?? {})) {
    const [best, v] = Object.entries(js).sort((a, b) => b[1][0] - a[1][0])[0] ?? [];
    if (best && v[0] >= MIN_BASE) d.set(k, best);
  }
  return d;
}
export function bases(zones) {
  const d = owners(zones), seen = new Set(), r = [];
  for (const [k, owner] of d) {
    if (seen.has(k)) continue;
    const [world] = k.split('|'), queue = [k], chunks = [];
    seen.add(k);
    while (queue.length) {
      const c = queue.pop(), [, cx, cz] = c.split('|').map(Number); chunks.push([cx, cz]);
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
        const v = `${world}|${cx + dx}|${cz + dz}`;
        if (!seen.has(v) && d.get(v) === owner) { seen.add(v); queue.push(v); }
      }
    }
    const placed = chunks.reduce((a, [cx, cz]) => a + zones[`${world}|${cx}|${cz}`][owner][0], 0);
    r.push({ owner, world, zones: chunks.length, placed, x: Math.round(chunks.reduce((a, t) => a + t[0], 0) / chunks.length * 16 + 8),
      z: Math.round(chunks.reduce((a, t) => a + t[1], 0) / chunks.length * 16 + 8) });
  }
  return r.sort((a, b) => b.placed - a.placed);
}

// ─────────────────────── Alerts ───────────────────────

const zoneOf = e => `${e.world}|${Math.floor(e.x / 16)}|${Math.floor(e.z / 16)}`;
const VALUABLE = /diamond|netherite|elytra|totem|enchanted_golden_apple|shulker_box|beacon|nether_star|emerald_block|ancient_debris/;
const id = (...p) => p.join('|');
// Everything worth a look, most serious first. «heat»: { zone: { player: 30 s samples } }. Each alert's text is
// [template, ...values]: the web page translates the template.
export function alerts({ events, zones, heat, miners: ms, countries = {} }) {
  const d = owners(zones), r = new Map();
  const put = a => { const x = r.get(a.id); if (x) { x.n += a.n ?? 1; x.t = Math.max(x.t, a.t); } else r.set(a.id, { n: 1, ...a }); };
  for (const e of events) {
    if (e.x == null) continue;
    const owner = d.get(zoneOf(e)), foreign = owner && owner.toLowerCase() !== e.player.toLowerCase();
    const place = { world: e.world, x: e.x, y: e.y, z: e.z, t: e.t, player: e.player, owner: foreign ? owner : null };
    if (e.type === 'take' && foreign)
      put({ ...place, id: id('take', e.player, owner, zoneOf(e)), kind: 'looting', severity: VALUABLE.test(e.text) ? 'high' : 'medium',
        text: ['took things from a container in {}\'s base', owner], detail: e.text });
    if (['lava', 'tnt', 'wither'].includes(e.type) || (e.type === 'fire' && !/obsidian/.test(e.text ?? '')))
      put({ ...place, id: id(e.type, e.player, zoneOf(e)), kind: e.type, severity: foreign || e.type === 'wither' ? 'high' : 'low',
        text: foreign ? [{ lava: 'poured lava in {}\'s base', tnt: 'placed TNT in {}\'s base', wither: 'summoned a wither in {}\'s base', fire: 'started a fire in {}\'s base' }[e.type], owner]
          : [{ lava: 'poured lava', tnt: 'placed TNT', wither: 'summoned a wither', fire: 'started a fire' }[e.type]] });
    if (e.type === 'command')
      put({ ...place, owner: null, id: id('command', e.player, e.t), kind: 'command', severity: /^\/?(minecraft:)?(op|deop|summon|fill|clone|setblock|pardon|ban|whitelist|execute)\b/i.test(e.text) ? 'medium' : 'low',
        text: ['used a command'], detail: e.text });
  }
  for (const [k, js] of Object.entries(zones ?? {})) {
    const owner = d.get(k); if (!owner) continue;
    const [world, cx, cz] = k.split('|');
    for (const [j, [, broken]] of Object.entries(js)) if (j !== owner && broken >= 32)
      put({ id: id('breaks', j, owner, k), kind: 'breakage', severity: broken >= 200 ? 'high' : 'medium', player: j, owner, world, x: cx * 16 + 8, z: cz * 16 + 8,
        t: 0, n: broken, text: ['broke {} blocks in {}\'s base', broken, owner] });
  }
  for (const [k, js] of Object.entries(heat ?? {})) {
    const owner = d.get(k); if (!owner) continue;
    const [world, cx, cz] = k.split('|');
    for (const [j, samples] of Object.entries(js)) if (j !== owner && samples >= 20)
      put({ id: id('visit', j, owner, k), kind: 'visit', severity: 'low', player: j, owner, world, x: cx * 16 + 8, z: cz * 16 + 8, t: 0, n: samples,
        text: ['spent {} min in {}\'s base', Math.round(samples / 2), owner] });
  }
  for (const m of ms ?? []) if (m.suspicion)
    put({ id: id('xray', m.player), kind: 'xray', severity: m.suspicion, player: m.player, t: m.last, world: null,
      text: ['finds too many hidden diamonds ({} with no face exposed; {} per 1000 stone blocks mined)', m.hidden, m.per1000] });
  // The same account from several countries: shared, or stolen. (A trip explains it too: hence medium.)
  for (const [j, ps] of Object.entries(countries)) if (ps?.length >= 2)
    put({ id: id('countries', j, ps.map(p => p.country).sort().join(',')), kind: 'countries', severity: 'medium', player: j, world: null, t: ps[0].last,
      text: ['joined from {} different countries', ps.length], detail: ps.map(p => `${p.country} (${p.count})`).join(', ') });
  const weight = { high: 3, medium: 2, low: 1 };
  return [...r.values()].sort((a, b) => weight[b.severity] - weight[a.severity] || b.t - a.t);
}

// ─────────────────────── Relations ───────────────────────

// sessions: [{ player, start, end }]. For each pair, the minutes they played at the same time.
export function relations(sessions) {
  const byPlayer = new Map(), pairs = new Map();
  for (const s of sessions) { if (!(s.end > s.start)) continue; (byPlayer.get(s.player) ?? byPlayer.set(s.player, []).get(s.player)).push(s); }
  const js = [...byPlayer.keys()];
  for (let i = 0; i < js.length; i++) for (let k = i + 1; k < js.length; k++) {
    let ms = 0;
    for (const a of byPlayer.get(js[i])) for (const b of byPlayer.get(js[k])) ms += Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
    if (ms >= 5 * 60e3) pairs.set(`${js[i]}|${js[k]}`, Math.round(ms / 60e3));
  }
  const nodes = js.map(j => ({ player: j, minutes: Math.round(byPlayer.get(j).reduce((a, s) => a + s.end - s.start, 0) / 60e3) }))
    .filter(n => [...pairs.keys()].some(k => k.split('|').includes(n.player)) || n.minutes > 0);
  return { nodes: nodes.sort((a, b) => b.minutes - a.minutes), links: [...pairs].map(([k, m]) => ({ a: k.split('|')[0], b: k.split('|')[1], minutes: m })).sort((a, b) => b.minutes - a.minutes) };
}
// Without Plan (Fabric): sessions come from the joins and leaves the panel has seen.
export function sessionsFromEvents(events) {
  const open = new Map(), r = [];
  for (const e of events) {
    if (e.type === 'join') open.set(e.player, e.t);
    else if (e.type === 'leave' && open.has(e.player)) { r.push({ player: e.player, start: open.get(e.player), end: e.t }); open.delete(e.player); }
  }
  return r;
}

// ─────────────────────── Heat map ───────────────────────

export function heatOf(heat, world) {
  const cells = [];
  for (const [k, js] of Object.entries(heat ?? {})) {
    const [w, cx, cz] = k.split('|'); if (w !== world) continue;
    cells.push({ cx: Number(cx), cz: Number(cz), n: Object.values(js).reduce((a, b) => a + b, 0), players: js });
  }
  return cells;
}
export function worlds(heat, events) {
  return [...new Set([...Object.keys(heat ?? {}).map(k => k.split('|')[0]), ...events.filter(e => e.world).map(e => e.world)])];
}
