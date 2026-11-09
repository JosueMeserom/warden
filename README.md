# Warden

Tools to run a handful of Minecraft servers at home that **sleep when nobody plays** and wake up when someone joins,
behind a single front door, with a web panel. [Español](README.es.md)

| Piece | What it does |
|---|---|
| **WardenGate** (`gate/`) | The Java front door: picks the server by the address the player typed (`lobby.example.net`) or by port, cuts known scanner bots, enforces a central whitelist with a **Discord bot** (`/verify`), passes the **player's real IP** on, records each player's country, and wakes sleeping servers for **Bedrock** (NetherNet) too. |
| **WardenPanel** (`panel/`, `plugins/panel/`) | Web panel: status, players (stats, inventory, advancements, sessions), leaderboard, charts, chat and console, world settings, MOTD with colours, an **investigation** view (x-ray, griefing, looting, powerful commands), relations and a heat map. Users with per-server permissions. English and Spanish. |
| **WardenList** (`plugins/list/`) | Paper plugin: the same central whitelist inside the server, for Bedrock players (who don't go through the gate). |
| **WardenUpdate** (`update/`) | Updates a server (Paper, Fabric or vanilla) and its plugins/mods from Modrinth, GeyserMC and GitHub, checking every hash, and tells you what would break on a newer Minecraft version. |
| Tools (`tools/`) | `new-server.sh` (a new server set up like the rest), `lgsm.sh` (lazymc ⇄ LinuxGSM), `cert-geyser.sh` (Bedrock's certificate). |

No dependencies beyond Node.js (20+), Python 3 and, for the panel's history, `sqlite3`. No npm packages.

## How it fits together

```
JAVA ──► WardenGate :25565 (by name) and each server's own port
           ├ bots.txt → cut          ├ whitelist (if required) → kicked with a code for /verify on Discord
           ▼ PROXY v2 header with the player's real IP
         lazymc (127.0.0.1:<port+20000>)   asleep → starts it with LinuxGSM and holds the player
           ▼ the same header
         Minecraft server (127.0.0.1:<port+10000>, proxy-protocol on: it sees the real IP)

BEDROCK ──► Geyser inside the server (its own port, TCP+UDP)
           while asleep, WardenGate answers Geyser's signaling ("💤 Sleeping") and wakes it through lazymc
```

It's built around:

- **[LinuxGSM](https://linuxgsm.com)** to install and run each server (`pmcserver` for Paper, `mcserver` for Fabric), one
  folder per server: `<serversDir>/mc-<name>/` with its `lazymc.toml`.
- **[lazymc](https://github.com/JosueMeserom/lazymc/tree/warden)**, the **Warden fork**: upstream lazymc can send the
  real IP to the server but can't receive it from a proxy in front of it, and it never detects a server whose MOTD has
  colours. The fork adds `receive_proxy_v2` and fixes the MOTD (GPL-3.0, like upstream).
- **pm2** to keep lazymc, the gate and the panel running (`tools/ecosystem.example.cjs`).
- Optionally **Caddy** (or any reverse proxy with HTTPS) for the panel, the Discord bot's endpoint and the servers'
  web pages (BlueMap, Plan, WebConsole).

### Ports

Each server uses a **block of 5** public ports `P…P+4`: `P` Java (served by the gate), `P+1` Bedrock (Geyser, TCP and
UDP), `P+2` Plan, `P+3` WebConsole, `P+4` query. So the router needs **one rule per server** (`P–P+1`, TCP and UDP) plus
25565 for the gate. Inside: lazymc on `P+20000` and the server on `P+10000`, both on `127.0.0.1`; the panel plugin on the
server's port `+20000`.

## Setup

1. **Site settings** go in `WARDEN_HOME` (default `~/.config/warden`), never in the repo: copy `config.example.json` to
   `~/.config/warden/config.json` and edit it.

   | Key | Meaning |
   |---|---|
   | `serversDir` | Folder with one `mc-<name>/` per server. |
   | `domain`, `rootServer` | `<name>.<domain>` picks a server at the gate; the bare domain goes to `rootServer`. |
   | `language` | `en` or `es`: messages to players, to the owner and in the tools. |
   | `owner` | Who players are told to ask for help. |
   | `notify` | Command to notify the owner (a chat bot, …); the HTML text is appended as the last argument. |
   | `aliases`, `ownPlugins` | WardenUpdate: other names for servers; your own plugins (it won't look for updates). |
   | `ecosystem`, `caddy`, `geyserCerts` | Used by `new-server.sh` and `cert-geyser.sh` (see the example). |
   | `gate` | Ports: main (25565), lazymc offset, Discord bot (8790); how long `/verify` codes last. |
   | `panel` | Its port (on loopback), public URL, owner sign-in (`sso`) and whether `notify` can edit messages. |

   Data that lives there too: `whitelist.json`, `countries.json` (country codes only, **never IPs**), `bots.txt`,
   `discord.env` (`WARDEN_TOKEN=…`, mode 600) and `panel/` (users, sessions, log, caches).

2. **lazymc fork**: build it (`cargo build --release` in the fork) and put the binary somewhere stable. In each
   `lazymc.toml`: `[public] address = "127.0.0.1:<P+20000>"`, `receive_proxy_v2 = true`, and `[server] command =
   "<repo>/tools/lgsm.sh <server folder> <pmcserver|mcserver>"`.
3. **Real IP**: `send_proxy_v2 = true` in lazymc and, in the server, Paper's `proxies.proxy-protocol: true`
   (`config/paper-global.yml`) plus Geyser's `advanced.java.use-haproxy-protocol: true`; on Fabric, the
   [Proxy Protocol Support](https://modrinth.com/mod/proxy-protocol-support) mod. Set `server-ip=127.0.0.1`: whoever
   could reach the server directly could fake their IP. Without this, the server sees everyone as 127.0.0.1 (then never
   use `/ban-ip`, and don't trust login plugins' IP sessions).
4. **Plugins**: `PAPER=<a Paper server folder> plugins/build.sh panel install` and `… list install` (javac, Java 21+).
5. **pm2**: adapt `tools/ecosystem.example.cjs`, then `pm2 start … && pm2 save`.
6. **Discord bot** (optional): create an application, write its bot token in `WARDEN_HOME/discord.env`, and point its
   *Interactions Endpoint URL* to your reverse proxy → `127.0.0.1:8790`. The commands (`/verify`, `/whitelist`) register
   themselves, localised in Spanish for Spanish clients.
7. **Panel**: reverse proxy with HTTPS → `127.0.0.1:8791` (it sets `Secure` cookies and trusts `X-Forwarded-For` only from
   loopback). Users are created by the owner from the panel; the owner signs in through `panel.sso` (below).

New servers: `tools/new-server.sh` does all of the above for one more server. Updates: `python3 update/update.py <name>`.

### Owner sign-in (`panel.sso`)

The owner has no password on the panel: a site they already trust signs them in. `/login/sso` redirects to
`sso.url?n=<nonce>`; that site, once sure it's the owner, redirects back to
`<panel>/login/sso/return?n=<nonce>&e=<expiry ms>&f=<signature>` where `signature = base64url(HMAC-SHA256(key,
"<subject>|<nonce>|<expiry>"))`, `key` is `WARDEN_HOME/panel/sso.key` (created by the panel, mode 600) and the expiry is
at most two minutes away.

## The panel

- Permissions per server (`*` = all): `view`, `chat`, `moderate`, `ban`, `whitelist`, `investigate`, `inventories`,
  `items`, `world`, `power`, `console` (console includes everything). Profiles: viewer, moderator, admin, admin with console.
- Everything done from it goes to `panel/log.jsonl`; the owner is notified at once of sensitive things, or in one
  summary per session (configurable).
- Data: lazymc and the Java process; the **WardenPanel plugin** on Paper (`/status`, `/events`, `/inventory`,
  `/counters` on `127.0.0.1:<server port + 20000>`, read-only, with the key in `plugins/WardenPanel/key`); on Fabric,
  the status ping and the log. Player stats and inventories come from the world files, so they show while asleep too.
  Plan's SQLite database adds sessions and history.
- **Investigate**: x-ray suspicion only from *hidden* diamonds (no face exposed) per 1000 stone mined — cave diamonds
  accuse nobody; bases (zones where someone placed ≥64 blocks), looting, breaking, lava, fire, TNT, withers and powerful
  commands in other people's bases; the same account joining from several countries.
- Translating: the code is in English and `panel/public/es.js` maps each text to Spanish. `node panel/languages.test.mjs`
  lists anything missing. Item, mob and advancement names come from Mojang's own language files.

## Tests

```
node gate/gate.test.mjs                    # GEOLITE=<GeoLite2-Country.mmdb> also checks countries
node gate/lazymc.test.mjs <lazymc binary>  # end to end with the fork: real IP and coloured MOTD (upstream fails)
node panel/server.test.mjs && node panel/languages.test.mjs
python3 update/update.test.py
```

## Security notes

- The gate and lazymc must be the only way into the servers: `server-ip=127.0.0.1` and only `P–P+1` forwarded.
- `/verify` codes are 6 digits, one per player and server, valid for 30 minutes, in memory only; one Discord account
  can only be linked to one Minecraft name.
- The plugin never records login plugins' commands nor private messages (a closed list of powerful commands only).
- Secrets (`discord.env`, `sso.key`, the plugin key, `users.json`) are created with mode 600 in `WARDEN_HOME`.

## Licence

[MIT](LICENSE). The lazymc fork is GPL-3.0, like lazymc.
