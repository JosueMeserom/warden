// pm2 example: one lazymc per server (mc-<name>), plus the gate and the panel. Copy it to WARDEN_HOME, adjust the
// paths, set config.json «ecosystem» to it (new-server.sh adds new servers here), then: pm2 start <it> && pm2 save
const REPO = '/home/you/warden', SERVERS = '/home/you/minecraft', LAZYMC = '/usr/local/bin/lazymc';
const app = folder => ({
  name: folder, script: LAZYMC, args: `start --config ${SERVERS}/${folder}/lazymc.toml`, cwd: `${SERVERS}/${folder}`,
  interpreter: 'none', autorestart: true, restart_delay: 5000,
  kill_timeout: 90000,            // on stop, LinuxGSM saves and stops the server: give it time
  time: true,
});
const gate = { name: 'warden-gate', script: `${REPO}/gate/gate.mjs`, cwd: REPO, autorestart: true, restart_delay: 5000, time: true };
const panel = { name: 'warden-panel', script: `${REPO}/panel/server.mjs`, cwd: REPO, autorestart: true, restart_delay: 5000, time: true };
module.exports = { apps: ['mc-lobby'].map(app).concat(gate, panel) };
