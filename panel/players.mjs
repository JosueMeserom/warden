// Each player's data, read from the world files (so it shows with the server asleep, and on Fabric too) and from
// Plan (sessions and history, on Paper):
//   world/stats/<uuid>.json, world/advancements/<uuid>.json, world/playerdata/<uuid>.dat   (up to 1.21)
//   world/players/{stats,advancements,data}/…                                               (26.x)
// Item and advancement names come from each version's official language files (Mojang); item images, from the
// game's textures (the client jar, checked against its sha1, only to extract them).
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';

const read = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
const readJSON = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const run = (prog, args, opts = {}) => new Promise(ok => execFile(prog, args, { timeout: 120e3, maxBuffer: 64 << 20, ...opts },
  (e, out) => ok(e ? null : out)));

// ─────────────────────── Where everything is ───────────────────────

export function paths(s) {
  const world = path.join(s.sf, /^level-name=(.*)$/m.exec(read(path.join(s.sf, 'server.properties')))?.[1]?.trim() || 'world');
  const p = path.join(world, 'players');
  return fs.existsSync(p)
    ? { world, stats: path.join(p, 'stats'), advancements: path.join(p, 'advancements'), data: path.join(p, 'data') }
    : { world, stats: path.join(world, 'stats'), advancements: path.join(world, 'advancements'), data: path.join(world, 'playerdata') };
}
const validUuid = u => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(u);

// ─────────────────────── NBT (the .dat files, gzipped) ───────────────────────

export function nbt(buf) {
  const b = buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf) : buf;
  let i = 0;
  const str = () => { const n = b.readUInt16BE(i); i += 2; const t = b.toString('utf8', i, i + n); i += n; return t; };
  const value = type => {
    switch (type) {
      case 1: return b.readInt8(i++);
      case 2: { const v = b.readInt16BE(i); i += 2; return v; }
      case 3: { const v = b.readInt32BE(i); i += 4; return v; }
      case 4: { const v = b.readBigInt64BE(i); i += 8; return Number(v); }
      case 5: { const v = b.readFloatBE(i); i += 4; return v; }
      case 6: { const v = b.readDoubleBE(i); i += 8; return v; }
      case 7: { const n = b.readInt32BE(i); i += 4; const v = [...b.subarray(i, i + n)]; i += n; return v; }
      case 8: return str();
      case 9: { const t = b[i++], n = b.readInt32BE(i); i += 4; return Array.from({ length: n }, () => value(t)); }
      case 10: { const o = {}; for (;;) { const t = b[i++]; if (t === 0) return o; const k = str(); o[k] = value(t); } }
      case 11: { const n = b.readInt32BE(i); i += 4; const v = []; for (let k = 0; k < n; k++, i += 4) v.push(b.readInt32BE(i)); return v; }
      case 12: { const n = b.readInt32BE(i); i += 4; const v = []; for (let k = 0; k < n; k++, i += 8) v.push(Number(b.readBigInt64BE(i))); return v; }
      default: throw new Error(`NBT: type ${type}`);
    }
  };
  const t = b[i++]; str();
  return value(t);
}

// An item from the .dat, in the plugin's format: { slot, id, n, name, enchantments, damage }.
// 1.20.5+: «count» and «components»; before: «Count» and «tag». Enchantments with «levels» or without (1.21.5+).
const plainText = t => {
  if (t == null) return null;
  if (typeof t === 'object') return [t.text ?? t.translate ?? '', ...(t.extra ?? []).map(plainText)].join('');
  try { return plainText(JSON.parse(t)); } catch { return String(t); }
};
export function nbtItem(o, slot = o.Slot) {
  if (!o?.id) return null;
  const c = o.components ?? {}, tag = o.tag ?? {};
  const enc = c['minecraft:enchantments'] ?? c['minecraft:stored_enchantments'];
  const levels = enc?.levels ?? enc ?? Object.fromEntries((tag.Enchantments ?? tag.StoredEnchantments ?? []).map(e => [e.id, e.lvl]));
  const r = { slot, id: o.id, n: o.count ?? o.Count ?? 1 };
  const name = plainText(c['minecraft:custom_name'] ?? tag.display?.Name);
  if (name) r.name = name;
  if (levels && Object.keys(levels).length) r.enchantments = levels;
  const damage = c['minecraft:damage'] ?? tag.Damage;
  if (damage) r.damage = damage;
  return r;
}
const EQUIPMENT = { feet: 100, legs: 101, chest: 102, head: 103, offhand: -106 };
export function nbtInventory(d) {
  const inv = (d.Inventory ?? []).map(o => nbtItem(o)).filter(Boolean);
  // 1.21.5+: armor and offhand in «equipment»; before, in the inventory with slots 100-103 and -106.
  for (const [k, slot] of Object.entries(EQUIPMENT)) { const o = nbtItem(d.equipment?.[k], slot); if (o) inv.push(o); }
  return {
    inventory: inv.filter(o => o.slot >= 0 && o.slot < 36), armor: inv.filter(o => o.slot >= 100 && o.slot <= 103),
    offhand: inv.filter(o => o.slot === -106), ender: (d.EnderItems ?? []).map(o => nbtItem(o)).filter(Boolean),
    health: d.Health, food: d.foodLevel, level: d.XpLevel, pos: d.Pos?.map(Math.round), dimension: d.Dimension, mode: d.playerGameType,
  };
}
export function inventory(s, uuid) {
  if (!validUuid(uuid)) return null;
  try { const f = path.join(paths(s).data, `${uuid}.dat`); return { ...nbtInventory(nbt(fs.readFileSync(f))), saved: fs.statSync(f).mtimeMs }; }
  catch { return null; }
}

// ─────────────────────── Statistics and advancements ───────────────────────

const DISTANCES = ['walk_one_cm', 'sprint_one_cm', 'crouch_one_cm', 'swim_one_cm', 'walk_on_water_one_cm', 'walk_under_water_one_cm',
  'fly_one_cm', 'aviate_one_cm', 'boat_one_cm', 'horse_one_cm', 'minecart_one_cm', 'pig_one_cm', 'strider_one_cm', 'climb_one_cm', 'fall_one_cm', 'happy_ghast_one_cm', 'nautilus_one_cm'];
export function statsSummary(j) {
  const st = j?.stats ?? {}, c = st['minecraft:custom'] ?? {}, g = k => c[`minecraft:${k}`] ?? 0;
  const sum = o => Object.values(o ?? {}).reduce((a, b) => a + b, 0);
  const top = (o, n = 8) => Object.entries(o ?? {}).sort((a, b) => b[1] - a[1]).slice(0, n).map(([id, v]) => ({ id, n: v }));
  const mined = st['minecraft:mined'] ?? {};
  return {
    played: Math.round(g('play_time') / 20) || Math.round(g('play_one_minute') / 20), deaths: g('deaths'), mobKills: g('mob_kills'),
    playerKills: g('player_kills'), distance: Math.round(DISTANCES.reduce((a, k) => a + g(k), 0) / 100), jumps: g('jump'),
    damageDealt: Math.round(g('damage_dealt') / 10), damageTaken: Math.round(g('damage_taken') / 10), sinceDeath: Math.round(g('time_since_death') / 20),
    diamonds: (mined['minecraft:diamond_ore'] ?? 0) + (mined['minecraft:deepslate_diamond_ore'] ?? 0),
    stoneMined: ['stone', 'deepslate', 'tuff', 'granite', 'diorite', 'andesite', 'calcite'].reduce((a, k) => a + (mined[`minecraft:${k}`] ?? 0), 0),
    netherrackMined: ['netherrack', 'basalt', 'blackstone'].reduce((a, k) => a + (mined[`minecraft:${k}`] ?? 0), 0),
    debris: mined['minecraft:ancient_debris'] ?? 0, mined: sum(mined), crafted: sum(st['minecraft:crafted']),
    traded: g('traded_with_villager'), fished: g('fish_caught'), animalsBred: g('animals_bred'), quits: g('leave_game'),
    topMined: top(mined), topKilled: top(st['minecraft:killed']), topKilledBy: top(st['minecraft:killed_by'], 5), topUsed: top(st['minecraft:used']),
  };
}
export function stats(s, uuid) {
  if (!validUuid(uuid)) return null;
  const f = path.join(paths(s).stats, `${uuid}.json`), j = readJSON(f);
  return j ? { ...statsSummary(j), saved: fs.statSync(f).mtimeMs } : null;
}
export function advancements(s, uuid, lang = {}) {
  if (!validUuid(uuid)) return null;
  const j = readJSON(path.join(paths(s).advancements, `${uuid}.json`)) ?? {};
  const done = Object.entries(j).filter(([k, v]) => !k.startsWith('minecraft:recipes/') && v?.done && k.startsWith('minecraft:'))
    .map(([k, v]) => ({ id: k, title: advancementTitle(k, lang), date: mcDate(Object.values(v.criteria ?? {}).sort().pop()) }))
    .sort((a, b) => (b.date ?? 0) - (a.date ?? 0));
  const total = Object.keys(lang).filter(k => /^advancements\.[a-z_]+\.[a-z_]+\.title$/.test(k) && !k.startsWith('advancements.empty')).length;
  return { done, total: total || null };
}
// «2026-02-03 21:05:12 +0100» (as Minecraft stores it) → milliseconds.
export const mcDate = t => { const m = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d) ([+-]\d\d)(\d\d)$/.exec(t ?? ''); return m ? Date.parse(`${m[1]}T${m[2]}${m[3]}:${m[4]}`) : null; };
const advancementTitle = (id, lang) => {
  const [cat, name] = id.replace('minecraft:', '').split('/');
  return lang[`advancements.${cat}.${name}.title`] ?? name?.replace(/_/g, ' ') ?? id;
};

// ─────────────────────── Who has played ───────────────────────

// An official account UUID (version 4) with no known name: asks Mojang once (in the background) and remembers it.
const mojangNames = new Map(), asked = new Set();
export function mojangName(dataDir, uuid) {
  if (!mojangNames.size) for (const [k, v] of Object.entries(readJSON(path.join(dataDir, 'names.json')) ?? {})) mojangNames.set(k, v);
  if (mojangNames.has(uuid) || uuid[14] !== '4' || asked.has(uuid)) return mojangNames.get(uuid) ?? null;
  asked.add(uuid);
  fetch(`https://sessionserver.mojang.com/session/minecraft/profile/${uuid.replace(/-/g, '')}`, { signal: AbortSignal.timeout(15e3) })
    .then(r => r.ok ? r.json() : null).then(j => {
      if (!j?.name) return;
      mojangNames.set(uuid, j.name);
      fs.writeFileSync(path.join(dataDir, 'names.json'), JSON.stringify(Object.fromEntries(mojangNames), null, 1));
    }).catch(() => {});
  return null;
}

export function known(s) {
  const r = new Map(), put = (uuid, name) => { if (validUuid(uuid)) r.set(uuid, { uuid, name: name ?? r.get(uuid)?.name ?? null }); };
  for (const u of readJSON(path.join(s.sf, 'usercache.json')) ?? []) put(u.uuid, u.name);
  try { for (const f of fs.readdirSync(paths(s).stats)) if (f.endsWith('.json')) put(f.slice(0, -5)); } catch {}
  return r;
}

// ─────────────────────── Plan (SQLite, read-only) ───────────────────────

export const planDB = s => { const f = path.join(s.sf, 'plugins/Plan/database.db'); return fs.existsSync(f) ? f : null; };
async function sql(db, query) {
  const out = await run('sqlite3', ['-readonly', '-json', db, query]);
  try { return out?.trim() ? JSON.parse(out) : []; } catch { return []; }
}
const quote = v => `'${String(v).replace(/'/g, "''")}'`;
export async function planPlayers(s) {
  const db = planDB(s); if (!db) return new Map();
  const rows = await sql(db, `select u.uuid, u.name, u.registered, count(x.id) sessions, coalesce(sum(x.session_end - x.session_start), 0) played,
    max(x.session_end) "last" from plan_users u left join plan_sessions x on x.user_id = u.id group by u.id`);
  return new Map(rows.map(f => [f.uuid, f]));
}
export async function planSessions(s, uuid) {
  const db = planDB(s); if (!db || !validUuid(uuid)) return null;
  return sql(db, `select x.session_start "start", x.session_end "end", x.mob_kills kills, x.deaths deaths, x.afk_time afk
    from plan_sessions x join plan_users u on u.id = x.user_id where u.uuid = ${quote(uuid)} order by x.session_start desc limit 200`);
}
// Server history: Plan's measurements averaged per bucket (half hour, hour or 4 hours), and distinct players per day.
export async function planCharts(s, days) {
  const db = planDB(s); if (!db) return null;
  const since = Date.now() - days * 864e5, bucket = days <= 2 ? 3600e3 / 2 : days <= 8 ? 3600e3 : 4 * 3600e3;
  const tps = await sql(db, `select (date / ${bucket}) * ${bucket} t, round(avg(tps), 2) tps, max(players_online) players,
    round(avg(cpu_usage), 1) cpu, round(avg(ram_usage)) ram from plan_tps where date > ${since} group by 1 order by 1`);
  const perDay = await sql(db, `select (session_start / 86400000) * 86400000 t, count(distinct user_id) players, count(*) sessions
    from plan_sessions where session_start > ${Date.now() - Math.max(days, 30) * 864e5} group by 1 order by 1`);
  return { bucket, tps, perDay };
}
// Every session (last 180 days), for the relations between players.
export async function planAllSessions(s) {
  const db = planDB(s); if (!db) return null;
  return sql(db, `select u.name player, x.session_start "start", x.session_end "end" from plan_sessions x join plan_users u on u.id = x.user_id
    where x.session_start > ${Date.now() - 180 * 864e5}`);
}

// ─────────────────────── Leaderboard ───────────────────────

// Play style: the category where someone stands out most compared to everyone else (their rank, from 0 to 1).
export const STYLES = { explorer: 'distance', miner: 'mined', warrior: 'mobKills', pvp: 'playerKills', trader: 'traded', survivor: 'sinceDeath' };
export function rank(rows) {
  const place = (k, v) => { const vs = rows.map(f => f[k] ?? 0).sort((a, b) => a - b); return vs.length > 1 ? vs.filter(x => x < v).length / (vs.length - 1) : 1; };
  for (const f of rows) {
    let best = null, score = -1;
    for (const [style, k] of Object.entries(STYLES)) { if (!f[k]) continue; const p = place(k, f[k]); if (p > score) { score = p; best = style; } }
    f.style = best; f.score = Math.round(score * 100);
  }
  return rows.sort((a, b) => (b.played ?? 0) - (a.played ?? 0));
}

// ─────────────────────── Language and textures (from Mojang, once per version) ───────────────────────

const MOJANG = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const versionJSON = async v => {
  const m = await (await fetch(MOJANG, { signal: AbortSignal.timeout(30e3) })).json();
  const e = m.versions.find(x => x.id === v); if (!e) throw new Error(`Mojang doesn't know version ${v}`);
  return (await fetch(e.url, { signal: AbortSignal.timeout(30e3) })).json();
};
const inProgress = new Map();
const once = (k, f) => { if (!inProgress.has(k)) inProgress.set(k, f().finally(() => setTimeout(() => inProgress.delete(k), 600e3))); return inProgress.get(k); };
const cleanVersion = v => String(v).match(/\d+(\.\d+)+/)?.[0] ?? String(v);

export async function gameLanguage(dataDir, version, locale = 'en_us') {
  const v = cleanVersion(version), f = path.join(dataDir, 'lang', `${v}-${locale}.json`);
  const cached = readJSON(f); if (cached) return cached;
  return once(f, async () => {
    try {
      const vj = await versionJSON(v), index = await (await fetch(vj.assetIndex.url, { signal: AbortSignal.timeout(30e3) })).json();
      const h = index.objects[`minecraft/lang/${locale}.json`]?.hash;
      let text;
      if (h) {
        text = await (await fetch(`https://resources.download.minecraft.net/${h.slice(0, 2)}/${h}`, { signal: AbortSignal.timeout(60e3) })).text();
        if (crypto.createHash('sha1').update(text).digest('hex') !== h) throw new Error('language file hash');
      } else if (locale === 'en_us') {                       // English isn't among the assets: it's inside the client jar
        text = await withJar(vj, jar => run('unzip', ['-p', jar, 'assets/minecraft/lang/en_us.json']));
        if (!text) throw new Error('no en_us.json in the jar');
      } else return {};
      fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text);
      return JSON.parse(text);
    } catch (e) { console.log(`language ${v}: ${e.message}`); return {}; }
  });
}

// The client jar (checked against its sha1), to extract something from it; deleted afterwards.
async function withJar(vj, f) {
  const c = vj.downloads.client, jar = path.join(os.tmpdir(), `warden-client-${process.pid}-${Date.now()}.jar`);
  const b = Buffer.from(await (await fetch(c.url, { signal: AbortSignal.timeout(600e3) })).arrayBuffer());
  if (crypto.createHash('sha1').update(b).digest('hex') !== c.sha1) throw new Error('client jar hash');
  fs.writeFileSync(jar, b, { mode: 0o600 });
  try { return await f(jar); } finally { fs.rmSync(jar, { force: true }); }
}
// Item and block textures from the client jar; only the PNGs needed.
export async function textures(dataDir, version) {
  const v = cleanVersion(version), d = path.join(dataDir, 'textures', v);
  if (fs.existsSync(path.join(d, 'ready'))) return d;
  return once(d, async () => {
    try {
      await withJar(await versionJSON(v), async jar => {
        fs.mkdirSync(d, { recursive: true });
        await run('unzip', ['-q', '-o', '-j', jar, 'assets/minecraft/textures/item/*', '-d', path.join(d, 'item')]);
        await run('unzip', ['-q', '-o', '-j', jar, 'assets/minecraft/textures/block/*', '-d', path.join(d, 'block')]);
      });
      fs.writeFileSync(path.join(d, 'ready'), '');
      return d;
    } catch (e) { console.log(`textures ${v}: ${e.message}`); return null; }
  });
}
// An item's image: its own, or the block's (side, front, top…), or nothing.
export function texture(d, id) {
  const n = String(id).replace(/^minecraft:/, '');
  if (!/^[a-z0-9_]+$/.test(n)) return null;
  const options = [`item/${n}.png`, `block/${n}.png`, `block/${n}_front.png`, `block/${n}_side.png`, `block/${n}_top.png`,
    `item/${n.replace(/_(block|wall_)/, '')}.png`, `block/${n.replace(/s$/, '')}.png`, `block/${n.replace(/_(stairs|slab|wall|fence|fence_gate|pressure_plate|button)$/, '')}.png`,
    `block/${n.replace(/_(stairs|slab|wall|fence|fence_gate|pressure_plate|button)$/, '')}s.png`, `block/${n.replace(/_log$|_wood$/, '_log')}.png`,
    `block/${n.replace(/_(stairs|slab|fence|fence_gate|pressure_plate|button|sign|hanging_sign|door|trapdoor)$/, '')}_planks.png`];
  return options.map(o => path.join(d, o)).find(f => fs.existsSync(f)) ?? null;
}
