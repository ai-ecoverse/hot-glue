import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile, loadSource, read, Sym } from '../../src/hotglue/bootstrap.js';

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

const dir = mkdtempSync(join(tmpdir(), 'hotglue-projector-'));

let filmWasm: Buffer;
let wavWasm: Buffer;
let y4mWasm: Buffer;

beforeAll(() => {
  if (!runtime) return;
  const asWat = join(dir, 'as.wat');
  writeFileSync(asWat, compile(loadSource(['src/hotglue/as.hma'])));
  const build = (entry: string) =>
    execFileSync(runtime!, ['run', '--invoke', 'run', asWat], {
      input: compile(loadSource([entry])),
      maxBuffer: 1 << 26,
    });
  filmWasm = build('examples/film.hma');
  wavWasm = build('examples/wav.hma');
  y4mWasm = build('examples/rgb2y4m.hma');
});

describe('the film is a program; the projector is a lamp', () => {
  it('reads .hma with the house reader, and the film declares everything', () => {
    const forms = read(readFileSync('examples/film.hma', 'utf8'));
    const film = forms.find((f) => Array.isArray(f) && f[0] instanceof Sym && f[0].name === 'film') as unknown[];
    expect(film).toBeDefined();
    expect(film[1]).toBe('gpu-perlmutt.mp4');
    const body = film.slice(2) as unknown[][];
    const declared = new Set(body.filter((s) => (s[0] as Sym).name === 'filter').map((s) => s[1] as string));
    for (const s of body.filter((s) => (s[0] as Sym).name === 'filter'))
      expect(existsSync(s[2] as string)).toBe(true);
    const native = new Set(['perl', 'speak', 'gpu']);
    for (const s of body.filter((s) => (s[0] as Sym).name === 'let')) {
      const verb = ((s[2] as unknown[])[0] as Sym).name;
      expect(declared.has(verb) || native.has(verb)).toBe(true);
    }
  });

  it.skipIf(!runtime)('compiles to a module whose import section is the manifest', () => {
    const mod = new WebAssembly.Module(filmWasm);
    const namespaces = new Set(WebAssembly.Module.imports(mod).map((i) => i.module));
    expect(namespaces).toEqual(new Set(['host', 'examples/wav.hma', 'examples/rgb2y4m.hma']));
    // every filter import is the byte protocol, nothing more
    const wavNames = WebAssembly.Module.imports(mod)
      .filter((i) => i.module === 'examples/wav.hma')
      .map((i) => i.name)
      .sort();
    expect(wavNames).toEqual(['begin', 'go', 'in!', 'out']);
  });

  it.skipIf(!runtime)('a stub lamp runs the film: real filters glue, the cut receives streams', () => {
    const stub = { wasi_snapshot_preview1: { fd_read: () => 8, fd_write: () => 8 } };
    const filters: Record<string, WebAssembly.Exports> = {
      'examples/wav.hma': new WebAssembly.Instance(new WebAssembly.Module(wavWasm), stub).exports,
      'examples/rgb2y4m.hma': new WebAssembly.Instance(new WebAssembly.Module(y4mWasm), stub).exports,
    };
    let film: WebAssembly.Instance;
    const mem = () => new Uint8Array((film.exports.memory as WebAssembly.Memory).buffer);
    const str = (p: number, n: number) => Buffer.from(mem().slice(p, p + n)).toString('utf8');
    let pending = Buffer.alloc(0);
    const inputs: { bytes: Buffer; loop: boolean }[] = [];
    let cutName = '';
    const calls: string[] = [];
    // stub capabilities with honest shapes: text, a sine, two frames
    const host = {
      perl(pp: number, pl: number) {
        calls.push('perl:' + str(pp, pl));
        pending = Buffer.from('The stub narrates.');
        return pending.length;
      },
      speak(tp: number, tl: number, vp: number, vl: number) {
        calls.push(`speak:${str(tp, tl)}:${str(vp, vl)}`);
        pending = Buffer.alloc(4800 * 4);
        for (let i = 0; i < 4800; i++) pending.writeFloatLE(Math.sin(i / 20) * 0.5, i * 4);
        return pending.length;
      },
      gpu(sp: number, sl: number, frames: number) {
        calls.push(`gpu:${str(sp, sl)}:${frames}`);
        pending = Buffer.alloc(2 * 196608);
        for (let i = 0; i < pending.length; i++) pending[i] = i & 255;
        return pending.length;
      },
      take(dst: number) {
        mem().set(pending, dst);
        pending = Buffer.alloc(0);
      },
      input(p: number, n: number, loop: number) {
        inputs.push({ bytes: Buffer.from(mem().slice(p, p + n)), loop: !!loop });
      },
      cut(pp: number, pl: number) {
        cutName = str(pp, pl);
      },
    };
    film = new WebAssembly.Instance(new WebAssembly.Module(filmWasm), { host, ...filters });
    (film.exports._start as () => void)();
    expect(calls).toEqual([
      'perl:examples/narration.pl',
      'speak:The stub narrates.:af_heart',
      'gpu:examples/mandel.wgsl:150',
    ]);
    expect(cutName).toBe('gpu-perlmutt.mp4');
    expect(inputs.length).toBe(2);
    expect(inputs[0].loop).toBe(true); // the video loops under the voice
    expect(inputs[0].bytes.subarray(0, 9).toString()).toBe('YUV4MPEG2');
    expect(inputs[0].bytes.length).toBe(39 + 2 * (6 + 3 * 65536)); // two frames through the real filter
    expect(inputs[1].loop).toBe(false);
    expect(inputs[1].bytes.subarray(0, 4).toString()).toBe('RIFF');
    expect(inputs[1].bytes.length).toBe(44 + 4800 * 2); // 16-bit samples behind the canonical header
  });

  it.skipIf(!runtime)('perl runs under pure wasmtime, a Hot Glue supervisor driving zeroperl', () => {
    const asWat = join(dir, 'as.wat');
    const build = (entry: string, out: string) =>
      writeFileSync(
        out,
        execFileSync(runtime!, ['run', '--invoke', 'run', asWat], {
          input: compile(loadSource([entry])),
          maxBuffer: 1 << 26,
        }),
      );
    const drv = join(dir, 'perl-driver.wasm');
    const env = join(dir, 'envstub.wasm');
    build('examples/perl-driver.hma', drv);
    build('examples/envstub.hma', env);
    const dev = join(dir, 'dev');
    mkdirSync(dev, { recursive: true });
    writeFileSync(join(dev, 'null'), '');
    const out = execFileSync(
      runtime!,
      ['--dir', '.', '--dir', `${dev}::/dev`, '--preload', `env=${env}`,
       '--preload', 'zeroperl=node_modules/@6over3/zeroperl-ts/dist/esm/zeroperl.wasm', drv],
      { input: 'examples/narration.pl', maxBuffer: 1 << 24 },
    ).toString();
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
      writeFileSync(wat, compile(loadSource(['examples/rgb2y4m.hma'])));
      const y4m = execFileSync(runtime!, [wat], { input: f, maxBuffer: 1 << 26 });
      expect(y4m.subarray(0, 9).toString()).toBe('YUV4MPEG2');
      expect(y4m.length).toBe(39 + 6 + 3 * 65536);
    },
    300000,
  );
});
