# 実装前レビュー記録: 収録モードAI参加者対応（ocean-review 2巡）

- 日付: 2026-08-20
- レビュアー: Codex CLI 0.144.5 / gpt-5.6-sol（read-only sandbox でリポジトリ直読）
- 対象: 実装計画（AI参加者=ChatGPTデスクトップ音声の3者収録 + Participant抽象化）
- 要件定義: `~/Downloads/jishushitsu_discord_A2A_requirements.md`（draft_v1）

## 第1巡: 指摘13件（要点）

| # | 重大度 | 指摘 | 採否 |
|---|---|---|---|
| 1 | Critical | タブ音声+明示リモートトラックの構造的二重取り込み。AIモニタ再生で三重化も | 全面採用 → 単一取り込みポリシー（AI有効時はタブ音声を録画ミキサーから除外、track.id重複排除） |
| 2 | Critical | クラッシュ・強制終了で録画チャンク全損（メモリ内配列のみ） | 条件付き採用 → P1: 冪等finalize(reason)+onerror回収+beforeunload。IndexedDB逐次永続化は最優先別タスク |
| 3 | Critical | OS「このデバイスを聴く」+LiveKit audiooutput切替はホストがBを聞けなくなり、自己ループも遮断保証なし | 全面採用 → アプリ内ChatGPT入力ミキサー（human限定・hidden audio+setSinkId(CABLE-B)）+プリフライト必須化 |
| 4 | High | AI publish が EchoNote 録音に無計画に混入（LocalTrackUnpublished 未処理） | 全面採用 → AIを含める仕様と明示、Unpublished対応、trackName分類共通化 |
| 5 | High | "ai:" トークンは後方互換でない（旧クライアントで未割当表示・未知layoutで空ステージ） | 条件付き採用 → 未知token/layoutの安全弁+schemaVersion。段階デプロイは不採用（第2巡で条件付き承認: 旧未リロードタブは非保証と明記+AI有効化前リロード依頼） |
| 6 | High | ai:<id> だけではリモート側がAIトラック/表示情報を解決できない | 全面採用 → StudioAiDescriptor（ownerIdentity+trackName完全一致で解決） |
| 7 | High | unpublishTrack はデフォルトで track を stop する。所有権未定義 | 全面採用 → Provider唯一オーナー、unpublish(track,false)、原子的再接続手順 |
| 8 | High | broadcast-studio が無検証・metadata全上書き・senderIdentity自己申告 | 条件付き採用 → shape検証・merge・revision・サイズ上限は採用。送信者認証は別タスク（第2巡で承認: 内部講師信頼モデル限定なら妥当、revision/schema検証は本件に残す） |
| 9 | Medium | StartAudioBanner相乗りでは独自AudioContextがresumeされない。participant単位activeSpeakerはAI判定に使えない | 全面採用 → AudioRuntime一元管理、track単位RMSのみ、listeningはP1除外 |
| 10 | Medium | 実装順が赤線検証を後回し | 採用 → 技術スパイクを先頭、単一取り込みを前倒し |
| 11 | Medium | AC-006のProvider契約テストがない | 全面採用 → FakeProvider（Oscillator）、Desktop providerのimportはfactoryのみ |
| 12 | Medium | monotonic session clock（FR-008/NFR-005）欠落 | 条件付き採用 → P1で内部イベント+クロック、JSON出力はP2（第2巡で承認: 基準はMediaRecorder.start()直前のperformance.now()） |
| 13 | Low | deviceId一致だけでは物理マイク誤選択を検知不十分 | 全面採用 → getSettings().deviceId+groupId+短時間相関測定 |

## 第2巡: 裁定 = **条件付きGO**

付帯条件（すべて計画に反映済み）:
1. 旧未リロードタブの表示維持は非保証と明記。AI有効化前に参加者へリロード依頼（運用ゲート）
2. R-2分離の条件: 完了条件を「AI障害・publish失敗・AIデバイス消失で人間録画を失わない」に限定。onerror回収は実際の途中WebM再生までテスト。finalize(reason)は冪等に
3. ChatGPT入力ミキサーは型+実行時ガードの二重化。プリフライトを4試験（A入る/B入る/AI無音/録画で各1回）に拡張
4. metadata は schemaVersion 必須 + revision 条件付き更新 + descriptor整合のshape検証（認証強化ではなく状態破壊防止として本件に残す）
5. EchoNote許可表: local mic + remote human + descriptor一致AI のみ。screen-share audioは既存挙動維持、未分類Unknownは除外

## 実装GOの必須条件（リリースゲート）
- プリフライト4試験の実機通過
- 本番LiveKitで Track.Source.Unknown の publish/subscribe/reconnect 試験
- 既存2者収録の回帰（4レイアウトのスクショ同等 + WebM音声）

## 別タスク起票
- (a) IndexedDB/OPFS 逐次チャンク永続化+クラッシュ復旧（本件P1完了直後の最優先）
- (b) broadcast-studio の送信者認証（セッション由来の身元確定）
