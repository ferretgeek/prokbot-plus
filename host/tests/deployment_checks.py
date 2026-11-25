import contextlib
import importlib.util
import io
import json
from pathlib import Path
import re
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

HOST = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HOST))
import deploy
import backup
import platforms

spec = importlib.util.spec_from_file_location('builder', HOST / 'release/build-docker.py')
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.home = Path(temp.name)
        self.args = ['--home', str(self.home)]

    def invoke(self, *args):
        with contextlib.redirect_stdout(io.StringIO()) as out:
            deploy.main(self.args + list(args))
        return out.getvalue()

    def test_platforms(self):
        for arch in ('amd64', 'x86_64', 'arm64', 'aarch64'):
            self.assertEqual(platforms.host_platform('Linux', arch), 'linux/' + ('arm64' if arch in ('arm64', 'aarch64') else 'amd64'))
        for os_name, arch in [('windows', 'amd64'), ('linux', 'armv7l')]:
            with self.assertRaises(ValueError): platforms.host_platform(os_name, arch)

    def test_runtime_matrix(self):
        for mode in (True, False):
            self.assertEqual(builder.choose_runtime('linux/amd64', mode), (platforms.BOX['localTag'], True))
            image, needs_box = builder.choose_runtime('linux/arm64', mode)
            self.assertNotEqual(image, platforms.BOX['localTag']); self.assertEqual(needs_box, not mode)

    def test_arm_probe_precedes_download(self):
        with patch.object(sys, 'argv', ['build']), patch.object(builder, 'docker_platform', return_value='linux/arm64'), \
             patch.object(builder, 'check_box_execution', side_effect=ValueError('no emulator')), patch.object(builder, 'prepare_box') as box:
            with self.assertRaisesRegex(ValueError, 'no emulator'): builder.main()
            box.assert_not_called()

    def test_arm_remote_skips_box_and_emulator(self):
        with patch.object(sys, 'argv', ['build', '--host-only', '--host-archive', str(self.home / 'missing')]), \
             patch.object(builder, 'docker_platform', return_value='linux/arm64'), patch.object(builder, 'check_box_execution') as probe, \
             patch.object(builder, 'prepare_box') as box:
            with self.assertRaises(FileNotFoundError): builder.main()
            box.assert_not_called(); probe.assert_not_called()

    def test_init_once_and_mode(self):
        self.invoke('--host-only', '--project', 'mybot', 'init', '--listen', '::1', '--public-url', 'http://[::1]:18080')
        env = (self.home / '.env').read_text()
        self.assertIn('GROKBOT_LISTEN_ADDRESS=[::1]', env)
        with self.assertRaisesRegex(ValueError, 'never overwrites'):
            self.invoke('init')
        self.assertEqual(env, (self.home / '.env').read_text())
        with patch.object(deploy, 'run') as run: self.invoke('status')
        self.assertIn('mybot', run.call_args.args[0]); self.assertIn(str(deploy.RELEASE / 'compose.host.yaml'), run.call_args.args[0])
        with self.assertRaisesRegex(ValueError, 'Project name conflicts'): self.invoke('--project', 'other', 'status')

    def env(self):
        return dict(line.split('=', 1) for line in (self.home / '.env').read_text().splitlines())

    def test_init_gives_the_web_client_its_own_port_and_address(self):
        created = json.loads(self.invoke('init'))
        self.assertEqual(self.env()['GROKBOT_WEB_PUBLIC_PORT'], '18081')
        self.assertNotIn('GROKBOT_WEB_PUBLIC_URL', self.env())
        self.assertEqual(created['webClientUrl'], 'http://127.0.0.1:18081/web/')
        (self.home / '.env').unlink()
        # A second instance on another port gets the next port for its web client.
        self.invoke('init', '--port', '18082')
        self.assertEqual(self.env()['GROKBOT_WEB_PUBLIC_PORT'], '18083')
        (self.home / '.env').unlink()
        created = json.loads(self.invoke('init', '--listen', '0.0.0.0', '--public-url', 'https://bot.example.org',
                                         '--web-public-url', 'https://web.bot.example.org/'))
        self.assertEqual(self.env()['GROKBOT_WEB_PUBLIC_URL'], 'https://web.bot.example.org')
        self.assertEqual(created['webClientUrl'], 'https://web.bot.example.org/web/')

    def test_init_refuses_a_web_client_on_the_admin_origin(self):
        for flags in (['--web-port', '18080'], ['--web-port', '0'], ['--port', '65535'],
                      ['--public-url', 'https://bot.example.org', '--web-public-url', 'https://BOT.example.org:443'],
                      ['--public-url', 'https://bot.example.org', '--web-port', '443'],
                      ['--web-public-url', 'https://web.example.org/web']):
            with self.subTest(flags=flags), self.assertRaises(ValueError):
                self.invoke('init', *flags)
        self.assertFalse((self.home / '.env').exists())

    def test_web_client_address_of_an_instance_from_an_earlier_release(self):
        # .env files written before 1.15.0 have neither web setting: the main host name with 18081.
        (self.home / '.env').write_text('GROKBOT_LISTEN_ADDRESS=192.0.2.10\nGROKBOT_PUBLIC_PORT=18080\n'
                                        'GROKBOT_PUBLIC_URL=http://192.0.2.10:18080\nPROKBOT_MODE=local\n')
        with patch.dict('os.environ', {}):
            for key in deploy.WEB_SETTINGS:
                deploy.os.environ.pop(key, None)
            self.assertEqual(deploy.web_client_url(deploy.instance_env(self.home)), 'http://192.0.2.10:18081/web/')
            with contextlib.redirect_stderr(io.StringIO()) as notice:
                deploy.web_notice(self.home)
            self.assertIn('http://192.0.2.10:18081/web/', notice.getvalue())
            self.assertNotIn('reverse proxy', notice.getvalue())
            deploy.os.environ['GROKBOT_WEB_PUBLIC_URL'] = 'https://web.example.org'
            self.assertEqual(deploy.web_client_url(deploy.instance_env(self.home)), 'https://web.example.org/web/')
            del deploy.os.environ['GROKBOT_WEB_PUBLIC_URL']
            (self.home / '.env').write_text('GROKBOT_PUBLIC_URL="https://bot.example.org"\n')
            with contextlib.redirect_stderr(io.StringIO()) as notice:
                deploy.web_notice(self.home)
            self.assertIn('https://bot.example.org:18081/web/', notice.getvalue())
            self.assertIn('GROKBOT_WEB_PUBLIC_URL', notice.getvalue())
            deploy.check_web_address(self.home)
            # A hand-edited web client URL equal to the admin URL is refused before an update stops anything.
            (self.home / '.env').write_text('GROKBOT_PUBLIC_URL=https://bot.example.org\n'
                                            "GROKBOT_WEB_PUBLIC_URL='https://BOT.example.org:443/'\n")
            with self.assertRaisesRegex(ValueError, 'must differ from GROKBOT_PUBLIC_URL'):
                deploy.check_web_address(self.home)
            (self.home / '.env').write_text('GROKBOT_PUBLIC_URL=https://bot.example.org\n'
                                            'GROKBOT_WEB_PUBLIC_URL=https://web.bot.example.org\n')
            deploy.check_web_address(self.home)

    def test_ports_published_by_another_instance_are_refused_before_anything_changes(self):
        config = {'services': {'host': {'ports': [{'published': '18080', 'target': 8000},
                                                  {'published': '18081', 'target': 8001}]}, 'box': {}}}
        def docker(cmd, **kwargs):
            if cmd[-3:] == ['config', '--format', 'json']:
                return SimpleNamespace(stdout=json.dumps(config))
            if cmd[:2] == ['docker', 'ps']:
                return SimpleNamespace(stdout='other\n' if cmd[-1] == 'publish=18081' else 'own\n')
            raise AssertionError(cmd)
        with patch.object(deploy, 'run', side_effect=docker), \
             patch.object(deploy.volume_backup, 'project_ids', return_value=['own']):
            with self.assertRaisesRegex(ValueError, 'Port 18081 of host is already published'):
                deploy.check_free_ports(['docker', 'compose'], 'demo', True)
            config['services']['host']['ports'].pop()
            deploy.check_free_ports(['docker', 'compose'], 'demo', True)
            # An earlier instance on --port 18081 collides with the default web client port of its own.
            config['services']['host']['ports'] = [{'published': '18081', 'target': 8000},
                                                   {'published': '18081', 'target': 8001}]
            with self.assertRaisesRegex(ValueError, 'Port 18081 is published twice'):
                deploy.check_free_ports(['docker', 'compose'], 'demo', True)

    def test_invalid_url_writes_nothing(self):
        for url in ['http://bot/path', 'http://user@bot', 'https://bot:65536', 'http://bot?key=x', 'https://bot:0']:
            with self.assertRaises(ValueError): self.invoke('init', '--public-url', url)
        self.assertFalse((self.home / '.env').exists())

    def test_preflight_failure_is_json(self):
        with patch.object(deploy, 'docker_platform', side_effect=ValueError('unsupported')), contextlib.redirect_stdout(io.StringIO()) as out:
            with self.assertRaises(SystemExit) as failure: deploy.main(self.args + ['doctor'])
            self.assertEqual(failure.exception.code, 1); self.assertFalse(json.loads(out.getvalue())['ok'])

    def test_archive_flags_keep_pinned_build_path(self):
        archive = self.home / 'original.tgz'; archive.touch()
        args = SimpleNamespace(host_only=True, host_archive=archive, box_archive=None)
        with patch.object(deploy, 'run') as called: deploy.build(args, 'candidate')
        self.assertEqual(called.call_args.args[0][-3:], ['--host-only', '--host-archive', str(archive.resolve())])

    def test_runtime_versions_require_subpath_capable_engine_and_compose(self):
        def versions(server, compose='2.26.0'):
            def run(cmd, **kwargs):
                if cmd[1] == 'version':
                    return SimpleNamespace(stdout=json.dumps(server))
                self.assertEqual(cmd, ['docker', 'compose', 'version', '--short'])
                return SimpleNamespace(stdout=compose)
            return run

        server = {'Version': '26.0.0', 'ApiVersion': '1.45'}
        with patch.object(deploy, 'run', side_effect=versions(server)):
            self.assertEqual(deploy.check_runtime_versions(), {
                'dockerEngineVersion': '26.0.0', 'dockerApiVersion': '1.45', 'composeVersion': '2.26.0'})
        ubuntu = {'Version': '26.1.5+dfsg1', 'ApiVersion': '1.45'}
        with patch.object(deploy, 'run', side_effect=versions(ubuntu, '2.40.3+ds1-0ubuntu1~24.04.1')):
            self.assertEqual(deploy.check_runtime_versions()['composeVersion'], '2.40.3')
        for old_server, old_compose, message in [
            ({'Version': '25.0.9', 'ApiVersion': '1.44'}, '2.26.0', 'Docker Engine 25.0.9 is too old'),
            ({'Version': '26.0.0', 'ApiVersion': '1.44'}, '2.26.0', 'Docker API 1.44.0 is too old'),
            (server, '2.25.0', 'Docker Compose 2.25.0 is too old'),
            (server, '2.25.0+ds1-0ubuntu1~22.04.1', 'Docker Compose 2.25.0 is too old'),
            (server, 'dev', 'usable Compose version'),
        ]:
            with self.subTest(message=message), patch.object(deploy, 'run', side_effect=versions(old_server, old_compose)):
                with self.assertRaisesRegex(ValueError, message):
                    deploy.check_runtime_versions()

    def test_memory_overlay_is_added_only_when_docker_supports_subpath(self):
        with patch.object(deploy, 'check_runtime_versions', side_effect=AssertionError('init needs no Docker')):
            self.invoke('init')
        for supported in (False, True):
            gate = ({'return_value': {}} if supported else
                    {'side_effect': ValueError('Docker Engine 24.0.2 is too old')})
            for action in (['up'], ['update'], ['recover', '--directory', str(self.home)]):
                with self.subTest(supported=supported, action=action[0]), \
                     patch.object(deploy, 'check_runtime_versions', **gate), \
                     patch.object(deploy, 'operate') as operate, \
                     patch.object(deploy.volume_backup, 'project_lock', return_value=contextlib.nullcontext()), \
                     contextlib.redirect_stderr(io.StringIO()) as notice:
                    self.invoke(*action)
                    dc = operate.call_args.args[2]
                    self.assertIn(str(deploy.RELEASE / 'compose.yaml'), dc)
                    self.assertEqual(deploy.memory_overlay(dc), supported)
                    self.assertEqual('stays off' in notice.getvalue(), not supported)
        with patch.object(deploy, 'check_runtime_versions') as gate, patch.object(deploy, 'run') as run:
            self.invoke('status')
        gate.assert_not_called()
        self.assertFalse(deploy.memory_overlay(run.call_args.args[0]))

    def test_host_only_skips_subpath_runtime_gate(self):
        with patch.object(deploy, 'check_runtime_versions', side_effect=ValueError('runtime too old')) as gate:
            self.invoke('--host-only', 'init')
            with patch.object(deploy, 'operate') as operate, \
                 patch.object(deploy.volume_backup, 'project_lock', return_value=contextlib.nullcontext()):
                self.invoke('--host-only', 'update')
            operate.assert_called_once()
            self.assertFalse(deploy.memory_overlay(operate.call_args.args[2]))
            gate.assert_not_called()
        self.assertIn('PROKBOT_MODE=remote', (self.home / '.env').read_text())


class ComposeFileTests(unittest.TestCase):
    release = HOST / 'release'

    def overlay_mounts(self):
        # A reader for the block-style mount list this overlay uses; PyYAML is not a test dependency.
        lines = deploy.MEMORY_COMPOSE.read_text(encoding='utf-8').splitlines()
        start = lines.index('    volumes:', lines.index('  box:'))
        mounts = []
        for line in lines[start + 1:]:
            if not line.strip() or line.strip().startswith('#'):
                continue
            if not line.startswith('      '):
                break
            dash, key, value = re.fullmatch(r'\s+(- )?(\w+): (.+)', line).groups()
            if dash:
                mounts.append({})
            flow = re.fullmatch(r'\{ (\w+): (\S+) \}', value)
            mounts[-1][key] = {flow[1]: flow[2]} if flow else value
        return mounts

    def test_default_compose_files_never_mount_host_data_into_the_desktop(self):
        for name in ('compose.yaml', 'compose.host.yaml', 'compose.execution.yaml'):
            with self.subTest(name=name):
                text = (self.release / name).read_text(encoding='utf-8')
                self.assertNotIn('subpath', text)
                self.assertNotIn('/data/runtime', text)
                self.assertNotIn('GROKBOT_HOST_MEMORY_MOUNTS', text)
        box = (self.release / 'compose.yaml').read_text(encoding='utf-8').split('\n  box:\n', 1)[1].split('\nvolumes:', 1)[0]
        self.assertNotIn('host-data', box)

    def test_overlay_mounts_exactly_the_five_trees_read_only(self):
        mounts = self.overlay_mounts()
        self.assertEqual([m['target'] for m in mounts], list(backup.BOX_DATA_TARGETS))
        for mount in mounts:
            tree = backup.BOX_DATA_TARGETS[mount['target']]
            self.assertEqual(mount, {'type': 'volume', 'source': 'host-data', 'target': mount['target'], 'read_only': 'true',
                                     'volume': {'subpath': str(backup.DATA_SOURCE_ROOT / tree)}})
        self.assertIn('      GROKBOT_HOST_MEMORY_MOUNTS: "1"', deploy.MEMORY_COMPOSE.read_text(encoding='utf-8'))


class ComposeMountTests(unittest.TestCase):
    dc = ['docker', 'compose', '-p', 'demo']
    memory_dc = dc + ['-f', str(deploy.MEMORY_COMPOSE)]
    image_id = 'sha256:' + '1' * 64

    @staticmethod
    def config(existing=False, box=False, memory=False):
        specs = {'host': ('host:local', [('host-data', '/data')])}
        if box:
            specs['box'] = (deploy.BOX['localTag'], [('box-home', '/home/box'), ('box-workspace', '/workspace')])
        services, volumes = {}, {}
        for service, (image, pairs) in specs.items():
            services[service] = {'image': image, 'volumes': [
                {'type': 'volume', 'source': name, 'target': dest} for name, dest in pairs]}
            if service == 'box' and memory:
                services[service]['volumes'].extend(
                    {'type': 'volume', 'source': 'host-data', 'target': target, 'read_only': True,
                     'volume': {'subpath': str(backup.DATA_SOURCE_ROOT / tree)}}
                    for target, tree in backup.BOX_DATA_TARGETS.items())
            for name, _ in pairs:
                volumes[name] = {'name': 'demo_' + name}
                if existing:
                    volumes[name]['external'] = True
        return {'services': services, 'volumes': volumes}

    @contextlib.contextmanager
    def config_only(self, config, existing, pinned=None, dc=None):
        def read(cmd, **kwargs):
            self.assertEqual(cmd, (dc or self.dc) + ['config', '--format', 'json'])
            self.assertTrue(kwargs['capture'])
            env = kwargs['env']
            self.assertEqual(env['PROKBOT_EXISTING_VOLUMES'], 'true' if existing else 'false')
            for service, image in (pinned or {}).items():
                self.assertEqual(env['GROKBOT_' + service.upper() + '_IMAGE'], image)
            return SimpleNamespace(stdout=json.dumps(config))

        with patch.object(deploy, 'run', side_effect=read) as run, \
             patch('subprocess.Popen', side_effect=AssertionError('Unexpected external process')):
            try:
                yield
            finally:
                run.assert_called_once()

    def images(self, config, existing=False, memory=False):
        dc = self.memory_dc if memory else self.dc
        with self.config_only(config, existing, dc=dc):
            return deploy.instance_images(dc, 'demo', tuple(config['services']), existing)

    def test_supported_mounts_and_non_overlapping_tmpfs(self):
        for box, memory in ((False, False), (True, False), (True, True)):
            for existing in (False, True):
                with self.subTest(box=box, memory=memory, existing=existing):
                    config = self.config(existing, box, memory)
                    services = config['services']
                    images = {s: v['image'] for s, v in services.items()}
                    self.assertEqual(self.images(config, existing, memory), images)
                    services['host']['volumes'].insert(0, {'type': 'tmpfs', 'target': '/database'})
                    services['host']['tmpfs'] = '/run:mode=0700'
                    if box:
                        services['box']['volumes'].reverse()
                        services['box']['tmpfs'] = ['/home/box-old', '/run:mode=0700']
                    self.assertEqual(self.images(config, existing, memory), images)

    def test_memory_mounts_follow_the_overlay_and_stay_read_only(self):
        for config_memory, dc_memory in ((True, False), (False, True)):
            with self.subTest(config=config_memory, overlay=dc_memory):
                with self.assertRaisesRegex(ValueError, 'do not match the selected Compose files'):
                    self.images(self.config(box=True, memory=config_memory), memory=dc_memory)
        target = '/data/runtime/host-data/agents'
        for change in ({'read_only': False}, {'read_only': None}, {'volume': {'subpath': 'runtime/host-data'}},
                       {'volume': {}}, {'source': 'box-home'}):
            with self.subTest(change=change):
                config = self.config(box=True, memory=True)
                mount = next(m for m in config['services']['box']['volumes'] if m['target'] == target)
                mount.update(change)
                with self.assertRaisesRegex(ValueError, 'read-only mount of the approved Host-data tree'):
                    self.images(config, memory=True)

    def test_rejects_extra_duplicate_and_shadowing_mounts(self):
        cases = [('host', 'bind', '/fixture', '/logs'), ('host', 'volume', 'extra', '/logs'),
                 ('host', 'volume', None, '/scratch'), ('host', 'volume', 'host-data', '/copy'),
                 ('host', 'volume', 'host-data', '/data'), ('host', 'bind', '/fixture', '/data'),
                 ('host', 'volume', 'extra', '/data/uploads'), ('box', 'bind', '/fixture', '/workspace/logs'),
                 ('box', 'bind', '/fixture', '/home/box/sand-data/agents'),
                 ('box', 'volume', 'host-data', '/data/runtime/host-data/agent-transcripts'),
                 ('host', 'tmpfs', None, '/'), ('box', 'tmpfs', None, '/home'),
                 ('host', 'tmpfs', None, '//data/.'), ('host', 'tmpfs', None, '/scratch/../data/cache')]
        for (service, kind, source, target), memory in ((case, memory) for case in cases for memory in (False, True)):
            with self.subTest(service=service, kind=kind, target=target, memory=memory):
                config = self.config(box=True, memory=memory)
                mount = {'type': kind, 'target': target}
                if source is not None:
                    mount['source'] = source
                if source == 'extra':
                    config['volumes'][source] = {'name': 'demo_extra'}
                config['services'][service]['volumes'].append(mount)
                with self.assertRaisesRegex(ValueError, service):
                    self.images(config, memory=memory)

    def test_checks_mounts_outside_service_volumes_list(self):
        for key, value in [('tmpfs', '/data:mode=0700'), ('tmpfs', ['/data/cache:size=64k']),
                           ('tmpfs', ['/run/.:mode=0700']), ('volumes_from', ['container:peer']),
                           ('configs', [{'source': 'cfg', 'target': '/data/cfg'}]),
                           ('secrets', [{'source': 'key'}]), ('use_api_socket', True)]:
            with self.subTest(key=key, value=value):
                config = self.config()
                config['services']['host']['volumes'].append({'type': 'tmpfs', 'target': '/run'})
                config['services']['host'][key] = value
                if key in ('configs', 'secrets'):
                    config[key] = {value[0]['source']: {'file': '/fixture'}}
                with self.assertRaisesRegex(ValueError, 'host'):
                    self.images(config)

    def test_required_volume_is_still_exact_and_writable(self):
        for mount, volume in [(None, {}), ({'source': 'other'}, {}), ({'read_only': True}, {}),
                              ({'type': 'tmpfs'}, {}), ({}, {'name': 'other_host-data'}), ({}, {'external': True})]:
            with self.subTest(mount=mount, volume=volume):
                config = self.config()
                mounts = config['services']['host']['volumes']
                if mount is None:
                    mounts.clear()
                else:
                    mounts[0].update(mount)
                config['volumes']['host-data'].update(volume)
                with self.assertRaisesRegex(ValueError, '/data'):
                    self.images(config)

    def test_existing_volume_subdirectory_is_not_the_managed_data_root(self):
        for service, expected in [('host', '/data'), ('box', '/home/box')]:
            with self.subTest(service=service):
                config = self.config(existing=True, box=True)
                mount = config['services'][service]['volumes'][0]
                mount['volume'] = {'nocopy': True}
                self.assertIn(service, self.images(config, existing=True))
                mount['volume']['subpath'] = 'other-instance'
                with self.assertRaisesRegex(ValueError, expected):
                    self.images(config, existing=True)

    def test_new_install_and_update_reject_before_inventory(self):
        for action in ('up', 'update'):
            with self.subTest(action=action):
                existing = action == 'update'
                config = self.config(existing)
                config['services']['host']['tmpfs'] = ['/data/cache']
                args = SimpleNamespace(action=action, host_only=True, project='demo')
                with self.config_only(config, existing), patch.object(deploy, 'inventory') as inventory:
                    with self.assertRaisesRegex(ValueError, '/data/cache'):
                        deploy.operate(args, None, self.dc)
                    inventory.assert_not_called()

    def test_last_preflight_rejects_before_compose_up(self):
        images = {'host': self.image_id}
        for existing in (False, True):
            with self.subTest(existing=existing):
                config = self.config(existing)
                config['services']['host'].update(image=self.image_id, tmpfs=['/data/cache'])
                with self.config_only(config, existing, images), self.assertRaisesRegex(ValueError, '/data/cache'):
                    deploy.up_and_wait(self.dc, 'demo', ('host',), images, existing=existing)

    def test_post_build_preflight_rejects_before_stop_or_backup(self):
        config = self.config(existing=True)
        config['services']['host']['tmpfs'] = ['/data/cache']
        old = {'host': {'Id': 'original', 'Image': self.image_id, 'State': {'Status': 'running'}}}
        staged = contextlib.nullcontext({'host': 'sha256:' + '2' * 64})
        with self.config_only(config, True), patch.object(deploy, 'tag_state', return_value=self.image_id), \
             patch.object(deploy, 'image_id', return_value=self.image_id), patch.object(deploy, 'staged_host', return_value=staged), \
             patch.object(deploy, 'inventory', return_value=old), patch.object(deploy, 'backup') as backup:
            with self.assertRaisesRegex(ValueError, '/data/cache'):
                deploy.upgrade(SimpleNamespace(project='demo'), None, self.dc, ('host',), 'host:local', old, 'demo', False)
            backup.assert_not_called()

    def test_recovery_preflight_rejects_before_writing_volumes(self):
        config = self.config(existing=True)
        config['services']['host'].update(image=self.image_id, tmpfs=['/data/cache'])
        images = {'host': self.image_id}
        manifest = {'project': 'original', 'serviceImages': images, 'volumes': [{'suffix': 'host-data'}]}
        args = SimpleNamespace(project='demo', directory=Mock(spec=Path))
        with self.config_only(config, True, images), patch.object(deploy.volume_backup, 'read_manifest', return_value=manifest), \
             patch.object(deploy, 'image_id', return_value=self.image_id), patch.object(deploy, 'check_platform'), \
             patch.object(deploy.volume_backup, 'restore') as restore:
            with self.assertRaisesRegex(ValueError, '/data/cache'):
                deploy.recover(args, None, self.dc, ('host',))
            restore.assert_not_called()


if __name__ == '__main__':
    unittest.main()
