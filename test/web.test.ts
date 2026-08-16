import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
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
        // the wilderness: C and Rust guests answer from inside the tab
        await page.selectOption('#example', 'interop');
        await page.click('#run');
        await page.waitForFunction(
          "document.getElementById('out').textContent.includes('crc32 by C:    cf894783')",
          undefined,
          { timeout: 60000 },
        );
        // and the set appears on the canvas
        await page.selectOption('#example', 'mandelbrot');
        await page.click('#run');
        await page.waitForFunction(
          "!document.getElementById('canvas').hidden",
          undefined,
          { timeout: 120000 },
        );
        const pixels = await page.evaluate(`(() => {
          const ctx = document.getElementById('canvas').getContext('2d');
          const c = ctx.getImageData(128, 128, 1, 1).data;
          const e = ctx.getImageData(0, 0, 1, 1).data;
          return [c[0], c[1], c[2], e[0]];
        })()`);
        expect(pixels.slice(0, 3)).toEqual([0, 0, 0]); // the center is in the set
        expect(pixels[3]).toBeGreaterThan(0); // the corner escapes
        // mandelzoom: a canvas still, plus the offer to become a film
        await page.selectOption('#example', 'mandelzoom');
        await page.click('#run');
        await page.waitForFunction("!document.getElementById('canvas').hidden", undefined, {
          timeout: 120000,
        });
        await page.waitForFunction("!document.getElementById('transcode').hidden", undefined, {
          timeout: 10000,
        });
        // the resident language model speaks, entirely inside the tab
        if (existsSync('examples/oyster.npt')) {
          await page.selectOption('#example', 'gpt');
          await page.fill('#prompt', 'The pearl');
          await page.click('#run');
          await page.waitForFunction(
            "document.getElementById('out').textContent.startsWith('The pearl') && document.getElementById('out').textContent.length > 40",
            undefined,
            { timeout: 120000 },
          );
        }
      } finally {
        await browser.close();
      }
    },
    240000,
  );
});
