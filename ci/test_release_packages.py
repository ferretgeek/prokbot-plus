"""Tiny, offline release fixtures. Run: python -I -B -S ci/test_release_packages.py

Create unattached Git objects and an index in a disposable directory. Simulate the
two ref lookups and compare the index to the fixture commit instead of unborn HEAD.
Git computes all diffs, ancestry, attributes and archives; no refs are updated.
"""

from contextlib import redirect_stderr, redirect_stdout
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import zipfile


spec = importlib.util.spec_from_file_location('release_packages', Path(__file__).with_name('release-packages.py'))
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)


def packet(files):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w') as z:
        for name, data in files:
            z.writestr(zipfile.ZipInfo(name), data)
    return buf.getvalue()


def files_at(out):
    return {p.name: p.read_bytes() for p in out.iterdir()}


def checksum_lines(files):
    return b''.join(hashlib.sha256(data).hexdigest().encode() + b'  ' + name.encode() + b'\n'
                    for name, data in sorted(files.items()) if name.endswith('.zip'))


class Packages(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        temp = tempfile.TemporaryDirectory(prefix='prokbot-release-fixture-')
        cls.addClassCleanup(temp.cleanup)
        cls.base = Path(temp.name).resolve()
        cls.repo = cls.base / 'public-source'
        cls.repo.mkdir()
        cls.real_git = staticmethod(r.git)
        g = lambda *args, **kw: r.git(cls.repo, *args, **kw)
        g('init', '-q', '--initial-branch=unborn', '--template=')
        g('config', 'core.fileMode', 'false')  # Mirror a Windows checkout on all test platforms.
        g('config', 'core.bigFileThreshold', '1')  # Producing ZIPs must override machine settings.
        paths = set(r.COMMON[:-1] + r.TOOLS + r.EXECUTABLES)
        for name in ('host', 'windows', 'mac', 'ios', 'android'):
            paths.update(f'{name}/{leaf}' for leaf in ('README.md', 'README.en.md', 'extra.fixture'))
        paths.update(('docs/extra.fixture', 'ci/not-shipped', 'packages/not-shipped',
                      'tools/not-shipped', '.gitattributes', '.gitignore', 'windows/setup.bat'))
        policy = r.verifier()
        payloads = {name: (name + '\n').encode() for name in paths}
        for name in policy.HELPERS:
            payloads[name] = b'synthetic helper ' + name.encode()
        payloads['.gitattributes'] = b'* text=auto eol=lf\n*.bat text eol=crlf\n*.apk binary\n'
        payloads['.gitignore'] = b'ignored.fixture\n'
        payloads['windows/setup.bat'] = b'@echo synthetic\r\n'
        payloads[policy.SHELL] = packet([('AndroidManifest.xml', b'fixture')])
        payloads[policy.MANIFEST] = json.dumps({'shell': {'path': policy.SHELL,
            'sha256': hashlib.sha256(payloads[policy.SHELL]).hexdigest()}}).encode()
        for name, data in payloads.items():
            dest = cls.repo / name
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(data)
        cls.pins = cls.base / 'public-helper-pins.txt'
        cls.pins.write_bytes(b''.join(hashlib.sha256(payloads[n]).hexdigest().encode() + b'  ' + n.encode() + b'\n'
                                      for n in sorted(policy.HELPERS)))
        g('add', '--', '.')
        g('update-index', '--chmod=+x', '--', *r.EXECUTABLES)  # Synthetic index only; never the working repository.
        tree = g('write-tree').strip().decode()
        headers = dict(GIT_AUTHOR_NAME='Fixture', GIT_AUTHOR_EMAIL='fixture@example.invalid',
                       GIT_COMMITTER_NAME='Fixture', GIT_COMMITTER_EMAIL='fixture@example.invalid',
                       GIT_AUTHOR_DATE='2001-02-03T04:05:06+00:00', GIT_COMMITTER_DATE='2001-02-03T04:05:06+00:00')
        def commit(message, *parents):
            kw = r.invocation(cls.repo, ('commit-tree', tree, *parents, '-m', message))
            kw['env'].update(headers)
            return subprocess.run(**kw, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, check=True).stdout.strip().decode()
        cls.sha = commit('synthetic snapshot')
        cls.tip = commit('later on remote', '-p', cls.sha)
        cls.other = commit('unrelated history')
        (cls.repo / 'ignored.fixture').write_bytes(b'not part of the commit')
        cls.payloads = payloads

    def setUp(self):
        self.index_before = (self.repo / '.git/index').read_bytes()
        tmp = tempfile.TemporaryDirectory(dir=self.base, prefix='case-')
        self.addCleanup(tmp.cleanup)
        self.out = Path(tmp.name) / 'release'
        self.tracking_tip = self.tip
        def fixture_git(repo, *args, **kw):
            if args == ('rev-parse', '--verify', 'HEAD^{commit}'):
                return self.sha.encode() + b'\n'
            if args == ('show-ref', '--verify', '--hash', 'refs/remotes/origin/main'):
                return self.tracking_tip.encode() + b'\n'
            if args[0] == 'status':
                # In an unborn checkout Git treats the entire synthetic index as staged. Compare
                # that index to the actual detached object, then use real worktree/untracked checks.
                return (self.real_git(repo, 'diff', '--cached', '--name-only', '-z', self.sha, '--') +
                        self.real_git(repo, 'diff-files', '--name-only', '-z') +
                        self.real_git(repo, 'ls-files', '-oz', '--exclude-standard'))
            return self.real_git(repo, *args, **kw)
        ctx = patch.object(r, 'git', side_effect=fixture_git)
        ctx.start()
        self.addCleanup(ctx.stop)

    def test_build_and_reproduce_five_tool_packages(self):
        with patch.dict(os.environ, TZ='EST5EDT', GIT_DIR='not-the-fixture'), redirect_stdout(io.StringIO()) as report:
            self.assertEqual(r.release(self.repo, self.sha, self.out, helper_sums=self.pins), self.tip)
        self.assertIn('verified packages=5', report.getvalue())
        data = files_at(self.out)
        expected = {'host': {'host'}, 'windows': {'windows', 'mac'}, 'mac': {'mac'},
                    'ios': {'ios'}, 'android': {'android', 'windows', 'mac'}}
        common = {'LICENSE', 'NOTICE', 'README.md', 'README.en.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md', 'docs'}
        self.assertEqual(set(data), {f'prokbot-plus-{k}.zip' for k in expected} | {'SHA256SUMS.txt'})
        self.assertEqual(data['SHA256SUMS.txt'], checksum_lines(data))
        for key, roots in expected.items():
            with zipfile.ZipFile(io.BytesIO(data[f'prokbot-plus-{key}.zip'])) as z:
                self.assertEqual(z.comment.decode(), self.sha)
                files = {n for n in z.namelist() if not n.endswith('/')}
                self.assertEqual(files, {n for n in self.payloads if n.partition('/')[0] in common | roots})
                for n in files:
                    self.assertEqual(z.read(n), self.payloads[n])
                for n in files.intersection(r.EXECUTABLES):
                    self.assertEqual(z.getinfo(n).external_attr >> 16, 0o100755)
        other = self.out.with_name('second')
        with patch.dict(os.environ, TZ='JST-9'):
            r.release(self.repo, self.sha, other)
            r.release(self.repo, self.sha, self.out, verify_only=True)
        self.assertEqual(data, files_at(other))
        self.assertEqual(data, files_at(self.out))
        self.assertEqual((self.repo / '.git/index').read_bytes(), self.index_before)
        self.assertFalse(self.real_git(self.repo, 'for-each-ref'))

    def test_no_overwrite_and_exact_output_set(self):
        self.out.mkdir()
        with self.assertRaisesRegex(r.ReleaseError, 'new directory'):
            r.release(self.repo, self.sha, self.out)
        path = self.out / 'prokbot-plus-android.zip'
        path.write_bytes(b'caller-owned')
        with self.assertRaisesRegex(r.ReleaseError, 'nothing was overwritten'):
            r.release(self.repo, self.sha, self.out)
        with self.assertRaisesRegex(r.ReleaseError, 'exactly five'):
            r.release(self.repo, self.sha, self.out, verify_only=True)
        self.assertEqual(files_at(self.out), {path.name: b'caller-owned'})

    def test_provenance_and_dirty_checkout(self):
        for commit, ref, error in [('HEAD', 'refs/remotes/origin/main', 'full commit'),
                                   (self.other, 'refs/remotes/origin/main', 'at the requested commit'),
                                   (self.sha, 'refs/heads/main', 'remote-tracking'),
                                   (self.sha, 'refs/remotes/other/absent', 'ref is missing')]:
            with self.subTest(error=error), self.assertRaisesRegex(r.ReleaseError, error):
                r.release(self.repo, commit, self.out, pushed_ref=ref)
        self.tracking_tip = self.other
        with self.assertRaisesRegex(r.ReleaseError, 'not proven reachable'):
            r.release(self.repo, self.sha, self.out)
        self.tracking_tip = self.tip
        for name, staged in [('untracked.fixture', False), ('README.md', False), ('README.md', True)]:
            with self.subTest(name=name, staged=staged):
                path = self.repo / name
                old = path.read_bytes() if path.exists() else None
                try:
                    path.write_bytes(b'dirt')
                    if staged:
                        self.real_git(self.repo, 'add', '--', name)
                    with self.assertRaisesRegex(r.ReleaseError, 'not clean'):
                        r.release(self.repo, self.sha, self.out)
                finally:
                    if old is None:
                        path.unlink()
                    else:
                        path.write_bytes(old)
                        if staged:
                            self.real_git(self.repo, 'read-tree', self.sha)
                        self.real_git(self.repo, 'update-index', '--refresh')
        self.assertFalse(self.out.exists())

    def test_hidden_index_entry_and_external_attributes(self):
        for flag in ('skip-worktree', 'assume-unchanged'):
            self.real_git(self.repo, 'update-index', '--' + flag, '--', 'README.md')
            try:
                with self.assertRaisesRegex(r.ReleaseError, 'certify a clean checkout'):
                    r.release(self.repo, self.sha, self.out)
            finally:
                self.real_git(self.repo, 'update-index', '--no-' + flag, '--', 'README.md')
        attrs = self.repo / '.git/info/attributes'
        attrs.parent.mkdir(exist_ok=True)
        try:
            attrs.write_bytes(b'* export-ignore\n')
            with self.assertRaisesRegex(r.ReleaseError, 'override committed'):
                r.release(self.repo, self.sha, self.out)
        finally:
            attrs.unlink()
        self.assertFalse(self.out.exists())

    def test_wrong_sums_and_resealed_content_are_rejected(self):
        r.release(self.repo, self.sha, self.out)
        manifest = self.out / r.SUMS
        manifest.write_bytes(b'wrong\n')
        with self.assertRaisesRegex(r.ReleaseError, 'SHA256SUMS'):
            r.release(self.repo, self.sha, self.out, verify_only=True)
        self.assertEqual(manifest.read_bytes(), b'wrong\n')
        path = self.out / 'prokbot-plus-host.zip'
        with zipfile.ZipFile(path, 'a') as z:
            z.writestr('host/plausible-extra.txt', b'not committed')
        manifest.write_bytes(checksum_lines(files_at(self.out)))
        with self.assertRaisesRegex(r.ReleaseError, 'bytes differ'):
            r.release(self.repo, self.sha, self.out, verify_only=True)

    def test_policy_failure_removes_only_our_output(self):
        bad = self.out.with_name('independent-pins.txt')
        bad.write_bytes(b'0' * 64 + b'  host/bin/grokbot-tailcat\n')
        with redirect_stderr(io.StringIO()) as report, self.assertRaisesRegex(r.ReleaseError, 'content policy'):
            r.release(self.repo, self.sha, self.out, helper_sums=bad)
        self.assertIn('category=helper-digest', report.getvalue())
        self.assertFalse(self.out.exists())
        self.assertTrue(bad.is_file())

    def test_collision_during_build_does_not_remove_foreign_file(self):
        collision = self.out / 'prokbot-plus-windows.zip'
        original = r.check_layout
        def collision_after_host(*args):
            original(*args)
            collision.write_bytes(b'not ours')
        with patch.object(r, 'check_layout', side_effect=collision_after_host), self.assertRaises(FileExistsError):
            r.release(self.repo, self.sha, self.out)
        self.assertEqual(files_at(self.out), {collision.name: b'not ours'})

    def test_incomplete_tree_and_forbidden_input_rejected_before_archiving(self):
        records = self.real_git(self.repo, 'ls-tree', '-rtz', self.sha, '--', *r.COMMON, *r.PACKAGES).split(b'\0')[:-1]
        policy = r.verifier()
        helper = b'\tmac/patchers/desktop/node_modules/.bin/asar'
        for kind in ('missing tool', 'wrong executable mode', 'disallowed file'):
            tree = []
            for rec in records:
                if kind == 'missing tool' and rec.endswith(b'\twindows/patchers/desktop/original.mjs'):
                    continue
                if kind == 'wrong executable mode' and rec.endswith(helper):
                    rec = b'100644' + rec[6:]
                tree.append(rec)
            if kind == 'disallowed file':
                tree.append(b'100644 blob ' + b'0' * 40 + b'\tandroid/dist/other.apk')
            with self.subTest(kind=kind), patch.object(r, 'git', return_value=b'\0'.join(tree) + b'\0'), self.assertRaises(r.ReleaseError):
                r.inventory(self.repo, self.sha, policy)

    def test_archive_layout_checks_mode_members_and_provenance(self):
        name = self.out.with_suffix('.zip')
        data = packet([('docs/tool', b'fixture')])
        for comment, expected, reason in [(self.tip, {'docs/tool': 0o100755}, 'commit comment'),
                (self.sha, {'docs/tool': 0o100755}, 'member mode'),
                (self.sha, {}, 'unexpected member')]:
            buf = io.BytesIO(data)
            with zipfile.ZipFile(buf, 'a') as archive:
                archive.comment = comment.encode()
            with self.subTest(reason=reason), self.assertRaisesRegex(r.ReleaseError, reason):
                r.check_layout(buf, name, self.sha, expected)
        buf = io.BytesIO(packet([]))
        with zipfile.ZipFile(buf, 'a') as archive:
            archive.comment = self.sha.encode()
        with self.assertRaisesRegex(r.ReleaseError, 'missing committed'):
            r.check_layout(buf, name, self.sha, {'docs/tool': 0o100755})


if __name__ == '__main__':
    unittest.main()
