// Site settings and data live outside the repo, in WARDEN_HOME (default ~/.config/warden):
//   config.json     domain, servers folder, language, how to notify the owner… (see config.example.json)
//   whitelist.json  the central whitelist          countries.json  players' countries (never IPs)
//   bots.txt        names cut at the gate          discord.env     WARDEN_TOKEN=… for the Discord bot
//   panel/          the panel's users, sessions, logs and caches
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

export const HOME = process.env.WARDEN_HOME ?? path.join(os.homedir(), '.config', 'warden');
export const file = (...parts) => path.join(HOME, ...parts);

const DEFAULTS = {
  serversDir: path.join(os.homedir(), 'minecraft'),   // one folder per server, mc-<name>, with its lazymc.toml
  domain: null,                                       // <name>.<domain> picks a server at the gate
  rootServer: null,                                   // the server for the bare domain
  language: 'en',                                     // messages to players and to the owner: en or es
  owner: null,                                        // who players should ask for help ("tell <owner>")
  notify: null,                                       // command to notify the owner; the text (HTML) goes last
  gate: { port: 25565, lazymcOffset: 20000, discordPort: 8790, codeMinutes: 30 },
  panel: {
    port: 8791,                                       // on 127.0.0.1, behind a reverse proxy with HTTPS
    url: null,                                        // its public address, for links in notifications
    caddyfile: null,                                  // to find each server's map, Plan and WebConsole addresses
    sso: null,                                        // owner sign-in through another site: { url, subject, label } (see README)
    notifyEditFlag: null,                             // if the notify command can edit a message: the flag (+ id)
  },
};

const merge = (a, b) => Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b ?? {})])].map(k =>
  [k, a[k] && typeof a[k] === 'object' && !Array.isArray(a[k]) ? merge(a[k], b?.[k]) : b?.[k] ?? a[k]]));

let cached = null;
export function config() {
  if (cached) return cached;
  let site = {};
  try { site = JSON.parse(fs.readFileSync(file('config.json'), 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  return (cached = merge(DEFAULTS, site));
}

// Notify the owner (e.g. through a chat bot). Fire and forget.
export function notifyOwner(html) {
  const c = config().notify;
  if (Array.isArray(c) && c.length) execFile(c[0], [...c.slice(1), html], () => {});
}

// Read a KEY=value file (secrets the owner writes; never printed).
export function readEnv(f) {
  try {
    return Object.fromEntries(fs.readFileSync(f, 'utf8').split('\n').map(l => l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/))
      .filter(Boolean).map(m => [m[1], m[2].replace(/^["']|["']$/g, '')]));
  } catch { return {}; }
}

// Write JSON atomically, readable only by the owner.
export function writeJSON(f, data) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f + '.tmp', JSON.stringify(data, null, 1) + '\n', { mode: 0o600 });
  fs.renameSync(f + '.tmp', f);
}

// Message tables: { en: { key: 'text with {} slots' }, es: {…} }. Falls back to English, then to the key.
export const translator = table => (lang, key, ...args) => {
  let i = 0;
  return String(table[lang]?.[key] ?? table.en?.[key] ?? key).replace(/\{\}/g, () => args[i++] ?? '');
};
