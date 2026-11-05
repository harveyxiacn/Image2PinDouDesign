"""Run the actual rollback script against isolated filesystem fixtures and mocked services."""
import os
from pathlib import Path
import subprocess
import tempfile

script = Path(__file__).with_name('rollback-cloud.sh').read_text(encoding='utf-8')
bash = os.environ.get('BASH_PATH', r'C:\Program Files\Git\bin\bash.exe' if os.name == 'nt' else '/bin/bash')

def put(root, path, text):
    p = root / path.lstrip('/')
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding='utf-8')

for stage in ('before-static-rename', 'between-static-renames', 'after-static-renames', 'restore-existing-service'):
    with tempfile.TemporaryDirectory(prefix='pindou-rollback-test-') as temp:
        root = Path(temp)
        prefix = root.as_posix()
        backup = root / 'var/backups/pindou-cloud/test-release'
        backup.mkdir(parents=True)
        put(root, '/var/backups/pindou-cloud/test-release/nginx.conf', 'original nginx')
        put(root, '/var/backups/pindou-cloud/test-release/previous-current', '')
        put(root, '/var/backups/pindou-cloud/test-release/previous-service-state', 'inactive\n')
        put(root, '/var/backups/pindou-cloud/test-release/previous-service-enabled', 'disabled\n')
        put(root, '/etc/nginx/sites-available/image2pindou.conf', 'new nginx')
        put(root, '/etc/nginx/snippets/pindou-cloud.conf', 'new snippet')
        put(root, '/etc/systemd/system/pindou-cloud.service', 'new service')
        put(root, '/etc/pindou-cloud.env', 'new environment')
        put(root, '/opt/pindou-cloud/current/server.mjs', 'new server')
        put(root, '/var/lib/pindou-cloud/cloud.sqlite', 'user data must survive')
        if stage == 'before-static-rename':
            put(root, '/var/www/image2pindou/index.html', 'original site')
        else:
            put(root, '/var/www/image2pindou.before-test-release/index.html', 'original site')
            if stage != 'between-static-renames':
                put(root, '/var/www/image2pindou/index.html', 'new site')
        if stage == 'restore-existing-service':
            for saved, value in [('cloud-snippet.conf', 'old snippet'), ('service', 'old service'), ('environment', 'old environment')]:
                put(root, f'/var/backups/pindou-cloud/test-release/{saved}', value)
            put(root, '/opt/pindou-cloud/releases/old/server.mjs', 'old server')
            put(root, '/var/backups/pindou-cloud/test-release/previous-current', prefix+'/opt/pindou-cloud/releases/old\n')
            put(root, '/var/backups/pindou-cloud/test-release/previous-service-state', 'active\n')
            put(root, '/var/backups/pindou-cloud/test-release/previous-service-enabled', 'enabled\n')
        rewritten = script
        for path in ('/var/', '/etc/', '/opt/'):
            rewritten = rewritten.replace(path, prefix+path)
        mocks = f'''\nhostname() {{ echo brightmaple-web; }}
id() {{ echo 0; }}
systemctl() {{ echo "$*" >> "{prefix}/service-calls"; }}
nginx() {{ return 0; }}
'''
        rewritten = rewritten.replace('set -Eeuo pipefail', 'set -Eeuo pipefail'+mocks, 1)
        runner = root / 'rollback-fixture.sh'
        runner.write_text(rewritten, encoding='utf-8', newline='\n')
        result = subprocess.run([bash, str(runner), str(backup).replace('\\','/')], capture_output=True, text=True)
        assert result.returncode == 0, (stage, result.stdout, result.stderr)
        assert (root/'etc/nginx/sites-available/image2pindou.conf').read_text() == 'original nginx'
        assert (root/'var/www/image2pindou/index.html').read_text() == 'original site'
        assert (root/'var/lib/pindou-cloud/cloud.sqlite').read_text() == 'user data must survive'
        if stage == 'restore-existing-service':
            assert (root/'etc/systemd/system/pindou-cloud.service').read_text() == 'old service'
            assert (root/'etc/pindou-cloud.env').read_text() == 'old environment'
            assert (root/'opt/pindou-cloud/current/server.mjs').read_text() == 'old server'
            assert 'start pindou-cloud' in (root/'service-calls').read_text()
        else:
            assert not (root/'etc/systemd/system/pindou-cloud.service').exists()
            assert not (root/'etc/pindou-cloud.env').exists()
        print('PASS', stage)
print('4 isolated rollback filesystem scenarios passed; systemctl/nginx mocked, no production state touched.')
