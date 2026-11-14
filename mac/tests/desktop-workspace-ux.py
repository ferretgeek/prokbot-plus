"""Optional native Windows UX fixture. Supply a project-built, pinned 0.71.2 portable folder."""
import argparse
from collections import Counter
from contextlib import contextmanager
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import hashlib
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import tempfile
import threading
import time
import sys
from urllib.parse import urlsplit, unquote
from urllib.request import build_opener, ProxyHandler

from playwright.sync_api import expect, sync_playwright


REPO = Path(__file__).resolve().parents[2]
AGENT = {'id': 'ux-fixture', 'name': 'Workspace Demo', 'title': '', 'description': '', 'role': 'assistant',
         'harness': 'temporal', 'avatarShape': 'circle', 'avatarColor': 'blue', 'status': 'idle'}


def digest(path):
    with path.open('rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()


def verify(app):
    pins = json.loads((REPO / 'windows/patchers/desktop/supported.json').read_text('utf-8'))
    marker = json.loads((app / 'resources/grokbot-local.patch.json').read_text('utf-8'))
    assert marker['version'] == pins['version'] == '0.71.2' and marker['originalAsarSha256'] == pins['asarSha256']
    assert marker['executable']['originalSha256'] == pins['exeSha256'] and digest(app / 'Grok Bot.exe') == marker['executable']['patchedSha256']
    assert digest(app / 'resources/app.asar') == marker['patchedAsarSha256']
    # Do not run an older patched package that registers protocols/shortcuts even in test profiles.
    script = """const {createRequire}=require('node:module'),path=require('node:path');
const asar=createRequire(path.resolve('mac/patchers/desktop/package.json'))('@electron/asar');
const read=n=>asar.extractFile(process.argv[1],path.join('local-client',n)).toString();
const main=read('main.mjs'), platform=read('platform.mjs');
if(!main.includes('canRegisterDesktopIntegration({ isolatedProfile })')||!platform.includes('if (isolatedProfile) return false;')||
!main.includes('if (registerIntegration &&')||!main.includes('if (registerIntegration) ensureStartMenuShortcut'))process.exit(1);"""
    subprocess.run(['node', '-e', script, str(app / 'resources/app.asar')], cwd=REPO, check=True)
    return marker['patchedAsarSha256']


class Fixture(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        if not isinstance(sys.exception(), (ConnectionResetError, ConnectionAbortedError, BrokenPipeError)):
            super().handle_error(request, client_address)

    def __init__(self):
        super().__init__(('127.0.0.1', 0), Request)
        self.origin = f'http://127.0.0.1:{self.server_port}'
        self.stop = threading.Event()
        self.token = secrets.token_hex(24)
        self.key = secrets.token_hex(3).upper()
        self.calls, self.sends = Counter(), []
        columns = [f'Column {n:02}' for n in range(1, 33)]
        md = 'Table fixture\n\n' + '\n'.join('| ' + ' | '.join(c) + ' |' for c in
                    [columns, ['---'] * len(columns), [f'WideDemoCell{n:02}' for n in range(1, 33)]])
        now = int(time.time() * 1000)
        self.entries = [{'id': 'fixture-table', 'seq': 1, 'kind': 'send-message', 'timestampMs': now,
                         'message': {'type': 'text', 'content': md}}]

    def reply(self, path, body):
        method = path.removeprefix('/api/')
        self.calls[method] += 1
        if path == '/connect/pair':
            assert body.get('pairingKey') == self.key
            return {'deviceId': 'fixture-device', 'token': self.token, 'gatewayUrl': self.origin}
        if path == '/connect/status':
            return {'deviceId': 'fixture-device'}
        if path == '/local/profile':
            return {'displayName': 'Fixture User', 'hostName': 'Fixture Host'}
        if path == '/local/voice/status':
            return {'enabled': False}
        if method == 'listAgents':
            return [AGENT]
        if method in ('getAgentTranscriptTail', 'openAgentTail'):
            return {'entries': self.entries, 'nextBeforeSeq': None, 'cloudAgentPeerIds': []}
        if method == 'getMcpState':
            return {'servers': []}
        if method == 'sendPrompt':
            self.sends.append(body)
            return {'accepted': True}
        if method == 'promptAcceptanceStatus':
            return {'outcome': 'not_found'}
        if method.startswith('list') or method in ('skillsCatalog', 'getMcpCatalog', 'getTrays', 'getEffectiveMcpPlugins',
                    'getAsyncTasks', 'getSubagents', 'getAgentWorkflows'):
            return []
        return {} if method.startswith('get') else None


class Request(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def respond(self):
        path = urlsplit(self.path).path
        try:
            if path in ('/events', '/notifications/events'):
                self.send_response(200); self.send_header('Content-Type', 'text/event-stream'); self.end_headers()
                while not self.server.stop.is_set():
                    self.wfile.write(b': fixture heartbeat\n\n'); self.wfile.flush()
                    self.server.stop.wait(1)
                return
            body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))) or b'{}')
            value = self.server.reply(path, body)
            data = json.dumps(value).encode()
            self.send_response(200); self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data))); self.end_headers(); self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass

    do_GET = do_POST = respond


def wait_for(fn, seconds=20):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        value = fn()
        if value:
            return value
        time.sleep(0.12)
    raise TimeoutError('Fixture condition not reached')


@contextmanager
def workspace(app):
    with tempfile.TemporaryDirectory(prefix='prokbot-workspace-ux-') as tmp, Fixture() as fixture, sync_playwright() as pw:
        thread = threading.Thread(target=fixture.serve_forever, daemon=True); thread.start()
        with socket.socket() as reserve:
            reserve.bind(('127.0.0.1', 0)); port = reserve.getsockname()[1]
        home = Path(tmp)
        env = {k: os.environ[k] for k in ('SystemRoot', 'WINDIR', 'COMSPEC', 'SystemDrive') if k in os.environ}
        for key, child in [('APPDATA', 'roaming'), ('LOCALAPPDATA', 'local'), ('TEMP', 'tmp'), ('TMP', 'tmp'),
                           ('USERPROFILE', 'home'), ('HOME', 'home'), ('GROKBOT_LOCAL_TEST_PROFILE', 'profile')]:
            d = home / child; d.mkdir(exist_ok=True); env[key] = str(d)
        env.update(PATH=str(Path(env['SystemRoot']) / 'System32'), GROKBOT_LOCAL_DEBUG_PORT=str(port))
        proc = subprocess.Popen([str(app / 'Grok Bot.exe'), '--disable-gpu', '--disable-gpu-shader-disk-cache', '--disable-background-networking', '--no-first-run', '--lang=en-US',
                                 '--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=127.0.0.1;localhost'], cwd=home,
                                env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            address = f'http://127.0.0.1:{port}'
            opener = build_opener(ProxyHandler({}))
            def ready():
                if proc.poll() is not None:
                    raise RuntimeError(f'isolated app exited: {proc.returncode}')
                try:
                    with opener.open(address + '/json/version', timeout=0.5) as response:
                        return response.status == 200
                except OSError:
                    return False
            wait_for(ready)
            browser = pw.chromium.connect_over_cdp(address)
            def local_page(suffix):
                for page in browser.contexts[0].pages:
                    url = urlsplit(page.url)
                    if url.scheme == 'file' and unquote(url.path).lower().endswith(suffix):
                        assert app.name.lower() + '/resources/app.asar/' in unquote(url.path).lower()
                        return page
            pairing = wait_for(lambda: local_page('/local-client/connect.html'))
            pairing.locator('#server').fill(fixture.origin); pairing.locator('#key').fill(fixture.key)
            pairing.get_by_role('button', name='Connect', exact=True).click()
            def workspace_page():
                for item in browser.contexts[0].pages:
                    if not item.is_closed():
                        try:
                            item.wait_for_timeout(100)
                        except Exception:
                            pass
                return local_page('/dist/renderer/index.html')
            try:
                page = wait_for(workspace_page, 25)
            except TimeoutError:
                print('fixture calls:', dict(fixture.calls), 'windows:', [p.url for p in browser.contexts[0].pages],
                      'status:', pairing.locator('#status').inner_text() if not pairing.is_closed() else '(closed)', flush=True)
                raise
            page.set_default_timeout(8000)
            page.on('console', lambda msg: print('renderer:', msg.text[:850], flush=True) if msg.type == 'error' else None)
            page.on('pageerror', lambda err: print('page error:', str(err)[:500], flush=True))
            page.get_by_role('button', name=AGENT['name']).first.click()
            expect(page.locator('.sand-prompt-form [contenteditable="true"]').first).to_be_visible()
            yield page, fixture, browser.version
        finally:
            if proc.poll() is None:
                subprocess.run(['taskkill.exe', '/PID', str(proc.pid), '/T', '/F'], capture_output=True, timeout=15)
            proc.wait(timeout=15)
            fixture.stop.set(); fixture.shutdown(); thread.join(timeout=5)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('app', type=Path)
    args = parser.parse_args()
    app = args.app.resolve(); print('verified ASAR:', verify(app), flush=True)
    with workspace(app) as (page, fixture, version):
        print('Chromium', version, 'workspace:', page.locator('body').aria_snapshot()[:4800], flush=True)
        print('tables', page.locator('table').count(), 'calls', list(fixture.calls), flush=True)


if __name__ == '__main__':
    main()
