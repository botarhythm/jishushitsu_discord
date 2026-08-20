# レビュー対象: AI参加者セットアップの設定永続化と、自己申告チェックの自動化

status: レビュー待ち（実装前）。2026-08-20。

## 背景

収録モードの AI 参加者（ChatGPT デスクトップ音声）は本番稼働中。設定は
`AiParticipantSetupModal` で行い、`AiParticipantConfig` として localStorage に保存する。

実機で **設定が勝手に戻る** 事象が繰り返し発生している。原因未特定。
あわせて、Windows 側の配線状態を利用者に自己申告させている2つのチェックボックスを
アプリ側の実測に置き換えたい。

## 観測された事実（実機・本番 session.botarhythm.com / Chrome）

時系列。利用者は「何もいじっていない」と明言している。

1. 設定完了状態を確認: ① `CABLE Output` / 通話マイク `マイク配列` /
   ② `Voicemeeter Input` / チェックボックス2つとも ON / 状態 🟢 接続済み
2. しばらく後に同じモーダルを開くと: ① **未選択** / ② 使用しない / チェック2つとも OFF
3. さらに後: ① `CABLE Output`（復活） / ② 使用しない / チェック2つとも OFF
4. localStorage の実値は未取得（利用者に依頼中）

つまり **一部のフィールドだけが既定値に戻る**。localStorage 全体が消えたわけではない
（①が復活しているため）。

## 関連する実装

- `lib/studio-participants.ts`
  - `AiParticipantConfig` / `DEFAULT_AI_CONFIG` / `loadAiConfig()` / `saveAiConfig()`
  - `AI_PARTICIPANT_STORAGE_KEY = 'jishushitsu.aiParticipant'`
- `components/RoomView.tsx`
  - `const [aiConfig, setAiConfig] = useState(() => loadAiConfig())`
  - `handleChangeAiConfig(c)` が唯一の書き込み経路（`setAiConfig` + `saveAiConfig`）
- `components/AiParticipantSetupModal.tsx`
  - `set(patch)` が `onChangeConfig({ ...config, ...patch })` を呼ぶ
  - `refreshDevices()` が `enumerateDevices()` で inputs/outputs を非同期に埋める
  - ②の `<select value={config.sinkDeviceId ?? ''}>`
  - `handleEnable()` が `validatedFingerprint` を付けて保存
- `components/AiPreflightPanel.tsx` — 収録前チェック6項目

## 当方の仮説（未検証。レビューで潰したい）

- H1: `enumerateDevices()` の解決前に `<select>` が描画され、保存済み deviceId に対応する
  `<option>` が無いため先頭項目が表示される。**state は保持されているが表示だけ既定に見える**。
  この状態で利用者が別項目を触ると `set()` が走り、表示上の値が実データとして確定して
  本当に失われる。
- H2: 何らかの経路で `config` が既定値の状態で `set()` が呼ばれ、
  `{...config, ...patch}` により他フィールドが既定へ巻き戻る（スプレッドによる意図しない上書き）。
- H3: audiooutput の deviceId がブラウザ再起動やデバイス構成変更で変わり、
  保存値が一覧に存在しなくなる（H1 と同じ表示症状を招く）。

チェックボックス2つ（`sendLocalMic` / `monitorAiLocally`）はデバイスに依存しない真偽値なので、
H1/H3 だけでは説明がつかない。ここが最大の疑問点。

## 提案（実装前）

### P1. 保存値の保護

- `<select>` の値が一覧に存在しない場合、**先頭項目にフォールバックさせない**。
  「保存済み: 〈ラベルまたはID〉（現在このPCで見つかりません）」という無効 option を
  動的に足して選択状態を維持する。
- `set(patch)` を全体置換ではなく **patch のみのマージ**にし、
  `RoomView` 側で `setAiConfig(prev => ({...prev, ...patch}))` の関数更新に変える
  （モーダルが持つ `config` プロップのスナップショットに依存しない）。
- `saveAiConfig` の呼び出し時に、既定値へ戻す変更を検知したら開発コンソールへ警告を出す
  （再発時の切り分け用）。

### P2. 自己申告チェックの自動化

現状、利用者に Windows 側の状態を申告させている:

- `sendLocalMic === false` = 「あなたの声は VoiceMeeter 側で常時 ChatGPT に送っている」
- `monitorAiLocally === false` = 「ChatGPT の声は Windows 側で常時モニタしている」

提案:

- **前者は実測できる**。アプリからの送出を止めた状態で、送出先（②）と対になる録音デバイス
  （例: `Voicemeeter Out B1`）を監視し、利用者に発声を促す。声が観測されれば
  VoiceMeeter が既に送っているので `sendLocalMic = false` を自動設定する。
  既存の `detectSignal()` と `findCableMonitorInput()` で実装可能。
- **後者はブラウザから検出できない**と当方は判断している。Windows の「このデバイスを聴く」の
  有効/無効を知る API が無く、ヘッドホン運用では物理マイクへの回り込みも起きないため。
  代案として「試聴ボタン」（5秒だけアプリ側から AI 音声を再生し、二重に聞こえるかを
  利用者の耳で判定させる）を提示している。

## レビューで判定してほしいこと

1. 設定が部分的に既定へ戻る現象の原因として、H1〜H3 以外に見落としている経路があるか。
   特にチェックボックス2つ（デバイス非依存の真偽値）が戻る説明がつく経路。
2. P1 の対策で再発を構造的に防げるか。不足があれば具体的に。
3. P2 後者（`monitorAiLocally`）は本当にブラウザから検出不能か。
   検出できる手段があるなら具体的に。無ければ試聴ボタン案の妥当性。
4. `AiPreflightPanel` の6項目のうち、利用者の操作を必要とせず自動化できるものが他にあるか。
