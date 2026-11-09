#!/bin/bash
# Builds the Paper plugins (no Gradle, no downloads): javac against the libraries of a Paper server you already have.
# Built for Java 21 against the Paper 1.21.x API, they also work on 26.x.
#   PAPER=/path/to/a/paper/server plugins/build.sh panel|list [install]
#   install: copies the jar into every mc-*/serverfiles/plugins with a paper.jar under the configured serversDir
#            (WARDEN_HOME/config.json); it takes effect when each server restarts.
set -e
cd "$(dirname "$0")"
case "$1" in panel) NAME=WardenPanel ;; list) NAME=WardenList ;; *) echo "usage: PAPER=<paper server folder> $0 panel|list [install]"; exit 2 ;; esac
[ -d "${PAPER:-}/libraries" ] || { echo "PAPER must point to a Paper server folder (with libraries/)"; exit 2; }
CP=$(find "$PAPER/libraries" -name '*.jar' | sort -V -r | tr '\n' ':')
B="$1/build"; rm -rf "$B" && mkdir -p "$B/classes"
javac --release 21 -Xlint:deprecation -d "$B/classes" -cp "$CP" $(find "$1/src/main/java" -name '*.java')
cp -r "$1/src/main/resources/." "$B/classes/"
jar --create --file "$B/$NAME.jar" -C "$B/classes" .
echo "$B/$NAME.jar"
if [ "${2:-}" = install ]; then
  SERVERS=$(node -e "import('../lib/config.mjs').then(m => console.log(m.config().serversDir))")
  for d in "$SERVERS"/mc-*/serverfiles; do
    [ -f "$d/paper.jar" ] && mkdir -p "$d/plugins" && cp "$B/$NAME.jar" "$d/plugins/" && echo "copied to $d/plugins (applies on restart)"
  done
fi
