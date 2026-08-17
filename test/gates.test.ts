import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile, loadSource } from '../src/bootstrap.js';

function probe(bins: string[], flag: string): string | null {
  for (const bin of bins) {
    try {
      execFileSync(bin, [flag], { stdio: 'pipe' });
      return bin;
    } catch {
      /* keep looking */
    }
  }
  return null;
}
const runtime = probe(['wasmtime', join(process.env.HOME ?? '', '.local/bin/wasmtime')], '--version');
const CORE = 'node_modules/@ffmpeg/core/dist/ffmpeg-core.wasm';
const GLUE = 'node_modules/@ffmpeg/core/dist/ffmpeg-core.js';
const core = existsSync(CORE) && existsSync(GLUE);

describe('the gates opened for JavaScript, served without it', () => {
  it.skipIf(!core)('the ledger reads every gate of a closure-minified build', () => {
    const out = execFileSync('node', ['tools/emscripten-gates/read-gates.mjs', CORE, GLUE], {
      maxBuffer: 1 << 24,
    }).toString();
    expect(out).toContain('gates of ffmpeg-core.wasm');
    // every function gate resolves; only the memory import is unmapped
    expect(out).toMatch(/## unresolved — 1 gates[\s\S]*?a\.a memory/);
  });

  it.skipIf(!core || !runtime)(
    'ffmpeg-core boots -version under the thin host with zero glue JS',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'gates-'));
      execFileSync('node', ['tools/emscripten-gates/make-shim.mjs', CORE, GLUE, dir], { stdio: 'pipe' });
      // the shim is Hot Glue WAT — assembled by as.hma, like everything
      const asWat = join(dir, 'as.wat');
      writeFileSync(asWat, compile(loadSource(['src/as.hma'])));
      const shim = execFileSync(runtime!, ['run', '--invoke', 'run', asWat], {
        input: readFileSync(join(dir, 'shim.wat')),
        maxBuffer: 1 << 26,
      });
      writeFileSync(join(dir, 'shim.wasm'), shim);
      const out = execFileSync(
        'node',
        ['tools/emscripten-gates/thin-host.mjs', CORE, dir, '--', '-version'],
        { maxBuffer: 1 << 24, timeout: 120000 },
      ).toString();
      expect(out).toContain('ffmpeg version');
      expect(out).toContain('libavcodec');
    },
    300000,
  );
});
