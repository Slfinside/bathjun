# ふろきゅ～ ♨

お風呂の順番と時間を家族で共有するアプリです。Windows PCをサーバーにして、iPhoneなどのブラウザーから予約できます。

## v2.0.0-rc2

週間スタンプ・特典チケット・プレゼント・新メニューとダッシュボードを搭載した第2リリース候補です。初回RC以降の修正・設定追加と、日本語名「ふろきゅ～」への変更を含みます。

**[v2.0.0-rc2のリリース](https://github.com/Slfinside/bathjun/releases/tag/v2.0.0-rc2)** · [インストーラ](https://github.com/Slfinside/bathjun/releases/download/v2.0.0-rc2/Bathjun-Setup-x64.exe) · [ZIP版](https://github.com/Slfinside/bathjun/releases/download/v2.0.0-rc2/Bathjun-Portable-x64.zip)

[RC版の使い方](docs/v2-preview-guide.md)と[変更・未搭載の範囲](docs/release-notes.md)をご確認ください。

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
- [v2.0.0向け開発版：週間カード・アイテム・新メニューの使い方](docs/v2-preview-guide.md)（v2.0.0-rc2に収録）
- [更新履歴](CHANGELOG.md)
- [セキュリティ確認結果と運用上の注意](docs/security-review.md)

## できること

- 抽選または固定順で予約する優先順位を決める
- 入浴時間の予約、備考、時間変更不可の表示、キャンセル
- 日付切り替え時刻の設定（初期2:00）と、前夜の確認・当日午後の準備の並行利用
- 明後日までの事前希望の共有と、順番が来たときの自動確定（下位の希望を許容する管理設定）
- 毎日自動で「入らない/様子見」にする個人設定
- パスキー、希望の結果・予約する番・設定した分数前の通知、ホーム画面への追加
- サーバー端末での常時表示ダッシュボードと共有QR
- メンバー・時間帯・予約時間・抽選制限の設定、パスワード変更、全データのリセット

初期状態に家族の名前や予約データは含みません。予約や認証情報はサーバーPC内に保存します。外部公開にはTailscale FunnelのHTTPSリンクを使い、家族側の端末へのTailscale導入やルーターのポート開放は不要です。
