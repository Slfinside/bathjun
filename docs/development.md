# 開発・ビルド

## 開発と検証

Node.js 24以降。macOS・Linux対応です。

```sh
npm ci
npm run dev
npm test
```

テストは一時DBを使用し、実際の予約には触れません。日本時間の日付境界、抽選、認証、公開リンクの保護、予約順と重複、備考と任意表示、通知送信の対象と再試行、データ保持などを検証します。プッシュサービスへの通信はテスト用送信処理で置き換えます。

`PORT=3001 npm start` でポートを変更できます。LAN用サーバーの既定は `0.0.0.0:3000`、公開用は `127.0.0.1:3000` です。`BATHJUN_DB` でDBファイルを、`CLOUDFLARED` でcloudflared実行ファイルを指定できます。

## Windows版を再ビルドする

NSIS 3以降・Python 3・Node.js・C#コンパイラー（Mono mcsなど）があるビルド用マシンで `python packaging/build-windows.py --makensis makensis --csc mcs` を実行します。アプリ本体・固定バージョンの公式Node.jsとライセンス・JS依存だけを集め、チェックサムを検証してから `dist/Bathjun-Setup-x64.exe` を作ります。`data`・秘密鍵・既存パスワード・予約・開発テスト用データは含めません。配布するNode.jsのバージョンとSHA-256は `packaging/windows/runtime-lock.json` で管理しています。TailscaleはPC側で署名を検証して導入するため、初回のオンライン接続が必要です。


## ソースの構成

- `src/`: サーバー、認証、予約、通知、管理用IPC。
- `public/`: iPhone向けWeb画面・PWA。
- `migrations/`: SQLiteの追加マイグレーション。
- `packaging/windows/`: Windows管理画面・ダッシュボード・インストーラー。
- `test/`・`test-support/`: 一時DBを使うテスト。
- `docs/`: 利用者・管理者・開発者向け文書。
- `dist/`: ビルド出力。Gitには含めません。

`ServerPanel.cs`・`Dashboard.cs`・`HumanPresenceReader.cs` は同じアセンブリとしてコンパイルします。ネイティブ描画テストは `packaging/windows/tests/DashboardTest.cs`、メンバー入力テストは `MemberEntryTest.cs`、通信テストは `PanelOutboxTest.cs` です。Windows APIを実行しない描画・入力テストは Mono + Xvfb でも実行できます。

## リリース

バージョンを package.json / package-lock.json で揃え、`npm ci`・`npm test` とWindows配布物の検証を行います。`vX.Y.Z` タグをpushすると `.github/workflows/release.yml` が両配布物とSHA-256を作り、GitHub Releaseへ添付します。GitHubがタグから提供するSource code ZIP / tar.gzは実行用ZIPとは別です。ローカルのdata、環境変数ファイル、過去のバックアップは配布対象に入れません。

管理画面は .NET Framework 4.7.2 の PerMonitorV2 DPI 設定を同梱します。ビルド時にPE内のマニフェストと設定ファイルを検証します。人感機能はWindows HumanPresenceSensorのABIのみを利用し、カメラ録画・顔認証処理は追加しません。

ZIPは `python3 packaging/verify-distribution.py dist/Bathjun-Portable-x64.zip`、インストーラーは7-Zipで別の一時フォルダーへ展開して同スクリプトへフォルダーを指定すると、マニフェスト全ファイル・秘密データの混入・版番号・同梱文書を検証できます。
