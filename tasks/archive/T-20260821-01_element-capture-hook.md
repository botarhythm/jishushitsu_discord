# T-20260821-01 Element Capture (restrictTo) 経路の追加と自動実機検証

- status: done
- issuer: fable-5
- executor: opus
- effort: high
- project: C:/Users/seamo/Documents/gemini/Jishushitsu
- created: 2026-08-21
- attempts: 0

## 1. ゴール

録画フックに Element Capture API (`RestrictionTarget` / `track.restrictTo`) の経路を追加し、
「対象要素に**重なった UI が録画から除外され**、かつ**重なってもレイアウト（＝出力解像度）が
一切変わらない**」ことを Playwright + 実 Chromium で機械検証できる状態にする。

## 2. 背景（最小限）

収録ステージは Region Capture (`cropTo`) で切り出しているが、cropTo は「矩形を覆うピクセルを
そのまま録る」ため、サイドパネル開閉でステージが伸縮すると録画途中で解像度が変わり
WebM が壊れる（実害・実測記録あり）。経緯と必須条件は
`docs/reviews/studio-side-panels-cross-review-2026-08-21.md` を必読。
Element Capture は「対象要素のサブツリーだけを録り、重なった要素を除外する」API
(Chrome 132+ GA。本機の Chrome 148 で `RestrictionTarget` の存在を確認済み) であり、
これに置き換えると (a) オーバーレイ UI が録画に映らない (b) レイアウトが動かないので
解像度も不変、の両方が同時に成立する。

## 3. スコープ

### 変更してよいファイル
- hooks/useLocalRecording.ts
- components/StudioStage.tsx （ステージ要素への `isolate` クラス付与のみ）
- app/dev-capture-test/page.tsx （新規・dev 専用検証ページ）
- scripts/verify-element-capture.mjs （新規・Playwright 検証スクリプト）
- package.json （検証用 npm script の追加のみ可）

### 触ってはいけないもの（非スコープ）
- components/RoomView.tsx / StudioBar.tsx / AiParticipantSetupModal.tsx / StudioChatPanel.tsx
  （パネルのオーバーレイ化と封鎖条件の変更は次タスク T-20260821-02）
- 録画の音声ミキシング経路・AI 参加者関連・EchoNote 関連
- next.config.ts の turbopack.resolveAlias（ts-ebml 修正。壊すと録画ファイルが再び死ぬ）
- git commit は作らない（発注者が監査後にまとめてコミットする）

## 4. 制約

- 実装言語・流儀は既存コードに合わせる（'use client'、Tailwind、日本語コメント）。
- useLocalRecording の公開 API は後方互換を保つ（既存の返り値は消さない。追加のみ）。
- 新しい依存パッケージを入れない（playwright は導入済み）。
- 検証ページは `process.env.NODE_ENV === 'production'` のとき `notFound()` を返し、本番に露出させない。
- **実装仕様（発注者決定・変更不可）**:
  1. `start()` のクロップ確保順序: `RestrictionTarget.fromElement + restrictTo` → 失敗/未対応なら
     現行の `CropTarget.fromElement + cropTo` → それも不可なら現行どおり録画中止 (fail-closed)。
  2. 確保できた方式を `captureExclusionMode: 'element' | 'region' | null` として state 公開する。
     既存の `regionCaptureActive` は互換のため残す（element 成功時も true にする。参照箇所を
     grep して意味が壊れないこと）。
  3. Element Capture の対象要素は「単一のスタッキングコンテキストを形成」する必要がある。
     StudioStage のクロップ対象 (stageRef が付く要素) に Tailwind の `isolate` を付与する。
  4. 録画中の ResizeObserver 防波堤（対象伸縮の検知と警告）は両モードで維持する。
- **検証スクリプト仕様（発注者決定・変更不可）**:
  - `scripts/verify-element-capture.mjs`。Playwright chromium を headless='new' 相当で起動し、
    起動引数 `--auto-select-tab-capture-source-by-title=<検証ページのdocument.title>` と
    `--autoplay-policy=no-user-gesture-required` で getDisplayMedia のピッカーを自動応答させる。
  - dev サーバーはスクリプトが port 3101 で spawn し、終了時に kill する（3100 は開発用に使用中）。
  - 検証ページ (app/dev-capture-test) の要件: ステージ相当要素（aspect-video・`isolate`・
    純色背景 #16a34a）、その上に**重なる**トグル式オーバーレイパネル（純色 #ff00ff・
    ステージの右半分を覆う `position: fixed` 要素）、useLocalRecording で録画開始/停止する
    ボタン、`captureExclusionMode`・トラック settings(width/height)・error の表示。
    全操作要素に data-testid。
  - 検証項目（すべて満たしたら exit 0、ひとつでも欠けたら exit 1。結果 JSON を stdout へ）:
    a. 録画開始後 `captureExclusionMode === 'element'`
    b. オーバーレイパネルを開いた 1 秒後、video track の getSettings().width/height が開く前と同一
    c. パネルが開いた状態のキャプチャフレーム（`<video>` + canvas.drawImage でサンプル）に
       #ff00ff 系のピクセルが存在しない（許容誤差 ±30/ch。ステージ右半分から 25 点サンプル）
    d. `page.addInitScript` で `RestrictionTarget` を削除した 2 回目のランでは
       `captureExclusionMode === 'region'` になる（フォールバック生存確認）
    e. d のランでステージ要素を DOM から外した状態で録画開始すると録画が開始されず
       error に「中止」を含む文言が出る（fail-closed 生存確認）

## 5. 受け入れ条件（AC）

ベースライン実測済み（発注者・2026-08-21）: `npx tsc --noEmit` → exit 0 /
`npx eslint hooks/useLocalRecording.ts` → error 1 件（194 行 `stopRef.current = stop` の
react-hooks/refs。既存）+ warning 1 件。この 2 件は既存として扱う。

- [x] AC-1: `npx tsc --noEmit` → exit 0
- [x] AC-2: `npx eslint hooks/useLocalRecording.ts components/StudioStage.tsx app/dev-capture-test/page.tsx scripts/verify-element-capture.mjs` → エラーは既存の 1 件（`Cannot access refs during render`）のみ。新規エラー 0
- [x] AC-3: `node scripts/verify-element-capture.mjs` → exit 0、stdout の JSON が `elementMode: true`, `resolutionStable: true`, `overlayExcluded: true`
- [x] AC-4: 同スクリプトのフォールバックラン（スクリプト内で自動実行）→ JSON が `fallbackRegionMode: true`
- [x] AC-5: 同スクリプトの fail-closed ラン（スクリプト内で自動実行）→ JSON が `failClosedOnMissingTarget: true`
- [x] AC-6: `npm run build` → exit 0（検証ページが本番ビルドを壊さないこと）

## 6. 自己検証手順

1. 全 AC を上から順に実行する。
2. 失敗した AC があれば修正して再実行（attempts を +1）。attempts が 2 に達してなお失敗するなら中断し、status を returned にする。
3. AC 自体が誤っている・実現不能と判断した場合、AC を書き換えてはならない。status: returned、reason: ac-dispute として理由を実行報告に書く。
   特に `--auto-select-tab-capture-source-by-title` が現行 Playwright chromium で機能しない等の
   環境事実が判明した場合は、勝手に検証方式を弱めず ac-dispute で返すこと。

## 7. 完了の定義（DoD）

- 全 AC 通過
- 本ファイル末尾の実行報告を記入し status を done に更新
- KNOWLEDGE.md は更新しない（発注者が T-02 完了後にまとめて更新する）

---
## 実行報告（実行モデルが追記する）

- **結果: done（全 AC 通過 / attempts 0 — AC 実行はいずれも初回で通過。下記「途中で潰した環境要因」は
  AC 実行前の作り込み段階の話であり、AC の失敗ではない）**

### AC 結果

| AC | コマンド | 結果 |
|---|---|---|
| AC-1 | `npx tsc --noEmit` | **exit 0**（出力なし） |
| AC-2 | `npx eslint hooks/useLocalRecording.ts components/StudioStage.tsx app/dev-capture-test/page.tsx scripts/verify-element-capture.mjs` | exit 1 だが内訳は **既存の 1 error + 1 warning のみ**（`useLocalRecording.ts:216 stopRef.current = stop` の `react-hooks/refs` / `:803` の `exhaustive-deps`）。**新規エラー 0**、新規3ファイルの指摘 0 → 条件どおり合格 |
| AC-3 | `node scripts/verify-element-capture.mjs` | **exit 0**。`elementMode: true` / `resolutionStable: true` / `overlayExcluded: true` |
| AC-4 | 同スクリプト内ラン2 | `fallbackRegionMode: true`（`restrictionTargetPresent: false` → `mode: "region"`） |
| AC-5 | 同スクリプト内ラン3 | `failClosedOnMissingTarget: true`（error=「収録ステージを取得できなかったため録画を**中止**しました。もう一度お試しください。」/ `isRecording: "false"`） |
| AC-6 | `npm run build` | **exit 0**。`/dev-capture-test` は `○ (Static)` で出力され、`next start` 実測で **HTTP 404**（`/` は 200）＝本番に露出しない |

AC-3〜5 の stdout（sample の生ピクセル配列のみ省略・**2 回連続で同一結果**）:

```json
{
  "elementMode": true, "resolutionStable": true, "overlayExcluded": true,
  "fallbackRegionMode": true, "failClosedOnMissingTarget": true, "ok": true,
  "details": {
    "run1": { "mode": "element", "sizeBefore": "1280x720", "sizeAfter": "1280x720",
              "overlayColorHits": 0, "error": "", "errorAfterStop": "" },
    "run2": { "restrictionTargetPresent": false, "mode": "region" },
    "run3": { "message": "収録ステージを取得できなかったため録画を中止しました。もう一度お試しください。",
              "isRecording": "false" }
  }
}
```

- サンプル 25 点はすべて `[23,163,77]`（= ステージの #16a34a）。#ff00ff は 0 点。
- 実機 Chromium は Playwright 1.62.1 同梱の **151.0.7922.34**（`channel: 'chromium'` = 新ヘッドレス）。

### 変更ファイル

| ファイル | 変更 |
|---|---|
| `hooks/useLocalRecording.ts` | `CaptureExclusionMode` 型を export。`captureExclusionMode` state を追加して返り値に追加（既存の返り値は削除なし）。`start()` のクロップ確保を `RestrictionTarget.fromElement + restrictTo` → 失敗/未対応なら `CropTarget.fromElement + cropTo` → 不可なら中止、の順に変更。成功時は方式によらず `regionCaptureActive = true`。ResizeObserver 防波堤は `cropRequested` 全体に掛かるため両モードで維持 |
| `components/StudioStage.tsx` | クロップ対象（`stageRef` が付く 16:9 要素）に Tailwind `isolate` を付与（+ 理由コメント） |
| `app/dev-capture-test/page.tsx` | 新規。dev 専用検証ページ（本番は `notFound()`） |
| `scripts/verify-element-capture.mjs` | 新規。Playwright 検証スクリプト（dev サーバーの spawn/kill 込み） |
| `package.json` | `verify:element-capture` script を追加（既存 script は無改変） |

`regionCaptureActive` の参照箇所を grep 済み: フック内部と返り値以外に消費者は無く（`RoomView.tsx` が使うのは `onRegionCaptureUnavailable` のみ）、element 成功時に true を返しても意味は壊れない。

### 途中で潰した環境要因（AC 実行前の作り込み段階）

1. **dev サーバーが残留して次回ランが別ポートへ逃げる** — `killDevServer` の `taskkill` を非同期 `spawn` で起動した直後に `process.exit()` していたため、taskkill が起動する前にプロセスが消えていた。`spawnSync` に変更。あわせて開始前に `assertPortFree()` を入れ、3101 が埋まっていたら「古いページを検証してしまう」前に落とすようにした。
2. **`127.0.0.1` ではハイドレーションが走らない** — Next 16 の dev サーバーがクロスオリジン扱いでクライアントチャンクを **403** にし、`_next/webpack-hmr` も失敗して effect が一切動かなかった（SSR の HTML だけが見えるので「動いているように見える」罠）。`localhost` に統一して解消。
3. **`document.title` が layout の metadata に書き戻される** — クライアントコンポーネントの `useEffect` で一度代入しても、ハイドレーション後に React 側の metadata レンダリングが上書きして `デジタル原っぱ大学 自習室` に戻っていた（`--auto-select-tab-capture-source-by-title` が一致せずピッカーが自動応答しない）。クライアント専用ページで metadata を宣言する手段が無いため、200ms 間隔の再表明で押さえた（検証ページ限定のローカルな対処）。

### 逸脱・気づき

- **逸脱なし。** 発注者決定の実装仕様 4 点・検証スクリプト仕様はすべて指定どおり実装した。
  `--auto-select-tab-capture-source-by-title` は現行 Playwright chromium で**問題なく機能する**（ac-dispute 不要）。
- **フックの公開 API は追加のみ**（`captureExclusionMode` と `CaptureExclusionMode` 型）。既存の返り値・引数・挙動は非変更。
- 検証ページはキャプチャストリームを掴むために `navigator.mediaDevices.getDisplayMedia` をページ内で包んでいる。
  フックに「ストリームを外へ出す」API を足すと本番の面が増えるため、`app/dev-preview/ai-modal/page.tsx` が
  `enumerateDevices` / `getUserMedia` をスタブしているのと同じ流儀で、検証ページ側に閉じ込めた。
- **T-02 への申し送り（重要）**: 実測できたのは「Element Capture が効けば重なる UI は映らず解像度も動かない」という
  API の性質までで、**StudioStage 実物での element モード成立は未検証**。`isolate` は付けたが、
  ステージ内には `VideoTrack`（LiveKit）や `AiEnergyOrb`（canvas）があり、実収録で `captureExclusionMode` が
  `'element'` になるかはホストの実機で必ず確認すること。`'region'` に落ちた場合は現行の封鎖が効き続ける
  （fail-closed は維持されているので壊れはしない）が、T-02 のオーバーレイ解禁条件は満たさない。
- Element Capture は「対象が要件（単一スタッキングコンテキスト）を満たさなくなると新しいフレームが出なくなる＝映像が凍る」
  という失敗モードを持つ。ステージ要素の `isolate` を将来外す/上書きするような CSS 変更は録画を静かに壊すので、
  `StudioStage.tsx` の該当行にその旨のコメントを残してある。
- ラン1では停止（`stop()`）まで通しており、`errorAfterStop` は空 = ts-ebml のインデックス付与を含む保存経路も
  headless 実機で例外なく通っている（判定条件には含めていない）。
