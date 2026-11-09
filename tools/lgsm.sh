#!/bin/bash
# lazymc's "server command". The server is still started and stopped by LinuxGSM, with its tmux and its usual options:
# this only gives lazymc a process that lives as long as the server does.
#   lgsm.sh <server folder> <LinuxGSM script>   (e.g. pmcserver)
# When lazymc wants it asleep it sends SIGTERM, which becomes "./pmcserver stop".
set -u
# If pm2 inherited the variables of a terminal running tmux (pm2 restart --update-env from inside tmux), LinuxGSM
# would refuse to start («Tmuxception»): this script never runs inside tmux.
unset TMUX TMUX_PANE
cd "$1" || exit 1
name="$2"                                  # inside a function, $2 would be something else
lgsm="./$name"
alive() { tmux -L "$socket" has-session -t "$name" 2>/dev/null; }
stop() { "$lgsm" stop >/dev/null 2>&1; exit 0; }
trap stop TERM INT

# If it was already running (started by hand), LinuxGSM says so and nothing happens.
"$lgsm" start >/dev/null 2>&1
# The session id (the same name LinuxGSM uses) is read AFTER starting: on a freshly installed server, LinuxGSM
# creates it on its first start.
socket="$name-$(cat "lgsm/data/$name.uid" 2>/dev/null)"
alive || exit 1
# LinuxGSM returns as soon as it creates the tmux session; here we wait for the server to die.
while alive; do sleep 5 & wait $!; done
