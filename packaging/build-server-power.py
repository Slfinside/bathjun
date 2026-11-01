"""Build the small Node-API power guard with the Windows x64 SDK (no npm scripts)."""
import argparse,hashlib,json,os,pathlib,subprocess,tarfile,tempfile,urllib.request
ROOT=pathlib.Path(__file__).resolve().parent.parent

def build(output,assets):
    if os.name!='nt':raise RuntimeError('Build the power guard on a Windows x64 builder.')
    lock=json.loads((ROOT/'packaging/windows/power-addon-lock.json').read_text())
    if lock['nodeVersion']!=json.loads((ROOT/'packaging/windows/runtime-lock.json').read_text())['node']['version']:raise ValueError('Power guard and bundled Node versions differ')
    assets=pathlib.Path(assets).resolve();assets.mkdir(parents=True,exist_ok=True)
    files={}
    for key,name in [('headers','headers.tar.gz'),('library','node.lib')]:
        path=assets/name
        if not path.exists():
            part=path.with_suffix('.part')
            try:
                with urllib.request.urlopen(lock[key]['url'],timeout=60) as source,part.open('wb') as target:
                    while chunk:=source.read(65536):target.write(chunk)
                part.replace(path)
            finally:part.unlink(missing_ok=True)
        if hashlib.sha256(path.read_bytes()).hexdigest()!=lock[key]['sha256']:raise ValueError('Node build asset checksum mismatch: '+name)
        files[key]=path
    program=pathlib.Path(os.environ['ProgramFiles(x86)'])
    vswhere=program/'Microsoft Visual Studio/Installer/vswhere.exe'
    compilers=subprocess.check_output([str(vswhere),'-latest','-products','*','-requires','Microsoft.VisualStudio.Component.VC.Tools.x86.x64','-find',r'VC\Tools\MSVC\**\bin\Hostx64\x64\cl.exe'],text=True).splitlines()
    if not compilers:raise RuntimeError('MSVC x64 compiler is unavailable')
    compiler=pathlib.Path(compilers[0]);msvc=compiler.parents[3]
    sdk=program/'Windows Kits/10'
    versions=[p.name for p in (sdk/'Include').glob('10.*') if (p/'um/windows.h').exists() and (sdk/'Lib'/p.name/'um/x64/kernel32.lib').exists()]
    version=max(versions,key=lambda v:tuple(map(int,v.split('.'))))
    output=pathlib.Path(output).resolve();output.parent.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='bathjun-power-') as temporary:
        work=pathlib.Path(temporary)
        prefix='node-v'+lock['nodeVersion']+'/include/node/'
        with tarfile.open(files['headers']) as archive:
            for member in archive.getmembers():
                if member.isfile() and member.name.startswith(prefix) and member.name.endswith('.h'):
                    relative=pathlib.PurePosixPath(member.name[len(prefix):])
                    if relative.is_absolute() or '..' in relative.parts:raise ValueError('Invalid Node header path')
                    target=work/'include'/relative;target.parent.mkdir(parents=True,exist_ok=True)
                    target.write_bytes(archive.extractfile(member).read())
        includes=[work/'include',msvc/'include']+[sdk/'Include'/version/part for part in ['ucrt','shared','um']]
        libraries=[msvc/'lib/x64',sdk/'Lib'/version/'ucrt/x64',sdk/'Lib'/version/'um/x64']
        command=[str(compiler),'/nologo','/LD','/MT','/std:c++17','/O1','/W4','/WX','/utf-8','/D_WIN32_WINNT=0x0A00','/DNAPI_VERSION=8','/DNODE_GYP_MODULE_NAME=bathjun_power']
        command+=['/I'+str(path) for path in includes]
        command+=[str(ROOT/'packaging/windows/ServerPower.cc'),'/link','/OUT:'+str(output),'/IMPLIB:'+str(work/'power.lib'),'/LIBPATH:'+str(files['library'].parent)]
        command+=['/LIBPATH:'+str(path) for path in libraries]+[str(files['library']),'kernel32.lib']
        subprocess.run(command,cwd=work,check=True,env={**os.environ,'PATH':str(compiler.parent)+os.pathsep+os.environ.get('PATH','')})
    print('Built '+str(output))
if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--output',required=True);parser.add_argument('--assets',default='power-build-assets');args=parser.parse_args();build(args.output,args.assets)
