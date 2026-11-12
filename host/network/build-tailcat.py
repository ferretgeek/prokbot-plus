#!/usr/bin/env python3
"""Build the pinned transport for host/desktop or an iOS static archive."""
import argparse
import os
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--target', choices=['native', 'linux-amd64', 'linux-arm64', 'windows-amd64', 'ios-arm64'], default='native')
parser.add_argument('--output', type=Path, default=ROOT / 'dist/network')
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True)
env = os.environ.copy()
tags = 'ts_omit_ssh,ts_omit_logtail,ts_omit_netlog,ts_omit_capture,ts_omit_clientmetrics,ts_omit_usermetrics,ts_omit_portmapper,ts_omit_webclient'
command = ['go', 'build', '-trimpath', '-tags', tags]
if args.target == 'ios-arm64':
    sdk = subprocess.check_output(['xcrun', '--sdk', 'iphoneos', '--show-sdk-path'], text=True).strip()
    env.update(GOOS='ios', GOARCH='arm64', CGO_ENABLED='1', CC='clang',
               CGO_CFLAGS=f'-arch arm64 -isysroot {sdk} -miphoneos-version-min=15.1',
               CGO_LDFLAGS=f'-arch arm64 -isysroot {sdk} -miphoneos-version-min=15.1')
    command += ['-buildmode=c-archive', '-o', str(args.output.resolve() / 'libGrokTailcat.a'), './mobile']
else:
    name = 'grokbot-tailcat'
    if args.target.startswith('linux-'):
        env.update(GOOS='linux', GOARCH=args.target.split('-')[1], CGO_ENABLED='0')
    elif args.target == 'windows-amd64':
        env.update(GOOS='windows', GOARCH='amd64', CGO_ENABLED='0')
        name += '.exe'
    elif args.target == 'native' and os.name == 'nt':
        name += '.exe'
    command += ['-ldflags=-s -w', '-o', str(args.output.resolve() / name), './cmd/grokbot-tailcat']
subprocess.run(command, cwd=ROOT / 'network/tailcat', env=env, check=True)
