#!/usr/bin/env python3
"""WardenUpdate: updates a Minecraft server set up like WardenGate expects (LinuxGSM + lazymc + pm2):
the server itself (Paper, Fabric or vanilla) and its plugins or mods.

    python3 update/update.py <name>        (the server in <serversDir>/mc-<name>)

First it only looks and shows: what you have, what is newer for your Minecraft version and, if you pick a newer
version, which plugins or mods would have a version for it. Nothing changes without asking. When applying: it puts the
server to sleep if it's awake, keeps whatever it replaces in serverfiles/updates/<date>/, checks every download's hash,
and updates lazymc.toml and LinuxGSM's version. At the end it can wake it to see whether it starts without errors.

Where it looks: Paper → fill.papermc.io · Fabric → meta.fabricmc.net · vanilla → Mojang · plugins and mods → Modrinth
(by the jar's hash) · Geyser and Floodgate → GeyserMC · the rest, GitHub (the repository in its plugin.yml, or those in
GITHUB) by version number. Anything not found anywhere (or your own: the Warden plugins and config.json's ownPlugins)
is reported and left to you. Messages in English or Spanish (config.json «language»). Test: python3 update/update.test.py
"""
import hashlib, json, os, re, shutil, subprocess, sys, time, urllib.parse, urllib.request, zipfile
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
HOME = Path(os.environ.get('WARDEN_HOME', Path.home() / '.config' / 'warden'))
try:
    SITE = json.loads((HOME / 'config.json').read_text())
except (FileNotFoundError, ValueError):
    SITE = {}
SERVERS = Path(SITE.get('serversDir', Path.home() / 'minecraft'))
LANG = SITE.get('language', 'en')
UA = {'user-agent': 'warden-update (github.com/JosueMeserom/warden)'}
PAPER = 'https://fill.papermc.io/v3/projects/paper'
FABRIC = 'https://meta.fabricmc.net/v2/versions'
MOJANG = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
MODRINTH = 'https://api.modrinth.com/v2'
GEYSER = 'https://download.geysermc.org/v2/projects'
GEYSER_PLUGINS = {'Geyser-Spigot': 'geyser', 'floodgate': 'floodgate'}   # plugin.yml name → project
GITHUB = {'WebConsole': 'mesacarlos/WebConsole'}                       # those that don't name their repository
OWN = {'WardenPanel', 'WardenList', *SITE.get('ownPlugins', [])}
# In order of preference: BlueMap publishes the same version for paper and spigot, and we want the paper one.
LOADERS = {'paper': [['paper'], ['spigot', 'bukkit']], 'fabric': [['fabric']]}

ES = {
    'No such server «{}». There are: {}': 'No existe el servidor «{}». Hay: {}',
    'No answer: nothing else changes.': 'Sin respuesta: no cambio nada más.',
    'the hash of {} doesn\'t match: download discarded': 'la huella de {} no coincide: descarga descartada',
    '    ·  {:44} yours: rebuild it from source': '    ·  {:44} tuyo: se compila desde su código',
    '; rebuild it and test it with {} (it may break if the API changes)': '; recompílalo y pruébalo con la {} (puede romperse si cambia la API)',
    '    ?  {:44} not on Modrinth nor GeyserMC: check it by hand': '    ?  {:44} no está en Modrinth ni GeyserMC: míralo a mano',
    ' · GitHub, no published hash': ' · GitHub, sin huella publicada',
    '  · players need it too': '  · los jugadores también tienen que tenerlo',
    '    ?  {:44} GitHub doesn\'t say whether it works with {}': '    ?  {:44} GitHub no dice si va con la {}',
    '    ✓  {:44} up to date (GitHub)': '    ✓  {:44} al día (GitHub)',
    'has a version for {}': 'tiene versión para {}', 'up to date': 'al día',
    '    ✗  {:44} no version marked for {}': '    ✗  {:44} sin versión marcada para {}', ' (it may work anyway)': ' (puede funcionar igual)',
    '{} is awake: it has to sleep to change its files (it kicks whoever is in). Put it to sleep?':
        '{} está despierto: hay que dormirlo para cambiar sus ficheros (echa a quien esté dentro). ¿Lo duermo?',
    '  LinuxGSM: mcversion="{}" · lazymc: version {}, protocol {}': '  LinuxGSM: mcversion="{}" · lazymc: versión {}, protocolo {}',
    '  Java: {} needs {}; start.sh now uses {}': '  Java: {} necesita la {}; start.sh ya usa {}',
    '  ⚠️ {} needs Java {} and the server uses {}: install it before waking it': '  ⚠️ {} necesita Java {} y el servidor usa la {}: instálala antes de despertarlo',
    '  pm2: {} restarted (so it announces the new version while asleep)': '  pm2: {} reiniciado (para que anuncie la versión nueva mientras duerme)',
    'Wake it now to see whether it starts without errors? (~1 minute)': '¿Lo despierto ahora para ver si arranca sin errores? (~1 minuto)',
    '  Started without errors.': '  Arrancado sin errores.', '  Error lines while starting (see its logs/latest.log):': '  Líneas de error del arranque (mira su logs/latest.log):',
    '  Which ones do I update? «all», numbers (e.g. 1 3) or Enter for none: ': '  ¿Cuáles actualizo? «todos», números (p. ej. 1 3) o Intro para ninguno: ',
    ' · Java {} · protocol {}': ' · Java {} · protocolo {}', ' · awake now': ' · ahora despierto', ' · asleep': ' · dormido',
    '  Paper build {}': '  Paper build {}', 'unknown': 'desconocida', ' → {} is out (stable)': ' → hay la {} (estable)', ' (up to date)': ' (al día)',
    '  ⚠️ Paper no longer supports {} ({}{})': '  ⚠️ Paper ya no da soporte a la {} ({}{})', ', since ': ', desde ',
    '  Fabric loader {}': '  Fabric loader {}', ' → {} is out (stable) ': ' → hay el {} (estable)',
    '  Newer Minecraft versions: {}': '  Versiones más nuevas de Minecraft: {}', 'none': 'ninguna',
    '\n  {} ({}), for {}:': '\n  {} ({}), para la {}:',
    '\nSee how they would do on another version? Type which ({}) or Enter to stay on {}: ': '\n¿Ver qué tal irían en otra versión? Escribe cuál ({}) o Intro para seguir en la {}: ',
    '\n  For {}:': '\n  Para la {}:',
    '\n  ⚠️ {} without a version for {}: if you move, they stay as they are (and may not load).': '\n  ⚠️ {} sin versión para la {}: si pasas, se quedarían como están (y pueden no cargar).',
    '  A world opened with a newer version can\'t be opened with the old one again: a backup comes first.': '  Un mundo abierto con una versión nueva no se puede volver a abrir con la vieja: se hace copia antes.',
    '\nMove {} to {}?': '\n¿Pasar {} a la {}?',
    '  Set aside the {} without a version for {}? (kept in the backup and not loaded)': '  ¿Aparto los {} sin versión para la {}? (se guardan en la copia y no se cargan)',
    '\nUpdate {}?': '\n¿Actualizar {}?', 'Paper to build {}': 'Paper a la build {}', 'the Fabric loader to {}': 'el loader de Fabric a {}',
    '  Note: {} also go into every player\'s game: they\'ll have to update them.': '  Ojo: {} también van en el juego de cada jugador: tendrán que actualizarlos.',
    'Nothing to do.': 'Nada que hacer.', 'Go on?': '¿Sigo?', 'It\'s still awake: I\'m not touching anything.': 'Sigue despierto: no toco nada.',
    'Full LinuxGSM backup before changing version (world included; it can take a while)?': 'Copia de seguridad completa con LinuxGSM antes de cambiar de versión (mundo incluido; puede tardar)?',
    'The backup failed: stopping.': 'La copia ha fallado: no sigo.', 'Paper has no stable build for {}': 'Paper no tiene build estable para la {}',
    '  ✓ Paper {} build {}': '  ✓ Paper {} build {}', '  ✓ Fabric loader {} for {}': '  ✓ Fabric loader {} para la {}', '  ✓ Minecraft {}': '  ✓ Minecraft {}',
    'server: {}': 'servidor: {}', '  · {} set aside (no version for {})': '  · {} apartado (sin versión para la {})',
    '  What was replaced is in {} (to go back, copy it back).': '  Lo sustituido está en {} (para volver atrás, se copia de vuelta).',
    '\nCancelled: nothing else has changed beyond what was already said.': '\nCancelado: no se ha cambiado nada más de lo que ya se haya dicho.',
}
def _(text, *args):
    return (ES.get(text, text) if LANG == 'es' else text).format(*args)

# ─────────────────────── Utilities ───────────────────────

def fetch(url, body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(url, data=data, headers={**UA, **({'content-type': 'application/json'} if data else {})})
    with urllib.request.urlopen(r, timeout=60) as f:
        return json.load(f)

def digest(path, alg):
    return hashlib.new(alg, Path(path).read_bytes()).hexdigest()

def download(url, dest, alg=None, expected=None):
    """Downloads to a temporary file, checks the hash and only then puts it in place."""
    tmp = Path(str(dest) + '.downloading')
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=300) as f, open(tmp, 'wb') as o:
        shutil.copyfileobj(f, o)
    if alg and digest(tmp, alg) != expected:
        tmp.unlink()
        raise RuntimeError(_('the hash of {} doesn\'t match: download discarded', Path(dest).name))
    tmp.replace(dest)

def from_zip(jar, name):
    try:
        with zipfile.ZipFile(jar) as z:
            return z.read(name).decode('utf-8', 'replace')
    except (KeyError, zipfile.BadZipFile, FileNotFoundError):
        return None

def version_key(v):
    """«1.21.11» < «26.1.2» < «26.3»: compares by numbers."""
    return [int(x) for x in re.findall(r'\d+', v)]

def is_release(v):
    return re.fullmatch(r'\d+(\.\d+)+', v) is not None

def ask(text):
    try:
        return input(text).strip()
    except EOFError:                                    # nobody there: nothing is ever taken as accepted
        print()
        sys.exit(_('No answer: nothing else changes.'))

def yes(text, default='y'):
    r = ask(f'{text} [{"Y/n" if default == "y" else "y/N"}] ').lower() or default
    return r.startswith(('y', 's'))

def java_major(binary):
    try:
        out = subprocess.run([binary, '-version'], capture_output=True, text=True).stderr
        return int(re.search(r'version "(\d+)', out).group(1))
    except Exception:
        return None

# ─────────────────────── The server ───────────────────────

def server(name):
    name = SITE.get('aliases', {}).get(name, name)
    d = SERVERS / f'mc-{name}'
    if not (d / 'lazymc.toml').exists():
        there = ' '.join(sorted(p.parent.name[3:] for p in SERVERS.glob('mc-*/lazymc.toml')))
        sys.exit(_('No such server «{}». There are: {}', name, there))
    script = sorted(os.listdir(d / 'lgsm/config-lgsm'))[0]          # pmcserver or mcserver
    sf = d / 'serverfiles'
    if script == 'pmcserver':
        kind, jar = 'paper', sf / 'paper.jar'
    elif (sf / 'fabric-server-launch.jar').exists():
        kind, jar = 'fabric', sf / 'server.jar'
    else:
        kind, jar = 'vanilla', next((p for p in (sf / 'minecraft_server.jar', sf / 'server.jar') if p.exists()), sf / 'server.jar')
    info = json.loads(from_zip(jar, 'version.json') or '{}')
    s = dict(name=name, dir=d, sf=sf, script=script, kind=kind, jar=jar, version=info.get('id', '?'),
             protocol=info.get('protocol_version'), java=info.get('java_version'))
    if kind == 'fabric':
        loaders = sorted(os.listdir(sf / 'libraries/net/fabricmc/fabric-loader'), key=version_key)
        s['loader'] = loaders[-1] if loaders else '?'
        s['java_bin'] = (re.search(r'^JAVA_BIN="(.*)"', (sf / 'start.sh').read_text(), re.M) or [None, 'java'])[1]
    else:
        s['java_bin'] = 'java'
    return s

def awake(s):
    uid = (s['dir'] / f'lgsm/data/{s["script"]}.uid')
    if not uid.exists():
        return False
    sock = f'{s["script"]}-{uid.read_text().strip()}'
    return subprocess.run(['tmux', '-L', sock, 'has-session', '-t', s['script']], capture_output=True).returncode == 0

def lazymc_port(s):
    m = re.search(r'\[public\][^\[]*?address\s*=\s*"[^"]*:(\d+)"', (s['dir'] / 'lazymc.toml').read_text())
    return m and m.group(1)

def put_to_sleep(s):
    """Like the panel: stop lazymc's wrapper (it runs «./script stop») so lazymc goes back to waiting; or stop it by hand."""
    if subprocess.run(['pkill', '-TERM', '-f', f'lgsm.sh {s["dir"]} ']).returncode != 0:
        subprocess.run([str(s['dir'] / s['script']), 'stop'], cwd=s['dir'], env={**os.environ, 'TMUX': '', 'TMUX_PANE': ''}, capture_output=True)
    for _i in range(120):
        if not awake(s):
            return True
        time.sleep(1)
    return not awake(s)

def wake(s):
    """As if a player joined: lazymc starts it (and will put it to sleep itself)."""
    subprocess.Popen(['node', str(HERE.parent / 'gate/probe.mjs'), 'join', '127.0.0.1', str(lazymc_port(s)), str(s.get('protocol') or -1)],
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

# ─────────────────────── What is newer for the server ───────────────────────

def paper_build(version, stable=True):
    builds = fetch(f'{PAPER}/versions/{version}/builds')                 # newest first
    b = next((b for b in builds if not stable or b['channel'] == 'STABLE'), None)
    if b:
        f = b['downloads']['server:default']
        return dict(id=b['id'], url=f['url'], alg='sha256', hash=f['checksums']['sha256'])

def server_news(s):
    """What's new within the same Minecraft version, and the newer versions out there."""
    v = s['version']
    if s['kind'] == 'paper':
        h = digest(s['jar'], 'sha256')
        builds = fetch(f'{PAPER}/versions/{v}/builds')
        s['build'] = next((b['id'] for b in builds if b['downloads']['server:default']['checksums']['sha256'] == h), None)
        latest = paper_build(v)
        support = fetch(f'{PAPER}/versions/{v}')['version'].get('support', {})
        everything = [x for group in fetch(PAPER)['versions'].values() for x in group]
        return dict(same=latest if latest and latest['id'] != s['build'] else None, support=support,
                    newer=sorted({x for x in everything if is_release(x) and version_key(x) > version_key(v)}, key=version_key))
    if s['kind'] == 'fabric':
        loader = next(l['loader']['version'] for l in fetch(f'{FABRIC}/loader/{v}') if l['loader']['stable'])
        games = [g['version'] for g in fetch(f'{FABRIC}/game') if g['stable']]
        return dict(same=loader if version_key(loader) > version_key(s['loader']) else None,
                    newer=sorted({g for g in games if version_key(g) > version_key(v)}, key=version_key))
    releases = [x['id'] for x in fetch(MOJANG)['versions'] if x['type'] == 'release']
    return dict(same=None, newer=sorted({x for x in releases if version_key(x) > version_key(v)}, key=version_key))

def vanilla_jar(version):
    url = next(x['url'] for x in fetch(MOJANG)['versions'] if x['id'] == version)
    d = fetch(url)['downloads']['server']
    return dict(url=d['url'], alg='sha1', hash=d['sha1'])

# ─────────────────────── Plugins and mods ───────────────────────

def read_addons(s):
    folder = s['sf'] / ('plugins' if s['kind'] == 'paper' else 'mods')
    found = []
    for jar in sorted(folder.glob('*.jar'), key=lambda p: p.name.lower()):
        name = version = web = None
        yml = from_zip(jar, 'paper-plugin.yml') or from_zip(jar, 'plugin.yml')
        if yml:
            name = (re.search(r'^name:\s*["\']?([^"\'\n]+)', yml, re.M) or [None, None])[1]
            version = (re.search(r'^version:\s*["\']?([^"\'\n]+)', yml, re.M) or [None, None])[1]
            web = (re.search(r'^website:\s*["\']?([^"\'\n]+)', yml, re.M) or [None, None])[1]
        mod = from_zip(jar, 'fabric.mod.json')
        if mod:
            try:
                m = json.loads(mod, strict=False)
                name, version = m.get('name') or m.get('id'), m.get('version')
                web = (m.get('contact') or {}).get('sources')
            except ValueError:
                pass
        repo = GITHUB.get((name or '').strip()) or (re.search(r'github\.com/([\w.-]+/[\w.-]+?)(?:\.git)?/?$', web or '') or [None, None])[1]
        found.append(dict(jar=jar, name=(name or jar.stem).strip(), version=(version or '?').strip(), repo=repo,
                          sha1=digest(jar, 'sha1'), sha256=digest(jar, 'sha256')))
    return found

def lookup(s, addons, version):
    """Fills in, for each addon, where it comes from and which version it would get for «version»."""
    if not addons:
        return addons
    hashes = [c['sha1'] for c in addons]
    current = fetch(f'{MODRINTH}/version_files', {'hashes': hashes, 'algorithm': 'sha1'})
    newer = {}
    for loaders in LOADERS.get(s['kind'], []):
        missing = [h for h in hashes if h in current and h not in newer]
        if missing:
            newer.update(fetch(f'{MODRINTH}/version_files/update', {'hashes': missing, 'algorithm': 'sha1',
                               'loaders': loaders, 'game_versions': [version]}))
    projects = {p['id']: p for p in fetch(f'{MODRINTH}/projects?ids=' + urllib.parse.quote(json.dumps(
                sorted({v['project_id'] for v in current.values()}))))} if current else {}
    for c in addons:
        c['new'] = None
        if c['name'] in GEYSER_PLUGINS and s['kind'] == 'paper':
            p = GEYSER_PLUGINS[c['name']]
            b = fetch(f'{GEYSER}/{p}/versions/latest/builds/latest')
            c['source'] = 'GeyserMC'
            if b['downloads']['spigot']['sha256'] != c['sha256']:
                c['new'] = dict(version=f'{b["version"]}-b{b["build"]}', file=c['jar'].name, alg='sha256',
                                hash=b['downloads']['spigot']['sha256'], type='release',
                                url=f'{GEYSER}/{p}/versions/{b["version"]}/builds/{b["build"]}/downloads/spigot')
            c['for'] = True                             # GeyserMC always tracks the latest Minecraft version
        elif c['sha1'] in current:
            v = current[c['sha1']]
            pr = projects.get(v['project_id'], {})
            c['source'], c['version'] = 'Modrinth', v['version_number']
            c['client'] = pr.get('client_side') == 'required'
            n = newer.get(c['sha1'])
            if n and n['version_type'] != 'release' and v['version_type'] == 'release':
                n = stable(v['project_id'], n['loaders'], version) or n   # if you have a stable one, only stable ones
            c['for'] = n is not None                    # False: Modrinth says there's none for that version
            if n:
                f = next((f for f in n['files'] if f.get('primary')), n['files'][0])
                if f['hashes']['sha1'] != c['sha1']:
                    c['new'] = dict(version=n['version_number'], file=f['filename'], url=f['url'],
                                    alg='sha512', hash=f['hashes']['sha512'], type=n['version_type'])
        elif c['repo'] and (r := github(c)):
            c['source'], c['for'] = 'GitHub', None      # None: GitHub doesn't say which versions it works with
            c['new'] = r if r['version'] != c['version'] else None
        else:
            c['source'], c['for'] = ('own' if c['name'] in OWN else None), None
    return addons

def stable(project, loaders, version):
    q = urllib.parse.urlencode({'loaders': json.dumps(loaders), 'game_versions': json.dumps([version])})
    return next((v for v in fetch(f'{MODRINTH}/project/{project}/version?{q}') if v['version_type'] == 'release'), None)

def github(c):
    """Latest release on GitHub (no drafts nor pre-releases), and its jar: the one with the same name or the only one."""
    try:
        r = fetch(f'https://api.github.com/repos/{c["repo"]}/releases/latest')
    except Exception:
        return None
    jars = [a for a in r['assets'] if a['name'].endswith('.jar')]
    a = next((a for a in jars if a['name'] == c['jar'].name), jars[0] if len(jars) == 1 else None)
    if not a:
        return None
    d = a.get('digest') or ''
    return dict(version=r['tag_name'].lstrip('vV'), file=a['name'], url=a['browser_download_url'], type='release',
                alg='sha256' if d.startswith('sha256:') else None, hash=d[7:] or None)

def show(addons, version, changing=False):
    pending = []
    for c in addons:
        name = f'{c["name"]} {c["version"]}'
        if c['source'] == 'own':
            print(_('    ·  {:44} yours: rebuild it from source', name) + (_('; rebuild it and test it with {} (it may break if the API changes)', version) if changing else ''))
        elif c['source'] is None:
            print(_('    ?  {:44} not on Modrinth nor GeyserMC: check it by hand', name))
        elif c['new']:
            pending.append(c)
            extra = f' ({c["new"]["type"]})' if c['new']['type'] != 'release' else ''
            extra += _(' · GitHub, no published hash') if c['source'] == 'GitHub' and not c['new']['alg'] else ''
            print(f'  {len(pending):>2}) {name:44} → {c["new"]["version"]}{extra}' + (_('  · players need it too') if c.get('client') else ''))
        elif c['source'] == 'GitHub':
            print(_('    ?  {:44} GitHub doesn\'t say whether it works with {}', name, version) if changing else _('    ✓  {:44} up to date (GitHub)', name))
        elif c['for']:
            print(f'    ✓  {name:44} {_("has a version for {}", version) if changing else _("up to date")}')
        else:
            print(_('    ✗  {:44} no version marked for {}', name, version) + ('' if changing else _(' (it may work anyway)')))
    return pending

# ─────────────────────── Applying ───────────────────────

def sleep_first(s):
    if not awake(s):
        return True
    if not yes(_('{} is awake: it has to sleep to change its files (it kicks whoever is in). Put it to sleep?', s['name'])):
        return False
    return put_to_sleep(s)

def set_version(s, version, new_jar):
    """LinuxGSM, lazymc and Java for the new version."""
    info = json.loads(from_zip(new_jar, 'version.json') or '{}')
    cfg = s['dir'] / f'lgsm/config-lgsm/{s["script"]}/{s["script"]}.cfg'
    t = cfg.read_text()
    cfg.write_text(re.sub(r'^mcversion="[^"]*"', f'mcversion="{version}"', t, flags=re.M) if 'mcversion=' in t else t + f'mcversion="{version}"\n')
    toml = s['dir'] / 'lazymc.toml'
    t = re.sub(r'^(\[public\][^\[]*?^version = )"[^"]*"', rf'\g<1>"{version}"', toml.read_text(), count=1, flags=re.M | re.S)
    if info.get('protocol_version'):
        t = re.sub(r'^protocol = \d+', f'protocol = {info["protocol_version"]}', t, count=1, flags=re.M)
    toml.write_text(t)
    print(_('  LinuxGSM: mcversion="{}" · lazymc: version {}, protocol {}', version, version, info.get('protocol_version', '?')))
    needs, has = info.get('java_version'), java_major(s['java_bin'])
    if needs and has and has < needs:
        other = Path(f'/usr/lib/jvm/java-{needs}-openjdk-amd64/bin/java')
        if s['kind'] == 'fabric' and other.exists():
            st = s['sf'] / 'start.sh'
            st.write_text(re.sub(r'^JAVA_BIN=".*"', f'JAVA_BIN="{other}"', st.read_text(), flags=re.M))
            print(_('  Java: {} needs {}; start.sh now uses {}', version, needs, other))
        else:
            print(_('  ⚠️ {} needs Java {} and the server uses {}: install it before waking it', version, needs, has))

def restart_lazymc(s):
    app = f'mc-{s["name"]}'
    names = [a['name'] for a in json.loads(subprocess.run(['pm2', 'jlist'], capture_output=True, text=True).stdout or '[]')]
    if app in names:
        subprocess.run(['pm2', 'restart', app], capture_output=True, env={k: v for k, v in os.environ.items() if not k.startswith('TMUX')})
        print(_('  pm2: {} restarted (so it announces the new version while asleep)', app))

def check_start(s):
    if not yes(_('Wake it now to see whether it starts without errors? (~1 minute)')):
        return
    log = s['sf'] / 'logs/latest.log'
    before = log.stat().st_mtime if log.exists() else 0
    wake(s)
    for _i in range(120):                               # the new log, up to «Done»
        if log.exists() and log.stat().st_mtime > before and 'Done (' in log.read_text(errors='replace'):
            break
        time.sleep(1)
    text = log.read_text(errors='replace') if log.exists() else ''
    bad = [l for l in text.splitlines() if re.search(r'/(ERROR|FATAL)\]|Could not load|Error occurred while enabling', l)]
    print(_('  Started without errors.') if 'Done (' in text and not bad else
          '\n'.join([_('  Error lines while starting (see its logs/latest.log):')] + ['    ' + l[:160] for l in bad[:15]]))

def choose(pending):
    if not pending:
        return []
    r = ask(_('  Which ones do I update? «all», numbers (e.g. 1 3) or Enter for none: ')).lower()
    if r in ('all', 'a', 'todos', 't', 'todo'):
        return pending
    return [pending[int(n) - 1] for n in re.findall(r'\d+', r) if 0 < int(n) <= len(pending)]

def main(name):
    s = server(name)
    print(f'\n{s["name"]}: {s["kind"].capitalize()} {s["version"]}' + (f' · Fabric loader {s["loader"]}' if s['kind'] == 'fabric' else '') +
          _(' · Java {} · protocol {}', s['java'], s['protocol']) + (_(' · awake now') if awake(s) else _(' · asleep')))
    news = server_news(s)
    if s['kind'] == 'paper':
        print(_('  Paper build {}', s['build'] or _('unknown')) + (_(' → {} is out (stable)', news['same']['id']) if news['same'] else _(' (up to date)')))
        sup = news.get('support', {})
        if sup.get('status') and sup['status'] != 'SUPPORTED':
            print(_('  ⚠️ Paper no longer supports {} ({}{})', s['version'], sup['status'], _(', since ') + sup['end'] if sup.get('end') else ''))
    elif s['kind'] == 'fabric':
        print(_('  Fabric loader {}', s['loader']) + (_(' → {} is out (stable) ', news['same']).rstrip() if news['same'] else _(' (up to date)')))
    print(_('  Newer Minecraft versions: {}', ' '.join(news['newer']) or _('none')))

    addons = read_addons(s)
    print(_('\n  {} ({}), for {}:', 'Plugins' if s['kind'] == 'paper' else 'Mods', len(addons), s['version']))
    pending = show(lookup(s, addons, s['version']), s['version'])

    target, without = s['version'], []
    if news['newer']:
        r = ask(_('\nSee how they would do on another version? Type which ({}) or Enter to stay on {}: ', ', '.join(news['newer']), s['version']))
        if r in news['newer']:
            print(_('\n  For {}:', r))
            addons_r = lookup(s, read_addons(s), r)
            pending_r = show(addons_r, r, changing=True)
            without = [c for c in addons_r if c['for'] is False]
            if without:
                print(_('\n  ⚠️ {} without a version for {}: if you move, they stay as they are (and may not load).', len(without), r))
            print(_('  A world opened with a newer version can\'t be opened with the old one again: a backup comes first.'))
            if yes(_('\nMove {} to {}?', s['name'], r), 'n'):
                target, pending = r, pending_r
                # On Fabric a mod for another version usually breaks the start; on Paper many plugins work anyway.
                if without and not yes(_('  Set aside the {} without a version for {}? (kept in the backup and not loaded)', len(without), r),
                                       'y' if s['kind'] == 'fabric' else 'n'):
                    without = []
            else:
                without = []
    changing = target != s['version']

    do_server = changing or (news['same'] and yes(_('\nUpdate {}?', _('Paper to build {}', news['same']['id']) if s['kind'] == 'paper' else _('the Fabric loader to {}', news['same']))))
    print()
    chosen = pending if changing else choose(pending)
    clients = [c for c in chosen if c.get('client')]
    if clients:
        print(_('  Note: {} also go into every player\'s game: they\'ll have to update them.', ', '.join(c['name'] for c in clients)))
    if not do_server and not chosen and not without:
        print(_('Nothing to do.'))
        return
    if not yes(_('Go on?')):
        return
    if not sleep_first(s):
        print(_('It\'s still awake: I\'m not touching anything.'))
        return
    if changing and yes(_('Full LinuxGSM backup before changing version (world included; it can take a while)?')):
        if subprocess.run([str(s['dir'] / s['script']), 'backup'], cwd=s['dir']).returncode != 0:
            print(_('The backup failed: stopping.'))
            return

    backup = s['sf'] / 'updates' / datetime.now().strftime('%Y-%m-%d_%H%M')
    backup.mkdir(parents=True, exist_ok=True)
    failures = []
    if do_server:
        try:
            if s['kind'] == 'paper':
                b = paper_build(target)
                if not b:
                    raise RuntimeError(_('Paper has no stable build for {}', target))
                shutil.copy2(s['jar'], backup / s['jar'].name)
                download(b['url'], s['jar'], b['alg'], b['hash'])
                print(_('  ✓ Paper {} build {}', target, b['id']))
            else:
                if s['kind'] == 'fabric':
                    launcher = s['sf'] / 'fabric-server-launch.jar'
                    loader = news['same'] if not changing else next(l['loader']['version'] for l in fetch(f'{FABRIC}/loader/{target}') if l['loader']['stable'])
                    loader = loader or s['loader']
                    inst = next(i['version'] for i in fetch(f'{FABRIC}/installer') if i['stable'])
                    shutil.copy2(launcher, backup / launcher.name)
                    download(f'{FABRIC}/loader/{target}/{loader}/{inst}/server/jar', launcher)   # Fabric publishes no hashes
                    print(_('  ✓ Fabric loader {} for {}', loader, target))
                if changing:
                    j = vanilla_jar(target)
                    shutil.copy2(s['jar'], backup / s['jar'].name)
                    download(j['url'], s['jar'], j['alg'], j['hash'])
                    print(_('  ✓ Minecraft {}', target))
            if changing:
                set_version(s, target, s['jar'])
        except Exception as e:
            failures.append(_('server: {}', e))
    for c in chosen:
        n = c['new']
        try:
            new = c['jar'].with_name(n['file'])
            download(n['url'], c['jar'].with_name(n['file'] + '.new'), n['alg'], n['hash'])
            shutil.move(c['jar'], backup / c['jar'].name)
            c['jar'].with_name(n['file'] + '.new').replace(new)
            print(f'  ✓ {c["name"]} {c["version"]} → {n["version"]}')
        except Exception as e:
            failures.append(f'{c["name"]}: {e}')
    for c in without:
        shutil.move(c['jar'], backup / c['jar'].name)
        print(_('  · {} set aside (no version for {})', c['name'], target))
    if not any(backup.iterdir()):
        backup.rmdir()
    else:
        print(_('  What was replaced is in {} (to go back, copy it back).', backup))
    for f in failures:
        print(f'  ✗ {f}')
    if changing:
        restart_lazymc(s)
    check_start(s)

if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    try:
        main(sys.argv[1])
    except KeyboardInterrupt:
        print(_('\nCancelled: nothing else has changed beyond what was already said.'))
