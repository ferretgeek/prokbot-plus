"""Release CLI failure paths, using only temporary synthetic input (no Xcode or device)."""
from pathlib import Path
import json
import os
import plistlib
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile


PATCHER = Path(__file__).resolve().parents[1] / 'release' / 'patch-ios.py'
MANIFEST = PATCHER.parents[1] / 'recipes' / 'ios' / 'manifest.json'


class ReleaseOutput(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='grokbot-ios-release-test-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source = self.root / 'demo.ipa'
        self.output = self.root / 'result'

    def refused(self, reason, patcher=PATCHER):
        before = self.source.read_bytes()
        result = subprocess.run([sys.executable, '-B', str(patcher), '--input', str(self.source),
                                 '--output', str(self.output)], capture_output=True, encoding='utf-8',
                                env={**os.environ, 'PYTHONIOENCODING': 'utf-8'}, timeout=15)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(reason, result.stderr)
        self.assertEqual(self.source.read_bytes(), before)

    def app_metadata(self, version, build, identifier='co.anysphere.sand'):
        with zipfile.ZipFile(self.source, 'w') as archive:
            archive.writestr('Payload/Demo.app/Info.plist', plistlib.dumps({'CFBundleIdentifier': identifier,
                'CFBundleShortVersionString': version, 'CFBundleVersion': build, 'CFBundleExecutable': 'Demo'}))
            archive.writestr('Payload/Demo.app/Demo', b'synthetic, not an executable')

    def test_rejects_wrong_version_build_or_bundle_identifier_independently(self):
        pins = json.loads(MANIFEST.read_text(encoding='utf-8'))
        for version, build, identifier in [(pins['version'] + '.1', pins['build'], 'co.anysphere.sand'),
                                           (pins['version'], pins['build'] + '0', 'co.anysphere.sand'),
                                           (pins['version'], pins['build'], 'dev.fixture.demo')]:
            with self.subTest(version=version, build=build, identifier=identifier):
                self.app_metadata(version, build, identifier)
                self.refused('Unsupported app version')
                self.assertEqual(list(self.root.iterdir()), [self.source])
        self.app_metadata(pins['version'], pins['build'])
        self.refused('Expected thin arm64 executable')
        self.assertEqual(list(self.root.iterdir()), [self.source])

    def test_metadata_gate_and_help_follow_the_packaged_manifest(self):
        # Copy only the release scripts and manifest into an isolated package. No working
        # IPA, patch recipes or native library are supplied: the binary gate must still fail.
        package = self.root / 'fixture-package'
        patcher = package / 'release' / PATCHER.name
        patcher.parent.mkdir(parents=True)
        for name in (PATCHER.name, 'bytepatch.py', 'native_text.py'):
            shutil.copyfile(PATCHER.with_name(name), patcher.with_name(name))
        manifest = package / 'recipes' / 'ios' / 'manifest.json'
        manifest.parent.mkdir(parents=True)
        pins = json.loads(MANIFEST.read_text(encoding='utf-8'))
        pins.update(version='0.0.7', build='9001')
        manifest.write_text(json.dumps(pins), encoding='utf-8')
        self.app_metadata(pins['version'], pins['build'])
        self.refused('Expected thin arm64 executable', patcher)
        help_text = subprocess.check_output([sys.executable, '-B', str(patcher), '--help'], encoding='utf-8',
                                            env={**os.environ, 'PYTHONIOENCODING': 'utf-8'})
        self.assertIn('0.0.7 (9001)', help_text)
        self.assertEqual(set(self.root.iterdir()), {package, self.source})

    def test_invalid_archive_leaves_no_output(self):
        self.source.write_bytes(b'demo, not an archive')
        self.refused('not a zip file')
        self.assertEqual(list(self.root.iterdir()), [self.source])

    def test_unsupported_app_leaves_no_output(self):
        with zipfile.ZipFile(self.source, 'w') as archive:
            archive.writestr('Payload/Demo.app/Info.plist', plistlib.dumps({'CFBundleIdentifier': 'dev.fixture.demo'}))
        self.refused('Unsupported app version')
        self.assertEqual(list(self.root.iterdir()), [self.source])

    def test_existing_output_is_unchanged(self):
        self.source.write_bytes(b'demo')
        self.output.mkdir()
        previous = self.output / 'prior-build'
        previous.write_bytes(b'original')
        self.refused('Output exists')
        self.assertEqual(list(self.output.iterdir()), [previous])
        self.assertEqual(previous.read_bytes(), b'original')
        self.assertEqual(set(self.root.iterdir()), {self.source, self.output})


if __name__ == '__main__':
    unittest.main()
