#!/usr/bin/env python3
"""Compile the shipped Windows UI against Microsoft's pinned .NET Framework 4.7.2 API."""
import argparse,hashlib,json,pathlib,subprocess,urllib.request,zipfile
ROOT=pathlib.Path(__file__).resolve().parent.parent
REFERENCES=['mscorlib','System','System.Core','System.Windows.Forms','System.Drawing','System.Web.Extensions','System.IO.Compression']
SOURCES=['ServerPanel.cs','Dashboard.cs','HumanPresenceReader.cs','ServerUpdate.cs','AutomaticUpdate.cs','TouchScroll.cs']
def compile_native(csc,output,assets,resource=None):
    assets=pathlib.Path(assets);assets.mkdir(parents=True,exist_ok=True)
    lock=json.loads((ROOT/'packaging/windows/framework-lock.json').read_text())
    package=assets/'net472.nupkg'
    if not package.exists():
        part=package.with_suffix('.part')
        try:
            with urllib.request.urlopen(lock['url'],timeout=90) as source,part.open('wb') as target:
                while chunk:=source.read(1024*1024):target.write(chunk)
            part.replace(package)
        finally:part.unlink(missing_ok=True)
    if hashlib.sha256(package.read_bytes()).hexdigest()!=lock['sha256']:raise ValueError('.NET Framework reference checksum mismatch')
    references=assets/'net472';references.mkdir(exist_ok=True)
    with zipfile.ZipFile(package) as archive:
        for name in REFERENCES:(references/(name+'.dll')).write_bytes(archive.read('build/.NETFramework/v4.7.2/'+name+'.dll'))
    output=pathlib.Path(output);output.parent.mkdir(parents=True,exist_ok=True)
    command=[str(csc),'-nostdlib+','-target:winexe','-platform:x64','-optimize+','-warnaserror+','-out:'+str(output)]
    command+=['-r:'+str(references/(name+'.dll')) for name in REFERENCES]
    if resource:command+=['-win32res:'+str(resource)]
    subprocess.run(command+[str(ROOT/'packaging/windows'/name) for name in SOURCES],check=True)
if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--csc',default='mcs');parser.add_argument('--output',required=True);parser.add_argument('--assets',default='/tmp/bathjun-framework-assets');args=parser.parse_args()
    compile_native(args.csc,args.output,args.assets)
