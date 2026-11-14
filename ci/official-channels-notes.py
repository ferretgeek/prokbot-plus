"""Index the public Grok Bot changelog from UTF-8 RSS on stdin; no network or files."""

import argparse
import json
import re
import sys
from xml.etree import ElementTree as ET


PAGE = 'https://x.ai/changelog/bot'
FEED = PAGE + '/rss.xml'
LIMIT = 512 * 1024
VERSION = r'(?:0|[1-9][0-9]{0,8})(?:\.(?:0|[1-9][0-9]{0,8})){1,2}'


def index_feed(data, versions):
    if len(data) > LIMIT:
        raise ValueError('RSS exceeds 512 KiB')
    xml = data.decode('utf-8-sig')
    if '\x00' in xml or re.search(r'<!\s*(?:DOCTYPE|ENTITY)\b', xml, re.I):
        raise ValueError('Expected UTF-8 RSS without DTD or entity declarations')
    root = ET.fromstring(xml)
    channel = root.find('channel')
    if (root.tag != 'rss' or root.get('version') != '2.0' or len(root.findall('channel')) != 1
            or channel.findtext('title') != 'Grok Bot Changelog' or channel.findtext('link') != PAGE
            or not any(link.get('rel') == 'self' and link.get('href') == FEED
                       for link in channel.findall('{http://www.w3.org/2005/Atom}link'))):
        raise ValueError('Expected the official Grok Bot RSS channel')
    entries, groups = {}, {}
    for item in channel.findall('item'):
        link = item.findtext('link', '')
        v = link.removeprefix(PAGE + '#v')
        if (not re.fullmatch(VERSION, v) or link != PAGE + '#v' + v or item.findtext('guid') != link
                or v in entries or not item.findtext('title', '').endswith('(' + v + ')')):
            raise ValueError('Invalid or duplicate Grok Bot changelog item')
        entries[v] = link
        # Versions in feature prose (e.g. minimum requirements) are not release groups.
        description = item.findtext('description', '').lstrip()
        if description.startswith('<p>Also includes'):
            group = re.match(r'^<p>Also includes ([^<]+)</p>', description)
            members = re.split(r',\s*(?:and\s+)?|\s+and\s+', group[1].strip()) if group else []
            if not members or not all(re.fullmatch(VERSION, member) for member in members):
                raise ValueError('Unrecognized grouped-version header')
            for member in members:
                groups.setdefault(member, []).append(link)
    if not entries or not all(re.fullmatch(VERSION, v) for v in versions):
        raise ValueError('Expected release items and numeric release versions')
    targets = {v: {'item': entries.get(v), 'includedIn': groups.get(v, [])} for v in versions}
    return {'source': FEED, 'lastBuildDate': channel.findtext('lastBuildDate'),
            'firstItem': next(iter(entries.values())), 'versions': targets}


if __name__ == '__main__':
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument('versions', nargs='+', metavar='VERSION')
    args = cli.parse_args()
    try:
        print(json.dumps(index_feed(sys.stdin.buffer.read(LIMIT + 1), args.versions), indent=2))
    except (ValueError, ET.ParseError) as exc:
        cli.exit(1, 'RSS unavailable or invalid: ' + str(exc) + '\n')
