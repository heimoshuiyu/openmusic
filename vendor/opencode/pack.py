"""Repack the fork's Bun runtime packages from a reviewed, installed checkout.

No build/install in that checkout. Ship the actual sources (Bun runs TS natively),
matched declarations and upstream license. Never walk home directories or node_modules.
"""
import gzip, hashlib, io, json, pathlib, subprocess, sys, tarfile, tempfile

root = pathlib.Path(sys.argv[1]).resolve()
out = pathlib.Path(__file__).resolve().parent
revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()
catalog = json.loads((root / 'package.json').read_text())['workspaces']['catalog']
names = 'ai client codemode core plugin plugin-browser protocol schema sdk server simulation util'.split()
release = '2.2.5-openmusic.1'
for name in names:
    if len(sys.argv)>2 and name not in sys.argv[2:]: continue
    pkg = root / 'packages' / name
    original = json.loads((pkg / 'package.json').read_text())
    meta = {k: original[k] for k in ('name','type','license','exports','imports','dependencies','peerDependencies','peerDependenciesMeta','optionalDependencies') if k in original}
    meta.update(version=release, gitHead=revision)
    for key in ('dependencies','peerDependencies','optionalDependencies'):
        for dep, version in meta.get(key, {}).items():
            if version == 'catalog:': meta[key][dep] = catalog[dep]
            if version == 'workspace:*': meta[key][dep] = release if dep.removeprefix('@opencode/') in names else original['version']
    meta['exports'] = {k: {'types':v.replace('./src/', './types/').rsplit('.',1)[0]+'.d.ts', 'import':v} if isinstance(v,str) and v.endswith(('.tsx','.ts')) else v for k,v in meta['exports'].items()}
    for alias, targets in list(meta.get('imports', {}).items()):
        if isinstance(targets,dict) and 'bun' in targets:
            t=targets.get('types',targets['bun']); meta['imports'][alias]={'types':t.replace('./src/','./types/').removesuffix('.ts')+'.d.ts', **{k:v for k,v in targets.items() if k!='types'}}
    files = subprocess.check_output(['git','ls-files','-z','--','src'],cwd=pkg).decode().split('\0')[:-1]
    if name == 'util' and 'src/transcription-model.ts' not in files: files.append('src/transcription-model.ts')
    with tempfile.TemporaryDirectory() as tmp:
        dest = pathlib.Path(tmp)
        (dest/'node_modules').symlink_to(root/'node_modules')
        config = {'extends':str(pkg/'tsconfig.json'),'compilerOptions':{'noCheck':True,'declaration':True,'noEmit':False,'emitDeclarationOnly':True,'composite':False,'incremental':False,'declarationMap':False,'rootDir':str(pkg/'src'),'outDir':str(dest/'types')},'include':[str(pkg/'src')]}
        (dest/'tsconfig.json').write_text(json.dumps(config))
        subprocess.run([root/'node_modules/.bin/tsc','-p',dest/'tsconfig.json'],check=True,cwd=pkg)
        data = {f:(pkg/f).read_bytes() for f in files}
        if name == 'server':
            # Send conversation pairs, not the private absolute scratch path, to the voice model.
            f = 'src/handlers/transcription.ts'
            for line in (b'import { Location } from "@opencode/core/location"\n', b'  const location = yield* Location.Service\n', b'  if (location.directory) parts.push(`directory: ${location.directory}`)\n'):
                assert data[f].count(line) == 1
                data[f] = data[f].replace(line, b'')
        if name == 'core':
            f='src/transcription/transcribe.ts'
            old=b'["-y", "-i", "pipe:0", "-ac", "1", "-f", "mp3", "pipe:1"]'
            assert data[f].count(old)==1
            data[f]=data[f].replace(old,b'["-nostdin", "-v", "error", "-protocol_whitelist", "pipe", "-format_whitelist", "matroska,webm,mov,mp4,m4a,3gp,3g2,mj2,ogg", "-i", "pipe:0", "-map", "0:a:0", "-t", "60", "-ac", "1", "-f", "mp3", "pipe:1"]')
        data.update({f.relative_to(dest).as_posix():f.read_bytes() for f in (dest/'types').rglob('*.d.ts')})
        data.update({'LICENSE':(root/'LICENSE').read_bytes(),'package.json':json.dumps(meta,indent=2).encode()})
        target=out/f'{name}-{release}.tgz'
        with target.open('wb') as fp, gzip.GzipFile(fileobj=fp,mode='wb',mtime=0,filename='') as gz, tarfile.open(fileobj=gz,mode='w|') as tar:
            for f,b in sorted(data.items()):
                info=tarfile.TarInfo('package/'+f); info.size=len(b);tar.addfile(info,io.BytesIO(b))
        digest=hashlib.sha256(target.read_bytes()).hexdigest()
        target.rename(target.with_stem(target.stem+'-'+digest[:12]))
        print(name, digest,flush=True)
