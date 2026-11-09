# python3 update/update.test.py — what needs no network: versions, a new version's settings and the messages.
import json, os, sys, tempfile, zipfile
from pathlib import Path
os.environ['WARDEN_HOME'] = tempfile.mkdtemp()
sys.path.insert(0, str(Path(__file__).parent))
import update as U

assert sorted(['26.3', '1.21.11', '26.1.2', '1.21.4'], key=U.version_key) == ['1.21.4', '1.21.11', '26.1.2', '26.3']
assert U.is_release('26.3') and U.is_release('1.21.11') and not U.is_release('26.3-rc-3') and not U.is_release('25w14a')

with tempfile.TemporaryDirectory() as t:
    d = Path(t) / 'mc-x'; (d / 'lgsm/config-lgsm/pmcserver').mkdir(parents=True); (d / 'serverfiles').mkdir()
    (d / 'lgsm/config-lgsm/pmcserver/pmcserver.cfg').write_text('port="35580"\nmcversion="1.21.11"\nmaxram="4G"\n')
    (d / 'lazymc.toml').write_text('[public]\naddress = "127.0.0.1:45580"\nversion = "1.21.11"\nprotocol = 774\n\n[server]\naddress = "x"\n\n[advanced]\nversion = "0.2.11"\n')
    jar = d / 'serverfiles/paper.jar'
    with zipfile.ZipFile(jar, 'w') as z:
        z.writestr('version.json', json.dumps({'id': '26.3', 'protocol_version': 777, 'java_version': 25}))
    s = dict(name='x', dir=d, sf=d / 'serverfiles', script='pmcserver', kind='paper', jar=jar, java_bin='java')
    U.set_version(s, '26.3', jar)
    cfg = (d / 'lgsm/config-lgsm/pmcserver/pmcserver.cfg').read_text()
    assert 'mcversion="26.3"' in cfg and 'maxram="4G"' in cfg
    toml = (d / 'lazymc.toml').read_text()
    assert 'version = "26.3"\nprotocol = 777' in toml, toml
    assert '[advanced]\nversion = "0.2.11"' in toml, 'lazymc\'s own version ([advanced]) is left alone'
    assert U.lazymc_port(s) == '45580'

# Messages: English by default, Spanish with language «es», with the same slots
assert U._('Paper has no stable build for {}', '26.3') == 'Paper has no stable build for 26.3'
U.LANG = 'es'
assert U._('Paper has no stable build for {}', '26.3') == 'Paper no tiene build estable para la 26.3'
import re
src = (Path(__file__).parent / 'update.py').read_text()
used = set(re.findall(r"_\('((?:[^'\\]|\\.)*)'", src)) | set(re.findall(r'_\("((?:[^"\\]|\\.)*)"', src))
used = {u.encode().decode('unicode_escape').encode('latin-1').decode('utf-8') for u in used}
missing = [u for u in used if u not in U.ES and u not in ('{}',)]
assert not missing, f'without Spanish: {missing}'
for k, v in U.ES.items():
    assert k.count('{') == v.count('{'), f'slots differ: {k}'
print('update: ok')
