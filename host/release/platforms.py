"""Deployment platform policy. Detect the Docker daemon, not the CLI machine."""
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
INPUTS = json.loads((ROOT / 'recipes/host/manifest.json').read_text(encoding='utf-8'))
BOX = INPUTS['box']


def host_platform(os_name, architecture):
    arch = {'amd64': 'amd64', 'x86_64': 'amd64', 'arm64': 'arm64', 'aarch64': 'arm64'}.get(architecture.lower())
    if os_name.lower() != 'linux' or not arch:
        raise ValueError(f'Unsupported Docker server: {os_name}/{architecture}. Use 64-bit Linux (amd64 or arm64).')
    return 'linux/' + arch


def docker_platform():
    result = subprocess.run(['docker', 'info', '--format', '{{.OSType}}/{{.Architecture}}'],
                            check=True, text=True, stdout=subprocess.PIPE, stdin=subprocess.DEVNULL)
    return host_platform(*result.stdout.strip().split('/', 1))


def check_box_execution(platform):
    if platform == BOX['platform']:
        return
    # Probe a real amd64 process before downloading the much larger desktop. No host mounts or privileges.
    cmd = ['docker', 'run', '--rm', '--platform', BOX['platform'], '--network', 'none', '--read-only',
           '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', 'busybox:1.37', 'uname', '-m']
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, stdin=subprocess.DEVNULL, timeout=120)
    except subprocess.TimeoutExpired:
        raise ValueError('amd64 probe timed out. Check access to busybox:1.37 and binfmt, or choose a separate execution node.') from None
    if result.returncode or result.stdout.strip() != 'x86_64':
        detail = result.stderr.strip().splitlines()[-1:] or [result.stdout.strip() or 'no output']
        raise ValueError('amd64 desktop probe failed: ' + detail[0] + '. Check registry access and Linux '
                         'binfmt/QEMU x86-64 support, or use a separate amd64 execution node (host-only mode).')
