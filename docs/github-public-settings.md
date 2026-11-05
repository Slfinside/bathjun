# GitHubで公開する前の設定

公開リポジトリでも、閲覧者に書き込み権限は付きません。閲覧・ダウンロード・fork・Pull Requestの提案はできますが、元のファイルの変更やマージには書き込み権限が必要です。2026-11-05の確認では、Collaboratorsは所有者の `Slfinside` だけです。Wikiも無効です。

この作業では公開への切り替え・メンバーの権限変更・アプリのリリースは行いません。

## ファイルで設定したもの

- `.github/CODEOWNERS`：変更のレビュー担当を所有者に指定します。これだけでマージを禁止する機能ではありません。
- `.github/dependabot.yml`：npmとGitHub Actionsの更新を週1回確認し、各3件までPull Requestを提案します。自動マージは設定しません。
- Releaseワークフロー：既定のトークン権限を読み取りにし、Releaseを作成するジョブだけ書き込み権限を与えます。checkoutした作業ツリーにはGitHubの認証情報を残しません。

## GitHub管理画面で必要な設定

GitHub連携による管理APIの読み取り・変更は403で拒否されました。以下は適用済みではありません。非公開のままでは、現在のプランでブランチ保護を利用できないという応答もありました。

### 1. mainの保護

[Settings → Rules → Rulesets](https://github.com/Slfinside/bathjun/settings/rules) で、公開後にブランチ用ルールを作ります。

- 対象は `main`、状態は `Active`。
- `Require a pull request before merging` をオン。
- 一人で管理する間、必要な承認数は **0**。1にすると本人の変更を本人が承認できず、運用が止まります。第三者が自由にマージできるという意味ではありません。
- `Require conversation resolution before merging`、`Block force pushes`、`Restrict deletions` をオン。
- 必須チェックは、そのブランチのPRで実際に動くCIを確認してから指定します。存在しないチェックを必須にしないでください。

### 2. 外部PRのActions実行とトークン

[Settings → Actions → General](https://github.com/Slfinside/bathjun/settings/actions) で設定します。

- forkのワークフロー承認：`Require approval for all outside collaborators`。
- `Workflow permissions`：`Read repository contents and packages permissions`。
- `Allow GitHub Actions to create and approve pull requests`：オフ。

外部PRの実行を承認する前に、ワークフローや実行されるスクリプトも確認してください。実行の承認と、元リポジトリへのマージは別の操作です。

### 3. 秘密情報と依存関係の検出

[Settings → Code security](https://github.com/Slfinside/bathjun/settings/security_analysis) で、公開後に利用できる無料の機能を有効にします。

- Secret scanning と Push protection。
- Dependency graph、Dependabot alerts、Dependabot security updates。
- Private vulnerability reporting（脆弱性の詳細を非公開で受け付ける機能）。

依存関係の更新通知は、上記のDependabot更新PRとは別の設定です。

## 書き込み権限

[Settings → Collaborators](https://github.com/Slfinside/bathjun/settings/access) は、当面所有者だけにします。公開してもここに閲覧者が自動で追加されることはありません。forkは別のコピーなので、fork先の変更が元リポジトリへ勝手に反映されることもありません。
