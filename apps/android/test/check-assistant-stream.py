"""Run with the release assistant open on the local fixture's first session (fresh process).
Usage: python apps/android/test/check-assistant-stream.py emulator-5614
No WebView debugging. Only visible text inside the conversation counts as evidence.
"""
from io import BytesIO
import re
import subprocess
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET
from PIL import Image, ImageChops, ImageFilter

chunks = ('鼓点', '响起', '了。')
serial = sys.argv[1]

def screen():
    raw = subprocess.check_output(['adb','-s',serial,'exec-out','uiautomator','dump','/dev/tty'],timeout=12)
    tree = ET.fromstring(raw[raw.index(b'<hierarchy'):raw.rindex(b'</hierarchy>')+len(b'</hierarchy>')])
    thread = next(e for e in tree.iter('node') if '对话记录' in (e.get('content-desc'), e.get('text')) and e.get('package')=='dev.hmsy.openmusic')
    def bounds(e): return list(map(int,re.findall(r'-?\d+',e.get('bounds',''))))
    l,t,r,b = bounds(thread)
    texts = []
    for e in thread.iter('node'):
        x,y,u,v = bounds(e)
        if min(r,u)>max(l,x) and min(b,v)>max(t,y): texts.append(e.get('text') or e.get('content-desc',''))
    return ''.join(texts), any(e.get('content-desc')=='停止生成' or e.get('text')=='停止生成' for e in tree.iter('node')), (l,t,r,b)

def release(step):
    with urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:37381/_delta/'+step,method='POST'),timeout=4) as r: assert r.status==204

initial, _, bounds = screen()
assert chunks[0] not in initial, 'Use a fresh fixture session view before starting this probe'

def pixels():
    png=subprocess.check_output(['adb','-s',serial,'exec-out','screencap','-p'],timeout=8)
    return Image.open(BytesIO(png)).convert('RGB').crop(bounds)

# Streamdown's animated text can be painted without exposing an Android accessibility text
# node until snapshot. Use the final static text as an image reference for the prefixes.
base=pixels(); frames=[]
for i in range(3):
    release(str(i+1)); _, busy, current_bounds=screen()
    assert busy and current_bounds==bounds
    frames.append(pixels())  # advance fixture only after taking this screenshot
release('end');text,busy,_=screen();assert not busy and ''.join(chunks) in text
final=pixels()
def ink(im): return ImageChops.difference(im,base).convert('L').point(lambda v:255 if v>40 else 0)
reference=ink(final)
right=0
for i,frame in enumerate(frames):
    actual=ink(frame);changed=actual.getbbox(); assert changed and changed[2]>right+4, 'No visible append for this delta'
    right=changed[2]; prefix=(0,changed[1]-3,right,changed[3]+3)
    a,b=actual.crop(prefix),reference.crop(prefix)
    # Inline animated spans and the final static paragraph can rasterize a glyph a pixel
    # apart. Require the same strokes in both directions, allowing subpixel placement.
    for x,y in ((a,b),(b,a)):
        unmatched=ImageChops.subtract(x,y.filter(ImageFilter.MaxFilter(5))).histogram()[255]
        assert unmatched <= .08*x.histogram()[255], 'Painted glyphs differ from final snapshot'
    print(f"visible={''.join(chunks[:i+1])!r} width={right-changed[0]}px busy=True")
assert abs(right-reference.getbbox()[2])<=3, 'Full text must be visible before final snapshot'
print('PASS: incremental pixels match final text; execution ended after last delta')
