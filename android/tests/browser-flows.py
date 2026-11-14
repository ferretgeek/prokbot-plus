"""Optional Playwright smoke test: python -B android/tests/browser-flows.py /path/to/test.apk.

Loads only the supplied APK's web assets in a disposable Chromium context. Every Host
and native request has a fixture response; no sockets, user profile or device are used.
"""
import argparse
import base64
import json
import mimetypes
from pathlib import Path
import re
from urllib.parse import urlsplit
import zipfile

from playwright.sync_api import expect, sync_playwright


ORIGIN = 'http://127.0.0.1:39710'
HOST = 'https://demo.invalid'
CONNECT = ORIGIN + '/app/client/connect.html'
WORKSPACE = ORIGIN + '/app/renderer/index.html'
CODE = 'DEMO42'
AGENT = {'id': 'demo', 'name': 'Demo Bot', 'title': '', 'description': '', 'role': 'assistant',
         'harness': 'temporal', 'avatarShape': 'circle', 'avatarColor': 'blue', 'status': 'idle'}


class Demo:
    def __init__(self, apk):
        self.assets = apk
        self.connection = {'paired': False, 'server': None, 'error': ''}
        self.settings = {'backgroundNotifications': True, 'theme': 'system', 'language': 'system',
                         'realtimeVoice': False, 'spellCheck': True}
        self.persistence = {}
        self.entries = []
        self.pairs, self.cursors, self.uploads, self.sends, self.external = [], [], [], [], []
        self.fail_settings = False

    def route(self, route):
        url = urlsplit(route.request.url)
        if url.scheme + '://' + url.netloc != ORIGIN:
            self.external.append(url.hostname)
            return route.abort()
        path = url.path
        if path == '/app/client/boot-data.js':
            boot = {'locale': 'en-US', 'systemLocale': 'en-US', 'settings': self.settings,
                    'connection': self.connection, 'persistence': self.persistence,
                    'vncOrigin': 'http://127.0.0.1:39720'}
            return route.fulfill(content_type='text/javascript', body='window.__grokbotAndroidBoot = ' + json.dumps(boot))
        if path.startswith('/app/') or path == '/local-client/icon.png':
            key = 'assets/web/' + ('client/icon.png' if path == '/local-client/icon.png' else path[5:])
            try:
                data = self.assets.read(key)
            except KeyError:
                return route.fulfill(status=404, body='Unknown fixture asset')
            mime = 'text/javascript' if key.endswith(('.mjs', '.js')) else mimetypes.guess_type(key)[0]
            return route.fulfill(body=data, content_type=mime or 'application/octet-stream')
        if path == '/events':
            self.cursors.append(route.request.headers.get('last-event-id'))
            return route.fulfill(content_type='text/event-stream', body=f'id: event-{len(self.cursors)}\ndata: {{}}\n\n')
        body = route.request.post_data_json if route.request.post_data else {}
        if path.startswith('/__native/'):
            result = {'ok': True}
            if path.endswith('/pair'):
                self.pairs.append(body)
                if body == {'server': HOST, 'key': CODE, 'edit': False}:
                    self.connection = {'paired': True, 'server': HOST, 'error': ''}
                else:
                    result = {'ok': False, 'error': 'Pairing code is invalid or expired.'}
            elif path.endswith('/settings'):
                if self.fail_settings:
                    result = {'ok': False, 'error': 'Could not save demo preference.'}
                else:
                    self.settings[body['key']] = body['value']
                    result['settings'] = self.settings
            elif path.endswith('/persistence'):
                for op in body['ops']:
                    if op['op'] == 'remove':
                        self.persistence.pop(op['key'], None)
                    else:
                        self.persistence[op['key']] = op['value']
            elif path.endswith('/disconnect'):
                self.connection = {'paired': False, 'server': None, 'error': ''}
            elif path.endswith('/ready'):
                result = {'pendingAgent': None}
        elif path == '/local/profile':
            result = {'displayName': 'Demo User', 'hostName': 'Demo Host'}
        elif path == '/local/voice/status':
            result = {'enabled': False}
        elif path.startswith('/api/'):
            method = path[5:]
            if method == 'uploadAttachmentChunk':
                self.uploads.append((body['filename'], base64.b64decode(body['bytesBase64'])))
                result = {'committedPath': '/demo/note.txt'}
            elif method == 'listAgents':
                result = [AGENT]
            elif method in ('getAgentTranscriptTail', 'openAgentTail'):
                result = {'entries': self.entries, 'nextBeforeSeq': None, 'cloudAgentPeerIds': []}
            elif method == 'getMcpState':
                result = {'servers': []}
            elif method in ('skillsCatalog', 'getMcpCatalog', 'getTrays', 'getEffectiveMcpPlugins',
                            'getAsyncTasks', 'getSubagents', 'getAgentWorkflows') or method.startswith('list'):
                result = []
            elif method == 'sendPrompt':
                self.sends.append(body)
                result = {'accepted': True}
            elif method == 'promptAcceptanceStatus':
                result = {'outcome': 'not_found'}
            else:
                result = {} if method.startswith('get') else None
        else:
            result = None
        route.fulfill(content_type='application/json', body=json.dumps(result))


def pairing(page, demo):
    page.goto(CONNECT)
    server, key, submit, status = (page.locator('#' + id_) for id_ in ('server', 'key', 'connect', 'status'))
    submit.click()
    expect(server).to_be_focused()
    server.fill('https://demo.invalid')
    key.fill('BAD001')
    submit.click()
    expect(status).to_have_text('Pairing code is invalid or expired.')
    expect(submit).to_be_enabled()
    key.fill('')
    key.focus()
    # insert_text follows the browser's editing path; assigning input.value would not test maxlength.
    page.keyboard.insert_text('\uff24\uff25\uff2d\uff2f\u3000\uff14\uff12')
    expect(key).to_have_value(CODE)
    key.dispatch_event('compositionstart', {'bubbles': True})
    page.locator('#form').evaluate('form => form.requestSubmit()')
    expect(submit).to_be_enabled()
    assert len(demo.pairs) == 1
    key.dispatch_event('compositionend', {'bubbles': True})
    key.press('Enter')
    expect(status).to_contain_text('Connected.')
    assert demo.pairs[-1] == {'server': HOST, 'key': CODE, 'edit': False}
    # The Activity, not JS, normally navigates after pairing. Reload its connection page for settings.
    page.reload()
    server.fill('https://another-demo.invalid')
    submit.click()
    expect(status).to_have_text('Enter a new pairing code to change Host.')
    expect(key).to_be_focused()
    assert len(demo.pairs) == 2, 'changing origin with no code reached the native bridge'
    server.fill(HOST)
    toggle = page.get_by_role('switch')
    demo.fail_settings = True
    toggle.click()
    expect(status).to_have_text('Could not save demo preference.')
    expect(toggle).to_be_checked()
    demo.fail_settings = False
    toggle.click()
    expect(toggle).not_to_be_checked()
    expect(status).to_be_empty()
    page.reload()
    expect(toggle).not_to_be_checked()
    demo.connection['error'] = 'Connection expired. Pair again.'
    page.reload()
    expect(page.locator('#workspace')).to_be_hidden()
    submit.click()
    expect(key).to_be_focused()
    assert len(demo.pairs) == 2
    key.fill(CODE)
    submit.click()
    expect(status).to_contain_text('Connected.')
    page.reload()
    page.get_by_role('button', name='Back to workspace').click()
    expect(page).to_have_url(WORKSPACE)
    print('PASS pair validation, paste, IME, error/retry, revoked pairing and preference rollback')


def workspace(page, demo, evidence):
    account = page.get_by_role('button', name='Open account menu')
    expect(account).to_be_visible()
    account.click()
    page.get_by_role('menuitem', name='Settings', exact=True).click()
    layout = page.locator('.sand-settings-layout')
    expect(layout).to_be_visible()
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    assert layout.bounding_box()['width'] <= 321
    page.locator('.sand-settings-nav__item').get_by_text('Updates', exact=True).click()
    page.locator('.sand-settings-nav__item').get_by_text('General', exact=True).click()
    spell = page.get_by_role('switch', name='Check Spelling While Typing')
    expect(spell).to_be_checked()
    spell.click()
    expect(spell).not_to_be_checked()
    assert demo.settings['spellCheck'] is False
    if evidence:
        page.screenshot(path=evidence / 'settings-320.png')
    page.locator('.sand-settings-panel__close').click()
    row = page.get_by_role('button', name='Demo Bot')
    row.click()
    back = page.get_by_role('button', name='Back', exact=True)
    expect(back).to_be_visible()
    expect(page.locator('html')).to_have_class(re.compile(r'\bgrokbot-view-chat\b'))
    with page.expect_file_chooser() as chosen:
        page.get_by_role('button', name='Attach file').click()
    chosen.value.set_files({'name': 'discard.txt', 'mimeType': 'text/plain', 'buffer': b'discard'})
    page.get_by_role('button', name='Remove discard.txt').click()
    expect(page.get_by_text('discard.txt', exact=True)).to_have_count(0)
    assert not demo.uploads
    with page.expect_file_chooser() as chosen:
        page.get_by_role('button', name='Attach file').click()
    chosen.value.set_files({'name': 'note.txt', 'mimeType': 'text/plain', 'buffer': b'demo note'})
    expect(page.get_by_text('note.txt', exact=True).first).to_be_visible()
    if evidence:
        page.screenshot(path=evidence / 'attachment-320.png')
    field = page.locator('.sand-prompt-form [contenteditable="true"]')
    field.click()
    field.press_sequentially('Fixture message')
    with page.expect_response(lambda response: response.url == ORIGIN + '/api/sendPrompt'):
        page.get_by_role('button', name='Send message').click()
    draft = page.locator('.sand-prompt-form').get_by_text('note.txt', exact=True)
    expect(draft).to_be_hidden(timeout=6000)
    assert demo.uploads == [('note.txt', b'demo note')], demo.uploads
    assert len(demo.sends) == 1 and demo.sends[0]['attachmentPaths'] == ['/demo/note.txt'], demo.sends
    back.click()
    expect(row).to_be_visible()
    page.set_viewport_size({'width': 800, 'height': 480})
    expect(back).to_be_hidden()
    expect(page.locator('.sand-chat')).to_be_visible()
    expect(row).to_be_visible()
    assert any(cursor is not None for cursor in demo.cursors), demo.cursors
    print('PASS real renderer settings, phone list/chat/back, picked attachment bytes, tablet and reconnect cursor')


def modal_shortcut(page, demo):
    field = page.locator('.sand-prompt-form [contenteditable="true"]'); marker = 'Modal test draft'
    field.fill(marker); start = len(demo.sends)
    page.get_by_role('button', name='Open account menu', exact=True).click(); page.get_by_role('menuitem', name='Settings', exact=True).click()
    expect(page.locator('.sand-settings-layout')).to_be_visible(); page.keyboard.press('Control+Enter'); page.wait_for_timeout(300)
    assert len(demo.sends) == start and field.inner_text().strip() == marker
    page.locator('.sand-settings-panel__close').click(); expect(page.locator('.sand-settings-layout')).to_be_hidden()
    with page.expect_response(lambda response: response.url == ORIGIN + '/api/sendPrompt'):
        field.click(); page.keyboard.press('Control+Enter')
    assert len(demo.sends) == start+1 and marker in json.dumps(demo.sends[-1])


def dismiss_dialogs(page):
    field=page.locator('.sand-prompt-form [contenteditable="true"]'); marker='Escape test draft'; field.fill(marker)
    page.get_by_role('button',name='Open account menu',exact=True).click(); page.get_by_role('menuitem',name='Settings',exact=True).click()
    settings=page.locator('.sand-settings-layout'); settings.get_by_role('button',name='Sign Out',exact=True).click()
    confirm=page.get_by_role('alertdialog'); expect(confirm).to_be_visible(); page.keyboard.press('Escape')
    expect(confirm).to_be_hidden(); expect(settings).to_be_visible(); settings.locator('.sand-settings-panel__close').click()
    page.get_by_role('button',name='Marketplace').click(); dialog=page.get_by_role('dialog').filter(has=page.locator('.sand-plugins-dialog__close'))
    search=dialog.locator('input[role=combobox]'); expect(search).to_have_value(''); search.click(); page.keyboard.press('Escape')
    expect(dialog).to_be_hidden(); assert field.inner_text().strip()==marker


def wide_reply(page, demo):
    columns = [f'Column {i}' for i in range(32)]
    pipe = lambda values: '| ' + ' | '.join(values) + ' |'
    table = '\n'.join(map(pipe, (columns, ['---'] * 32, [f'WideDemoCell{i}' for i in range(32)])))
    texts = ['Prose control: ' + 'ordinary reply text '*64, 'Table control:\n\n' + table]
    demo.entries = [{'id': f'table-demo-{i}', 'seq': i, 'kind': 'send-message', 'timestampMs': 1700000000000 + i*1000,
                     'message': {'type': 'text', 'content': text}} for i, text in enumerate(texts, 1)]
    page.set_viewport_size({'width': 1440, 'height': 800}); page.goto(WORKSPACE, wait_until='domcontentloaded')
    page.get_by_role('button', name=AGENT['name'], exact=True).click()
    grid = page.locator('[role=log] table'); expect(grid.locator('thead th')).to_have_count(32)
    measure = '''t => {
        const prose = [...t.closest('[role=log]').querySelectorAll('p')].find(p=>p.textContent.startsWith('Prose control:'));
        if (!prose) return null;
        const bubble=t.closest('.sand-message'), other=prose.closest('.sand-message'), port=t.parentElement;
        return [port.clientWidth, other.getBoundingClientRect().width, port.scrollWidth, document.documentElement.scrollWidth,
                bubble.getBoundingClientRect().right, t.closest('.sand-chat').getBoundingClientRect().right];
    }'''
    wide = grid.evaluate(measure)
    assert wide and wide[0] >= wide[1]+32 and wide[2] > wide[0]+96 and wide[3] <= 1440 and wide[4] <= wide[5]+2, wide
    grid.scroll_into_view_if_needed(); grid.locator('..').hover(); page.mouse.wheel(160, 0)
    for _ in range(20):
        if grid.evaluate('t=>t.parentElement.scrollLeft') > 2: break
        page.wait_for_timeout(50)
    else: raise AssertionError('horizontal wheel did not move the table scrollport')
    assert page.evaluate('scrollX') == 0
    page.set_viewport_size({'width': 375, 'height': 680}); grid.scroll_into_view_if_needed()
    narrow = grid.evaluate(measure)
    assert narrow and narrow[0] < wide[0] and narrow[3] <= 375 and narrow[4] <= narrow[5]+2, narrow
    print('PASS 32-column table: internal scrolling, wider than prose on desktop, contained on phone')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('apk', type=Path)
    parser.add_argument('--evidence', type=Path, help='Optional existing temporary directory for demo screenshots')
    args = parser.parse_args()
    with zipfile.ZipFile(args.apk) as assets, sync_playwright() as playwright:
        browser = playwright.chromium.launch(args=['--disable-background-networking'])
        context = browser.new_context(viewport={'width': 320, 'height': 568}, is_mobile=True,
                                      has_touch=True, locale='en-US', timezone_id='UTC', service_workers='block')
        demo = Demo(assets)
        context.route('**/*', demo.route)
        context.route_web_socket('**/*', lambda socket: socket.close())
        errors = []
        page = context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.set_default_timeout(5000)
        try:
            print(f'Chromium {browser.version}, fresh context, fixture only')
            pairing(page, demo)
            workspace(page, demo, args.evidence)
            modal_shortcut(page, demo)
            dismiss_dialogs(page)
            wide_reply(page, demo)
            assert not errors, errors
            assert not demo.external, demo.external
        finally:
            context.close()
            browser.close()


if __name__ == '__main__':
    main()
