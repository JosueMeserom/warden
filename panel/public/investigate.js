// Investigate (alerts, mining, bases, commands), relations, world (rules, difficulty, time, weather) and the heat map.
// Uses what app.js and players.js define (api, esc, head, detail, current, can, ago, num, hours, date). Game data goes through esc().
'use strict';

const TI = translateObj({
  icons: { countries: '🌍', looting: '🧰', lava: '🌋', tnt: '🧨', wither: '💀', fire: '🔥', command: '⌨️', breakage: '⛏', visit: '👣', xray: '🔦' },
  severity: { high: 'severe', medium: 'medium', low: 'minor' },
  times: { day: '☀️ Day', noon: '🌞 Noon', night: '🌙 Night', midnight: '🌑 Midnight' },
  weathers: { clear: '☀️ Clear', rain: '🌧 Rain', thunder: '⛈ Thunder' },
  difficulties: { peaceful: 'Peaceful', easy: 'Easy', normal: 'Normal', hard: 'Hard' },
});
let inv = null, severityFilter = '', mapView = 'bluemap', heatData = null, heatScale = null;
window.mapView = mapView;

// BlueMap opened at a spot: its address + #world:x:y:z:distance…
const onMap = (world, x, y, z) => detail?.map && world ? `${detail.map}/#${encodeURIComponent(world)}:${x}:${y ?? 64}:${z}:120:0:0:0:0:perspective` : null;
const spot = a => a.x == null ? '' : (() => { const u = onMap(a.world, a.x, a.y, a.z), t = `${a.x}, ${a.y ?? '~'}, ${a.z}${a.world ? ` · ${a.world}` : ''}`;
  return u ? `<a href="${esc(u)}" target="_blank" rel="noopener">📍 ${esc(t)}</a>` : `📍 ${esc(t)}`; })();

const tabBefore = window.onTabChange, serverBefore = window.onServerChange;
window.onTabChange = t => Promise.all([tabBefore?.(t), ({ investigate: loadInvestigation, relations: loadRelations, world: loadWorld })[t]?.(),
  t === 'map' && mapView === 'heat' && loadHeat()]);
window.onServerChange = () => { serverBefore?.(); inv = null; heatData = null; };

// ─────────────────────── Investigate ───────────────────────

async function loadInvestigation() {
  try { inv = await api(`/api/server/${current}/investigation`); } catch (e) { $('#i-alerts').innerHTML = `<p class="error">${esc(e.message)}</p>`; return; }
  paintInvestigation();
}
function paintInvestigation() {
  const showReviewed = $('#i-reviewed').checked;
  $('#i-since').textContent = inv.since ? L('Data since {} (when this part of the plugin was installed). Mining also looks at the game\'s history.', date(inv.since))
    : L('No plugin data on this server yet: it\'ll appear once people play with it. Mining already looks at the game\'s history.');
  const al = inv.alerts.filter(a => (showReviewed || !a.reviewed) && (!severityFilter || a.severity === severityFilter));
  $('#i-alerts').innerHTML = al.map(a => `<div class="alert ${esc(a.severity)} ${a.reviewed ? 'reviewed' : ''}">
      <span class="icon">${TI.icons[a.kind] ?? '•'}</span>
      <span class="what">${head(a.player)}<b>${esc(a.player)}</b> ${esc(L(...[].concat(a.text)))}${a.n > 1 ? ` <span class="tag">×${a.n}</span>` : ''}
        <span class="tag ${esc(a.severity)}">${TI.severity[a.severity]}</span>${a.detail ? `<br><code>${esc(a.detail)}</code>` : ''}</span>
      <span class="buttons">${can('investigate') ? `<button class="small" data-review="${esc(a.id)}" data-undo="${a.reviewed ? 1 : ''}">${a.reviewed ? `↩ ${L('Pending')}` : `✓ ${L('Reviewed')}`}</button>` : ''}
        <button class="small" data-see-player="${esc(a.player)}">👤</button></span>
      <span class="where">${a.t ? `${ago(a.t)} · ` : ''}${spot(a)}</span></div>`).join('')
    || `<p class="empty">${inv.alerts.length ? L('Nothing with these filters.') : L('Nothing suspicious.') + ' 🎉'}</p>`;
  $('#i-miners').innerHTML = inv.miners.length ? `<table><thead><tr><th>${L('Player')}</th><th title="${L('Since the plugin')}">💎</th><th title="${L('With no face exposed to air: the ones that give X-ray away')}">${L('Hidden')}</th><th title="${L('Stone mined, since the plugin')}">${L('Stone')}</th><th title="${L('Hidden per 1000 stone')}">/1000</th>
      <th title="${L('The world\'s whole lifetime (game statistics; includes those in caves, so only a rough guide)')}">💎 ${L('total')}</th><th>/1000 ${L('total')}</th><th>${L('Debris')}</th><th></th></tr></thead><tbody>
    ${inv.miners.map(m => `<tr><td>${head(m.player)}${esc(m.player)}</td><td>${num(m.diamonds)}</td><td>${num(m.hidden)}</td><td>${num(m.stone)}</td><td>${m.per1000 ?? '—'}</td>
      <td>${num(m.allTime?.diamonds)}</td><td>${m.allTimePer1000 ?? '—'}</td><td>${num((m.allTime?.debris ?? 0) + m.debris)}</td>
      <td>${m.suspicion ? `<span class="tag ${m.suspicion}">${L(m.suspicion === 'high' ? 'very suspicious' : 'suspicious')}</span>` : ''}</td></tr>`).join('')}</tbody></table>` : `<p class="empty">${L('Nobody has mined diamonds.')}</p>`;
  $('#i-bases').innerHTML = inv.bases.map(b => `<li>${head(b.owner)}<span class="grow">${esc(b.owner)} <span class="hint">· ${L('{} blocks · {} zone(s)', num(b.placed), b.zones)}</span></span>
      ${spot({ world: b.world, x: b.x, z: b.z })}</li>`).join('') || `<li class="hint">${L('None yet.')}</li>`;
  $('#i-commands').innerHTML = inv.commands.length ? `<table><thead><tr><th>${L('When')}</th><th>${L('Player')}</th><th>${L('Command')}</th></tr></thead><tbody>
    ${inv.commands.slice(0, 100).map(c => `<tr><td>${ago(c.t)}</td><td>${head(c.player)}${esc(c.player)}</td><td style="white-space:normal"><code>${esc(c.text)}</code></td></tr>`).join('')}</tbody></table>`
    : `<p class="empty">${L('Nobody has used powerful commands.')}</p>`;
}
$('#i-severity').addEventListener('click', e => { const b = e.target.closest('[data-s]'); if (!b) return; severityFilter = b.dataset.s; for (const x of $('#i-severity').children) x.classList.toggle('active', x === b); paintInvestigation(); });
$('#i-reviewed').addEventListener('change', () => inv && paintInvestigation());
$('#i-alerts').addEventListener('click', async e => {
  const r = e.target.closest('[data-review]'), v = e.target.closest('[data-see-player]');
  if (r) { try { await api(`/api/server/${current}/investigation`, 'POST', r.dataset.undo ? { unreview: r.dataset.review } : { review: r.dataset.review }); loadInvestigation(); } catch (er) { toast(er.message, true); } }
  if (v) seePlayer(v.dataset.seePlayer);
});
async function seePlayer(name) {
  if (!playerList.length) await loadPlayers();
  const j = playerList.find(x => x.name.toLowerCase() === name.toLowerCase());
  changeTab('players'); if (j) openProfile(j.uuid); else toast(L`Can't find ${name} among the players.`, true);
}

// ─────────────────────── Relations ───────────────────────

async function loadRelations() {
  let r; try { r = await api(`/api/server/${current}/relations`); } catch { return; }
  $('#r-source').textContent = L('Who plays with whom: time spent online together ({}).', L(r.source === 'plan' ? 'Plan sessions, last 180 days' : 'joins and leaves seen by the panel'));
  const ns = r.nodes.filter(n => r.links.some(e => e.a === n.player || e.b === n.player)).slice(0, 24);
  if (!ns.length) { $('#r-graph').innerHTML = `<p class="empty">${L('Nobody has overlapped yet.')}</p>`; $('#r-list').innerHTML = ''; return; }
  const pos = new Map(ns.map((n, i) => { const a = (i / ns.length) * 2 * Math.PI - Math.PI / 2, rad = ns.length < 3 ? 120 : 220;
    return [n.player, { x: 300 + rad * Math.cos(a), y: 300 + rad * Math.sin(a) }]; }));
  const max = Math.max(...r.links.map(e => e.minutes));
  const links = r.links.filter(e => pos.has(e.a) && pos.has(e.b)).map(e => {
    const a = pos.get(e.a), b = pos.get(e.b), g = 1 + 9 * Math.sqrt(e.minutes / max);
    return `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="var(--purple)" stroke-width="${g.toFixed(1)}" opacity="${(0.25 + 0.6 * e.minutes / max).toFixed(2)}"><title>${L('{} and {}: {} together', esc(e.a), esc(e.b), hours(e.minutes * 60))}</title></line>`;
  }).join('');
  const nodes = ns.map(n => { const p = pos.get(n.player);
    return `<div class="node" style="left:${(p.x / 6).toFixed(2)}%;top:${(p.y / 6).toFixed(2)}%" title="${L('{}: {} played', esc(n.player), hours(n.minutes * 60))}">${head(n.player)}<span>${esc(n.player)}</span></div>`; }).join('');
  $('#r-graph').innerHTML = `<svg viewBox="0 0 600 600">${links}</svg>${nodes}`;
  $('#r-list').innerHTML = r.links.slice(0, 30).map(e => `<li>${head(e.a)}${head(e.b)}<span class="grow">${L('{} and {}', esc(e.a), esc(e.b))}</span><span class="hint">${L('{} together', hours(e.minutes * 60))}</span></li>`).join('');
}

// ─────────────────────── World ───────────────────────

async function loadWorld() {
  let m; try { m = await api(`/api/server/${current}/world`); } catch { return; }
  const change = can('world') && m.state === 'awake', w = m.worlds?.[0];
  const buttons = (type, options, now) => Object.entries(options).map(([k, t]) => `<button class="small ${k === now ? 'primary' : ''}" data-world="${type}" data-value="${k}" ${change ? '' : 'disabled'}>${t}</button>`).join('');
  const time = w ? L(w.time < 1000 || w.time >= 23000 ? 'dawn' : w.time < 12000 ? 'day' : w.time < 13800 ? 'dusk' : 'night') : null;
  $('#w-content').innerHTML = `
    ${m.state !== 'awake' ? `<p class="hint">${L('It\'s asleep: settings are shown and changed while it\'s awake.')}</p>` : !change ? `<p class="hint">${L('You can see it, but not change it ("world settings" permission).')}</p>` : ''}
    <h3>MOTD <span class="hint">${L('(what shows in the server list; applies on restart)')}</span></h3>
    <div class="motd" id="motd-preview">${motdHTML(m.motd ?? '')}</div>
    ${can('world') ? `<div class="motd-palette">${Object.entries(MC_COLORS).map(([c, col]) => `<button class="small" data-motd="${c}" style="background:${col}" title="&${c}"></button>`).join('')}
      ${[['l', 'B', L('bold')], ['o', 'I', L('italic')], ['n', 'U', L('underlined')], ['m', 'S', L('strikethrough')], ['r', '↺', L('reset formatting')]]
        .map(([c, t, n]) => `<button class="small" data-motd="${c}" title="&${c} · ${n}">${t}</button>`).join('')}</div>` : ''}
    <div class="row"><textarea id="motd-input" rows="2" maxlength="300" ${can('world') ? '' : 'disabled'} placeholder="${L('Colours with & (e.g. &aGreen); two lines at most')}">${esc((m.motd ?? '').replace(/§/g, '&'))}</textarea>
      ${can('world') ? `<button class="small primary" id="motd-save">${L('Save')}</button>` : ''}</div>
    <h3>${L('Difficulty')} ${w ? `<span class="tag">${TI.difficulties[w.difficulty] ?? esc(w.difficulty)}</span>` : ''}</h3><div class="row">${buttons('difficulty', TI.difficulties, w?.difficulty)}</div>
    <h3>${L('Time')} ${time ? `<span class="tag">${time}</span>` : ''}</h3><div class="row">${buttons('time', TI.times)}</div>
    <h3>${L('Weather')} ${w ? `<span class="tag">${L(w.rain ? 'raining' : 'clear')}</span>` : ''}</h3><div class="row">${buttons('weather', TI.weathers)}</div>
    <h3>${L('Game rules')} ${m.rules.length ? `<span class="count">${m.rules.length}</span>` : ''}</h3>
    ${m.rules.length ? `<input id="rule-search" placeholder="${L('Search rules…')}" autocomplete="off" style="margin-bottom:8px;width:100%">
      <div class="rules">${m.rules.map(r => `<div class="rule" data-name="${esc(r.name)}" data-text="${esc((r.title + ' ' + r.name + ' ' + r.description).toLowerCase())}">
        <span class="title" title="${esc(r.name)}">${esc(r.title)}</span>
        ${typeof r.value === 'boolean' ? `<input type="checkbox" class="switch" data-rule="${esc(r.name)}" ${r.value ? 'checked' : ''} ${change ? '' : 'disabled'}>`
          : `<span><input type="number" value="${esc(r.value)}" data-rule-num="${esc(r.name)}" ${change ? '' : 'disabled'}></span>`}
        ${r.description ? `<span class="desc">${esc(r.description)}</span>` : ''}</div>`).join('')}</div>`
      : `<p class="hint">${L(m.state === 'awake' && !m.plugin ? 'This server doesn\'t have the WardenPanel plugin (Fabric): rules can\'t be read; change them from the console with /gamerule.' : 'Rules are shown while the server is awake.')}</p>`}`;
}
async function sendWorld(data, el) {
  el.disabled = true;
  try { await api(`/api/server/${current}/action`, 'POST', data); toast(L('Done.')); setTimeout(loadWorld, 700); }
  catch (er) { toast(er.message, true); el.disabled = false; }
}
$('#w-content').addEventListener('click', async e => {
  const b = e.target.closest('[data-world]'); if (b) return sendWorld({ type: b.dataset.world, value: b.dataset.value }, b);
  const c = e.target.closest('[data-motd]');
  if (c) {                                                    // puts the code where the cursor is
    const t = $('#motd-input'), i = t.selectionStart ?? t.value.length, j = t.selectionEnd ?? i;
    t.value = t.value.slice(0, i) + '&' + c.dataset.motd + t.value.slice(j); t.focus(); t.setSelectionRange(i + 2, i + 2);
    return previewMotd();
  }
  if (e.target.id === 'motd-save') {
    try { const r = await api(`/api/server/${current}/action`, 'POST', { type: 'motd', value: $('#motd-input').value }); $('#motd-input').value = r.motd.replace(/§/g, '&'); previewMotd(); toast(L('MOTD saved: it\'ll show after the server restarts.')); loadDetail(); }
    catch (er) { toast(er.message, true); }
  }
});
const previewMotd = () => { $('#motd-preview').innerHTML = motdHTML($('#motd-input').value.replace(/&([0-9a-fk-or])/gi, '§$1')); };
$('#w-content').addEventListener('input', e => { if (e.target.id === 'motd-input') previewMotd(); });
$('#w-content').addEventListener('change', e => {
  if (e.target.dataset.rule) sendWorld({ type: 'rule', name: e.target.dataset.rule, value: String(e.target.checked) }, e.target);
  if (e.target.dataset.ruleNum) sendWorld({ type: 'rule', name: e.target.dataset.ruleNum, value: String(Math.round(Number(e.target.value))) }, e.target);
});
$('#w-content').addEventListener('input', e => {
  if (e.target.id !== 'rule-search') return;
  const q = e.target.value.toLowerCase();
  for (const r of document.querySelectorAll('.rule')) r.hidden = q && !r.dataset.text.includes(q);
});

// ─────────────────────── Heat map ───────────────────────

$('#map-view').addEventListener('click', e => {
  const b = e.target.closest('[data-view]'); if (!b) return;
  mapView = window.mapView = b.dataset.view;
  for (const x of $('#map-view').children) x.classList.toggle('active', x === b);
  $('#heat').hidden = mapView !== 'heat';
  if (mapView === 'heat') { $('#map').hidden = true; $('#map-missing').hidden = true; loadHeat(); } else changeTab('map');
});
$('#heat-world').addEventListener('change', e => loadHeat(e.target.value));
async function loadHeat(world) {
  try { heatData = await api(`/api/server/${current}/heat${world ? `?world=${encodeURIComponent(world)}` : ''}`); } catch { return; }
  $('#heat-world').innerHTML = (heatData.worlds.length ? heatData.worlds : [heatData.world]).map(m => `<option ${m === heatData.world ? 'selected' : ''}>${esc(m)}</option>`).join('');
  paintHeat();
}
function paintHeat() {
  const c = $('#heat-canvas'), d = heatData, dpr = devicePixelRatio || 1;
  const W = c.clientWidth || 900, H = Math.round(W * 0.62);                // drawn at its real size: sharp
  c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); c.style.height = `${H}px`;
  const x = c.getContext('2d'); x.setTransform(dpr, 0, 0, dpr, 0, 0);
  x.fillStyle = '#0b0d11'; x.fillRect(0, 0, W, H);
  const points = [...d.cells.map(k => [k.cx * 16 + 8, k.cz * 16 + 8]), ...d.deaths.map(m => [m.x, m.z]), ...d.bases.map(b => [b.x, b.z])];
  if (!points.length) { x.fillStyle = '#8b93a6'; x.font = '15px system-ui'; x.textAlign = 'center'; x.fillText(L('No data for this world yet: it builds up as people play.'), W / 2, H / 2); heatScale = null; return; }
  let [x0, x1, z0, z1] = [Math.min(...points.map(p => p[0])), Math.max(...points.map(p => p[0])), Math.min(...points.map(p => p[1])), Math.max(...points.map(p => p[1]))];
  const margin = 64; x0 -= margin; x1 += margin; z0 -= margin; z1 += margin;
  const k = Math.min(W / (x1 - x0), H / (z1 - z0)), ox = (W - (x1 - x0) * k) / 2, oz = (H - (z1 - z0) * k) / 2;
  const toX = v => ox + (v - x0) * k, toZ = v => oz + (v - z0) * k;
  heatScale = { blockX: px => Math.round(x0 + (px - ox) / k), blockZ: pz => Math.round(z0 + (pz - oz) / k) };
  // a grid every 256 blocks, with 0,0
  x.strokeStyle = '#1d212a'; x.lineWidth = 1; x.fillStyle = '#4a5163'; x.font = '10px monospace';
  for (let v = Math.ceil(x0 / 256) * 256; v < x1; v += 256) { x.beginPath(); x.moveTo(toX(v), 0); x.lineTo(toX(v), H); x.stroke(); x.fillText(v, toX(v) + 2, 10); }
  for (let v = Math.ceil(z0 / 256) * 256; v < z1; v += 256) { x.beginPath(); x.moveTo(0, toZ(v)); x.lineTo(W, toZ(v)); x.stroke(); x.fillText(v, 2, toZ(v) - 2); }
  const max = Math.max(1, ...d.cells.map(c2 => c2.n)), side = Math.max(2, 16 * k);
  for (const c2 of d.cells) {
    const t = Math.sqrt(c2.n / max);                                // from blue (little) to yellow and red (a lot)
    x.fillStyle = `hsla(${Math.round(240 - 240 * t)}, 90%, ${45 + 10 * t}%, ${0.35 + 0.6 * t})`;
    x.fillRect(toX(c2.cx * 16), toZ(c2.cz * 16), side, side);
  }
  x.font = '13px system-ui'; x.textAlign = 'center';
  for (const b of d.bases) { x.strokeStyle = '#8b7bff'; x.lineWidth = 2; x.strokeRect(toX(b.x) - 10, toZ(b.z) - 10, 20, 20); x.fillStyle = '#c9c2ff'; x.fillText(`🏠 ${b.owner}`, toX(b.x), toZ(b.z) - 14); }
  for (const m of d.deaths) x.fillText('💀', toX(m.x), toZ(m.z) + 5);
}
$('#heat-canvas').addEventListener('click', e => {
  if (!heatScale) return;
  const r = e.target.getBoundingClientRect(), px = e.clientX - r.left, pz = e.clientY - r.top;
  const bx = heatScale.blockX(px), bz = heatScale.blockZ(pz), u = onMap(heatData.world, bx, 64, bz);
  const cell = heatData.cells.find(k => k.cx === Math.floor(bx / 16) && k.cz === Math.floor(bz / 16));
  $('#heat-spot').innerHTML = `${bx}, ${bz}${cell ? ` · ${Object.entries(cell.players).map(([j, n]) => `${esc(j)} ${hours(n * 30)}`).join(', ')}` : ''}${u ? ` · <a href="${esc(u)}" target="_blank" rel="noopener">${L('open in BlueMap')} ↗</a>` : ''}`;
});
