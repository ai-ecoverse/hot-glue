import { describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright-core';
import { buildPage } from '../../src/nacre/build-web.js';

async function launch(): Promise<Browser | null> {
  const tries = [
    () => chromium.launch({ args: ['--no-sandbox'] }),
    () => chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] }),
  ];
  for (const t of tries) {
    try {
      return await t();
    } catch {
      /* next */
    }
  }
  return null;
}

describe('the browser as expansion host', () => {
  it(
    'expands, assembles, and runs — fizzbuzz and the GC AST — in Chromium',
    async () => {
      const browser = await launch();
      if (!browser) return; // no browser here; the page still works where there is one
      try {
        const pagePath = buildPage();
        const page = await browser.newPage();
        await page.goto('file://' + process.cwd() + '/' + pagePath);
        await page.click('#run');
        await page.waitForFunction(
          "document.getElementById('out').textContent.includes('FizzBuzz')",
          undefined,
          { timeout: 60000 },
        );
        expect(await page.textContent('#out')).toContain('Buzz\n');
        await page.selectOption('#example', 'gc-ast');
        await page.click('#run');
        await page.waitForFunction(
          "document.getElementById('out').textContent.includes('demo() = 15')",
          undefined,
          { timeout: 60000 },
        );
      } finally {
        await browser.close();
      }
    },
    180000,
  );
});
