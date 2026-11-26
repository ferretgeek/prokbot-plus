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

    def test_accepts_pinned_fallback_release_and_enforces_per_release_extensions(self):
        for rel_dir, expected_pair in (
            ('1.27.0', ('1.27.0', '29519')),
            ('1.26.0', ('1.26.0', '29388')),
            ('1.16.0', ('1.16.0', '23152')),
        ):
            fallback_manifest = MANIFEST.parent / rel_dir / 'manifest.json'
            self.assertTrue(fallback_manifest.is_file(), f'{rel_dir} fallback manifest must remain pinned')
            fallback = json.loads(fallback_manifest.read_text(encoding='utf-8'))
            self.assertEqual((fallback['version'], fallback['build']), expected_pair)
            self.app_metadata(fallback['version'], fallback['build'])
            self.refused('Expected thin arm64 executable')
            self.app_metadata(fallback['version'], fallback['build'] + '9')
            self.refused('Unsupported app version')
        sys.path.insert(0, str(PATCHER.parents[1] / 'patchers' / 'ios'))
        import extensions  # noqa: E402
        self.assertIn(('1.28.0', '29649'), extensions.EXTENSIONS_BY_RELEASE)
        self.assertIn(('1.27.0', '29519'), extensions.EXTENSIONS_BY_RELEASE)
        self.assertIn(('1.26.0', '29388'), extensions.EXTENSIONS_BY_RELEASE)
        self.assertIn(('1.16.0', '23152'), extensions.EXTENSIONS_BY_RELEASE)
        self.assertEqual(extensions.WIDGETS_SCHEME_COUNTS_BY_RELEASE[('1.28.0', '29649')], 2)
        self.assertEqual(extensions.WIDGETS_SCHEME_COUNTS_BY_RELEASE[('1.27.0', '29519')], 2)
        self.assertEqual(extensions.WIDGETS_SCHEME_COUNTS_BY_RELEASE[('1.26.0', '29388')], 1)
        self.assertEqual(extensions.WIDGETS_SCHEME_COUNTS_BY_RELEASE[('1.16.0', '23152')], 1)
        self.assertNotEqual(
            extensions.EXTENSIONS_BY_RELEASE[('1.28.0', '29649')]['Widgets.appex'][1],
            extensions.EXTENSIONS_BY_RELEASE[('1.27.0', '29519')]['Widgets.appex'][1],
        )
        self.assertNotEqual(
            extensions.EXTENSIONS_BY_RELEASE[('1.27.0', '29519')]['Widgets.appex'][1],
            extensions.EXTENSIONS_BY_RELEASE[('1.26.0', '29388')]['Widgets.appex'][1],
        )
        self.assertNotEqual(
            extensions.EXTENSIONS_BY_RELEASE[('1.26.0', '29388')]['Widgets.appex'][1],
            extensions.EXTENSIONS_BY_RELEASE[('1.16.0', '23152')]['Widgets.appex'][1],
        )

    def test_extensions_rejects_unknown_release(self):
        sys.path.insert(0, str(PATCHER.parents[1] / 'patchers' / 'ios'))
        import extensions  # noqa: E402
        # Unknown releases must fail closed rather than defaulting widget scheme count to 1.
        with self.assertRaisesRegex(ValueError, 'Unsupported release for extensions'):
            extensions.prepare_extensions(
                self.root,
                'dev.example.app',
                'group.dev.example.app',
                lambda _b: [],
                release=('9.9.9', '99999'),
            )

    def test_rejects_duplicate_pinned_manifests(self):
        # Duplicate (version, build) manifests must be rejected by load_manifests().
        dup_pkg = self.root / 'dup-package'
        dup_patcher = dup_pkg / 'release' / PATCHER.name
        dup_patcher.parent.mkdir(parents=True)
        for name in (PATCHER.name, 'bytepatch.py', 'native_text.py'):
            shutil.copyfile(PATCHER.with_name(name), dup_patcher.with_name(name))
        dup_primary = dup_pkg / 'recipes' / 'ios' / 'manifest.json'
        dup_fallback = dup_pkg / 'recipes' / 'ios' / 'dup' / 'manifest.json'
        dup_fallback.parent.mkdir(parents=True)
        pins = json.loads(MANIFEST.read_text(encoding='utf-8'))
        dup_primary.write_text(json.dumps(pins), encoding='utf-8')
        dup_fallback.write_text(json.dumps(pins), encoding='utf-8')
        self.app_metadata(pins['version'], pins['build'])
        self.refused('Duplicate fixed iOS release', dup_patcher)

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

    def test_private_patch_helper_uses_the_packaged_manifest(self):
        helper = PATCHER.parents[1] / 'patchers' / 'ios' / 'patch-app.py'
        source = helper.read_text(encoding='utf-8')
        self.assertIn("ROOT/'recipes/ios/manifest.json'", source)
        self.assertNotIn("--expect-version", source)
        self.assertNotIn("--expect-build", source)

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
