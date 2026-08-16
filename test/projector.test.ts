import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile, read, Sym } from '../../src/hotglue/bootstrap.js';

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
const chromium = existsSync('/opt/pw-browsers/chromium');

const dir = mkdtempSync(join(tmpdir(), 'hotglue-hotglue-'));

describe('hot melt adhesive', () => {
  it('reads .hma with the house reader', () => {
    const forms = read(readFileSync('examples/film.hma', 'utf8'));
    const film = forms.find((f) => Array.isArray(f) && f[0] instanceof Sym && f[0].name === 'film') as unknown[];
    expect(film).toBeDefined();
    expect((film[1] as Sym).name).toBe('gpu-perlmutt.mp4');
    const steps = (film.slice(2) as unknown[][]).map((s) => (s[0] as Sym).name);
    expect(steps).toContain('let');
    expect(steps).toContain('cut');
  });

  it('the film is self-contained: every wasm verb declares its sources', () => {
    const forms = read(readFileSync('examples/film.hma', 'utf8'));
    const film = forms.find((f) => Array.isArray(f) && f[0] instanceof Sym && f[0].name === 'film') as unknown[][];
    const body = film.slice(2) as Sym[][];
    const declared = new Set(
      body.filter((s) => s[0].name === 'filter').map((s) => s[1].name),
    );
    // the macro layer is imported by listing it, visibly, before the program
    for (const s of body.filter((s) => s[0].name === 'filter')) {
      const sources = s.slice(2).map((x) => x.name);
      expect(sources.length).toBeGreaterThan(0);
      for (const f of sources) expect(existsSync(f)).toBe(true);
    }
    expect(declared).toContain('wav');
    expect(declared).toContain('rgb->y4m');
    // and every verb a (let …) invokes is either declared here or a native sandbox
    const native = new Set(['perl', 'speak', 'gpu']);
    for (const s of body.filter((s) => s[0].name === 'let')) {
      const verb = (s[2] as unknown as Sym[])[0].name;
      expect(declared.has(verb) || native.has(verb)).toBe(true);
    }
  });

  it('perl writes the narration inside wasm', async () => {
    const { ZeroPerl } = await import('@6over3/zeroperl-ts');
    let out = '';
    const perl = await ZeroPerl.create({ stdout: (s: string) => (out += s) });
    await perl.eval(readFileSync('examples/narration.pl', 'utf8'));
    perl.flush();
    expect(out).toContain('WebGPU');
    expect(out).toContain('Perl wrote this sentence');
    expect(out).toMatch(/\d+ thousand/); // Perl did arithmetic, as Perl does
  }, 120000);

  it.skipIf(!chromium || !runtime)(
    'webgpu renders a frame the Lisp can glue',
    () => {
      const rgb = join(dir, 'frame.rgb');
      execFileSync('node', ['scripts/gpu-render.mjs'], {
        env: { ...process.env, SHADER: 'examples/mandel.wgsl', FRAMES: '1', OUT: rgb },
        stdio: 'pipe',
        timeout: 300000,
      });
      const f = readFileSync(rgb);
      expect(f.length).toBe(256 * 256 * 3);
      const px = (x: number, y: number) => f.subarray((y * 256 + x) * 3, (y * 256 + x) * 3 + 3);
      expect([...px(128, 128)]).toEqual([0, 0, 0]); // frame 0 centers the full view: in the set
      expect(px(0, 0)[0]).toBeGreaterThan(0); // the corner escapes
      // and the Lisp turns it into a stream ffmpeg drinks
      const wat = join(dir, 'rgb2y4m.wat');
      writeFileSync(
        wat,
        compile(['src/hotglue/clj.hma', 'examples/rgb2y4m.hma'].map((x) => readFileSync(x, 'utf8')).join('\n')),
      );
      const y4m = execFileSync(runtime!, [wat], { input: f, maxBuffer: 1 << 26 });
      expect(y4m.subarray(0, 9).toString()).toBe('YUV4MPEG2');
      expect(y4m.length).toBe(39 + 6 + 3 * 65536);
    },
    300000,
  );
});
