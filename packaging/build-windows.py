#!/usr/bin/env python3
"""Build an offline, per-user NSIS installer. Never package local data or keys."""
import argparse,hashlib,json,os,pathlib,re,runpy,shutil,struct,subprocess,tempfile,urllib.request,zipfile
ROOT=pathlib.Path(__file__).resolve().parent.parent

def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def fetch(url,path,expected=None):
    if not path.exists():
        temporary=path.with_suffix(path.suffix+'.part')
        try:
            with urllib.request.urlopen(url,timeout=90) as response,open(temporary,'wb') as out:
                while chunk:=response.read(1024*1024):out.write(chunk)
            temporary.replace(path)
        finally:temporary.unlink(missing_ok=True)
    if expected and sha(path)!=expected:raise RuntimeError(f'Checksum mismatch: {path.name}')

def windows_file_version(version):
    match=re.fullmatch(r'(\d+)\.(\d+)\.(\d+)(?:-rc(?:\.?([0-9]+))?)?',version)
    if not match:raise ValueError('Unsupported release version: '+version)
    parts=[int(match.group(i)) for i in range(1,4)]
    revision=int(match.group(4) or '1') if '-rc' in version else 65535
    if any(part>65535 for part in parts) or not 1<=revision<=65535 or ('-rc' in version and revision==65535):raise ValueError('Version is outside Windows resource limits')
    return '.'.join(map(str,[*parts,revision]))

def build(args):
    assets=pathlib.Path(args.assets).resolve();assets.mkdir(parents=True,exist_ok=True)
    lock=json.loads((ROOT/'packaging/windows/runtime-lock.json').read_text())
    for name,info in lock.items():fetch(info['url'],assets/(name+'.exe'),info['sha256'])
    output=pathlib.Path(args.output).resolve();output.parent.mkdir(parents=True,exist_ok=True)
    version=json.loads((ROOT/'package.json').read_text())['version']
    fonts=ROOT/'public/fonts'
    for name,info in json.loads((fonts/'source.json').read_text())['files'].items():
        if pathlib.Path(name).name!=name or sha(fonts/name)!=info['sha256']:raise RuntimeError('Shared font checksum mismatch')
    if not (fonts/'OFL.txt').is_file():raise RuntimeError('Shared font license missing')
    with tempfile.TemporaryDirectory(prefix='bathjun-win-build-') as temporary:
        payload=pathlib.Path(temporary)/'payload';app=payload/'app';app.mkdir(parents=True)
        for directory in ['src','public','migrations','docs']:shutil.copytree(ROOT/directory,app/directory)
        for file in ['package.json','package-lock.json','README.md']:shutil.copy2(ROOT/file,app/file)
        subprocess.run(['npm','ci','--omit=dev','--ignore-scripts','--no-audit','--no-fund'],cwd=app,check=True,env={**os.environ,'npm_config_cache':str(assets/'npm-cache')})
        if list((app/'node_modules').rglob('*.node')):raise RuntimeError('Native npm modules need Windows-specific builds')
        binary=payload/'bin';binary.mkdir()
        # Use a standard .res file: Mono mcs silently ignores -win32manifest.
        manifest_data=(ROOT/'packaging/windows/ServerPanel.manifest').read_bytes()
        resource=pathlib.Path(temporary)/'server-panel.res'
        null_header=struct.pack('<IIHHHHIHHII',0,32,0xffff,0,0xffff,0,0,0,0,0,0)
        manifest_header=struct.pack('<IIHHHHIHHII',len(manifest_data),32,0xffff,24,0xffff,1,0,0x30,0,0,0)
        resource.write_bytes(null_header+manifest_header+manifest_data+b'\0'*((-len(manifest_data))%4))
        runpy.run_path(str(ROOT/'packaging/build-native.py'))['compile_native'](args.csc,binary/'Bathjun-Server.exe',assets/'framework',resource)
        shutil.copy2(ROOT/'packaging/windows/ServerPanel.exe.config',binary/'Bathjun-Server.exe.config')
        runpy.run_path(str(ROOT/'packaging/windows/tests/verify-dpi.py'))['verify'](binary/'Bathjun-Server.exe')
        for name in lock:shutil.copy2(assets/(name+'.exe'),binary/(name+'.exe'))
        # Redistribute the upstream license texts with the bundled executables.
        for name,url in [('NODE-LICENSE.txt','https://raw.githubusercontent.com/nodejs/node/v'+lock['node']['version']+'/LICENSE')]:
            fetch(url,binary/name)
        png=(app/'public/icon-192.png').read_bytes()
        (app/'public/icon.ico').write_bytes(struct.pack('<HHH',0,1,1)+struct.pack('<BBBBHHII',192,192,0,0,1,32,len(png),22)+png)
        for name,mode in [('start-public.cmd','public'),('start-local.cmd','local'),('family-password.cmd','password')]:
            text='\r\n'.join(['@echo off','chcp 65001 >nul','setlocal','cd /d "%~dp0app"','set "BATHJUN_DATA_DIR=%LOCALAPPDATA%\\BathjunData"','set "UV_THREADPOOL_SIZE=2"','set "GOMEMLIMIT=64MiB"',f'"%~dp0bin\\node.exe" --max-old-space-size=96 src\\windows-launcher.js {mode}','set "bathjun_exit=%ERRORLEVEL%"','if not "%BATHJUN_AUTOSTART%"=="1" if not "%bathjun_exit%"=="0" pause','exit /b %bathjun_exit%',''])
            (payload/name).write_bytes(text.encode('utf-8'))
        (payload/'start-autostart.cmd').write_bytes(('\r\n'.join(['@echo off','set "BATHJUN_AUTOSTART=1"','set "BATHJUN_NO_BROWSER=1"','call "%~dp0start-local.cmd"',''])).encode('ascii'))
        shutil.copy2(ROOT/'packaging/windows/Windowsの使い方.txt',payload/'Windowsの使い方.txt')
        shutil.copy2(ROOT/'packaging/windows/install-tailscale.ps1',payload/'install-tailscale.ps1')
        files={str(path.relative_to(payload)).replace('\\','/'):sha(path) for path in payload.rglob('*') if path.is_file()}
        if any('/data/' in '/'+name or name.endswith('.sqlite') for name in files):raise RuntimeError('Private data must never be included')
        (payload/'build-manifest.json').write_text(json.dumps({'version':version,'runtime':lock,'files':files},ensure_ascii=False,indent=2),encoding='utf-8')
        if args.portable_output:
            portable=pathlib.Path(temporary)/'portable';shutil.copytree(payload,portable)
            # Local testing does not install services, request elevation or change Run keys.
            for name in ['install-tailscale.ps1','start-public.cmd','start-autostart.cmd']:(portable/name).unlink(missing_ok=True)
            for name in ['start-local.cmd','family-password.cmd']:
                raw=(portable/name).read_bytes().replace(b'BathjunData',b'BathjunTestData')
                (portable/name).write_bytes(raw)
            (portable/'はじめる.cmd').write_bytes(b'@echo off\r\ncall "%~dp0start-local.cmd"\r\n')
            shutil.copy2(ROOT/'packaging/windows/テスト版の使い方.txt',portable/'はじめに.txt')
            portable_files={str(path.relative_to(portable)).replace('\\','/'):sha(path) for path in portable.rglob('*') if path.is_file() and path.name!='build-manifest.json'}
            (portable/'build-manifest.json').write_text(json.dumps({'version':version,'distribution':'portable-local','runtime':lock,'files':portable_files},ensure_ascii=False,indent=2),encoding='utf-8')
            portable_output=pathlib.Path(args.portable_output).resolve();portable_output.parent.mkdir(parents=True,exist_ok=True)
            with zipfile.ZipFile(portable_output,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=6) as archive:
                for path in sorted(portable.rglob('*')):
                    if path.is_file():archive.write(path,pathlib.Path('Bathjun-Portable')/path.relative_to(portable))
            portable_output.with_suffix('.zip.sha256').write_text(sha(portable_output)+'  '+portable_output.name+'\n',encoding='ascii')
            print(f'Created {portable_output} ({portable_output.stat().st_size:,} bytes)')

        subprocess.run([args.makensis,'-WX','-V2',f'-DOUTPUT={output}',f'-DPAYLOAD={payload}',f'-DVERSION={version}',f'-DFILE_VERSION={windows_file_version(version)}',str(ROOT/'packaging/windows/installer.nsi')],check=True)
    output.with_suffix('.exe.sha256').write_text(sha(output)+'  '+output.name+'\n',encoding='ascii')
    print(f'Created {output} ({output.stat().st_size:,} bytes)')

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--makensis',default='makensis');parser.add_argument('--csc',default='mcs');parser.add_argument('--assets',default='/tmp/bathjun-windows-assets');parser.add_argument('--output',default=str(ROOT/'dist/Bathjun-Setup-x64.exe'));parser.add_argument('--portable-output',default=str(ROOT/'dist/Bathjun-Portable-x64.zip'));build(parser.parse_args())
