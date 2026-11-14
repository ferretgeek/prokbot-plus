"""Build the five ProkBot Plus tool ZIPs, or check an existing set against Git.

Use a clean checkout at the full commit ID and a fresh, caller-verified local
remote-tracking ref. Reachability is offline evidence, not a live remote check.
No fetch, push, checkout, installer download, extraction or package execution.
Reproducing exact compressed bytes requires the same Git/zlib toolchain.
"""

import argparse
from contextlib import ExitStack
import errno
import hashlib
import importlib.util
import io
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import zipfile


HERE = Path(__file__).resolve().parent
SUMS = 'SHA256SUMS.txt'
COMMON = ('LICENSE', 'NOTICE', 'README.md', 'README.en.md', 'CHANGELOG.md',
          'CONTRIBUTING.md', 'SECURITY.md', 'docs')
PACKAGES = {'host': ('host',), 'windows': ('windows', 'mac'), 'mac': ('mac',),
            'ios': ('ios',), 'android': ('android', 'windows', 'mac')}
# A faithful archive of an incomplete commit is still not a usable tool package.
TOOLS = ('docs/AI-INSTALL.md', 'docs/AI-INSTALL.en.md', 'docs/ARCHITECTURE.md', 'docs/ARCHITECTURE.en.md',
         'host/deploy.py', 'host/release/build-docker.py', 'host/server/application-guide.md',
         'host/tools/host-admin.mjs', 'host/recipes/host/manifest.json',
         'windows/patchers/desktop/patch.mjs', 'windows/patchers/desktop/original.mjs',
         'windows/patchers/desktop/supported.json', 'windows/patchers/desktop/recipes/manifest.json',
         'windows/dist/network/grokbot-tailcat.exe', 'windows/dist/installer/grokbot-setup-stub.exe',
         'mac/clients/desktop/main.mjs', 'mac/patchers/desktop/patch.mjs', 'mac/patchers/desktop/release-recipes.mjs',
         'mac/patchers/desktop/supported.json', 'mac/patchers/desktop/recipes/manifest.json',
         'mac/patchers/desktop/download-original.mjs', 'mac/patchers/desktop/package.json',
         'mac/patchers/desktop/node_modules/@electron/asar/package.json', 'mac/patchers/desktop/node_modules/@electron/asar/lib/asar.js',
         'ios/release/patch-ios.py', 'ios/recipes/ios/manifest.json', 'android/patchers/patch.mjs',
         'android/patchers/supported.json', 'android/dist/grokbot-android-shell.apk')
EXECUTABLES = ('host/bin/grokbot-tailcat', 'host/bin/linux-arm64/grokbot-tailcat',
               'mac/dist/network/grokbot-tailcat', 'ios/bin/GrokBotLocal.dylib',
               'mac/patchers/desktop/node_modules/.bin/asar', 'mac/patchers/desktop/node_modules/@electron/asar/bin/asar.mjs',
               'android/shell/gradlew')


class ReleaseError(Exception):
    pass


def verifier():
    spec = importlib.util.spec_from_file_location('verify_release', HERE / 'verify-release.py')
    module = importlib.util.module_from_spec(spec)
    previous = sys.dont_write_bytecode
    try:
        sys.dont_write_bytecode = True  # Verification must not write a cache into the checkout.
        spec.loader.exec_module(module)
    finally:
        sys.dont_write_bytecode = previous
    return module


def invocation(repo, args):
    # Ignore inherited Git redirections, trace sinks, user filters and archive settings.
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith('GIT_')}
    env.update(TZ='UTC0', LC_ALL='C', GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull,
               GIT_ATTR_NOSYSTEM='1', GIT_NO_REPLACE_OBJECTS='1', GIT_OPTIONAL_LOCKS='0',
               GIT_NO_LAZY_FETCH='1', GIT_ALLOW_PROTOCOL='', GIT_TERMINAL_PROMPT='0')
    cmd = ['git', '--literal-pathspecs', '-c', 'core.autocrlf=false', '-c', 'core.eol=lf',
           '-c', 'core.bigFileThreshold=64m', '-c', 'core.fsmonitor=false',
           '-c', 'core.untrackedCache=false', '-c', 'core.attributesFile=' + os.devnull, *args]
    return dict(args=cmd, cwd=repo, env=env, stderr=subprocess.DEVNULL)


def git(repo, *args, data=None, stdout=subprocess.PIPE, failure=None):
    result = subprocess.run(**invocation(repo, args), stdout=stdout, input=data,
                            stdin=subprocess.DEVNULL if data is None else None)
    if result.returncode:
        raise ReleaseError(failure or f'git {args[0]} failed (exit {result.returncode})')
    return result.stdout


def source(repo, commit, pushed_ref):
    if not re.fullmatch(r'[0-9a-f]{40}|[0-9a-f]{64}', commit):
        raise ReleaseError('--commit must be a full commit object ID')
    if not re.fullmatch(r'refs/remotes/[^/]+/.+', pushed_ref):
        raise ReleaseError('--pushed-ref must name a full remote-tracking branch ref')
    def git_path(at, option):
        return Path(os.fsdecode(git(at, 'rev-parse', '--path-format=absolute', option).rstrip(b'\r\n')))
    repo = git_path(repo, '--show-toplevel')
    common_dir = git_path(repo, '--git-common-dir')
    if os.path.lexists(common_dir / 'info' / 'attributes'):
        raise ReleaseError('repository-local info/attributes would override committed release inputs')
    if git(repo, 'rev-parse', '--verify', 'HEAD^{commit}').strip().decode('ascii') != commit:
        raise ReleaseError('the checkout must be at the requested commit')
    flags = git(repo, 'ls-files', '-v', '-z').split(b'\0')[:-1]
    if any(record[:1] == b'S' or record[:1].islower() for record in flags):
        raise ReleaseError('cannot certify a clean checkout with skip-worktree or assume-unchanged entries')
    if git(repo, 'status', '--porcelain=v1', '-z', '--untracked-files=normal', '--ignore-submodules=none'):
        raise ReleaseError('checkout is not clean (index, worktree or untracked files)')
    tip = git(repo, 'show-ref', '--verify', '--hash', pushed_ref,
              failure='local remote-tracking ref is missing').strip().decode('ascii')
    git(repo, 'merge-base', '--is-ancestor', commit, tip,
        failure='commit is not proven reachable from the local remote-tracking ref')
    return repo, common_dir, tip


def inventory(repo, commit, policy):
    raw = git(repo, 'ls-tree', '-rtz', '--full-tree', commit, '--', *COMMON, *PACKAGES)
    tree, keys = {}, set()
    for entry in raw.split(b'\0')[:-1]:
        header, path = entry.split(b'\t', 1)
        name = path.decode('utf-8')
        mode = int(header.split()[0], 8)
        directory = mode == stat.S_IFDIR
        if not directory and mode not in (0o100644, 0o100755):
            raise ReleaseError('release roots may contain only ordinary files and directories')
        try:
            policy.path_policy(name, direct=True, directory=directory)
            key = policy.pathkey(name)
        except policy.Rejected as exc:
            raise ReleaseError(f'release tree rejected: {exc}') from None
        if key in keys:
            raise ReleaseError('release tree contains ambiguous path names')
        keys.add(key)
        tree[name + ('/' if directory else '')] = mode
    readmes = [f'{root}/{name}' for root in PACKAGES for name in ('README.md', 'README.en.md')]
    for name in (*COMMON[:-1], *TOOLS, *readmes, *EXECUTABLES):
        if name not in tree or (name in EXECUTABLES and tree[name] != 0o100755):
            raise ReleaseError(f'missing required file or executable mode: {name}')
    # Substitution can depend on mutable refs; named filters/diff drivers on local config.
    names = b''.join(n.encode('utf-8') + b'\0' for n in tree if not n.endswith('/'))
    attrs = git(repo, 'check-attr', '--source=' + commit, '-z', '--stdin', 'export-subst', 'filter', 'diff',
                data=names).split(b'\0')
    for attr, value in zip(attrs[1::3], attrs[2::3]):
        if value not in (b'unset', b'unspecified') and not (attr == b'diff' and value == b'set'):
            raise ReleaseError('release inputs use a non-reproducible Git attribute: ' + attr.decode('ascii'))
    return tree


def digest(stream):
    h = hashlib.sha256()
    for chunk in iter(lambda: stream.read(1 << 20), b''):
        h.update(chunk)
    return h.hexdigest()


def archive_digest(repo, args):
    with subprocess.Popen(**invocation(repo, args), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE) as process:
        with process.stdout:
            result = digest(process.stdout)
        if process.wait():
            raise ReleaseError('git archive failed while reproducing a package')
    return result


def check_layout(src, path, commit, expected):
    src.seek(0)
    with zipfile.ZipFile(src) as archive:
        if archive.comment != commit.encode('ascii'):
            raise ReleaseError(f'{path.name}: wrong Git commit comment')
        seen = set()
        for info in archive.infolist():
            name = info.orig_filename
            if name in seen or name not in expected:
                raise ReleaseError(f'{path.name}: duplicate or unexpected member')
            seen.add(name)
            mode = info.external_attr >> 16
            # Git uses DOS attrs (no Unix mode) for directories and ordinary non-executables.
            wanted = expected[name]
            if mode != wanted and not (mode == 0 and wanted in (stat.S_IFDIR, 0o100644)):
                raise ReleaseError(f'{path.name}: wrong member mode')
        if seen != expected.keys():
            raise ReleaseError(f'{path.name}: missing committed members')


def content_check(policy, repo, commit, sums, archives, helper_sums):
    # Both control inputs are independent of ZIP member lookup. Never infer helper pins.
    shell = git(repo, 'cat-file', 'blob', f'{commit}:{policy.MANIFEST}')
    controls = {Path(SUMS): sums, Path(policy.MANIFEST): shell}
    def opener(path):
        return io.BytesIO(controls[path]) if path in controls else policy.local(path)
    argv = ['--sums', SUMS, '--shell-manifest', policy.MANIFEST, '--helper-sums', str(helper_sums.absolute()),
            *(str(p) for p in archives)]
    if policy.main(argv, opener):
        raise ReleaseError('release content policy did not pass')


def remove_empty(path):
    try:
        path.rmdir()
    except OSError as exc:
        if exc.errno not in (errno.ENOTEMPTY, errno.EEXIST, errno.ENOENT):
            raise


def open_artifact(policy, path):
    if linked(path):
        raise ReleaseError(f'{path.name}: refusing a link or Windows reparse point')
    try:
        return policy.local(path)
    except policy.Rejected as exc:
        raise ReleaseError(f'{path.name}: expected a regular local file') from exc


def linked(path):
    if not os.path.lexists(path):
        return False
    info = path.lstat()
    return stat.S_ISLNK(info.st_mode) or bool(getattr(info, 'st_file_attributes', 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT)


def release(repo, commit, output, *, pushed_ref='refs/remotes/origin/main', verify_only=False, helper_sums=None):
    if any(str(p).startswith(('//', '\\\\')) for p in (repo, output, helper_sums) if p is not None):
        raise ReleaseError('use local filesystem paths')
    if os.path.lexists(output) and not verify_only:
        raise ReleaseError('--output must be a new directory; nothing was overwritten')
    repo, common_dir, tip = source(repo, commit, pushed_ref)
    output = output.parent.resolve(strict=True) / output.name  # Do not follow a final symlink.
    if output.name in ('', '.', '..') or output.is_relative_to(repo) or output.is_relative_to(common_dir) or linked(output):
        raise ReleaseError('output must be a dedicated external directory, not a link or repository path')
    policy = verifier()
    tree = inventory(repo, commit, policy)
    archives = {key: output / f'prokbot-plus-{key}.zip' for key in PACKAGES}
    with ExitStack() as rollback:
        if verify_only:
            names = {p.name for p in archives.values()} | {SUMS}
            if {p.name for p in output.iterdir()} != names:
                raise ReleaseError('expected exactly five platform ZIPs and SHA256SUMS.txt')
        else:
            output.mkdir(mode=0o700)  # Atomic reservation; even an existing empty directory is not ours.
            rollback.callback(remove_empty, output)
        rows = []
        for key, path in archives.items():
            roots = (*COMMON, *PACKAGES[key])
            args = ('archive', '--format=zip', '-6', commit, '--', *roots)
            if not verify_only:
                with path.open('xb') as dest:
                    rollback.callback(path.unlink, missing_ok=True)
                    git(repo, *args, stdout=dest)
            with open_artifact(policy, path) as src:
                sha = digest(src)
                if verify_only and sha != archive_digest(repo, args):
                    raise ReleaseError(f'{path.name}: bytes differ from git archive of the requested commit')
                check_layout(src, path, commit, {n: m for n, m in tree.items() if n.partition('/')[0] in roots})
            rows.append((path.name, sha))
        sums = ''.join(f'{sha}  {name}\n' for name, sha in sorted(rows)).encode('ascii')
        manifest = output / SUMS
        if verify_only:
            with open_artifact(policy, manifest) as src:
                if src.read(len(sums) + 1) != sums:
                    raise ReleaseError('SHA256SUMS.txt does not match the five reproduced ZIPs')
        if helper_sums is not None:
            content_check(policy, repo, commit, sums, archives.values(), helper_sums)
        if not verify_only:
            with manifest.open('xb') as dest:  # Completion marker, written only after the requested checks.
                rollback.callback(manifest.unlink, missing_ok=True)
                dest.write(sums)
        rollback.pop_all()
    return tip


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False,
        epilog='Requires Git with check-attr --source and Python 3.10+. Main still gates extracted platform '
               'tests and Windows/Android patch.mjs --source ORIGINAL --verify-only separately.')
    parser.add_argument('--repo', type=Path, default=HERE.parent, help='release checkout (default: this repository)')
    parser.add_argument('--commit', required=True, help='full checked-out commit ID')
    parser.add_argument('--pushed-ref', default='refs/remotes/origin/main', help='local tracking ref (default: %(default)s)')
    parser.add_argument('--output', required=True, type=Path, help='new external directory under an existing parent')
    parser.add_argument('--verify-only', action='store_true', help='read an existing set; compare all bytes with fresh Git archive streams')
    parser.add_argument('--helper-sums', type=Path, help='also run verify-release.py with these independent public native-helper pins')
    args = parser.parse_args(argv)
    try:
        tip = release(args.repo, args.commit.lower(), args.output, pushed_ref=args.pushed_ref,
                      verify_only=args.verify_only, helper_sums=args.helper_sums)
    except (ReleaseError, OSError, UnicodeError, zipfile.BadZipFile) as exc:
        print('release-packages: ' + (str(exc) if isinstance(exc, ReleaseError) else type(exc).__name__), file=sys.stderr)
        return 1
    print(f'{"reproduced" if args.verify_only else "built"} packages=5 commit={args.commit.lower()} '
          f'tracking_tip={tip} content_policy={"passed" if args.helper_sums else "not-run"}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
