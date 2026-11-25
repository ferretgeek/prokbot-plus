#!/usr/bin/env python3
"""Back up a Compose project's volumes, or restore them into a new project."""
import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import time
from uuid import uuid4

DOCKER = shutil.which('docker') or '/usr/local/bin/docker'
PROJECT_NAME = re.compile(r'[a-z0-9][a-z0-9_-]{0,60}')
RESTORE_LABEL = 'io.prokbot.restore-id'
LINEAGE_LABEL = 'io.prokbot.lineage-root'
PROJECT_LABEL = 'com.docker.compose.project'
VOLUME_LABEL = 'com.docker.compose.volume'
VERSION_LABEL = 'com.docker.compose.version'
OPERATION_LABEL = 'io.prokbot.operation-id'
MOUNTS = {'host': {'host-data': '/data'}, 'box': {'box-home': '/home/box', 'box-workspace': '/workspace'},
          'gateway': {'gateway-data': '/data'}}
TOPOLOGIES = (('host',), ('host', 'box'), ('gateway', 'box'))
DATA_TREES = ('agents', 'user-memory', 'workflows', 'plugins', 'managed-skills')
DATA_SOURCE_ROOT = PurePosixPath('runtime/host-data')
BOX_DATA_ROOTS = (PurePosixPath('/data/runtime/host-data'),)
BOX_DATA_TARGETS = {str(root / tree): tree for root in BOX_DATA_ROOTS for tree in DATA_TREES}


def run(*args, **kwargs):
    kwargs.setdefault('stdin', subprocess.DEVNULL)
    return subprocess.run([DOCKER, *args], check=True, **kwargs)


def output(*args):
    return subprocess.check_output([DOCKER, *args], text=True, stdin=subprocess.DEVNULL).strip()


def project_volumes(project):
    return set(output('volume', 'ls', '-q', '--filter', f'label=com.docker.compose.project={project}').splitlines())


def topology(project, names):
    for services in TOPOLOGIES:
        if names == {f'{project}_{suffix}' for s in services for suffix in MOUNTS[s]}:
            return services
    raise ValueError('Incomplete or unexpected project volume set; check the original project and topology.')


def label_fields(field, keys):
    fields = ','.join('"%s":{{json (index %s "%s")}}' % (k, field, k) for k in keys)
    return '{{if '+field+'}}{'+fields+'}{{else}}{}{{end}}'


def volume_labels(name):
    fmt = label_fields('.Labels', (PROJECT_LABEL, VOLUME_LABEL, VERSION_LABEL, RESTORE_LABEL, LINEAGE_LABEL, OPERATION_LABEL))
    labels = json.loads(output('volume', 'inspect', '--format', fmt, name))
    return {k: v for k, v in labels.items() if v}


@contextmanager
def operation_lock(name):
    # The daemon's named-volume namespace is shared across homes, users and Docker clients.
    # Never steal a stale lock: a disconnected updater may still be running.
    token = uuid4().hex
    try:
        run('volume', 'create', '--label', f'{OPERATION_LABEL}={token}', name, stdout=subprocess.DEVNULL)
        if volume_labels(name).get(OPERATION_LABEL) != token:
            raise ValueError(f'Another operation owns {name}; do not remove an active lock.')
        yield
    finally:
        try:
            if name in output('volume', 'ls', '-q').splitlines() and volume_labels(name).get(OPERATION_LABEL) == token:
                run('volume', 'rm', name, stdout=subprocess.DEVNULL)
        except (OSError, ValueError, subprocess.SubprocessError) as error:
            raise RuntimeError(f'Could not verify/release operation lock {name}; inspect before retrying.') from error


def project_lock(project):
    if not PROJECT_NAME.fullmatch(project):
        raise ValueError('Invalid Compose project name')
    return operation_lock('prokbot-operation-'+project)


def lineage_lock(root):
    if not isinstance(root, str) or not PROJECT_NAME.fullmatch(root):
        raise ValueError('Unknown backup lineage; only offline data restore is safe.')
    return operation_lock('prokbot-lineage-operation-'+root)


def compose_created(labels):
    return re.fullmatch(r'v?\d+\.\d+(?:\.\d+)?(?:[-+][\w.+-]+)?', labels.get(VERSION_LABEL, '')) is not None


def volume_lineage(project, labels):
    root = labels.get(LINEAGE_LABEL)
    if root is not None and (not isinstance(root, str) or not PROJECT_NAME.fullmatch(root)):
        raise ValueError('Invalid Host volume lineage metadata.')
    # Legacy restored volumes have no proven source, even if this is the only copy on the daemon.
    if root is None and RESTORE_LABEL not in labels and compose_created(labels):
        root = project
    return root


def volume_users(name):
    return set(output('ps', '--all', '--no-trunc', '-q', '--filter', f'volume={name}').splitlines())


def active_host_mount(name):
    for c in inspect_containers(volume_users(name)):
        if (c['State']['Status'] not in ('created', 'exited') and
                (c['Labels'] or {}).get('com.docker.compose.service') == 'host' and
                any(m['Type'] == 'volume' and m.get('Name') == name and m['Destination'] == '/data' for m in c['Mounts'])):
            return True
    return False


def host_volume_inventory():
    # No payloads, credentials, container environment, or client identity files are inspected.
    names = set(output('volume', 'ls', '-q').splitlines())
    hosts = {n for n in names if n.endswith('_host-data')}
    hosts.update(output('volume', 'ls', '-q', '--filter', f'label={VOLUME_LABEL}=host-data').splitlines())
    entries = {}
    for name in hosts:
        labels = volume_labels(name)
        project = labels.get(PROJECT_LABEL, '')
        role = labels.get(VOLUME_LABEL)
        marked = RESTORE_LABEL in labels or LINEAGE_LABEL in labels
        if not labels:
            # Even the oldest managed restore set both Compose ownership labels. A suffix alone
            # is not evidence of a copy; an actual Host /data mount or an exact target collision is.
            if active_host_mount(name):
                raise ValueError('A Host is using an unlabelled data volume; refusing activation.')
            continue
        if (not project and not role and not marked and re.fullmatch(r'[a-f0-9]{32}', labels.get(OPERATION_LABEL, ''))
                and name.startswith(('prokbot-operation-', 'prokbot-lineage-operation-'))):
            continue  # A valid project name (and hence its lock name) can end in _host-data.
        if (not marked and PROJECT_NAME.fullmatch(project) and role and compose_created(labels) and
                (role != 'host-data' or name != project+'_host-data')):
            continue  # Explicit foreign Compose names are not managed ProkBot mounts.
        if (not PROJECT_NAME.fullmatch(project) or name != project+'_host-data' or role != 'host-data'):
            raise ValueError('Cannot establish lineage of an unmanaged Host volume on this daemon.')
        entries[project] = (name, volume_lineage(project, labels))
    return entries


def local_lineage(project):
    name = project+'_host-data'
    if name not in project_volumes(project):
        return None
    labels = volume_labels(name)
    if labels.get(PROJECT_LABEL) != project or labels.get(VOLUME_LABEL) != 'host-data':
        raise ValueError('Host volume does not belong to the selected project.')
    return volume_lineage(project, labels)


def check_lineage(root, project, *, original=None, fresh=False, continuing=False):
    """Reject unsafe activation. Return whether detached unknown copies limited this approval."""
    if not isinstance(root, str) or not PROJECT_NAME.fullmatch(root):
        raise ValueError('Unknown Host lineage; refusing automatic activation.')
    entries = host_volume_inventory()
    checked = set()
    detached_unknown = False
    for owner, (name, declared) in entries.items():
        if declared is None:
            # Never activate an unknown copy. An empty install or the same already-running
            # original may proceed past a different, detached copy; even stopped attachments count.
            if ((fresh or continuing) and owner not in (root, project, original) and
                    not project_ids(owner) and not volume_users(name)):
                detached_unknown = True
                continue
            raise ValueError('Unmarked legacy Host volume on this daemon; identity is ambiguous. Use offline data restore.')
        if declared != root:
            if owner in (root, project, original):
                raise ValueError('Conflicting Host lineage; refusing activation.')
            continue
        if owner == project:
            continue
        peers = set(project_ids(owner))
        checked.update(peers | volume_users(name))
    for owner in {root, original} - {None, project}:
        checked.update(project_ids(owner))
    for cid in checked:
        if output('inspect', '--format', '{{.State.Status}}', cid) not in ('created', 'exited'):
            raise ValueError('Another project with this Host identity is not stopped; refusing activation.')
    return detached_unknown


def verify_volumes(project, names):
    for name in names:
        labels = volume_labels(name)
        if (labels.get('com.docker.compose.project') != project or
                labels.get('com.docker.compose.volume') != name[len(project)+1:]):
            raise ValueError(f'Volume {name} does not have the expected project and volume labels.')


def project_ids(project):
    return output('ps', '--all', '--no-trunc', '-q', '--filter', f'label=com.docker.compose.project={project}').splitlines()


def inspect_containers(ids):
    # Request only lifecycle metadata, not a container's environment or other configuration.
    labels = label_fields('.Config.Labels', (PROJECT_LABEL, 'com.docker.compose.service', 'com.docker.compose.oneoff'))
    # Docker's resolved mount list omits VolumeOptions.Subpath. Project only the affected
    # container destinations and source identities; never request HostConfig wholesale.
    # `docker inspect` retries a template that fails on its typed structs against the raw JSON,
    # with missing keys as errors; `.Id` and `index` on a struct fail there, so this template
    # always reads the raw JSON. The daemon omits empty fields from it: HostConfig.Mounts on
    # containers created with Binds (as Compose 2.40 does), VolumeOptions or Subpath on plain
    # volume mounts. `index` reads such a key as empty instead of failing the inspection.
    subpaths = ('[{{$sep := ""}}{{range index .HostConfig "Mounts"}}{{$target := index . "Target"}}'
                '{{$source := index . "Source"}}{{with index . "VolumeOptions"}}'
                '{{if index . "Subpath"}}{{$sep}}{"Target":{{json $target}},"Source":{{json $source}},'
                '"Subpath":{{json (index . "Subpath")}}}{{$sep = ","}}{{end}}{{end}}{{end}}]')
    fmt = ('{"Id":{{json .Id}},"Image":{{json .Image}},"State":{"Status":{{json .State.Status}}},'
           '"Labels":'+labels+',"Declared":{{json (index .Config "Volumes")}},"Mounts":{{json .Mounts}},'
           '"SubpathMounts":'+subpaths+'}')
    records = [json.loads(line) for line in output('inspect', '--format', fmt, *ids).splitlines()] if ids else []
    if {c['Id'] for c in records} != set(ids):
        raise ValueError('Container inventory changed during inspection.')
    for record in records:
        record['Mounts'] = record['Mounts'] or []
        record['SubpathMounts'] = record['SubpathMounts'] or []
    return records


def _under(path, root):
    return path == root or path.is_relative_to(root)


def _data_source_tree(source, tree):
    path = PurePosixPath(source or '')
    expected = DATA_SOURCE_ROOT / tree
    return path.is_absolute() and path.parts[-len(expected.parts):] == expected.parts


def _validate_box_data_mounts(c, project, *, host_data, legacy_writable=False):
    subpaths = {}
    for item in c['SubpathMounts']:
        target, source, subpath = item.get('Target'), item.get('Source'), item.get('Subpath')
        if not isinstance(target, str) or not isinstance(source, str) or not isinstance(subpath, str):
            raise ValueError('Box has an invalid subdirectory mount.')
        if target in subpaths:
            raise ValueError('Box has duplicate subdirectory mount metadata.')
        subpaths[target] = (source, subpath)

    by_target = {}
    for mount in c['Mounts']:
        target = mount.get('Destination')
        if target in BOX_DATA_TARGETS:
            if target in by_target:
                raise ValueError(f'Box has duplicate data mounts at {target}.')
            by_target[target] = mount

    for mount in c['Mounts']:
        target = PurePosixPath(mount.get('Destination', ''))
        if any(_under(target, root) for root in BOX_DATA_ROOTS) and str(target) not in BOX_DATA_TARGETS:
            raise ValueError(f'Box has an unapproved Host-data mount at {target}.')
    for target in subpaths:
        if target not in BOX_DATA_TARGETS:
            raise ValueError(f'Box has an unmanaged subdirectory mount at {target}.')

    if not by_target and not subpaths:
        return
    if not host_data or set(by_target) != set(BOX_DATA_TARGETS):
        raise ValueError('Box Host-data mounts are incomplete or do not belong to the local Host volume.')

    identities = {}
    for target, tree in BOX_DATA_TARGETS.items():
        mount = by_target[target]
        # The Bot only reads these trees; a writable mount would let it forge Host records.
        # ProkBot Plus 1.7.0-1.14.0 mounted them writable. Such a container may still be inspected,
        # stopped and backed up (legacy_writable), so that an update can replace it read-only.
        if mount.get('RW') is not False and not (legacy_writable and mount.get('RW') is True):
            raise ValueError(f'Box Host-data mount at {target} is writable; it must be read-only.')
        if mount.get('Type') == 'volume':
            source = project+'_host-data'
            expected = str(DATA_SOURCE_ROOT / tree)
            if mount.get('Name') != source or subpaths.get(target) != (source, expected):
                raise ValueError(f'Box volume mount at {target} does not select the expected Host-data tree.')
            identities[target] = ('volume', source, expected)
        elif mount.get('Type') == 'bind':
            source = mount.get('Source')
            if target in subpaths or not _data_source_tree(source, tree):
                raise ValueError(f'Box bind mount at {target} does not select the expected Host-data tree.')
            identities[target] = ('bind', source)
        else:
            raise ValueError(f'Box Host-data mount at {target} has an unsupported type.')

    for root in BOX_DATA_ROOTS:
        for tree in DATA_TREES:
            first = identities[str(root / tree)]
            for other in BOX_DATA_ROOTS:
                if identities[str(other / tree)] != first:
                    raise ValueError(f'Box exposes different sources for Host-data tree {tree}.')


def writable_box_data(containers):
    """True when a box container still has the writable Host-data mounts of Plus 1.7.0-1.14.0."""
    box = containers.get('box')
    return bool(box) and any(m.get('Destination') in BOX_DATA_TARGETS and m.get('RW') is True for m in box['Mounts'])


def project_services(project, services, *, host_data=None, legacy_writable=False):
    result = {}
    if host_data is None:
        host_data = project+'_host-data' in project_volumes(project)
    for c in inspect_containers(project_ids(project)):
        labels = c['Labels'] or {}
        service = labels.get('com.docker.compose.service')
        if (labels.get('com.docker.compose.project') != project or service not in services or service in result or
                (labels.get('com.docker.compose.oneoff') or '').lower() == 'true'):
            raise ValueError('Unexpected or duplicate project container. Resolve it before operating on the instance.')
        roots = {PurePosixPath(dest) for dest in MOUNTS[service].values()}
        if any(str(PurePosixPath(item.get('Target', ''))) in MOUNTS[service].values() for item in c['SubpathMounts']):
            raise ValueError(f'{service} uses a subdirectory instead of the managed volume root; refusing this operation.')
        if service == 'box':
            _validate_box_data_mounts(c, project, host_data=host_data, legacy_writable=legacy_writable)
        elif c['SubpathMounts']:
            raise ValueError(f'{service} has an unmanaged subdirectory mount; refusing this operation.')
        box_data = set(BOX_DATA_TARGETS) if service == 'box' else set()
        for mount in c['Mounts']:
            dest = PurePosixPath(mount['Destination'])
            if dest in roots or str(dest) in box_data:
                continue
            if service == 'box' and any(_under(dest, root) for root in BOX_DATA_ROOTS):
                raise ValueError(f'Unmanaged Host-data mount on box at {dest}; refusing this operation.')
            # Inherited image VOLUMEs may create anonymous scratch space outside managed data.
            anonymous = (mount['Type'] == 'volume' and re.fullmatch(r'[0-9a-f]{64}', mount.get('Name', '')) and
                         str(dest) in (c.get('Declared') or {}))
            if (any(dest.is_relative_to(root) or root.is_relative_to(dest) for root in roots) or
                    (mount['Type'] != 'tmpfs' and not anonymous)):
                raise ValueError(f'Unmanaged mount on {service} at {dest} would be omitted; refusing this operation.')
        for suffix, dest in MOUNTS[service].items():
            mounts = [m for m in c['Mounts'] if m['Destination'] == dest]
            if (len(mounts) != 1 or mounts[0]['Type'] != 'volume' or mounts[0].get('Name') != project+'_'+suffix
                    or mounts[0].get('RW') is not True):
                raise ValueError(f'{service}: {dest} is not the expected writable project volume.')
        if c['State']['Status'] not in ('running', 'paused', 'exited', 'created'):
            raise ValueError(f'{service} is in a transient or unsupported state; check docker ps before retrying.')
        result[service] = c
    return result


def verify_users(volumes, containers):
    ids = {c['Id'] for c in containers.values()}
    for name in volumes:
        if volume_users(name) - ids:
            raise ValueError(f'Another container uses {name}; detach it before taking a project snapshot.')


def sha(path):
    result = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(1024*1024), b''):
            result.update(block)
    return result.hexdigest()


def backup(project, destination, image, *, stopped=False):
    if destination.exists():
        raise ValueError('Backup destination exists')
    volumes = project_volumes(project)
    services = topology(project, volumes)
    verify_volumes(project, volumes)
    root = local_lineage(project) if 'host' in services else None
    # Backups read data only; an instance from before the read-only mounts must remain backed up.
    containers = project_services(project, services, host_data=project+'_host-data' in volumes, legacy_writable=True)
    verify_users(volumes, containers)
    if stopped and any(c['State']['Status'] not in ('created', 'exited') for c in containers.values()):
        raise ValueError('Upgrade backup requires all project containers to remain stopped.')
    destination.mkdir(parents=True, mode=0o700)
    paused = []
    records = []
    try:
        for c in containers.values():
            if c['State']['Status'] == 'running':
                paused.append(c['Id'])  # A failed CLI response does not prove the daemon did not pause it.
                run('pause', c['Id'], stdout=subprocess.DEVNULL)
        for volume in sorted(volumes):
            path = destination / (volume+'.tar.gz')
            with path.open('wb') as target:
                run('run', '--rm', '--pull=never', '--network', 'none', '--read-only', '--user', '0:0', '--entrypoint', 'tar',
                    '--mount', f'type=volume,src={volume},dst=/backup,readonly,volume-nocopy', image,
                    '-czf', '-', '-C', '/backup', '.', stdout=target)
                os.fsync(target.fileno())
            path.chmod(0o600)
            records.append({'name': volume, 'suffix': volume[len(project)+1:], 'file': path.name, 'sha256': sha(path), 'bytes': path.stat().st_size})
        current = project_services(project, services, host_data=project+'_host-data' in volumes, legacy_writable=True)
        expected = {c['Id']: 'paused' if c['Id'] in paused else c['State']['Status'] for c in containers.values()}
        if project_volumes(project) != volumes or {c['Id']: c['State']['Status'] for c in current.values()} != expected:
            raise ValueError('Instance changed during backup; no manifest was published.')
        verify_users(volumes, current)
    finally:
        failed = []
        for container in reversed(paused):
            try:
                status = output('inspect', '--format', '{{.State.Status}}', container)
                if status == 'paused':
                    run('unpause', container, stdout=subprocess.DEVNULL)
                elif status != 'running':
                    failed.append(container)
            except (OSError, ValueError, subprocess.SubprocessError):
                failed.append(container)
        if failed:
            raise RuntimeError('Could not resume these containers; check docker ps and unpause them: ' + ', '.join(failed))
    manifest = {'schema':'grokbot-volumes/v1', 'project':project, 'image':image,
                'lineageRoot': root,
                'serviceImages': {s: c['Image'] for s, c in containers.items()},
                'at':time.strftime('%Y-%m-%dT%H:%M:%S%z'), 'volumes':records}
    tmp = destination/'manifest.tmp'
    with tmp.open('x', encoding='utf-8') as target:
        target.write(json.dumps(manifest, indent=2)+'\n')
        target.flush()
        os.fsync(target.fileno())
    tmp.chmod(0o600)
    tmp.replace(destination/'manifest.json')
    if os.name == 'posix':
        fd = os.open(destination, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    print(json.dumps({'backup':str(destination), 'volumes':len(records), 'containersResumed':len(paused)}))


def read_manifest(source):
    manifest = json.loads((source/'manifest.json').read_text(encoding='utf-8'))
    if not isinstance(manifest, dict) or manifest.get('schema') != 'grokbot-volumes/v1':
        raise ValueError('Unsupported backup format')
    origin = manifest.get('project')
    if not isinstance(origin, str) or not PROJECT_NAME.fullmatch(origin) or not isinstance(manifest.get('volumes'), list):
        raise ValueError('Invalid backup manifest')
    root = manifest.get('lineageRoot')
    if root is not None and (not isinstance(root, str) or not PROJECT_NAME.fullmatch(root)):
        raise ValueError('Invalid backup lineage metadata')
    return manifest


def restore(source, project, image, *, manifest=None):
    manifest = read_manifest(source) if manifest is None else manifest
    origin = manifest['project']
    prepared = []
    suffixes = set()
    for record in manifest['volumes']:
        suffix = record.get('suffix') if isinstance(record, dict) else None
        if not isinstance(suffix, str) or not re.fullmatch(r'[a-z0-9-]+', suffix) or suffix in suffixes:
            raise ValueError('Invalid or duplicate backup volume')
        suffixes.add(suffix)
        original = origin+'_'+suffix
        if record.get('name') != original or record.get('file') != original+'.tar.gz':
            raise ValueError('Backup filename does not match the recorded volume')
        path = source/record['file']; name = project+'_'+suffix
        if not path.is_file() or path.is_symlink() or path.stat().st_size != record.get('bytes') or sha(path) != record.get('sha256'):
            raise ValueError('Backup checksum mismatch: '+record['file'])
        prepared.append((path, name, suffix))
    topology(origin, {origin+'_'+s for s in suffixes})
    targets = {n for _, n, _ in prepared}
    if project_ids(project) or project_volumes(project) or targets.intersection(output('volume', 'ls', '-q').splitlines()):
        raise ValueError('Restore target already exists; choose a new project.')

    # This extra project volume makes an interrupted restore fail every managed topology check.
    claim = uuid4().hex
    guard = project+'_restore-in-progress'
    created = []

    def reserve(name, suffix):
        # docker volume create succeeds for an existing name, or may create one then lose the reply.
        created.append(name)
        root = manifest.get('lineageRoot')
        lineage = ['--label', f'{LINEAGE_LABEL}={root}'] if root is not None else []
        run('volume', 'create', '--label', f'{RESTORE_LABEL}={claim}', '--label', f'com.docker.compose.project={project}',
            '--label', f'com.docker.compose.volume={suffix}', *lineage, name, stdout=subprocess.DEVNULL)
        if volume_labels(name).get(RESTORE_LABEL) != claim:
            raise ValueError('Restore target was created concurrently: '+name)

    try:
        reserve(guard, 'restore-in-progress')
        for _, name, suffix in prepared:
            reserve(name, suffix)
        for path, name, _ in prepared:
            if volume_labels(name).get(RESTORE_LABEL) != claim or project_ids(project):
                raise ValueError('Restore target changed; refusing to write to '+name)
            verify_users([name], {})
            with path.open('rb') as source_file:
                run('run', '--rm', '-i', '--pull=never', '--network', 'none', '--read-only', '--user', '0:0', '--entrypoint', 'tar',
                    '--mount', f'type=volume,src={name},dst=/restore,volume-nocopy', image, '-xzf', '-', '-C', '/restore', stdin=source_file)
        if project_ids(project) or project_volumes(project) != (targets | {guard}):
            raise ValueError('Restore target changed during extraction.')
        verify_users(targets, {})
        if any(volume_labels(name).get(RESTORE_LABEL) != claim for name in created):
            raise ValueError('Restore ownership changed during extraction.')
        run('volume', 'rm', guard, stdout=subprocess.DEVNULL)
    except (Exception, KeyboardInterrupt):
        failed = []
        for name in reversed(created):
            if name == guard and failed:
                failed.append(guard)
                break
            try:
                if name in output('volume', 'ls', '-q').splitlines() and volume_labels(name).get(RESTORE_LABEL) == claim:
                    run('volume', 'rm', name, stdout=subprocess.DEVNULL)
            except (OSError, ValueError, subprocess.SubprocessError):
                failed.append(name)
        if failed:
            raise RuntimeError('Could not verify or clean partial restore volumes; do not start this project: '+', '.join(failed))
        raise
    print(json.dumps({'restoredProject':project,'volumes':len(prepared),'servicesStarted':False}))


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation',choices=['backup','restore'])
    parser.add_argument('--project',required=True)
    parser.add_argument('--directory',required=True,type=Path)
    parser.add_argument('--image',default='grokbot-host:local')
    args=parser.parse_args()
    if not PROJECT_NAME.fullmatch(args.project):
        parser.error('Invalid Compose project name')
    with project_lock(args.project):
        if args.operation=='backup':
            backup(args.project,args.directory,args.image)
        else:
            restore(args.directory,args.project,args.image)


if __name__=='__main__':
    try:
        main()
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        sys.exit(str(error))
