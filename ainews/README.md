# Daily AI News to Slack

AI関連ニュースをRSS/Atomから収集し、重要度と新規性で5件前後に絞ってSlackへ投稿するGitHub Actions用の実装です。

## GitHub Secrets

Repository settings の `Secrets and variables` -> `Actions` に以下を設定します。

- `OPENAI_API_KEY`: 日本語要約に使うOpenAI APIキー
- `SLACK_BOT_TOKEN`: `chat:write` 権限を持つSlack bot token

Webhookで投稿したい場合は、`SLACK_BOT_TOKEN` の代わりに `SLACK_WEBHOOK_URL` を設定できます。

## GitHub Variables

必要に応じて `Variables` に以下を設定します。

- `SLACK_CHANNEL_ID`: 投稿先チャンネルID。未設定時は `C0B231KJ1B2`
- `OPENAI_MODEL`: 未設定時は `gpt-4.1-mini`

## ローカルテスト

```bash
cd daily-ai-news
npm run dry-run
```

OpenAI APIキーなしでも、RSS候補を使った簡易文面を表示します。

## 重複排除

投稿済みURLは `state.json` に保存します。GitHub Actions実行後に `state.json` を自動コミットするため、次回以降は同じURLを投稿しません。

## 情報源

情報源は `sources.json` で管理します。RSS/AtomのURLと重みを追加・削除できます。
