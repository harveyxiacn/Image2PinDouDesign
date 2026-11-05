#!/usr/bin/env bash
# Run only after tests and independent review. Payload: workshop/, warehouse/, cloud/, deploy/.
set -Eeuo pipefail
payload="${1:?Usage: install-cloud.sh /opt/pindou-cloud/staging/release-id}"
[[ "$(id -u)" == 0 && "$(hostname)" == brightmaple-web ]] || { echo 'Unexpected deployment host/user'; exit 1; }
[[ "$payload" =~ ^/opt/pindou-cloud/staging/[A-Za-z0-9_-]+$ && -d "$payload" ]] || exit 1
for f in workshop/index.html warehouse/index.html cloud/server.mjs deploy/pindou-cloud.service deploy/nginx-pindou-cloud.conf deploy/rollback-cloud.sh; do
  [[ -f "$payload/$f" ]] || { echo "Missing payload $f"; exit 1; }
done
free=$(df -B1 --output=avail / | tail -1 | tr -d ' ')
size=$(du -s -B1 "$payload" | cut -f1)
old_size=$(du -s -B1 /var/www/image2pindou | cut -f1)
# Payload copy, conservative old-site archive + retained assets, and allocation/log margin.
(( free - size * 2 - old_size * 2 - 67108864 > 1073741824 )) || { echo 'Insufficient release/rollback reserve'; exit 1; }
check_reserve() { local available; available=$(df -B1 --output=avail / | tail -1 | tr -d ' '); (( available > 1140850688 )) || { echo 'Disk reserve breached'; return 1; }; }
release=$(basename "$payload")
backup="/var/backups/pindou-cloud/$release"
[[ ! -e "$backup" && ! -e "/opt/pindou-cloud/releases/$release" ]] || { echo 'Release already exists'; exit 1; }
for target in "/var/www/image2pindou.new-$release" "/var/www/image2pindou.before-$release" "/opt/pindou-cloud/current-$release"; do
  [[ ! -e "$target" && ! -L "$target" ]] || { echo 'Release temporary path already exists'; exit 1; }
done
[[ ! -e /etc/pindou-cloud.env ]] || { echo 'Existing cloud environment requires reviewed upgrade path'; exit 1; }
if [[ -f /var/lib/pindou-cloud/cloud.sqlite ]]; then
  echo 'Existing cloud database requires a separately reviewed upgrade and consistent backup.'
  exit 1
fi
mkdir -p "$backup" /opt/pindou-cloud/releases
chmod 700 /var/backups/pindou-cloud "$backup"
cp -a /etc/nginx/sites-available/image2pindou.conf "$backup/nginx.conf"
[[ ! -f /etc/nginx/snippets/pindou-cloud.conf ]] || cp -a /etc/nginx/snippets/pindou-cloud.conf "$backup/cloud-snippet.conf"
[[ ! -f /etc/systemd/system/pindou-cloud.service ]] || cp -a /etc/systemd/system/pindou-cloud.service "$backup/service"
[[ ! -f /etc/pindou-cloud.env ]] || cp -a /etc/pindou-cloud.env "$backup/environment"
if [[ -e /opt/pindou-cloud/current ]]; then readlink -f /opt/pindou-cloud/current > "$backup/previous-current"; else : > "$backup/previous-current"; fi
systemctl is-active pindou-cloud > "$backup/previous-service-state" || true
systemctl is-enabled pindou-cloud > "$backup/previous-service-enabled" || true
tar -C /var/www -czf "$backup/static.tar.gz" image2pindou
check_reserve
cp "$payload/deploy/rollback-cloud.sh" "$backup/rollback-cloud.sh"
rollback() {
  local code=$?
  trap - ERR
  bash "$backup/rollback-cloud.sh" "$backup" || echo "Automatic rollback failed; use backup $backup for manual recovery."
  exit "$code"
}
# Install the trap before the first service/configuration/current/static mutation.
trap rollback ERR
getent passwd pindou-cloud >/dev/null || useradd --system --home-dir /var/lib/pindou-cloud --shell /usr/sbin/nologin pindou-cloud
install -d -m 700 -o pindou-cloud -g pindou-cloud /var/lib/pindou-cloud
install -d -m 755 "/opt/pindou-cloud/releases/$release"
cp -a "$payload/cloud/." "/opt/pindou-cloud/releases/$release/"
chmod -R go-w "/opt/pindou-cloud/releases/$release"
check_reserve
ln -s "/opt/pindou-cloud/releases/$release" "/opt/pindou-cloud/current-$release"
mv -Tf "/opt/pindou-cloud/current-$release" /opt/pindou-cloud/current
install -m 644 "$payload/deploy/pindou-cloud.service" /etc/systemd/system/pindou-cloud.service
install -m 644 "$payload/deploy/nginx-pindou-cloud.conf" /etc/nginx/snippets/pindou-cloud.conf
if [[ ! -e /etc/pindou-cloud.env ]]; then
  umask 077
  cat > /etc/pindou-cloud.env <<'ENV'
PINDOU_CLOUD_DIR=/var/lib/pindou-cloud
PINDOU_CLOUD_ORIGIN=https://pindou.fanni-panda.com
PINDOU_CLOUD_PORT=8788
PINDOU_CLOUD_SECURE=true
PINDOU_CLOUD_TRUST_PROXY=true
PINDOU_CLOUD_REGISTRATION=false
PINDOU_CLOUD_MAX_USERS=100
PINDOU_CLOUD_ACCOUNT_BYTES=4194304
PINDOU_CLOUD_SERVICE_BYTES=314572800
PINDOU_CLOUD_MIN_FREE_BYTES=1073741824
ENV
fi
python3 - <<'PY'
from pathlib import Path
p=Path('/etc/nginx/sites-available/image2pindou.conf')
s=p.read_text()
marker='    # pindou-cloud managed include'
if marker in s: raise SystemExit('Existing cloud integration requires reviewed upgrade path')
needle='    server_name pindou.fanni-panda.com;'
if s.count(needle)!=1: raise SystemExit('Expected single HTTPS site')
s=s.replace(needle,needle+'\n\n'+marker+'\n    include /etc/nginx/snippets/pindou-cloud.conf;',1)
http='    server_name _;'
if s.count(http)!=1: raise SystemExit('Expected single HTTP site')
s=s.replace(http,http+'\n    location ^~ /cloud-api/ { return 308 https://pindou.fanni-panda.com$request_uri; }\n    location ^~ /warehouse { return 308 https://pindou.fanni-panda.com$request_uri; }',1)
p.write_text(s)
PY
nginx -t
systemctl daemon-reload
systemctl enable --now pindou-cloud
for i in {1..20}; do
  if curl -fsS -H 'x-pindou-client: web' http://127.0.0.1:8788/cloud-api/health >/dev/null; then break; fi
  sleep 1
done
curl -fsS -H 'x-pindou-client: web' http://127.0.0.1:8788/cloud-api/health >/dev/null
site="/var/www/image2pindou.new-$release"
mkdir "$site"
cp -a "$payload/workshop/." "$site/"
mkdir "$site/warehouse"
cp -a "$payload/warehouse/." "$site/warehouse/"
cp -an /var/www/image2pindou/assets/. "$site/assets/"
find "$site" -type d -exec chmod 755 {} +
find "$site" -type f -exec chmod 644 {} +
check_reserve
mv -T /var/www/image2pindou "/var/www/image2pindou.before-$release"
mv -T "$site" /var/www/image2pindou
systemctl reload nginx
trap - ERR
echo "Installed $release; registration remains disabled pending backup/restore and live acceptance."
echo "Rollback evidence: $backup; previous static: /var/www/image2pindou.before-$release"
