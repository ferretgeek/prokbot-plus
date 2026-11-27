import hashlib
import io
import importlib.util
import json
import base64
import os
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'release'))
import bytepatch

PATCH_HOST = Path(__file__).resolve().parents[1] / 'release' / 'patch-host.py'
PATCH_HOST_SPEC = importlib.util.spec_from_file_location('patch_host', PATCH_HOST)
patch_host = importlib.util.module_from_spec(PATCH_HOST_SPEC)
PATCH_HOST_SPEC.loader.exec_module(patch_host)


def pinned_host_archive():
    configured = os.environ.get('PROKBOT_TEST_HOST_ARCHIVE')
    candidates = [Path(configured).expanduser()] if configured else [
        Path(__file__).resolve().parents[2] / 'inputs' / 'host' / 'sand-host-bundle-d0a4baa.tgz',
    ]
    for path in candidates:
        if path.is_file() and bytepatch.file_digest(path) == 'b03894dc9a29eadc6ee1b7265424fe5695d77c5af0cdc022f27338cd69f73d0f':
            with tarfile.open(path, 'r:gz') as archive:
                member = archive.extractfile('sand-host/host-main.cjs')
                if member is None:
                    raise ValueError('Pinned Host archive has no sand-host/host-main.cjs')
                return member.read()
    return None


class PinnedPatchTests(unittest.TestCase):
    def setUp(self):
        self.raw = bytes(range(256)) * 8
        self.target = self.raw[:300] + b'project addition' + self.raw[500:]
        self.recipe = bytepatch.create(self.raw, self.target)

    def test_many_targets_share_one_source_hash_but_each_recipe_checks_its_pin(self):
        with patch.object(bytepatch, 'digest', wraps=bytepatch.digest) as fingerprint:
            source = bytepatch.PatchSource(self.raw)
            for _ in range(3):
                output = io.BytesIO()
                source.write_verified(self.recipe, output)
                self.assertEqual(output.getvalue(), self.target)
            self.assertEqual(sum(call.args == (self.raw,) for call in fingerprint.call_args_list), 1)
        for changed in ({'sourceSha256': '0' * 64}, {'sourceBytes': 2}, {'targetSha256': '0' * 64},
                        {'targetBytes': 1}, {'ops': [['copy', 0, len(self.raw) + 1]]}):
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                source.write_verified({**self.recipe, **changed}, io.BytesIO())

    def test_cached_source_cannot_be_changed_after_verification(self):
        buf = bytearray(self.raw)
        source = bytepatch.PatchSource(buf)
        buf[0] ^= 1
        output = io.BytesIO()
        source.write_verified(self.recipe, output)
        self.assertEqual(output.getvalue(), self.target)

    def test_archive_digest_does_not_load_the_entire_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'input.bin'
            data = self.raw * 2048
            path.write_bytes(data)
            with patch.object(Path, 'read_bytes', side_effect=AssertionError('unbounded file read')):
                self.assertEqual(bytepatch.file_digest(path), hashlib.sha256(data).hexdigest())

    def test_reliability_manifest_checks_generated_file_digests(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp) / 'release-reliability'
            directory.mkdir()
            content = b'prepared output'
            (directory / 'module.mjs').write_bytes(content)
            manifest = {
                'digest': 'a' * 64,
                'files': [{'name': 'module.mjs', 'sha256': hashlib.sha256(content).hexdigest()}],
            }
            (directory / 'manifest.json').write_text(json.dumps(manifest))
            patch_host.verify_reliability_manifest(Path(tmp))
            (directory / 'module.mjs').write_bytes(b'changed output')
            with self.assertRaisesRegex(ValueError, 'Prepared reliability manifest mismatch: module.mjs'):
                patch_host.verify_reliability_manifest(Path(tmp))

    def test_tool_stream_recipe_waits_for_both_error_branches(self):
        recipe = bytepatch.load(Path(__file__).resolve().parents[1] / 'recipes' / 'host' /
                                'release-reliability__engine-tool-stream-executor.mjs.gbp.gz')
        additions = b''.join(base64.b64decode(operation[1]) for operation in recipe['ops'] if operation[0] == 'add')
        self.assertIn(b'await Promise.allSettled([stream1.throw(e), stream22.close()]', additions)
        self.assertIn(b'.catch(() => interactionHandler.invocationId)', additions)

    def test_bot_id_injection_applies_to_the_complete_pinned_harness_target(self):
        source = pinned_host_archive()
        if source is None:
            self.skipTest('set PROKBOT_TEST_HOST_ARCHIVE to run the pinned Host recipe check')
        # Since upstream 684e1ba the stable copy is the unmodified recovered
        # harness again; the release-reliability copy the Host loads injects the Bot ID.
        expected = {
            'recovered-core__stable__harness-turn-run-shell.mjs.gbp.gz': (
                '0d545b121d648ae63b263384d5bcc80f8ff7bc1858d5b863a588145089a5d70e', 762, ()),
            'release-reliability__harness-turn-run-shell.mjs.gbp.gz': (
                'b402f015e19eae49b730ae202bd6dae3ddd16cc26f82b308a15fef87d13a48bd', 776, (421, 453)),
        }
        recipes = Path(__file__).resolve().parents[1] / 'recipes' / 'host'
        for name, (digest, lines, positions) in expected.items():
            with self.subTest(recipe=name):
                target = bytepatch.apply(source, bytepatch.load(recipes / name))
                self.assertEqual(bytepatch.digest(target), digest)
                target_lines = target.splitlines()
                self.assertEqual(len(target_lines), lines)
                found = tuple(index + 1 for index, line in enumerate(target_lines)
                              if b'agentId: host.getConversationId()' in line)
                self.assertEqual(found, positions)

    def test_prompt_tools_recovery_plan_keeps_auto_review_bindings(self):
        source = pinned_host_archive()
        if source is None:
            self.skipTest('set PROKBOT_TEST_HOST_ARCHIVE to run the pinned Host recipe check')
        recipes = Path(__file__).resolve().parents[1] / 'recipes' / 'host'
        for prefix in ('recovered-core__stable', 'release-reliability'):
            with self.subTest(prefix=prefix):
                provenance = json.loads(bytepatch.apply(
                    source, bytepatch.load(recipes / f'{prefix}__prompt-tools-provenance.json.gbp.gz')
                ).decode('utf-8'))
                turn_toolset_meta = next(
                    item for item in provenance.get('modules', [])
                    if item.get('name') == 'prompt-tools-turn-toolset.mjs'
                )
                deps = set(turn_toolset_meta.get('dependencies', []))
                self.assertIn('buildSandShellAutoReviewTargetEnrichment', deps)
                self.assertIn('SAND_AUTO_REVIEW_CLASSIFIER_MAX_ATTEMPTS', deps)

                turn_toolset_code = bytepatch.apply(
                    source, bytepatch.load(recipes / f'{prefix}__prompt-tools-turn-toolset.mjs.gbp.gz')
                ).decode('utf-8')
                self.assertIn('buildSandShellAutoReviewTargetEnrichment', turn_toolset_code)
                self.assertIn('SAND_AUTO_REVIEW_CLASSIFIER_MAX_ATTEMPTS', turn_toolset_code)


if __name__ == '__main__':
    unittest.main()
