# Discord 認証 / 許可 guild 運用

Jishushitsu の Discord OAuth 認証で「どの Discord サーバーのメンバーを許可するか」「誰を講師として扱うか」を整理した運用ドキュメント。

## ルール (シンプル化後)

ロールベースから **User ID リストベース** に切り替え (2026-05-19)。

```
許可サーバー (guild) のいずれかに所属しているか?
  ├─ NO  → 入室拒否
  └─ YES → Discord User ID が instructor リストに含まれるか?
            ├─ YES → 講師 (instructor)
            └─ NO  → 受講生 (student)
```

## 現行運用

### 許可サーバー (guild)

| 区分 | 名前 | Guild ID | 環境変数 |
|------|------|----------|----------|
| プライマリ | After Digital Harappa Daigaku (ADHD) | `1500075036285866215` | `DISCORD_GUILD_ID` |
| 追加 | デジハラ第1期 | `1500085001717420134` | `DISCORD_ADDITIONAL_GUILD_IDS` (カンマ区切り) |

### 講師 (instructor) — Discord User ID 固定

| 名前 | Discord User ID |
|------|-----------------|
| 元沢 (もっちゃん) | `1016907741018726470` |
| 塚ちゃん | `1337662562283683861` |

環境変数: `DISCORD_INSTRUCTOR_USER_IDS=1016907741018726470,1337662562283683861`

**他のメンバーは全員 student** (許可 guild に所属していれば入室可)。

## 認証ロジック (`app/api/auth/discord/callback/route.ts`)

1. プライマリ guild + 追加 guild を結合して許可リストを構築 (重複排除)
2. ユーザの access_token で許可 guild 群すべてに対し `GET /users/@me/guilds/<guild_id>/member` を並列実行
3. **どれか 1 つでもメンバーシップが返れば認証通過**
4. `user.id` が `DISCORD_INSTRUCTOR_USER_IDS` に含まれていれば `instructor`、それ以外は `student`
5. JWT を発行して `lk_session` Cookie に保存

> **後方互換:** 旧 `DISCORD_INSTRUCTOR_ROLE_ID` も残してあり、最初にマッチした guild の roles[] にそのロール ID が含まれる場合も instructor 扱いになる。新運用では設定しない。

## 環境変数 (Vercel)

```
DISCORD_CLIENT_ID=...
DISCORD_CLIENT_SECRET=...
DISCORD_GUILD_ID=1500075036285866215
DISCORD_ADDITIONAL_GUILD_IDS=1500085001717420134
DISCORD_INSTRUCTOR_USER_IDS=1016907741018726470,1337662562283683861
SESSION_SECRET=<32+ バイトランダム>

# 不要 (廃止予定だが互換のため残置可)
# DISCORD_INSTRUCTOR_ROLE_ID=
```

Production / Preview / Development すべてに同じ値を設定。

## 追加 guild の動作前提

`guilds.members.read` scope は **OAuth 同意したユーザー自身の member 情報を返す** ため、Discord アプリ (bot) を追加 guild に導入する必要は原則ない。

ただし環境によっては Discord アプリが guild を認知している必要があるケースがあるので、`fetchGuildMember` が常に null/403 を返すようなら以下を実施:

1. Discord Developer Portal → Jishushitsu アプリ → OAuth2 → URL Generator
2. Scopes: `applications.commands` のみ (bot 機能不要のため最小権限)
3. 生成 URL を追加 guild の管理者に共有し、サーバーに導入

## 動作確認チェックリスト

| 経路 | 期待 | 確認状況 |
|------|------|----------|
| 元沢が ADHD 経由でログイン | instructor 判定 | ✅ 確認済 |
| 塚ちゃんが ADHD 経由でログイン | instructor 判定 | 未確認 |
| ADHD の一般メンバー (student) ログイン | student 判定で入室可 | 未確認 |
| 第1期メンバー (ADHD 未所属) ログイン | student 判定で入室可 | 未確認 |
| 第1期に元沢/塚ちゃんが所属していた場合のログイン | instructor 判定 (User ID 一致のため guild に関係なく) | 未確認 |
| 許可 guild に未所属のアカウントでログイン | 拒否 (「対象サーバーに参加していません」) | 未確認 |

## 運用変更時のフロー

| やりたいこと | 必要な作業 |
|---|---|
| 新サーバーを許可リストに追加 | `DISCORD_ADDITIONAL_GUILD_IDS` にカンマ区切りで guild ID 追加 → 再デプロイ |
| 講師を追加/交代 | `DISCORD_INSTRUCTOR_USER_IDS` に User ID 追加/差替 → 再デプロイ |
| サーバーをアクセス停止 | `DISCORD_ADDITIONAL_GUILD_IDS` から外す → 再デプロイ |

## Discord User ID の取得方法

1. Discord クライアント → 設定 → 詳細設定 → **開発者モードを ON**
2. 対象ユーザのアイコンを右クリック → **ユーザー ID をコピー**
3. 17-20 桁の数字が User ID
