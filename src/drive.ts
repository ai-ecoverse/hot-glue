/**
 * drive.ts — running the compiler this package ships, which is wasm.
 *
 * expand.wasm and as.wasm are instantiated as reactors and handed to
 * hotglue.wasm as its imported modules; the source arrives on stdin,
 * (use …) resolves through WASI path_open against the lookup path,
 * the WAT is read out of the expander instance the driver drove, and
 * the binary comes back on stdout. It is the same driver the tab runs
 * (web/playground.template.html), with a real filesystem behind
 * path_open instead of an embedded map, and it needs no wasmtime: the
 * only WebAssembly host in play is the one Node already is.
 *
 * Nothing here expands anything. The expander is expand.wasm, the
 * assembler is as.wasm; this is a lookup path and forty lines of WASI.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Organ = 'expand' | 'as' | 'hotglue';

export interface Options {
  /** searched before ./src and the sources shipped beside the organs */
  dirs?: string[];
  /** a complaint that did not stop the run — an assembler that refused
   *  the WAT, say, when only the WAT was asked for */
  onWarn?: (message: string) => void;
}

export interface Compiled {
  /** the WAT the expander printed, byte for byte */
  wat: Uint8Array;
  /** the binary the assembler made of it */
  bin: Uint8Array;
}

const here = dirname(fileURLToPath(import.meta.url));
const dec = new TextDecoder();

// What the driver can be handed: hotglue.hma walks the preopened
// directories by trying fd 3 and stopping at 10, so seven is the length
// of a lookup path — under wasmtime exactly as much as here.
const PREOPENS = 7;

/**
 * Where the three organs live. An explicit HOTGLUE_DIST wins — the
 * projector already spells the lookup that way — then the directory
 * this file sits in, which is the published layout, then the
 * bootstrap's output directory, which is a checkout that has run it.
 */
function organDir(): string {
  const tried = [process.env.HOTGLUE_DIST, here, join(here, '..', 'dist', 'hotglue')].filter(
    (d): d is string => !!d,
  );
  for (const d of tried) if (existsSync(join(d, 'as.wasm'))) return d;
  throw new Error(
    `no wasm toolchain here: as.wasm is in none of ${tried.join(', ')}.
In a checkout the bootstrap builds it, and needs a wasmtime to do it:

  npm run bootstrap`,
  );
}

/** The path of a shipped organ, for a caller that hosts it itself. */
export function wasmPath(organ: Organ): string {
  return join(organDir(), `${organ}.wasm`);
}

/**
 * The lookup path a (use …) is resolved against: the caller's
 * directories, then ./src, then the sources shipped beside this file —
 * so the prelude is there under `npx`, with no checkout to find it in.
 *
 * Resolved and deduplicated, because the path is short and a repeat
 * spends one of it. Six entry files out of one directory are one
 * directory, not six, and the sources shipped beside this file are
 * worth more than the sixth copy of the name they came in under.
 */
export function lookupPath(dirs: string[] = []): string[] {
  const path: string[] = [];
  for (const dir of [...dirs, 'src', here]) {
    const abs = resolve(dir);
    if (!path.includes(abs)) path.push(abs);
  }
  return path;
}

const modules = new Map<Organ, WebAssembly.Module>();
function organ(name: Organ): WebAssembly.Module {
  let m = modules.get(name);
  if (!m) modules.set(name, (m = new WebAssembly.Module(readFileSync(wasmPath(name)))));
  return m;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.length;
  }
  return all;
}

// Enough WASI for a reactor that only ever writes: both organs report
// what stopped them on fd 2 before they trap, and losing that message
// is losing the only thing they said.
function reactor(name: Organ, errs: Uint8Array[]): WebAssembly.Exports {
  let inst: WebAssembly.Instance;
  const mem = () => (inst.exports.memory as WebAssembly.Memory).buffer;
  inst = new WebAssembly.Instance(organ(name), {
    wasi_snapshot_preview1: {
      fd_read: () => 8,
      fd_write(fd: number, iovs: number, _cnt: number, pn: number) {
        const dv = new DataView(mem());
        const base = dv.getUint32(iovs, true);
        const len = dv.getUint32(iovs + 4, true);
        errs.push(new Uint8Array(mem()).slice(base, base + len));
        dv.setUint32(pn, len, true);
        return 0;
      },
    },
  });
  return inst.exports;
}

interface Run extends Compiled {
  error?: Error;
}

function run(source: string | Uint8Array, opts: Options): Run {
  const stdin = typeof source === 'string' ? new TextEncoder().encode(source) : source;
  const dirs = lookupPath(opts.dirs);
  // Better than a lookup path whose tail is unreachable: the shipped
  // sources are at the end of it, and a (use prelude.hma) that cannot
  // see them fails a long way from the cause.
  if (dirs.length > PREOPENS) {
    throw new Error(
      `the lookup path is ${dirs.length} directories and the driver can open ${PREOPENS}:
  ${dirs.join('\n  ')}
hotglue.wasm tries fd 3 through 9 and stops, so the rest would never be
searched. Give fewer directories, or put those sources on one.`,
    );
  }
  const outs: Uint8Array[] = [];
  const errs: Uint8Array[] = [];
  const ex = reactor('expand', errs);
  const asm = reactor('as', errs);

  let inst: WebAssembly.Instance;
  const buf = () => (inst.exports.memory as WebAssembly.Memory).buffer;
  const dv = () => new DataView(buf());
  const u8 = () => new Uint8Array(buf());
  const files = new Map<number, { bytes: Uint8Array; pos: number }>();
  let stdinPos = 0;
  let nextFd = 100;

  const wasi = {
    // one argument, which is the program's own name: with no second one
    // the driver reads stdin, and stdin is where we put the source
    args_sizes_get(pc: number, ps: number) {
      dv().setUint32(pc, 1, true);
      dv().setUint32(ps, 0, true);
      return 0;
    },
    args_get: () => 0,
    // the preopened directories are the lookup path, in order, and the
    // driver walks them by trying fd 3 upward — so fd 3 is dirs[0]
    path_open(
      dirfd: number,
      _dirflags: number,
      pp: number,
      pl: number,
      _oflags: number,
      _rights: bigint,
      _inheriting: bigint,
      _fdflags: number,
      res: number,
    ) {
      const dir = dirs[dirfd - 3];
      if (dir === undefined) return 8; // EBADF: no such preopen
      const name = dec.decode(u8().slice(pp, pp + pl));
      const path = join(dir, name);
      if (!existsSync(path)) return 44; // ENOENT: try the next directory
      const fd = nextFd++;
      files.set(fd, { bytes: readFileSync(path), pos: 0 });
      dv().setUint32(res, fd, true);
      return 0;
    },
    fd_read(fd: number, iovs: number, _cnt: number, pn: number) {
      const base = dv().getUint32(iovs, true);
      const len = dv().getUint32(iovs + 4, true);
      const f = fd === 0 ? { bytes: stdin, pos: stdinPos } : files.get(fd);
      if (!f) return 8;
      const n = Math.min(len, f.bytes.length - f.pos);
      u8().set(f.bytes.subarray(f.pos, f.pos + n), base);
      f.pos += n;
      if (fd === 0) stdinPos = f.pos;
      dv().setUint32(pn, n, true);
      return 0;
    },
    fd_close(fd: number) {
      files.delete(fd);
      return 0;
    },
    fd_write(fd: number, iovs: number, _cnt: number, pn: number) {
      const base = dv().getUint32(iovs, true);
      const len = dv().getUint32(iovs + 4, true);
      (fd === 2 ? errs : outs).push(u8().slice(base, base + len));
      dv().setUint32(pn, len, true);
      return 0;
    },
  };

  inst = new WebAssembly.Instance(organ('hotglue'), {
    wasi_snapshot_preview1: wasi,
    expand: ex,
    as: asm,
  });

  let error: Error | undefined;
  try {
    (inst.exports._start as () => void)();
  } catch (e) {
    // A driver that dies mid-sentence has put half of it on stdout: the
    // name of the file it could not find is written there, the reason
    // for it on stderr. Nothing was a binary if we got here, so read
    // stdout back as prose — as long as it looks like prose.
    const text = (parts: Uint8Array[]) => dec.decode(concat(parts));
    const prose = (s: string) => !/[\x00-\x08]/.test(s);
    const half = text(outs);
    const said = ((prose(half) ? half : '') + text(errs)).trim();
    error = said ? new Error(said) : e instanceof Error ? e : new Error(String(e));
  }

  // the WAT comes out of the expander instance the driver drove, which
  // still holds it whether or not the assembler could stomach it
  const outlen = ex.outlen as () => number;
  const at = ex.out as (i: number) => number;
  const wat = new Uint8Array(outlen());
  for (let i = 0; i < wat.length; i++) wat[i] = at(i);

  return { wat, bin: concat(outs), error };
}

/** Source in, WAT and binary out — the whole flow, in this process. */
export function compile(source: string | Uint8Array, opts: Options = {}): Compiled {
  const { wat, bin, error } = run(source, opts);
  if (error) throw error;
  return { wat, bin };
}

/**
 * Source in, WAT out. An assembler that refuses the result is a warning
 * here rather than a failure: the WAT is what was asked for, wasmtime
 * runs it, and the subset as.wasm accepts is not the subset WAT has.
 */
export function expand(source: string | Uint8Array, opts: Options = {}): Uint8Array {
  const { wat, error } = run(source, opts);
  if (error && !wat.length) throw error;
  if (error) opts.onWarn?.(`the WAT expanded, but the assembler refused it: ${error.message}`);
  return wat;
}
