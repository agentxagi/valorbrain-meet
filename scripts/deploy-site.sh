#!/usr/bin/env bash
# Publishes site-dist/ (npm run site:build) to the nginx origin of
# meet.valorbra.in, served through the cloudflared tunnel.
#
#   $ROOT/releases/<timestamp>/  page, behind an atomic "current" symlink
#                                (rollback: point "current" at the previous one)
#   $ROOT/downloads/             zips, append-only: a published version never
#                                changes bytes and keeps its URL forever
set -euo pipefail

ROOT="${MEET_SITE_ROOT:-/var/www/meet.valorbra.in}"
KEEP="${MEET_SITE_KEEP:-5}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/site-dist"

if [ ! -f "$SRC/index.html" ]; then
  echo "site-dist/ não encontrado: rode npm run site:build" >&2
  exit 1
fi

mkdir -p "$ROOT/releases" "$ROOT/downloads"

for zip in "$SRC"/downloads/*.zip; do
  name="$(basename "$zip")"
  if [ -e "$ROOT/downloads/$name" ]; then
    if ! cmp -s "$zip" "$ROOT/downloads/$name"; then
      echo "recusado: $name já foi publicado com outro conteúdo. Aumente a versão." >&2
      exit 1
    fi
  else
    install -m 0644 "$zip" "$ROOT/downloads/$name"
  fi
done
(cd "$ROOT/downloads" && sha256sum -- *.zip > SHA256SUMS.tmp && mv -f SHA256SUMS.tmp SHA256SUMS)

release="$ROOT/releases/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$release"
cp -a "$SRC"/. "$release"/
rm -rf "$release/downloads"
chmod -R a+rX "$release" "$ROOT/downloads"

ln -sfn "$release" "$ROOT/current.new"
mv -Tf "$ROOT/current.new" "$ROOT/current"

# Keep the newest $KEEP page releases (downloads are never pruned).
find "$ROOT/releases" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort | head -n -"$KEEP" |
  while read -r old; do rm -rf "${ROOT:?}/releases/$old"; done

echo "publicado: $release"
echo "downloads: $(ls "$ROOT/downloads" | tr '\n' ' ')"
