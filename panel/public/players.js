// Players (profile, sessions, statistics, inventory, advancements), leaderboard and charts.
// Uses what app.js defines (api, esc, head, detail, current, can). Everything that comes from the game goes through esc().
'use strict';

const TP = translateObj({
  styles: { explorer: '🧭 Explorer', miner: '⛏ Miner', warrior: '⚔ Warrior', pvp: '🗡 PvP', trader: '💰 Trader', survivor: '🛡 Survivor' },
  profileTabs: { profile: 'Profile', sessions: 'Sessions', stats: 'Statistics', inventory: 'Inventory', advancements: 'Advancements' },
  slots: { 103: 'Helmet', 102: 'Chestplate', 101: 'Leggings', 100: 'Boots', '-106': 'Off hand' },
});
let playerList = [], playerFilter = '', currentPlayer = null, currentProfile = null, profileTab = 'profile';
let board = [], boardOrder = { k: 'played', d: -1 }, chartDays = 7, accountFilter = '';
// Which accounts to show: all, official only (Mojang UUIDs), offline or Bedrock. Shared by the list and the leaderboard.
const ACCOUNTS = translateObj({ '': 'All accounts', official: 'Official', offline: 'Unofficial', bedrock: 'Bedrock' });
const ofAccount = j => !accountFilter || j.account === accountFilter;
function paintAccountFilter(list) {
  const has = new Set(list.map(j => j.account));
  for (const c of document.querySelectorAll('[data-account-filter]'))
    c.innerHTML = Object.entries(ACCOUNTS).filter(([k]) => !k || has.has(k))
      .map(([k, t]) => `<button data-account="${k}" class="${k === accountFilter ? 'active' : ''}">${t}${k ? ` <span class="count">${list.filter(j => j.account === k).length}</span>` : ''}</button>`).join('');
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-account]'); if (!b) return;
  accountFilter = b.dataset.account; paintAccountFilter(playerList.length ? playerList : board); paintPlayerList(); paintBoard();
});

const num = n => Number(n ?? 0).toLocaleString(LOCALE);
const hours = s => !s ? '0 min' : s >= 3600 ? `${(s / 3600).toLocaleString(LOCALE, { maximumFractionDigits: 1 })} h` : `${Math.max(1, Math.round(s / 60))} min`;
const km = m => m >= 1000 ? `${(m / 1000).toLocaleString(LOCALE, { maximumFractionDigits: 1 })} km` : `${num(m)} m`;
const date = t => t ? new Date(t).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
const ago = t => { if (!t) return '—'; const m = (Date.now() - t) / 60e3;
  return m < 1.5 ? L('now') : m < 60 ? L`${Math.round(m)} min ago` : m < 1440 ? L`${Math.round(m / 60)} h ago` : L`${Math.round(m / 1440)} d ago`; };
// Flag of the country they last joined from (from flagcdn: on Windows, flag emojis are just letters).
const countryName = c => { try { return new Intl.DisplayNames([LOCALE], { type: 'region' }).of(c); } catch { return c; } };
const flag = ps => ps?.[0] ? `<img class="flag" alt="${esc(ps[0].country)}" title="${esc(ps.map(p => countryName(p.country)).join(', '))}" src="https://flagcdn.com/20x15/${esc(ps[0].country.toLowerCase())}.png">` : '';
const roman = n => ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'][n] ?? n;
const tex = id => `/api/texture/${encodeURIComponent(detail.texturesVersion)}/${encodeURIComponent(String(id).replace(/^minecraft:/, ''))}`;
// An item's image; if there is none, its initials (see the error handler below).
const itemIcon = (id, name, cls = 'item-icon') => `<img class="${cls} tex" alt="" loading="lazy" src="${tex(id)}" data-abbr="${esc((name ?? id).split(/[\s_:]+/).filter(x => x && !/^(of|the|de|del|la|el|los|las|minecraft)$/i.test(x)).slice(0, 2).map(x => x.slice(0, 4)).join(' '))}">`;
document.addEventListener('error', e => {
  const t = e.target; if (!t.classList?.contains('tex')) return;
  const s = document.createElement('span'); s.className = 'abbr'; s.textContent = t.dataset.abbr; t.replaceWith(s);
}, true);

window.onServerChange = () => { accountFilter = ''; playerList = []; currentPlayer = null; currentProfile = null; board = []; $('#profile').innerHTML = `<p class="empty">${L('Pick a player.')}</p>`; };
window.onTabChange = t => ({ players: loadPlayers, leaderboard: loadBoard, charts: loadCharts })[t]?.();

// ─────────────────────── Player list ───────────────────────

async function loadPlayers() {
  try { playerList = await api(`/api/server/${current}/players`); } catch { return; }
  paintPlayerList();
}
function paintPlayerList() {
  const q = $('#p-search').value.toLowerCase();
  paintAccountFilter(playerList);
  const l = playerList.filter(j => ofAccount(j) && (!playerFilter || j[playerFilter]) && j.name.toLowerCase().includes(q))
    .sort((a, b) => (b.online - a.online) || (b.last ?? 0) - (a.last ?? 0));
  $('#p-list').innerHTML = l.map(j => `<li data-uuid="${esc(j.uuid)}" class="${j.uuid === currentPlayer ? 'active' : ''}">${head(j.name)}
    <span class="grow">${esc(j.name)} ${flag(j.countries)}${j.otherAccount ? ` <span class="hint" title="${L('There\'s another account with this name (official and unofficial)')}">#${esc(j.otherAccount)}</span>` : ''}${j.online ? '<span class="dot-mini"></span>' : ''}<span class="mini">${hours(j.played)} · ${j.online ? L('online') : ago(j.last)}</span></span>
    ${j.op ? '<span class="tag">op</span>' : ''}${j.banned ? '<span class="tag red">ban</span>' : ''}</li>`).join('') || `<li class="hint">${L('Nobody.')}</li>`;
}
$('#p-search').addEventListener('input', paintPlayerList);
$('#p-filters').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  playerFilter = b.dataset.f; for (const x of $('#p-filters').children) x.classList.toggle('active', x === b); paintPlayerList();
});
$('#p-list').addEventListener('click', e => { const li = e.target.closest('[data-uuid]'); if (li) openProfile(li.dataset.uuid); });

// ─────────────────────── Profile ───────────────────────

async function openProfile(uuid) {
  currentPlayer = uuid; paintPlayerList();
  $('#profile').innerHTML = `<p class="empty">${L('Loading…')}</p>`;
  try { currentProfile = await api(`/api/server/${current}/player/${uuid}`); } catch (e) { $('#profile').innerHTML = `<p class="error">${esc(e.message)}</p>`; return; }
  if (profileTab === 'inventory' && currentProfile.inventory === undefined) profileTab = 'profile';
  paintProfile();
}
function paintProfile() {
  const p = currentProfile, tabs = Object.keys(TP.profileTabs).filter(k => k !== 'inventory' || p.inventory !== undefined);
  const tags = [p.online && `<span class="tag green">${L('online')}</span>`, p.op && '<span class="tag purple">op</span>',
    p.listed && `<span class="tag">${L('whitelist')}</span>`, p.banned && `<span class="tag red">${L('banned')}</span>`].filter(Boolean).join('');
  $('#profile').innerHTML = `
    <div class="profile-head">
      <img class="body-img" alt="" src="https://mc-heads.net/body/${faceOf(p.name)}/128">
      <div><h3>${esc(p.name)} ${flag(p.countries)}${p.otherAccount ? ` <span class="hint">#${esc(p.otherAccount)}</span>` : ''} ${tags}</h3>
        <div class="sub">${L('First seen: {} · Last: {} · Played: {}', date(p.first), p.online ? L('now') : ago(p.last), hours(p.played))}</div>
        ${p.countries?.length ? `<div class="sub">${L('Joins from:')} ${p.countries.map(x => `${esc(countryName(x.country))} (${x.count})`).join(', ')}</div>` : ''}
        ${can('moderate') && p.online ? `<button class="small" id="p-actions" style="margin-top:.5rem">${L('Actions…')}</button>` : ''}</div>
    </div>
    <div class="chips" id="p-sub">${tabs.map(k => `<button data-sub="${k}" class="${k === profileTab ? 'active' : ''}">${TP.profileTabs[k]}</button>`).join('')}</div>
    <div id="p-content" style="margin-top:10px">${{ profile: htmlSummary, sessions: htmlSessions, stats: htmlStats, inventory: htmlInventory, advancements: htmlAdvancements }[profileTab](p)}</div>`;
}
$('#profile').addEventListener('click', e => {
  const b = e.target.closest('[data-sub]'); if (b) { profileTab = b.dataset.sub; return paintProfile(); }
  if (e.target.id === 'p-actions') return openPlayer(currentProfile.name);
  const r = e.target.closest('.slot[data-i]'); if (r) $('#item-detail').innerHTML = itemDetail(profileItems[r.dataset.i]);
});

function htmlSummary(p) {
  const st = p.stats, l = p.advancements;
  if (!st && !p.sessionList?.length) return `<p class="empty">${L('This server has no saved statistics for this player.')}</p>`;
  const c = (title, value, gold) => `<div class="record ${gold ? 'gold' : ''}"><span>${L(title)}</span><b>${value}</b></div>`;
  return `<div class="records">
    ${c('Time played', hours(p.played))}
    ${c('Sessions', p.sessions != null ? num(p.sessions) : '—')}
    ${c('Longest session', p.longestSession ? hours(p.longestSession.duration / 1e3) : '—', true)}
    ${st ? c('Mobs killed', num(st.mobKills)) : ''}
    ${st ? c('Diamonds mined', num(st.diamonds), true) : ''}
    ${st ? c('Distance travelled', km(st.distance), true) : ''}
    ${st ? c('Deaths', num(st.deaths)) : ''}
    ${st ? c('Without dying', hours(st.sinceDeath)) : ''}
    ${st?.playerKills ? c('PvP kills', num(st.playerKills)) : ''}
    ${st ? c('Blocks mined', num(st.mined)) : ''}
    ${l ? c('Advancements', `${l.done.length}${l.total ? ` / ${l.total}` : ''}`) : ''}
  </div>${st?.saved ? `<p class="hint">${L('Statistics saved {} (the server saves them every few minutes and when players leave).', ago(st.saved))}</p>` : ''}`;
}

// Hours per day over the 30 days up to their last session (so something still shows if they haven't played for a while).
function dayBars(sessions, days = 30) {
  const today = new Date(Math.max(...sessions.map(s => s.start))); today.setHours(0, 0, 0, 0);
  const h = Array(days).fill(0);
  for (const s of sessions) { const d = Math.floor((today.getTime() + 864e5 - s.start) / 864e5); if (d >= 0 && d < days) h[days - 1 - d] += (s.end - s.start) / 3600e3; }
  const max = Math.max(1, ...h), w = 600 / days;
  const recent = Date.now() - today.getTime() < 2 * 864e5;
  return `<div class="chart"><h3>${L('Hours per day')} <span>${recent ? L('last {} days', days) : L('{} days up to {}', days, date(today))}</span></h3><div class="chart-canvas"><svg viewBox="0 0 600 120" preserveAspectRatio="none">
    ${h.map((v, i) => `<rect x="${i * w + 1}" y="${110 - v / max * 100}" width="${w - 2}" height="${v / max * 100}" fill="var(--purple)" rx="2"><title>${v.toFixed(1)} h</title></rect>`).join('')}
    </svg><span class="axis up">${max.toFixed(1)} h</span></div></div>`;
}
function htmlSessions(p) {
  if (!p.sessionList) return `<p class="empty">${L('This server doesn\'t have Plan: no session history.')}</p>`;
  if (!p.sessionList.length) return `<p class="empty">${L('No sessions.')}</p>`;
  return `${dayBars(p.sessionList)}<table style="margin-top:10px"><thead><tr>${['Start', 'Duration', 'Mobs', 'Deaths', 'AFK'].map(x => `<th>${L(x)}</th>`).join('')}</tr></thead><tbody>
    ${p.sessionList.slice(0, 100).map(s => `<tr><td>${new Date(s.start).toLocaleString(LOCALE, { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })}</td>
      <td>${hours((s.end - s.start) / 1e3)}</td><td>${num(s.kills)}</td><td>${num(s.deaths)}</td><td>${s.afk ? hours(s.afk / 1e3) : '—'}</td></tr>`).join('')}</tbody></table>`;
}
function htmlStats(p) {
  const st = p.stats; if (!st) return `<p class="empty">${L('No saved statistics.')}</p>`;
  const row = (k, v) => `<dt>${L(k)}</dt><dd>${v}</dd>`;
  const top = (title, l, egg) => `<div><h3>${L(title)}</h3><ul class="list top">${l.map(o => `<li>${itemIcon(egg ? `${o.id.split(':')[1]}_spawn_egg` : o.id, o.name)}
    <span class="grow">${esc(o.name)}</span><span class="n">${num(o.n)}</span></li>`).join('') || `<li class="hint">${L('Nothing.')}</li>`}</ul></div>`;
  return `<dl class="facts" style="max-width:420px">${row('Time played', hours(st.played))}${row('Distance', km(st.distance))}${row('Jumps', num(st.jumps))}
    ${row('Damage dealt', num(st.damageDealt) + ' ❤')}${row('Damage taken', num(st.damageTaken) + ' ❤')}${row('Items crafted', num(st.crafted))}
    ${row('Fish caught', num(st.fished))}${row('Animals bred', num(st.animalsBred))}${row('Villager trades', num(st.traded))}
    ${row('Ancient debris', num(st.debris))}${row('Times left the game', num(st.quits))}</dl>
    <div class="two">${top('Most mined', st.topMined)}${top('Most used', st.topUsed)}
      ${top('Mobs they killed', st.topKilled, true)}${top('Killed by', st.topKilledBy, true)}</div>`;
}

let profileItems = [];
function slot(o, label) {
  if (!o) return `<div class="slot blank" title="${esc(label ?? '')}"></div>`;
  const i = profileItems.push(o) - 1, name = o.name ?? o.gameName;
  const wear = o.maxDamage ? `<span class="wear"><i style="width:${Math.round((1 - (o.damage ?? 0) / o.maxDamage) * 100)}%"></i></span>` : '';
  return `<div class="slot ${o.enchantments ? 'enchanted' : ''}" data-i="${i}" title="${esc(name)}${o.n > 1 ? ` ×${o.n}` : ''}">
    ${itemIcon(o.id, o.gameName, '')}${o.n > 1 ? `<span class="num">${o.n}</span>` : ''}${wear}</div>`;
}
function itemDetail(o) {
  const enc = Object.entries(o.enchantments ?? {}).map(([k, v]) => `${esc(k)} ${roman(v)}`).join(', ');
  return `<b>${esc(o.name ?? o.gameName)}</b>${o.name ? ` <span class="hint">(${esc(o.gameName)})</span>` : ''}${o.n > 1 ? ` ×${o.n}` : ''}
    ${enc ? `<div style="color:var(--purple)">${enc}</div>` : ''}${o.damage ? `<div class="hint">${L('Wear:')} ${o.damage}${o.maxDamage ? ` / ${o.maxDamage}` : ''}</div>` : ''}
    <div class="hint">${esc(o.id)}</div>`;
}
function htmlInventory(p) {
  const v = p.inventory; if (!v) return `<p class="empty">${L('No saved inventory for this player.')}</p>`;
  profileItems = [];
  const bySlot = (l, s) => l?.find(o => o.slot === s);
  const row = (l, from, to) => Array.from({ length: to - from }, (_, k) => slot(bySlot(l, from + k))).join('');
  return `<p class="hint">${v.live ? `🟢 ${L('Live')}` : L('Saved {}', ago(v.saved))}${v.health != null ? ` · ❤ ${Math.round(v.health)} · 🍗 ${v.food} · ${L('level {}', v.level)}` : ''}</p>
    <h3>${L('Armour and off hand')}</h3><div class="inv armor">${[103, 102, 101, 100].map(k => slot(bySlot(v.armor, k), TP.slots[k])).join('')}${slot(v.offhand?.[0], TP.slots[-106])}</div>
    <h3>${L('Inventory')}</h3><div class="inv">${row(v.inventory, 9, 36)}</div><div class="inv">${row(v.inventory, 0, 9)}</div>
    <h3>${L('Ender chest')}</h3><div class="inv">${row(v.ender, 0, 27)}</div>
    <div class="item-detail" id="item-detail"><span class="hint">${L('Click an item to see its details.')}</span></div>`;
}
function htmlAdvancements(p) {
  const l = p.advancements; if (!l?.done.length) return `<p class="empty">${L('No advancements yet.')}</p>`;
  return `<div class="sub">${l.total ? L('{} of {} advancements', l.done.length, l.total) : L('{} advancements', l.done.length)}</div>
    ${l.total ? `<div class="progress"><i style="width:${Math.round(l.done.length / l.total * 100)}%"></i></div>` : ''}
    <ul class="list">${l.done.map(h => `<li>🏆 <span class="grow">${esc(h.title)}</span><span class="hint">${h.date ? date(h.date) : ''}</span></li>`).join('')}</ul>`;
}

// ─────────────────────── Leaderboard ───────────────────────

const COLUMNS = [['name', 'Player'], ['style', 'Style'], ['played', 'Played', hours], ['sessions', 'Sessions', num], ['deaths', 'Deaths', num],
  ['mobKills', 'Mobs', num], ['playerKills', 'PvP', num], ['distance', 'Distance', km], ['mined', 'Mined', num], ['diamonds', 'Diamonds', num], ['advancements', 'Advancements', num]].map(([c, t, f]) => [c, L(t), f]);
async function loadBoard() { try { board = await api(`/api/server/${current}/leaderboard`); } catch { return; } paintBoard(); }
function paintBoard() {
  if (!board.length) { $('#t-leaderboard').innerHTML = `<p class="empty">${L('Nobody has saved playtime yet.')}</p>`; return; }
  const { k, d } = boardOrder;
  paintAccountFilter(board);
  const l = board.filter(ofAccount).sort((a, b) => (typeof a[k] === 'string' || typeof b[k] === 'string' ? String(a[k] ?? '').localeCompare(String(b[k] ?? '')) : (a[k] ?? 0) - (b[k] ?? 0)) * d);
  $('#t-leaderboard').innerHTML = `<table><thead><tr><th>#</th>${COLUMNS.map(([c, t]) => `<th class="sortable ${c === k ? 'sorted' : ''}" data-col="${c}">${t}${c === k ? (d < 0 ? ' ▾' : ' ▴') : ''}</th>`).join('')}</tr></thead><tbody>
    ${l.map((j, i) => `<tr class="clickable" data-uuid="${esc(j.uuid)}"><td class="hint">${i + 1}</td><td>${head(j.name)}${esc(j.name)} ${flag(j.countries)}${j.otherAccount ? ` <span class="hint">#${esc(j.otherAccount)}</span>` : ''}</td>
      <td>${j.style ? `<span class="tag purple">${TP.styles[j.style]} ${j.score}</span>` : ''}</td>
      ${COLUMNS.slice(2).map(([c, , f]) => `<td>${f(j[c])}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}
$('#t-leaderboard').addEventListener('click', e => {
  const th = e.target.closest('[data-col]');
  if (th) { const c = th.dataset.col; boardOrder = { k: c, d: boardOrder.k === c ? -boardOrder.d : (c === 'name' ? 1 : -1) }; return paintBoard(); }
  const tr = e.target.closest('[data-uuid]');
  if (tr) { changeTab('players'); openProfile(tr.dataset.uuid); }
});

// ─────────────────────── Charts (from Plan) ───────────────────────

function line(title, points, { min = 0, max, color = 'var(--purple)', fmt = v => num(Math.round(v)), sub = '' } = {}) {
  const p = points.filter(x => x.v != null && x.v >= 0);
  if (!p.length) return '';
  const t0 = p[0].t, t1 = p.at(-1).t || t0 + 1, top = max ?? Math.max(1, ...p.map(x => x.v)), W = 600, H = 120;
  const x = t => ((t - t0) / Math.max(1, t1 - t0)) * W, y = v => H - 12 - ((v - min) / Math.max(1e-9, top - min)) * (H - 24);
  const d = p.map((q, i) => `${i ? 'L' : 'M'}${x(q.t).toFixed(1)},${y(q.v).toFixed(1)}`).join(' ');
  const avg = p.reduce((a, q) => a + q.v, 0) / p.length;
  const f = t => new Date(t).toLocaleString(LOCALE, { day: '2-digit', month: '2-digit', hour: chartDays <= 2 ? '2-digit' : undefined, minute: chartDays <= 2 ? '2-digit' : undefined });
  return `<div class="chart"><h3>${L(title)} <span>${sub || L('average {}', fmt(avg))}</span></h3>
    <div class="chart-canvas"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><path d="${d} L${W},${H - 12} L0,${H - 12} Z" fill="${color}" opacity=".12"/><path d="${d}" fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>
    <span class="axis up">${fmt(top)}</span><span class="axis left">${f(t0)}</span><span class="axis right">${f(t1)}</span></div></div>`;
}
async function loadCharts() {
  $('#charts').innerHTML = `<p class="empty">${L('Loading…')}</p>`;
  let g; try { g = await api(`/api/server/${current}/charts?days=${chartDays}`); } catch { return; }
  if (!g) { $('#charts').innerHTML = `<p class="empty">${L('This server doesn\'t have Plan: no history.')}</p>`; return; }
  const s = k => g.tps.map(x => ({ t: x.t, v: x[k] }));
  const days = g.perDay.map(x => ({ t: x.t, v: x.players }));
  $('#charts').innerHTML = (line('Players online', s('players'), { color: 'var(--green)', sub: L('max {}', Math.max(0, ...g.tps.map(x => x.players))) })
    + line('TPS', s('tps'), { min: 0, max: 20, color: 'var(--blue)', fmt: v => v.toFixed(1) })
    + line('RAM (MB)', s('ram'), { color: 'var(--yellow)' })
    + line('CPU (%)', s('cpu'), { color: 'var(--red)', fmt: v => v.toFixed(0) })
    + line('Unique players per day', days, { color: 'var(--purple)', sub: L('last {} days', Math.max(chartDays, 30)) }))
    || `<p class="empty">${L('Plan has no data for this period (the server was asleep).')}</p>`;
}
$('#c-days').addEventListener('click', e => {
  const b = e.target.closest('[data-days]'); if (!b) return;
  chartDays = Number(b.dataset.days); for (const x of $('#c-days').children) x.classList.toggle('active', x === b); loadCharts();
});
