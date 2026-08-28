import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile, loadSource } from '../src/bootstrap.js';

function found(bin: string, args: string[] = ['--version']): string | null {
  for (const p of [bin, join(process.env.HOME ?? '', '.local/bin', bin), join('/opt/homebrew/bin', bin)]) {
    try {
      execFileSync(p, args, { stdio: 'pipe' });
      return p;
    } catch {
      /* keep looking */
    }
  }
  return null;
}
const wasmtime = found('wasmtime');
const zig = found('zig', ['version']);
const wasmMerge = found('wasm-merge');

const dir = mkdtempSync(join(tmpdir(), 'hotglue-braid-'));

const assemble = (hma: string, out: string) => {
  const wat = join(dir, out + '.wat');
  writeFileSync(wat, compile(loadSource([hma])));
  const wasm = join(dir, out + '.wasm');
  writeFileSync(
    wasm,
    execFileSync(wasmtime!, ['run', '--invoke', 'run', join(dir, 'as.wat')], {
      input: compile(loadSource([hma])),
      maxBuffer: 1 << 26,
    }),
  );
  return wasm;
};

const zigBand = (src: string, base: number, out: string, exports: string[]) => {
  const wasm = join(dir, out);
  execFileSync(zig!, [
    'build-exe', join(process.cwd(), src), '-target', 'wasm32-freestanding', '-O', 'ReleaseSmall', '-fno-entry',
    '--import-memory', '--initial-memory=2097152', `--global-base=${base}`, '--stack', '8192',
    ...exports.map((e) => `--export=${e}`), `-femit-bin=${wasm}`,
  ], { cwd: dir });
  return wasm;
};

describe.skipIf(!wasmtime || !zig || !wasmMerge)('the braid — Zig bands in one Hot Glue memory', () => {
  let braid: string;

  beforeAll(() => {
    writeFileSync(join(dir, 'as.wat'), compile(loadSource(['src/as.hma'])));
    const sup = assemble('examples/braid.hma', 'sup');
    const seam = assemble('examples/stamp-seam.hma', 'seam');
    const fnv = zigBand('examples/native/fnv.zig', 1048576, 'fnv.wasm', ['fnv1a', 'motto_ptr', 'motto_len']);
    const mix = zigBand('examples/native/mix.zig', 1179648, 'mix.wasm', ['stamp']);
    braid = join(dir, 'braid.wasm');
    execFileSync(wasmMerge!, [sup, 'env', fnv, 'fnv', mix, 'mix', seam, 'seam', '-o', braid]);
  });

  it('fuses to one module with one memory and agrees with itself', () => {
    const out = execFileSync(wasmtime!, [braid], { stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
    // fnv verified against an independent implementation; "agree" is the
    // shared memory read from both sides of the dissolved boundary
    expect(out).toBe('{"motto":"the pearl remembers","fnv":1809698868,"agree":true,"stamp":-1056193573}');
  });

  it('a write across a band border dies at the canary, loudly', () => {
    const crash = join(dir, 'crash.hma');
    writeFileSync(
      crash,
      `(use clj.hma)\n(use glue-alloc.hma)\n(use canary.hma)\n(module\n  (memory 2)\n` +
        `  (take-guarded $b 60)\n` +
        `  (func (export "_start")\n    (canaries-arm)\n` +
        `    ;; one store past the band's brim lands on the sentinel\n` +
        `    (i32.store (i32.add ($b) (i32.const 60)) (i32.const 7))\n` +
        `    (canaries-check)))\n`,
    );
    const wat = join(dir, 'crash.wat');
    writeFileSync(wat, compile(loadSource([crash])));
    let code = 0;
    let err = '';
    try {
      execFileSync(wasmtime!, [wat], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e: any) {
      code = e.status;
      err = e.stderr.toString();
    }
    expect(code).not.toBe(0);
    expect(err).toContain('unreachable');
  });

  it('take packs bands and take-from moves the floor', () => {
    const probe = join(dir, 'probe.hma');
    writeFileSync(
      probe,
      `(use glue-alloc.hma)\n(take-from 131072)\n(take a 100)\n(take b 4)\n(module (memory 3)\n` +
        `  (func (export "a") (result i32) (a))\n  (func (export "b") (result i32) (b))\n` +
        `  (func (export "top") (result i32) (taken)))\n`,
    );
    const wat = compile(loadSource([probe]));
    expect(wat).toContain('(i32.const 131072)');
    expect(wat).toContain('(i32.const 131172)');
    expect(wat).toContain('(i32.const 131176)');
  });
});

const dist = ['dist/hotglue/hotglue.wasm', 'dist/hotglue/expand.wasm', 'dist/hotglue/as.wasm'];

describe.skipIf(!wasmtime || !zig || !wasmMerge || !dist.every((p) => existsSync(p)))(
  'the braid, compiled by the wasm compiler',
  () => {
    it('tells the same story with no TypeScript in the room', () => {
      const sup = join(dir, 'sup-native.wasm');
      writeFileSync(
        sup,
        execFileSync(
          wasmtime!,
          [
            '--dir', 'src', '--dir', 'examples', '--dir', '.',
            '--preload', 'expand=dist/hotglue/expand.wasm',
            '--preload', 'as=dist/hotglue/as.wasm',
            'dist/hotglue/hotglue.wasm', 'examples/braid.hma',
          ],
          { maxBuffer: 1 << 26 },
        ),
      );
      const braid2 = join(dir, 'braid-native.wasm');
      execFileSync(wasmMerge!, [
        sup, 'env',
        join(dir, 'fnv.wasm'), 'fnv',
        join(dir, 'mix.wasm'), 'mix',
        join(dir, 'seam.wasm'), 'seam',
        '-o', braid2,
      ]);
      const out = execFileSync(wasmtime!, [braid2], { stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
      expect(out).toBe('{"motto":"the pearl remembers","fnv":1809698868,"agree":true,"stamp":-1056193573}');
    });
  },
);
