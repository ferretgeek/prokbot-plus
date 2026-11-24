"""Optional Chromium checks: python -B host/tests/admin-ui-browser.py [--artifacts DIR].

Only public assets are served on loopback. Every API response is a demo fixture;
other origins are blocked. No Host, saved browser profile or credentials needed.
"""
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import re
from threading import Thread
import unittest
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright


PUBLIC = Path(__file__).resolve().parents[1] / 'server' / 'public'
FORMATS = ['OpenAI Chat Completions', 'OpenAI Responses', 'Anthropic Messages']
HTML = '<html><title>DEMO PROXY</title><body>Demo proxy page</body></html>'
ARTIFACTS = None


class Static(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


class AdminUI(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        http = ThreadingHTTPServer(('127.0.0.1', 0), partial(Static, directory=PUBLIC))
        cls.origin = 'http://127.0.0.1:' + str(http.server_port)
        thread = Thread(target=http.serve_forever, daemon=True)
        thread.start()
        cls.addClassCleanup(http.server_close)
        cls.addClassCleanup(thread.join)
        cls.addClassCleanup(http.shutdown)
        driver = sync_playwright().start()
        cls.addClassCleanup(driver.stop)
        chrome = Path('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
        cls.browser = driver.chromium.launch(executable_path=str(chrome),
            args=['--disable-background-networking']) if chrome.exists() else driver.chromium.launch(
                args=['--disable-background-networking'])
        cls.addClassCleanup(cls.browser.close)

    def start(self, view='overview', *, mobile=False, locale='en-US', initial='ready', authenticated=True, demo_bot=False,
              legacy=None, skills=None):
        self.mode, self.authenticated, self.reply = initial, authenticated, 'ok'
        self.demo_bot, self.legacy, self.saved, self.skills = demo_bot, legacy, None, skills or []
        self.resolve_calls, self.sync_settings_saved, self.observed_cleared = [], None, []
        self.requests, self.unexpected = [], []
        viewport = {'width': 390, 'height': 844} if mobile else {'width': 1440, 'height': 940} if view == 'model' else {'width': 1280, 'height': 900}
        context = self.browser.new_context(locale=locale, timezone_id='UTC',
            viewport=viewport,
            is_mobile=mobile, has_touch=mobile, reduced_motion='reduce', service_workers='block')
        self.addCleanup(context.close)
        self.addCleanup(lambda: self.assertEqual(self.unexpected, []))
        context.route('**/*', self.route)
        self.page = context.new_page()
        self.page.on('pageerror', lambda error: self.unexpected.append(str(error)))
        self.page.clock.install()
        self.page.goto(self.origin + '/?view=' + view, wait_until='networkidle')
        return self.page

    def route(self, route):
        req = route.request
        parts = urlsplit(req.url)
        if parts.scheme + '://' + parts.netloc != self.origin:
            self.unexpected.append('off-origin request: ' + parts.netloc)
            return route.abort()
        if not parts.path.startswith('/admin/api/'):
            return route.continue_()
        key = parts.path.removeprefix('/admin/api/')
        self.requests.append((req.method, key))
        if key == 'session':
            return route.fulfill(json={'initialized': True, 'authenticated': self.authenticated})
        if key == 'login' and self.reply == 'ok':
            self.authenticated = True
            return route.fulfill(json={'ok': True})
        mode = self.mode if key == 'status' else self.reply if key in ('login', 'model/test', 'voice/test') else None
        if mode == 'dropped':
            return route.abort('connectionreset')
        if mode == 'stalled':
            self.stalled = route
            return
        if mode in ('401', '502'):
            return route.fulfill(status=int(mode), content_type='text/html', body=HTML)
        if mode == 'json401':
            return route.fulfill(status=401, json={'error': '管理员密码不正确' if key == 'login' else '请登录管理页面'})
        configured = self.mode != 'unconfigured'
        model = {
            'version': 1,
            'providers': [
                {'id': 'demo', 'name': 'Demo service', 'apiFormat': 'openai',
                 'baseUrl': 'https://model.example.invalid/v1', 'hasApiKey': configured},
                {'id': 'backup', 'name': 'Backup service', 'apiFormat': 'anthropic',
                 'baseUrl': 'https://backup.example.invalid', 'hasApiKey': configured},
            ] if configured else [],
            'profiles': [
                {'id': 'primary', 'name': 'Primary profile', 'providerId': 'demo', 'model': 'demo-model',
                 'efforts': ['low'], 'contextWindowTokens': 0, 'summaryThresholdTokens': 0},
                {'id': 'backup', 'name': 'Backup profile', 'providerId': 'backup', 'model': 'demo-backup',
                 'efforts': ['high'], 'contextWindowTokens': 0, 'summaryThresholdTokens': 0},
            ] if configured else [],
            'defaultRoute': {'profileId': 'primary', 'effort': 'low',
                             'fallbacks': [{'profileId': 'backup', 'effort': 'high'}]} if configured else None,
            'botRoutes': {'demo-bot': {'profileId': 'backup', 'effort': 'high',
                                      'fallbacks': [{'profileId': 'primary', 'effort': 'low'}]}}
                        if configured and self.demo_bot else {},
            'model': 'demo-model' if configured else '',
            'configured': configured, 'reload': {'status': 'applied'}, 'hasApiKey': configured,
            'routingMigrated': self.legacy is not None, 'legacyAdaptiveRouting': self.legacy == 'adaptive',
        }
        if key == 'model' and req.method == 'PUT':
            self.saved, self.legacy = req.post_data_json, None
            model.update(routingMigrated=False, legacyAdaptiveRouting=False)
        if key == 'model/resolve' and req.method == 'POST':
            body = req.post_data_json or {}
            self.resolve_calls.append(body)
            model_id = body.get('model', '')
            provider_id = body.get('providerId', '')
            if model_id == 'gpt-5-chat-latest':
                return route.fulfill(json={'model': {
                    'id': model_id, 'efforts': ['low'], 'source': 'reference',
                    'contextWindowTokens': 128000, 'summaryThresholdTokens': 96000,
                    'contextSource': 'reference', 'matchedFamily': 'gpt-5-chat',
                }})
            if model_id == 'provider-model' and provider_id == 'backup':
                return route.fulfill(json={'model': {
                    'id': model_id, 'efforts': ['medium', 'high'], 'source': 'provider',
                    'contextWindowTokens': 256000, 'summaryThresholdTokens': 192000,
                    'contextSource': 'provider',
                }})
            return route.fulfill(json={'model': {
                'id': model_id, 'efforts': [], 'source': 'manual',
                'contextWindowTokens': 0, 'summaryThresholdTokens': 0, 'contextSource': 'unknown',
            }})
        if key == 'model/sync-settings' and req.method == 'PUT':
            self.sync_settings_saved = req.post_data_json
            model['contextSync'] = {
                'autoSync': self.sync_settings_saved.get('autoSync', True),
                'codexManifestProbe': self.sync_settings_saved.get('codexManifestProbe', False),
                'providers': {},
            }
            return route.fulfill(json=model)
        if key == 'model/observed/clear' and req.method == 'POST':
            self.observed_cleared.append(req.post_data_json)
            return route.fulfill(json=model)
        if key == 'voice' and req.method == 'PUT':
            self.voice_saved = req.post_data_json
        fixtures = {'status': {'model': model, 'devices': [], 'pairingKeys': [], 'notifications': {},
                'publicUrl': 'https://demo.example.invalid',
                'host': {'connected': self.mode == 'ready', 'busy': False,
                         'agents': [{'id': 'demo-bot', 'name': 'Research Bot', 'isRunning': False,
                                     'isGroup': False}] if configured and self.demo_bot else [],
                         'waitingForExecutionNode': self.mode == 'split-wait'}},
            'profile': {'displayName': 'Demo workspace', 'hostName': 'Demo Host', 'avatarDataUrl': None},
            'usage': {'requests': 0}, 'speech': {'enabled': False, 'provider': 'fish'},
            'voice': {'enabled': True, 'asr': {'configured': False}, 'tts': {'provider': 'openai',
                'endpoint': 'https://voice.example.invalid', 'model': 'demo', 'voice': 'demo', 'speed': 1},
                'selection': {'enabled': True, 'candidates': []}},
            'media': {'defaults': {}}, 'web-services': {'defaults': {}}, 'harness': {}, 'skills': self.skills,
            'apps': {'apps': []}, 'network': {'enabled': False}, 'execution': {'enabled': False, 'url': '', 'name': 'Demo node'},
            'federation': {'peers': []}, 'webhooks': [], 'sharing': [],
            'model/routing-log': {'items': []}, 'model': model}
        if key.startswith('skills/'):
            skill_id = key.removeprefix('skills/')
            entry = next((item for item in self.skills if item['id'] == skill_id), None)
            if entry is None:
                return route.fulfill(status=404, json={'error': 'Skill not found'})
            return route.fulfill(json={**entry, 'content': {
                'id': entry['id'], 'name': entry['name'], 'description': entry['description'],
                'requiresTools': [], 'files': [{'path': 'SKILL.md', 'encoding': 'utf8', 'content': '# Demo\n'}],
            }})
        if key not in fixtures:
            self.unexpected.append('unexpected demo API: ' + key)
            return route.fulfill(status=404, json={'error': 'Unknown demo endpoint'})
        return route.fulfill(json=fixtures[key])

    def poll(self, mode):
        self.mode = mode
        event = 'requestfailed' if mode == 'dropped' else 'response'
        with self.page.expect_event(event, predicate=lambda r: r.url.endswith('/admin/api/status')):
            self.page.clock.fast_forward(5000)
        self.page.wait_for_load_state('networkidle')

    def capture(self, name, **data):
        if ARTIFACTS:
            self.page.screenshot(path=ARTIFACTS / (name + '.png'), animations='disabled')
            (ARTIFACTS / (name + '.json')).write_text(json.dumps({**data, 'requests': self.requests},
                ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

    def test_split_wait_points_to_the_real_execution_editor(self):
        page = self.start(mobile=True, initial='split-wait')
        expect(page.locator('#header-health')).to_have_text('Execution node required')
        action = page.locator('#attention-list button[data-view=execution]')
        expect(action).to_have_text('Set up node')
        self.capture('split-wait', action=action.inner_text())
        action.click()
        expect(page.locator('#execution-form')).to_be_visible()
        self.assertIn(('GET', 'execution'), self.requests)

    def test_status_loss_and_recovery(self):
        page = self.start()
        header, hero = page.locator('#header-health'), page.locator('#hero-title')
        expect(header).to_have_text('Host ready')
        self.poll('core-down')
        expect(header).to_have_text('Waiting for Host')
        self.poll('ready')
        for mode in ['dropped', '502']:
            with self.subTest(mode=mode):
                self.poll(mode)
                self.capture('status-' + mode, header=header.inner_text(), tone=header.get_attribute('data-tone'),
                             headline=hero.inner_text())
                self.assertNotEqual(header.get_attribute('data-tone'), 'success')
                self.assertEqual(header.inner_text(), 'Status unavailable')
                self.assertEqual(hero.inner_text(), 'Status unavailable')
                expect(page.locator('#hero-host')).to_be_hidden()
                if mode == '502':
                    expect(page.locator('.hero-copy')).to_contain_text('502')
                expect(page.locator('body')).not_to_contain_text('DEMO PROXY')
            self.poll('ready')
            expect(hero).to_have_text('Host ready')
            expect(header).to_have_attribute('data-tone', 'success')

    def test_offline_and_stalled_poll(self):
        page = self.start()
        header = page.locator('#header-health')
        expect(header).to_have_text('Host ready')
        self.mode = 'dropped'
        page.context.set_offline(True)
        expect(header).to_have_text('Status unavailable', timeout=1500)
        self.mode = 'ready'
        page.context.set_offline(False)
        expect(header).to_have_text('Host ready', timeout=2000)
        self.mode = 'stalled'
        with page.expect_request(lambda r: r.url.endswith('/admin/api/status')):
            page.clock.fast_forward(5000)
        page.clock.run_for(12050)
        expect(header).to_have_text('Status unavailable')
        expect(page.locator('#hero-status-error')).to_have_text('Host status request timed out.')
        self.stalled.abort()
        self.poll('ready')
        expect(header).to_have_text('Host ready')

    def test_first_status_expired(self):
        page = self.start(view='model', initial='json401')
        expect(page.locator('#auth-screen')).to_be_visible()
        first = len(self.requests)
        for _ in range(2):
            page.clock.fast_forward(5000)
            page.wait_for_load_state('networkidle')
        self.capture('first-status-expired', notice=page.locator('#auth-error').text_content(),
                     extra_requests=len(self.requests) - first)
        self.assertEqual(self.requests, [('GET', 'session'), ('GET', 'status')])
        expect(page.locator('#auth-error')).to_have_text('Session expired. Sign in again.')
        expect(page.locator('#auth-password')).to_be_focused()
        self.mode = 'ready'
        page.keyboard.type('demo-password-only')
        page.keyboard.press('Enter')
        expect(page.locator('#header-health')).to_have_text('Host ready')
        self.poll('core-down')
        expect(page.locator('#header-health')).to_have_text('Waiting for Host')

    def test_proxy_expiry_during_poll(self):
        page = self.start()
        self.poll('401')
        first = len(self.requests)
        page.clock.fast_forward(10000)
        page.wait_for_load_state('networkidle')
        self.capture('poll-html-401', notice=page.locator('#auth-error').text_content(),
                     auth_visible=page.locator('#auth-screen').is_visible(), extra_requests=len(self.requests) - first)
        self.assertEqual(self.requests[first:], [])
        expect(page.locator('#auth-error')).to_have_text('Session expired. Sign in again.')
        expect(page.locator('#console')).to_be_hidden()

    def test_login_proxy_and_json_errors(self):
        page = self.start(authenticated=False)
        field = page.get_by_label('Admin password', exact=True)
        for reply, message in [('401', '401'), ('502', '502'), ('json401', 'Incorrect administrator password')]:
            with self.subTest(reply=reply):
                self.reply = reply
                field.fill('demo-password-only')
                with page.expect_event('requestfinished', predicate=lambda r: r.url.endswith('/admin/api/login')):
                    field.press('Enter')
                alert = page.locator('#auth-error')
                expect(alert).to_be_visible()
                self.capture('login-' + reply, notice=alert.inner_text())
                self.assertIn(message, alert.inner_text())
                self.assertNotRegex(alert.inner_text(), r'(?i)<html|<!doctype|DEMO PROXY|unexpected token|expired')

    def test_mobile_english_keyboard(self):
        page = self.start(mobile=True, initial='ready', demo_bot=True)
        hint = page.locator('#attention-list .row-hint').first.inner_text()
        layout = page.evaluate('''() => {
            const range = document.createRange();
            const right = Math.max(...[...document.querySelectorAll('#hero-title span')].map(line => {
                range.selectNodeContents(line); return range.getBoundingClientRect().right;
            }));
            return {textRight: right, iconLeft: document.querySelector('#hero-host').getBoundingClientRect().left};
        }''')
        self.capture('mobile-setup', hint=hint, layout=layout)
        self.assertLessEqual(layout['textRight'], layout['iconLeft'])
        menu = page.get_by_role('button', name='Menu', exact=True)
        page.keyboard.press('Tab')  # brand link
        page.keyboard.press('Tab')
        expect(menu).to_be_focused()
        page.keyboard.press('Space')
        expect(menu).to_have_attribute('aria-expanded', 'true')
        page.keyboard.press('Tab')  # Overview
        page.keyboard.press('Tab')
        link = page.locator('#nav [data-view=model]')
        expect(link).to_be_focused()
        page.keyboard.press('Enter')
        expect(link).to_have_attribute('aria-current', 'page')
        expect(menu).to_have_attribute('aria-expanded', 'false')
        expect(page.locator('#model-providers .item')).to_have_count(2)
        expect(page.locator('#model-profiles .item')).to_have_count(2)
        expect(page.locator('#model-default-route')).to_contain_text('Primary profile')
        expect(page.locator('#model-default-route')).to_contain_text('Backup profile')
        expect(page.locator('#model-bot-routes')).to_contain_text('Research Bot')
        page.get_by_role('button', name='More actions for Demo service').click()
        page.get_by_role('menuitem', name='Edit').click()
        select = page.get_by_role('combobox', name='API format')
        self.assertEqual(select.locator('option').all_text_contents(), FORMATS)
        select.focus()
        page.keyboard.press('ArrowDown')
        expect(select).to_have_value('openai-responses')
        page.keyboard.press('End')
        expect(select).to_have_value('anthropic')
        page.get_by_role('button', name='Cancel').last.click()
        self.reply = '502'
        page.get_by_role('button', name='Test connection').first.click()
        toast = page.locator('#toast')
        expect(toast).to_be_visible()
        self.capture('mobile-model-error', notice=toast.inner_text(), format='openai')
        self.assertEqual(toast.inner_text(), 'Request failed (502)')
        page.goto(self.origin + '/?view=overview', wait_until='networkidle')
        self.assertIn('Primary profile', page.locator('#model-default-route').inner_text())
        self.assertIn('Backup profile', page.locator('#model-default-route').inner_text())
        self.assertTrue(page.evaluate('document.documentElement.scrollWidth <= innerWidth'))

    def test_desktop_model_page_documents_routes(self):
        page = self.start(view='model', demo_bot=True)
        expect(page.locator('#model-providers .item')).to_have_count(2)
        expect(page.locator('#model-profiles .item')).to_have_count(2)
        expect(page.locator('#model-default-route')).to_contain_text('Primary profile')
        expect(page.locator('#model-default-route')).to_contain_text('Backup profile')
        expect(page.locator('#model-bot-routes')).to_contain_text('Research Bot')
        expect(page.locator('#model-bot-routes')).to_contain_text('Backup profile')
        self.capture('admin-model')

    def test_model_profile_manual_preservation_provider_switch_and_suggestions(self):
        page = self.start(view='model')
        # 1. Upstream sync toggles default to autoSync=True, codexManifestProbe=False and persist via PUT
        page.locator('#model-profiles + details summary').click()
        auto_sync = page.locator('#model-auto-sync')
        codex_probe = page.locator('#model-codex-probe')
        expect(auto_sync).to_be_checked()
        expect(codex_probe).not_to_be_checked()
        with page.expect_response(lambda r: r.url.endswith('/admin/api/model/sync-settings')):
            codex_probe.click()
        self.assertEqual(self.sync_settings_saved, {'codexManifestProbe': True})

        # 2. Editing a manual profile's model ID must NOT clear manual context or effort checkboxes
        page.get_by_role('button', name='More actions for Primary profile').click()
        page.get_by_role('menuitem', name='Edit').click()
        dialog = page.locator('#model-profile-editor')
        expect(dialog).to_be_visible()
        dialog.locator('[name=contextWindowTokens]').fill('128K')
        dialog.locator('[name=contextWindowTokens]').dispatch_event('input')
        expect(dialog.locator('[name=contextModeAuto]')).not_to_be_checked()
        expect(dialog.locator('[name=effort-low]')).to_be_checked()
        dialog.locator('[name=model]').fill('gpt-5-chat-latest')
        with page.expect_response(lambda r: r.url.endswith('/admin/api/model/resolve')):
            dialog.locator('[name=model]').dispatch_event('change')
        # Manual 128K and manual effort 'low' survive model ID change
        expect(dialog.locator('[name=contextWindowTokens]')).to_have_value('128K')
        expect(dialog.locator('[name=effort-low]')).to_be_checked()
        dialog.get_by_role('button', name='Cancel').click()

        # 3. New auto profile shows reference as suggestion (not auto-filled) and re-queries on provider switch
        page.locator('#add-model-profile').click()
        expect(dialog).to_be_visible()
        expect(dialog.locator('[name=contextModeAuto]')).to_be_checked()
        dialog.locator('[name=model]').fill('gpt-5-chat-latest')
        with page.expect_response(lambda r: r.url.endswith('/admin/api/model/resolve')):
            dialog.locator('[name=model]').dispatch_event('change')
        expect(dialog.locator('[name=contextWindowTokens]')).to_have_value('')
        apply_btn = dialog.get_by_role('button', name='Apply suggestion')
        expect(apply_btn).to_be_visible()
        apply_btn.click()
        expect(dialog.locator('[name=contextWindowTokens]')).to_have_value('128K')
        expect(dialog.locator('[name=contextModeAuto]')).not_to_be_checked()

        # Switch back to auto and change model + provider -> provider switch re-queries /resolve
        dialog.locator('[name=contextModeAuto]').check()
        dialog.locator('[name=model]').fill('provider-model')
        with page.expect_response(lambda r: r.url.endswith('/admin/api/model/resolve')):
            dialog.locator('[name=providerId]').select_option('backup')
        expect(dialog.locator('[name=contextWindowTokens]')).to_have_value('256K')
        dialog.get_by_role('button', name='Cancel').click()

    def test_legacy_model_migration_mentions_jev_only_for_adaptive_routing(self):
        for legacy in ('single', 'adaptive'):
            with self.subTest(legacy=legacy):
                page = self.start(view='model', legacy=legacy)
                notice = page.locator('#legacy-routing-notice')
                expect(notice).to_be_visible()
                self.assertEqual('Jev' in notice.inner_text(), legacy == 'adaptive')
                page.locator('#model-form button[type=submit]').click()
                if legacy == 'adaptive':
                    confirm = page.locator('#confirm-dialog')
                    expect(confirm).to_contain_text('Jev')
                    confirm.locator('#confirm-accept').click()
                expect(notice).to_be_hidden()
                self.assertIs(self.saved.get('migrateLegacyRouting'), True)

    def test_chinese_setup_copy(self):
        page = self.start(initial='unconfigured', locale='zh-CN')
        hint = page.locator('#attention-list .row-hint').first.inner_text()
        self.capture('zh-setup', hint=hint)
        self.assertTrue(all(label in hint for label in FORMATS))

    def test_voice_proxy_errors(self):
        page = self.start(view='speech')
        button, error = page.locator('#voice-preview'), page.locator('#voice-error')
        self.reply = '502'
        button.press('Enter')
        expect(error).to_be_visible()
        self.capture('voice-502', notice=error.inner_text())
        with self.subTest(status=502):
            self.assertEqual(error.inner_text(), 'Request failed (502)')
        self.reply = '401'
        with page.expect_response(lambda r: r.url.endswith('/admin/api/voice/test')):
            button.press('Enter')
        expect(page.locator('#auth-error')).to_have_text('Session expired. Sign in again.')
        expect(page.locator('#console')).to_be_hidden()

    def test_voice_candidates_save_matching_metadata(self):
        page = self.start(view='speech')
        page.locator('#voice-candidate-add').click()
        dialog = page.locator('dialog[open]')
        self.assertEqual(dialog.locator('button[data-close].icon-btn').get_attribute('aria-label'), 'Close')
        self.assertIn('OpenAI Compatible', dialog.locator('[name=provider] option[value=openai]').inner_text())
        dialog.locator('[name=name]').fill('Incomplete voice')
        dialog.locator('button[type=submit]').click()
        expect(dialog.locator('[data-candidate-error]')).to_be_visible()
        dialog.locator('[name=name]').fill('Research voice')
        dialog.locator('[name=provider]').select_option('openai')
        dialog.locator('[name=voice]').fill('sage')
        dialog.locator('[name=keywords]').fill('研究、分析；research, analysis')
        dialog.locator('[name=languages]').fill('zh、en')
        dialog.locator('button[type=submit]').click()
        expect(page.locator('#voice-candidates')).to_contain_text('Research voice')
        with page.expect_request(lambda r: r.url.endswith('/admin/api/voice') and r.method == 'PUT'):
            page.locator('#voice-form button[type=submit]').click()
        saved = self.voice_saved
        self.capture('voice-selection', saved=saved)
        self.assertEqual(saved['selection'], {'enabled': True, 'candidates': [
            {'id': saved['selection']['candidates'][0]['id'], 'name': 'Research voice', 'provider': 'openai',
             'referenceId': '', 'voice': 'sage', 'keywords': ['研究', '分析', 'research', 'analysis'], 'languages': ['zh', 'en']}
        ]})

    def test_skills_page_localization(self):
        demo_skills = [
            {
                'id': 'learn-from-demonstration', 'source': 'host', 'enabled': True, 'current': 'd1e7bbcd1234',
                'name': 'Learn from demonstration',
                'description': 'Turn a recorded task into a reusable skill.',
                'localizedName': {'en': 'Learn from demonstration', 'zh-CN': '从演示中学习'},
                'localizedDescription': {'en': 'Turn a recorded task into a reusable skill.', 'zh-CN': '将录制的操作整理为可复用的技能。'},
                'versions': [{'id': 'd1e7bbcd1234', 'at': 1700000000000, 'name': 'Learn from demonstration', 'description': 'Turn a recorded task into a reusable skill.'}],
            },
            {
                'id': 'p-demo-vault-safe-login-d81df759', 'source': 'plugin:demo-vault', 'enabled': False, 'current': 'd81df7591234',
                'name': 'Demo Vault Safe Login',
                'description': 'Look up accounts and sign in safely with approval cards.',
                'localizedName': {'en': 'Demo Vault Safe Login', 'zh-CN': '演示密码库安全登录'},
                'localizedDescription': {'en': 'Look up accounts and sign in safely with approval cards.', 'zh-CN': '查询账号并配合审批卡片安全登录。'},
                'versions': [],
            },
            {
                'id': 'custom-skill', 'source': 'host', 'enabled': True, 'current': 'abcdef123456',
                'name': 'My Custom Skill', 'description': 'Custom instructions.', 'versions': [],
            },
        ]
        for locale, expected_host_title, expected_host_desc, expected_app_title, expected_app_desc, expected_source, edit_label in [
            ('zh-CN', '从演示中学习', '将录制的操作整理为可复用的技能。', '演示密码库安全登录', '查询账号并配合审批卡片安全登录。', '应用附带', '编辑'),
            ('en-US', 'Learn from demonstration', 'Turn a recorded task into a reusable skill.', 'Demo Vault Safe Login', 'Look up accounts and sign in safely with approval cards.', 'Bundled with app', 'Edit'),
        ]:
            with self.subTest(locale=locale):
                page = self.start(view='skills', locale=locale, skills=demo_skills)
                rows = page.locator('#skills-list .item')
                expect(rows).to_have_count(3)
                expect(rows.nth(0)).to_contain_text(expected_host_title)
                expect(rows.nth(0)).to_contain_text(expected_host_desc)
                expect(rows.nth(1)).to_contain_text(expected_app_title)
                expect(rows.nth(1)).to_contain_text(expected_app_desc)
                expect(rows.nth(1)).to_contain_text(expected_source)
                expect(rows.nth(2)).to_contain_text('My Custom Skill')
                rows.nth(0).get_by_role('button', name=edit_label).click()
                expect(page.locator('#skill-editor')).to_be_visible()
                expect(page.locator('#skill-editor-title')).to_have_text(expected_host_title)
                page.locator('#skill-editor button[data-close].icon-btn').click()
                page.goto(self.origin + '/?view=sharing', wait_until='networkidle')
                page.locator('#sharing-skill').click()
                expect(page.locator('#sharing-select')).to_be_visible()
                options = page.locator('#sharing-select-form select[name=skill] option')
                expect(options).to_have_count(3)
                self.assertEqual(options.all_text_contents(), [expected_host_title, expected_app_title, 'My Custom Skill'])


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--artifacts', type=Path)
    args, rest = parser.parse_known_args()
    ARTIFACTS = args.artifacts
    if ARTIFACTS:
        ARTIFACTS.mkdir(parents=True, exist_ok=True)
    unittest.main(argv=[__file__, *rest], verbosity=2)
