"""Optional Playwright test of the web client: python -B web/tests/browser-flows.py <GrokBotLocal-web-*.zip>.

Runs the real Host service (host/server, needs `npm ci --prefix host/server`) on loopback with a
temporary data directory and a fixture Host core (fixture-host.mjs), installs the supplied bundle and
signs in from fresh browser contexts: Windows-sized Chromium and Firefox, Mac-sized WebKit, Android
phone and tablet (Chromium), iPhone and iPad (WebKit). The web client has its own origin; only the
admin-page check may reach the Host's main origin, and every other origin is blocked. Needs the
Playwright Chromium, Firefox and WebKit browsers; a missing engine is reported and skipped.
"""
import argparse
import json
from pathlib import Path
import re
import subprocess
import zipfile
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[2]
# Phone layout classes android.css sets on <html>.
LIST, CHAT = re.compile(r'\bgrokbot-view-list\b'), re.compile(r'\bgrokbot-view-chat\b')
# Fake notifications: headless browsers cannot show real ones, and the page's own rules are under test.
NOTIFICATIONS = '''(() => {
  const shown = [];
  function Notification(title, options) { shown.push({ title, body: options && options.body }); this.close = () => {}; }
  Notification.permission = 'granted';
  Notification.requestPermission = async () => 'granted';
  Object.defineProperty(window, 'Notification', { value: Notification, configurable: true, writable: true });
  window.__grokbotShown = shown;
})();'''


class Fixture:
    def __init__(self, bundle):
        self.process = subprocess.Popen(['node', str(ROOT / 'web/tests/fixture-host.mjs'), str(bundle)], cwd=ROOT,
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        info = json.loads(self.process.stdout.readline())
        # origin: the web client's own listener; admin: the main listener with the admin page.
        self.origin, self.admin = info['web'], info['origin']
        self.control, self.password = info['control'], info['password']
        assert self.origin != self.admin
        with zipfile.ZipFile(bundle) as archive:
            self.version = json.loads(archive.read('web-bundle.json'))['rendererVersion']

    def call(self, path, body=None):
        request = Request(self.control + path, method='GET' if body is None else 'POST',
                          data=None if body is None else json.dumps(body).encode(), headers={'content-type': 'application/json'})
        with urlopen(request, timeout=10) as response:
            return json.load(response)

    def close(self):
        self.process.stdin.close()
        self.process.wait(timeout=30)


def devices(playwright):
    d = playwright.devices
    return [
        ('Windows Chrome', 'chromium', {'viewport': {'width': 1440, 'height': 900}}),
        ('Windows Firefox', 'firefox', {'viewport': {'width': 1280, 'height': 800}}),
        ('Mac Safari', 'webkit', {**d['Desktop Safari'], 'viewport': {'width': 1280, 'height': 800}}),
        ('Android phone', 'chromium', d['Pixel 7']),
        ('Android tablet', 'chromium', d['Galaxy Tab S4']),
        ('iPhone', 'webkit', d['iPhone 15']),
        ('Small iPhone', 'webkit', d['iPhone SE']),
        ('iPad', 'webkit', d['iPad Pro 11 landscape']),
    ]


class Run:
    def __init__(self, fixture, browser, name, options, evidence):
        self.fixture, self.name, self.evidence = fixture, name, evidence
        self.context = browser.new_context(**options, locale='en-US', timezone_id='UTC', service_workers='block')
        self.errors, self.external, self.refused, self.signed_out = [], [], [], False
        self.admin_allowed = False  # Only admin_open visits the main origin; the web client never calls it.
        self.context.add_init_script(NOTIFICATIONS)
        self.context.route('**/*', self.route)
        self.page = self.context.new_page()
        self.page.on('pageerror', lambda error: self.errors.append(str(error)))
        # The wrong pairing code is the only refusal the flow expects, apart from what a page that
        # has just signed out still requests before it leaves.
        self.page.on('response', lambda response: self.refused.append(f'{response.status} {response.url}')
                     if response.status >= 400 and not response.url.endswith('/web/api/pair') and not self.signed_out else None)
        self.page.set_default_timeout(10000)

    def route(self, route):
        url = urlsplit(route.request.url)
        origin = f'{url.scheme}://{url.netloc}'
        if origin != self.fixture.origin and not (self.admin_allowed and origin == self.fixture.admin):
            self.external.append(url.netloc)
            return route.abort()
        route.continue_()

    def shot(self, label):
        if self.evidence:
            self.page.screenshot(path=self.evidence / f'{self.name.replace(" ", "-").lower()}-{label}.png', caret='initial')

    def check_layout(self):
        size = self.page.evaluate('[document.documentElement.scrollWidth, innerWidth, document.documentElement.scrollHeight, innerHeight]')
        assert size[0] <= size[1] and size[2] <= size[3] + 1, f'{self.name}: page scrolls ({size})'

    def close(self):
        self.context.close()
        assert not self.errors, f'{self.name}: {self.errors}'
        assert not self.external, f'{self.name}: off-origin requests {self.external}'
        assert not self.refused, f'{self.name}: refused requests {self.refused}'


def shown(page, name):
    # Polls from here: wait_for_function evaluates a string, which Safari's CSP for the page refuses.
    for _ in range(100):
        if any(body.endswith(name) for body in page.evaluate('window.__grokbotShown.map(item => item.body)')):
            return
        page.wait_for_timeout(100)
    raise AssertionError(f'{name}: no notification shown')


def sign_in(run):
    page, fixture = run.page, run.fixture
    # A link to one Bot survives the sign-in page and opens that Bot.
    page.goto(fixture.origin + '/web/?agent=demo')
    expect(page).to_have_url(re.compile(r'/web/login\?agent=demo$'))
    code = page.locator('#web-code')
    expect(code).to_be_visible()
    run.check_layout()
    run.shot('sign-in')
    code.fill('ZZZZ99')
    code.press('Enter')
    expect(page.locator('#web-message')).to_have_text('Pairing code is invalid, used or expired')
    key = fixture.call('/pairing')['pairingKey']
    code.fill('')
    code.focus()
    # Phones type lower case and full-width characters; the page tidies them like the apps do.
    page.keyboard.insert_text(' '.join(key.lower()))
    expect(code).to_have_value(key)
    code.press('Enter')
    expect(page).to_have_url(re.compile(r'/web/renderer/index\.html$'))
    expect(page.locator('html')).to_have_class(re.compile(r'\bgrokbot-web\b'))


def workspace(run, phone):
    page, fixture = run.page, run.fixture
    view = page.locator('html')
    field = page.locator('.sand-prompt-form [contenteditable="true"]')
    expect(page.get_by_role('log', name='Conversation transcript')).to_be_visible()
    expect(field).to_be_visible()
    if phone:
        expect(view).to_have_class(CHAT)
    # The Bot's screenshot renders; in Safari that needs compat.js for the interface's image sizing.
    image = page.get_by_role('log').get_by_role('img', name='Demo screenshot')
    expect(image).to_be_visible()
    assert image.evaluate('image => image.complete && image.naturalWidth') == 160, run.name
    # Only Bots that are not on screen raise a notification.
    notify = lambda agent, body: fixture.call('/notify', {'type': 'message', 'agentId': agent, 'title': 'Demo Bot',
                                                          'body': f'{body} · {run.name}', 'id': f'{id(run)}-{agent}'})
    page.wait_for_timeout(1500)  # The interface reports the Bot on screen once its conversation has loaded.
    notify('demo', 'Seen reply')
    page.wait_for_timeout(800)
    notify('other', 'Other reply')
    shown(page, run.name)
    # Notifications from the previous device's run may still be inside the page's start-up window.
    bodies = [body for body in page.evaluate('window.__grokbotShown.map(item => item.body)') if body.endswith(run.name)]
    assert bodies == [f'Other reply · {run.name}'], (run.name, bodies)
    message = f'Hello from {run.name}'
    field.click()
    field.press_sequentially(message)
    with page.expect_response(lambda response: response.url.endswith('/api/sendPrompt')):
        page.get_by_role('button', name='Send message').click()
    assert any(message in json.dumps(send) for send in fixture.call('/received')['sends']), (run.name, 'message not sent')
    run.check_layout()
    run.shot('chat')
    row = page.get_by_role('button', name='Demo Bot', exact=True)
    if phone:
        # The browser's back button returns to the Bot list without leaving the page.
        page.go_back()
        expect(view).to_have_class(LIST)
        expect(page).to_have_url(re.compile(r'/web/renderer/index\.html$'))
    expect(row).to_be_visible()
    page.wait_for_timeout(500)  # Let the slide back to the list finish.
    run.check_layout()
    run.shot('list')
    # Still signed in after a reload; on a phone the list stays, as the link opened its Bot only once.
    page.reload()
    expect(row).to_be_visible()
    if phone:
        expect(view).to_have_class(LIST)
        row.click()
        expect(view).to_have_class(CHAT)


def sign_out(run):
    page, fixture = run.page, run.fixture
    # 1.1.0 shows the Host profile name on the account button; 0.71.2 labels it.
    account = page.get_by_role('button', name='Open account menu', exact=True)
    account.or_(page.get_by_role('button', name=re.compile('本地工作区'))).first.click()
    page.get_by_role('menuitem', name='Settings', exact=True).click()
    page.locator('.sand-settings-layout').get_by_role('button', name='Sign Out', exact=True).click()
    run.signed_out = True
    page.get_by_role('alertdialog').get_by_role('button', name='Sign out', exact=True).click()
    expect(page).to_have_url(re.compile(r'/web/login'))
    expect(page.locator('#web-code')).to_be_visible()
    page.goto(fixture.origin + '/web/renderer/index.html')
    expect(page).to_have_url(re.compile(r'/web/login$'))
    # Windows Chrome runs first, so signing out leaves no browser signed in.
    devices = fixture.call('/received')['devices']
    assert [item['revokedAt'] is not None for item in devices if item['platform'] == 'web'] == [True], devices


def admin_open(run):
    page, fixture = run.page, run.fixture
    run.admin_allowed = True
    page.goto(fixture.admin + '/admin?view=web-client')
    page.locator('#auth-password').fill(fixture.password)
    page.locator('#auth-password').press('Enter')
    expect(page.locator('#web-client-bundle')).to_contain_text(f'Interface {fixture.version} ')
    expect(page.locator('#web-client-enabled')).to_be_checked()
    expect(page.locator('#web-client-url')).to_have_text(fixture.origin + '/web/')
    with page.context.expect_page() as opened:
        page.locator('#web-client-open').click()
    tab = opened.value
    # The one-time ticket signs this browser in on the web client's origin, not the admin page's.
    expect(tab).to_have_url(fixture.origin + '/web/renderer/index.html')
    expect(tab.get_by_role('button', name='Demo Bot', exact=True)).to_be_visible()
    # Code running in the interface cannot use the administrator's session: the web origin has no
    # admin API, and the browser withholds the admin origin's responses (and refuses its preflight).
    probe = '''async admin => {
      const own = await fetch('/admin/api/status').then(r => r.status);
      const read = await fetch(admin + '/admin/api/status', { credentials: 'include' }).then(r => r.status, () => 'blocked');
      const write = await fetch(admin + '/admin/api/model', { method: 'PUT', credentials: 'include',
        headers: { 'x-grokbot-csrf': '1', 'content-type': 'application/json' }, body: '{}' }).then(r => r.status, () => 'blocked');
      return [own, read, write];
    }'''
    assert tab.evaluate(probe, fixture.admin) == [404, 'blocked', 'blocked'], run.name
    tab.close()
    # Old links to /web/ on the main address lead to the web client's own address.
    page.goto(fixture.admin + '/web/')
    expect(page).to_have_url(fixture.origin + '/web/renderer/index.html')
    page.goto(fixture.admin + '/admin?view=web-client')
    page.locator('#web-client-enabled').click()
    expect(page.locator('#web-client-open')).to_be_disabled()
    page.goto(fixture.origin + '/web/')
    expect(page.locator('#web-status')).to_contain_text('not enabled')
    run.admin_allowed = False
    fixture.call('/web-client', {'enabled': True})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('bundle', type=Path)
    parser.add_argument('--evidence', type=Path, help='Optional existing temporary directory for demo screenshots')
    parser.add_argument('--only', help='Run only the device whose name contains this text')
    args = parser.parse_args()
    fixture = Fixture(args.bundle.resolve())
    passed, skipped = [], []
    try:
        with sync_playwright() as playwright:
            browsers = {}
            for name, engine, options in devices(playwright):
                if args.only and args.only.lower() not in name.lower():
                    continue
                if engine not in browsers:
                    try:
                        browsers[engine] = getattr(playwright, engine).launch()
                    except Exception as error:
                        browsers[engine] = None
                        print(f'SKIP {engine}: {str(error).splitlines()[0]}')
                if browsers[engine] is None:
                    skipped.append(name)
                    continue
                run = Run(fixture, browsers[engine], name, options, args.evidence)
                try:
                    sign_in(run)
                    workspace(run, phone=options['viewport']['width'] < 600)
                    if name == 'Windows Chrome':
                        sign_out(run)
                        admin_open(run)
                except Exception:
                    run.shot('failure')
                    raise
                finally:
                    run.close()
                passed.append(name)
                print(f'PASS {name} ({engine} {browsers[engine].version}, {options["viewport"]["width"]}x{options["viewport"]["height"]})')
            # Leaving sync_playwright stops the driver, which ends its browsers. Browser.close itself
            # sometimes never returns on Windows after a full run, with every device already passed.
    finally:
        fixture.close()
    print(f'{len(passed)} passed, {len(skipped)} skipped')


if __name__ == '__main__':
    main()
