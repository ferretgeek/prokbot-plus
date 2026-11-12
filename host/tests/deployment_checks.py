import contextlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

HOST = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HOST))
import deploy
import platforms
import backup as volume_backup

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
        with self.assertRaisesRegex(ValueError, 'never overwrites'): self.invoke('init')
        self.assertEqual(env, (self.home / '.env').read_text())
        with patch.object(deploy, 'run') as run: self.invoke('status')
        self.assertIn('mybot', run.call_args.args[0]); self.assertIn(str(deploy.RELEASE / 'compose.host.yaml'), run.call_args.args[0])
        with self.assertRaisesRegex(ValueError, 'Project name conflicts'): self.invoke('--project', 'other', 'status')

    def test_invalid_url_writes_nothing(self):
        for url in ['http://bot/path', 'http://user@bot', 'https://bot:65536', 'http://bot?key=x', 'https://bot:0']:
            with self.assertRaises(ValueError): self.invoke('init', '--public-url', url)
        self.assertFalse((self.home / '.env').exists())

    def test_preflight_failure_is_json(self):
        with patch.object(deploy, 'docker_platform', side_effect=ValueError('unsupported')), contextlib.redirect_stdout(io.StringIO()) as out:
            with self.assertRaises(SystemExit) as failure: deploy.main(self.args + ['doctor'])
            self.assertEqual(failure.exception.code, 1); self.assertFalse(json.loads(out.getvalue())['ok'])

    def test_update_never_switches_after_failure(self):
        self.invoke('--host-only', 'init')
        def fake(cmd, **kw):
            return SimpleNamespace(stdout='grokbot_host-data\n' if 'volume' in cmd else '')
        for failed in ('backup', 'build'):
            with patch.object(deploy, 'service_images', return_value={'host': {'image': 'local'}}), \
                 patch.object(deploy, 'run', side_effect=fake) as run, patch.object(deploy, 'backup') as backup, patch.object(deploy, 'build') as build:
                (backup if failed == 'backup' else build).side_effect = subprocess.CalledProcessError(1, failed)
                with self.assertRaises(subprocess.CalledProcessError): self.invoke('update')
                backup.assert_called_once()
                if failed == 'backup': build.assert_not_called()
                self.assertFalse(any('up' in call.args[0] for call in run.call_args_list))

    def test_wrong_volumes_never_change_instance(self):
        self.invoke('--host-only', 'init')
        for action, owned, all_names in [('up', {'grokbot_host-data'}, 'grokbot_host-data'), ('up', set(), 'grokbot_host-data'),
                                         ('update', {'grokbot_box-home'}, 'grokbot_box-home')]:
            with patch.object(deploy, 'project_volumes', return_value=owned), patch.object(deploy, 'run', return_value=SimpleNamespace(stdout=all_names)), \
                 patch.object(deploy, 'service_images', return_value={'host': {'image': 'local'}}), patch.object(deploy, 'build') as build:
                with self.assertRaises(ValueError): self.invoke(action)
                build.assert_not_called()

    def test_resume_attempts_every_paused_container(self):
        def output(*args):
            return 'demo_host-data' if args[0] == 'volume' else 'first\nsecond' if args[0] == 'ps' else 'false'
        def run(*args, **kwargs):
            if args == ('unpause', 'second'):
                raise subprocess.CalledProcessError(1, 'unpause')
        with patch.object(volume_backup, 'output', side_effect=output), patch.object(volume_backup, 'run', side_effect=run) as called:
            with self.assertRaisesRegex(RuntimeError, 'second'): volume_backup.backup('demo', self.home / 'backup', 'local')
            self.assertEqual([c.args[1] for c in called.call_args_list if c.args[0] == 'unpause'], ['second', 'first'])
            self.assertFalse((self.home / 'backup/manifest.json').exists())

    def test_archive_flags_keep_pinned_build_path(self):
        archive = self.home / 'original.tgz'; archive.touch()
        args = SimpleNamespace(host_only=True, host_archive=archive, box_archive=None)
        with patch.object(deploy, 'run') as called: deploy.build(args, 'candidate')
        self.assertEqual(called.call_args.args[0][-3:], ['--host-only', '--host-archive', str(archive.resolve())])


if __name__ == '__main__':
    unittest.main()
