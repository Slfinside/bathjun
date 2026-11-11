# 開発・ビルド

## 開発と検証

Node.js 24以降。macOS・Linux対応です。

```sh
npm ci
npm run dev
npm test
npm run test:browser
npm run test:sequences
```

ブラウザーテストにはChromeまたはChromiumが必要です。`BATHJUN_BROWSER_PATH`で実行ファイルを指定できます。`BATHJUN_BROWSER_SCREENSHOTS`を指定すると合成データの画面を保存します。連続操作テストは`BATHJUN_SEQUENCE_SEEDS`（カンマ区切り）と`BATHJUN_SEQUENCE_STEPS`で操作選択のseedと回数を指定できます。抽選結果には通常の乱数を使い、失敗時はseedと直近の操作を出力します。

Safari向けの表示確認には、同じテストをWebKitでも実行します。

```sh
node node_modules/playwright-core/cli.js install --with-deps webkit
BATHJUN_BROWSER_ENGINE=webkit npm run test:browser
```

CIではChromiumとWebKitの両方を確認します。ウインドウの中央位置・はみ出し・内部スクロールを縦横の画面サイズで検証し、iPhoneのホーム画面アプリ相当のユーザーエージェント・タッチ操作・`navigator.standalone`でも操作します。LinuxのWebKitでは自動操作が停止するService Workerとの干渉を避けるため、ワーカーをテスト内だけで無効にします。Chromium専用の仮想パスキー認証3項目はWebKitでは明示的にスキップします。これらはiOS実機の表示・ソフトキーボード・PWAの画面領域を完全に再現するものではありません。

テストは一時DBを使用し、実際の予約には触れません。日本時間の日付境界、抽選、認証、公開リンクの保護、予約順と重複、備考と任意表示、通知送信の対象と再試行、データ保持などを検証します。プッシュサービスへの通信はテスト用送信処理で置き換えます。

`PORT=3001 npm start` でポートを変更できます。LAN用サーバーの既定は `0.0.0.0:3000`、公開用は `127.0.0.1:3000` です。`BATHJUN_DB` でDBファイルを、`CLOUDFLARED` でcloudflared実行ファイルを指定できます。

## Windows版を再ビルドする

最初にWindows x64のMSVC／Windows SDKがあるビルダーで `python packaging/build-server-power.py --output build/Bathjun-Power.node` を実行します。Node-APIヘッダーとインポートライブラリはバージョン・SHA-256を固定して取得します。次にNSIS 3以降・Python 3・Node.js・C#コンパイラー（Mono mcsなど）があるビルド用マシンで `python packaging/build-windows.py --power-addon build/Bathjun-Power.node --makensis makensis --csc mcs` を実行します。アプリ本体・固定バージョンの公式Node.jsとライセンス・JS依存だけを集め、チェックサムを検証してから `dist/Bathjun-Setup-x64.exe` を作ります。`data`・秘密鍵・既存パスワード・予約・開発テスト用データは含めません。配布するNode.jsのバージョンとSHA-256は `packaging/windows/runtime-lock.json` で管理しています。TailscaleはPC側で署名を検証して導入するため、初回のオンライン接続が必要です。


## ソースの構成

- `src/`: サーバー、認証、予約、通知、管理用IPC。
- `public/`: iPhone向けWeb画面・PWA。
- `migrations/`: SQLiteの追加マイグレーション。
- `packaging/windows/`: Windows管理画面・ダッシュボード・インストーラー。
- `test/`・`test-support/`: 一時DBを使うテスト。
- `docs/`: 利用者・管理者・開発者向け文書。
- `dist/`: ビルド出力。Gitには含めません。

`ServerPanel.cs`・`Dashboard.cs`・`HumanPresenceReader.cs`・`ServerUpdate.cs` は同じアセンブリとしてコンパイルします。ネイティブ描画テストは `packaging/windows/tests/DashboardTest.cs`、メンバー入力テストは `MemberEntryTest.cs`、通信テストは `PanelOutboxTest.cs` です。Windows APIを実行しない描画・入力テストは Mono + Xvfb でも実行できます。

## リリース

バージョンを package.json / package-lock.json で揃え、`npm ci`・`npm test` とWindows配布物の検証を行います。`vX.Y.Z` タグをpushすると `.github/workflows/release.yml` が両配布物とSHA-256を作り、GitHub Releaseへ添付します。GitHubがタグから提供するSource code ZIP / tar.gzは実行用ZIPとは別です。ローカルのdata、環境変数ファイル、過去のバックアップは配布対象に入れません。

管理画面は .NET Framework 4.7.2 の PerMonitorV2 DPI 設定を同梱します。ビルド時にPE内のマニフェストと設定ファイルを検証します。人感機能はWindows HumanPresenceSensorのABIのみを利用し、カメラ録画・顔認証処理は追加しません。

ZIPは `python3 packaging/verify-distribution.py dist/Bathjun-Portable-x64.zip`、インストーラーは7-Zipで別の一時フォルダーへ展開して同スクリプトへフォルダーを指定すると、マニフェスト全ファイル・秘密データの混入・版番号・同梱文書を検証できます。

更新ファイルの検査は `ServerUpdateTest.cs` と `UpdateFixture.cs` で確認できます。MonoはネイティブEXEのFileVersionInfoを取得できないため、テストでは管理アセンブリのバージョンリソースを使用します。インストーラー起動・実際の上書き更新はWindows実機で別途確認が必要です。


## 共通フォント

`public/fonts/` に Noto Sans JP の400/700の静的TTF（ネイティブ用）と同じアウトラインのWOFF2（Web用）、OFLと出典・ハッシュを同梱します。`source.json` の出典は上流コミットで固定しています。Webのフォント名は Bathjun Sans、実体はネイティブと同じ Noto Sans JP です。WOFF2名に内容のハッシュを付けて、家族用リンクの保護を保ちながらブラウザー内にキャッシュします。

Windowsは `PrivateFontCollection` から同梱の Noto Sans JP の通常・太字を名前とスタイルで選び、そのFontFamilyを描画・測定で直接使います。日本語charsetと言語を明示し、文字は不透明な背景上でClearTypeGridFitにより描画します。Windowsへのフォントインストールは行いません。Linuxのlibgdiplusはprivate fontのメトリクスに制限があるため、Linux描画テストはFontconfigに同じ同梱フォントのディレクトリーを指定して実行します。Windows CIの描画テストは製品と同じprivate-font読み込みを直接使い、通常・太字と縦横の描画に加え、Windowsが実際に選択するGDIフォント名も確認してからReleaseを作ります。これらは実機の電源・人感センサーの検証ではありません。

## 予約開始日の区切り（開発中）

`bookingCutoff`が所属日の境界で、`bathStart` / `bathEnd`はその日の予約開始時刻の範囲として内部的に保持します。今日と抽選は日本時間0:00固定です。開始時刻を境界未満に制限し、終了は境界をまたげます。異なる日付の予約も実際の時刻で重複検証します。旧時間帯の履歴を残し、翌日以降のルールを一度だけ24時間枠へ移行します。予約・希望テーブルの終了時刻制約も全列・インデックス・トリガーを保持して拡張します。

## Windowsでの消灯中の実行継続（開発中）

`src/server-power.js` が `bin/Bathjun-Power.node` を予約サーバー内へ読み込み、System／Execution／threadの要求をそのプロセスで保持します。管理用IPCの `serverPowerHeld` と管理画面自身の要求の両方が有効な場合だけ消灯します。復帰時の認証済み `power/renew` で再取得し、ランタイム終了・Node環境終了の両方で解除します。モジュールを含まないWindowsのソース起動では消灯が無効になります。Windows以外では読み込みません。

Source checksではWindows上で配布用Nodeのチェックサムを検証して実要求をテストし、その保護モジュールを使ってLinuxビルダーでインストーラとZIPを組み立てます。配布ワークフローも同じ流れです。C++モジュールは静的CRTでビルドし、追加のVisual C++ランタイム配布を必要としません。[調査内容と実機検証の範囲](screen-off-investigation.md)も参照してください。
