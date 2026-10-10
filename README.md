# デジタル原っぱ大学 自習室

オンライン学習支援 WebRTC アプリです。**Discord OAuth2 認証**でアクセスを対象サーバーのメンバーに限定し、LiveKit Cloud + Next.js で構築しています。ブレイクアウトルーム・挙手通知・強制移動・自動退出・ローカル録画・招待リンク (回ごと) を備えます。

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
| 招待リンク / 回 | Discord なしで入れる 1 人 1 リンク。期限を選べ (2〜72h)、回 (授業・収録) ごとに部屋が分かれる |

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
│       ├── invite-token/route.ts                 # 招待リンク発行 (講師のみ)
│       ├── space/route.ts                        # 回の確認・切り替え (講師のみ)
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
│   └── useEndSession.ts                          # 終了モーダル制御
├── lib/
│   ├── session.ts                                # JWT発行/検証 + Cookie操作
│   ├── discord.ts                                # Discord OAuth2 helper
│   ├── auth-guard.ts                             # requireSession / requireInstructor
│   ├── space.ts                                  # 回 → LiveKit 部屋名の変換
│   ├── invite-token.ts                           # 招待リンク JWT
│   ├── invite-revocation.ts                      # 招待リンクの失効
│   └── types.ts
├── docs/
│   ├── admin-manual.md
│   ├── participant-manual.md
│   └── echonote-integration.md                   # 廃止の記録
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
| `DISCORD_ADDITIONAL_GUILD_IDS` | 追加で許可する Guild ID をカンマ区切り (本番: デジハラ第1期 `1500085001717420134`, 第2期 `1529007741979332709`) |

許可 guild のいずれかに所属していれば入室可。User ID で講師判定するため、どの guild から来ても元沢/塚ちゃんは instructor、それ以外は student。

#### 後方互換 (使用しない)

| 変数名 | 説明 |
|--------|------|
| `DISCORD_INSTRUCTOR_ROLE_ID` | 旧来のロールベース講師判定。`DISCORD_INSTRUCTOR_USER_IDS` を設定していれば実質上書きされる。新規には使用しない |

#### 廃止した変数 (2026-10-10)

EchoNote 連携と、サーバー間で招待リンクを発行する入口を廃止した ([記録](./docs/echonote-integration.md))。
`SERVICE_SHARED_SECRET`・`INSTRUCTOR_<N>_DISCORD_ID`・`INSTRUCTOR_<N>_ECHONOTE_URL`・`INSTRUCTOR_<N>_ECHONOTE_TOKEN` はコードから参照されない。Vercel からの削除は店主が行う。

## 認証フロー

1. ユーザーが `/` で「Discordでログイン」をクリック
2. `/api/auth/discord/start` がランダム `state` を Cookie に保存して Discord 認可URLへリダイレクト
3. ユーザーが Discord で認可（要求スコープ: `identify`, `guilds.members.read`）
4. `/api/auth/discord/callback` が `state` 検証 → access_token 取得 → `/users/@me` と、許可 guild 群 (プライマリ + 追加) すべてに対して `/users/@me/guilds/<guild>/member` を並列取得
5. **どの許可 guild のメンバーでもなければ拒否**
6. 最初に見つかった guild のメンバー情報を採用し、「講師」ロール所持なら `role=instructor`、それ以外は `student` として JWT を発行し httpOnly Cookie に保存
7. `/room` にリダイレクト → LiveKit token を `/api/token` で取得して入室

### 招待リンク (ゲスト経路) と回

Discord 認証を経由しない経路として `/api/invite-token` で発行する `/join/<token>` がある。
- 発行できるのは Discord の講師セッション (Cookie) だけ。role は student 固定
- **1 人 1 リンク**。同じリンクで入り直せる (LiveKit の参加者 ID はリンクごとに固定)
- 期限は発行時に 2 / 6 / 24 / 72 時間から選ぶ (既定 24 時間)。ゲストのセッションもリンクの期限まで有効
- リンクは講師が今いる**回** (`/api/space` で切り替え) に固定される。LiveKit 上の部屋名は `<回ID>--main` のように回ごとに分かれ、既定の回は従来どおり `main` / `bo-1` …
- 講師が参加者を退出させるときに「リンクも無効にする」を選ぶと、その回の部屋の metadata に失効が記録され、同じリンクでは入れなくなる (410)。記録は回の部屋が開いている間だけ残る (外部ストレージなし)
- 退出 (`/api/auth/logout`) で session Cookie 削除

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
| 録画ボタンを押しても何も起きない | ブラウザの画面共有許可ダイアログを許可していない。「このタブ」+「タブ音声を共有」推奨 |

## 関連ドキュメント

- [管理者（講師）マニュアル](./docs/admin-manual.md)
- [参加者マニュアル](./docs/participant-manual.md)
- [EchoNote 連携 (廃止)](./docs/echonote-integration.md)
- [Discord 認証 / 許可 guild 運用](./docs/discord-auth.md)
- [LiveKit 公式ドキュメント](https://docs.livekit.io/)
- [Discord OAuth2 リファレンス](https://discord.com/developers/docs/topics/oauth2)
