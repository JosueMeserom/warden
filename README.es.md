# Warden

Herramientas para tener unos cuantos servidores de Minecraft en casa que **duermen cuando nadie juega** y se despiertan
cuando alguien entra, detrás de una sola puerta de entrada y con un panel web. [English](README.md)

| Pieza | Qué hace |
|---|---|
| **WardenGate** (`gate/`) | La puerta de Java: elige el servidor por la dirección que escribe el jugador (`lobby.ejemplo.net`) o por el puerto, corta los bots escáner conocidos, aplica una lista blanca central con un **bot de Discord** (`/verificar`), pasa la **IP real del jugador**, apunta el país de cada uno y despierta los servidores dormidos también para **Bedrock** (NetherNet). |
| **WardenPanel** (`panel/`, `plugins/panel/`) | Panel web: estado, jugadores (estadísticas, inventario, logros, sesiones), clasificación, gráficas, chat y consola, ajustes del mundo, MOTD con colores, **investigación** (rayos X, destrozos, saqueos, comandos poderosos), relaciones y mapa de calor. Usuarios con permisos por servidor. En inglés y en español. |
| **WardenList** (`plugins/list/`) | Plugin de Paper: la misma lista blanca central dentro del servidor, para los de Bedrock (que no pasan por la puerta). |
| **WardenUpdate** (`update/`) | Actualiza un servidor (Paper, Fabric o vanilla) y sus plugins o mods desde Modrinth, GeyserMC y GitHub, comprobando la huella de cada descarga, y dice qué se rompería con una versión nueva de Minecraft. |
| Herramientas (`tools/`) | `new-server.sh` (un servidor nuevo montado como los demás), `lgsm.sh` (lazymc ⇄ LinuxGSM), `cert-geyser.sh` (el certificado de Bedrock). |

Sin más dependencias que Node.js (20 o más), Python 3 y, para el historial del panel, `sqlite3`. Ningún paquete de npm.

## Cómo encaja todo

```
JAVA ──► WardenGate :25565 (por nombre) y el puerto propio de cada servidor
           ├ bots.txt → cortado        ├ lista blanca (si la exige) → expulsado con un código para /verificar en Discord
           ▼ cabecera PROXY v2 con la IP real del jugador
         lazymc (127.0.0.1:<puerto+20000>)   dormido → lo arranca con LinuxGSM y retiene al jugador
           ▼ la misma cabecera
         servidor de Minecraft (127.0.0.1:<puerto+10000>, con proxy-protocol: ve la IP real)

BEDROCK ──► Geyser dentro del servidor (su propio puerto, TCP+UDP)
           mientras duerme, WardenGate contesta la señalización de Geyser («💤 Durmiendo») y lo despierta por lazymc
```

Se apoya en:

- **[LinuxGSM](https://linuxgsm.com)** para instalar y arrancar cada servidor (`pmcserver` en Paper, `mcserver` en
  Fabric), una carpeta por servidor: `<serversDir>/mc-<nombre>/` con su `lazymc.toml`.
- **[lazymc](https://github.com/JosueMeserom/lazymc/tree/warden)**, el **fork de Warden**: el lazymc original sabe
  mandar la IP real al servidor, pero no recibirla de un proxy que tenga delante, y nunca da por arrancado un servidor
  con el MOTD en colores. El fork añade `receive_proxy_v2` y arregla el MOTD (GPL-3.0, como el original).
- **pm2** para mantener en marcha lazymc, la puerta y el panel (`tools/ecosystem.example.cjs`).
- Opcionalmente **Caddy** (o cualquier proxy inverso con HTTPS) para el panel, la dirección del bot de Discord y las
  webs de los servidores (BlueMap, Plan, WebConsole).

### Puertos

Cada servidor usa un **bloque de 5** puertos públicos `P…P+4`: `P` Java (lo atiende la puerta), `P+1` Bedrock (Geyser,
TCP y UDP), `P+2` Plan, `P+3` WebConsole y `P+4` la query. Así, en el router basta **una regla por servidor** (`P–P+1`,
TCP y UDP), más el 25565 de la puerta. Por dentro: lazymc en `P+20000` y el servidor en `P+10000`, los dos en
`127.0.0.1`; el plugin del panel, en el puerto del servidor `+20000`.

## Instalación

1. **La configuración del sitio** va en `WARDEN_HOME` (por defecto `~/.config/warden`), nunca en el repo: copia
   `config.example.json` a `~/.config/warden/config.json` y edítalo.

   | Clave | Qué es |
   |---|---|
   | `serversDir` | La carpeta con un `mc-<nombre>/` por servidor. |
   | `domain`, `rootServer` | `<nombre>.<dominio>` elige servidor en la puerta; el dominio a secas va a `rootServer`. |
   | `language` | `en` o `es`: los mensajes a los jugadores, al dueño y en las herramientas. |
   | `owner` | A quién se dice a los jugadores que pidan ayuda. |
   | `notify` | La orden para avisar al dueño (un bot de chat…); el texto (HTML) va como último argumento. |
   | `aliases`, `ownPlugins` | WardenUpdate: otros nombres de servidores; tus propios plugins (no les busca versión). |
   | `ecosystem`, `caddy`, `geyserCerts` | Los usan `new-server.sh` y `cert-geyser.sh` (mira el ejemplo). |
   | `gate` | Puertos: el principal (25565), el desfase de lazymc y el del bot de Discord (8790); cuánto vale cada código. |
   | `panel` | Su puerto (en local), su dirección pública, la entrada del dueño (`sso`) y si `notify` puede editar mensajes. |

   Los datos también viven ahí: `whitelist.json`, `countries.json` (solo códigos de país, **nunca IP**), `bots.txt`,
   `discord.env` (`WARDEN_TOKEN=…`, permisos 600) y `panel/` (usuarios, sesiones, registro, cachés).

2. **El fork de lazymc**: compílalo (`cargo build --release` en el fork) y deja el binario en un sitio fijo. En cada
   `lazymc.toml`: `[public] address = "127.0.0.1:<P+20000>"`, `receive_proxy_v2 = true`, y `[server] command =
   "<repo>/tools/lgsm.sh <carpeta del servidor> <pmcserver|mcserver>"`.
3. **IP real**: `send_proxy_v2 = true` en lazymc y, en el servidor, `proxies.proxy-protocol: true` en Paper
   (`config/paper-global.yml`) y `advanced.java.use-haproxy-protocol: true` en Geyser; en Fabric, el mod
   [Proxy Protocol Support](https://modrinth.com/mod/proxy-protocol-support). Pon `server-ip=127.0.0.1`: quien llegara
   directo al servidor podría inventarse la IP. Sin esto el servidor ve a todos como 127.0.0.1 (entonces, nunca
   `/ban-ip`, y no te fíes de las sesiones por IP de los plugins de login).
4. **Plugins**: `PAPER=<carpeta de un servidor Paper> plugins/build.sh panel install` y `… list install` (javac, Java 21+).
5. **pm2**: adapta `tools/ecosystem.example.cjs` y luego `pm2 start … && pm2 save`.
6. **Bot de Discord** (opcional): crea una aplicación, escribe el token del bot en `WARDEN_HOME/discord.env` y apunta su
   *Interactions Endpoint URL* a tu proxy inverso → `127.0.0.1:8790`. Las órdenes (`/verificar`, `/lista-blanca`) se
   registran solas, en inglés y en español según el idioma de cada cliente.
7. **Panel**: proxy inverso con HTTPS → `127.0.0.1:8791` (pone cookies `Secure` y solo se fía de `X-Forwarded-For` si
   llega desde local). Los usuarios los crea el dueño desde el panel; el dueño entra con `panel.sso` (abajo).

Servidores nuevos: `tools/new-server.sh` hace todo lo anterior para uno más. Actualizar: `python3 update/update.py <nombre>`.

### Entrada del dueño (`panel.sso`)

El dueño no tiene contraseña en el panel: le hace entrar otra web de la que ya se fía. `/login/sso` redirige a
`sso.url?n=<nonce>`; esa web, cuando sabe que es el dueño, vuelve a
`<panel>/login/sso/return?n=<nonce>&e=<caducidad en ms>&f=<firma>` con `firma = base64url(HMAC-SHA256(clave,
"<subject>|<nonce>|<caducidad>"))`, donde la clave es `WARDEN_HOME/panel/sso.key` (la crea el panel, permisos 600) y
la caducidad queda como mucho a dos minutos.

## El panel

- Permisos por servidor (`*` = todos): `view`, `chat`, `moderate`, `ban`, `whitelist`, `investigate`, `inventories`,
  `items`, `world`, `power`, `console` (la consola lo incluye todo). Perfiles: espectador, moderador, administrador y
  administrador con consola.
- Todo lo que se hace desde él queda en `panel/log.jsonl`; al dueño se le avisa al momento de lo delicado, o en un
  resumen por sesión (se elige).
- Datos: lazymc y el proceso de Java; el **plugin WardenPanel** en Paper (`/status`, `/events`, `/inventory`,
  `/counters` en `127.0.0.1:<puerto del servidor + 20000>`, solo lectura, con la clave de `plugins/WardenPanel/key`); en
  Fabric, el ping de estado y el log. Las estadísticas y los inventarios salen de los ficheros del mundo, así que se ven
  también con el servidor dormido. La base de datos de Plan añade las sesiones y el historial.
- **Investigar**: la sospecha de rayos X sale solo de los diamantes *escondidos* (sin ninguna cara al aire) por cada 1000
  de piedra picada: los de las cuevas no acusan a nadie; bases (zonas donde alguien ha puesto 64 bloques o más), saqueos,
  destrozos, lava, fuego, TNT, withers y comandos poderosos en bases ajenas; la misma cuenta entrando desde varios países.
- Traducir: el código está en inglés y `panel/public/es.js` da el español de cada texto. `node panel/languages.test.mjs`
  dice qué falta. Los nombres de objetos, criaturas y logros salen de los ficheros de idioma oficiales de Mojang.

## Pruebas

```
node gate/gate.test.mjs                    # con GEOLITE=<GeoLite2-Country.mmdb> también mira los países
node gate/lazymc.test.mjs <binario lazymc> # de punta a punta con el fork: IP real y MOTD en colores (el original falla)
node panel/server.test.mjs && node panel/languages.test.mjs
python3 update/update.test.py
```

## Seguridad

- La puerta y lazymc tienen que ser el único camino a los servidores: `server-ip=127.0.0.1` y solo `P–P+1` abiertos.
- Los códigos de `/verificar` son de 6 cifras, uno por jugador y servidor, valen 30 minutos y solo están en memoria; una
  cuenta de Discord solo se puede enlazar a un nombre de Minecraft.
- El plugin nunca apunta las órdenes de los plugins de login ni los mensajes privados (solo una lista cerrada de comandos
  poderosos).
- Los secretos (`discord.env`, `sso.key`, la clave del plugin, `users.json`) se crean con permisos 600 en `WARDEN_HOME`.

## Licencia

[MIT](LICENSE). El fork de lazymc es GPL-3.0, como lazymc.
