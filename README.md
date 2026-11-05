# ふろじゅん ♨

お風呂の順番と時間を家族で共有するアプリです。Windows PCをサーバーにして、iPhoneなどのブラウザーから予約できます。

## v2.0.1

毎朝4:00のサーバー自動更新、画面内のお知らせと予約配信、当日の未確定スタンプに使ったインクの返却を追加しました。[v2.0.1の使い方](docs/updates-and-announcements.md)を参照してください。

週間スタンプとアイテム、プレゼントボックス、サーバーダッシュボード、曜日ごとの自動予約を収録した安定版です。アプリ内の使い方ガイド、自動予約の曜日別設定、未報告時の再予約確認、通知・認証・入力保持などの修正も含みます。日本語名は「ふろじゅん」に戻し、bathjunの識別子と既存データを引き継ぎます。

**[v2.0.1のリリース](https://github.com/Slfinside/bathjun/releases/tag/v2.0.1)** · [インストーラ](https://github.com/Slfinside/bathjun/releases/download/v2.0.1/Bathjun-Setup-x64.exe) · [ZIP版](https://github.com/Slfinside/bathjun/releases/download/v2.0.1/Bathjun-Portable-x64.zip)

[変更点と確認範囲](docs/release-notes.md)、[使い方ガイド](docs/client-help.md)、[消灯処理と実機確認の範囲](docs/screen-off-investigation.md)をご確認ください。

## v2.1.0向けの開発中の機能

開始時刻をまだ決めずに、所要時間だけ共有できる希望を追加しています。[通知の条件・計算例・設定方法](docs/duration-only-wishes.md)をご覧ください。以下のv2.0.0配布物には含まれません。

## 安定版のダウンロード

**[GitHub Releases](https://github.com/Slfinside/bathjun/releases/latest)** から取得してください。

| ファイル | 用途 |
| --- | --- |
| `Bathjun-Setup-x64.exe` | Windowsへのインストール。別端末への公開にも対応 |
| `Bathjun-Portable-x64.zip` | インストール不要。このPC内だけで試すZIP版 |
| `*.sha256` | 配布ファイルのSHA-256 |
| Source code (zip / tar.gz) | 開発者向けソース。実行用ZIPではありません |

Windows 10/11の64bit版、.NET Framework 4.7.2以降が必要です。Node.jsは同梱しています。Tailscaleの初回導入には管理者の許可が必要です。本体のみの導入とZIP版のローカルテストには管理者権限を要求しません。配布ファイルは未署名です。

非公開リポジトリでは、ダウンロードにも閲覧権限のあるGitHubアカウントが必要です。

## 使い方

- **[利用者向け：iPhoneでの初回設定・予約・通知](docs/user-guide.md)**
- **[管理者向け：導入・メンバー設定・外部公開・ダッシュボード・更新](docs/administrator-guide.md)**
- [開発者向け：ソース・テスト・ビルド](docs/development.md)
- [週間カード・アイテム・新メニューの使い方](docs/v2-preview-guide.md)
- [更新履歴](CHANGELOG.md)
- [セキュリティ確認結果と運用上の注意](docs/security-review.md)

## できること

- 抽選または固定順で予約する優先順位を決める
- 入浴時間の予約、備考、時間変更不可の表示、キャンセル
- 暦日の今日と予約・スタンプの区切り（初期7:00）を分け、朝の前日予約の確認と当日分の準備を並行
- 明後日までの事前希望の共有と、順番が来たときの自動確定（下位の希望を許容する管理設定）
- 曜日ごとの自動予約・「入らない/様子見」の個人設定
- パスキー、希望の結果・予約する番・設定した分数前の通知、ホーム画面への追加
- サーバー端末での常時表示ダッシュボードと共有QR
- メンバー・時間帯・予約時間・抽選制限の設定、パスワード変更、全データのリセット

初期状態に家族の名前や予約データは含みません。予約や認証情報はサーバーPC内に保存します。外部公開にはTailscale FunnelのHTTPSリンクを使い、家族側の端末へのTailscale導入やルーターのポート開放は不要です。
