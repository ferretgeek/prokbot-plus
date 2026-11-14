import runpy
import unittest
from pathlib import Path
from xml.etree.ElementTree import ParseError


index_feed = runpy.run_path(str(Path(__file__).with_name('official-channels-notes.py')))['index_feed']
PAGE = 'https://x.ai/changelog/bot'
ITEM = f'<item><title>Example (1.0.1)</title><link>{PAGE}#v1.0.1</link><guid>{PAGE}#v1.0.1</guid>' \
       '<description>&lt;p&gt;Also includes 1.0.0&lt;/p&gt;&lt;li&gt;Requires 1.0.3.&lt;/li&gt;</description></item>'
RSS = f'<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel>' \
      f'<title>Grok Bot Changelog</title><link>{PAGE}</link><atom:link rel="self" href="{PAGE}/rss.xml"/>' \
      f'<lastBuildDate>Wed, 11 Nov 2026 00:00:00 GMT</lastBuildDate>{ITEM}</channel></rss>'


class ChangelogTests(unittest.TestCase):
    def test_exact_grouped_and_unlisted_are_distinct(self):
        versions = ['1.0.0', '1.0.1', '1.0.3', '1.1.0']
        link = PAGE + '#v1.0.1'
        report = index_feed(RSS.encode(), versions)
        self.assertEqual(report['source'], PAGE + '/rss.xml')
        self.assertEqual(report['firstItem'], link)
        self.assertEqual(report['lastBuildDate'], 'Wed, 11 Nov 2026 00:00:00 GMT')
        self.assertEqual(report['versions'], {
            '1.0.0': {'item': None, 'includedIn': [link]}, '1.0.1': {'item': link, 'includedIn': []},
            '1.0.3': {'item': None, 'includedIn': []}, '1.1.0': {'item': None, 'includedIn': []}})

    def test_future_group_does_not_assign_individual_features(self):
        for conjunction in [' and ', ', and ']:
            newer = ITEM.replace('1.0.1', '1.1.0').replace('1.0.0', '1.0.2, 1.0.3' + conjunction + '1.0.4')
            report = index_feed(RSS.replace(ITEM, newer + ITEM).encode(), ['1.0.1', '1.0.2', '1.0.3', '1.0.4', '1.1.0'])
            self.assertEqual(report['firstItem'], PAGE + '#v1.1.0')
            self.assertEqual(report['versions']['1.1.0']['item'], PAGE + '#v1.1.0')
            for v in ['1.0.2', '1.0.3', '1.0.4']:
                self.assertEqual(report['versions'][v], {'item': None, 'includedIn': [PAGE + '#v1.1.0']})

    def test_unreadable_or_wrong_product_is_not_absence(self):
        for body in [b'<html/>', b'<rss', b'\xff', b'x' * (512 * 1024 + 1),
                     ('<!DOCTYPE rss>' + RSS).encode(), RSS.replace(PAGE, PAGE + '-other').encode(),
                     RSS.replace('Grok Bot Changelog', 'Grok Build Changelog').encode(),
                     RSS.replace('Example (1.0.1)', 'Example (1.1.0)').encode(),
                     RSS.replace('<guid>', '<guid>other-').encode(), RSS.replace(ITEM, '').encode(),
                     RSS.replace(ITEM, ITEM * 2).encode(), RSS.replace('Also includes 1.0.0', 'Also includes v?').encode()]:
            with self.subTest(prefix=body[:70]), self.assertRaises((ValueError, ParseError)):
                index_feed(body, ['1.1.0'])


if __name__ == '__main__':
    unittest.main()
