#!/usr/bin/env python3
"""Build a local Host image from project patches and user-owned original resources."""
import argparse
import hashlib
import json
import re
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
BOX = 'public.ecr.aws/k0i0n2g5/cursorenvironments/universal@sha256:73c04dc8722de013fb2ad99366171e3a4c7379f1253d127348a5047d13f0ed41'
BOX_ID = 'sha256:1bdd316ac812b6647fe1163e97f200b99edb155b97d927727e85dc0c5ea3cd6f'
BOX_MANIFEST = BOX.split('@', 1)[1]
# The classic image store reports the config digest as the image ID; the containerd
# image store (default on new Docker 29+ installs) reports the pinned manifest digest.
BOX_IDENTITIES = {BOX_ID, BOX_MANIFEST}
BOX_TAG = 'grokbot-box-input:9d2ac1b'


def run(*args, **kwargs):
    subprocess.run(args, check=True, **kwargs)


def image_id(reference):
    probe = subprocess.run(['docker', 'image', 'inspect', reference, '--format', '{{.Id}}'], capture_output=True, text=True)
    return probe.stdout.strip() if probe.returncode == 0 else None


def load_verified_archive(path):
    """Verify a docker-save archive by its config digest, independent of the Docker image store."""
    with tarfile.open(path, 'r:*') as archive:
        names = {member.name.lstrip('./'): member for member in archive}
        entries = json.load(archive.extractfile(names['manifest.json']))
        if len(entries) != 1:
            raise ValueError('Box archive must contain exactly one image')
        config = archive.extractfile(names[entries[0]['Config'].lstrip('./')]).read()
    if 'sha256:' + hashlib.sha256(config).hexdigest() != BOX_ID:
        raise ValueError('Unsupported Box archive identity')
    loaded = subprocess.run(['docker', 'load', '-i', str(path)], check=True, capture_output=True, text=True).stdout
    match = re.search(r'Loaded image(?: ID)?: (\S+)', loaded)
    if not match:
        raise ValueError('Docker did not report the loaded Box image')
    return match.group(1)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host-archive', type=Path)
    parser.add_argument('--box-archive', type=Path, help='Optional original docker-save tar or tar.gz')
    parser.add_argument('--box-only', action='store_true', help='Prepare the verified Box image for a standalone execution node')
    parser.add_argument('--image', default='grokbot-host:local')
    parser.add_argument('--base-image', default='grokbot-patch-base:local')
    args = parser.parse_args()
    manifest = json.loads((ROOT / 'recipes/host/manifest.json').read_text())
    started = time.monotonic()
    if args.box_archive:
        source = load_verified_archive(args.box_archive.resolve())
        identity = image_id(source)
    else:
        source = next((reference for reference in (BOX, BOX_TAG, BOX_ID) if image_id(reference) in BOX_IDENTITIES), None)
        if not source:
            run('docker', 'pull', '--platform', 'linux/amd64', BOX)
            source = BOX
        identity = image_id(source)
        if identity not in BOX_IDENTITIES:
            raise ValueError('Unsupported Box image identity')
    # docker-save archives do not retain registry RepoDigests. Give Compose a
    # verified local tag so offline imports do not trigger another registry pull.
    run('docker', 'tag', source, BOX_TAG)
    box_image = BOX_TAG
    if args.box_only:
        print(json.dumps({'boxImage': box_image, 'originalImageId': identity, 'inputSeconds': round(time.monotonic()-started, 3)}))
        return
    with tempfile.TemporaryDirectory(prefix='grokbot-build-') as temporary:
        work = Path(temporary)
        archive = args.host_archive
        if not archive:
            archive = work / 'host.tgz'
            with urllib.request.urlopen(manifest['archive']['url'], timeout=60) as response, archive.open('wb') as target:
                shutil.copyfileobj(response, target)
        if hashlib.sha256(archive.read_bytes()).hexdigest() != manifest['archive']['sha256']:
            raise ValueError('Unsupported Host archive SHA-256')
        input_seconds = time.monotonic()-started
        run('docker', 'build', '--platform', 'linux/amd64', '-f', str(ROOT / 'release/Dockerfile.base'), '-t', args.base_image, str(ROOT))
        base_seconds = time.monotonic()-started-input_seconds
        (work / 'inputs').mkdir()
        shutil.copy2(archive, work / 'inputs/host.tgz')
        run('docker', 'build', '--platform', 'linux/amd64', '-f', str(ROOT / 'release/Dockerfile.host'),
            '--build-arg', f'PATCH_IMAGE={args.base_image}', '--build-arg', f'BOX_IMAGE={box_image}', '-t', args.image, str(work))
    print(json.dumps({'image': args.image, 'boxImage': box_image, 'inputSeconds': round(input_seconds, 3),
        'baseBuildSeconds': round(base_seconds, 3), 'finalBuildSeconds': round(time.monotonic()-started-input_seconds-base_seconds, 3),
        'originalImageId': identity, 'distribution': 'local-only'}))


if __name__ == '__main__':
    main()
