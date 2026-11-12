#!/usr/bin/env python3
"""Operate one local ProkBot Compose project, from a checkout or the Host release package."""
import argparse
from datetime import datetime, timezone
import ipaddress
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
from urllib.parse import urlsplit

RELEASE = Path(__file__).resolve().parent / 'release'
sys.path.insert(0, str(RELEASE))
from platforms import BOX, check_box_execution, docker_platform


def run(cmd, *, env=None, capture=False):
    return subprocess.run(cmd, env=env, stdin=subprocess.DEVNULL, check=True, text=True,
                          stdout=subprocess.PIPE if capture else None)


def endpoint(value):
    url = urlsplit(value)
    if (url.scheme not in ('https', 'http') or not url.hostname or url.username is not None or
            url.password is not None or url.path not in ('', '/') or url.query or url.fragment or
            not re.fullmatch(r'https?://[a-zA-Z0-9.\[\]:-]+/?', value) or url.port == 0):
        raise ValueError('Public URL must be an HTTP(S) origin without credentials, a path, query or fragment.')
    return value.rstrip('/')


def initialise(home, args):
    if not 1 <= args.port <= 65535:
        raise ValueError('Port must be 1..65535')
    listen = str(ipaddress.ip_address(args.listen))
    if not args.public_url and listen != '127.0.0.1':
        raise ValueError('Set --public-url to the address clients will actually enter.')
    origin = endpoint(args.public_url or f'http://127.0.0.1:{args.port}')
    if ':' in listen:
        listen = f'[{listen}]'
    home.mkdir(mode=0o700, parents=True, exist_ok=True)
    try:
        fd = os.open(home / '.env', os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        raise ValueError('Configuration already exists; init never overwrites it. Use status or update.') from None
    with os.fdopen(fd, 'w', encoding='utf-8', newline='\n') as config:
        config.write(f'GROKBOT_LISTEN_ADDRESS={listen}\nGROKBOT_PUBLIC_PORT={args.port}\nGROKBOT_PUBLIC_URL={origin}\n'
                     f'PROKBOT_MODE={"remote" if args.host_only else "local"}\nPROKBOT_PROJECT={args.project}\n')
    print(json.dumps({'configCreated': True, 'publicUrl': origin}))


def compose(args, home):
    if not (home / '.env').is_file():
        raise ValueError('No .env in the instance directory. Run init first or select --home.')
    name = 'compose.host.yaml' if args.host_only else 'compose.yaml'
    return ['docker', 'compose', '--env-file', str(home / '.env'), '-p', args.project, '-f', str(RELEASE / name)]


def instance_settings(args, home):
    # Only read the two markers written by init. Docker Compose interprets all other .env fields.
    path = home / '.env'
    markers = {}
    if path.is_file():
        for line in path.read_text(encoding='utf-8').splitlines():
            key, _, value = line.partition('=')
            if key in ('PROKBOT_MODE', 'PROKBOT_PROJECT'):
                markers[key] = value.strip()
    mode = markers.get('PROKBOT_MODE')
    if mode not in (None, 'remote', 'local') or (mode == 'local' and args.host_only):
        raise ValueError('Instance mode conflicts with its .env; do not switch topologies during an update.')
    args.host_only = args.host_only or mode == 'remote'
    saved = markers.get('PROKBOT_PROJECT')
    if saved and args.project and saved != args.project:
        raise ValueError('Project name conflicts with the instance .env; check --home and --project.')
    args.project = args.project or saved or 'grokbot'
    if not re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,60}', args.project):
        raise ValueError('Invalid Compose project name')


def project_volumes(project):
    return set(run(['docker', 'volume', 'ls', '-q', '--filter', f'label=com.docker.compose.project={project}'],
                   capture=True).stdout.splitlines())


def daemon_resources():
    info = json.loads(run(['docker', 'info', '--format', '{{json .}}'], capture=True).stdout)
    report = {'cpuCount': info.get('NCPU'), 'memoryBytes': info.get('MemTotal')}
    # Disk usage is local-only; a remote Docker context may use the same path on a different machine.
    endpoint = os.environ.get('DOCKER_HOST') or run(['docker', 'context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], capture=True).stdout.strip()
    root = info.get('DockerRootDir')
    if root and endpoint.startswith('unix://') and sys.platform.startswith('linux'):
        try:
            report['dockerDiskFreeBytes'] = shutil.disk_usage(root).free
        except OSError:
            pass
    return report


def backup(args, home, image):
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    dest = home / 'backups' / f'{args.project}-{stamp}'
    run([sys.executable, str(RELEASE / 'backup.py'), 'backup', '--project', args.project,
         '--directory', str(dest), '--image', image])
    return dest


def service_images(dc):
    return json.loads(run(dc + ['config', '--format', 'json'], capture=True).stdout)['services']


def build(args, image):
    cmd = [sys.executable, str(RELEASE / 'build-docker.py'), '--image', image]
    if args.host_only:
        cmd.append('--host-only')
    for flag, path in [('host-archive', args.host_archive), ('box-archive', args.box_archive)]:
        if path is not None:
            cmd.extend(['--' + flag, str(path.resolve(strict=True))])
    run(cmd)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--home', type=Path, default=Path.home() / 'grokbot', help='Instance directory (.env, backups); default ~/grokbot')
    parser.add_argument('--project', help='Compose project/volume prefix; default: saved project or grokbot')
    parser.add_argument('--host-only', action='store_true', help='Use a separately deployed execution node')
    sub = parser.add_subparsers(dest='action', required=True)
    init = sub.add_parser('init', help='Create .env once; never overwrite an existing deployment')
    init.add_argument('--listen', default='127.0.0.1'); init.add_argument('--port', type=int, default=18080)
    init.add_argument('--public-url', help='URL entered on clients; no subpath')
    for cmd, help_text in [('doctor', 'Check Docker, Compose, architecture and desktop compatibility'),
                           ('up', 'Build verified inputs and start a new installation'),
                           ('update', 'Back up the existing instance, rebuild and recreate services'),
                           ('backup', 'Back up all project volumes'), ('status', 'Show container status'),
                           ('logs', 'Show recent Host logs'), ('setup-key', 'Show the private, first-use setup key')]:
        command = sub.add_parser(cmd, help=help_text)
        if cmd in ('up', 'update'):
            command.add_argument('--host-archive', type=Path, help='Use a previously downloaded pinned Host archive')
            command.add_argument('--box-archive', type=Path, help='Use a previously saved pinned desktop image')
    admin = sub.add_parser('admin', help='Run the bundled admin CLI; pass secrets via environment only')
    admin.add_argument('arguments', nargs=argparse.REMAINDER)
    args = parser.parse_args(argv); home = args.home.expanduser().resolve()
    instance_settings(args, home)
    if args.action == 'init':
        return initialise(home, args)
    if args.action == 'doctor':
        report = {'ok': False, 'project': args.project, 'existingConfig': (home / '.env').is_file()}
        try:
            platform = docker_platform()
            report.update(hostPlatform=platform, composeVersion=run(['docker', 'compose', 'version', '--short'], capture=True).stdout.strip(),
                          desktop='remote' if args.host_only else 'native' if platform == BOX['platform'] else 'emulated-amd64',
                          existingVolumes=sorted(project_volumes(args.project)), resources=daemon_resources())
            help_text = run(['docker', 'compose', 'up', '--help'], capture=True).stdout
            if '--wait-timeout' not in help_text:
                raise ValueError('This Compose version cannot wait for service health. Install a Compose v2 with up --wait-timeout.')
            report['hostDataVolumes'] = run(['docker', 'volume', 'ls', '-q', '--filter', 'label=com.docker.compose.volume=host-data'], capture=True).stdout.splitlines()
            if report['existingConfig']:
                run(compose(args, home) + ['config', '--quiet'])
            if not args.host_only:
                check_box_execution(platform)
            report['ok'] = True
        except (OSError, ValueError, subprocess.SubprocessError) as error:
            report['error'] = str(error)
        print(json.dumps(report))
        if not report['ok']:
            raise SystemExit(1)
        return
    dc = compose(args, home)
    if args.action in ('status', 'logs', 'setup-key'):
        return run(dc + {'status': ['ps', '--all'], 'logs': ['logs', '--tail', '100', 'host'],
                         'setup-key': ['exec', '-T', 'host', 'cat', '/data/setup-key']}[args.action])
    if args.action == 'admin':
        env = {**os.environ, 'GROKBOT_URL': 'http://127.0.0.1:8000'}
        flags = [arg for k in ('GROKBOT_URL', 'GROKBOT_ADMIN_PASSWORD', 'MODEL_API_KEY') if k in env for arg in ('-e', k)]
        extra = args.arguments or ['help']
        if extra[0] == 'setup':
            extra = [*extra, '--setup-key-file', '/data/setup-key']
        return run(dc + ['exec', '-T', *flags, 'host', '/exec-daemon/node', 'tools/host-admin.mjs', *extra], env=env)
    services = service_images(dc); image = services['host']['image']
    if args.action == 'backup':
        return backup(args, home, image)
    if 'box' in services and services['box']['image'] != BOX['localTag']:
        raise ValueError('This deployment entry point only starts the verified desktop tag from the input manifest.')
    volumes = project_volumes(args.project)
    expected = {args.project + '_' + name for name in (['host-data'] if args.host_only else ['host-data', 'box-home', 'box-workspace'])}
    named = set(run(['docker', 'volume', 'ls', '-q'], capture=True).stdout.splitlines())
    if (expected & named) - volumes:
        raise ValueError('A matching volume is not owned by this Compose project; refusing to use it.')
    containers = run(dc + ['ps', '--all', '-q'], capture=True).stdout.strip()
    if args.action == 'up' and (volumes or containers):
        raise ValueError('Instance exists. Use update to take a backup before changing it.')
    if args.action == 'update':
        if volumes != expected:
            raise ValueError('Volume set does not match this topology; check the original project, --home and --host-only.')
        old = run(dc + ['ps', '--all', '-q', 'host'], capture=True).stdout.strip()
        backup_image = run(['docker', 'inspect', '--format', '{{.Image}}', old], capture=True).stdout.strip() if old else image
        backup(args, home, backup_image)
    build(args, image)
    actual = run(['docker', 'image', 'inspect', '--format', '{{.Os}}/{{.Architecture}}', image], capture=True).stdout.strip()
    if actual != docker_platform():
        raise ValueError('Host image platform does not match the Docker server; refusing to start.')
    run(dc + ['up', '-d', '--pull', 'never', '--wait', '--wait-timeout', '180'])
    run(dc + ['ps'])


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        raise SystemExit(str(error)) from error
