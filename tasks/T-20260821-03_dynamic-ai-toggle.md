# T-20260821-03 録画中の AI 参加者 ON/OFF を解禁する（音声経路の動的切替）

- status: done
- issuer: fable-5
- executor: opus
- effort: high
- project: C:/Users/seamo/Documents/gemini/Jishushitsu
- created: 2026-08-21
- attempts: 0

## 1. ゴール

録画中でも AI 参加者を ON/OFF できるようにする。ON にしても AI 音声が二重に録音されず、
OFF にしても録画が壊れない。切替は録画ファイルの中で滑らかに（クリックノイズなしに）行われ、
その挙動を音声トーンの帯域分析で機械検証できる状態にする。

## 2. 背景（最小限）

現在は「録画中の AI ON/OFF 全面禁止」（RoomView の `aiToggleLocked`）。理由は
useLocalRecording が録画開始時に excludeTabAudio（タブ音声を録るか）をスナップショットで
固定するため、録画中に AI を ON にすると「タブ再生 + AI トラック」で音声が二重になるから
（過去の Codex レビュー裁定）。AI トラック自体は AudioTrackRegistry (lib/audio-track-registry.ts)
の subscribe 機構で録画中の add/remove に動的追従済み。固定されているのは
**タブ音声の接続だけ**であり、そこを動的化すれば禁止を解除できる。
経緯: KNOWLEDGE.md [project-recording-pipeline] / docs/reviews/studio-side-panels-cross-review-2026-08-21.md

## 3. スコープ

### 変更してよいファイル
- hooks/useLocalRecording.ts
- components/RoomView.tsx
- components/StudioBar.tsx
- components/AiParticipantSetupModal.tsx （フッターの有効/無効ボタンの活殺のみ）
- app/dev-capture-test/page.tsx
- scripts/verify-element-capture.mjs

### 触ってはいけないもの（非スコープ）
- lib/audio-track-registry.ts（動的追従は実装済み。触る必要が生じたら returned(blocked)）
- useAiParticipant / AI プロバイダ接続ロジック（ON/OFF の解禁は封鎖フラグの変更のみで行う）
- useSessionRecorder（EchoNote 音声録音。タブ音声を扱わないため対象外）
- Element Capture / Region Capture の映像経路（T-01/02 の成果物。回帰は AC-3 で担保）
- git commit は作らない

## 4. 制約

- **実装仕様（発注者決定・変更不可）**:
  1. **タブ音声は常に GainNode 経由で接続する**。録画開始時、タブ音声トラックがあれば
     excludeTabAudio の値に関係なく `tabSrc → tabGain → destination` を構築し、
     初期ゲインを `excludeTabAudio ? 0 : 1` にする（ゲイン 0 = 従来の「接続しない」と
     録音内容が等価。unity gain は透過）。tabGain は RecordingResources に保持する。
  2. **録画中の excludeTabAudio 変化に動的追従する**: excludeTabAudio prop の変化を
     effect で監視し、録画リソースが生きていれば `setTargetAtTime`（時定数 ~0.02s、
     または ~80ms の linearRamp）でゲインを 0/1 へ滑らかに遷移させる。
     ノードの connect/disconnect のやり直しはしない（クリックノイズ源になるため）。
  3. 切替時に `recordSessionEvent({ type: 'tab_audio_gate', ... })` 相当のセッション
     イベントを記録する（既存の recordSessionEvent の流儀に合わせる。事後診断用）。
  4. **RoomView の封鎖変更**: `aiToggleLocked` を `isLocalRecordingStarting` のみに縮める
     （録画開始処理中だけ禁止。録画中は ON/OFF 可）。
     AiParticipantSetupModal フッターの「AI 参加者を無効にする」の `disabled={isRecording}`
     も撤廃する。StudioBar のツールチップ文言を新仕様に合わせる。
  5. **region モードの注意**: AI の ON/OFF 自体は音声の話なので region モードでも許可する。
     ただし toggleAi は「未設定なら設定パネルを開く」挙動を持ち、region モード録画中は
     パネルが封鎖されている。この場合はパネルを開かず、既存の DeviceErrorBanner 経路で
     「録画中は設定画面を開けません。配線設定済みの場合のみ切替できます」と表示する。
  6. 既存保護の不変条件: AI を一度も切り替えない録画では、録音内容が従来と完全等価であること
     （AI 無効スタート → tabGain=1 のまま / AI 有効スタート → tabGain=0 のまま）。
- **検証仕様（発注者決定・変更不可）**: scripts/verify-element-capture.mjs に音声ラン (run4) を追加:
  - dev-capture-test ページに追加する要素: ①タブ音声として 440Hz の OscillatorNode を
    `AudioContext.destination` へ再生（getDisplayMedia の audio:true がタブ音声として拾う）
    ②「AI 参加者トグル」相当のボタン — ON で 880Hz oscillator →
    `MediaStreamAudioDestinationNode` のトラックを AudioTrackRegistry に add し、
    excludeTabAudio を true に。OFF で registry から remove し excludeTabAudio を false に
    （実 UI と同じ配線: registry + excludeTabAudio 連動）。
  - シナリオ: 録画開始（AI OFF）→ 2 秒 → AI ON → 2 秒 → AI OFF → 2 秒 → 停止。
    各フェーズ境界の実時刻を page 側で記録する。
  - 保存された WebM Blob をページ内で `decodeAudioData` し、OfflineAudioContext +
    BiquadFilter (bandpass Q≈30) で 440Hz 帯と 880Hz 帯の RMS をフェーズごとに算出。
    境界の過渡 (±300ms) は除外して測る。
  - 判定（JSON キーは `audioDynamicSwitch`）:
    - フェーズ1 (AI OFF): 440 帯 RMS が基準値、880 帯はその 5% 未満
    - フェーズ2 (AI ON): 440 帯がフェーズ1 の 10% 未満（タブ音声ゲート閉）、
      880 帯がフェーズ1 の 440 帯と同オーダー（AI トラック取り込み）
    - フェーズ3 (AI OFF): 440 帯が復帰（フェーズ1 の 50% 以上）、880 帯が 5% 未満
    - 全フェーズを通して録画が継続し error が空
  - しきい値は上記を出発点とし、実測でノイズフロアに合わせて調整してよい
    （調整した場合は実行報告に実測値と共に記す）。判定構造自体は変えない。
- 既存の Tailwind イディオム・日本語コメント・コード流儀を踏襲。新規依存なし。

## 5. 受け入れ条件（AC）

ベースライン（T-02 done 時点）: `npx tsc --noEmit` exit 0 / verify スクリプト全項目 true /
eslint 既存エラーは useLocalRecording.ts 216 行の 1 件（+ 非スコープ 2 件）。

- [x] AC-1: `npx tsc --noEmit` → exit 0
- [x] AC-2: `npx eslint hooks/useLocalRecording.ts components/RoomView.tsx components/StudioBar.tsx components/AiParticipantSetupModal.tsx app/dev-capture-test/page.tsx scripts/verify-element-capture.mjs` → 新規エラー 0（既存の useLocalRecording.ts 1 件のみ許容）
- [x] AC-3: `node scripts/verify-element-capture.mjs` → exit 0 かつ既存 8 項目
  (`elementMode`/`resolutionStable`/`overlayExcluded`/`panelToggleDuringElementRecording`/
  `fallbackRegionMode`/`panelsLockedInRegionMode`/`panelsForceClosedInRegionMode`/
  `failClosedOnMissingTarget`) がすべて true のまま
- [x] AC-4: 同スクリプト → `audioDynamicSwitch: true`（上記判定をすべて満たす。
  details に各フェーズの 440/880 帯 RMS 実測値を含めること）
- [x] AC-5: 同スクリプトの element ランで、録画中に AI トグルボタンが `disabled` でないこと、
  および region ランで同ボタンが `disabled` でない（音声は方式非依存）ことを DOM で確認
  → `aiToggleUnlockedWhileRecording: true`
- [x] AC-6: `npm run build` → exit 0

## 6. 自己検証手順

1. 全 AC を上から順に実行する。
2. 失敗した AC があれば修正して再実行（attempts を +1）。attempts が 2 に達してなお失敗するなら中断し、status を returned にする。
3. AC 自体が誤っている・実現不能と判断した場合、AC を書き換えてはならない。status: returned、reason: ac-dispute として理由を実行報告に書く。
   特に headless Chromium でタブ音声 (getDisplayMedia audio) が取得できない等の環境事実が
   判明した場合は、検証方式を黙って弱めず ac-dispute で返すこと。

## 7. 完了の定義（DoD）

- 全 AC 通過
- 本ファイル末尾の実行報告を記入し status を done に更新
- KNOWLEDGE.md は更新しない（発注者がまとめて更新する）

---
## 実行報告（実行モデルが追記する）

- 結果: **done**（全 AC 通過 / attempts 0）

### AC 結果

| AC | 結果 | 実行結果の要点 |
|---|---|---|
| AC-1 | pass | `npx tsc --noEmit` → exit 0 |
| AC-2 | pass | 新規エラー 0。検出は `useLocalRecording.ts:266 react-hooks/refs`（既存の `stopRef.current = stop`。ベースラインの 216 行が行ずれしただけ）+ 同ファイル `exhaustive-deps` warning 1 件。ベースライン（stash して再 lint）と件数・内容が完全一致することを確認済み |
| AC-3 | pass | `node scripts/verify-element-capture.mjs` → exit 0。`elementMode`/`resolutionStable`/`overlayExcluded`/`panelToggleDuringElementRecording`/`fallbackRegionMode`/`panelsLockedInRegionMode`/`panelsForceClosedInRegionMode`/`failClosedOnMissingTarget` すべて true |
| AC-4 | pass | `audioDynamicSwitch: true`（実測値は下表） |
| AC-5 | pass | `aiToggleUnlockedWhileRecording: true`（run1 element 録画中 `aiToggleDisabled:false` / run2 region 録画中 `aiToggleDisabled:false`。同じ run2 でパネル開閉ボタンは `true`=封鎖のままであることも併記して確認） |
| AC-6 | pass | `npm run build` → exit 0（`/dev-capture-test` 含め全ルート生成） |

#### AC-4 実測値（run4 / duration 6.18s / 48kHz / 2ch / blob 184,821 bytes）

| フェーズ | 測定区間(s) | 440帯 RMS | 880帯 RMS | 基準比 440 | 基準比 880 |
|---|---|---|---|---|---|
| phase1 (AI OFF) | 0.300–1.879 | 0.176594 | 0.003918 | 1.000（基準） | 0.0222 |
| phase2 (AI ON) | 2.479–3.943 | 0.003923 | 0.176859 | 0.0222 | 1.0015 |
| phase3 (AI OFF) | 4.543–6.044 | 0.176293 | 0.003911 | 0.9983 | 0.0221 |

`stillRecording: "true"` / `error: ""`（全フェーズを通して録画継続・エラーなし）。
残留 2.2% は Q=30 bandpass の裾（1 オクターブ離れた他方の音）で、これがノイズフロア。
判定しきい値は発注仕様のまま（5% / 10% / 50%）採用し、変更していない。
「880 帯がフェーズ1 の 440 帯と同オーダー」だけは機械判定用に `0.3 <= ratio <= 3` と具体化した（実測 1.0015）。
なお phase1 の 440 帯 RMS 0.176594 は発振器振幅 0.25 の理論 RMS 0.176777 と 0.1% 差で一致しており、
unity gain が透過であること（不変条件 6 の「等価」）が実測で裏付けられている。

### 変更ファイル

- `hooks/useLocalRecording.ts` — タブ音声を常時 `tabSrc → tabGain → destination` で接続（初期ゲイン `excludeTabAudio ? 0 : 1`）。`tabGain` を `RecordingResources` に保持。`excludeTabAudio` 変化を監視する effect で `setTargetAtTime(target, now, 0.02)` により 0/1 を滑らかに遷移（connect/disconnect のやり直しはしない）。切替時に `recordSessionEvent({ type: 'tab_audio_gate', open })`。
- `components/RoomView.tsx` — `aiToggleLocked` を `isLocalRecordingStarting` のみに縮小。`toggleAi` の録画中 alert 封鎖を撤廃。未設定 + `panelsLocked`（region 録画中）のときはパネルを開かず `setDeviceError('録画中は設定画面を開けません。配線設定済みの場合のみ切替できます。')`。
- `components/StudioBar.tsx` — AI トグルのツールチップ文言と prop コメントを新仕様に更新。
- `components/AiParticipantSetupModal.tsx` — フッター「無効にする」の `disabled={isRecording}`/title を撤廃、`canEnable` と `enableBlockReason` から `isRecording` を除去。テストトーン系の録画中封鎖はそのまま維持。
- `app/dev-capture-test/page.tsx` — 440Hz タブ音声トーン（`?audio=1` のときのみ再生）、AI 参加者トグル（880Hz → `MediaStreamAudioDestinationNode` → `AudioTrackRegistry` + `excludeTabAudio` 連動）、フェーズ境界の時刻記録、停止時に Blob と境界を `window.__audioRun` へ受け渡し、`capture-audio-tracks` 等の診断表示を追加。
- `scripts/verify-element-capture.mjs` — run4（音声動的切替）と帯域 RMS 解析（`decodeAudioData` + `OfflineAudioContext` + bandpass Q=30、境界 ±300ms 除外、フィルタ立ち上がり 100ms 除外）を追加。run1/run2 で AI トグルの `disabled` を DOM 確認し `aiToggleUnlockedWhileRecording` を合成。
- `lib/session-clock.ts` — **スコープ外だが必要最小限の追加**（下記「逸脱」参照）。

### 逸脱・気づき

1. **`lib/session-clock.ts` を触った（スコープ外・非スコープ指定でもない）**。制約 3 の
   `recordSessionEvent({ type: 'tab_audio_gate', ... })` は `SessionEventInput` が
   閉じた union のため、型を足さないと呼べない。追加は
   `tab_audio_gate` の 2 union メンバーと `summarizeSessionEvents` の件数表示のみで、
   既存イベントの意味・形は変えていない。
2. **headless Chromium でタブ音声が無音になる真因は Playwright の `--mute-audio`**。
   Playwright は headless 起動時に既定でこの引数を足す。付いていると
   `getDisplayMedia({audio:true})` のトラックは `live`/`unmuted` で取れるのに中身が
   完全な無音になり、外から見ると「切替の失敗」と区別が付かない。音声ラン(run4)だけ
   `ignoreDefaultArgs: ['--mute-audio']` で外して解決した（`peakHz=439.45` を実測して確定）。
   副作用として run4 の約10秒間は実際にスピーカーから 440Hz が鳴る（音声出力デバイスが要る）。
   ac-dispute には該当しない（環境の制約ではなく起動引数の問題だった）ため通常完了とした。
3. **Chrome のタブ音声 APM が測定を汚す**。`audio: true` のタブ音声には既定で
   AGC/NS/AEC が掛かり、純音を「雑音」とみなして数秒かけて 1/3 以下（0.176→0.019）まで
   削っていく。この状態では phase3 の復帰判定（50% 以上）が**ゲートとは無関係に**落ちる。
   本番の `getDisplayMedia` 引数は変えず、dev-capture-test ページが既に持っている
   getDisplayMedia パッチの中で、`?audio=1` のときだけ
   `audio: { echoCancellation:false, noiseSuppression:false, autoGainControl:false }` を
   指定するようにした。測定対象はこちらのゲートであって Chrome の APM ではないため。
   本番経路（`audio: true`）は未変更。
4. `?audio=1` を付けないランでは 440Hz トーンを鳴らさない設計にした（run1〜3 は無音のまま）。
   実行のたびに PC から音が出るのを音声ランの約10秒に限定するため。
5. 不変条件 6（AI を切り替えない録画の等価性）は、①初期ゲインが従来と同じ論理で決まること
   ②unity gain が透過であることの実測（phase1 の RMS が理論値と 0.1% 差）で担保。
   ゲート追従 effect は `tabGateTargetRef` と目標値が一致する間は何もしないので、
   切替が起きない録画では `setTargetAtTime` も session event も発生しない。
