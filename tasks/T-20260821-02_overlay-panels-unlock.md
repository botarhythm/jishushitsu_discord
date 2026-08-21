# T-20260821-02 サイドパネルのオーバーレイ化と録画中封鎖の条件解除

- status: done
- issuer: fable-5
- executor: opus
- effort: high
- project: C:/Users/seamo/Documents/gemini/Jishushitsu
- created: 2026-08-21
- depends-on: T-20260821-01 (done であること)
- attempts: 0

## 1. ゴール

チャットパネルと AI 設定パネルを「ステージのレイアウトに影響しないオーバーレイ」に変え、
Element Capture が有効な環境では**録画中でも自由に開閉できる**ようにする
（開閉しても録画に映らず、解像度も変わらないため）。フォールバック環境
(`captureExclusionMode === 'region'`) では現行の録画中封鎖を維持する。

## 2. 背景（最小限）

`docs/reviews/studio-side-panels-cross-review-2026-08-21.md` 必読（恒久対策の必須条件）。
T-20260821-01 で `captureExclusionMode: 'element' | 'region' | null` が
useLocalRecording から公開済み。element モードでは「ステージ要素のサブツリーのみが録画され、
重なった要素は除外される」ことが scripts/verify-element-capture.mjs で機械検証済み。
ユーザー要件は「収録セッション中にも AI 設定（配線調整）とチャット確認ができること」。
「録画中は開けない」封鎖はレビュー由来の暫定措置であり、本タスクがその解除条件を実装する。

## 3. スコープ

### 変更してよいファイル
- components/RoomView.tsx
- components/AiParticipantSetupModal.tsx
- components/StudioChatPanel.tsx
- components/StudioBar.tsx
- scripts/verify-element-capture.mjs （実 UI 構造での検証項目の追加）
- app/dev-capture-test/page.tsx （検証に必要な範囲の拡張のみ可）

### 触ってはいけないもの（非スコープ）
- hooks/useLocalRecording.ts（T-01 の成果物。API 追加が必要になったら returned(blocked) で返す）
- 録画の音声経路・AI 参加者の接続ロジック（AiParticipantSetupModal 内の音声処理コードは
  レイアウト変更に必要な範囲以外触らない）
- 通常モード（studioMode でない画面）のチャット UI
- git commit は作らない

## 4. 制約

- **実装仕様（発注者決定・変更不可）**:
  1. 両パネルを `position: fixed`（フロー外）のオーバーレイにする。チャットは左端・全高、
     AI 設定は右端・全高。ステージ列の flex 兄弟からは外し、開閉が
     ステージ要素の bounding box に一切影響しないこと。
  2. 収録モードの封鎖条件を次に変更する:
     `panelsLocked = isLocalRecordingStarting || (isLocalRecording && captureExclusionMode !== 'element')`
     - starting 中はモード未確定のため常に封鎖（現行踏襲）
     - element モード確定後は封鎖解除（録画中も開閉可）
     - region モード時は封鎖維持
  3. **region フォールバック時の強制クローズ**: `isLocalRecording && captureExclusionMode === 'region'`
     になったら両パネルを閉じる（region はオーバーレイが映り込むため）。
  4. **録画開始前の事前クローズ**は「`'RestrictionTarget' in globalThis` が false のブラウザ」
     でのみ行う（同期 feature-detect。element 対応ブラウザでは開いたまま録画開始してよい —
     オーバーレイはステージ寸法に影響せず、映り込みも除外されるため）。
     既存の prepareLayoutForRecording をこの仕様に改める。
  5. 「録画中は AI 参加者の ON/OFF 切替禁止」（音声二重取り込み防止）は**モードに関係なく維持**。
     StudioBar の aiToggleDisabled と AiParticipantSetupModal 内の無効化ボタンの
     録画中 disabled は解除しない。パネル内の配線調整（デバイス選択・レベル確認）は開ける。
  6. パネルの影・装飾がステージ上に視覚的に被るのは element モードでは問題ない
     （録画から除外される）。region 用に外していた shadow は復活させてよいが必須ではない。
  7. StudioBar のツールチップ文言を新仕様に合わせて更新する
     （「録画中は開閉できません」は region モード時のみ真になる）。
- 既存の Tailwind イディオム・日本語コメントの流儀を踏襲。新規依存なし。
- z-index はステージ関連 (z-20/z-30) より上、既存モーダル (z-50) より下に収める。

## 5. 受け入れ条件（AC）

ベースライン: T-20260821-01 done 時点で AC-1〜AC-6 全通過済みであること（未達なら blocked）。
eslint の既存エラー 1 件（useLocalRecording.ts 194 行）は既存として扱う。

- [x] AC-1: `npx tsc --noEmit` → exit 0
- [x] AC-2: `npx eslint components/RoomView.tsx components/AiParticipantSetupModal.tsx components/StudioChatPanel.tsx components/StudioBar.tsx` → エラー 0
- [x] AC-3: `node scripts/verify-element-capture.mjs` → exit 0 かつ従来項目
  (`elementMode`/`resolutionStable`/`overlayExcluded`/`fallbackRegionMode`/`failClosedOnMissingTarget`) がすべて true のまま
- [x] AC-4: 同スクリプトに追加する検証（検証ページを実 UI と同じ「fixed オーバーレイ + 封鎖条件」構造に
  拡張して実施）→ JSON が `panelToggleDuringElementRecording: true`
  （element モードの録画中にパネルをトグルしても settings 不変・録画継続・error なし）
  **T-01 からの申し送り反映**: この検証のステージ要素には、実物 StudioStage に存在する
  子要素種別を含めること — ①再生中の `<video>`（`canvas.captureStream()` を srcObject に
  流せば getUserMedia 不要）②requestAnimationFrame で描画し続ける `<canvas>`
  （AiEnergyOrb 相当）。これらを含んだ状態で `captureExclusionMode === 'element'` に
  なることを確認する（実物ステージで element eligibility が通ることの近似検証）。
- [x] AC-5: 同スクリプトのフォールバックランで `panelsLockedInRegionMode: true`
  （region モード録画中はパネル開閉ボタンが disabled であることを DOM で確認）
- [x] AC-6: `npm run build` → exit 0

## 6. 自己検証手順

1. 全 AC を上から順に実行する。
2. 失敗した AC があれば修正して再実行（attempts を +1）。attempts が 2 に達してなお失敗するなら中断し、status を returned にする。
3. AC 自体が誤っている・実現不能と判断した場合、AC を書き換えてはならない。status: returned、reason: ac-dispute として理由を実行報告に書く。

## 7. 完了の定義（DoD）

- 全 AC 通過
- 本ファイル末尾の実行報告を記入し status を done に更新
- KNOWLEDGE.md は更新しない（発注者がまとめて更新する）

---
## 実行報告（実行モデルが追記する）

- 結果: **done**（全 AC 通過 / attempts 0 = 自己修正なし）

### AC 結果

| AC | コマンド | 結果 |
|---|---|---|
| AC-1 | `npx tsc --noEmit` | exit 0（出力なし） |
| AC-2 | `npx eslint` (対象4ファイル) | exit 0 / エラー 0・警告 0 |
| AC-3 | `node scripts/verify-element-capture.mjs` | exit 0 / `ok: true` |
| AC-4 | 同上 | `panelToggleDuringElementRecording: true` |
| AC-5 | 同上 | `panelsLockedInRegionMode: true` |
| AC-6 | `npm run build` | exit 0（`/dev-capture-test` を含む全ルート生成） |

検証スクリプトの最終 JSON（フラグ部）:

```json
{
  "elementMode": true,
  "resolutionStable": true,
  "overlayExcluded": true,
  "panelToggleDuringElementRecording": true,
  "fallbackRegionMode": true,
  "panelsLockedInRegionMode": true,
  "panelsForceClosedInRegionMode": true,
  "failClosedOnMissingTarget": true,
  "ok": true
}
```

要点（details より）:

- run1（Element Capture）: `stageVideoPlaying: true` / `mode: "element"` / `panelsLocked: "false"`
  / `sizeBefore == sizeAfter == "1250x702"` / `overlayColorHits: 0`
  / パネル重なり `chatOverlapPx: 320`, `aiOverlapPx: 120`（＝「重なっていないから映らない」ではない）
  / トグル3往復後 `sizeAfterToggles: "1250x702"`, `stillRecording: "true"`, `errorAfterToggles: ""`
- run2（region フォールバック）: `mode: "region"` / 両トグルとも `isDisabled() === true`
  / 開いた状態で開始したパネルが `chatPanelState: "false"`, `aiPanelState: "false"` に強制クローズ
- run3（fail-closed）: 「収録ステージを取得できなかったため録画を中止しました。」/ `isRecording: "false"`

ベースライン確認: 着手前に T-20260821-01 時点の同スクリプトを実行し exit 0（従来5項目 true）であることを確認済み。
`npx eslint`（全体）のエラーは 3 件だが、いずれも本タスクの非スコープファイル
（`useAutoLogout.ts:77` / `useLocalRecording.ts:216`（= 課題文の「194 行」が T-01 の加筆で移動したもの）/ `useRoomsStatus.ts:48`）で既存。

### 変更ファイル

| ファイル | 内容 |
|---|---|
| `components/RoomView.tsx` | 両パネルをステージ列の flex 兄弟から外して fixed オーバーレイ化。封鎖条件を `panelsLocked` へ差し替え、AI 切替の封鎖 (`aiToggleLocked`) を分離。region 時の強制クローズ effect を追加。`prepareLayoutForRecording` を `'RestrictionTarget' in globalThis` の同期 feature-detect ベースに変更 |
| `components/StudioChatPanel.tsx` | `fixed inset-y-0 left-0 z-40`（全高オーバーレイ）へ。`shrink-0`/`h-full` を撤去 |
| `components/AiParticipantSetupModal.tsx` | `fixed inset-y-0 right-0 z-40` へ。`shadow-2xl` を復活（element モードでは収録から除外される）。録画中の無効化ガードは非変更 |
| `components/StudioBar.tsx` | `panelLockReason: 'starting' \| 'region' \| null` を追加し、封鎖ツールチップを理由別文言に差し替え |
| `app/dev-capture-test/page.tsx` | 実 UI と同じ「左右 fixed オーバーレイ + 同一の封鎖式 + region 強制クローズ」構造へ拡張。ステージ内に `canvas.captureStream()` を流した再生中 `<video>` と rAF 描画の `<canvas>` を追加。ページをスクロールさせない構成に変更 |
| `scripts/verify-element-capture.mjs` | 全面サンプリング化（左右両パネルを一度に見る）、パネル重なりの実測ガード、録画中トグル検証(f)、region 封鎖・強制クローズ検証(g) を追加 |

（`hooks/useLocalRecording.ts` / `components/StudioStage.tsx` / `package.json` の差分は T-20260821-01 のもので、本タスクでは触っていない）

### 逸脱・気づき

- **AC の追加検証を1つ足した**: `panelsForceClosedInRegionMode`（制約 §4-3 の強制クローズ）。
  AC に明記は無いが仕様要件なので機械判定に含めた（true）。AC の書き換えはしていない。
- **色判定が空振りにならない保証を追加**: 「パネル色が映らない」がレイアウト変更で
  無意味化するのを防ぐため、パネルとステージの矩形交差を `getBoundingClientRect` で実測し、
  重なりが 0 なら `overlayExcluded` を false に倒すようにした。
- **検証ページのステージを 640→1000px に拡大**した。右端 (`right-0`) のパネルを
  実 UI と同じ位置に置いたうえでステージへ食い込ませるための座標調整。あわせて
  操作 UI を `fixed` の帯へ移し、ページスクロール（Playwright の自動スクロールが
  ステージを動かす経路）を根絶した。
- **通常モード（studioMode でない画面）の挙動は不変**。そこでは `cropTarget` を渡さないので
  `captureExclusionMode` が常に null となり、`panelsLocked` は従来の
  `isLocalRecording || isStarting` と完全に同値になる。
- `app/dev-preview/ai-modal`（手順書スクショ用）は `AiParticipantSetupModal` を単体表示するが、
  `scripts/capture-help-shots.mjs` は aside 内側の `flex-col` 要素を element screenshot で
  撮っているため、fixed 化しても撮影結果は変わらない（撮り直し不要）。
- 実機での最終確認（レビュー記録 §「恒久対策の残タスク」4〜5: 実収録での WebM 検証・Canva 取込）は
  本タスクのスコープ外。ブラウザ自動検証までで止めてある。
