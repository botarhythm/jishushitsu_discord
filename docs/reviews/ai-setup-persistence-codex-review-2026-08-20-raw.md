結論から言うと、設計メモの P1 だけでは再発防止になりません。部分巻き戻りの最有力原因は「デバイス列挙」ではなく、スキーマなしの設定オブジェクトを複数タブ／旧バンドルが全体上書きできる構造です。加えて、録画開始を誤認させる UI と、録画中 AI 有効化による二重取り込み経路があります。

1. [Critical] 「AI参加者つきで収録開始」を押しても録画は開始されない

理由: ボタン文言は「収録開始」ですが、ハンドラは `enterStudio()` と `setAiEnabled(true)` しか呼ばず、`startLocalRecording()` を呼んでいません。利用者が収録開始済みと誤認すると、そのテイクは丸ごと失われます。

根拠:

- [components/InstructorDashboard.tsx:283](C:/Users/seamo/Documents/gemini/Jishushitsu/components/InstructorDashboard.tsx:283)
- [components/RoomView.tsx:524](C:/Users/seamo/Documents/gemini/Jishushitsu/components/RoomView.tsx:524)
- 実際の録画開始処理は別経路の [components/RoomView.tsx:539](C:/Users/seamo/Documents/gemini/Jishushitsu/components/RoomView.tsx:539)

修正案:

- 即時対策は文言を「AI参加者つき収録レイアウトを開始」に変更する。
- 本当にワンクリック収録にするなら、同じユーザージェスチャ内で `getDisplayMedia()` を開始する。ただし `aiEnabled` の state/effect 更新待ちに依存せず、`excludeTabAudio: true` を録画開始引数として明示的に渡すこと。
- 録画インジケーターが点灯するまで「収録開始済み」と表示しない。

2. [Critical] 録画中に StudioBar から AI を有効化でき、AI 音声が二重取り込みされる

理由: セットアップモーダルでは録画中の有効化を禁止していますが、StudioBar の `toggleAi()` は録画状態を確認しません。録画開始時に `aiEnabled=false` ならタブ音声がミックスされています。その後 AI を有効化すると、AI トラックがレジストリ経由で追加される一方、録画開始時に選ばれたタブ音声経路は残ります。同じ AI 音声が「タブ再生音＋明示 AI トラック」で二重になります。

根拠:

- 無条件で AI を有効化する [components/RoomView.tsx:512](C:/Users/seamo/Documents/gemini/Jishushitsu/components/RoomView.tsx:512)
- StudioBar へ直接渡している [components/RoomView.tsx:923](C:/Users/seamo/Documents/gemini/Jishushitsu/components/RoomView.tsx:923)
- `excludeTabAudio` は録画開始時のスナップショット [hooks/useLocalRecording.ts:128](C:/Users/seamo/Documents/gemini/Jishushitsu/hooks/useLocalRecording.ts:128)
- タブ音声接続 [hooks/useLocalRecording.ts:310](C:/Users/seamo/Documents/gemini/Jishushitsu/hooks/useLocalRecording.ts:310)
- 録画中でも動的に AI トラックを追加 [hooks/useLocalRecording.ts:453](C:/Users/seamo/Documents/gemini/Jishushitsu/hooks/useLocalRecording.ts:453)

修正案:

- 録画中は AI の OFF→ON を全経路で禁止する。UI 無効化だけでなく `toggleAi()` 内でも拒否する。
- 将来動的切替を許可するなら、録画ミキサー内でタブ音声と明示トラックの排他を実行時に切り替える必要がある。
- 「AI 無効で録画開始→録画中 AI ON」の回帰テストを追加し、音声波形が1倍であることを確認する。

3. [High] 真偽値を含む「部分巻き戻り」の最有力原因は、欠落フィールドの既定値補完と stale な全体保存

理由: `sendLocalMic` と `monitorAiLocally` は optional で、保存 JSON に存在しない場合は `true` に補完されます。一方、どの変更も `...config` を含む設定全体を保存します。別タブ、旧バンドル、以前から開いていた画面が `sourceDeviceId` だけ保持し、`sinkDeviceId=null`、真偽値欠落または `true` の状態で何か一項目を保存すると、観測された状態そのものになります。

実際、履歴上 `sendLocalMic` と `monitorAiLocally` は初期実装より後に追加されています。スキーマ番号がないため、旧形式と現形式を区別できません。

根拠:

- optional な真偽値 [lib/studio-participants.ts:150](C:/Users/seamo/Documents/gemini/Jishushitsu/lib/studio-participants.ts:150)
- 既定値が両方 `true` [lib/studio-participants.ts:179](C:/Users/seamo/Documents/gemini/Jishushitsu/lib/studio-participants.ts:179)
- 欠落値を既定値で補完 [lib/studio-participants.ts:205](C:/Users/seamo/Documents/gemini/Jishushitsu/lib/studio-participants.ts:205)
- stale な props を含めて全体保存 [components/AiParticipantSetupModal.tsx:423](C:/Users/seamo/Documents/gemini/Jishushitsu/components/AiParticipantSetupModal.tsx:423)
- 親も全体置換・全体保存 [components/RoomView.tsx:248](C:/Users/seamo/Documents/gemini/Jishushitsu/components/RoomView.tsx:248)
- `storage` イベント同期や競合検出は存在しない。

H1/H3について:

- 保存済み ID に対応する option がない間、select が空または先頭相当に見えることはあります。
- しかし controlled select は、別のチェックボックスを操作しただけで `e.target.value` を自動保存しません。`set()` は表示値ではなく実際の `config` をスプレッドするため、H1 の「別項目を触ると表示上の値が実データになる」は現コードでは成立しません。
- ①が後から復活するのは、`inputs=[]` で初回描画した後に `enumerateDevices()` が完了する流れで説明できます。[components/AiParticipantSetupModal.tsx:101](C:/Users/seamo/Documents/gemini/Jishushitsu/components/AiParticipantSetupModal.tsx:101)、[components/AiParticipantSetupModal.tsx:117](C:/Users/seamo/Documents/gemini/Jishushitsu/components/AiParticipantSetupModal.tsx:117)、[components/AiParticipantSetupModal.tsx:524](C:/Users/seamo/Documents/gemini/Jishushitsu/components/AiParticipantSetupModal.tsx:524)
- H3 は表示不整合を起こしますが、真偽値を変更できません。`deviceId` は通常は保存可能な識別子ですが、権限やサイトデータ消去等でローテーションし得ます。[W3C Media Capture and Streams](https://www.w3.org/TR/mediacapture-streams/)

なお、現コードには「時間経過だけで state を既定値へ戻す effect」はありません。真偽値が実際に OFF 表示へ戻ったなら、再マウント時のロード、または全体保存による置換が必要です。localStorage 実値と複数タブの有無が最終確証になります。

4. [High] P1 は同一 React ツリー内の stale props しか防げず、構造的な再発防止として不足

理由: 親で関数更新にすれば、同一コンポーネント内の連続更新競合は防げます。しかし、旧バンドル、別タブ、欠落フィールド、不正型、保存失敗には効きません。

修正案:

- 保存キーを `jishushitsu.aiParticipant.v2` のように更新する。旧コードは旧キーしか書けないため、旧タブからの上書きを遮断できる。
- `{schemaVersion, revision, updatedAt, buildId, config}` の envelope を導入する。
- ロード時にフィールドごとの型検証を行い、正規化後は真偽値を required にする。`as Partial<...>` だけで信用しない。
- UI API は `onChangeConfig(config)` ではなく `onPatchConfig(patch, reason)` に限定し、マージ・検証・保存を一か所へ集約する。
- `storage` イベントで別タブ更新を state に反映する。
- `saveAiConfig()` の例外を黙殺せず、成功可否を返して画面に「設定を保存できません」を表示する。[lib/studio-participants.ts:224](C:/Users/seamo/Documents/gemini/Jishushitsu/lib/studio-participants.ts:224)
- console 警告は補助に留める。「既定値になった」ではなく、変更元、変更フィールド、schemaVersion、tabId、buildId を記録する。
- 保存済み ID が一覧にない無効 option の追加は採用してよい。ただしこれは UX 改善であり、巻き戻りの主修正ではない。

React ハイドレーションは今回の主因ではありません。`RoomInner` は参加ボタン押下後に初めてマウントされるため、`loadAiConfig()` はこの構造ではブラウザ側で呼ばれます。[components/RoomView.tsx:72](C:/Users/seamo/Documents/gemini/Jishushitsu/components/RoomView.tsx:72)、[components/RoomView.tsx:95](C:/Users/seamo/Documents/gemini/Jishushitsu/components/RoomView.tsx:95)、[components/RoomView.tsx:126](C:/Users/seamo/Documents/gemini/Jishushitsu/components/RoomView.tsx:126)

5. [High] 保存した真偽値が稼働中の音声経路へ反映されない

理由:

- `monitorAiLocally` は `attachTrack()` 時に一度読むだけで、Provider effect の依存配列に含まれません。
- `sendLocalMic` もミキサー `start()` 時に一度読むだけで、ミキサー effect の依存配列は `room` と `sinkDeviceId` だけです。

そのため、有効化中にチェックを変更しても UI/localStorage と実際の配線が食い違います。特に `sendLocalMic=false` が反映されないと、VoiceMeeter とアプリの双方から自声を送り続けます。

根拠:

- monitor の一回読み [hooks/useAiParticipant.ts:117](C:/Users/seamo/Documents/gemini/Jishushitsu/hooks/useAiParticipant.ts:117)
- Provider effect の依存 [hooks/useAiParticipant.ts:182](C:/Users/seamo/Documents/gemini/Jishushitsu/hooks/useAiParticipant.ts:182)
- sendLocalMic の一回読み [hooks/useAiParticipant.ts:247](C:/Users/seamo/Documents/gemini/Jishushitsu/hooks/useAiParticipant.ts:247)
- ミキサー effect の依存 [hooks/useAiParticipant.ts:265](C:/Users/seamo/Documents/gemini/Jishushitsu/hooks/useAiParticipant.ts:265)

修正案:

- `monitorAiLocally` 変更専用 effect で、既存 monitor element の `srcObject` を即座に付け外しする。
- `sendLocalMic` を依存配列へ追加してミキサーを再構築するか、ミキサーに `setIncludeLocalMic(boolean)` を追加する。
- 配線検証指紋に両真偽値も含め、変更時は再検証済み状態を失効させる。

6. [High] プリフライト未実施・失敗でも「検証済み配線」として保存できる

理由: `canEnable` はソース、衝突、録画状態しか見ておらず、`loopCheck` や `manualConfirm` を要求しません。`handleEnable()` は無条件で現在の fingerprint を保存します。

また6項目チェックは、AI 無効中や sink 未設定の項目を `skip` にしたまま最後に `onAllPassed()` を呼べます。ループ検査も `detectSignal()` のエラーと、AI が実際に発声したかを確認せず、両方の peak が低ければ合格します。

根拠:

- 有効化条件 [components/AiParticipantSetupModal.tsx:412](C:/Users/seamo/Documents/gemini/Jishushitsu/components/AiParticipantSetupModal.tsx:412)
- 無条件 fingerprint 保存 [components/AiParticipantSetupModal.tsx:437](C:/Users/seamo/Documents/gemini/Jishushitsu/components/AiParticipantSetupModal.tsx:437)
- skip 処理 [components/AiPreflightPanel.tsx:143](C:/Users/seamo/Documents/gemini/Jishushitsu/components/AiPreflightPanel.tsx:143)、[components/AiPreflightPanel.tsx:184](C:/Users/seamo/Documents/gemini/Jishushitsu/components/AiPreflightPanel.tsx:184)
- エラーを無視した peak 比較 [components/AiPreflightPanel.tsx:221](C:/Users/seamo/Documents/gemini/Jishushitsu/components/AiPreflightPanel.tsx:221)
- 無条件 `onAllPassed()` [components/AiPreflightPanel.tsx:248](C:/Users/seamo/Documents/gemini/Jishushitsu/components/AiPreflightPanel.tsx:248)
- fingerprint は deviceId 2個だけ [lib/studio-participants.ts:189](C:/Users/seamo/Documents/gemini/Jishushitsu/lib/studio-participants.ts:189)

修正案:

- `validatedFingerprint` を保存できるのは「必要項目が pass」または明示的な手動確認時だけにする。
- `skip` を pass とみなさない。
- ループ試験では source 側に十分なテスト信号があったことを必須条件にし、取得エラーや無音は fail/unavailable にする。
- fingerprint に `sendLocalMic`、`monitorAiLocally`、可能なら保存ラベル／機器特性を含める。

7. [High] ChatGPT 入力ミキサーの起動失敗がトランザクショナルでなく、意図しない既定出力再生を残し得る

理由: hidden audio を `autoplay=true`、`srcObject` 設定済みで DOM に追加してから `setSinkId()` を await しています。`setSinkId()` が拒否されると `start()` は失敗しますが、その場では element/node を掃除しません。

根拠:

- [lib/ai/chatgpt-input-mixer.ts:34](C:/Users/seamo/Documents/gemini/Jishushitsu/lib/ai/chatgpt-input-mixer.ts:34)
- 特に [lib/ai/chatgpt-input-mixer.ts:56](C:/Users/seamo/Documents/gemini/Jishushitsu/lib/ai/chatgpt-input-mixer.ts:56)

修正案:

- `autoplay=false` の未接続 element を作り、`setSinkId()` 成功後にだけ `srcObject`、DOM 追加、`play()` を行う。
- `start()` 全体を try/catch し、途中失敗時は必ず `stop()` 相当のロールバックを行う。
- 非既定 output は権限が必要になる場合があるため、必要ならユーザージェスチャ内で `selectAudioOutput()` を経由する。[W3C Audio Output Devices API](https://www.w3.org/TR/audio-output/)

8. [Medium] `monitorAiLocally` をブラウザから直接検出不能という判断は正しい

理由: Web API が公開するのは、入出力デバイスの列挙、入力キャプチャ、出力先の選択です。Windows の「このデバイスを聴く」の有効状態や OS 内部オーディオグラフを取得する API はありません。[Media Capture and Streams](https://www.w3.org/TR/mediacapture-streams/)、[Audio Output Devices API](https://www.w3.org/TR/audio-output/)

マイクへの回り込みを使う推定はスピーカーでは可能ですが、ヘッドホンでは成立せず、Windows モニタとアプリ再生を区別できません。

修正案:

- 試聴案は妥当。ただし単純に「5秒再生して二重か」より、A/B方式が確実。
  1. アプリ側モニタ OFF で AI を発話させ、聞こえるか確認。
  2. アプリ側モニタ ON で再度確認。
  3. OFF でも聞こえた場合だけ `monitorAiLocally=false` とする。
- 判定結果は自動検出ではなく「利用者確認済み」と明示する。

9. [Medium] 6項目のうち、4番と6番、条件付きで5番まで自動化できる

現状の1～3番は既に自動判定ですが、1番は実際には「一覧に存在する」だけで、「開ける」は確認していません。[components/AiPreflightPanel.tsx:95](C:/Users/seamo/Documents/gemini/Jishushitsu/components/AiPreflightPanel.tsx:95)

追加で可能な自動化:

- 4「ChatGPT の声がアプリに届く」  
  `findCablePlaybackForCapture()` で対応再生側を求め、短い識別用プローブ音を `setSinkId()` で流し、source input で相関検出する。ChatGPT 操作は不要。
- 6「AI の声がChatGPTに戻っていない」  
  同じプローブを source 側へ注入し、送出先 monitor input に同じ信号が現れないことを同時測定する。
- 5「あなたの声がChatGPTに届く」  
  アプリ送出経路については、ミキサーに診断用プローブを注入し monitor input で検出できる。物理マイクそのものの確認と、`sendLocalMic=false` の外部 VoiceMeeter 経路は、無音環境では利用者の発声なしに保証できない。

修正時は単純な音量閾値ではなく、既知の周波数列やチャープとの相関を使って環境音と区別してください。

10. [Medium] 録画バックアップには終了直前の狭い損失窓が残る

理由: `discard()` は永続化キューを待つ前に `disabled=true` にします。一方、未実行の `append()` は `disabled` を見て書き込みを中止します。通常終了ではメモリ上の Blob が保存されるため問題ありませんが、最終化・ダウンロード中にブラウザが落ちた場合、最後の未書き込みチャンクが復旧バックアップに残りません。

根拠:

- 非同期 append [hooks/useLocalRecording.ts:561](C:/Users/seamo/Documents/gemini/Jishushitsu/hooks/useLocalRecording.ts:561)
- 成功扱いで discard [hooks/useLocalRecording.ts:616](C:/Users/seamo/Documents/gemini/Jishushitsu/hooks/useLocalRecording.ts:616)
- `disabled=true` が flush より先 [lib/recording-store.ts:148](C:/Users/seamo/Documents/gemini/Jishushitsu/lib/recording-store.ts:148)、[lib/recording-store.ts:185](C:/Users/seamo/Documents/gemini/Jishushitsu/lib/recording-store.ts:185)

修正案:

- `discard()` は先に `await flush()` し、その後に新規 append を閉じて削除する。
- `finalize()` でも writer の flush 完了を待ってからバックアップ破棄へ進む。
- 「停止直後にタブ終了」の実機試験で復旧可能な最終チャンクを確認する。

11. [Low] デバイス対応付けロジックが二重実装されており、プリフライトとモーダルで将来判定がずれる

理由: `findCableMonitorInput()`、ラベル正規化、仮想デバイス判定がモーダル内と `lib/audio-devices.ts` に重複しています。

根拠:

- [components/AiParticipantSetupModal.tsx:38](C:/Users/seamo/Documents/gemini/Jishushitsu/components/AiParticipantSetupModal.tsx:38)
- [lib/audio-devices.ts:9](C:/Users/seamo/Documents/gemini/Jishushitsu/lib/audio-devices.ts:9)

修正案: モーダル側のローカル実装を削除し、`lib/audio-devices.ts` のみを正本にする。VoiceMeeter、VB-CABLE A/B、権限未付与、deviceId ローテーションのテーブルテストを追加する。

総合判定: **NO-GO（P1 単独実装では不十分）**。

最低限のリリース条件は、(1)「収録開始」誤表示の修正、(2) 録画中 AI ON の封鎖、(3) versioned storage key＋型付き migration＋patch API、(4) 稼働中の真偽値反映、(5) プリフライト合格と fingerprint 保存の結合です。P2 の `monitorAiLocally` 直接検出不能という判断は承認できます。