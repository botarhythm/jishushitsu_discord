import type { Metadata } from 'next';
import Link from 'next/link';
import { Shot } from './Shot';

export const metadata: Metadata = {
  title: 'AI 参加者セットアップ手順 | デジタル原っぱ大学 自習室',
  description: 'ChatGPT を3人目の参加者として収録に加えるための、Windows 側の音声設定手順。',
};

/**
 * 講師向けのセットアップ手順ページ。
 *
 * この機能は Windows の音声デバイス設定に強く依存しており、初見では確実に詰まる
 * （実機構築で丸1日を要した）。新しい PC で構築する講師が、同じ落とし穴を
 * 踏まずに済むよう、実際に踏んだ罠を含めて手順化したもの。
 */
export default function AiParticipantHelpPage() {
  return (
    <div className="min-h-dvh bg-stone-950">
      <main className="mx-auto max-w-3xl px-5 py-10 text-stone-200">
        <header className="mb-10">
          <p className="mb-2 text-xs font-medium text-amber-500">講師向け手順書</p>
          <h1 className="text-balance text-2xl font-bold text-stone-100 sm:text-3xl">
            ChatGPT を3人目の参加者として収録に加える
          </h1>
          <p className="mt-3 text-pretty text-sm leading-relaxed text-stone-400">
            人間2名 + ChatGPT の音声で、3者のビデオポッドキャストを収録するための設定です。
            Windows の音声デバイスを何箇所か触るので、上から順に進めてください。
            所要時間は初回で 30〜45 分ほどです。
          </p>
        </header>

        <Callout tone="warn" title="先に知っておいてほしいこと">
          この設定は Windows の音声まわりを変更します。途中で「普段の音が聞こえない」
          「マイクが使えない」という状態になることがありますが、
          各ステップの確認ポイントを飛ばさなければ元に戻せます。
          <strong className="text-stone-200">
            うまくいかないときは、次のステップへ進まずにその場で止まってください。
          </strong>
        </Callout>

        <Section n={0} title="用意するもの">
          <ul className="space-y-2 text-sm text-stone-300">
            <Item>
              <strong>ChatGPT デスクトップアプリ</strong> — 音声モードが使えるプラン
            </Item>
            <Item>
              <strong>VB-CABLE</strong>（無料）—{' '}
              <ExtLink href="https://vb-audio.com/Cable/">vb-audio.com/Cable</ExtLink>
            </Item>
            <Item>
              <strong>VoiceMeeter</strong>（無料）—{' '}
              <ExtLink href="https://vb-audio.com/Voicemeeter/">vb-audio.com/Voicemeeter</ExtLink>
            </Item>
            <Item>
              <strong>ヘッドホン（必須）</strong> —
              スピーカーだと AI の声をマイクが拾い、ハウリングします
            </Item>
          </ul>
          <p className="mt-4 text-pretty text-sm leading-relaxed text-stone-400">
            どちらも寄付ウェアです。インストール後は
            <strong className="text-stone-200">PC の再起動が必要</strong>です
            （オーディオドライバのため）。
          </p>
        </Section>

        <Section n={1} title="音の流れを理解する">
          <p className="mb-5 text-pretty text-sm leading-relaxed text-stone-400">
            設定の意味が分かっていると詰まったときに自力で直せます。
            やっていることは「2本の仮想的な管をつなぐ」だけです。
          </p>
          <RoutingDiagram />
          <ul className="mt-5 space-y-2 text-sm text-stone-300">
            <Item>
              <strong>ChatGPT の声</strong>は CABLE を通って自習室アプリに入り、
              録画・配信・あなたのヘッドホンへ流れます
            </Item>
            <Item>
              <strong>あなたと相手の声</strong>は VoiceMeeter の B1 に集まり、
              ChatGPT の「耳」になります
            </Item>
          </ul>
        </Section>

        <Section n={2} title="ChatGPT 単体で音声会話できることを確認する">
          <p className="mb-4 text-pretty text-sm leading-relaxed text-stone-400">
            仮想デバイスを触る前に、ここを必ず確認します。これを飛ばすと、
            後で問題が起きたときに「アプリのせい」か「ChatGPT のせい」か切り分けられなくなります。
          </p>
          <Steps
            items={[
              'ChatGPT デスクトップを起動し、音声モードを開く',
              'マイクボタンのミュートを解除する（斜線が消える）',
              '話しかけて、返答があることを確認する',
            ]}
          />
          <Check>会話が成立したら次へ。しなければ、まずそこを解決してください。</Check>
          <Callout tone="note" title="反応しないとき">
            設定 → システム → サウンド → 音量ミキサーの最下部にある
            <strong className="text-stone-200">「リセット」</strong>
            を押すと直ることがあります。アプリ別の音声設定が壊れている場合の復旧手段です。
          </Callout>
        </Section>

        <Section n={3} title="使わないデバイスを無効化する">
          <Callout tone="warn" title="ここを飛ばすと必ず詰まります">
            VB-CABLE と VoiceMeeter を入れると、名前がよく似たデバイスが十数個増えます。
            ChatGPT がそのうちの間違ったものを掴む事故が繰り返し起きました。
            <strong className="text-stone-200">選択肢を消すのが唯一の確実な対策です。</strong>
          </Callout>
          <p className="mb-3 text-sm text-stone-400">
            <Kbd>Win</Kbd> + <Kbd>R</Kbd> →{' '}
            <code className="rounded bg-stone-800 px-1.5 py-0.5 text-xs">mmsys.cpl</code>{' '}
            を実行し、各デバイスを右クリック →「無効」。
          </p>
          <DeviceTable
            caption="録音タブ"
            rows={[
              ['マイク配列（物理マイク）', 'keep'],
              ['CABLE Output', 'keep'],
              ['Voicemeeter Out B1', 'keep'],
              ['Stereo Mix', 'disable'],
              ['Voicemeeter Out A1〜A5', 'disable'],
              ['Voicemeeter Out B2 / B3', 'disable'],
            ]}
          />
          <DeviceTable
            caption="再生タブ"
            rows={[
              ['ヘッドホン', 'keep'],
              ['CABLE Input', 'keep'],
              ['Voicemeeter Input', 'keep'],
              ['CABLE In 16ch', 'disable'],
              ['Voicemeeter In 3〜5 / AUX / VAIO3', 'disable'],
            ]}
          />
          <Shot src="/help/ai-participant/devices.png" caption="無効化が済んだ録音タブ" />
          <Check>
            録音タブに残るのが3つ、再生タブに残るのが3つになっていれば成功です。
          </Check>
        </Section>

        <Section n={4} title="Windows のデバイス役割を決める">
          <p className="mb-4 text-pretty text-sm leading-relaxed text-stone-400">
            Windows の録音デバイスには
            <strong className="text-stone-200">「既定」と「既定の通信」の2つの枠</strong>
            があります。ChatGPT は通信デバイスの枠を見るので、ここを使い分けます。
          </p>
          <RoleTable />
          <p className="mt-4 text-sm text-stone-400">
            設定方法: デバイスを選び、
            <strong className="text-stone-200">「既定値に設定」ボタンの右の ▼</strong>
            から役割を選びます。
          </p>
          <Check>
            <code className="rounded bg-stone-800 px-1.5 py-0.5 text-xs">Voicemeeter Out B1</code>{' '}
            に受話器アイコンが付けば成功です。
          </Check>
        </Section>

        <Section n={5} title="VoiceMeeter を配線する">
          <Steps
            items={[
              '左端の Hardware Input 1 に「マイク配列」を割り当てる',
              'そのストリップの B だけを点灯させる（A は消灯）',
              '右側の Virtual Input も B だけを点灯させる（A は消灯）',
              'メニューで System Tray と Run on Windows Startup を有効にする',
            ]}
          />
          <Callout tone="warn" title="A を点灯させない">
            A を点灯させると、あなたと相手の声がスピーカーから流れます。
            その音をマイクが拾って ChatGPT へ戻り、ハウリングします。
          </Callout>
          <Shot src="/help/ai-participant/voicemeeter.png" caption="正しい状態の VoiceMeeter" />
          <Check>
            話すと右側の「B VIRTUAL OUT」メーターが振れれば成功です。
          </Check>
        </Section>

        <Section n={6} title="ChatGPT の声の出口を決める">
          <p className="mb-4 text-pretty text-sm leading-relaxed text-stone-400">
            ChatGPT は<strong className="text-stone-200">出力だけは通信デバイスを見ません</strong>。
            ここだけアプリ別の設定が必要です。
          </p>
          <Steps
            items={[
              'ChatGPT に何か喋らせる（音を鳴らさないと一覧に出てきません）',
              '設定 → システム → サウンド → 音量ミキサー を開く',
              'ChatGPT の行を展開し、出力デバイスを「CABLE Input」にする',
            ]}
          />
          <Callout tone="note" title="行が複数あるとき">
            音量ミキサーはアプリ単位ではなく音声セッション単位の一覧です。ChatGPT が
            複数行に分かれることがあるので、
            <strong className="text-stone-200">すべての行に同じ設定</strong>を入れてください。
            似た名前の <code className="rounded bg-stone-800 px-1 text-xs">CABLE In 16ch</code>{' '}
            は別物なので選ばないこと。
          </Callout>
          <Check>
            設定すると ChatGPT の声がヘッドホンから消えます。それが正常です
            （次の手順で聞こえるようになります）。
          </Check>
        </Section>

        <Section n={7} title="ChatGPT の声を常に聞こえるようにする">
          <p className="mb-4 text-pretty text-sm leading-relaxed text-stone-400">
            このままだと収録していないとき ChatGPT の声が聞こえません。
            Windows に常時モニタさせて、普段どおり単体でも使えるようにします。
          </p>
          <Steps
            items={[
              'mmsys.cpl → 録音タブ → CABLE Output → プロパティ',
              '「聴く」タブを開く',
              '「このデバイスを聴く」にチェックし、再生先にヘッドホンを選ぶ',
            ]}
          />
          <Check>
            ChatGPT の声がヘッドホンから聞こえるようになれば成功です。
            収録していなくても ChatGPT を普段どおり使えます。
          </Check>
        </Section>

        <Section n={8} title="自習室アプリ側を設定する">
          <p className="mb-4 text-pretty text-sm leading-relaxed text-stone-400">
            収録モードに入り、コントロールバーの{' '}
            <span className="rounded bg-stone-800 px-1.5 py-0.5">🔧</span>{' '}
            （AI 参加者の設定）を開きます。
          </p>
          <AppSettingsTable />
          <p className="mt-4 text-sm text-stone-400">
            さらに、下にある2つのチェックボックスを
            <strong className="text-stone-200">両方オン</strong>にしてください。
            手順5・7で VoiceMeeter と Windows に任せた分を、アプリ側で二重に鳴らさないための設定です。
          </p>
          <Shot src="/help/ai-participant/app-settings.png" caption="設定が済んだ状態" />
        </Section>

        <Section n={9} title="動作を確認する">
          <p className="mb-4 text-pretty text-sm leading-relaxed text-stone-400">
            設定画面の<strong className="text-stone-200">「すべて確認」</strong>
            を押すと、6項目を順に検査して、崩れている箇所と対処法を表示します。
            収録を始める前に毎回押す運用をおすすめします。
          </p>
          <Steps
            items={[
              'コントロールバーの 🤖 を押して AI 参加者を ON にする',
              'ステージ下部にエネルギー球が現れることを確認',
              'ChatGPT に話しかけ、返答で球が揺らぐことを確認',
              '🎥 で録画し、保存された動画に両方の声が入っていることを確認',
            ]}
          />
          <Check>ここまで通れば収録可能です。</Check>
        </Section>

        <Section n={10} title="うまくいかないときは">
          <dl className="space-y-5">
            <Trouble q="ChatGPT がこちらの声に反応しない">
              マイクボタンにカーソルを合わせると、ChatGPT が実際に使っているデバイス名が出ます。
              <code className="mx-1 rounded bg-stone-800 px-1.5 py-0.5 text-xs">
                Voicemeeter Out B1
              </code>
              以外なら、手順4をやり直してから ChatGPT を再起動してください。
            </Trouble>
            <Trouble q="ハウリングする">
              スピーカーを使っていないか、VoiceMeeter で A が点灯していないかを確認してください。
              通話マイクに「ステレオ ミキサー」を選んでいる場合も起きます。
            </Trouble>
            <Trouble q="自分の声が ChatGPT に二重に届く">
              手順8のチェックボックスが入っていません。VoiceMeeter とアプリの両方から
              送っている状態です。
            </Trouble>
            <Trouble q="PC の音が急に聞こえなくなった">
              VoiceMeeter がインストール時に既定の再生デバイスを奪っています。
              設定 → システム → サウンド → 出力 でヘッドホンを選び直してください。
            </Trouble>
            <Trouble q="設定が壊れて何をしても直らない">
              音量ミキサー最下部の「リセット」でアプリ別設定を全消去してから、
              手順6をやり直すのが確実です。
            </Trouble>
          </dl>
        </Section>

        <footer className="mt-12 border-t border-stone-800 pt-6">
          <Link
            href="/room"
            className="text-sm font-medium text-amber-500 underline-offset-4 hover:underline"
          >
            自習室に戻る
          </Link>
          <p className="mt-3 text-xs leading-relaxed text-stone-400">
            この手順は実機構築で実際に踏んだ落とし穴を反映しています。
            新しい詰まりどころを見つけたら、リポジトリの{' '}
            <code className="rounded bg-stone-800 px-1 py-0.5">docs/ai-participant-setup.md</code>{' '}
            に追記してください。
          </p>
        </footer>
      </main>
    </div>
  );
}

/* ── 部品 ─────────────────────────────────────────── */

function Section({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section className="mb-12">
      <h2 className="mb-4 flex items-baseline gap-3 text-balance text-lg font-semibold text-stone-100">
        <span className="tabular-nums text-sm font-bold text-amber-500">{n}</span>
        {title}
      </h2>
      {children}
    </section>
  );
}

function Item({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex gap-2 text-pretty leading-relaxed">
      <span aria-hidden className="mt-2 size-1 shrink-0 rounded-full bg-stone-600" />
      <span>{children}</span>
    </li>
  );
}

function Steps({ items }: { items: string[] }) {
  return (
    <ol className="space-y-2.5">
      {items.map((s, i) => (
        <li key={s} className="flex gap-3 text-sm leading-relaxed text-stone-300">
          <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-stone-800 text-xs tabular-nums text-stone-400">
            {i + 1}
          </span>
          <span className="text-pretty">{s}</span>
        </li>
      ))}
    </ol>
  );
}

function Check({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-4 rounded-lg border border-green-800/60 bg-green-950/30 px-4 py-3 text-pretty text-sm leading-relaxed text-green-200">
      <span className="font-medium">確認 — </span>
      {children}
    </p>
  );
}

function Callout({
  tone,
  title,
  children,
}: {
  tone: 'warn' | 'note';
  title: string;
  children: React.ReactNode;
}) {
  const styles =
    tone === 'warn'
      ? 'border-amber-900/60 bg-amber-950/30 text-amber-100'
      : 'border-stone-700 bg-stone-900 text-stone-300';
  return (
    <aside className={`mb-6 rounded-lg border px-4 py-3 ${styles}`}>
      <p className="mb-1 text-sm font-semibold">{title}</p>
      <p className="text-pretty text-sm leading-relaxed">{children}</p>
    </aside>
  );
}

function Trouble({ q, children }: { q: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-sm font-semibold text-stone-100">{q}</dt>
      <dd className="mt-1 text-pretty text-sm leading-relaxed text-stone-400">{children}</dd>
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border border-stone-600 bg-stone-800 px-1.5 py-0.5 text-xs text-stone-300">
      {children}
    </kbd>
  );
}

function ExtLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-amber-500 underline-offset-4 hover:underline"
    >
      {children}
    </a>
  );
}

function DeviceTable({ caption, rows }: { caption: string; rows: [string, 'keep' | 'disable'][] }) {
  return (
    <div className="mb-5 overflow-x-auto">
      <table className="w-full text-left text-sm">
        <caption className="mb-2 text-left text-xs font-medium text-stone-400">{caption}</caption>
        <tbody className="divide-y divide-stone-800">
          {rows.map(([name, action]) => (
            <tr key={name}>
              <td className="py-2 pr-4 text-stone-300">{name}</td>
              <td className="w-24 py-2">
                <span
                  className={
                    action === 'keep'
                      ? 'text-xs font-medium text-green-400'
                      : 'text-xs font-medium text-stone-400'
                  }
                >
                  {action === 'keep' ? '残す' : '無効にする'}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RoleTable() {
  const rows: [string, string, string][] = [
    ['録音', '既定のデバイス', 'マイク配列（物理マイク）'],
    ['録音', '既定の通信デバイス', 'Voicemeeter Out B1'],
    ['再生', '既定のデバイス', 'ヘッドホン'],
  ];
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-stone-800 text-xs text-stone-400">
            <th className="w-16 py-2 font-medium">タブ</th>
            <th className="py-2 font-medium">枠</th>
            <th className="py-2 font-medium">設定するデバイス</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-stone-800">
          {rows.map(([tab, role, device]) => (
            <tr key={`${tab}-${role}`}>
              <td className="py-2 text-stone-400">{tab}</td>
              <td className="py-2 text-stone-400">{role}</td>
              <td className="py-2 font-medium text-stone-200">{device}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AppSettingsTable() {
  const rows: [string, string][] = [
    ['① AI 音声ソース', 'CABLE Output'],
    ['通話マイク', 'マイク配列（「既定 -」が付かない方）'],
    ['② ChatGPT への送出先', 'Voicemeeter Input'],
  ];
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <tbody className="divide-y divide-stone-800">
          {rows.map(([label, value]) => (
            <tr key={label}>
              <td className="py-2 pr-4 text-stone-400">{label}</td>
              <td className="py-2 font-medium text-stone-200">{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 音の流れ図。設定の意味を掴んでもらうための概念図 */
function RoutingDiagram() {
  return (
    <figure className="overflow-x-auto rounded-lg border border-stone-800 bg-stone-900 p-4">
      <svg viewBox="0 0 640 260" className="w-full min-w-[520px]" role="img" aria-label="音声の流れ図">
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#8f9382" />
          </marker>
        </defs>

        {/* ChatGPT の声 */}
        <text x="8" y="20" className="fill-stone-400 text-[11px]">ChatGPT の声</text>
        <Box x={8} y={30} w={120} label="ChatGPT" sub="出力" />
        <Arrow x1={128} y1={52} x2={196} y2={52} />
        <Box x={196} y={30} w={130} label="CABLE" sub="Input → Output" accent />
        <Arrow x1={326} y1={52} x2={394} y2={52} />
        <Box x={394} y={30} w={140} label="自習室アプリ" sub="AI 音声ソース" />

        <Arrow x1={464} y1={74} x2={464} y2={112} />
        <text x="474" y="100" className="fill-stone-400 text-[10px]">録画・配信・モニタ</text>

        {/* 人間の声 */}
        <text x="8" y="122" className="fill-stone-400 text-[11px]">あなたと相手の声</text>
        <Box x={8} y={180} w={120} label="あなた" sub="物理マイク" />
        <Box x={8} y={130} w={120} label="相手" sub="LiveKit 経由" />
        <Arrow x1={128} y1={202} x2={196} y2={202} />
        <Arrow x1={128} y1={152} x2={196} y2={196} />
        <Box x={196} y={180} w={130} label="VoiceMeeter" sub="B1 バス" accent />
        <Arrow x1={326} y1={202} x2={394} y2={202} />
        <Box x={394} y={180} w={140} label="ChatGPT" sub="入力（耳）" />
      </svg>
    </figure>
  );
}

function Box({
  x,
  y,
  w,
  label,
  sub,
  accent = false,
}: {
  x: number;
  y: number;
  w: number;
  label: string;
  sub: string;
  accent?: boolean;
}) {
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={w}
        height={44}
        rx={6}
        className={accent ? 'fill-stone-800 stroke-amber-700' : 'fill-stone-800 stroke-stone-700'}
      />
      <text x={x + w / 2} y={y + 19} textAnchor="middle" className="fill-stone-200 text-[12px] font-medium">
        {label}
      </text>
      <text x={x + w / 2} y={y + 34} textAnchor="middle" className="fill-stone-400 text-[10px]">
        {sub}
      </text>
    </g>
  );
}

function Arrow({ x1, y1, x2, y2 }: { x1: number; y1: number; x2: number; y2: number }) {
  return <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="#8f9382" strokeWidth={1.5} markerEnd="url(#arrow)" />;
}
