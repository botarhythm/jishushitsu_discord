# デジタル原っぱ大学 自習室

オンライン学習支援 WebRTC アプリです。**Discord OAuth2 認証**でアクセスを対象サーバーのメンバーに限定し、LiveKit Cloud + Next.js で構築しています。ブレイクアウトルーム・挙手通知・強制移動・自動退出・ローカル録画・EchoNote連携 (任意) を備えます。

## 主要機能

| 機能 | 説明 |
|------|------|
| **Discord OAuth2 ログイン** | 対象Discordサーバーのメンバーのみ参加可。「講師」ロール所持者は instructor 権限 |
| メインルーム | 全員が集まる広場。最大20名の画面共有を一覧表示 |
| ブレイクアウトルーム | 1対1指導用の個室（BO1〜BO3 の3部屋） |
| 挙手機能 | 受講生が質問を講師に通知 |
| 強制移動 / 強制退出 / 強制ミュート | 講師ダッシュボードから受講生を操作 |
| **自動退出** (受講生) | 入室から1時間で継続確認 → 5分応答なしで退出漏れとして自動退出 |
| **ローカル録画** (全員) | `getDisplayMedia` でタブ録画 + マイクmix、WebM 自動DL |
| セッション音声録音 | 講師ロール時、メイン/各BOを別ファイルとして録音 (EchoNote 設定時のみ) |
| EchoNote 連携 (任意) | 終了時に録音を [EchoNote](https://github.com/botarhythm/EchoNote) へ自動送信 → 文字起こし＋AI要約 |

## 技術スタック

| 層 | 技術 |
|----|------|
| フロントエンド | Next.js 16 (App Router) + TypeScript + React 19 |
| UI | Tailwind CSS v4 |
| WebRTC | LiveKit Client SDK + @livekit/components-react |
| 認証 | Discord OAuth2 + JWT (jose) を httpOnly Cookie に保存 |
| バックエンド | Next.js API Routes |
| WebRTC SFU | LiveKit Cloud |
| ホスティング | Vercel |

## ディレクトリ構成

```
jishushitsu/
├── app/
│   ├── page.tsx                                  # ランディング (Discordログインボタン)
│   ├── room/page.tsx                             # ルーム入室
│   └── api/
│       ├── auth/
│       │   ├── discord/start/route.ts            # OAuth2開始
│       │   ├── discord/callback/route.ts         # OAuth2コールバック
│       │   └── logout/route.ts                   # セッションCookie削除
│       ├── token/route.ts                        # LiveKit token (session認証)
│       ├── end-session/route.ts                  # 講師による全員終了
│       ├── invite/route.ts                       # Discord/Slack Webhook 招待送信
│       ├── echonote/{status,upload}/route.ts     # EchoNote 連携
│       └── {mute,remove,move}-participant/route.ts
├── components/
│   ├── LandingContent.tsx                        # ランディング (Discordログイン)
│   ├── RoomView.tsx                              # ルーム全体
│   ├── ControlBar.tsx                            # マイク/カメラ/共有/録画ボタン
│   ├── InstructorDashboard.tsx                   # 講師サイドパネル
│   ├── AutoLogoutModal.tsx                       # 自動退出確認モーダル
│   └── ...
├── hooks/
│   ├── useAutoLogout.ts                          # 1h+5min 自動退出タイマー
│   ├── useLocalRecording.ts                      # タブ録画 (getDisplayMedia)
│   ├── useSessionRecorder.ts                     # 講師音声録音 (EchoNote用)
│   └── useEndSession.ts                          # 終了モーダル制御
├── lib/
│   ├── session.ts                                # JWT発行/検証 + Cookie操作
│   ├── discord.ts                                # Discord OAuth2 helper
│   ├── auth-guard.ts                             # requireSession / requireInstructor
│   ├── echonote.ts                               # 講師→EchoNoteエンドポイント解決
│   └── types.ts
├── docs/
│   ├── admin-manual.md
│   ├── participant-manual.md
│   └── echonote-integration.md
├── .env.local                                    # 環境変数 (Git管理外)
├── .env.local.example                            # テンプレート
└── README.md
```

## セットアップ

### 前提条件

- Node.js 20 以上
- LiveKit Cloud アカウント ([cloud.livekit.io](https://cloud.livekit.io/))
- Discord Developer Portal でアプリ作成 ([discord.com/developers/applications](https://discord.com/developers/applications))
- 対象 Discord サーバー（受講対象者を所属させる）+ 「講師」ロール

### Discord アプリ設定

1. https://discord.com/developers/applications → New Application
2. OAuth2 → Redirects に以下を追加:
   - `http://localhost:3000/api/auth/discord/callback` (開発用)
   - `https://<your-domain>/api/auth/discord/callback` (本番用)
3. Client ID / Client Secret を控える
4. 対象サーバーの **Guild ID** と「講師」ロールの **Role ID** を控える (Discord 開発者モードONで右クリック→IDをコピー)

### インストール

```bash
# 1. 依存パッケージのインストール
npm install

# 2. 環境変数ファイルを作成
cp .env.local.example .env.local

# 3. .env.local を編集 (下記の環境変数一覧を参照)

# 4. SESSION_SECRET を生成
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 5. 開発サーバーを起動
npm run dev
```

`http://localhost:3000` でアクセスできます。

### 環境変数一覧

#### 必須

| 変数名 | 説明 |
|--------|------|
| `LIVEKIT_API_KEY` | LiveKit Cloud APIキー |
| `LIVEKIT_API_SECRET` | LiveKit Cloud APIシークレット |
| `LIVEKIT_URL` | LiveKit Cloud WSS URL (`wss://...`) |
| `DISCORD_CLIENT_ID` | Discord アプリの Client ID |
| `DISCORD_CLIENT_SECRET` | Discord アプリの Client Secret |
| `DISCORD_GUILD_ID` | プライマリ Discord サーバーの Guild ID (本番: ADHD `1500075036285866215`) |
| `DISCORD_INSTRUCTOR_USER_IDS` | 講師の Discord User ID をカンマ区切り (本番: 元沢 `1016907741018726470`, 塚ちゃん `1337662562283683861`) |
| `SESSION_SECRET` | JWT 署名鍵 (32バイト以上のランダム値) |

#### Discord 追加 guild (任意)

| 変数名 | 説明 |
|--------|------|
| `DISCORD_ADDITIONAL_GUILD_IDS` | 追加で許可する Guild ID をカンマ区切り (本番: デジハラ第1期 `1500085001717420134`) |

許可 guild のいずれかに所属していれば入室可。User ID で講師判定するため、どの guild から来ても元沢/塚ちゃんは instructor、それ以外は student。

#### 後方互換 (使用しない)

| 変数名 | 説明 |
|--------|------|
| `DISCORD_INSTRUCTOR_ROLE_ID` | 旧来のロールベース講師判定。`DISCORD_INSTRUCTOR_USER_IDS` を設定していれば実質上書きされる。新規には使用しない |

#### EchoNote 連携 / S2S (任意)

| 変数名 | 説明 |
|--------|------|
| `SERVICE_SHARED_SECRET` | EchoNote から `/api/invite-token` を Discord 認証なしで叩く際の共有秘密。EchoNote 側の `JISHUSHITSU_SERVICE_SECRET` と一致させる |

#### EchoNote 連携 (任意 / 講師ごとに別インスタンス可)

`INSTRUCTOR_<N>_DISCORD_ID` をキーに、その講師の EchoNote URL/Token を紐付けます。N は 1〜10 まで使用可能。

| 変数名 | 説明 |
|--------|------|
| `INSTRUCTOR_<N>_DISCORD_ID` | 講師の Discord User ID |
| `INSTRUCTOR_<N>_ECHONOTE_URL` | その講師の EchoNote インスタンスのベースURL |
| `INSTRUCTOR_<N>_ECHONOTE_TOKEN` | その講師の EchoNote `ECHONOTE_INGEST_TOKEN` |

未設定の講師は録音→要約フローが無効化され (録音そのものを実行しない)、終了モーダルは「全員終了」「自分だけ退出」のみのシンプルな表示になります。

#### 招待 Webhook (任意)

| 変数名 | 説明 |
|--------|------|
| `DISCORD_WEBHOOK_URL` | 招待モーダルから Discord に送信する Webhook URL |
| `SLACK_WEBHOOK_URL` | 同上 Slack 用 |

## 認証フロー

1. ユーザーが `/` で「Discordでログイン」をクリック
2. `/api/auth/discord/start` がランダム `state` を Cookie に保存して Discord 認可URLへリダイレクト
3. ユーザーが Discord で認可（要求スコープ: `identify`, `guilds.members.read`）
4. `/api/auth/discord/callback` が `state` 検証 → access_token 取得 → `/users/@me` と、許可 guild 群 (プライマリ + 追加) すべてに対して `/users/@me/guilds/<guild>/member` を並列取得
5. **どの許可 guild のメンバーでもなければ拒否**
6. 最初に見つかった guild のメンバー情報を採用し、「講師」ロール所持なら `role=instructor`、それ以外は `student` として JWT を発行し httpOnly Cookie に保存
7. `/room` にリダイレクト → LiveKit token を `/api/token` で取得して入室

### ワンタイム招待リンク (ゲスト経路)

Discord 認証を経由しない経路として `/api/invite-token` で発行する `/join/<token>` がある。
- 講師セッション (Cookie) からの発行: 受講生用 student role
- EchoNote 等の外部サービスからの `X-Service-Secret` ヘッダー付き発行: instructor / student いずれも指定可
- token は 1 回限り (consume 後は 410)、TTL 2 時間、退出 (`/api/auth/logout`) で session Cookie 削除

## デプロイ (Vercel)

1. このリポジトリを Vercel に Import
2. **Environment Variables** で `.env.local` の中身をまとめてペースト
3. Deploy
4. Vercel preview/production URL の callback を Discord Portal の Redirects に追加

## トラブルシューティング

| 症状 | 対処 |
|------|------|
| ローカルで `unable to verify the first certificate` | PCのTLS検査製品 (Zscaler等) が原因。Vercel本番では発生しない。本番URLでテストするのが最も確実 |
| ログイン後 `/` に戻され「対象サーバーに参加していません」 | Discord User の所属サーバーと `DISCORD_GUILD_ID` / `DISCORD_ADDITIONAL_GUILD_IDS` を確認 |
| 講師UIにならない (受講生UIになる) | `DISCORD_INSTRUCTOR_USER_IDS` に当該ユーザの Discord User ID が含まれているか確認 |
| 招待Webhookが届かない | `DISCORD_WEBHOOK_URL` / `SLACK_WEBHOOK_URL` の Webhook が有効か |
| 録画ボタンを押しても何も起きない | ブラウザの画面共有許可ダイアログを許可していない。「このタブ」+「タブ音声を共有」推奨 |

## 関連ドキュメント

- [管理者（講師）マニュアル](./docs/admin-manual.md)
- [参加者マニュアル](./docs/participant-manual.md)
- [EchoNote 連携](./docs/echonote-integration.md)
- [Discord 認証 / 許可 guild 運用](./docs/discord-auth.md)
- [LiveKit 公式ドキュメント](https://docs.livekit.io/)
- [Discord OAuth2 リファレンス](https://discord.com/developers/docs/topics/oauth2)
