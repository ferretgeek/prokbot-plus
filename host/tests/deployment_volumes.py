"""An isolated Docker command boundary; archive bytes come from the system tar."""
import contextlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

HOST = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HOST))
import deploy
import backup
import data_init

PROJECT = 'demo'
HOST_TAG = 'grokbot-host:local'
BOX_TAG = deploy.BOX['localTag']
OLD = 'sha256:' + '1' * 64
NEW = 'sha256:' + '2' * 64
BOX = deploy.BOX['configDigest']
MOUNTS = {'host': {'host-data': '/data'}, 'box': {'box-home': '/home/box', 'box-workspace': '/workspace'},
          'gateway': {'gateway-data': '/data'}}
DATA_TARGETS = backup.BOX_DATA_TARGETS


class Engine:
    def __init__(self, root):
        self.root = root
        self.root.mkdir()
        self.labels, self.containers = {}, {}
        self.images = {HOST_TAG: OLD, BOX_TAG: BOX}
        self.image_ids = {OLD, BOX}
        self.calls = []
        self.fail = lambda cmd: False
        self.before_create = lambda name: None
        self.after_build = lambda: None
        self.before_up = lambda: None
        self.unhealthy = False
        self.server = {'Version': '29.1.2', 'ApiVersion': '1.52'}
        self.tar = shutil.which('tar')
        if not self.tar:
            raise unittest.SkipTest('system tar is required for archive integration')

    def volume(self, name, labels=None):
        if name not in self.labels:
            self.labels[name] = labels or {}
            (self.root / name).mkdir()
        return self.root / name

    def stack(self, services=('host', 'box'), project=PROJECT):
        for service in services:
            mounts = []
            for suffix, target in MOUNTS[service].items():
                name = project + '_' + suffix
                directory = self.volume(name, {'com.docker.compose.project': project, 'com.docker.compose.volume': suffix,
                                               'com.docker.compose.version': '2.40.3'})
                (directory / 'payload').write_bytes((suffix + ': original').encode())
                mounts.append({'Type': 'volume', 'Name': name, 'Destination': target, 'RW': True})
            self.container(service, project, mounts, self.images[HOST_TAG if service == 'host' else BOX_TAG])

    def container(self, service, project, mounts, image):
        cid = project + '-' + service
        self.containers[cid] = {'Id': cid, 'Image': image, 'State': {'Status': 'running', 'Paused': False},
                                'Mounts': mounts, 'Config': {'Labels': {'com.docker.compose.project': project,
                                                                     'com.docker.compose.service': service}}}
        return cid

    def ids(self, project):
        return [cid for cid, c in self.containers.items() if c['Config']['Labels']['com.docker.compose.project'] == project]

    @staticmethod
    def error(cmd):
        raise subprocess.CalledProcessError(1, cmd)

    def docker(self, cmd, **kw):
        cmd = list(cmd)
        self.calls.append(cmd)
        if self.fail(cmd):
            self.error(cmd)
        filters = [cmd[i+1] for i, v in enumerate(cmd) if v == '--filter']
        project = next((f.split('=', 2)[2] for f in filters if f.startswith('label=com.docker.compose.project=')), None)
        if cmd[:2] == ['volume', 'ls']:
            wanted = [f[6:].split('=', 1) for f in filters if f.startswith('label=')]
            return '\n'.join(n for n, labels in self.labels.items() if all(k in labels and (not v or labels[k] == v[0]) for k, *v in wanted))
        if cmd[:2] == ['volume', 'inspect']:
            name = next((v for v in cmd[2:] if v in self.labels), None)
            if not name:
                self.error(cmd)
            return json.dumps(self.labels[name]) if '--format' in cmd else json.dumps([{'Name': name, 'Labels': self.labels[name]}])
        if cmd[:2] == ['volume', 'create']:
            name = cmd[-1]
            self.before_create(name)
            labels = dict(cmd[i+1].split('=', 1) for i, v in enumerate(cmd) if v == '--label')
            self.volume(name, labels)  # Docker returns success without relabeling an existing named volume.
            return name
        if cmd[:2] == ['volume', 'rm']:
            name = cmd[-1]
            if any(m.get('Name') == name for c in self.containers.values() for m in c['Mounts']):
                self.error(cmd)
            self.labels.pop(name)
            shutil.rmtree(self.root / name)
            return name
        if cmd[0] == 'ps':
            ids = self.ids(project) if project else list(self.containers)
            for f in filters:
                if f.startswith('status='):
                    ids = [i for i in ids if self.containers[i]['State']['Status'] == f[7:]]
                if f.startswith('volume='):
                    ids = [i for i in ids if any(m.get('Name') == f[7:] for m in self.containers[i]['Mounts'])]
            if not ('-a' in cmd or '--all' in cmd):
                ids = [i for i in ids if self.containers[i]['State']['Status'] in ('running', 'paused', 'restarting')]
            return '\n'.join(ids)
        if cmd[0] == 'inspect':
            items = [self.containers[i] for i in cmd[1:] if i in self.containers]
            if not items:
                self.error(cmd)
            fmt = cmd[cmd.index('--format')+1]
            if fmt == '{{.State.Status}}':
                return '\n'.join(c['State']['Status'] for c in items)
            assert 'index .Config.Labels' in fmt and '{{json .Mounts}}' in fmt
            # `.Id` makes docker inspect read the raw JSON, where a dotted key the daemon omitted
            # is an error. Containers here have no HostConfig.Mounts unless a test adds them, as
            # when Compose 2.40 creates named volumes as Binds.
            for c in items:
                host_mounts = c.get('HostConfig', {}).get('Mounts')
                if ('.HostConfig.Mounts' in fmt and host_mounts is None or
                        '.VolumeOptions' in fmt and any('VolumeOptions' not in m for m in host_mounts or [])):
                    self.error(cmd)
            return '\n'.join(json.dumps({'Id': c['Id'], 'State': c['State'], 'Image': c['Image'],
                                          'Labels': c['Config']['Labels'], 'Mounts': c['Mounts'],
                                          'SubpathMounts': [{'Target': m['Target'], 'Source': m.get('Source'),
                                                             'Subpath': m['VolumeOptions']['Subpath']}
                                                            for m in c.get('HostConfig', {}).get('Mounts') or []
                                                            if (m.get('VolumeOptions') or {}).get('Subpath')]
                                          if 'index .HostConfig "Mounts"' in fmt else []}) for c in items)
        if cmd[0] in ('pause', 'unpause', 'stop', 'start'):
            c = self.containers[cmd[-1]]
            status = {'pause': 'paused', 'unpause': 'running', 'stop': 'exited', 'start': 'running'}[cmd[0]]
            c['State'].update(Status=status, Paused=status == 'paused')
            return cmd[-1]
        if cmd[0] == 'run':
            entrypoint = cmd[cmd.index('--entrypoint')+1] if '--entrypoint' in cmd else None
            if '--mount' in cmd:
                mount = dict(item.split('=', 1) for item in cmd[cmd.index('--mount')+1].split(',') if '=' in item)
                name = mount.get('src') or mount['source']
            else:
                name = cmd[cmd.index('-v')+1].split(':')[0]
            directory = self.volume(name)
            self.assert_helper_is_local(cmd)
            if entrypoint == 'python3':
                assert any(str(arg).endswith('/release/data_init.py') for arg in cmd)
                data_init.initialise(directory/'runtime/host-data', trusted_root=directory,
                                     uid=os.getuid() if os.name == 'posix' else data_init.UID,
                                     gid=os.getgid() if os.name == 'posix' else data_init.GID)
                return ''
            if entrypoint != 'tar':
                raise AssertionError(cmd)
            flags = cmd.index('-czf' if '-czf' in cmd else '-xzf')
            tar_args = cmd[flags:]
            tar_args[tar_args.index('-C')+1] = str(directory)
            subprocess.run([self.tar, *tar_args], check=True, stdin=kw.get('stdin'), stdout=kw.get('stdout'))
            return ''
        if cmd[:2] == ['image', 'ls']:
            return self.images.get(cmd[-1], '')
        if cmd[:2] == ['image', 'inspect']:
            ref = next((v for v in cmd[2:] if v in self.images or v in self.images.values() or v in self.image_ids), None)
            if not ref:
                self.error(cmd)
            return 'linux/amd64' if '{{.Os}}/{{.Architecture}}' in cmd else self.images.get(ref, ref)
        if cmd[:2] == ['image', 'tag'] or cmd[0] == 'tag':
            self.images[cmd[-1]] = self.images.get(cmd[-2], cmd[-2])
            return ''
        if cmd[:2] == ['image', 'rm']:
            del self.images[cmd[-1]]
            return ''
        if cmd[:2] == ['version', '--format']:
            return json.dumps(self.server)
        if cmd[0] == 'compose':
            if 'version' in cmd:
                return '2.40.3'
            project = cmd[cmd.index('-p')+1]
            modes = ('host',) if any(str(p).endswith('compose.host.yaml') for p in cmd) else ('host', 'box')
            memory = any(str(p).endswith('compose.memory.yaml') for p in cmd)
            env = kw.get('env') or {}
            external = env.get('PROKBOT_EXISTING_VOLUMES') == 'true'
            refs = {'host': env.get('GROKBOT_HOST_IMAGE', HOST_TAG), 'box': env.get('GROKBOT_BOX_IMAGE', BOX_TAG)}
            if 'config' in cmd:
                services = {}
                for s in modes:
                    volumes = [{'type': 'volume', 'source': n, 'target': t} for n, t in MOUNTS[s].items()]
                    if s == 'box' and memory:
                        volumes.extend({'type': 'volume', 'source': 'host-data', 'target': target, 'read_only': True,
                                        'volume': {'subpath': str(backup.DATA_SOURCE_ROOT/tree)}}
                                       for target, tree in DATA_TARGETS.items())
                    services[s] = {'image': refs[s], 'volumes': volumes}
                return json.dumps({'services': services,
                    'volumes': {n: {'name': project+'_'+n, 'external': external} for s in modes for n in MOUNTS[s]}})
            if 'ps' in cmd:
                return '\n'.join(i for i in self.ids(project) if cmd[-1] not in MOUNTS or i == project+'-'+cmd[-1])
            if 'stop' in cmd:
                for i in self.ids(project):
                    self.containers[i]['State'].update(Status='exited', Paused=False)
                return ''
            if 'up' in cmd:
                self.before_up()
                if external and any(project+'_'+suffix not in self.labels for s in modes for suffix in MOUNTS[s]):
                    self.error(cmd)
                for s in modes:
                    mounts = []
                    configured = []
                    for suffix, target in MOUNTS[s].items():
                        name = project + '_' + suffix
                        self.volume(name, {'com.docker.compose.project': project, 'com.docker.compose.volume': suffix,
                                           'com.docker.compose.version': '2.40.3'})
                        mounts.append({'Type': 'volume', 'Name': name, 'Destination': target, 'RW': True})
                    if s == 'box' and memory:
                        for target, tree in DATA_TARGETS.items():
                            name = project+'_host-data'
                            subpath = str(backup.DATA_SOURCE_ROOT/tree)
                            mounts.append({'Type': 'volume', 'Name': name, 'Destination': target, 'RW': False})
                            configured.append({'Type': 'volume', 'Source': name, 'Target': target,
                                               'VolumeOptions': {'Subpath': subpath}})
                    cid = self.container(s, project, mounts, self.images.get(refs[s], refs[s]))
                    self.containers[cid]['HostConfig'] = {'Mounts': configured}
                if self.unhealthy:
                    (self.root / (project + '_host-data') / 'partial-migration').touch()
                    self.error(cmd)
                return ''
        raise AssertionError(f'unimplemented simulated command: {cmd}')

    @staticmethod
    def assert_helper_is_local(cmd):
        assert '--pull=never' in cmd and cmd[cmd.index('--network')+1] == 'none'
        assert 'volume-nocopy' in cmd[cmd.index('--mount')+1] and '--read-only' in cmd

    def deploy_run(self, cmd, **kw):
        if cmd[0] != 'docker':
            raise AssertionError(cmd)
        return SimpleNamespace(stdout=self.docker(cmd[1:], **kw))

    def build(self, args, image):
        self.calls.append(['build', image])
        self.images[image] = NEW
        self.image_ids.add(NEW)
        self.after_build()


class VolumeTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.home = Path(tmp.name) / 'instance'
        self.e = Engine(Path(tmp.name) / 'volumes')
        self.source = Path(tmp.name) / 'snapshot'
        for obj, name, fn in [(deploy, 'run', self.e.deploy_run), (deploy, 'build', self.e.build),
                              (deploy, 'docker_platform', lambda: 'linux/amd64'),
                              (backup, 'run', lambda *cmd, **kw: self.e.docker(cmd, **kw)),
                              (backup, 'output', lambda *cmd: self.e.docker(cmd))]:
            mock = patch.object(obj, name, fn)
            mock.start()
            self.addCleanup(mock.stop)

    def invoke(self, *args):
        return deploy.main(['--home', str(self.home), '--project', PROJECT, *args])

    def snapshot(self, services=('host', 'box')):
        self.e.stack(services)
        backup.backup(PROJECT, self.source, HOST_TAG)

    def restored(self, project, suffix):
        return self.e.root / (project + '_' + suffix)

    def add_box_data_mounts(self, *, bind=False):
        container = self.e.containers[PROJECT+'-box']
        configured = []
        for target, tree in DATA_TARGETS.items():
            if bind:
                container['Mounts'].append({'Type': 'bind',
                    'Source': f'/srv/prokbot/runtime/host-data/{tree}', 'Destination': target, 'RW': False})
            else:
                container['Mounts'].append({'Type': 'volume', 'Name': PROJECT+'_host-data',
                                            'Destination': target, 'RW': False})
                configured.append({'Type': 'volume', 'Source': PROJECT+'_host-data', 'Target': target,
                                   'VolumeOptions': {'Subpath': str(backup.DATA_SOURCE_ROOT/tree)}})
        if configured:
            container['HostConfig'] = {'Mounts': configured}
        return container

    def test_round_trip_preserves_three_volumes_without_starting_a_service(self):
        self.snapshot()
        backup.restore(self.source, 'recovered', HOST_TAG)
        for suffix in ('host-data', 'box-home', 'box-workspace'):
            self.assertEqual((self.restored('recovered', suffix) / 'payload').read_bytes(), (suffix + ': original').encode())
        self.assertFalse(self.e.ids('recovered'))

    def test_split_execution_backup_restores_gateway_and_desktop_without_a_host_volume(self):
        self.snapshot(('gateway', 'box'))
        backup.restore(self.source, 'recovered', HOST_TAG)
        for suffix in ('gateway-data', 'box-home', 'box-workspace'):
            self.assertEqual((self.restored('recovered', suffix)/'payload').read_bytes(), (suffix+': original').encode())
        self.assertFalse(self.restored('recovered', 'host-data').exists())

    @unittest.skipIf(os.name == 'nt', 'POSIX volume metadata')
    def test_round_trip_preserves_database_rows_binary_mode_links_and_empty_directory(self):
        import sqlite3
        self.e.stack()
        data = self.restored(PROJECT, 'host-data')
        db = sqlite3.connect(data / 'state.db')
        self.addCleanup(db.close)
        db.execute('pragma journal_mode=wal')
        db.execute('pragma wal_autocheckpoint=0')
        db.execute('create table messages (body text)')
        db.execute('insert into messages values (?)', ('fixture conversation',))
        db.commit()
        self.assertGreater((data/'state.db-wal').stat().st_size, 0)
        workspace = self.restored(PROJECT, 'box-workspace')
        payload = workspace/'private-data'
        payload.write_bytes(bytes(range(256))*9)
        payload.chmod(0o600)
        os.link(payload, workspace/'hardlink')
        (workspace/'link').symlink_to('private-data')
        (workspace/'empty').mkdir(mode=0o750)
        backup.backup(PROJECT, self.source, HOST_TAG)
        backup.restore(self.source, 'recovered', HOST_TAG)
        with contextlib.closing(sqlite3.connect(self.restored('recovered', 'host-data')/'state.db')) as db:
            self.assertEqual(db.execute('select * from messages').fetchall(), [('fixture conversation',)])
            self.assertEqual(db.execute('pragma integrity_check').fetchone(), ('ok',))
        copy = self.restored('recovered', 'box-workspace')
        self.assertEqual((copy/'link').readlink(), Path('private-data'))
        self.assertEqual((copy/'private-data').read_bytes(), payload.read_bytes())
        self.assertEqual((copy/'private-data').stat().st_mode & 0o777, 0o600)
        self.assertTrue((copy/'hardlink').samefile(copy/'private-data'))
        self.assertEqual(list((copy/'empty').iterdir()), [])

    def test_concurrent_target_creation_never_overwrites_foreign_bytes(self):
        self.snapshot(('host',))
        name = 'recovered_host-data'
        self.e.before_create = lambda n: (self.e.volume(n) / 'payload').write_bytes(b'keep me') if n == name else None
        with self.assertRaises((ValueError, RuntimeError)):
            backup.restore(self.source, 'recovered', HOST_TAG)
        self.assertEqual((self.e.root / name / 'payload').read_bytes(), b'keep me')

    def test_restore_inspection_error_is_not_absence(self):
        self.snapshot(('host',))
        name = 'recovered_host-data'
        (self.e.volume(name) / 'payload').write_bytes(b'keep me')
        self.e.fail = lambda cmd: cmd[:2] in (['volume', 'inspect'], ['volume', 'ls'])
        with self.assertRaises((ValueError, subprocess.CalledProcessError)):
            backup.restore(self.source, 'recovered', HOST_TAG)
        self.assertEqual((self.e.root / name / 'payload').read_bytes(), b'keep me')

    def test_restore_failure_leaves_retryable_target(self):
        self.snapshot()
        self.e.fail = lambda cmd: cmd[0] == 'run' and any('recovered_box-home' in v for v in cmd)
        with self.assertRaises((ValueError, RuntimeError, subprocess.CalledProcessError)):
            backup.restore(self.source, 'recovered', HOST_TAG)
        self.assertFalse(any(n.startswith('recovered_') for n in self.e.labels))
        self.e.fail = lambda cmd: False
        backup.restore(self.source, 'recovered', HOST_TAG)

    def test_corrupt_or_incomplete_manifests_never_create_volumes(self):
        self.snapshot()
        manifest = self.source / 'manifest.json'
        original = json.loads(manifest.read_text())
        records = original['volumes']
        for invalid in ([], records[1:], records + [records[0]], [*records[:-1], {**records[-1], 'file': records[0]['file']}],
                        [*records[:-1], {**records[-1], 'sha256': '0'*64}]):
            with self.subTest(count=len(invalid)):
                manifest.write_text(json.dumps({**original, 'volumes': invalid}))
                with self.assertRaises(ValueError): backup.restore(self.source, 'recovered', HOST_TAG)
                self.assertFalse(any(c[:2] == ['volume', 'create'] for c in self.e.calls))

    def test_restore_refuses_a_project_even_without_matching_target_volumes(self):
        self.snapshot(('host',))
        self.e.container('other', 'recovered', [], OLD)
        with self.assertRaisesRegex(ValueError, 'already exists'):
            backup.restore(self.source, 'recovered', HOST_TAG)
        self.assertNotIn('recovered_host-data', self.e.labels)

    def test_restore_cleanup_failure_is_reported_without_claiming_success(self):
        self.snapshot()
        self.e.fail = lambda c: (c[0] == 'run' and any('recovered_box-home' in v for v in c)) or c[:2] == ['volume', 'rm']
        with self.assertRaisesRegex(RuntimeError, 'partial restore'):
            backup.restore(self.source, 'recovered', HOST_TAG)
        self.assertFalse(self.e.ids('recovered'))
        with self.assertRaisesRegex(ValueError, 'already exists'): backup.restore(self.source, 'recovered', HOST_TAG)

    def test_interrupted_restore_is_not_an_upgradable_instance(self):
        self.snapshot()
        def interrupt(cmd):
            if cmd[0] == 'run' and '-xzf' in cmd:
                raise SystemExit('simulated termination without cleanup')
        self.e.fail = interrupt
        with self.assertRaises(SystemExit): backup.restore(self.source, 'recovered', HOST_TAG)
        self.e.fail = lambda c: False
        args = ['--home', str(self.home), '--project', 'recovered']
        deploy.main([*args, 'init'])
        with self.assertRaisesRegex(ValueError, 'volume|Volume|restore'): deploy.main([*args, 'update'])
        self.assertFalse(any('up' in c for c in self.e.calls))

    def test_lost_volume_create_acknowledgement_cleans_only_our_volume(self):
        self.snapshot(('host',))
        create = self.e.docker
        def uncertain(cmd, **kw):
            result = create(cmd, **kw)
            if list(cmd[:2]) == ['volume', 'create'] and cmd[-1] == 'recovered_host-data':
                self.e.error(cmd)
            return result
        with patch.object(self.e, 'docker', uncertain), self.assertRaises(subprocess.CalledProcessError):
            backup.restore(self.source, 'recovered', HOST_TAG)
        self.assertFalse(any(n.startswith('recovered_') for n in self.e.labels))

    def test_backup_rejects_active_foreign_writer_without_pausing_it(self):
        self.e.stack(('host',))
        self.e.container('sidecar', 'another', self.e.containers['demo-host']['Mounts'], OLD)
        with self.assertRaisesRegex(ValueError, 'container|writer|project'):
            backup.backup(PROJECT, self.source, HOST_TAG)
        self.assertEqual(self.e.containers['another-sidecar']['State']['Status'], 'running')
        self.assertFalse((self.source / 'manifest.json').exists())

    def test_backup_rejects_container_using_only_a_subdirectory_of_its_project_volume(self):
        self.e.stack(('host',))
        c = self.e.containers['demo-host']
        c['HostConfig'] = {'Mounts': [{'Type': 'volume', 'Target': '/data', 'Source': 'demo_host-data',
                                       'VolumeOptions': {'Subpath': 'other-instance'}}]}
        with self.assertRaisesRegex(ValueError, 'subdirectory'):
            backup.backup(PROJECT, self.source, HOST_TAG)
        self.assertFalse(self.source.exists()); self.assertEqual(c['State']['Status'], 'running')
        self.assertFalse(any(cmd[0] in ('pause', 'run') for cmd in self.e.calls))

    def test_backup_reads_containers_without_host_config_mounts_or_volume_options(self):
        # Compose 2.40 writes Binds, leaving no HostConfig.Mounts; --mount without options leaves no VolumeOptions.
        self.e.stack()
        self.e.containers['demo-box']['HostConfig'] = {'Mounts': [{'Type': 'volume', 'Target': '/workspace',
                                                                   'Source': 'demo_box-workspace'}]}
        backup.backup(PROJECT, self.source, HOST_TAG)
        manifest = json.loads((self.source / 'manifest.json').read_text())
        self.assertEqual(len(manifest['volumes']), 3)
        self.assertEqual({c['State']['Status'] for c in self.e.containers.values()}, {'running'})

    def test_box_gets_only_the_five_parent_data_trees_and_host_data_is_archived_once(self):
        self.e.stack()
        self.add_box_data_mounts()
        services = backup.project_services(PROJECT, ('host', 'box'), host_data=True)
        self.assertEqual(set(services), {'host', 'box'})
        backup.backup(PROJECT, self.source, HOST_TAG)
        manifest = json.loads((self.source/'manifest.json').read_text())
        self.assertEqual([item['suffix'] for item in manifest['volumes']], ['box-home', 'box-workspace', 'host-data'])
        self.assertNotIn('connector-secrets', backup.BOX_DATA_TARGETS)
        self.assertNotIn('projects', backup.DATA_TREES)
        self.assertEqual(len(backup.BOX_DATA_TARGETS), 5)

    def test_fnOS_style_box_bind_tree_mounts_are_accepted(self):
        self.e.stack()
        self.add_box_data_mounts(bind=True)
        services = backup.project_services(PROJECT, ('host', 'box'), host_data=True)
        self.assertEqual(set(services), {'host', 'box'})
        for tree in backup.DATA_TREES:
            sources = {next(m['Source'] for m in services['box']['Mounts']
                            if m['Destination'] == str(root/tree)) for root in backup.BOX_DATA_ROOTS}
            self.assertEqual(len(sources), 1)

    def test_partial_extra_wrong_and_writable_box_data_mounts_are_rejected(self):
        self.e.stack()
        self.add_box_data_mounts()
        box = self.e.containers[PROJECT+'-box']
        original = box['Mounts']
        with self.subTest('partial'):
            box['Mounts'] = original[:-1]
            with self.assertRaisesRegex(ValueError, 'incomplete'):
                backup.project_services(PROJECT, ('host', 'box'), host_data=True)
        box['Mounts'] = [dict(item) for item in original]
        for name in ('connector-secrets', 'agent-transcripts'):
            with self.subTest('sensitive-extra', name=name):
                box['Mounts'] = [dict(item) for item in original]
                box['Mounts'].append({'Type': 'bind', 'Source': f'/srv/prokbot/runtime/host-data/{name}',
                                      'Destination': f'/data/runtime/host-data/{name}', 'RW': True})
                with self.assertRaisesRegex(ValueError, 'unapproved'):
                    backup.project_services(PROJECT, ('host', 'box'), host_data=True)
        box['Mounts'] = [dict(item) for item in original]
        with self.subTest('wrong-source'):
            box['Mounts'][2]['Name'] = 'another_host-data'
            with self.assertRaisesRegex(ValueError, 'expected Host-data tree'):
                backup.project_services(PROJECT, ('host', 'box'), host_data=True)
        box['Mounts'] = [dict(item) for item in original]
        with self.subTest('writable'):
            next(item for item in box['Mounts'] if item['Destination'] == '/data/runtime/host-data/agents')['RW'] = True
            with self.assertRaisesRegex(ValueError, 'writable; it must be read-only'):
                backup.project_services(PROJECT, ('host', 'box'), host_data=True)
        box['Mounts'] = [dict(item) for item in original]
        box['Mounts'] = [dict(item) for item in original]
        with self.subTest('wrong-subpath'):
            box['HostConfig']['Mounts'][0]['VolumeOptions']['Subpath'] = 'runtime/host-data/connector-secrets'
            with self.assertRaisesRegex(ValueError, 'expected Host-data tree'):
                backup.project_services(PROJECT, ('host', 'box'), host_data=True)

    def test_backup_does_not_unpause_prepaused_or_start_stopped_services(self):
        self.e.stack()
        self.e.docker(['pause', 'demo-box'])
        self.e.docker(['stop', 'demo-host'])
        backup.backup(PROJECT, self.source, HOST_TAG)
        self.assertEqual(self.e.containers['demo-box']['State']['Status'], 'paused')
        self.assertEqual(self.e.containers['demo-host']['State']['Status'], 'exited')
        self.assertTrue((self.source / 'manifest.json').is_file())

    def test_resume_attempts_every_container_paused_by_backup(self):
        self.e.stack()
        self.e.fail = lambda cmd: cmd == ['unpause', 'demo-box']
        with self.assertRaisesRegex(RuntimeError, 'demo-box'):
            backup.backup(PROJECT, self.source, HOST_TAG)
        self.assertEqual([c[-1] for c in self.e.calls if c[0] == 'unpause'], ['demo-box', 'demo-host'])
        self.assertFalse((self.source / 'manifest.json').exists())

    def test_lost_pause_acknowledgement_does_not_strand_running_service(self):
        self.e.stack()
        command = self.e.docker
        def uncertain(cmd, **kw):
            result = command(cmd, **kw)
            if list(cmd) == ['pause', 'demo-box']: self.e.error(cmd)
            return result
        with patch.object(self.e, 'docker', uncertain), self.assertRaises(subprocess.CalledProcessError):
            backup.backup(PROJECT, self.source, HOST_TAG)
        self.assertTrue(all(c['State']['Status'] == 'running' for c in self.e.containers.values()))
        self.assertFalse((self.source / 'manifest.json').exists())

    def test_live_mounts_not_just_project_volume_names_are_checked(self):
        self.invoke('init')
        self.e.stack()
        self.e.containers['demo-host']['Mounts'] = [{'Type': 'bind', 'Source': '/fixture', 'Destination': '/data', 'RW': True}]
        with self.assertRaisesRegex(ValueError, 'mount|volume'):
            self.invoke('update')
        self.assertFalse(any(cmd[0] in ('build', 'stop', 'pause') or 'up' in cmd for cmd in self.e.calls))

    def test_failed_switch_keeps_latest_backup_and_stops_candidate(self):
        self.invoke('init')
        self.e.stack()
        data = self.restored(PROJECT, 'host-data')
        self.e.after_build = lambda: (data / 'payload').write_bytes(b'last acknowledged write')
        self.e.unhealthy = True
        with self.assertRaises((ValueError, RuntimeError, subprocess.CalledProcessError)):
            self.invoke('update')
        self.assertTrue(all(c['State']['Status'] == 'exited' for c in self.e.containers.values()), 'failed candidate still writing')
        snapshots = list((self.home / 'backups').glob('*/manifest.json'))
        self.assertEqual(len(snapshots), 1)
        backup.restore(snapshots[0].parent, 'recovered', HOST_TAG)
        recovered = self.restored('recovered', 'host-data')
        self.assertEqual((recovered / 'payload').read_bytes(), b'last acknowledged write')
        self.assertFalse((recovered / 'partial-migration').exists())
        self.assertTrue((data / 'partial-migration').exists(), 'do not overwrite the live volume to roll back')
        self.assertIn(OLD, [v for k, v in self.e.images.items() if k.startswith('prokbot-recovery:')])

    def test_first_install_health_failure_stops_partial_stack_and_retains_its_volumes(self):
        self.invoke('init')
        self.e.unhealthy = True
        with self.assertRaises((RuntimeError, subprocess.CalledProcessError)): self.invoke('up')
        self.assertTrue(all(c['State']['Status'] == 'exited' for c in self.e.containers.values()))
        self.assertEqual(len(self.e.labels), 3)
        self.assertTrue((self.restored(PROJECT, 'host-data')/'partial-migration').exists())
        with self.assertRaises(ValueError): self.invoke('up')

    def test_failed_candidate_stop_does_not_claim_rollback_or_shutdown(self):
        self.invoke('--host-only', 'init')
        self.e.stack(('host',))
        self.e.unhealthy = True
        self.e.fail = lambda c: c[0] == 'compose' and 'stop' in c
        with self.assertRaisesRegex(RuntimeError, 'shutdown NOT confirmed'): self.invoke('update')
        self.assertTrue(list((self.home / 'backups').glob('*/manifest.json')))
        self.assertFalse(any(c[0] == 'start' for c in self.e.calls))

    def test_failed_build_or_platform_check_leaves_old_image_and_processes_alone(self):
        self.invoke('--host-only', 'init')
        self.e.stack(('host',))
        for mock in (patch.object(deploy, 'build', side_effect=ValueError('build')),
                     patch.object(deploy, 'docker_platform', return_value='linux/arm64')):
            with mock, self.assertRaises(ValueError): self.invoke('update')
            self.assertEqual(self.e.images[HOST_TAG], OLD)
            self.assertFalse(any(c[0] in ('start', 'stop', 'pause') or 'up' in c for c in self.e.calls))

    def test_stop_failure_recovers_original_running_services_and_never_starts_candidate(self):
        self.invoke('init')
        self.e.stack()
        self.e.fail = lambda c: c == ['stop', 'demo-box']
        with self.assertRaises(subprocess.CalledProcessError): self.invoke('update')
        self.assertTrue(all(c['State']['Status'] == 'running' and c['Image'] != NEW for c in self.e.containers.values()))
        self.assertFalse(any('up' in c for c in self.e.calls))

    def test_backup_failure_resumes_only_originally_running_services(self):
        self.invoke('init')
        self.e.stack()
        self.e.docker(['stop', 'demo-box'])
        self.e.fail = lambda c: c[0] == 'run' and '-czf' in c
        with self.assertRaises(subprocess.CalledProcessError): self.invoke('update')
        self.assertEqual(self.e.images[HOST_TAG], OLD)
        self.assertEqual(self.e.containers['demo-host']['State']['Status'], 'running')
        self.assertEqual(self.e.containers['demo-box']['State']['Status'], 'exited')
        self.assertFalse(any('up' in c for c in self.e.calls))

    def test_build_time_mount_change_aborts_before_stopping_services(self):
        self.invoke('init')
        self.e.stack()
        self.e.after_build = lambda: self.e.containers['demo-box']['Mounts'].pop()
        with self.assertRaisesRegex(ValueError, 'volume'): self.invoke('update')
        self.assertFalse(any(c[0] == 'stop' or 'up' in c for c in self.e.calls))

    def test_mutating_commands_in_same_instance_directory_are_serialized(self):
        self.invoke('init')
        self.e.stack()
        def concurrent_backup():
            with self.assertRaisesRegex(ValueError, 'operation'): self.invoke('backup')
        self.e.after_build = concurrent_backup
        self.invoke('update')
        self.assertEqual(len(list((self.home/'backups').glob('*/manifest.json'))), 1)

    def test_upgrade_cannot_silently_create_an_empty_replacement_volume(self):
        self.invoke('init')
        self.e.stack()
        self.e.before_up = lambda: self.e.labels.pop('demo_host-data')
        with self.assertRaisesRegex(RuntimeError, 'No automatic data rollback'): self.invoke('update')
        self.assertNotIn('demo_host-data', self.e.labels)
        self.assertTrue(list((self.home / 'backups').glob('*/manifest.json')))
        self.assertTrue(all(c['State']['Status'] == 'exited' for c in self.e.containers.values()))

    def test_partial_and_foreign_volumes_block_up_and_update(self):
        self.invoke('init')
        self.e.volume('demo_host-data', {})
        for action in ('up', 'update'):
            with self.assertRaises(ValueError): self.invoke(action)
        self.assertFalse(any(c[0] == 'build' for c in self.e.calls))

    def test_volume_only_host_never_treats_mutable_tag_as_the_previous_image(self):
        self.invoke('--host-only', 'init')
        self.e.stack(('host',))
        self.e.containers.clear()
        self.e.images[HOST_TAG] = NEW
        with self.assertRaisesRegex(ValueError, 'volume-only'): self.invoke('update')
        self.assertFalse(list((self.home / 'backups').glob('*/manifest.json')))
        self.assertFalse(any(c[0] in ('build', 'stop', 'start') or 'up' in c for c in self.e.calls))

    def test_unmanaged_submount_blocks_backup_and_update_before_stopping_host(self):
        self.invoke('--host-only', 'init')
        self.e.stack(('host',))
        uploads = self.e.volume('user-uploads') / 'payload'
        uploads.write_bytes(b'private fixture')
        self.e.containers['demo-host']['Mounts'].append({'Type':'volume', 'Name':'user-uploads', 'Destination':'/data/uploads', 'RW':True})
        for action in ('backup', 'update'):
            with self.assertRaisesRegex(ValueError, '/data/uploads'): self.invoke(action)
        self.assertFalse(any(c[0] in ('build', 'stop', 'pause') or 'up' in c for c in self.e.calls))
        self.assertEqual(uploads.read_bytes(), b'private fixture')

    def test_same_daemon_project_cannot_switch_twice_from_different_homes(self):
        self.invoke('--host-only', 'init')
        other = ['--home', str(self.home.parent/'second-home'), '--project', PROJECT, '--host-only']
        deploy.main([*other, 'init'])
        self.e.stack(('host',))
        def concurrent():
            self.e.before_up = lambda: None
            with self.assertRaisesRegex(ValueError, 'operation'): deploy.main([*other, 'update'])
        self.e.before_up = concurrent
        self.invoke('update')
        self.assertEqual(sum(c[0] == 'build' for c in self.e.calls), 1)
        self.assertEqual(self.e.containers['demo-host']['Image'], NEW)
        self.assertEqual(self.e.containers['demo-host']['State']['Status'], 'running')

    def test_lost_image_tag_reply_restores_actual_previous_public_tag_and_original_host(self):
        self.invoke('--host-only', 'init')
        self.e.stack(('host',))
        previous_tag = 'sha256:' + '4'*64  # Shared tag need not match the running Host.
        self.e.images[HOST_TAG] = previous_tag
        self.e.image_ids.add(previous_tag)
        command = self.e.docker
        def uncertain(cmd, **kw):
            result = command(cmd, **kw)
            if list(cmd) == ['image', 'tag', NEW, HOST_TAG]: self.e.error(cmd)
            return result
        with patch.object(self.e, 'docker', uncertain), self.assertRaises(subprocess.CalledProcessError): self.invoke('update')
        self.assertEqual(self.e.images[HOST_TAG], previous_tag)
        self.assertEqual(self.e.containers['demo-host']['Image'], OLD)
        self.assertEqual(self.e.containers['demo-host']['State']['Status'], 'running')
        self.assertFalse(any('up' in c for c in self.e.calls))

    def test_new_and_existing_stacks_use_pinned_box_despite_retag_during_start(self):
        self.invoke('init')
        for action in ('up', 'update'):
            self.e.images[BOX_TAG] = BOX
            self.e.before_up = lambda: self.e.images.update({BOX_TAG: 'sha256:'+'4'*64})
            self.invoke(action)
            self.assertEqual(self.e.containers['demo-box']['Image'], BOX)

    def test_running_wrong_box_image_is_not_reported_as_success(self):
        self.invoke('init')
        self.e.stack()
        command = self.e.docker
        def wrong(cmd, **kw):
            result = command(cmd, **kw)
            if cmd[0] == 'compose' and 'up' in cmd: self.e.containers['demo-box']['Image'] = 'sha256:'+'4'*64
            return result
        with patch.object(self.e, 'docker', wrong), self.assertRaisesRegex(RuntimeError, 'verified deployment'):
            self.invoke('update')
        self.assertTrue(all(c['State']['Status'] == 'exited' for c in self.e.containers.values()))

    def recovery_args(self, split=False):
        args = ['--home', str(self.home.parent/'recovery-home'), '--project', 'recovered']
        deploy.main([*args, *(['--host-only'] if split else []), 'init'])
        return [*args, 'recover', '--directory', str(self.source)]

    def test_recover_starts_exact_original_images_and_existing_volumes_after_failed_update(self):
        self.invoke('init')
        self.e.stack()
        self.e.unhealthy = True
        with self.assertRaises(RuntimeError): self.invoke('update')
        self.source = next((self.home/'backups').glob('*/manifest.json')).parent
        self.e.unhealthy = False
        self.e.images[BOX_TAG] = 'sha256:'+'4'*64
        self.e.images[HOST_TAG] = NEW
        args = self.recovery_args()
        deploy.main(args)
        for service, expected in [('host', OLD), ('box', BOX)]:
            self.assertEqual(self.e.containers['recovered-'+service]['Image'], expected)
            self.assertEqual(self.e.containers['demo-'+service]['State']['Status'], 'exited')
        self.assertFalse((self.restored('recovered', 'host-data')/'partial-migration').exists())
        self.assertTrue((self.restored('demo', 'host-data')/'partial-migration').exists())
        with self.assertRaises(ValueError): deploy.main(args)

    def test_recover_refuses_running_original_missing_image_or_legacy_mutable_manifest(self):
        self.snapshot(('host',))
        args = self.recovery_args(split=True)
        with self.assertRaisesRegex(ValueError, 'not stopped'): deploy.main(args)
        self.e.docker(['stop', 'demo-host'])
        path = self.source/'manifest.json'
        manifest = json.loads(path.read_bytes())
        self.e.images[HOST_TAG] = NEW
        self.e.image_ids.remove(OLD)
        with self.assertRaises(subprocess.CalledProcessError): deploy.main(args)
        self.e.image_ids.add(OLD)
        path.write_text(json.dumps({k:v for k,v in manifest.items() if k != 'serviceImages'}))
        with self.assertRaisesRegex(ValueError, 'no verified'): deploy.main(args)
        self.assertFalse(any(n.startswith('recovered_') for n in self.e.labels))

    def test_recover_host_only_requires_stopped_original_and_starts_without_build(self):
        self.snapshot(('host',))
        self.e.docker(['stop', 'demo-host'])
        args = self.recovery_args(split=True)
        deploy.main(args)
        self.assertEqual(self.e.containers['recovered-host']['Image'], OLD)
        self.assertEqual(self.e.containers['demo-host']['State']['Status'], 'exited')
        self.assertFalse(any(c[0] == 'build' for c in self.e.calls))

    def test_memory_mounts_follow_docker_version_and_stay_read_only(self):
        def data_mounts():
            return [m for m in self.e.containers[PROJECT+'-box']['Mounts'] if m['Destination'].startswith('/data')]

        self.e.server = {'Version': '24.0.2', 'ApiVersion': '1.43'}
        self.invoke('init')
        with contextlib.redirect_stderr(io.StringIO()) as notice:
            self.invoke('up')
        self.assertIn('Docker Engine 24.0.2 is too old', notice.getvalue())
        self.assertEqual(data_mounts(), [])
        self.assertFalse((self.restored(PROJECT, 'host-data')/'runtime').exists(), 'data_init runs only with the overlay')
        self.assertFalse(any(str(deploy.MEMORY_COMPOSE) in c for c in self.e.calls))

        # Upgrading Docker later turns the feature on at the next update.
        self.e.server = {'Version': '29.1.2', 'ApiVersion': '1.52'}
        self.invoke('update')
        self.assertEqual({m['Destination']: m['RW'] for m in data_mounts()}, dict.fromkeys(DATA_TARGETS, False))
        self.assertEqual({p.name for p in (self.restored(PROJECT, 'host-data')/'runtime/host-data').iterdir()},
                         set(backup.DATA_TREES))
        self.invoke('backup')

    def test_update_replaces_writable_memory_mounts_of_earlier_releases_with_read_only_ones(self):
        # ProkBot Plus 1.7.0-1.14.0 created the box with the five Host-data trees writable.
        self.invoke('init')
        self.e.stack()
        for mount in self.add_box_data_mounts()['Mounts']:
            if mount['Destination'] in DATA_TARGETS:
                mount['RW'] = True
        with self.assertRaisesRegex(ValueError, 'writable; it must be read-only'):
            backup.project_services(PROJECT, ('host', 'box'), host_data=True)
        with contextlib.redirect_stderr(io.StringIO()) as notice:
            self.invoke('backup')
        self.assertIn('Run update', notice.getvalue())
        with contextlib.redirect_stderr(io.StringIO()) as notice:
            self.invoke('update')
        self.assertIn('replaces those mounts with read-only ones', notice.getvalue())
        box = self.e.containers[PROJECT+'-box']
        self.assertEqual({m['Destination']: m['RW'] for m in box['Mounts'] if m['Destination'] in DATA_TARGETS},
                         dict.fromkeys(DATA_TARGETS, False))
        self.assertEqual(set(backup.project_services(PROJECT, ('host', 'box'), host_data=True)), {'host', 'box'})
        self.assertEqual(len(list((self.home / 'backups').glob('*/manifest.json'))), 2)
        with contextlib.redirect_stderr(io.StringIO()) as notice:
            self.invoke('backup')
        self.assertNotIn('writable', notice.getvalue())

    def test_a_started_box_with_writable_memory_mounts_fails_the_update(self):
        self.invoke('init')
        self.e.stack()
        command = self.e.docker
        def writable(cmd, **kw):
            result = command(cmd, **kw)
            if cmd[0] == 'compose' and 'up' in cmd:
                for mount in self.e.containers['demo-box']['Mounts']:
                    if mount['Destination'] in DATA_TARGETS:
                        mount['RW'] = True
            return result
        with patch.object(self.e, 'docker', writable), \
             self.assertRaisesRegex(RuntimeError, 'Project services are stopped.*must be read-only'):
            self.invoke('update')
        self.assertTrue(all(c['State']['Status'] == 'exited' for c in self.e.containers.values()))

    def test_fresh_install_and_existing_update_reuse_data(self):
        self.invoke('init')
        self.invoke('up')
        for suffix in ('host-data', 'box-home', 'box-workspace'):
            (self.restored(PROJECT, suffix) / 'payload').write_bytes(suffix.encode())
        self.invoke('update')
        for suffix in ('host-data', 'box-home', 'box-workspace'):
            self.assertEqual((self.restored(PROJECT, suffix) / 'payload').read_bytes(), suffix.encode())
        self.assertEqual(len(list((self.home / 'backups').glob('*/manifest.json'))), 1)


if __name__ == '__main__':
    with contextlib.redirect_stdout(io.StringIO()):
        unittest.main()
