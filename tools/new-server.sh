#!/bin/bash
# Creates another Minecraft server set up like the rest:
#   LinuxGSM (pmcserver for Paper, mcserver for Fabric) + lazymc + pm2 (+ Caddy), behind WardenGate (public port,
#   central whitelist, real IP over PROXY v2) and with WardenList if it's Paper.
# It copies from a server you pick as a template its settings, its plugins or mods (no worlds, databases, logs nor
# backups), and asks everything that usually changes. Each question shows in brackets what Enter will use.
#
#   tools/new-server.sh
#
# Settings from WARDEN_HOME/config.json: serversDir, domain, language, and optionally
#   ecosystem  pm2's ecosystem file with the lazymc apps (an array «[...].map(app)» of mc-<name>)
#   caddy      { file, bluemap, webconsole, planHost }: the Caddyfile and the snippets it imports for each server
# To update it later (server, plugins or mods): python3 update/update.py <name>.
# What it does NOT do (it reminds you at the end): open the port on the router.
set -euo pipefail
# LinuxGSM refuses to install inside tmux («tmuxception»). No session of its own is opened here, so it just must not know.
unset TMUX TMUX_PANE
HERE=$(cd "$(dirname "$0")/.." && pwd)
cfg() { node -e "import('$HERE/lib/config.mjs').then(m => { const v = $1; console.log(v ?? '') })"; }
J=$(cfg 'm.config().serversDir'); DOMAIN=$(cfg 'm.config().domain'); LG=$(cfg 'm.config().language')
ECOSYSTEM=$(cfg 'm.config().ecosystem'); WHITELIST=$(cfg "m.file('whitelist.json')")
CADDYFILE=$(cfg 'm.config().caddy?.file'); CADDY_BM=$(cfg 'm.config().caddy?.bluemap'); CADDY_WC=$(cfg 'm.config().caddy?.webconsole')
PLAN_HOST=$(cfg "m.config().caddy?.planHost ?? '127.0.0.1'")
AIKAR='-XX:+UseG1GC -XX:+ParallelRefProcEnabled -XX:MaxGCPauseMillis=200 -XX:+UnlockExperimentalVMOptions -XX:+DisableExplicitGC -XX:+AlwaysPreTouch -XX:G1NewSizePercent=30 -XX:G1MaxNewSizePercent=40 -XX:G1HeapRegionSize=8M -XX:G1ReservePercent=20 -XX:G1HeapWastePercent=5 -XX:G1MixedGCCountTarget=4 -XX:InitiatingHeapOccupancyPercent=15 -XX:G1MixedGCLiveThresholdPercent=90 -XX:G1RSetUpdatingPauseTimePercent=5 -XX:SurvivorRatio=32 -XX:+PerfDisableSharedMem -XX:MaxTenuringThreshold=1 -Daikars.new.flags=true'

t()    { [ "$LG" = es ] && printf '%s' "$2" || printf '%s' "$1"; }          # t 'English' 'Español'
ask()  { local r; read -rp "  $1${2:+ [$2]}: " r || true; echo "${r:-${2:-}}"; }
yes()  { local d=${2:-y} r; read -rp "  $1 [$d]: " r || true; r=${r:-$d}; [[ $r =~ ^[sSyY] ]]; }
step() { printf '\n\033[1m── %s\033[0m\n' "$1"; }
prop() { sed -nE "s/^$2=(.*)/\1/p" "$1" 2>/dev/null | head -1; }

# ── What is already there ───────────────────────────────────────────────────
kind_of() { [ -d "$1/lgsm/config-lgsm/pmcserver" ] && echo paper || { [ -d "$1/lgsm/config-lgsm/mcserver" ] && echo fabric || echo ?; }; }
servers=(); for d in "$J"/mc-*/; do [ -f "$d/lazymc.toml" ] && servers+=("$(basename "$d")"); done

taken() {   # every port something already uses (listening or configured)
  ss -ltnuH | awk '{print $5}' | sed -E 's/.*:([0-9]+)$/\1/'
  for d in "$J"/mc-*/; do
    prop "$d/serverfiles/server.properties" server-port; prop "$d/serverfiles/server.properties" query.port
    sed -nE 's/^address = "[^:]+:([0-9]+)".*/\1/p' "$d/lazymc.toml" 2>/dev/null
    grep -hoE '^\s*(Port|port):\s*[0-9]+' "$d"/serverfiles/plugins/{Plan,WebConsole,Geyser-Spigot}/config.yml 2>/dev/null | grep -oE '[0-9]+'
    grep -hoE '^port:\s*[0-9]+' "$d"/serverfiles/plugins/BlueMap/webserver.conf "$d"/serverfiles/config/bluemap/webserver.conf 2>/dev/null | grep -oE '[0-9]+'
  done
  true   # a grep that finds nothing is not an error here
}
free() { ! grep -qx "$1" <<< "$TAKEN"; }
TAKEN=$(taken | sort -un)

echo "$(t 'Servers you already have' 'Servidores que ya tienes'): ${servers[*]:-}"

# ── 1. Name and type ────────────────────────────────────────────────────────
step "1. $(t 'Name and type' 'Nombre y tipo')"
while :; do
  NAME=$(ask "$(t 'Short name (lowercase; the folder will be mc-<name>)' 'Nombre corto (minúsculas; la carpeta será mc-<nombre>)')")
  [[ $NAME =~ ^[a-z0-9]+$ ]] || { echo "  $(t 'Lowercase letters and digits only.' 'Solo minúsculas y números.')"; continue; }
  [ -e "$J/mc-$NAME" ] && { echo "  $(t 'mc-'"$NAME"' already exists.' 'Ya existe mc-'"$NAME"'.')"; continue; }
  break
done
DIR=$J/mc-$NAME
KIND=$(ask "$(t 'Type: paper (plugins) or fabric (mods, like Cobblemon)' 'Tipo: paper (plugins) o fabric (mods, como Cobblemon)')" paper)
[[ $KIND =~ ^(paper|fabric)$ ]] || { echo "$(t 'Unknown type' 'Tipo desconocido'): $KIND"; exit 1; }
SCRIPT=$([ "$KIND" = paper ] && echo pmcserver || echo mcserver)

templates=(); for s in "${servers[@]}"; do [ "$(kind_of "$J/$s")" = "$KIND" ] && templates+=("$s"); done
NONE=$(t none ninguna)
TEMPLATE=$(ask "$(t 'Template to copy from' 'Plantilla de la que copiar') (${templates[*]:-$NONE}, $(t 'or' 'o') «$NONE»)" "${templates[0]:-$NONE}")
[ "$TEMPLATE" = "$NONE" ] && TEMPLATE="" || [ -d "$J/$TEMPLATE" ] || { echo "$(t 'No such folder' 'No existe') $TEMPLATE"; exit 1; }
PT=${TEMPLATE:+$J/$TEMPLATE}
SP=${PT:+$PT/serverfiles/server.properties}

# ── 2. Version ──────────────────────────────────────────────────────────────
step "2. $(t 'Minecraft version' 'Versión de Minecraft')"
if [ "$KIND" = paper ]; then
  vdef=$([ -n "$PT" ] && ls "$PT/serverfiles/versions" 2>/dev/null | sort -V | tail -1 || true)
else
  vdef=$([ -n "$PT" ] && unzip -p "$PT/serverfiles/server.jar" version.json 2>/dev/null | sed -nE 's/.*"id": *"([^"]+)".*/\1/p' | head -1 || true)
fi
VERSION=$(ask "$(t 'Version (the template'"'"'s, or «latest»)' 'Versión (la de la plantilla, o «latest»)')" "${vdef:-latest}")
PROTO=$(curl -fsS -m 20 https://raw.githubusercontent.com/PrismarineJS/minecraft-data/master/data/pc/common/protocolVersions.json 2>/dev/null |
        python3 -c "import json,sys; m={e['minecraftVersion']:e['version'] for e in json.load(sys.stdin) if e.get('usesNetty')}; print(m.get('$VERSION',''))" 2>/dev/null || true)
[ -n "$PROTO" ] || PROTO=$(ask "$(t "I don't know the protocol number of $VERSION (lazymc uses it until the first start)" "No sé el número de protocolo de $VERSION (lo usa lazymc hasta que arranca por 1.ª vez)")" 767)

# ── 3. Ports ────────────────────────────────────────────────────────────────
step "3. $(t 'Ports (free ones are suggested)' 'Puertos (se proponen libres)')"
# Blocks of 5 (P players, P+1 Bedrock, P+2 Plan, P+3 WebConsole, P+4 query), so the router needs one rule per server
# (P–P+1, TCP and UDP). Never the 25565 block: that's the gate's (and the one scanners sweep the most).
block_free() { local i; for i in 0 1 2 3 4; do free $(($1+i)) || return 1; done; free $(($1+10000)) && free $(($1+20000)); }
p=25570; until block_free $p; do p=$((p+5)); done
PORT=$(ask "$(t 'Public port (players'"'"'; Bedrock +1, Plan +2, WebConsole +3, a block of 5)' 'Puerto público (el de los jugadores; Bedrock en +1, Plan en +2 y WebConsole en +3, bloque de 5)')" $p)
INTERNAL=$((PORT+10000))
LAZYMC=$((PORT+20000))     # lazymc on loopback only: the public port is the gate's
b=8115; until free $b; do b=$((b+5)); done
BLUEMAP=$(ask "$(t 'BlueMap port' 'Puerto de BlueMap')" $b)
# Bedrock (Geyser, NetherNet) on +1: TCP (signaling: Bedrock finds the server over HTTPS with the <name>.<domain>
# certificate) and UDP (game). The public port's TCP is Java's (the gate).
BEDROCK=$((PORT+1))

# ── 4. Memory and settings ──────────────────────────────────────────────────
step "4. $(t 'Memory and world settings' 'Memoria y ajustes del mundo')"
cfgp=${PT:+$PT/lgsm/config-lgsm/$SCRIPT/$SCRIPT.cfg}
mindef=$(sed -nE 's/^minram="(.*)"/\1/p' "${cfgp:-/dev/null}" 2>/dev/null); maxdef=$(sed -nE 's/^maxram="(.*)"/\1/p' "${cfgp:-/dev/null}" 2>/dev/null)
[ "$KIND" = fabric ] && [ -n "$PT" ] && read -r mindef maxdef < <(grep -oE -- '-Xms[^ ]+|-Xmx[^ ]+' "$PT/serverfiles/start.sh" | sed 's/-X..//' | tr '\n' ' ') || true
RAMMIN=$(ask "$(t 'Minimum memory' 'Memoria mínima')" "${mindef:-2G}")
RAMMAX=$(ask "$(t 'Maximum memory' 'Memoria máxima')" "${maxdef:-4G}")
MOTD=$(ask "$(t 'Server list message (MOTD; colours with &, e.g. &aGreen)' 'Mensaje en la lista de servidores (motd; colores con &, p. ej. &aVerde)')" "$NAME")
# Colours with & (easier to type) or §; stored as §. The lazymc fork understands a coloured status.
MOTD=$(sed 's/[&§]\([0-9a-fk-orA-FK-OR]\)/§\L\1/g' <<< "$MOTD")
DIFFICULTY=$(ask "$(t 'Difficulty (peaceful/easy/normal/hard)' 'Dificultad (peaceful/easy/normal/hard)')" "$(prop "${SP:-/dev/null}" difficulty || true)")
DIFFICULTY=${DIFFICULTY:-hard}
VIEW=$(ask "$(t 'View and simulation distance' 'Distancia de visión y simulación')" "$(prop "${SP:-/dev/null}" view-distance || true)")
VIEW=${VIEW:-16}
ONLINE=$(ask "$(t 'Require an official account (online-mode)? true/false' '¿Exigir cuenta oficial (online-mode)? true/false')" "$(prop "${SP:-/dev/null}" online-mode || echo false)")
ONLINE=${ONLINE:-false}
SEED=$(ask "$(t 'World seed (empty = random)' 'Semilla del mundo (vacío = al azar)')" "")
if [ "$KIND" = fabric ]; then
  jdef=$([ -n "$PT" ] && sed -nE 's/^JAVA_BIN="(.*)"/\1/p' "$PT/serverfiles/start.sh" || true)
  JAVA=$(ask "$(t 'Java it will use (path)' 'Java que usará (ruta)')" "${jdef:-/usr/lib/jvm/java-21-openjdk-amd64/bin/java}")
fi

# ── 5. What to copy from the template ───────────────────────────────────────
COPY=none; OPS=n
if [ -n "$PT" ]; then
  step "5. $(t 'What to copy from' 'Qué copiar de') $TEMPLATE"
  what=$([ "$KIND" = paper ] && echo plugins || echo mods)
  COPY=$(ask "$what: «all» $(t '(with their settings), «jar» (only the jars, with default settings) or «none»' '(con sus ajustes), «jar» (solo los jar, con ajustes de fábrica) o «none»')" all)
  yes "$(t 'Also copy the operators (ops) and the vanilla whitelist?' '¿Copiar también los operadores (ops) y la lista blanca normal?')" n && OPS=y || true
fi
LIST=n; yes "$(t 'Require the central whitelist (WardenGate)?' '¿Exigir la lista blanca central (WardenGate)?')" y && LIST=y || true

# ── 6. Summary and confirmation ─────────────────────────────────────────────
step "6. $(t 'Summary' 'Resumen')"
cat <<EOF
  $(t 'Folder' 'Carpeta'):   $DIR ($KIND, LinuxGSM $SCRIPT)
  $(t 'Template' 'Plantilla'): ${TEMPLATE:-$NONE} · copy: $COPY · ops/whitelist: $OPS · central list: $LIST
  $(t 'Version' 'Versión'):   $VERSION (protocol $PROTO)
  $(t 'Ports' 'Puertos'):     players $PORT (gate) → lazymc $LAZYMC → server $INTERNAL · Bedrock $BEDROCK · Plan $((PORT+2)) · WebConsole $((PORT+3)) · BlueMap $BLUEMAP
  $(t 'Memory' 'Memoria'):    $RAMMIN–$RAMMAX · difficulty $DIFFICULTY · view $VIEW · online-mode $ONLINE
EOF
yes "$(t 'Do you accept the Minecraft EULA (https://aka.ms/MinecraftEULA)? It won'"'"'t start without it' '¿Aceptas el EULA de Minecraft (https://aka.ms/MinecraftEULA)? Sin él no arranca')" y || { echo "$(t 'No EULA, stopping.' 'Sin EULA no sigo.')"; exit 1; }
yes "$(t 'Create it?' '¿Lo creo?')" y || exit 1

# ── 7. LinuxGSM ─────────────────────────────────────────────────────────────
step "7. $(t 'Installing with LinuxGSM (downloads the server; a few minutes)' 'Instalando con LinuxGSM (descarga el servidor; unos minutos)')"
mkdir -p "$DIR" && cd "$DIR"
curl -fsSLo linuxgsm.sh https://linuxgsm.sh && chmod +x linuxgsm.sh
bash linuxgsm.sh "$SCRIPT" >/dev/null
mkdir -p "lgsm/config-lgsm/$SCRIPT"
if [ "$KIND" = paper ]; then
  cat > "lgsm/config-lgsm/$SCRIPT/$SCRIPT.cfg" <<EOF
port="$INTERNAL"
ip="0.0.0.0"
mcversion="$VERSION"
minram="$RAMMIN"
maxram="$RAMMAX"
flags="$AIKAR"
preexecutable="java -Xms\${minram} -Xmx\${maxram} \${flags} -jar"
executable="./paper.jar"
EOF
else
  cat > "lgsm/config-lgsm/$SCRIPT/$SCRIPT.cfg" <<EOF
port="$INTERNAL"
mcversion="$VERSION"
preexecutable=""
executable="./start.sh"
startparameters="nogui"
updateonstart="off"
EOF
fi
./"$SCRIPT" auto-install > "$DIR/install.log" 2>&1 || { echo "$(t 'LinuxGSM failed: see' 'LinuxGSM ha fallado: mira') $DIR/install.log"; exit 1; }
[ "$KIND" = paper ] && [ ! -f serverfiles/paper.jar ] && { echo "$(t 'Paper was not downloaded: see' 'No se ha descargado Paper: mira') $DIR/install.log"; exit 1; }

if [ "$KIND" = fabric ]; then
  inst=$(curl -fsS -m 20 https://meta.fabricmc.net/v2/versions/installer | python3 -c "import json,sys; print(next(e['version'] for e in json.load(sys.stdin) if e['stable']))")
  load=$(curl -fsS -m 20 "https://meta.fabricmc.net/v2/versions/loader/$VERSION" | python3 -c "import json,sys; print(next(e['loader']['version'] for e in json.load(sys.stdin) if e['loader']['stable']))")
  curl -fsSLo serverfiles/fabric-server-launch.jar "https://meta.fabricmc.net/v2/versions/loader/$VERSION/$load/$inst/server/jar"
  cat > serverfiles/start.sh <<EOF
#!/usr/bin/env bash
# Run by LinuxGSM (executable="./start.sh"). Fabric $load for Minecraft $VERSION.
JAVA_BIN="$JAVA"
\$JAVA_BIN -Xms$RAMMIN -Xmx$RAMMAX $AIKAR -jar fabric-server-launch.jar nogui
EOF
  chmod +x serverfiles/start.sh
  echo "  Fabric $load (installer $inst)"
fi

# ── 8. Settings ─────────────────────────────────────────────────────────────
step "8. $(t 'Settings' 'Configuración')"
SF=$DIR/serverfiles
# Never: worlds, databases, logs, backups, caches nor Plan's identity. With tar and not rsync: tar is always there.
copy() {   # copy <from> <to>, without the above
  mkdir -p "$2"
  tar -C "$1" -cf - --exclude='*.db' --exclude='*.db-*' --exclude='*.sqlite*' --exclude='*.mv.db' \
      --exclude='*.log' --exclude='*.log.gz' --exclude=logs --exclude=backups --exclude=Backups \
      --exclude=cache --exclude=ServerInfoFile.yml --exclude=playerdata --exclude=userdata . | tar -C "$2" -xf -
}
if [ -n "$PT" ]; then
  if [ "$KIND" = paper ]; then
    for f in bukkit.yml spigot.yml commands.yml permissions.yml help.yml; do cp -p "$PT/serverfiles/$f" "$SF/" 2>/dev/null || true; done
    mkdir -p "$SF/config"; cp -p "$PT"/serverfiles/config/paper-*.yml "$SF/config/" 2>/dev/null || true
    mkdir -p "$SF/plugins"
    case $COPY in
      all) copy "$PT/serverfiles/plugins" "$SF/plugins" ;;
      jar) cp -p "$PT"/serverfiles/plugins/*.jar "$SF/plugins/" ;;
    esac
  else
    mkdir -p "$SF/mods" "$SF/config"
    case $COPY in
      all) cp -p "$PT"/serverfiles/mods/*.jar "$SF/mods/"; copy "$PT/serverfiles/config" "$SF/config" ;;
      jar) cp -p "$PT"/serverfiles/mods/*.jar "$SF/mods/" ;;
    esac
  fi
  [ "$OPS" = y ] && cp -p "$PT"/serverfiles/{ops,whitelist}.json "$SF/" 2>/dev/null || true
  grep -vE '^(rcon\.password|management-server-secret)=' "$SP" > "$SF/server.properties"
fi

# server.properties: your answers over the template's (or the defaults).
python3 - "$SF/server.properties" <<PY
import sys, os
f = sys.argv[1]
lines = open(f).read().splitlines() if os.path.exists(f) else []
esc = lambda t: ''.join(c if 32 <= ord(c) < 127 else ''.join(chr(92) + 'u%04x' % int.from_bytes(c.encode('utf-16-be')[i:i+2], 'big') for i in range(0, len(c.encode('utf-16-be')), 2)) for c in t)
# server-ip on loopback: only lazymc reaches the server (with the PROXY protocol, anyone else could fake their IP).
# query on +4: +1 is Bedrock (Geyser)
new = {'server-port': '$INTERNAL', 'server-ip': '127.0.0.1', 'query.port': '$((PORT+4))', 'enable-query': 'true', 'motd': esc('''$MOTD'''),
       'difficulty': '$DIFFICULTY', 'view-distance': '$VIEW', 'simulation-distance': '$VIEW',
       'online-mode': '$ONLINE', 'level-seed': '''$SEED''', 'level-name': 'world', 'enable-rcon': 'false'}
if '$KIND' == 'paper': new['pause-when-empty-seconds'] = '-1'   # lazymc decides when it sleeps, not Paper
seen = set(); out = []
for l in lines:
    k = l.split('=', 1)[0]
    if '=' in l and k in new: out.append(f'{k}={new[k]}'); seen.add(k)
    else: out.append(l)
out += [f'{k}={v}' for k, v in new.items() if k not in seen]
open(f, 'w').write('\n'.join(out) + '\n')
PY
echo "eula=true" > "$SF/eula.txt"

# Each plugin its own port (two servers on the same port leave the second one without it).
python3 - "$SF" "$((PORT+2))" "$((PORT+3))" "$BLUEMAP" "$BEDROCK" <<'PY'
import sys, re, pathlib
sf, plan, wc, bm, br = sys.argv[1:]
def change(path, pattern, value, after=None):
    p = pathlib.Path(sf, path)
    if not p.exists(): return
    s = p.read_text(); start = s.find(after) if after else 0
    if start < 0: return
    m = re.compile(pattern, re.M).search(s, start)
    if m: s = s[:m.start(1)] + value + s[m.end(1):]; p.write_text(s); print(f'  {path}: {value}')
change('plugins/Plan/config.yml', r'^\s+Port:\s*(\d+)', plan, 'Webserver:')
change('plugins/WebConsole/config.yml', r'^\s*port:\s*(\d+)', wc)
change('plugins/BlueMap/webserver.conf', r'^port:\s*(\d+)', bm)
change('config/bluemap/webserver.conf', r'^port:\s*(\d+)', bm)
change('plugins/Geyser-Spigot/config.yml', r'^\s+port:\s*(\d+)', br, 'bedrock:')
# Fixed, not "the same as the Java server": lazymc moves that one to its internal port.
change('plugins/Geyser-Spigot/config.yml', r'^\s*clone-remote-port:\s*(\w+)', 'false')
PY
# Bedrock signaling's certificate, in its own folder (tools/cert-geyser.sh copies it).
[ -f "$SF/plugins/Geyser-Spigot/config.yml" ] && sed -i "s#/mc-[a-z0-9]*/serverfiles/plugins/Geyser-Spigot/#/mc-$NAME/serverfiles/plugins/Geyser-Spigot/#g" "$SF/plugins/Geyser-Spigot/config.yml"
# Plan: accept the GeoLite2 licence (downloads the country database; the gate uses it for the panel's flags).
[ -f "$SF/plugins/Plan/config.yml" ] && sed -i 's/^\(\s*\)Accept_GeoLite2_EULA: false/\1Accept_GeoLite2_EULA: true/' "$SF/plugins/Plan/config.yml"

# Secrets that came with the template: the new server would use the same ones (same Discord bot…).
sec=$(grep -rIlE '(token|password|secret|webhook|api[-_]?key)["'"'"']?\s*[:=]\s*["'"'"']?[A-Za-z0-9_./+-]{12,}' "$SF/plugins" "$SF/config" 2>/dev/null | sed "s|$SF/||" || true)
[ -n "$sec" ] && { echo "  ⚠️ $(t 'Copied files with something that looks like a secret (check them):' 'Ficheros copiados con algo que parece un secreto (revísalos):')"; sed 's/^/     /' <<< "$sec"; }

# ── 9. lazymc ───────────────────────────────────────────────────────────────
step "9. lazymc ($(t 'asleep until someone joins' 'dormido hasta que alguien entre'))"
cat > "$DIR/lazymc.toml" <<EOF
# lazymc for mc-$NAME (created with WardenGate's new-server.sh). Public port $PORT (gate), lazymc on $LAZYMC, server on $INTERNAL.

[public]
address = "127.0.0.1:$LAZYMC"
version = "$VERSION"
protocol = $PROTO
receive_proxy_v2 = true

[server]
address = "127.0.0.1:$INTERNAL"
directory = "$SF"
command = "$HERE/tools/lgsm.sh $DIR $SCRIPT"
freeze_process = false
wake_on_start = false
wake_on_crash = false
start_timeout = 300
stop_timeout = 150
wake_whitelist = true
block_banned_ips = true
send_proxy_v2 = false

[time]
sleep_after = 600
minimum_online_time = 120

[motd]
sleeping = "§7💤 $(t 'Sleeping to save memory' 'Durmiendo para ahorrar memoria')\n§2☻ $(t 'Join and it wakes up' 'Entra y se despierta solo')"
starting = "§2☻ $(t 'Starting…' 'Arrancando…')\n§7⌛ $(t 'One moment' 'Un momento')"
stopping = "§7💤 $(t 'Going to sleep…' 'Se está yendo a dormir…')\n§7⌛ $(t 'Join again in a minute' 'Vuelve a entrar en un minuto')"
from_server = false

[join]
methods = ["hold", "kick"]

[join.kick]
starting = "§2$(t 'The server was asleep and is waking up.' 'El servidor estaba dormido y se está despertando.')\n\n§f$(t 'Join again in a minute.' 'Vuelve a entrar en un minuto.')"
stopping = "§7$(t 'The server is going to sleep.' 'El servidor se está yendo a dormir.')\n\n§f$(t 'Join again in a minute and it will wake up.' 'Vuelve a entrar en un minuto y se despertará.')"

[join.hold]
timeout = 25

[advanced]
rewrite_server_properties = false

[config]
version = "0.2.11"
EOF
# The player's real IP: the gate passes it to lazymc (receive_proxy_v2) and lazymc to the server (send_proxy_v2), only
# if the server understands the header: Paper with proxy-protocol (and Geyser with it), Fabric with the mod.
PROXY=false
if [ "$KIND" = paper ] && [ -f "$SF/config/paper-global.yml" ]; then
  sed -i 's/^  proxy-protocol: false$/  proxy-protocol: true/' "$SF/config/paper-global.yml"
  grep -q '^  proxy-protocol: true$' "$SF/config/paper-global.yml" && PROXY=true
  [ "$PROXY" = true ] && [ -f "$SF/plugins/Geyser-Spigot/config.yml" ] && sed -i 's/^    use-haproxy-protocol: false$/    use-haproxy-protocol: true/' "$SF/plugins/Geyser-Spigot/config.yml"
elif [ "$KIND" = fabric ] && ls "$SF"/mods/proxy-protocol-support-*.jar >/dev/null 2>&1; then
  [ -f "$SF/config/proxy_protocol_support.json" ] || printf '{\n  "enableProxyProtocol": true,\n  "proxyServerIPs": ["127.0.0.1"],\n  "directAccessIPs": [],\n  "whitelistTCPShieldServers": false\n}\n' > "$SF/config/proxy_protocol_support.json"
  PROXY=true
fi
sed -i "s/^send_proxy_v2 = false$/send_proxy_v2 = $PROXY/" "$DIR/lazymc.toml"
grep -E '^(address|version|protocol|command|receive_proxy_v2|send_proxy_v2)' "$DIR/lazymc.toml" | sed 's/^/  /'
[ "$PROXY" = true ] || echo "  ℹ️ $(t 'The server will see everyone as 127.0.0.1 until the real IP is enabled (README, «The real IP»).' 'El servidor verá a todos como 127.0.0.1 hasta activar la IP real (README, «La IP real»).')"

# ── 9b. Central whitelist ───────────────────────────────────────────────────
if [ "$LIST" = y ]; then
  python3 - "$WHITELIST" "$NAME" <<'PY'
import json, os, sys
f, n = sys.argv[1:]
try: l = json.load(open(f))
except FileNotFoundError: l = {'servers': {}, 'players': {}}
l.setdefault('servers', {})[n] = True
os.makedirs(os.path.dirname(f), exist_ok=True)
json.dump(l, open(f + '.tmp', 'w'), indent=1, ensure_ascii=False); os.chmod(f + '.tmp', 0o600); os.replace(f + '.tmp', f)
PY
  echo "  whitelist.json: $NAME $(t 'requires it (whoever is not on it gets a code for the Discord bot)' 'la exige (quien no esté recibe un código para el bot de Discord)')"
fi
# WardenList on Paper: it applies the list to Bedrock too. If the server doesn't require it, it does nothing.
if [ "$KIND" = paper ]; then
  PAPER="$SF" "$HERE/plugins/build.sh" list >/dev/null && cp "$HERE/plugins/list/build/WardenList.jar" "$SF/plugins/" && echo "  WardenList $(t 'installed' 'instalado')"
  PAPER="$SF" "$HERE/plugins/build.sh" panel >/dev/null && cp "$HERE/plugins/panel/build/WardenPanel.jar" "$SF/plugins/" && echo "  WardenPanel $(t 'installed' 'instalado')"
fi

# ── 10. pm2 ─────────────────────────────────────────────────────────────────
if [ -n "$ECOSYSTEM" ] && yes "$(t 'Add it to pm2 (starts with the machine; whoever joins wakes it)?' '¿Añadirlo a pm2 (arranca con la máquina y lo despierta quien entre)?')" y; then
  python3 - "$ECOSYSTEM" "mc-$NAME" <<'PY'
import sys, re, pathlib
p = pathlib.Path(sys.argv[1]); s = p.read_text()
m = re.search(r"\[([^\]]*)\]\.map\(app\)", s)
names = [x.strip().strip("'\"") for x in m.group(1).split(',') if x.strip()]
if sys.argv[2] not in names: names.append(sys.argv[2])
s = s[:m.start(1)] + ', '.join(f"'{n}'" for n in names) + s[m.end(1):]
p.write_text(s)
PY
  pm2 start "$ECOSYSTEM" --only "mc-$NAME" >/dev/null && pm2 save >/dev/null && echo "  pm2: mc-$NAME $(t 'running and saved' 'en marcha y guardado')"
fi

# ── 11. Caddy (web) ─────────────────────────────────────────────────────────
if [ -n "$CADDYFILE" ] && [ -n "$DOMAIN" ]; then
  # Bedrock needs a certificate for <name>.<domain>: Caddy gets one if it has a block with that name.
  if [ -d "$SF/plugins/Geyser-Spigot" ] && yes "$(t "Add $NAME.$DOMAIN to Caddy? (Bedrock needs it for its certificate)" "¿Añadir $NAME.$DOMAIN a Caddy? (lo necesita Bedrock para su certificado)")" y; then
    cp -p "$CADDYFILE" "$CADDYFILE.before-mc-$NAME"
    printf '\n%s.%s {\n\t# For the Bedrock certificate (tools/cert-geyser.sh); in a browser, to the map\n\tredir https://bm-%s.%s{uri}\n}\n' "$NAME" "$DOMAIN" "$NAME" "$DOMAIN" >> "$CADDYFILE"
    if caddy reload --config "$CADDYFILE" >/dev/null 2>&1; then echo "  $(t 'Caddy reloaded: the certificate arrives in a minute; then run tools/cert-geyser.sh (or wait for its cron)' 'Caddy recargado: el certificado llega en un minuto; luego, tools/cert-geyser.sh (o su cron)')"
    else cat "$CADDYFILE.before-mc-$NAME" > "$CADDYFILE"; echo "  $(t "Caddy didn't accept it: the Caddyfile is back as it was" 'Caddy no lo ha aceptado: dejo el Caddyfile como estaba')"; fi
  fi
  if [ -n "$CADDY_BM" ] && yes "$(t "Publish its websites with Caddy (bm-$NAME, pl-$NAME, wcp-$NAME .$DOMAIN)?" "¿Publicar sus webs con Caddy (bm-$NAME, pl-$NAME, wcp-$NAME .$DOMAIN)?")" n; then
    blocks="
bm-$NAME.$DOMAIN {
	# The map from its files: it shows even while the server sleeps
	import $CADDY_BM mc-$NAME $BLUEMAP
}
"
    [ -d "$SF/plugins/Plan" ] && blocks+="
pl-$NAME.$DOMAIN {
	reverse_proxy $PLAN_HOST:$((PORT+2))
}
"
    [ -d "$SF/plugins/WebConsole" ] && [ -n "$CADDY_WC" ] && blocks+="
wcp-$NAME.$DOMAIN {
	# Its page (official client) + the plugin's WebSocket
	import $CADDY_WC $((PORT+3))
}
"
    cp -p "$CADDYFILE" "$CADDYFILE.before-mc-$NAME"
    printf '%s' "$blocks" >> "$CADDYFILE"
    if caddy reload --config "$CADDYFILE" >/dev/null 2>&1; then echo "  $(t 'Caddy reloaded' 'Caddy recargado')"
    else cat "$CADDYFILE.before-mc-$NAME" > "$CADDYFILE"; echo "  $(t "Caddy didn't accept it: the Caddyfile is back as it was" 'Caddy no lo ha aceptado: dejo el Caddyfile como estaba')"; fi
  fi
fi

# ── Done ────────────────────────────────────────────────────────────────────
step "$(t 'Done' 'Hecho')"
ADDR=${DOMAIN:+$NAME.$DOMAIN}
if [ "$LG" = es ]; then cat <<EOF
  Java entra por WardenGate (el 25565 por nombre${ADDR:+, $ADDR} y el $PORT directo): lo ve solo en menos de un minuto.
  El primer arranque genera el mundo y tarda más de lo normal.

  Falta, a mano:
  1. Router: $([ -d "$SF/plugins/Geyser-Spigot" ] && echo "una regla $PORT-$BEDROCK, TCP y UDP (Java y Bedrock)" || echo "el $PORT TCP (Java)") hacia esta máquina.
  2. Bedrock: ${ADDR:-esta máquina} y puerto $BEDROCK (dormido, WardenGate lo despierta al intentar entrar; se vuelve a entrar al minuto).
EOF
else cat <<EOF
  Java goes through WardenGate (25565 by name${ADDR:+, $ADDR} and $PORT directly): it notices on its own within a minute.
  The first start generates the world and takes longer than usual.

  Left to do by hand:
  1. Router: $([ -d "$SF/plugins/Geyser-Spigot" ] && echo "one rule $PORT-$BEDROCK, TCP and UDP (Java and Bedrock)" || echo "$PORT TCP (Java)") to this machine.
  2. Bedrock: ${ADDR:-this machine} and port $BEDROCK (while asleep, WardenGate wakes it when someone tries to join; join again a minute later).
EOF
fi
