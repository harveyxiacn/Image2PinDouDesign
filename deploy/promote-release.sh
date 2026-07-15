#!/usr/bin/env bash
set -Eeuo pipefail

release_dir="${1:?Usage: promote-release.sh <release-dir> [site-dir]}"
site_dir="${2:-/var/www/image2pindou}"

if [[ ! -d "$release_dir" || ! -f "$release_dir/index.html" ]]; then
  echo "Release directory must contain index.html: $release_dir" >&2
  exit 1
fi

site_parent="$(dirname "$site_dir")"
backup_dir="${site_dir}.backup-$(date +%Y%m%d-%H%M%S)"
old_site_moved=0

# Immutable asset URLs can remain in already-open tabs and older service workers.
# Keep one previous asset generation alongside the new build to prevent chunk 404s.
if [[ -d "$site_dir/assets" ]]; then
  mkdir -p "$release_dir/assets"
  cp -a --update=none "$site_dir/assets/." "$release_dir/assets/"
fi

rollback() {
  if [[ "$old_site_moved" -eq 1 && -d "$backup_dir" ]]; then
    rm -rf "${site_dir}.failed"
    [[ -d "$site_dir" ]] && mv "$site_dir" "${site_dir}.failed"
    mv "$backup_dir" "$site_dir"
  fi
}
trap rollback ERR

mkdir -p "$site_parent"
if [[ -d "$site_dir" ]]; then
  mv "$site_dir" "$backup_dir"
  old_site_moved=1
fi
mv "$release_dir" "$site_dir"
chown -R root:root "$site_dir"
nginx -t
systemctl reload nginx

trap - ERR
echo "Promoted $site_dir (rollback: $backup_dir)"
