#!/usr/bin/env bash
# Toont de vingerafdruk van de code die je uitrolt: een lijst met een hash per bestand en één hash voor het geheel.
# Zet die in de release-notities (bijvoorbeeld op GitHub), dan kan iedereen nagaan of de server dezelfde code draait.
set -euo pipefail
cd "$(dirname "$0")/.."
FILES="$(ls server.py public/app.js public/style.css public/theme.js public/sw.js public/changes.json)"
shasum -a 256 $FILES
echo
echo "Geheel: $(shasum -a 256 $FILES | shasum -a 256 | cut -d' ' -f1)"
