// WardenPanel in the browser: no libraries. Everything that comes from the game (names, chat) goes through esc().
'use strict';
const $ = s => document.querySelector(s);

// ─────────────────────── Language ───────────────────────
// Texts are written in English and L() translates them with the dictionary in es.js (anything missing stays in English).
// L('text') or L`text with ${value}`: in the dictionary each value is {} (or {0}, {1}… to change the order).
// The language: the one the user picked (saved on the panel) or, if none, English unless the browser is in Spanish.
const LANGS = { en: 'English', es: 'Español' };
const LANG = (() => { try { const g = localStorage.getItem('lang'); if (LANGS[g]) return g; } catch {} return navigator.languages?.some(l => /^es\b/i.test(l)) ? 'es' : 'en'; })();
const LOCALE = LANG === 'es' ? 'es-ES' : navigator.languages?.find(l => /^en\b/i.test(l)) ?? 'en-GB';
const DICT = LANG === 'es' ? window.ES ?? {} : {};
function L(s, ...v) {
  if (Array.isArray(s)) s = s.join('{}');
  let i = 0; return String(DICT[s] ?? s).replace(/\{(\d*)\}/g, (_, n) => v[n === '' ? i++ : Number(n)] ?? '');
}
const translateObj = o => Array.isArray(o) ? o.map(translateObj) : o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, translateObj(v)])) : typeof o === 'string' ? L(o) : o;
// The static page (index.html): texts, placeholder and title; what has bold or links inside, whole (data-l).
document.documentElement.lang = LANG;
if (LANG !== 'en') {
  document.title = L(document.title);
  for (const el of document.querySelectorAll('[data-l]')) el.innerHTML = L(el.innerHTML.trim().replace(/\s+/g, ' '));
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n; (n = w.nextNode());) { const t = n.nodeValue.trim(); if (t && DICT[t]) n.nodeValue = n.nodeValue.replace(t, DICT[t]); }
  for (const el of document.querySelectorAll('[placeholder], [title]')) for (const a of ['placeholder', 'title']) { const t = el.getAttribute(a); if (t && DICT[t]) el.setAttribute(a, DICT[t]); }
}
function changeLanguage(l) {
  try { localStorage.setItem('lang', l); } catch {}
  (me ? api('/api/preferences', 'PUT', { language: l }) : Promise.resolve()).catch(() => {}).finally(() => location.reload());
}
for (const sel of document.querySelectorAll('.lang select')) {
  sel.innerHTML = Object.entries(LANGS).map(([k, v]) => `<option value="${k}" ${k === LANG ? 'selected' : ''}>${v}</option>`).join('');
  sel.addEventListener('change', () => changeLanguage(sel.value));
}
const esc = t => String(t ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// The fixed texts, together (translated on load).
const T = translateObj({
  states: { asleep: '💤 Asleep', starting: '⏳ Starting…', awake: '🟢 Awake' },
  types: { paper: 'Paper', fabric: 'Fabric', vanilla: 'Vanilla' },
  events: { join: ['🟢', 'joined'], leave: ['⚪', 'left'], chat: ['💬', ''], death: ['💀', ''], advancement: ['🏆', 'made the advancement'],
    travel: ['🌀', 'went to'], sleep: ['🛏', 'went to bed'] },
  dimensions: { normal: '🌍 Overworld', nether: '🔥 Nether', the_end: '🌌 End' },
  modes: { survival: 'Survival', creative: 'Creative', adventure: 'Adventure', spectator: 'Spectator' },
  permissions: { view: 'view', chat: 'chat', moderate: 'moderate', ban: 'ban', whitelist: 'whitelist', investigate: 'investigate', inventories: 'inventories',
    items: 'items', world: 'world settings', power: 'power', console: 'console' },
  profiles: { '': '—', viewer: 'Spectator', moderator: 'Moderator', admin: 'Administrator', console: 'Administrator with console' },
  notices: { console: 'Console (by others)', ban: 'Ban and unban', power: 'Wake, sleep, restart', whitelist: 'Whitelist',
    world: 'World settings (rules, difficulty, time, weather)', failures: 'Failed sign-in attempts', users: 'User changes', other: 'Everything else' },
  noticeModes: { now: 'Instantly', summary: 'In the summary', off: 'Nothing' },
});

let me = null, site = {}, servers = [], current = null, detail = null;
let events = [], lastEvent = 0, consoleEnd = null, tab = 'activity', dialogPlayer = null;

// ─────────────────────── Utilities ───────────────────────

async function api(route, method = 'GET', body) {
  // What is asked about a server: if the user switches to another one meanwhile, it's no longer valid (it would be painted
  // over the new one). It's left unanswered, so whoever asked paints nothing. Actions (POST…) do finish.
  const of = method === 'GET' && /^\/api\/server\/([^/?]+)/.exec(route)?.[1];
  if (of) { const d = await api2(route, method, body); return decodeURIComponent(of) === current ? d : new Promise(() => {}); }
  return api2(route, method, body);
}
async function api2(route, method, body) {
  const r = await fetch(route, { method, headers: method === 'GET' ? {} : { 'content-type': 'application/json', 'x-warden': '1' },
    body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (r.status === 401 && route !== '/api/login' && route !== '/api/password') { show('login'); throw new Error(L(d.error || 'not signed in')); }
  if (r.status === 403 && d.mustChange) { show('password'); throw new Error(L(d.error)); }
  if (!r.ok) throw new Error(L(d.error || `error ${r.status}`));
  return d;
}
function toast(text, bad = false) {
  const a = $('#toast'); a.textContent = text; a.className = 'toast' + (bad ? ' bad' : ''); a.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { a.hidden = true; }, 4000);
}
const clock = t => { const d = new Date(t), today = new Date().toDateString() === d.toDateString();
  return (today ? '' : d.toLocaleDateString(LOCALE, { day: '2-digit', month: '2-digit' }) + ' ') + d.toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' }); };
const duration = ms => { const m = Math.max(0, Math.round(ms / 60e3)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };
// By UUID for a known official account (detail.faces): by name, mc-heads sometimes can't find it and returns Steve.
const faceOf = n => detail?.faces?.[String(n).toLowerCase()] ?? encodeURIComponent(String(n).replace(/^\./, ''));
const head = n => `<img class="head" alt="" loading="lazy" src="https://mc-heads.net/avatar/${faceOf(n)}/24">`;
// No skin (Bedrock, offline accounts…): the head stays blank. Here and not in onerror=: the CSP allows no JS in the HTML.
document.addEventListener('error', e => { if (e.target.classList?.contains('head')) e.target.style.visibility = 'hidden'; }, true);
const can = p => detail?.permissions?.includes(p);
// The MOTD as in the server list: each line centred (without the spaces that centre it in the game) and with § colours.
const MC_COLORS = { 0: '#000', 1: '#00a', 2: '#0a0', 3: '#0aa', 4: '#a00', 5: '#a0a', 6: '#fa0', 7: '#aaa', 8: '#555', 9: '#55f', a: '#5f5', b: '#5ff', c: '#f55', d: '#f5f', e: '#ff5', f: '#fff' };
function motdHTML(t) {
  return String(t).split('\n').slice(0, 2).map(line => {
    let html = '', style = {};
    for (const [i, part] of line.trim().split(/§([0-9a-fk-or])/i).entries()) {
      if (i % 2) { const c = part.toLowerCase(); if (MC_COLORS[c] || c === 'r') style = MC_COLORS[c] ? { color: MC_COLORS[c] } : {};
        else style = { ...style, ...{ l: { fontWeight: 700 }, o: { fontStyle: 'italic' }, n: { textDecoration: 'underline' }, m: { textDecoration: 'line-through' } }[c] }; continue; }
      if (!part) continue;
      const css = [style.color && `color:${style.color}`, style.fontWeight && 'font-weight:700', style.fontStyle && 'font-style:italic', style.textDecoration && `text-decoration:${style.textDecoration}`].filter(Boolean).join(';');
      html += css ? `<span style="${css}">${esc(part)}</span>` : esc(part);
    }
    return `<div>${html}</div>`;
  }).join('');
}
const address = s => !site.domain ? `:${s.public}` : s.name === site.rootServer ? site.domain : `${s.name}.${site.domain}`;

function show(view) {
  for (const v of ['login', 'password', 'panel']) $(`#v-${v}`).hidden = v !== view;
  if (view === 'password') { $('#password-cancel').hidden = !me || me.mustChange; $('#password-hint').textContent = me?.mustChange
    ? L('This is your first time: change the temporary password to one of your own (at least 10 characters).') : L('At least 10 characters.'); }
}
function go(page) {
  for (const p of ['server', 'users', 'log', 'settings']) $(`#${p}`).hidden = p !== page;
  $('#menu').hidden = true;
  if (page === 'users') loadUsers();
  if (page === 'log') loadLog();
  if (page === 'settings') loadSettings();
  if (page !== 'server') for (const b of document.querySelectorAll('#servers button')) b.classList.remove('active');
}

// ─────────────────────── Sign in ───────────────────────

$('#f-login').addEventListener('submit', async e => {
  e.preventDefault(); const f = new FormData(e.target); $('#e-login').textContent = '';
  try { await api('/api/login', 'POST', { user: f.get('user'), password: f.get('password') }); await start(); }
  catch (er) { $('#e-login').textContent = er.message; }
});
$('#f-password').addEventListener('submit', async e => {
  e.preventDefault(); const f = new FormData(e.target); $('#e-password').textContent = '';
  if (f.get('next') !== f.get('again')) { $('#e-password').textContent = L('The two new passwords don\'t match.'); return; }
  try { await api('/api/password', 'POST', { current: f.get('current'), next: f.get('next') }); e.target.reset(); toast(L('Password changed.')); await start(); }
  catch (er) { $('#e-password').textContent = er.message; }
});
$('#password-cancel').addEventListener('click', () => show('panel'));
$('#b-logout').addEventListener('click', async () => { await api('/api/logout', 'POST').catch(() => {}); location.reload(); });
$('#b-menu').addEventListener('click', () => { $('#menu').hidden = !$('#menu').hidden; });
document.addEventListener('click', e => { if (!e.target.closest('.me')) $('#menu').hidden = true; });
$('#menu').addEventListener('click', e => {
  const b = e.target.closest('[data-go]'); if (!b) return;
  if (b.dataset.go === 'password') { $('#menu').hidden = true; show('password'); }
  else if (b.dataset.go === 'tabs') { $('#menu').hidden = true; orderTabs(TAB_ORDER); api('/api/preferences', 'PUT', { tabs: null }).catch(() => {}); toast(L('Tabs back in their default order.')); }
  else { location.hash = b.dataset.go; }
});

async function start() {
  try { me = await api('/api/me'); } catch { return; }
  if (me.mustChange) return show('password');
  document.body.classList.toggle('owner', me.owner);
  $('#me-name').textContent = me.name;
  if (me.language && me.language !== LANG) { try { localStorage.setItem('lang', me.language); } catch {} return location.reload(); }
  if (!me.language) api('/api/preferences', 'PUT', { language: LANG }).catch(() => {});   // the first time, this browser's
  show('panel');
  orderTabs((await api('/api/preferences').catch(() => ({}))).tabs);
  await loadServers();
  if (location.hash.length > 1) route(); else if (servers[0]) pick(servers[0].name);
}

// ─────────────────────── Servers ───────────────────────

async function loadServers() {
  try { servers = await api('/api/servers'); } catch { return; }
  $('#servers').innerHTML = servers.map(s => `<button data-server="${esc(s.name)}" class="${s.name === current && $('#server').hidden === false ? 'active' : ''}">
    <span class="dot ${esc(s.state)}"></span>${esc(s.name)}${s.online ? ` <span class="count">${s.online}</span>` : ''}</button>`).join('')
    || `<span class="hint">${L('You have no servers assigned.')}</span>`;
}
$('#servers').addEventListener('click', e => { const b = e.target.closest('[data-server]'); if (b) location.hash = `s/${b.dataset.server}`; });

let switching = 0;
function pick(name) {
  const other = current !== name;
  if (other) { window.onServerChange?.(); current = name; events = []; lastEvent = 0; consoleEnd = null; $('#console').textContent = ''; $('#events').innerHTML = ''; $('#map').removeAttribute('src'); }
  go('server');
  for (const b of document.querySelectorAll('#servers button')) b.classList.toggle('active', b.dataset.server === name);
  paintEvents(); loadEvents();
  if (!other) return loadDetail();
  // Another server: what is shown is still the previous one's, so it can't be touched until the open tab reloads with
  // the new one (a click there would go to the new server with the old one's data). At most 10 s, in case something hangs.
  const mine = ++switching, ready = () => { if (mine === switching) $('#server').classList.remove('switching'); };
  $('#server').classList.add('switching'); setTimeout(ready, 10e3);
  loadDetail().then(() => mine === switching && changeTab(tab)).finally(ready);
}
function route() {
  const h = location.hash.slice(1);
  if (h.startsWith('s/')) return pick(h.slice(2));
  if (['users', 'log', 'settings'].includes(h) && me?.owner) return go(h);
  if (servers[0]) pick(servers[0].name);
}
addEventListener('hashchange', route);

async function loadDetail() {
  if (!current) return;
  try { detail = await api(`/api/server/${current}`); } catch (e) { return; }
  paintInfo(); paintPlayers(); paintAccess();
  for (const el of document.querySelectorAll('[data-perm]')) el.hidden = !can(el.dataset.perm);
  if (tab === 'console' && !can('console')) changeTab('activity');
}

function paintInfo() {
  const s = detail, awake = s.state === 'awake';
  const tps = s.tps?.[0], tpsClass = tps >= 19 ? 'tps-good' : tps >= 15 ? 'tps-mid' : 'tps-bad';
  let sleeps = '—';
  if (s.sleeps?.never) sleeps = L('never');
  else if (s.sleeps?.afterEmpty) sleeps = L`${Math.round(s.sleeps.afterEmpty / 60)} min after the last player leaves`;
  else if (s.sleeps?.at) sleeps = s.sleeps.at <= Date.now() ? L('shortly') : L`at ${new Date(s.sleeps.at).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' })}`;
  const memory = s.memory ? `${Math.round(s.memory.used / 1048576)} / ${Math.round(s.memory.max / 1048576)} MB` : null;
  const row = (k, v) => v == null || v === '' ? '' : `<dt>${L(k)}</dt><dd>${v}</dd>`;
  $('#c-info').innerHTML = `
    <h2>${esc(s.name)} <span class="state ${esc(s.state)}">${T.states[s.state]}</span>${s.icon ? `<img class="server-icon" alt="" src="/api/server/${esc(s.name)}/icon">` : ''}</h2>
    ${s.motd ? `<div class="motd">${motdHTML(s.motd)}</div>` : ''}
    <dl class="facts">
      ${row('Version', `${esc(T.types[s.type] ?? s.type)} ${esc(s.version)}`)}
      ${row('Players', awake ? `${s.online}${s.max ? ` / ${s.max}` : ''}` : '0')}
      ${row('TPS', tps != null ? `<span class="${tpsClass}">${tps.toFixed(1)}</span> · ${esc(s.mspt)} ms/tick` : null)}
      ${row('Memory (Java)', memory)}
      ${row('Process RAM', s.process ? `${s.process.mb} MB` : null)}
      ${row('CPU', s.process?.cpu != null ? `${s.process.cpu} %` : null)}
      ${row('Address', `<code>${esc(address(s))}</code>`)}
      ${row('Will sleep', awake ? esc(sleeps) : null)}
    </dl>
    ${can('power') ? `<div class="controls">
      ${s.state === 'asleep' ? `<button class="primary" data-power="wake">▶ ${L('Wake up')}</button>` : ''}
      ${awake ? `<button data-power="restart">↻ ${L('Restart')}</button><button class="danger" data-power="sleep">⏹ ${L('Sleep')}</button>` : ''}
    </div>` : ''}
    <div class="links">
      ${s.map ? `<a href="${esc(s.map)}" target="_blank" rel="noopener">🗺 BlueMap ↗</a>` : ''}
      ${s.plan ? `<a href="${esc(s.plan)}" target="_blank" rel="noopener">📈 Plan ↗</a>` : ''}
      ${s.webconsole && can('console') ? `<a href="${esc(s.webconsole)}" target="_blank" rel="noopener">🖥 WebConsole ↗</a>` : ''}
    </div>`;
}
$('#c-info').addEventListener('click', async e => {
  const b = e.target.closest('[data-power]'); if (!b) return;
  const what = b.dataset.power, n = detail.online;
  if (what !== 'wake' && !confirm(L(what === 'sleep' ? 'Put {} to sleep?' : 'Restart {}?', detail.name) + (n ? ' ' + L('There are {} player(s) online: they will be kicked.', n) : ''))) return;
  b.disabled = true;
  try { await api(`/api/server/${current}/action`, 'POST', { type: what }); toast(L(what === 'wake' ? 'Waking it up: takes ~1 minute.' : what === 'sleep' ? 'Putting it to sleep…' : 'Restarting: takes ~1-2 minutes.')); }
  catch (er) { toast(er.message, true); }
  setTimeout(loadDetail, 1500);
});

function paintPlayers() {
  const s = detail, js = s.players ?? [];
  $('#n-players').textContent = s.state === 'awake' ? `${s.online}${s.max ? ` / ${s.max}` : ''}` : '';
  if (s.state !== 'awake') { $('#c-players').innerHTML = `<p class="empty">${L(s.state === 'asleep' ? 'It\'s asleep.' : 'Starting…')}</p>`; return; }
  if (!js.length) { $('#c-players').innerHTML = `<p class="empty">${s.online ? L('{} online; the server doesn\'t say who.', s.online) : L('Nobody online.')}</p>`; return; }
  const full = s.plugin;
  $('#c-players').innerHTML = `<table><thead><tr><th>${L('Player')}</th>${full ? `<th>⏱</th><th>${L('Position')}</th><th>❤</th><th>🍗</th><th>Ping</th><th>${L('Mode')}</th>` : ''}</tr></thead><tbody>
    ${js.map(j => `<tr class="clickable" data-player="${esc(j.name)}"><td>${head(j.name)}${esc(j.name)}${j.op ? ' <span class="tag">op</span>' : ''}</td>
      ${full ? `<td>${duration(Date.now() - j.since)}</td>
      <td title="${esc(j.world)}">${esc((T.dimensions[j.dimension] ?? j.dimension).split(' ')[0])} ${j.x}, ${j.y}, ${j.z}</td>
      <td>${Math.round(j.health)}/${Math.round(j.maxHealth)}</td><td>${j.food}</td><td>${j.ping} ms</td><td>${esc(T.modes[j.mode] ?? j.mode)}</td>` : ''}</tr>`).join('')}
    </tbody></table>${full ? '' : `<p class="hint">${L('Without the WardenPanel plugin only names are shown.')}</p>`}`;
}
$('#c-players').addEventListener('click', e => { const tr = e.target.closest('[data-player]'); if (tr) openPlayer(tr.dataset.player); });

// ─────────────────────── Actions on a player ───────────────────────

const ACTIONS = [
  ['message', '💬 Message', 'moderate'], ['tp', '📍 Teleport', 'moderate'], ['mode', '🎮 Game mode', 'moderate'],
  ['heal', '❤ Heal', 'moderate'], ['give', '🎁 Give item', 'items'], ['kick', '👢 Kick', 'moderate'], ['ban', '⛔ Ban', 'ban'],
].map(([k, t, p]) => [k, L(t), p]);
function openPlayer(name) {
  dialogPlayer = name;
  $('#dp-name').innerHTML = `${head(name)}${esc(name)}`;
  const avail = ACTIONS.filter(a => can(a[2]));
  $('#dp-actions').innerHTML = avail.map(([k, t]) => `<button type="button" data-action="${k}" class="${k === 'ban' || k === 'kick' ? 'danger' : ''}">${t}</button>`).join('')
    || `<p class="hint">${L('You don\'t have permission to do anything to players.')}</p>`;
  $('#dp-extra').innerHTML = ''; $('#e-player').textContent = '';
  $('#d-player').showModal();
}
$('#dp-actions').addEventListener('click', e => {
  const b = e.target.closest('[data-action]'); if (!b) return;
  const k = b.dataset.action, others = (detail.players ?? []).map(j => j.name).filter(n => n !== dialogPlayer);
  const fields = {
    message: `<label>${L('Message')} <input name="text" maxlength="250" required></label>`,
    tp: `<label>${L('To another player')} <select name="target"><option value="">${L('— (to coordinates)')}</option>${others.map(n => `<option>${esc(n)}</option>`).join('')}</select></label>
         <div class="row"><input name="x" placeholder="x" inputmode="numeric"><input name="y" placeholder="y" inputmode="numeric"><input name="z" placeholder="z" inputmode="numeric"></div>`,
    mode: `<label>${L('Mode')} <select name="mode">${Object.entries(T.modes).map(([k2, v]) => `<option value="${k2}">${v}</option>`).join('')}</select></label>`,
    heal: `<p class="sub">${L('Fills their health and hunger.')}</p>`,
    give: `<label>${L('Item')} <input name="item" placeholder="minecraft:diamond" required pattern="[a-z0-9_.:\\-]+"></label><label>${L('Amount')} <input name="amount" type="number" min="1" max="6400" value="1"></label>`,
    kick: `<label>${L('Reason (optional)')} <input name="reason" maxlength="120"></label>`,
    ban: `<label>${L('Reason (optional)')} <input name="reason" maxlength="120"></label><p class="sub">${L('They won\'t be able to join again until you unban them (Access tab).')}</p>`,
  }[k];
  $('#dp-extra').innerHTML = `${fields}<button type="button" class="primary" data-do="${k}">${esc(b.textContent)}</button>`;
  $('#dp-extra').querySelector('input, select')?.focus();
});
$('#dp-extra').addEventListener('click', async e => {
  const b = e.target.closest('[data-do]'); if (!b) return;
  const data = { type: b.dataset.do, player: dialogPlayer };
  for (const el of $('#dp-extra').querySelectorAll('input, select')) {
    if (!el.checkValidity()) { el.reportValidity(); return; }
    data[el.name] = el.value;
  }
  if (data.type === 'ban' && !confirm(L`Ban ${dialogPlayer}?`)) return;
  b.disabled = true; $('#e-player').textContent = '';
  try { await api(`/api/server/${current}/action`, 'POST', data); toast(L('Done.')); $('#d-player').close(); setTimeout(loadDetail, 800); }
  catch (er) { $('#e-player').textContent = er.message; b.disabled = false; }
});

// ─────────────────────── Activity, chat and console ───────────────────────

// Tabs can be reordered by dragging them (with a finger, after a long press); the order is saved per user.
const TAB_ORDER = [...document.querySelectorAll('#sub button')].map(b => b.dataset.tab);
function orderTabs(order) {
  const nav = $('#sub'), all = [...nav.children];
  // the saved ones first, in their order; then any missing (new tabs), each only once
  for (const t of new Set([...(order ?? []).filter(x => TAB_ORDER.includes(x)), ...TAB_ORDER])) {
    const b = all.find(x => x.dataset.tab === t); if (b) nav.appendChild(b);
  }
}
let drag = null;
$('#sub').addEventListener('pointerdown', e => {
  const b = e.target.closest('button'); if (!b) return;
  drag = { b, x: e.clientX, active: false, moved: false, wait: e.pointerType === 'mouse' ? null : setTimeout(() => { if (drag) drag.active = true; b.classList.add('dragging'); }, 400) };
});
$('#sub').addEventListener('pointermove', e => {
  if (!drag) return;
  if (!drag.active && e.pointerType === 'mouse' && Math.abs(e.clientX - drag.x) > 8) { drag.active = true; drag.b.classList.add('dragging'); }
  if (!drag.active) { if (Math.abs(e.clientX - drag.x) > 8) clearTimeout(drag.wait); return; }
  e.preventDefault();
  const over = document.elementFromPoint(e.clientX, e.clientY)?.closest('#sub button');
  if (over && over !== drag.b) {
    const r = over.getBoundingClientRect();
    over.parentNode.insertBefore(drag.b, e.clientX < r.left + r.width / 2 ? over : over.nextSibling);
    drag.moved = true;
  }
});
document.addEventListener('pointerup', () => {
  if (!drag) return;
  clearTimeout(drag.wait); drag.b.classList.remove('dragging');
  if (drag.moved) { api('/api/preferences', 'PUT', { tabs: [...$('#sub').children].map(b => b.dataset.tab) }).catch(() => {}); drag.b.dataset.justMoved = '1'; }
  drag = null;
});
for (const b of document.querySelectorAll('#sub button')) b.addEventListener('click', () => {
  if (b.dataset.justMoved) { delete b.dataset.justMoved; return; }
  changeTab(b.dataset.tab);
});
function changeTab(t) {
  tab = t;
  for (const b of document.querySelectorAll('#sub button')) b.classList.toggle('active', b.dataset.tab === t);
  for (const p of document.querySelectorAll('[data-panel]')) p.hidden = p.dataset.panel !== t;
  if (t === 'map' && window.mapView !== 'heat') { const m = detail?.map; $('#map').hidden = !m; $('#map-missing').hidden = Boolean(m); if (m && $('#map').getAttribute('src') !== m) $('#map').src = m; }
  return Promise.all([window.onTabChange?.(t), t === 'console' && loadConsole()]);   // to know when it has loaded
}
async function loadEvents() {
  if (!current) return;
  const n = current;
  let fresh; try { fresh = await api(`/api/server/${n}/events?since=${lastEvent}`); } catch { return; }
  if (n !== current || !fresh.length) return;
  events.push(...fresh); lastEvent = fresh.at(-1).id; events = events.slice(-500);
  paintEvents();
}
function paintEvents() {
  const box = $('#events'), atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  const show = new Set([...document.querySelectorAll('#filters input:checked')].map(i => i.value));
  const list = events.filter(e => show.has(e.type));
  box.innerHTML = list.map(e => {
    const [icon, verb] = T.events[e.type] ?? ['•', e.type];
    let text;
    if (e.type === 'chat') text = `<span class="who">${esc(e.player)}</span>: ${esc(e.text)}`;
    else if (e.type === 'death') text = `<span class="who">${esc(e.player)}</span> ${esc((e.text ?? '').replace(e.player, '').trim() || L('died'))}`;
    else if (e.type === 'travel') text = `<span class="who">${esc(e.player)}</span> ${verb} ${esc(T.dimensions[e.text] ?? e.text)}`;
    else if (e.type === 'advancement') text = `<span class="who">${esc(e.player)}</span> ${verb} <b>[${esc(e.text)}]</b>`;
    else if (e.type === 'leave' && e.text) text = `<span class="who">${esc(e.player)}</span> ${verb} ${L`(after ${duration(Number(e.text))})`}`;
    else text = `<span class="who">${esc(e.player)}</span> ${verb}`;
    return `<li class="ev-${esc(e.type)}"><span>${icon}</span><span>${text}</span><span class="time">${clock(e.t)}</span></li>`;
  }).join('') || `<li class="empty">${L('Nothing has happened yet (or not with these filters).')}</li>`;
  if (atBottom) box.scrollTop = box.scrollHeight;
}
$('#filters').addEventListener('change', paintEvents);
$('#f-chat').addEventListener('submit', async e => {
  e.preventDefault(); const i = e.target.text; if (!i.value.trim()) return;
  try { await api(`/api/server/${current}/action`, 'POST', { type: 'chat', text: i.value }); i.value = ''; }
  catch (er) { toast(er.message, true); }
});

async function loadConsole() {
  if (!current || !can('console')) return;
  let d; try { d = await api(`/api/server/${current}/console${consoleEnd != null ? `?since=${consoleEnd}` : ''}`); } catch { return; }
  if (consoleEnd != null && d.end < consoleEnd) { $('#console').textContent = ''; consoleEnd = null; return loadConsole(); }  // a new log
  consoleEnd = d.end;
  if (!d.text) return;
  const pre = $('#console'), atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 60;
  pre.insertAdjacentHTML('beforeend', d.text.split('\n').map(l => l && /\/(WARN)\]/.test(l) ? `<span class="w">${esc(l)}</span>` : /\/(ERROR|FATAL)\]/.test(l) ? `<span class="e">${esc(l)}</span>` : esc(l)).join('\n'));
  if (pre.textContent.length > 300000) pre.textContent = pre.textContent.slice(-200000);
  if (atBottom) pre.scrollTop = pre.scrollHeight;
}
$('#f-console').addEventListener('submit', async e => {
  e.preventDefault(); const i = e.target.command; if (!i.value.trim()) return;
  try { await api(`/api/server/${current}/console`, 'POST', { command: i.value }); i.value = ''; setTimeout(loadConsole, 400); }
  catch (er) { toast(er.message, true); }
});

// ─────────────────────── Access ───────────────────────

function paintAccess() {
  const s = detail;
  $('#requires').textContent = L(s.requiresList ? '(required: anyone not on it gets a code for the Discord bot)' : '(this server doesn\'t require it: anyone can join)');
  $('#l-whitelist').innerHTML = s.whitelist.map(j => `<li>${head(j.name)}<span class="grow">${esc(j.name)}</span>
    ${j.all ? `<span class="tag">${L('all')}</span>` : ''}${j.discord ? '<span class="tag">Discord</span>' : ''}
    ${can('whitelist') ? `<button class="small danger" data-unlist="${esc(j.name)}">${L('Remove')}</button>` : ''}</li>`).join('') || `<li class="hint">${L('Nobody.')}</li>`;
  $('#l-ops').innerHTML = s.ops.map(o => `<li>${head(o.name)}<span class="grow">${esc(o.name)}</span><span class="tag">${L`level ${o.level}`}</span></li>`).join('') || `<li class="hint">${L('Nobody.')}</li>`;
  $('#l-ban').innerHTML = s.banned.map(b => `<li>${head(b.name)}<span class="grow" title="${esc(b.reason)}">${esc(b.name)} <span class="hint">${esc(b.reason ?? '')}</span></span>
    ${can('ban') ? `<button class="small" data-unban="${esc(b.name)}">${L('Unban')}</button>` : ''}</li>`).join('') || `<li class="hint">${L('Nobody.')}</li>`;
}
$('#f-whitelist').addEventListener('submit', async e => {
  e.preventDefault(); const i = e.target.player;
  try { await api(`/api/server/${current}/action`, 'POST', { type: 'whitelist-add', player: i.value.trim() }); i.value = ''; toast(L('Added.')); loadDetail(); }
  catch (er) { toast(er.message, true); }
});
document.querySelector('[data-panel="access"]').addEventListener('click', async e => {
  const q = e.target.closest('[data-unlist]'), d = e.target.closest('[data-unban]');
  if (!q && !d) return;
  const n = (q ?? d).dataset.unlist ?? (q ?? d).dataset.unban;
  if (q && !confirm(L`Remove ${n} from the ${current} whitelist?`)) return;
  try {
    await api(`/api/server/${current}/action`, 'POST', { type: q ? 'whitelist-remove' : 'unban', player: n });
    toast(L(q ? 'Removed.' : 'Unbanned (if it was asleep, it applies when it wakes up).')); setTimeout(loadDetail, 800);
  } catch (er) { toast(er.message, true); }
});

// ─────────────────────── Owner only: users, log and notifications ───────────────────────

let usersData = null;
async function loadUsers() {
  try { usersData = await api('/api/users'); } catch { return; }
  const { users } = usersData;
  const summary = p => Object.entries(p).map(([s, l]) => `<b>${s === '*' ? L('all') : esc(s)}</b>: ${l.map(x => T.permissions[x]).join(', ')}`).join(' · ') || `<span class="hint">${L('nothing')}</span>`;
  $('#t-users').innerHTML = users.length ? `<table><thead><tr><th>${L('Username')}</th><th>Minecraft</th><th>${L('Permissions')}</th><th></th></tr></thead><tbody>
    ${users.map(u => `<tr><td>${esc(u.name)}${u.mustChange ? ` <span class="tag">${L('not used yet')}</span>` : ''}</td><td>${esc(u.minecraft ?? '')}</td>
      <td style="white-space:normal">${summary(u.permissions)}</td>
      <td><button class="small" data-edit="${esc(u.name)}">${L('Edit')}</button> <button class="small" data-repass="${esc(u.name)}">${L('New password')}</button>
      <button class="small danger" data-delete="${esc(u.name)}">${L('Delete')}</button></td></tr>`).join('')}</tbody></table>` : `<p class="empty">${L('Nobody yet.')}</p>`;
  userForm();
}
function userForm(u) {
  const f = $('#f-user'), { servers: srvs, permissions, profiles } = usersData;
  f.reset(); f.name.readOnly = Boolean(u); f.name.value = u?.name ?? ''; f.minecraft.value = u?.minecraft ?? '';
  $('#u-title').textContent = u ? L`${u.name}'s permissions` : L('New user'); $('#u-password').textContent = ''; $('#e-user').textContent = '';
  $('#u-perms').innerHTML = ['*', ...srvs].map(s => {
    const has = u?.permissions?.[s] ?? [];
    const profile = Object.entries(profiles).find(([, l]) => l.length === has.length && l.every(x => has.includes(x)))?.[0] ?? '';
    return `<div class="perm-row" data-srv="${esc(s)}"><select data-profile>${Object.entries(T.profiles).map(([k, v]) => `<option value="${k}" ${k === profile ? 'selected' : ''}>${s === '*' && !k ? L('All: —') : v}</option>`).join('')}</select>
      <div class="checks"><b>${s === '*' ? L('All servers') : esc(s)}:</b> ${permissions.map(p => `<label><input type="checkbox" value="${p}" ${has.includes(p) ? 'checked' : ''}>${T.permissions[p]}</label>`).join('')}</div></div>`;
  }).join('');
}
$('#u-perms').addEventListener('change', e => {
  if (!e.target.matches('[data-profile]')) return;
  const row = e.target.closest('.perm-row'), l = usersData.profiles[e.target.value] ?? [];
  for (const c of row.querySelectorAll('input[type=checkbox]')) c.checked = l.includes(c.value);
});
$('#u-new').addEventListener('click', () => userForm());
$('#f-user').addEventListener('submit', async e => {
  e.preventDefault(); const f = e.target;
  const permissions = Object.fromEntries([...document.querySelectorAll('#u-perms .perm-row')].map(row =>
    [row.dataset.srv, [...row.querySelectorAll('input:checked')].map(c => c.value)]));
  try {
    const r = await api(`/api/users/${encodeURIComponent(f.name.value.trim())}`, 'PUT', { minecraft: f.minecraft.value.trim(), permissions });
    await loadUsers();
    if (r.password) $('#u-password').innerHTML = L('Temporary password for <b>{}</b>: <code>{}</code> — pass it on; it won\'t be shown again.', esc(r.user.name), esc(r.password));
    else toast(L('Saved.'));
  } catch (er) { $('#e-user').textContent = er.message; }
});
$('#t-users').addEventListener('click', async e => {
  const b = e.target.closest('button'); if (!b) return;
  const n = b.dataset.edit ?? b.dataset.repass ?? b.dataset.delete;
  if (b.dataset.edit) return userForm(usersData.users.find(u => u.name === n));
  if (b.dataset.repass && confirm(L`Give ${n} a new password? Their sessions will be closed.`)) {
    try { const r = await api(`/api/users/${encodeURIComponent(n)}/password`, 'POST'); await loadUsers();
      $('#u-password').innerHTML = L('Temporary password for <b>{}</b>: <code>{}</code> — pass it on; it won\'t be shown again.', esc(n), esc(r.password)); } catch (er) { toast(er.message, true); }
  }
  if (b.dataset.delete && confirm(L`Delete ${n}? They lose access immediately.`)) {
    try { await api(`/api/users/${encodeURIComponent(n)}`, 'DELETE'); loadUsers(); } catch (er) { toast(er.message, true); }
  }
});

let logRows = [];
async function loadLog() { try { logRows = await api('/api/log'); } catch { return; } paintLog(); }
function paintLog() {
  const f = $('#log-filter').value.toLowerCase();
  const l = logRows.filter(r => !f || JSON.stringify(r).toLowerCase().includes(f)).slice(0, 500);
  $('#t-log').innerHTML = l.length ? `<table><thead><tr>${['When', 'Who', 'Server', 'What', 'Detail', 'IP'].map(x => `<th>${L(x)}</th>`).join('')}</tr></thead><tbody>
    ${l.map(r => `<tr><td>${clock(r.t)}</td><td>${esc(r.user)}</td><td>${esc(r.server ?? '')}</td><td>${esc(r.type)}</td>
      <td style="white-space:normal;max-width:30rem"><code>${esc(r.detail ?? '')}</code></td><td class="hint">${esc(r.ip ?? '')}</td></tr>`).join('')}</tbody></table>` : `<p class="empty">${L('Nothing.')}</p>`;
}
$('#log-filter').addEventListener('input', paintLog);

async function loadSettings() {
  let a; try { a = await api('/api/settings'); } catch { return; }
  $('#f-settings').innerHTML = Object.entries(T.notices).map(([k, v]) => `<label>${v} <select name="${k}">${Object.entries(T.noticeModes)
    .map(([m, t]) => `<option value="${m}" ${a.notices[k] === m ? 'selected' : ''}>${t}</option>`).join('')}</select></label>`).join('')
    + `<button class="primary">${L('Save')}</button>`;
}
$('#f-settings').addEventListener('submit', async e => {
  e.preventDefault();
  try { await api('/api/settings', 'PUT', { notices: Object.fromEntries(new FormData(e.target)) }); toast(L('Saved.')); } catch (er) { toast(er.message, true); }
});

// ─────────────────────── Keeping up to date ───────────────────────

setInterval(() => { if (!document.hidden && me && !$('#v-panel').hidden) loadServers(); }, 6000);
setInterval(() => { if (!document.hidden && !$('#server').hidden) loadDetail(); }, 3000);
setInterval(() => { if (!document.hidden && !$('#server').hidden) loadEvents(); }, 2000);
setInterval(() => { if (!document.hidden && tab === 'console' && !$('#server').hidden) loadConsole(); }, 1500);
// Site settings for the page: the owner's sign-in button and the servers' addresses.
fetch('/api/config').then(r => r.json()).then(c => {
  site = c;
  if (c.sso) { const a = $('#sso'); a.textContent = L('Sign in with {}', c.sso); a.hidden = false; }
  if (location.hash === '#bad') { history.replaceState(null, '', '/'); toast(L('Could not sign in with {}.', c.sso ?? 'SSO'), true); }
  if (detail) paintInfo();
}).catch(() => {});
start();
