## F-1-01 推奨VoiceMeeter配線とローカルマイクの必須混合が衝突する
- severity: P1
- affected: FR-003 / FR-008 / FR-010 / RAC-003
- evidence: FR-003はローカル人間マイクをミキサーへ含める。一方、`scripts/check-chatgpt-audio.ps1:216-221` は物理マイクのIN1→B1とVirtual Input→B1を同時に有効化する。`components/AiParticipantSetupModal.tsx:794-799` と `lib/ai/chatgpt-input-mixer.ts:75-81` は、この配線でアプリからもローカルマイクを送ると二重送出になるため除外する既存仕様を明示している。
- failure scenario: Windows修復でIN1→B1を有効化し、FR-003に従ってローカルマイクも混合すると、講師の声が直接経路とブラウザ経路から二重に届く。また、ブラウザで停止・退出しても直接経路は残り、ChatGPTは講師の声を引き続き取得できる。
- gap: 推奨経路の矛盾と、停止・ミュートの効力範囲の未定義。
- proposed resolution: 人間ごとのChatGPT入力は一経路だけと明記し、直接送出を維持する場合はFR-003に例外を設ける。通常通話のミュート・AI停止・退出が直接経路に及ぶかを決定し、ブラウザだけで停止できない範囲はUIに明示する。
- proposed test: IN1→B1あり／なしの両構成で講師音声の入力経路数を確認し、ミュート・停止・退出を実行する → 二重送出がなく、各操作後の直接経路とアプリ経路の状態が定義と一致する。

## F-1-02 「検証済み」と「会話可能」がリモート音声到達を保証する条件になっていない
- severity: P1
- affected: FR-005 / FR-006 / FR-007 / FR-009 / RAC-002 / RAC-006
- evidence: `docs/briefs/chatgpt-all-participants.md:17` は、B1の信号とChatGPT内部の入力選択が別である実測を記録する。`components/AiParticipantSetupModal.tsx:1013-1018` は自己ループがないという手動確認だけでも検証指紋を設定する。同ファイル`:1023-1031` では送出先なしでも設定でき、`lib/ai-wiring-plan.ts:42` はその簡易構成では相手の声が届かないと明記する。FR-006は検証済み配線と列挙デバイスの一致を起動条件とするが、検証の内容と更新条件を定義していない。
- failure scenario: 既存の自己ループ確認だけで保存された指紋を通常モードへ流用すると、リモート音声を一度も確認していない構成がワンクリック対象になる。その後ChatGPT内部のマイクだけが変更されてもデバイス列挙は変わらず、「会話可能」と表示できてしまう。
- gap: 検証の意味、既存検証記録の移行、外部設定が観測できない場合の状態表示が曖昧。
- proposed resolution: 「ブラウザ配線確認」「自己ループ確認」「リモートのみの音声による往復確認」を区別する。旧指紋の扱い、送出先欠落時の扱い、確認記録の無効化条件を明記する。外部の現在状態を観測できない場合は過去の確認と現在の接続状態を区別し、指紋一致だけで「会話可能」を保証しない。
- proposed test: 旧指紋、送出先なし、自己ループ確認のみ、ChatGPT内部入力のみ変更の各ケースで起動する → 全参加者との疎通確認済みと誤表示しない。リモート音声だけで応答と全員の再生を確認した場合に、定義された確認状態へ遷移する。

## F-1-03 単一ownerを成立させる原子的な更新境界が未定義
- severity: P1
- affected: FR-012 / NFR-005 / Security / RAC-004
- evidence: `app/api/broadcast-studio/route.ts:159-175` はmetadataを取得してrevisionを比較し、`:183-204` で取得時の全metadataを組み立て直して更新する。比較と更新は別操作である。FR-012は先着の単一owner、NFR-005はmergeと競合検出を要求するが、既存studio更新を含む同時更新の境界と障害時の動作を定義していない。
- failure scenario: 二つの開始要求がともにownerなしのmetadataを取得し、それぞれ成功して音声を開始する。またはstudio更新がAI取得前のmetadataを読み、取得後にその古い内容で全metadataを上書きし、owner情報を消す。順番に競合要求を送るだけのRAC-004では検出できない。
- gap: 単一ownerの実現に必要な共有排他・原子的な取得の依存関係と、他のmetadata更新経路との整合性が不足。
- proposed resolution: 所有権取得・解除をサーバーの単一の原子的判断で確定し、確定後だけ音声送出を開始すると明記する。studioを含む更新経路がAI状態を失わないこと、共有排他や状態ストアが利用不能なら開始しないことを要求する。具体方式と実行環境上の成立条件は設計で証明する。
- proposed test: 二つの開始要求を同じ読み取り時点で同期させて並行実行し、studio更新も交差させる → 成功するownerは一つ、送出も一つ、studioとAI双方の状態が保持される。必要な共有基盤の障害時は開始しない。

## F-1-04 音声保存・サーバー送信の禁止範囲が必要機能と矛盾する
- severity: P2
- affected: NFR-004 / FR-002 / FR-011
- evidence: NFR-004は「音声内容を保存・サーバー送信しない」とする。一方、FR-002はLiveKitへの音声publish、FR-011はAI録音トラック登録の維持を要求する。`hooks/useAiParticipant.ts:124` は録画レジストリへの登録、`:149-155` はLiveKitへのpublishを行い、`components/RoomView.tsx:291-310` は既存のローカルWebM録画にAIトラックを組み込む。
- failure scenario: NFR-004を文字通り実装するとLiveKit音声配信や既存録音を禁止することになる。逆に既存挙動を維持する実装はNFR-004に違反したと判断できる。
- gap: 音声経路・既存録音と、新設する設定／診断機能のデータ禁止範囲が区別されていない。
- proposed resolution: 既存の明示的な録音、LiveKit音声配信、ChatGPTへの音声入力を対象機能として区別し、追加する設定・診断・metadata・ログに音声内容を保存／送信しないという境界を明記する。
- proposed test: 通常モードのAI起動と、利用者が明示開始した録音を確認する → 必要な音声配信と録音は機能し、設定API・診断出力・metadata・ログには音声内容が含まれない。

Counts: P0=0, P1=3, P2=1, P3=0, question=0.

Unresolved questions:
- VoiceMeeterの直接マイク経路を維持する場合、通話ミュート・AI停止・退出後にChatGPTへ届く講師音声をどの操作で止めるか。
- 既存の検証指紋を移行時に失効させるか、検証内容ごとに段階を分けるか。
- 全metadata更新経路を含む原子的なowner管理を、実行環境上のどの共有機構で成立させるか。

Verdict: `revise`
