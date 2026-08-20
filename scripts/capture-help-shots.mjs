/**
 * 手順書用スクリーンショットの自動撮影。
 *
 * 使い方（dev サーバーを 3100 で起動した状態で）:
 *   node scripts/capture-help-shots.mjs
 *
 * アプリ側の UI を変えたらこれを流し直せば、手順書の挿絵が実物と揃う。
 * 撮影対象は開発時のみ有効なプレビュー (/dev-preview/ai-modal)。
 * 実機の音声デバイスに依存しないよう、そちらでデバイス一覧をスタブしてある。
 */

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.PREVIEW_BASE ?? 'http://localhost:3100';
const OUT = join(process.cwd(), 'public', 'help', 'ai-participant');

/** モーダル内のスクロール領域を、指定セクションの見出しが上に来る位置まで送る */
async function scrollToSection(page, title) {
  await page.evaluate((t) => {
    const panel = document.querySelector('h2')?.closest('div.flex.flex-col');
    const scroller = panel?.querySelector(':scope > div.overflow-y-auto');
    const heading = [...(panel?.querySelectorAll('h3') ?? [])].find((h) =>
      h.textContent?.includes(t)
    );
    if (!scroller || !heading) return;
    scroller.scrollTop += heading.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 8;
  }, title);
  await page.waitForTimeout(250);
}

const main = async () => {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage({ viewport: { width: 640, height: 980 } });

  await page.goto(`${BASE}/dev-preview/ai-modal`, { waitUntil: 'networkidle' });
  const panel = page.locator('h2').locator('xpath=ancestor::div[contains(@class,"flex-col")][1]');
  await panel.waitFor();

  const shots = [
    { name: 'app-settings.png', section: 'デバイスを選ぶ' },
    { name: 'preflight.png', section: '動作を確認する' },
  ];
  for (const { name, section } of shots) {
    await scrollToSection(page, section);
    await panel.screenshot({ path: join(OUT, name) });
    console.log('saved', name);
  }

  await browser.close();
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
