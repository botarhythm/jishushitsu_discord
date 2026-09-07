import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

// node node_modules/next/dist/bin/next dev --port 3107 を先に起動。外部サービス・実音声は使わない。
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  await page.goto('http://localhost:3107/dev-preview/spotlight');
  const main = page.getByTestId('spotlight-main');
  const strip = page.getByTestId('spotlight-strip');
  await strip.waitFor();
  assert.equal(await strip.getByRole('button').count(), 4);
  await strip.getByRole('button', { name: 'ゲストをスポットライトに固定', exact: true }).click();
  assert.match(await main.innerText(), /ゲスト/);
  await strip.getByRole('button', { name: 'ChatGPTをスポットライトに固定', exact: true }).click();
  assert.match(await main.innerText(), /ChatGPT/);
  await page.getByRole('button', { name: '受信側切替', exact: true }).click();
  assert.equal(await strip.getByRole('button').count(), 0);
  assert.match(await main.innerText(), /ChatGPT/);
  await page.getByRole('button', { name: '受信側切替', exact: true }).click();
  await strip.getByRole('button', { name: 'ゲストをスポットライトに固定', exact: true }).click();
  await page.getByRole('button', { name: 'ゲスト退出', exact: true }).click();
  await main.getByRole('status').waitFor();
  assert.match(await main.innerText(), /参加を待っています/);
  assert.equal(await strip.getByRole('button').count(), 3);
  await strip.getByRole('button', { name: 'ホストをスポットライトに固定', exact: true }).click();
  await page.getByRole('combobox', { name: 'レイアウト', exact: true }).selectOption('spotlight');
  assert.equal(await strip.count(), 0);
  assert.match(await main.innerText(), /ホスト/);
  await page.getByRole('button', { name: 'スポットライト解除', exact: true }).click();
  assert.equal(await page.getByRole('combobox', { name: 'レイアウト', exact: true }).inputValue(), 'split');
  await page.getByRole('combobox', { name: 'レイアウト', exact: true }).selectOption('spotlight-strip');
  await mkdir('output/playwright', { recursive: true });
  await page.mouse.move(700, 300);
  await page.getByRole('combobox', { name: 'レイアウト', exact: true }).evaluate((el) => el.blur());
  await page.waitForTimeout(3200);
  await page.screenshot({ path: 'output/playwright/spotlight-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  const boxes = await strip.locator(':scope > div').evaluateAll((els) => els.map((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, width: r.width };
  }));
  assert(boxes.every((r) => r.left >= 0 && r.right <= 390 && r.width > 0));
  await page.screenshot({ path: 'output/playwright/spotlight-mobile.png' });
  assert.deepEqual(errors, []);
  console.log('PASS: human/AI spotlight, viewer controls, departure, release, strip bounds, no runtime errors');
} finally {
  await browser.close();
}
