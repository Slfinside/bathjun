#!/usr/bin/env python3
"""Build a public, static manual from an explicit allowlist. Never copy app data."""
from pathlib import Path
import argparse, html, json, shutil
ROOT=Path(__file__).resolve().parent.parent
PUBLIC=ROOT/'public'
escape=html.escape

def render(standalone=False):
    topics=json.loads((PUBLIC/'help/content.json').read_text())
    prefix='./' if standalone else '../'
    sections=[]
    for key,topic in topics.items():
        steps=''.join('<li><h3>'+escape(step['title'])+'</h3><p>'+escape(step['text'])+'</p></li>' for step in topic['steps'])
        details=''.join('<h3>'+escape(item['title'])+'</h3><p>'+escape(item['text'])+'</p>' for item in topic['details'])
        sections.append(f'<section class="manual-section" id="{key}"><h2>{escape(topic["title"])}</h2><p>{escape(topic["intro"])}</p><ol class="guide-steps">{steps}</ol><details class="guide-details"><summary>詳細を見る</summary>{details}</details><a class="manual-top" href="#top">目次へ戻る ↑</a></section>')
    nav=''.join(f'<a href="#{key}">{escape(topic["title"])}</a>' for key,topic in topics.items())
    css='./help.css' if standalone else './manual.css'
    return f'''<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#f6f5f0"><meta name="description" content="ふろきゅ～の予約・事前希望・アイテム・スタンプカードの使い方。"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; script-src 'none'; base-uri 'none'; form-action 'none'"><title>使い方ガイド | ふろきゅ～</title><link rel="icon" href="{prefix}icon.svg" type="image/svg+xml"><link rel="stylesheet" href="{prefix}fonts/web.css"><link rel="stylesheet" href="{prefix}style.css"><link rel="stylesheet" href="{css}"></head>
<body><div class="app-shell" id="top"><header class="site-header"><a class="brand" href="./"><span class="brand-icon" aria-hidden="true">♨</span>ふろきゅ～<span class="brand-dot">.</span></a></header><main><div class="manual-hero"><span class="date-caption">HOW TO USE</span><h1>使い方ガイド</h1><p>予約も、順番待ちも。迷ったら、ここから。</p></div><nav class="manual-nav" aria-label="目次">{nav}</nav>{''.join(sections)}<p class="manual-note">予約できる時間や報告期限などは、ご家庭の設定によって異なります。アプリに表示される内容を確認してください。</p></main><footer><span class="site-credit">Made by @Slfinside・with Codex</span></footer></div></body></html>
'''

def build(output):
    manifest=json.loads((PUBLIC/'fonts/web.json').read_text())
    expected={'index.html','.nojekyll','style.css','icon.svg','help.css','fonts/web.css','fonts/OFL.txt'}
    expected.update('fonts/web/'+font['file'] for face in manifest['faces'] for font in face['files'])
    existing={path.relative_to(output).as_posix() for path in output.rglob('*') if path.is_file()} if output.exists() else set()
    if existing - expected:raise ValueError('Output directory contains unrelated files; choose an empty directory')
    output.mkdir(parents=True,exist_ok=True)
    (output/'index.html').write_text(render(True))
    (output/'.nojekyll').write_text('')
    for source,target in [('style.css','style.css'),('icon.svg','icon.svg'),('help/manual.css','help.css')]:shutil.copyfile(PUBLIC/source,output/target)
    fonts=output/'fonts';fonts.mkdir(exist_ok=True)
    shutil.copyfile(PUBLIC/'fonts/web.css',fonts/'web.css')
    shutil.copyfile(PUBLIC/'fonts/OFL.txt',fonts/'OFL.txt')
    manifest=json.loads((PUBLIC/'fonts/web.json').read_text())
    (fonts/'web').mkdir(exist_ok=True)
    for face in manifest['faces']:
        for font in face['files']:shutil.copyfile(PUBLIC/'fonts/web'/font['file'],fonts/'web'/font['file'])
    print('Built public manual (static HTML/CSS/fonts only):',output)

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--output',type=Path);args=parser.parse_args()
    (PUBLIC/'help/index.html').write_text(render())
    if args.output:build(args.output)
