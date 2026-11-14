"""Verify all ZIPs named in --sums without extracting anything to disk.

--shell-manifest is the trusted public checkout's android/patchers/supported.json,
not a file taken from the ZIP. --sensitive-file is caller-managed binary data:
one literal per LF/CRLF line (caller controls its Windows ACL). For native helpers,
--helper-sums supplies their SHA-256 records from an independent public baseline.
Package 0 denotes a control-file/argument error.
"""

import argparse
import hashlib
import io
import json
import os
import re
import stat
import struct
import sys
import unicodedata
import warnings
import zipfile
import zlib
from itertools import chain
from pathlib import Path

MIB = 1 << 20
BLOCK = TEXT = 64 << 10
MAX_ZIP, MAX_MEMBER, MAX_BUFFER = 256 * MIB, 128 * MIB, 32 * MIB
MAX_DEPTH, MAX_ENTRIES, MAX_DIRECTORY = 4, 20000, 2 * MIB
MAX_PACKAGES, MAX_RULES, MAX_LITERAL = 16, 128, 4096
SHELL = 'android/dist/grokbot-android-shell.apk'
MANIFEST = 'android/patchers/supported.json'
HELPERS = {'windows/dist/network/grokbot-tailcat.exe', 'windows/dist/installer/grokbot-setup-stub.exe',
           'host/bin/grokbot-tailcat', 'host/bin/linux-arm64/grokbot-tailcat',
           'mac/dist/network/grokbot-tailcat', 'ios/bin/GrokBotLocal.dylib'}
PRIVATE = set(('.git .cache .ssh .gnupg .aws .azure .kube .codex .grokbot-local .netrc .npmrc '
               '.private private secrets .secrets credentials .credentials host-data box-home box-workspace '
               'backups .gradle .grokbot .docker .envrc android-signing.json auth.json model.env setup-key credentials.json secrets.json').split())
KEY_FILES = ('.key', '.pem', '.p8', '.pk8', '.pkcs8', '.p12', '.pfx', '.ppk', '.jks', '.keystore', '.mobileprovision')
NOTES = re.compile(r'access[ ._-]*(?:notes?|details?|info|records?|credentials?)|(?:server|ssh)[ ._-]*(?:access|login|notes?|credentials?|details?)|'
                   r'^(?:access|ssh|login)(?:[ ._-]*notes?)?\.|\u8bbf\u95ee|\u767b\u5f55|\u51ed\u636e|\u5bc6\u7801|\u79c1\u94a5|\u670d\u52a1\u5668|'
                   r'\u63a5\u5165(?:\u4fe1\u606f|\u8bf4\u660e|\u914d\u7f6e)')
PRIVATE_DIR = re.compile(r'(?:^|[._ -])(?:private|secrets?|credentials?)(?:$|[._ -])|\u79c1\u5bc6|\u79c1\u6709|\u9690\u79c1|\u673a\u5bc6|'
                         r'\u5c40\u57df\u7f51(?:\u5c0f)?\u4e3b\u673a')
ARMOR = re.compile(rb'-----BEGIN (?:(?:RSA |DSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----|PuTTY-User-Key-File-[23]:')
OPENSSH = re.compile(rb'openssh-key-v1\x00\x00\x00\x00[\x01-\x40][a-z0-9@._-]{1,64}\x00\x00\x00[\x01-\x40]')
PRODUCT = ('.ipa', '.aab', '.apks', '.xapk', '.apkm', '.asar', '.asar.unpacked', '.app', '.dmg', '.pkg', '.msi',
           '.msix', '.appx', '.exe', '.dll', '.dylib', '.appimage', '.hbc', '.pak', '.7z', '.rar', '.tar', '.tgz',
           '.xz', '.bz2', '.zst', '.lz4', '.cab', '.patch.json')
ZIP = (b'PK\x03\x04', b'PK\x05\x06')


class Rejected(Exception):
    pass


def need(ok, category):
    if not ok:
        raise Rejected(category)


def local(path):
    need(not str(path).startswith(('//', '\\\\')) and not path.is_symlink() and path.is_file(), 'input-file')
    return path.open('rb')


def small(opener, path, owned=False):
    with opener(path) as src:
        if owned and opener is local and hasattr(os, 'getuid'):
            need(os.fstat(src.fileno()).st_uid == os.getuid(), 'input-file')
        data = src.read(TEXT + 1)
    need(len(data) <= TEXT, 'input-limit')
    return data


def lines(data):
    *rows, last = data.split(b'\n')
    return [row[:-1] if row.endswith(b'\r') else row for row in rows] + ([last] if last else [])


def literals(data):
    rows = lines(data)
    need(len(rows) <= MAX_RULES and all(len(row) <= MAX_LITERAL for row in rows), 'input-limit')
    values = tuple(dict.fromkeys(filter(None, rows)))
    need(values, 'empty-rules')
    return values


def pathkey(name):
    key = unicodedata.normalize('NFKC', name).casefold()
    parts = key.split('/')
    need(len(key) <= 1024 and len(parts) <= 64, 'input-limit')
    need(not re.search(r'[\\:<>"|?*\x00-\x1f\x7f]|(?:^|/)(?:con|aux|prn|nul|com[1-9]|lpt[1-9])(?:[./]|$)', key)
         and all(p and not p.endswith(('.', ' ')) for p in parts), 'unsafe-path')
    return key


def path_policy(name, direct=False, directory=False):
    parts = pathkey(name).split('/')
    leaf = parts[-1]
    need(not (PRIVATE.intersection(parts) or any(PRIVATE_DIR.search(p) or NOTES.search(p) for p in (parts if directory else parts[:-1]))
              or leaf.endswith(KEY_FILES) or re.match(r'^id_(?:rsa|dsa|ecdsa|ed25519)(?:$|\.(?!pub$))', leaf)
              or any(p.startswith('.env') and p not in ('.env.example', '.env.sample', '.env.template') for p in parts)
              or (NOTES.search(leaf) and ('.' not in leaf or leaf.endswith(('.txt', '.md', '.json', '.log', '.ini', '.yaml', '.yml', '.csv', '.pdf', '.xlsx', '.docx'))))), 'private-path')
    need(not any(p in ('output', '.output', 'outputs', 'win-unpacked', 'original', 'originals', 'official', 'official-inputs') or
                 p.endswith(('.app', '.asar.unpacked', '.noindex')) for p in parts) and
         not any(p.endswith(('.apk', '.ipa', '.asar')) for p in parts[:-1]), 'client-program')
    need(not leaf.endswith('.apk') or (direct and not directory and name == SHELL), 'apk')
    helper = direct and not directory and helper_path(name)
    need(helper or not (leaf.endswith(PRODUCT) or ('portable' in leaf and leaf.endswith('.zip'))), 'client-program')
    return helper


def helper_path(name):
    return name in HELPERS or (name.startswith('ios/clients/ios/audio-processing/') and name.endswith('.a'))


def pin(data):
    def unique(pairs):
        obj = dict(pairs)
        need(len(obj) == len(pairs), 'shell-manifest')
        return obj
    try:
        shell = json.loads(data, object_pairs_hook=unique)['shell']
        digest = shell['sha256']
        need(shell['path'] == SHELL and isinstance(digest, str) and re.fullmatch('[0-9a-f]{64}', digest), 'shell-manifest')
        return digest
    except (ValueError, TypeError, KeyError, RecursionError):
        raise Rejected('shell-manifest') from None


def checksums(data, helpers=False):
    sums, keys = {}, set()
    for row in lines(data):
        m = re.fullmatch(rb'([0-9a-fA-F]{64}) [ *](.+)', row)
        need(m, 'checksum-format')
        name = m[2].decode('utf-8')
        key = pathkey(name)
        need((helper_path(name) if helpers else '/' not in key) and key not in keys, 'checksum-set')
        sums[name] = m[1].decode('ascii').lower()
        keys.add(key)
    return sums


def blocks(src):
    return iter(lambda: src.read(BLOCK), b'')


def directory(src, remaining, shell):
    # Bound the directory BEFORE ZipFile allocates one object per entry.
    size = src.seek(0, 2)
    start = max(0, size - (65535 + 22 + 20))
    src.seek(start)
    tail = src.read(size - start)
    i = tail.rfind(ZIP[1])
    need(i >= 0 and i + 22 <= len(tail), 'zip-format')
    disk, cd_disk, count_disk, count, length, offset, comment = struct.unpack_from('<4H2IH', tail, i + 4)
    need(not (disk or cd_disk) and count_disk == count and offset + length == start + i and
         i + 22 + comment == len(tail) and tail[max(0, i-20):i-16] != b'PK\x06\x07', 'zip-format')
    # Reject a second apparent ZIP64 locator (including within a crafted comment)
    # before delegating end-record discovery to different stdlib versions.
    need(b'PK\x06\x07' not in tail[i+22:i+22+comment], 'zip-format')
    need(count <= remaining and length <= MAX_DIRECTORY, 'input-limit')
    if offset >= 24:
        src.seek(offset - 24)
        n, magic = struct.unpack('<Q16s', src.read(24))
        if magic == b'APK Sig Block 42':
            need(shell, 'apk')
            need(24 <= n <= offset - 8, 'zip-format')
            offset -= n + 8
            src.seek(offset)
            need(src.read(8) == struct.pack('<Q', n), 'zip-format')
    return count, offset


def zip_extra(data):
    pos = 0
    while pos + 4 <= len(data):
        kind, size = struct.unpack_from('<HH', data, pos)
        need(kind not in (0x7075, 0x756e, 0x000d), 'unsafe-path')  # Alternate pathname/link metadata.
        need(kind != 1 and pos + 4 + size <= len(data), 'zip-format')  # ZIP64 not needed at these limits.
        pos += 4 + size
    need(not any(data[pos:]), 'zip-format')  # zipalign may append zero padding.


def zip_chunks(src, info, end):
    # ZipExtFile truncates decoded output to the declared size. Independently
    # require exact Deflate EOF, actual size and CRC, including data descriptors.
    src.seek(info.header_offset)
    local = src.read(30)
    need(len(local) == 30 and local.startswith(ZIP[0]), 'zip-format')
    _, flags, method, _, _, crc, packed, size, n, x = struct.unpack_from('<5H3I2H', local, 4)
    need((flags, method) == (info.flag_bits, info.compress_type) and not flags & ~(0x80e) and
         method in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED), 'zip-format')
    need(src.read(n).decode('utf-8' if flags & 2048 else 'cp437') == info.orig_filename, 'zip-format')
    zip_extra(info.extra)
    zip_extra(src.read(x))
    expected = (info.CRC, info.compress_size, info.file_size)
    descriptor = end - src.tell() - info.compress_size
    if flags & 8:
        need(descriptor in (12, 16) and all(v in (0, ref) for v, ref in zip((crc, packed, size), expected)), 'zip-format')
    else:
        need(descriptor == 0 and (crc, packed, size) == expected, 'zip-format')
    decoder = zlib.decompressobj(-15) if method else None
    left, actual, checksum = info.compress_size, 0, 0
    while left:
        part = src.read(min(BLOCK, left))
        need(part, 'zip-format')
        left -= len(part)
        while part:
            out = decoder.decompress(part, BLOCK) if decoder else part
            part = decoder.unconsumed_tail if decoder else b''
            need(not decoder or not decoder.unused_data, 'zip-format')
            actual += len(out)
            need(actual <= info.file_size, 'zip-format')
            checksum = zlib.crc32(out, checksum)
            if out:
                yield out
    need((not decoder or decoder.eof) and (checksum, actual) == (info.CRC, info.file_size), 'zip-format')
    if descriptor:
        desc = src.read(descriptor)
        need(len(desc) == descriptor and (descriptor == 12 or desc.startswith(b'PK\x07\x08')) and
             struct.unpack('<3I', desc[-12:]) == expected, 'zip-format')


class Scan:
    def __init__(self, values, trusted, helpers, budget):
        self.values, self.trusted, self.helpers, self.left = values, trusted, helpers, budget
        self.overlap = max([96] + [len(v) - 1 for v in values])
        self.entries = MAX_ENTRIES

    def match(self, data):
        need(not any(v in data for v in self.values), 'sensitive-bytes')
        if b'openssh-key-v1\0' in data:
            need(not OPENSSH.search(data), 'private-key')
        if b'-----BEGIN ' in data or b'PuTTY-User-Key-File-' in data:
            need(not ARMOR.search(data), 'private-key')

    def checked(self, chunks, cap):
        tail = b''
        for chunk in chunks:
            cap -= len(chunk)
            self.left -= len(chunk)
            need(min(cap, self.left) >= 0, 'input-limit')
            window = tail + chunk
            self.match(window)
            tail = window[-self.overlap:]
            yield chunk

    def gunzip(self, data):
        # Screen every original name; concatenated members form ONE decoded stream.
        pos = 0
        while pos < len(data):
            self.entries -= 1
            need(self.entries >= 0, 'input-limit')
            need(data[pos:pos+3] == b'\x1f\x8b\x08' and pos + 10 <= len(data), 'gzip-format')
            flags, p = data[pos+3], pos + 10
            if flags & 4:
                need(p + 2 <= len(data), 'gzip-format')
                p += 2 + int.from_bytes(data[p:p+2], 'little')
            if flags & 8:
                end = data.find(b'\0', p, p + 1025)
                need(end >= p, 'gzip-format')
                original = data[p:end]
                try:
                    name = original.decode('utf-8')
                except UnicodeDecodeError:
                    name = original.decode('latin-1')
                if name:
                    path_policy(name)
            decoder = zlib.decompressobj(31)
            while not decoder.eof:
                part = data[pos:pos+BLOCK]
                need(part, 'gzip-format')
                out = decoder.decompress(part, BLOCK)
                used = len(part) - len(decoder.unused_data if decoder.eof else decoder.unconsumed_tail)
                need(out or used > 0, 'gzip-format')
                pos += used
                if out:
                    yield out

    def member(self, chunks, name, depth, declared=None):
        helper = path_policy(name, direct=depth == 1)
        it = self.checked(chunks, MAX_MEMBER)
        head = b''
        while len(head) < 512:
            chunk = next(it, b'')
            if not chunk:
                break
            head += chunk
        key = pathkey(name)
        mach = head[:4] in (b'\xcf\xfa\xed\xfe', b'\xfe\xed\xfa\xcf', b'\xce\xfa\xed\xfe', b'\xfe\xed\xfa\xce')
        fat = head[:4] in (b'\xca\xfe\xba\xbf', b'\xbf\xba\xfe\xca', b'\xbe\xba\xfe\xca') or (
            head[:4] == b'\xca\xfe\xba\xbe' and 0 < int.from_bytes(head[4:8], 'big') < 32)  # Java shares this magic.
        need(helper or not (head.startswith((b'MZ', b'\x7fELF')) or mach or fat), 'client-program')
        need(not (head.startswith((b'7z\xbc\xaf\x27\x1c', b'Rar!\x1a\x07', b'\xfd7zXZ\x00', b'BZh', b'xar!', b'MSCF', b'\x28\xb5\x2f\xfd', b'\x04\x22\x4d\x18')) or
                  head[257:262] == b'ustar'), 'unsupported-container')
        is_zip, is_gz = head.startswith(ZIP), head.startswith(b'\x1f\x8b')
        need(not key.endswith(('.zip', '.jar', '.apk', '.aar')) or is_zip, 'zip-format')
        need(not key.endswith(('.gz', '.gzip')) or is_gz, 'gzip-format')
        manifest = depth == 1 and name == MANIFEST
        shell = depth == 1 and name == SHELL
        need(not shell or self.trusted, 'shell-manifest')
        cap = TEXT if manifest else MAX_BUFFER if is_zip or is_gz else MAX_MEMBER
        need(declared is None or declared <= cap, 'input-limit')
        need(not (is_zip or is_gz) or depth <= MAX_DEPTH, 'input-limit')
        need(not helper or name in self.helpers, 'helper-digest')
        helper_hash = hashlib.sha256() if helper else None
        buf = io.BytesIO() if manifest or is_zip or is_gz else None
        size, tail = 0, b''
        for part in chain((head,), it):
            size += len(part)
            need(size <= cap, 'input-limit')
            if buf is not None:
                buf.write(part)
            elif not helper:
                tail = (tail + part)[-65557:]  # Detect prefixed/SFX ZIPs even with a non-archive name.
            if helper:
                helper_hash.update(part)
        need(declared is None or size == declared, 'zip-format')
        need(ZIP[1] not in tail or not zipfile.is_zipfile(io.BytesIO(tail)), 'zip-format')
        need(tail[-512:-504] != b'koly\0\0\0\x04', 'client-program')  # UDIF disk image trailer.
        need(not helper or helper_hash.hexdigest() == self.helpers[name], 'helper-digest')
        if manifest:
            self.packed_pin = pin(buf.getvalue())
        if shell:
            need(hashlib.sha256(buf.getbuffer()).hexdigest() == self.trusted, 'shell-digest')
            self.has_shell = True
        if is_zip:
            self.zip(buf, depth, shell)
        elif is_gz:
            inner = name.rsplit('.', 1)[0] if key.endswith(('.gz', '.gzip')) else name
            self.member(self.gunzip(buf.getvalue()), inner, depth + 1)

    def zip(self, src, depth, shell=False):
        count, cd_start = directory(src, self.entries, shell)
        self.entries -= count
        seen = {}
        with warnings.catch_warnings():
            warnings.simplefilter('ignore')  # Library warnings on hostile metadata can echo paths.
            archive = zipfile.ZipFile(src)
        with archive:
            infos = sorted(archive.infolist(), key=lambda i: i.header_offset)
            need(len(infos) == count and (infos[0].header_offset if infos else cd_start) == 0, 'zip-format')
            for i, info in enumerate(infos):
                name = info.orig_filename[:-1] if info.is_dir() else info.orig_filename
                key = pathkey(name)
                self.match(name.encode('utf-8'))
                need(key not in seen, 'duplicate-entry')
                seen[key] = info.is_dir()
                need(key != 'androidmanifest.xml' or shell, 'apk')
                mode = stat.S_IFMT(info.external_attr >> 16)
                need(mode in (0, stat.S_IFDIR if info.is_dir() else stat.S_IFREG), 'unsafe-path')
                need(info.file_size <= min(MAX_MEMBER, self.left), 'input-limit')
                end = infos[i+1].header_offset if i + 1 < count else cd_start
                chunks = zip_chunks(src, info, end)
                if info.is_dir():
                    path_policy(name, direct=depth == 0, directory=True)
                    need(info.file_size == 0 and next(chunks, None) is None, 'zip-format')
                else:
                    self.member(chunks, name, depth + 1, info.file_size)
        for key in seen:
            while '/' in key:
                key = key.rsplit('/', 1)[0]
                need(seen.get(key, True), 'duplicate-entry')
        need(not shell or seen.get('androidmanifest.xml') is False, 'apk')

    def package(self, src, digest):
        self.packed_pin, self.has_shell = None, False
        need(src.seek(0, 2) <= min(MAX_ZIP, self.left), 'input-limit')
        src.seek(0)
        need(src.read(4) in ZIP, 'zip-format')
        src.seek(0)
        h = hashlib.sha256()
        for chunk in self.checked(blocks(src), MAX_ZIP):
            h.update(chunk)
        need(h.hexdigest() == digest, 'checksum-digest')
        self.zip(src, 0)
        if self.has_shell or self.packed_pin is not None:
            need(self.has_shell and self.packed_pin == self.trusted, 'shell-manifest')


class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise Rejected('arguments')  # argparse's default echoes untrusted arguments.


def main(argv=None, opener=local):
    index = 0
    try:
        parser = Parser(prog='verify-release', description=__doc__, allow_abbrev=False)
        parser.add_argument('--sums', required=True, type=Path)
        parser.add_argument('--sensitive-file', type=Path)
        parser.add_argument('--shell-manifest', type=Path)
        parser.add_argument('--helper-sums', type=Path)
        parser.add_argument('--budget-mib', type=int, default=1024, help='total raw plus decoded MiB (1..2048)')
        parser.add_argument('archives', nargs='+', type=Path)
        args = parser.parse_args(argv)
        need(1 <= args.budget_mib <= 2048 and len(args.archives) <= MAX_PACKAGES, 'input-limit')
        values = literals(small(opener, args.sensitive_file, owned=True)) if args.sensitive_file else ()
        trusted = pin(small(opener, args.shell_manifest)) if args.shell_manifest else None
        helpers = checksums(small(opener, args.helper_sums), True) if args.helper_sums else {}
        scan = Scan(values, trusted, helpers, args.budget_mib * MIB)
        raw = small(opener, args.sums)
        scan.match(raw)
        sums = checksums(raw)
        names = [p.name for p in args.archives]
        need(len(names) == len(sums) and set(names) == sums.keys(), 'checksum-set')
        for index, path in enumerate(args.archives, 1):
            path_policy(path.name)
            need(path.suffix.casefold() == '.zip', 'zip-format')
            with opener(path) as src:
                scan.package(src, sums[path.name])
    except Rejected as exc:
        category = exc.args[0]
    except KeyboardInterrupt:
        category = 'interrupted'
    except Exception:
        category = 'invalid-input'  # Library and filesystem errors can contain names or data.
    else:
        print('verified packages=%d' % len(names))
        return 0
    print('category=%s package=%d' % (category, index), file=sys.stderr)
    return 1


if __name__ == '__main__':
    sys.exit(main())
