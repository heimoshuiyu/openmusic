"""Release smoke test. Open a conversation with history; dismiss the keyboard first.

  adb -s SERIAL exec-out uiautomator dump /dev/tty | python apps/android/test/check-assistant-layout.py

Reads the actual on-screen bounds, not just the presence of accessible message nodes. Does not
send a prompt, require WebView debugging, or print session names or conversation contents.
"""
import re
import sys
from xml.etree import ElementTree as ET

raw = sys.stdin.read()
start, end = raw.find('<hierarchy'), raw.rfind('</hierarchy>')
if start < 0 or end < 0:
    sys.exit('No UI hierarchy in input')
root = ET.fromstring(raw[start:end + len('</hierarchy>')])

def height(node):
    _, top, _, bottom = map(int, re.findall(r'-?\d+', node.attrib['bounds']))
    return bottom - top

for web in root.iter('node'):
    if web.get('class') != 'android.webkit.WebView' or web.get('package') != 'dev.hmsy.openmusic':
        continue
    for thread in web.iter('node'):
        if '对话记录' not in (thread.get('content-desc'), thread.get('text')):
            continue
        host, visible = height(web), height(thread)
        if host > 0 and visible >= .35 * host:
            print(f'PASS: visible conversation {visible}px / WebView {host}px')
            sys.exit(0)
        sys.exit(f'FAIL: clipped conversation {visible}px / WebView {host}px')
sys.exit('Open a loaded assistant conversation before running this check')
