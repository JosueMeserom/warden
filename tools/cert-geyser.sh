#!/bin/bash
# Copies to Geyser the certificate Caddy gets for <server>.<domain> (Bedrock's NetherNet HTTPS signaling), for every
# server whose Geyser asks for it in its config.yml (certificate: '…/Geyser-Spigot/https.crt'). The key in PKCS#8:
# Geyser can't read Caddy's «EC PRIVATE KEY». If the certificate is new and the server is awake and empty, it runs
# «geyser reload» (restarts only Geyser); with players online it tries again next day; asleep, Geyser reads it on start.
# Run it daily from cron. Settings from WARDEN_HOME/config.json: serversDir, domain and geyserCerts (Caddy's
# certificates folder, e.g. ~/.local/share/caddy/certificates/acme-v02.api.letsencrypt.org-directory).
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
read -r SERVERS DOMAIN CA < <(node -e "import('$HERE/../lib/config.mjs').then(m => { const c = m.config(); console.log(c.serversDir, c.domain, c.geyserCerts ?? '') })")
[ -n "$DOMAIN" ] && [ -n "$CA" ] || { echo "config.json needs domain and geyserCerts"; exit 2; }
umask 077
for G in "$SERVERS"/mc-*/serverfiles/plugins/Geyser-Spigot; do
  grep -q "certificate: '$G/https.crt'" "$G/config.yml" 2>/dev/null || continue
  S=${G%/serverfiles/*}; n=${S##*/mc-}; C=$CA/$n.$DOMAIN/$n.$DOMAIN
  [ -f "$C.crt" ] || { echo "$n: Caddy has no certificate for $n.$DOMAIN yet"; continue; }
  if ! cmp -s "$C.crt" "$G/https.crt"; then
    openssl pkcs8 -topk8 -nocrypt -in "$C.key" -out "$G/https.key.new" &&
      cp "$C.crt" "$G/https.crt.new" && mv "$G/https.key.new" "$G/https.key" && mv "$G/https.crt.new" "$G/https.crt" &&
      touch "$G/https.reload" && echo "$n: new certificate"
  fi
  [ -f "$G/https.reload" ] || continue
  real=$(sed -nE '/^\[server\]/,/^\[/s/^address = "[^"]*:([0-9]+)".*/\1/p' "$S/lazymc.toml" | head -1)
  lz=$(sed -nE '/^\[public\]/,/^\[/s/^address = "[^"]*:([0-9]+)".*/\1/p' "$S/lazymc.toml" | head -1)
  (exec 3<>"/dev/tcp/127.0.0.1/$real") 2>/dev/null || { rm -f "$G/https.reload"; continue; }   # asleep: read on start
  # through lazymc (no PROXY header needed; it doesn't wake an awake server): how many are online?
  st=$(node "$HERE/../gate/probe.mjs" status 127.0.0.1 "$lz" 2>/dev/null) || continue
  case "$st" in *'"players":0'*) ;; *) continue ;; esac
  script=$(ls "$S/lgsm/config-lgsm" | head -1)
  (cd "$S" && ./"$script" send "geyser reload" >/dev/null 2>&1) && rm -f "$G/https.reload" && echo "$n: Geyser reloaded"
done
