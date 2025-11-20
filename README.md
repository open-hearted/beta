# English Learning App

## Persistent AI Quota Tracking

This project records AI usage counts per user in Amazon S3 so that quotas persist even if learners clear their local history. The front-end consults `/api/usage` before each request to the chat or pronunciation services and the backend enforces per-user limits.

### Required Environment Variables

| Name | Purpose |
| --- | --- |
| `USAGE_S3_BUCKET` | S3 bucket used to store per-user quota JSON files. |
| `AWS_REGION` | Region for the S3 client (defaults to `ap-northeast-1`). |
| `LISTENING_USAGE_LIMIT` | Maximum listening evaluations permitted for the section (default `10`). |
| `TRANSLATION_USAGE_LIMIT` | Maximum translation evaluations permitted for the section (default `10`). |
| `PRONUNCIATION_USAGE_LIMIT` | Maximum pronunciation assessments permitted for the section (default `10`). |
| `AUTH_USERS` | JSON/string map of user IDs to password hashes. |
| `AUTH_ADMINS` | Comma-separated list or JSON collection of admin user IDs. |
| `AUTH_SECRET` | Secret used to sign auth tokens. |

Provide standard AWS credentials (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and optionally `AWS_SESSION_TOKEN`) in your deployment environment.

When the S3 bucket is unreachable the application logs a warning and falls back to in-memory storage. In-memory mode is intended only for local development because counters reset whenever the process restarts.

### API Endpoints

| Route | Method | Description |
| --- | --- | --- |
| `/api/usage` | `GET` | Returns the authenticated user's usage totals, limits, and remaining counts. |
| `/api/usage` | `POST` | Increments usage for `listening`, `translation`, or `pronunciation` by one (or the optional `amount`). Enforces limits. |
| `/api/usage-admin` | `GET` | Admin-only listing of all users' usage data. |
| `/api/usage-admin` | `POST` | Admin actions: `reset`, `delete`, or `get` for a specific user (`{ action, userId }`). |

Admin privileges require that the authenticated user ID appears in `AUTH_ADMINS` (strings, arrays, or JSON objects are supported).

### 管理用ダッシュボード

`admin.html` をブラウザーで開くと、S3 バケット内に保存された全ユーザーの使用状況を一覧できます。管理者としてログイン後、以下の操作が利用できます。

- 最新状態の再取得（`/api/usage-admin` から再読み込み）。
- ユーザーごとの使用回数リセット。
- ユーザーレコードの削除（S3 上のファイルを削除）。

環境が S3 に接続できない場合は、画面上部に「メモリ (再起動で消去されます)」と表示され、アプリケーションがメモリモードで動作していることが確認できます。