#!/usr/bin/env python3
"""Operate one local ProkBot Compose project, from a checkout or the Host release package."""
import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import ipaddress
import json
import os
from pathlib import Path
import posixpath
import re
import shutil
import subprocess
import sys
from urllib.parse import urlsplit
from uuid import uuid4

RELEASE = Path(__file__).resolve().parent / 'release'
MEMORY_COMPOSE = RELEASE / 'compose.memory.yaml'
MIN_DOCKER_ENGINE = (26, 0, 0)
MIN_DOCKER_API = (1, 45, 0)
MIN_COMPOSE = (2, 26, 0)
sys.path.insert(0, str(RELEASE))
from platforms import BOX, check_box_execution, docker_platform
import backup as volume_backup


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


def compose(args, home, *, memory=False):
    if not (home / '.env').is_file():
        raise ValueError('No .env in the instance directory. Run init first or select --home.')
    name = 'compose.host.yaml' if args.host_only else 'compose.yaml'
    overlay = ['-f', str(MEMORY_COMPOSE)] if memory else []
    return ['docker', 'compose', '--env-file', str(home / '.env'), '-p', args.project, '-f', str(RELEASE / name), *overlay]


def memory_overlay(dc):
    return str(MEMORY_COMPOSE) in dc


def memory_supported():
    # Engines before 26 ignore subpath and would mount the whole host-data volume, keys included.
    try:
        check_runtime_versions()
    except ValueError as error:
        print(f'Bot memory reading on its desktop stays off: {error}', file=sys.stderr)
        return False
    return True


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
    if not volume_backup.PROJECT_NAME.fullmatch(args.project):
        raise ValueError('Invalid Compose project name')


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


def backup(args, home, image, *, stopped=False):
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    dest = home / 'backups' / f'{args.project}-{stamp}'
    volume_backup.backup(args.project, dest, image, stopped=stopped)
    return dest


def volume_policy(existing, images=None):
    # Explicit process environment takes precedence over a stale setting in an instance .env.
    env = {**os.environ, 'PROKBOT_EXISTING_VOLUMES': 'true' if existing else 'false'}
    for service, ref in (images or {}).items():
        env['GROKBOT_'+service.upper()+'_IMAGE'] = ref
    return env


def compose_mounts(service, definition):
    # These settings can introduce mounts not listed in service.volumes.
    for key in ('volumes_from', 'configs', 'secrets', 'use_api_socket'):
        if definition.get(key):
            raise ValueError(f'Effective Compose {service}.{key} introduces unmanaged mounts.')
    mounts = list(definition.get('volumes', []))
    tmpfs = definition.get('tmpfs', [])
    if isinstance(tmpfs, str):
        tmpfs = [tmpfs]
    mounts.extend({'type': 'tmpfs', 'target': item.partition(':')[0]} for item in tmpfs)

    roots = set(volume_backup.MOUNTS[service].values())
    data_targets = set(volume_backup.BOX_DATA_TARGETS) if service == 'box' else set()
    allowed = roots | data_targets
    by_target = {}
    for mount in mounts:
        target = mount.get('target')
        if not isinstance(target, str) or not target.startswith('/'):
            raise ValueError(f'Effective Compose mount on {service} needs an absolute container target.')
        dest = posixpath.normpath('/' + target.lstrip('/'))
        if dest in by_target:
            raise ValueError(f'Duplicate effective Compose mount on {service} at {dest}.')
        if dest not in allowed and (mount.get('type') != 'tmpfs' or
                any(posixpath.commonpath((root, dest)) in (root, dest) for root in allowed)):
            raise ValueError(f'Unmanaged mount on {service} at {dest} would be omitted from the backup.')
        by_target[dest] = mount
    return by_target


def instance_images(dc, project, services, existing, pinned=None):
    config = json.loads(run(dc + ['config', '--format', 'json'], env=volume_policy(existing, pinned), capture=True).stdout)
    if set(config['services']) != set(services):
        raise ValueError('Effective Compose services do not match the selected topology.')
    for s in services:
        mounts = compose_mounts(s, config['services'][s])
        for suffix, dest in volume_backup.MOUNTS[s].items():
            mount = mounts.get(dest, {})
            volume = config.get('volumes', {}).get(suffix, {})
            if (volume.get('name') != project+'_'+suffix or volume.get('external', False) is not existing or
                    mount.get('type') != 'volume' or mount.get('source') != suffix or
                    mount.get('target') != dest or mount.get('read_only') or (mount.get('volume') or {}).get('subpath')):
                raise ValueError(f'Effective Compose mount {s}:{dest} does not select the root of the expected writable project volume.')
        if s == 'box':
            expected = volume_backup.BOX_DATA_TARGETS if memory_overlay(dc) else {}
            if {t for t in volume_backup.BOX_DATA_TARGETS if t in mounts} != set(expected):
                raise ValueError('Effective Compose Host-data mounts on box do not match the selected Compose files.')
            for target, tree in expected.items():
                mount = mounts[target]
                subpath = (mount.get('volume') or {}).get('subpath')
                if (mount.get('type') != 'volume' or mount.get('source') != 'host-data' or
                        mount.get('target') != target or mount.get('read_only') is not True or
                        subpath != str(volume_backup.DATA_SOURCE_ROOT / tree)):
                    raise ValueError(f'Effective Compose mount box:{target} is not a read-only mount of the approved Host-data tree.')
    images = {s: config['services'][s]['image'] for s in services}
    if pinned is not None and images != pinned:
        raise ValueError('Effective Compose configuration did not select the requested immutable images.')
    if pinned is None and 'box' in images and images['box'] != BOX['localTag']:
        raise ValueError('This deployment entry point only starts the verified desktop tag from the input manifest.')
    return images


def build(args, image):
    cmd = [sys.executable, str(RELEASE / 'build-docker.py'), '--image', image]
    if args.host_only:
        cmd.append('--host-only')
    for flag, path in [('host-archive', args.host_archive), ('box-archive', args.box_archive)]:
        if path is not None:
            cmd.extend(['--' + flag, str(path.resolve(strict=True))])
    run(cmd)


def inventory(project, services, *, new, legacy_writable=False):
    # legacy_writable: a box created by Plus 1.7.0-1.14.0 may still mount Host data writable. Only checks
    # before services are replaced accept it; the checks after a start or recovery require read-only.
    volumes = volume_backup.project_volumes(project)
    expected = {f'{project}_{suffix}' for s in services for suffix in volume_backup.MOUNTS[s]}
    if new:
        named = set(volume_backup.output('volume', 'ls', '-q').splitlines())
        if volumes or expected & named or volume_backup.project_ids(project):
            raise ValueError('Instance or conflicting volume exists. Check the project and use update for an existing instance.')
        return {}
    if volumes != expected:
        raise ValueError('Volume set does not match this topology; check the original project, --home and --host-only.')
    volume_backup.verify_volumes(project, volumes)
    containers = volume_backup.project_services(project, services, host_data=f'{project}_host-data' in volumes,
                                                legacy_writable=legacy_writable)
    volume_backup.verify_users(volumes, containers)
    return containers


def image_id(ref):
    identity = run(['docker', 'image', 'inspect', '--format', '{{.Id}}', ref], capture=True).stdout.strip()
    if not re.fullmatch(r'sha256:[0-9a-f]{64}', identity):
        raise ValueError('Docker did not return a usable local image identity.')
    return identity


def startup_images(services, host_id):
    images = {'host': host_id}
    if 'box' in services:
        box = image_id(BOX['localTag'])
        if box not in (BOX['manifestDigest'], BOX['configDigest']):
            raise ValueError('Local desktop image does not match the pinned desktop digest.')
        images['box'] = box
    return images


def version_tuple(value, label):
    # Distribution builds add suffixes, e.g. Ubuntu's Compose reports 2.40.3+ds1-0ubuntu1~24.04.1.
    match = re.match(r'v?(\d+)\.(\d+)(?:\.(\d+))?(?![\d.])', value)
    if not match:
        raise ValueError(f'Docker did not report a usable {label} version.')
    return tuple(int(part or 0) for part in match.groups())


def require_version(actual, minimum, label):
    if actual < minimum:
        found = '.'.join(map(str, actual))
        required = '.'.join(map(str, minimum))
        raise ValueError(f'{label} {found} is too old; version {required} or newer is required for Host-data subpath mounts.')


def compose_version():
    version = run(['docker', 'compose', 'version', '--short'], capture=True).stdout.strip()
    # Compose labels its own volumes with the plain number, which backup lineage checks expect.
    return '.'.join(map(str, version_tuple(version, 'Compose')))


def check_runtime_versions():
    try:
        server = json.loads(run(['docker', 'version', '--format', '{{json .Server}}'], capture=True).stdout)
    except json.JSONDecodeError as error:
        raise ValueError('Docker did not report usable Engine version details.') from error
    if not isinstance(server, dict):
        raise ValueError('Docker Engine is unavailable; start it before configuring Host data mounts.')
    engine = server.get('Version')
    api = server.get('ApiVersion')
    if not isinstance(engine, str) or not isinstance(api, str):
        raise ValueError('Docker did not report both Engine and API versions.')
    engine_version = version_tuple(engine, 'Engine')
    api_version = version_tuple(api, 'API')
    compose = compose_version()
    compose_number = version_tuple(compose, 'Compose')
    require_version(engine_version, MIN_DOCKER_ENGINE, 'Docker Engine')
    require_version(api_version, MIN_DOCKER_API, 'Docker API')
    require_version(compose_number, MIN_COMPOSE, 'Docker Compose')
    return {'dockerEngineVersion': engine, 'dockerApiVersion': api, 'composeVersion': compose}


def ensure_host_data(project, image):
    name = project+'_host-data'
    if name not in set(volume_backup.output('volume', 'ls', '-q').splitlines()):
        run(['docker', 'volume', 'create',
             '--label', f'{volume_backup.PROJECT_LABEL}={project}',
             '--label', f'{volume_backup.VOLUME_LABEL}=host-data',
             '--label', f'{volume_backup.VERSION_LABEL}={compose_version()}',
             name], capture=True)
    labels = volume_backup.volume_labels(name)
    if labels.get(volume_backup.PROJECT_LABEL) != project or labels.get(volume_backup.VOLUME_LABEL) != 'host-data':
        raise ValueError('The Host data volume does not belong to the selected project.')
    run(['docker', 'run', '--rm', '--pull=never', '--network', 'none', '--read-only', '--user', '0:0',
         '--entrypoint', 'python3', '--mount', f'type=volume,src={name},dst=/data,volume-nocopy', image,
         '/opt/grokbot/release/data_init.py', '/data/runtime/host-data'])


def up_and_wait(dc, project, services, images, *, existing):
    instance_images(dc, project, services, existing, pinned=images)
    if 'box' in services and memory_overlay(dc):
        ensure_host_data(project, images['host'])
    run(dc + ['up', '-d', '--pull', 'never', '--wait', '--wait-timeout', '180'], env=volume_policy(existing, images))
    current = inventory(project, services, new=False)
    if (set(current) != set(services) or any(c['State']['Status'] != 'running' for c in current.values()) or
            any(current[s]['Image'] != images[s] for s in services)):
        raise ValueError('Compose finished but the running services do not match the verified deployment.')


def stop_failed_start(dc, project, services, existing, notice, error):
    try:
        run(dc + ['stop'], env=volume_policy(existing))
        # After a failed update the old box, with writable mounts, may still be the one Compose stopped.
        current = volume_backup.project_services(project, services, legacy_writable=True)
        if any(c['State']['Status'] not in ('exited', 'created') for c in current.values()):
            raise ValueError('some services remain active')
    except (OSError, ValueError, subprocess.SubprocessError) as stop_error:
        raise RuntimeError(notice + ' Service shutdown NOT confirmed: ' + str(stop_error)) from error
    raise RuntimeError(notice + ' Project services are stopped. Cause: ' + str(error)) from error


def tag_state(tag):
    if (not re.fullmatch(r'[a-z0-9][a-z0-9._:/-]*(?::[\w.-]+)?', tag, re.ASCII) or '@' in tag or
            re.fullmatch(r'(?:sha256:)?[0-9a-f]{64}', tag)):
        raise ValueError('Configured Host build target must be a local tag, not an ID, digest or pattern.')
    if ':' not in tag.rsplit('/', 1)[-1]:
        tag += ':latest'
    # A successful, empty tag inventory means absent. Any inspect/daemon error is a hard failure.
    rows = run(['docker', 'image', 'ls', '--no-trunc', '--format', '{{.ID}}', tag], capture=True).stdout.splitlines()
    if not rows:
        return None
    if len(rows) != 1 or not re.fullmatch(r'sha256:[0-9a-f]{64}', rows[0]) or image_id(tag) != rows[0]:
        raise ValueError('Host tag inventory changed or is ambiguous; refusing to switch.')
    return rows[0]


def revert_tag(previous, candidate, tag):
    try:
        actual = tag_state(tag)
        if actual == previous:
            return
        if actual != candidate:
            raise ValueError('another image owns this tag; it was not modified')
        try:
            if previous is None:
                run(['docker', 'image', 'rm', '--no-prune', tag])
            else:
                run(['docker', 'image', 'tag', previous, tag])
        except (OSError, subprocess.SubprocessError):
            pass  # The acknowledgement can be lost after the operation succeeds.
        if tag_state(tag) != previous:
            raise ValueError('previous tag state could not be verified')
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        raise RuntimeError('Host tag rollback NOT confirmed; inspect local image metadata before retrying.') from error


def publish_image(previous, candidate, tag):
    if tag_state(tag) != previous:
        raise ValueError('Configured Host tag changed since preflight; refusing to replace it.')
    try:
        run(['docker', 'image', 'tag', candidate, tag])
        if tag_state(tag) != candidate:
            raise ValueError('Candidate tag was not installed.')
    except (Exception, KeyboardInterrupt):
        revert_tag(previous, candidate, tag)
        raise


@contextmanager
def staged_host(args, services):
    candidate = 'prokbot-upgrade:' + uuid4().hex
    build(args, candidate)
    try:
        check_platform(candidate)
        yield startup_images(services, image_id(candidate))
    finally:
        try:
            run(['docker', 'image', 'rm', '--no-prune', candidate], capture=True)
        except (OSError, subprocess.SubprocessError):
            print('Could not remove temporary image tag: '+candidate, file=sys.stderr)


def upgrade(args, home, dc, services, image, old, root, continuing):
    def state(containers):
        return {s: (c['Id'], c['Image'], c['State']['Status']) for s, c in containers.items()}

    if any(c['State']['Status'] == 'paused' for c in old.values()):
        raise ValueError('A project service is paused; resolve its state before upgrading.')
    if set(old) != set(services):
        raise ValueError('Missing original service container; cannot establish previous image identities from volume-only data. Use recover with a matching backup.')
    previous = old['host']['Image']
    public_before = tag_state(image)
    if image_id(previous) != previous:
        raise ValueError('Previous Host image identity is unavailable; refusing to switch.')
    with staged_host(args, services) as images:
        candidate_id = images['host']
        current = inventory(args.project, services, new=False, legacy_writable=True)
        if state(current) != state(old) or instance_images(dc, args.project, services, True)['host'] != image:
            raise ValueError('The instance changed during the build; no service was switched.')
        offline_only = volume_backup.check_lineage(root, args.project, continuing=continuing)
        if offline_only:
            print('An unknown detached Host copy exists: automatic recovery is blocked on this daemon. '
                  'If the candidate fails after takeover, use data-only restore into new offline volumes.',
                  file=sys.stderr, flush=True)
        running = [old[s]['Id'] for s in services if s in old and old[s]['State']['Status'] == 'running']
        try:
            for cid in running:  # Stop Host first so no new desktop work is dispatched.
                run(['docker', 'stop', cid])
            dest = backup(args, home, previous, stopped=True)
            # Keep the old image locally addressable after Compose removes its last container.
            recovery_image = f'prokbot-recovery:{args.project}-{previous[7:]}'
            run(['docker', 'image', 'tag', previous, recovery_image])
            offline_only = volume_backup.check_lineage(root, args.project, continuing=continuing)
            publish_image(public_before, candidate_id, image)
        except (Exception, KeyboardInterrupt):
            # Before Compose up, only the original containers have touched the data.
            # A manual peer start during the snapshot must not trigger a second identity on rollback.
            volume_backup.check_lineage(root, args.project, continuing=continuing)
            failed = []
            for cid in reversed(running):
                try:
                    run(['docker', 'start', cid])
                except (OSError, subprocess.SubprocessError):
                    failed.append(cid)
            if failed:
                raise RuntimeError('Could not resume original containers; inspect their status: '+', '.join(failed))
            raise
        try:
            up_and_wait(dc, args.project, services, images, existing=True)
        except (Exception, KeyboardInterrupt) as error:
            # A candidate may already have migrated data. Never restart the old image on those volumes.
            action = (f'An unknown detached Host copy exists; automatic recovery is blocked on this daemon. '
                      f'Use data-only restore from {dest} into new offline volumes. Do not start those volumes '
                      'until conflicting identities are resolved.' if offline_only else
                      f'Run recover --directory {dest} for a NEW project.')
            notice = f'Upgrade failed. No automatic data rollback. {action} Previous Host: {recovery_image} ({previous}).'
            try:
                stop_failed_start(dc, args.project, services, True, notice, error)
            finally:
                revert_tag(public_before, candidate_id, image)


def check_platform(image):
    actual = run(['docker', 'image', 'inspect', '--format', '{{.Os}}/{{.Architecture}}', image], capture=True).stdout.strip()
    if actual != docker_platform():
        raise ValueError('Host image platform does not match the Docker server; refusing to start.')


def recover(args, home, dc, services):
    source = args.directory.expanduser().resolve(strict=True)
    manifest = volume_backup.read_manifest(source)
    origin = manifest['project']
    if args.project == origin:
        raise ValueError('Recovery requires a NEW project, never the source project.')
    images = manifest.get('serviceImages')
    if (not isinstance(images, dict) or set(images) != set(services) or
            any(not isinstance(i, str) or not re.fullmatch(r'sha256:[0-9a-f]{64}', i) for i in images.values())):
        # Backups from backup.py or an older deploy.py record no image IDs. Starting them would mean
        # guessing which image wrote the data, so they get the data-only path with its exact command.
        raise ValueError('Backup has no verified service image IDs for this topology, so it cannot be started '
                         'automatically; do not guess tags. Use data-only restore: python3 release/backup.py restore '
                         f'--project <new project> --directory {source} --image <verified local Host image ID>, '
                         'then start that project only after confirming no other copy of this Host identity runs.')
    suffixes = {n for s in services for n in volume_backup.MOUNTS[s]}
    if {r.get('suffix') for r in manifest['volumes'] if isinstance(r, dict)} != suffixes:
        raise ValueError('Backup volumes do not match the selected recovery topology.')
    if any(image_id(i) != i for i in images.values()):
        raise ValueError('One of the exact recovery images is unavailable locally.')
    check_platform(images['host'])
    instance_images(dc, args.project, services, True, pinned=images)
    root = manifest.get('lineageRoot')
    with volume_backup.project_lock(origin), volume_backup.lineage_lock(root):
        volume_backup.check_lineage(root, args.project, original=origin)
        inventory(args.project, services, new=True)
        volume_backup.restore(source, args.project, images['host'], manifest=manifest)
        volume_backup.check_lineage(root, args.project, original=origin)
        inventory(args.project, services, new=False)
        try:
            up_and_wait(dc, args.project, services, images, existing=True)
        except (Exception, KeyboardInterrupt) as error:
            stop_failed_start(dc, args.project, services, True, 'Recovery start failed. Restored volumes retained; source unchanged.', error)
    print(json.dumps({'recoveredProject': args.project, 'sourceProject': origin, 'serviceImages': images, 'servicesStarted': True}))


def operate(args, home, dc):
    services = ('host',) if args.host_only else ('host', 'box')
    if args.action == 'recover':
        return recover(args, home, dc, services)
    image = instance_images(dc, args.project, services, args.action != 'up')['host']
    current = inventory(args.project, services, new=args.action == 'up', legacy_writable=True)
    if volume_backup.writable_box_data(current):
        print('The Bot computer still mounts Host memory writable (ProkBot Plus 1.7.0-1.14.0). '
              + ('This update replaces those mounts with read-only ones.' if args.action == 'update'
                 else 'Run update to replace them with read-only mounts.'), file=sys.stderr, flush=True)
    if args.action == 'backup':
        return backup(args, home, current['host']['Image'] if 'host' in current else image)
    root = volume_backup.local_lineage(args.project) if args.action == 'update' else args.project
    # Builders also publish fixed shared base/desktop tags. One daemon-wide writer covers aliases and rollback.
    with volume_backup.lineage_lock(root), volume_backup.operation_lock('prokbot-image-publication-lock'):
        # Preserve the pre-stop fact through snapshot and rollback. This exception never applies
        # to a stopped Host, a restored Host, or recovery into a new project.
        continuing = False
        if (args.action == 'update' and root == args.project and 'host' in current and
                current['host']['State']['Status'] == 'running'):
            labels = volume_backup.volume_labels(args.project+'_host-data')
            continuing = (labels.get(volume_backup.PROJECT_LABEL) == args.project and
                          labels.get(volume_backup.VOLUME_LABEL) == 'host-data' and
                          volume_backup.RESTORE_LABEL not in labels and volume_backup.LINEAGE_LABEL not in labels and
                          volume_backup.compose_created(labels))
        volume_backup.check_lineage(root, args.project, fresh=args.action == 'up', continuing=continuing)
        if args.action == 'update':
            upgrade(args, home, dc, services, image, current, root, continuing)
        else:
            previous = tag_state(image)
            with staged_host(args, services) as images:
                inventory(args.project, services, new=True)
                volume_backup.check_lineage(root, args.project, fresh=True)
                publish_image(previous, images['host'], image)
                try:
                    up_and_wait(dc, args.project, services, images, existing=False)
                except (Exception, KeyboardInterrupt) as error:
                    try:
                        stop_failed_start(dc, args.project, services, False, 'Installation failed. No volumes were removed.', error)
                    finally:
                        revert_tag(previous, images['host'], image)
    run(dc + ['ps'])


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--home', type=Path, default=Path.home() / 'grokbot', help='Instance directory (.env, backups); default ~/grokbot')
    parser.add_argument('--project', help='Compose project/volume prefix; default: saved project or grokbot')
    parser.add_argument('--host-only', action='store_true', help='Use a separately deployed execution node')
    sub = parser.add_subparsers(dest='action', required=True)
    init = sub.add_parser('init', help='Create .env once; never overwrite an existing deployment')
    init.add_argument('--listen', default='127.0.0.1'); init.add_argument('--port', type=int, default=18080)
    init.add_argument('--public-url', help='URL entered on clients; no subpath')
    recovery = sub.add_parser('recover', help='Restore and start a NEW project from verified volumes and recorded immutable images')
    recovery.add_argument('--directory', required=True, type=Path, help='Backup directory containing manifest.json')
    for cmd, help_text in [('doctor', 'Check Docker, Compose, architecture and desktop compatibility'),
                           ('up', 'Build verified inputs and start a new installation'),
                           ('update', 'Stage a build, stop existing services, back up and switch to the candidate'),
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
            memory = not args.host_only and memory_supported()
            report.update(hostPlatform=platform, memoryMounts=memory,
                          composeVersion=run(['docker', 'compose', 'version', '--short'], capture=True).stdout.strip(),
                          desktop='remote' if args.host_only else 'native' if platform == BOX['platform'] else 'emulated-amd64',
                          existingVolumes=sorted(volume_backup.project_volumes(args.project)), resources=daemon_resources())
            help_text = run(['docker', 'compose', 'up', '--help'], capture=True).stdout
            if '--wait-timeout' not in help_text:
                raise ValueError('This Compose version cannot wait for service health. Install a Compose v2 with up --wait-timeout.')
            report['hostDataVolumes'] = run(['docker', 'volume', 'ls', '-q', '--filter', 'label=com.docker.compose.volume=host-data'], capture=True).stdout.splitlines()
            if report['existingConfig']:
                run(compose(args, home, memory=memory) + ['config', '--quiet'])
            if not args.host_only:
                check_box_execution(platform)
            report['ok'] = True
        except (OSError, ValueError, subprocess.SubprocessError) as error:
            report['error'] = str(error)
        print(json.dumps(report))
        if not report['ok']:
            raise SystemExit(1)
        return
    # Only these actions create containers; the overlay is chosen afresh each time.
    dc = compose(args, home, memory=args.action in ('up', 'update', 'recover') and not args.host_only and memory_supported())
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
    with volume_backup.project_lock(args.project):
        return operate(args, home, dc)


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        raise SystemExit(str(error)) from error
