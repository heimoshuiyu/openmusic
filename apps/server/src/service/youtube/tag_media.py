"""Operate ONLY on a private staging copy. JSON options on stdin, bounded summary on stdout."""
import base64
import datetime
import json
import pathlib
import shutil
import sys
import subprocess
from mutagen import MutagenError
from mutagen.id3 import ID3, ID3NoHeaderError, APIC, TIT2, TPE1, TPE2, TALB, TCON, TRCK, TPOS, TDRC, TXXX
from PIL import Image
from io import BytesIO
from mutagen.mp4 import MP4, MP4Cover
from mutagen.oggopus import OggOpus
from mutagen.flac import Picture

options = json.load(sys.stdin)
ext = options['ext']
if ext not in ('mp3', 'opus', 'm4a', 'mp4'):
    raise ValueError('unsupported media type')
audio = pathlib.Path('audio.' + ext)
probe = json.loads(subprocess.check_output(['ffprobe','-v','error','-show_entries','format=format_name:stream=codec_type,codec_name:stream_disposition=attached_pic','-of','json',str(audio)],timeout=8))
streams = probe['streams']
if not set(probe['format']['format_name'].split(',')).intersection({'opus':{'ogg'},'mp3':{'mp3'},'m4a':{'mov','mp4'},'mp4':{'mov','mp4'}}[ext]):
    raise ValueError('container does not match requested format')
ac = [s['codec_name'] for s in streams if s['codec_type'] == 'audio']
vc = [s['codec_name'] for s in streams if s['codec_type'] == 'video' and not s['disposition']['attached_pic']]
if ac != [{'opus':'opus','mp3':'mp3','m4a':'aac','mp4':'aac'}[ext]] or vc != (['h264'] if ext == 'mp4' else []):
    raise ValueError('streams do not match requested format')
values = options['tags']
day = options.get('uploadDate')
if day:
    datetime.date.fromisoformat(day)
image = options.get('image')
jpeg = None
if image:
    try:
        with Image.open(image, formats=['JPEG', 'PNG', 'WEBP']) as picture:
            if picture.width * picture.height > 16_000_000:
                raise ValueError('too many pixels')
            picture.thumbnail((1200,1200)); blob=BytesIO(); picture.convert('RGB').save(blob, 'JPEG', quality=90)
        jpeg = blob.getvalue()
    except Exception:
        if options.get('requiredImage'): raise

def write_tags(audio):
  if ext == 'mp3':
    try: tags = ID3(audio, load_v1=False)
    except ID3NoHeaderError: tags = ID3()
    url = 'https://www.youtube.com/watch?v=' + options['videoId']
    if options.get('verifyLegacy') and not any(url == str(frame) for frame in tags.getall('TXXX') if frame.desc.lower() in ('purl', 'comment')):
        raise ValueError('not a verified YouTube import')
    for key, frame in [('title', TIT2), ('artist', TPE1), ('albumArtist', TPE2), ('album', TALB), ('genre', TCON), ('trackNumber', TRCK), ('discNumber', TPOS)]:
        if key in values: tags.setall(frame.__name__, [frame(encoding=3, text=[str(values[key])])])
    if day:
        tags.setall('TDRC', [TDRC(encoding=3, text=[day])]); tags.add(TXXX(encoding=3, desc='OPENMUSIC_YOUTUBE_UPLOAD_DATE', text=[day]))
    elif options.get('newImport'): tags.delall('TDRC')
    tags.add(TXXX(encoding=3, desc='OPENMUSIC_YOUTUBE_ID', text=[options['videoId']]))
    if jpeg: tags.setall('APIC', [APIC(encoding=3, mime='image/jpeg', type=3, desc='Front cover', data=jpeg)])
    tags.save(audio, v1=0, v2_version=4)
    genre = str(tags['TCON']) if 'TCON' in tags else None
  else:
    if options.get('verifyLegacy'): raise ValueError('provenance required')
    mp4 = ext != 'opus'
    media = MP4(audio) if mp4 else OggOpus(audio)
    if media.tags is None: media.add_tags()
    tags = media.tags
    atoms = {'title':'©nam','artist':'©ART','albumArtist':'aART','album':'©alb','genre':'©gen','trackNumber':'trkn','discNumber':'disk'}
    for key, atom in atoms.items():
        if key not in values: continue
        if mp4: tags[atom] = [(int(values[key]), 0)] if key in ('trackNumber','discNumber') else [values[key]]
        else: tags[key.lower()] = [str(values[key])]
    datekey = '©day' if mp4 else 'date'
    if day: tags[datekey] = [day]
    elif options.get('newImport') and datekey in tags: del tags[datekey]
    if mp4: tags['----:com.apple.iTunes:OPENMUSIC_YOUTUBE_ID'] = [options['videoId'].encode()]
    else: tags['OPENMUSIC_YOUTUBE_ID'] = [options['videoId']]
    if jpeg:
        if mp4: tags['covr'] = [MP4Cover(jpeg, imageformat=MP4Cover.FORMAT_JPEG)]
        else:
            pic = Picture(); pic.type = 3; pic.mime = 'image/jpeg'; pic.data = jpeg
            tags['metadata_block_picture'] = [base64.b64encode(pic.write()).decode('ascii')]
    media.save()
    genre = tags.get('©gen' if mp4 else 'genre', [None])[0]
  return genre

# Only a tag-codec failure on an otherwise validated file can degrade to catalog-only text.
# Invalid media/artwork, unverifiable legacy files, filesystem errors and cancellation still fail.
allow_db_only = options.get('allowDbOnly') and not options.get('requiredImage') and not options.get('verifyLegacy')
stage = audio
if allow_db_only and options.get('newImport'):
    stage = audio.with_name('tag-copy.' + ext)
    shutil.copyfile(audio, stage)
try:
    genre = write_tags(stage)
except MutagenError as exc:
    if not allow_db_only or isinstance(exc.__cause__, OSError): raise
    # The original download is intact; for edits the caller discards its staging copy.
    print(json.dumps({'dbOnly': True, 'coverApplied': False, 'genre': None}))
else:
    if stage != audio: stage.replace(audio)
    print(json.dumps({'coverApplied': bool(jpeg), 'genre': genre}))
