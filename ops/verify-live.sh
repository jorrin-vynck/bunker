#!/usr/bin/env bash
# Haalt de bestanden die een draaiende bunker uitdeelt op en vergelijkt ze met deze map.
#   ./ops/verify-live.sh https://jouw-adres
# Een "ja" betekent: de server deelt aan jou nu dezelfde bestanden uit. Een eerlijke server doet dat voor iedereen; een
# server die kwaad wil kan jou en anderen verschillende bestanden geven. Laat daarom meer mensen dit af en toe draaien.
set -euo pipefail
URL="${1:?Geef het adres: ./ops/verify-live.sh https://jouw-adres}"
cd "$(dirname "$0")/.."
ok=1
for f in app.js style.css theme.js sw.js changes.json; do
  if [ "$(curl -fsS "$URL/$f" | shasum -a 256 | cut -d' ' -f1)" = "$(shasum -a 256 "public/$f" | cut -d' ' -f1)" ]; then echo "ja    $f"; else echo "NEE   $f"; ok=0; fi
done
[ "$ok" = 1 ] && echo "Alles gelijk aan deze map." || { echo "Verschil gevonden."; exit 1; }
