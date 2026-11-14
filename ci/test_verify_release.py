"""Synthetic-only, single-process regression tests. No files besides source are opened."""

import contextlib
import gzip
import hashlib
import importlib.util
import io
import json
import stat
import struct
import unittest
import warnings
import zipfile
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('verify_release', Path(__file__).with_name('verify-release.py'))
v = importlib.util.module_from_spec(spec)
spec.loader.exec_module(v)


def pack(entries=(), comment=b'', sink=None, method=zipfile.ZIP_DEFLATED):
    sink = io.BytesIO() if sink is None else sink
    with zipfile.ZipFile(sink, 'w', method) as z:
        for name, data in entries:
            z.writestr(name, data)
        z.comment = comment
    return sink.getvalue()


def record(name, data):
    return hashlib.sha256(data).hexdigest().encode() + b'  ' + name.encode() + b'\n'


def manifest(apk, path=v.SHELL):
    return json.dumps({'shell': {'path': path, 'sha256': hashlib.sha256(apk).hexdigest()}}).encode()


def signed_layout(apk):
    # Minimal APK signing-block envelope. The verifier pins bytes, not Android signatures.
    end = apk.rindex(v.ZIP[1])
    cd, = struct.unpack_from('<I', apk, end + 16)
    block = struct.pack('<Q', 24) * 2 + b'APK Sig Block 42'
    result = bytearray(apk[:cd] + block + apk[cd:])
    struct.pack_into('<I', result, end + len(block) + 16, cd + len(block))
    return bytes(result)


class Cases(unittest.TestCase):
    def run_cli(self, packages, *, sums=None, rules=None, pin=None, helpers=None, args=(), names=None):
        names = names or ['sample-%d.zip' % i for i in range(len(packages))]
        files = dict(zip(names, packages))
        files['sums'] = b''.join(record(n, p) for n, p in files.items()) if sums is None else sums
        argv = ['--sums', 'sums']
        for flag, data in [('--sensitive-file', rules), ('--shell-manifest', pin), ('--helper-sums', helpers)]:
            if data is not None:
                argv += [flag, flag[2:]]
                files[flag[2:]] = data
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = v.main(argv + list(args) + names, lambda p: io.BytesIO(files[str(p)]))
        return rc, out.getvalue(), err.getvalue()

    def ok(self, *packages, **kw):
        self.assertEqual(self.run_cli(packages, **kw), (0, 'verified packages=%d\n' % len(packages), ''))

    def bad(self, category, *packages, index=1, **kw):
        self.assertEqual(self.run_cli(packages, **kw), (1, '', 'category=%s package=%d\n' % (category, index)))

    def test_public_release_and_checksums(self):
        a = pack([('docs/README.md', b'example'), ('ios/recipes/patch.gbp.gz', gzip.compress(b'patch'))])
        b = pack([('android/shell/gradle/wrapper/gradle-wrapper.jar', pack([('Tool.class', b'fixture')]))])
        names = ['example one.zip', 'example-two.zip']
        sums = record(names[1], b).replace(b'  ', b' *').replace(b'\n', b'\r\n') + record(names[0], a).rstrip(b'\n')
        self.ok(a, b, names=names, sums=sums)
        self.bad('checksum-digest', a, b, names=names, sums=record(names[0], a) + record(names[1], a), index=2)
        row = record(names[0], a)
        for sums, cat in [(row + row, 'checksum-set'), (row, 'checksum-set'), (row + record('extra.zip', b), 'checksum-set'),
                          (record('../elsewhere.zip', b), 'unsafe-path'), (b'malformed\n', 'checksum-format')]:
            with self.subTest(cat=cat):
                self.bad(cat, a, b, sums=sums, names=names, index=0)
        self.bad('checksum-set', a, a, sums=row, names=[names[0], names[0]], index=0)

    def test_exact_binary_lines_and_boundaries(self):
        marker = b' Test.[*]\x00\xffEND '
        rules = marker + b'\r\n\r\nsecond\r'  # An unterminated final CR is data.
        with patch.object(v, 'BLOCK', 11):
            for split in (1, 5, 10):
                data = b'x' * (11 - split) + marker
                self.bad('sensitive-bytes', pack([('data', data)]), rules=rules)
            self.bad('sensitive-bytes', pack([('data', b'second\r')]), rules=rules)
            self.ok(pack([('data', marker.strip() + b' SECOND second')]), rules=rules)
            armor = b'-----BEGIN ' + b'OPENSSH PRIVATE KEY-----'
            self.bad('private-key', pack([('renamed', b'12345678' + armor)]))
        self.ok(pack([('a', marker[:6]), ('b', marker[6:])]), rules=rules)
        self.bad('sensitive-bytes', pack(comment=marker), rules=rules)
        self.bad('sensitive-bytes', pack([('meta-only-name', b'public')]), rules=b'meta-only-name')
        self.bad('sensitive-bytes', pack([('large', b'.' * (v.BLOCK - 5) + marker)]), rules=rules)
        self.ok(pack([('large', b'0' * (3 * v.BLOCK)), ('twice', gzip.compress(b'0' * (2 * v.BLOCK)))]))
        ssh_magic = b'openssh-key-v1\0'
        self.ok(pack([('parser', ssh_magic + b' is a public parser constant')]))
        self.bad('private-key', pack([('binary', ssh_magic + struct.pack('>I', 4) + b'none' + struct.pack('>I', 4))]))

    def test_private_and_client_policy(self):
        categories = {'private-path': ['.GiT/config', '.cache/a', '.ssh/', 'operator-private/log', '.env.local',
                                      'team/access-notes.md', 'ssh-access/readme.md', '\u670d\u52a1\u5668\u8bbf\u95ee.txt',
                                      'AuthKey_TEST.p8', 'android-signing.json', 'id_ed25519',
                                      '\u63a5\u5165\u4fe1\u606f.txt', '\u5c40\u57df\u7f51\u5c0f\u4e3b\u673a/demo.txt'],
                      'client-program': ['payload.iPa', 'Payload/Fake.app/data', 'official/setup', 'win/output/data',
                                         'Client-Portable.zip', 'client.DMG', 'resources/app.asar', 'client.exe'],
                      'apk': ['build/other.APK', 'android/dist/other.apk'],
                      'unsafe-path': ['../data', '/data', 'C:/data', 'dir\\data', 'alias.']}
        for cat, names in categories.items():
            for n in names:
                with self.subTest(n=n):
                    # Windows ZipInfo normalizes backslashes on write; keep the hostile bytes on the wire.
                    clean = n.replace('\\', '~')
                    blob = pack([(clean, b'')]).replace(clean.encode(), n.encode())
                    self.bad(cat, blob)
        self.bad('client-program', pack([('extensionless', b'MZ' + b'fake Windows image')]))
        self.bad('client-program', pack([('disguised.a', b'\xca\xfe\xba\xbe\0\0\0\x02' + b'fake fat image')]))
        self.bad('client-program', pack([('disguised.image', b'prefix' + b'koly\0\0\0\x04' + b'\0' * 504)]))
        self.bad('client-program', pack([('disguised.zip', pack([('Payload/A.app/Info.plist', b'')]))]))
        self.ok(pack([('host/.env.example', b'template'), ('mac/clients/desktop/access.js', b'public')]))

    def test_nested_magic_gzip_and_limits(self):
        marker = b'boundary-literal'
        concat = gzip.compress(b'x' * 40 + marker[:8]) + gzip.compress(marker[8:])
        nested = pack([('outer.data', gzip.compress(pack([('inner.data', concat)])))])
        with patch.object(v, 'BLOCK', 13):
            self.bad('sensitive-bytes', nested, rules=marker)
            self.ok(nested, rules=marker.upper())
        buf = io.BytesIO()
        with gzip.GzipFile('access-notes.txt', 'wb', fileobj=buf, mtime=0) as gz:
            gz.write(b'public')
        self.bad('private-path', pack([('data', gzip.compress(b'a') + buf.getvalue())]))
        self.bad('client-program', pack([('docs/client.ipa.gz', gzip.compress(b'fake'))]))
        with patch.object(v, 'MAX_DEPTH', 2):
            self.ok(pack([('z', gzip.compress(pack([('public', b'ok')])))]))
            self.bad('input-limit', nested)
        with patch.object(v, 'MAX_ENTRIES', 2):
            self.ok(pack([('g', gzip.compress(b'x'))]))
            self.bad('input-limit', pack([('g', gzip.compress(b'') * 2)]))

    def test_pinned_shell(self):
        marker = b'apk-decoded-only'
        apk = signed_layout(pack([('AndroidManifest.xml', b'fixture'), ('assets/x', gzip.compress(marker))]))
        pin = manifest(apk)
        pair = [(v.MANIFEST, pin), (v.SHELL, apk)]
        self.ok(pack(pair), pin=pin)
        self.ok(pack(pair[::-1]), pin=pin)
        self.bad('sensitive-bytes', pack(pair), pin=pin, rules=marker)
        self.bad('shell-manifest', pack(pair))
        self.bad('shell-manifest', pack(pair[1:]), pin=pin)
        self.bad('shell-manifest', pack(pair[:1]), pin=pin)
        other = pack([('AndroidManifest.xml', b'a different fake shell')])
        self.bad('shell-digest', pack([(v.SHELL, other), (v.MANIFEST, manifest(other))]), pin=pin)
        self.bad('shell-manifest', pack([(v.SHELL, apk), (v.MANIFEST, manifest(other))]), pin=pin)
        self.bad('shell-manifest', pack(pair), pin=manifest(apk, 'elsewhere.apk'), index=0)
        self.bad('apk', pack([('prefix/' + v.SHELL, apk)]), pin=pin)
        self.bad('apk', pack([(v.SHELL.upper(), apk)]), pin=pin)
        self.bad('apk', pack([('nested.zip', pack(pair))]), pin=pin)
        self.bad('apk', pack([('disguised', other)]), pin=pin)
        self.bad('apk', pack([('disguised', apk)]), pin=pin)

    def test_helpers_are_pinned_not_name_exemptions(self):
        helper = 'windows/dist/installer/grokbot-setup-stub.exe'
        data = b'MZfixture'
        pins = record(helper, data)
        self.ok(pack([(helper, data)]), helpers=pins)
        self.bad('helper-digest', pack([(helper, data)]))
        self.bad('helper-digest', pack([(helper, data + b'portable payload')]), helpers=pins)
        self.bad('client-program', pack([('nested', pack([(helper, data)]))]), helpers=pins)
        self.bad('sensitive-bytes', pack([(helper, data)]), helpers=pins, rules=b'MZfixture')
        audio = 'ios/clients/ios/audio-processing/libfixture.a'
        self.ok(pack([(audio, b'!<arch>\n')]), helpers=record(audio, b'!<arch>\n'))

    def test_exact_caps(self):
        payload = b'x' * 2048
        blob = pack([('sample', payload)])
        for attr, limit in [('MAX_ZIP', len(blob)), ('MAX_MEMBER', len(payload)), ('MAX_DIRECTORY', 46 + len('sample'))]:
            with patch.object(v, attr, limit):
                self.ok(blob)
            with patch.object(v, attr, limit - 1):
                self.bad('input-limit', blob)
        nested = pack([('compressed', gzip.compress(payload))])
        with patch.object(v, 'MAX_BUFFER', len(gzip.compress(payload)) - 1):
            self.bad('input-limit', nested)
        with patch.object(v, 'MAX_MEMBER', len(payload) - 1):
            self.bad('input-limit', nested)
        with patch.object(v, 'MIB', len(blob) + len(payload)):
            self.ok(blob, args=['--budget-mib', '1'])
            self.bad('input-limit', blob, blob, index=2, args=['--budget-mib', '1'])
        for rules in (b'a' * (v.TEXT + 1), b'x' * (v.MAX_LITERAL + 1), b'x\n' * (v.MAX_RULES + 1)):
            self.bad('input-limit', blob, rules=rules, index=0)
        self.bad('empty-rules', blob, rules=b'\r\n', index=0)
        self.bad('input-limit', blob, args=['--budget-mib', '0'], index=0)
        self.bad('input-limit', *([blob] * (v.MAX_PACKAGES + 1)), index=0)

    def test_conflicts_and_corruption(self):
        for entries in [[('x', b'x'), ('X', b'y')], [('x/a', b'x'), ('x', b'y')], [('x', b'y'), ('x/a', b'x')]]:
            self.bad('duplicate-entry', pack(entries))
        link = zipfile.ZipInfo('shortcut')
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        self.bad('unsafe-path', pack([(link, b'../public')]))
        alt = zipfile.ZipInfo('public-file')
        hidden = struct.pack('<BI', 1, v.zlib.crc32(b'public-file')) + b'renamed-file'
        alt.extra = struct.pack('<HH', 0x7075, len(hidden)) + hidden
        self.bad('unsafe-path', pack([(alt, b'fixture')]))
        special = bytearray(pack([('public', b'fixture')]))
        center = special.index(b'PK\x01\x02')
        for at in (6, center + 8):
            struct.pack_into('<H', special, at, 1)
        self.bad('zip-format', bytes(special))
        renamed = pack([('not-a-zip.zip', b'not zip')])
        self.bad('zip-format', renamed)
        self.bad('zip-format', pack([('prefixed.data', b'prefix' + pack([('x', b'fixture')]))]))
        self.bad('zip-format', pack([('file', b'f')]) + b'trailing')
        self.bad('zip-format', pack(comment=b'PK\x06\x07'))
        self.bad('gzip-format', pack([('g.gz', gzip.compress(b'x')[:-4])]))
        self.bad('unsupported-container', pack([('blind.data', b'7z\xbc\xaf\x27\x1c' + b'fixture')]))
        blob = pack([('name', b'visible-hidden')])
        cd = blob.index(b'PK\x01\x02')
        forged = bytearray(blob)
        for offset in (22, cd + 24):
            struct.pack_into('<I', forged, offset, 7)
        for offset in (14, cd + 16):
            struct.pack_into('<I', forged, offset, v.zlib.crc32(b'visible'))
        self.bad('zip-format', bytes(forged))

    def test_redacted_errors_and_descriptors(self):
        class Pipe(io.BytesIO):
            def seek(self, *args):
                raise io.UnsupportedOperation()
        self.ok(pack([('file', b'fixture')], sink=Pipe()))
        first, second = pack(), pack([('do-not-print-operator.pem', b'not-a-key')])
        self.bad('private-path', first, second, index=2, names=['demo.zip', 'do-not-print-path.zip'])
        self.bad('arguments', first, index=0, args=['--unexpected-do-not-print'])
        self.bad('invalid-input', first, index=0, args=['--sums', 'missing-do-not-print'])
        real_zip = zipfile.ZipFile
        def noisy_reader(*args, **kwargs):
            warnings.warn('do-not-print-member-name', UserWarning)
            return real_zip(*args, **kwargs)
        with warnings.catch_warnings(), patch.object(v.zipfile, 'ZipFile', noisy_reader):
            warnings.simplefilter('always')
            self.ok(first)


if __name__ == '__main__':
    unittest.main()
