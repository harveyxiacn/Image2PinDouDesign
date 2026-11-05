#!/usr/bin/env bash
# Restore deployment configuration and static assets; never revert or delete user data.
set -Eeuo pipefail
backup="${1:?Usage: rollback-cloud.sh /var/backups/pindou-cloud/release-id}"
[[ "$(id -u)" == 0 && "$(hostname)" == brightmaple-web ]] || exit 1
[[ "$backup" =~ ^/var/backups/pindou-cloud/[A-Za-z0-9_-]+$ && -f "$backup/nginx.conf" ]] || exit 1
release=$(basename "$backup")
archive="$backup/rolled-back-$(date +%Y%m%d-%H%M%S)"
mkdir "$archive"
systemctl stop pindou-cloud || true
restore_file() {
  local saved="$1" target="$2" label="$3"
  if [[ -e "$target" || -L "$target" ]]; then mv "$target" "$archive/$label"; fi
  if [[ -f "$backup/$saved" ]]; then cp -a "$backup/$saved" "$target"; fi
}
restore_file nginx.conf /etc/nginx/sites-available/image2pindou.conf nginx.conf
restore_file cloud-snippet.conf /etc/nginx/snippets/pindou-cloud.conf cloud-snippet.conf
restore_file service /etc/systemd/system/pindou-cloud.service service
restore_file environment /etc/pindou-cloud.env environment
if [[ -e /opt/pindou-cloud/current || -L /opt/pindou-cloud/current ]]; then mv /opt/pindou-cloud/current "$archive/current"; fi
previous=$(cat "$backup/previous-current")
if [[ -n "$previous" ]]; then
  [[ "$previous" =~ ^/opt/pindou-cloud/releases/[A-Za-z0-9_-]+$ && -d "$previous" ]] || { echo 'Invalid previous release'; exit 1; }
  ln -s "$previous" /opt/pindou-cloud/current
fi
old_site="/var/www/image2pindou.before-$release"
if [[ -d "$old_site" ]]; then
  # The current directory may not exist if the second rename failed.
  if [[ -e /var/www/image2pindou ]]; then mv /var/www/image2pindou "$archive/static"; fi
  mv "$old_site" /var/www/image2pindou
fi
systemctl daemon-reload
if grep -qx enabled "$backup/previous-service-enabled"; then systemctl enable pindou-cloud; else systemctl disable pindou-cloud || true; fi
if grep -qx active "$backup/previous-service-state"; then systemctl start pindou-cloud; fi
nginx -t
systemctl reload nginx
echo "Rollback complete. User database retained at /var/lib/pindou-cloud; failed release retained at $archive"
