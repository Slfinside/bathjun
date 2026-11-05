#!/usr/bin/env python3
"""Verify every manifest hash in a ZIP or an already-extracted installer payload."""
import argparse, hashlib, json, pathlib, tempfile, zipfile

def verify(root):
    manifest=json.loads((root/'build-manifest.json').read_text(encoding='utf-8'))
    expected=manifest['files']
    actual={p.relative_to(root).as_posix() for p in root.rglob('*') if p.is_file() and p.name!='build-manifest.json' and '$PLUGINSDIR' not in p.parts}
    # NSIS generates its own uninstaller, outside the application's payload.
    # Some NSIS/7-Zip combinations expose it at the extraction root.
    generated={'Uninstall.exe'} if 'distribution' not in manifest else set()
    if actual-generated!=set(expected):raise ValueError('Payload differs from its manifest')
    for name,digest in expected.items():
        path=root/name
        if hashlib.sha256(path.read_bytes()).hexdigest()!=digest:raise ValueError('Invalid file hash: '+name)
        if '/data/' in '/'+name or path.suffix in {'.sqlite','.db'} or path.name.startswith('.env'):raise ValueError('Private data in payload')
    for name in ['public/bath-reports.js','src/bath-outcomes.js','migrations/0024_bath_outcomes.sql','src/duration-only-wishes.js','src/time-selection-notifications.js','migrations/0022_time_selection_notifications.sql','docs/duration-only-wishes.md','src/announcements.js','src/installed-update.js','migrations/0023_announcements.sql','public/announcements.js','src/completion-policy.js','src/rebooking.js','migrations/0019_rebooking.sql','migrations/0020_completion_notice_receipts.sql','public/help.js','public/help/content.json','public/help/index.html','public/help/manual.css','public/fonts/web.css','public/fonts/web.json','src/wish-starts.js','migrations/0018_wish_starts.sql','src/auto-wishes.js','src/app.js','src/wish-notifications.js','migrations/0017_auto_wishes.sql','src/rewards.js','src/http.js','migrations/0016_stamp_ink.sql','public/stamps/bath.svg','public/items/bathStamp.svg','public/items/stampInk.svg','src/server-power.js','src/dashboard.js','src/standby-stamps.js','src/completion-reminders.js','migrations/0012_standby_stamps.sql','migrations/0013_completion_reminders.sql','public/app.js','public/emoji/1f436.png','public/emoji/LICENSE-GRAPHICS','docs/user-guide.md','docs/administrator-guide.md']:
        if (root/'app'/name).read_bytes()!=(pathlib.Path(__file__).resolve().parent.parent/name).read_bytes():raise ValueError('Stale application file: '+name)
    if not (root/'bin/Bathjun-Power.node').is_file():raise ValueError('Server power guard missing')
    if not (root/'bin/Bathjun-Server.exe.config').is_file():raise ValueError('DPI configuration missing')
    version=json.loads((root/'app/package.json').read_text())['version']
    bundle=json.loads((root/'app/release-announcements'/(version+'.json')).read_text(encoding='utf-8'))
    if bundle['version']!=version or not bundle['pages']:raise ValueError('Update announcement missing')
    for page in bundle['pages']:
        if page.get('image') and not (root/'app/release-announcements'/page['image']).is_file():raise ValueError('Announcement image missing')
    if 'distribution' not in manifest and not (root/'start-after-install.cmd').is_file():raise ValueError('Installer launch entry missing')
    if version!=manifest['version']:raise ValueError('Version mismatch')
    print(f'Verified {len(expected)} files, version {version}, {manifest.get("distribution","installer")}.')

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('path',type=pathlib.Path);args=parser.parse_args()
    if args.path.suffix.lower()=='.zip':
        with tempfile.TemporaryDirectory(prefix='bathjun-verify-') as temporary:
            with zipfile.ZipFile(args.path) as archive:archive.extractall(temporary)
            verify(pathlib.Path(temporary)/'Bathjun-Portable')
    else:verify(args.path)
