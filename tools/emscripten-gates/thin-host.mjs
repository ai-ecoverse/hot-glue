#!/usr/bin/env node
// thin-host.mjs — boot an Emscripten binary with no Emscripten glue.
//
// A generic loader: it knows nothing about any particular module. It
// reads the sidecar make-shim.mjs produced (memory descriptor, the
// export map recovered from the glue text, the miss table), creates
// the shared memory, instantiates the generated shim against ~40
// lines of WASI, hands the shim's exports to the module as the
// namespace its import section names, and calls ctors + main the way
// the glue would have — argv malloc'd into the module's own heap.
// Not one line of the original .js executes.
//
//   node tools/emscripten-gates/thin-host.mjs core.wasm shimdir/ -- -version
import { readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const sep = args.indexOf('--');
const [corePath, shimDir] = args;
const progArgs = sep >= 0 ? args.slice(sep + 1) : [];

const sidecar = JSON.parse(readFileSync(join(shimDir, 'shim.json'), 'utf8'));
const { pages, shared } = sidecar.memory;
const memory = new WebAssembly.Memory({ initial: pages, maximum: pages, shared });
const dv = () => new DataView(memory.buffer);

const wasi = {
  clock_time_get(id, _precision, out) {
    const ns = id === 0 ? BigInt(Date.now()) * 1000000n : process.hrtime.bigint();
    dv().setBigUint64(out, ns, true);
    return 0;
  },
  fd_write(fd, iov, cnt, pnum) {
    let total = 0;
    for (let i = 0; i < cnt; i++) {
      const p = dv().getUint32(iov + 8 * i, true);
      const n = dv().getUint32(iov + 8 * i + 4, true);
      // Buffer.from copies — a shared buffer can't go to writeSync raw
      writeSync(fd === 2 ? 2 : 1, Buffer.from(new Uint8Array(memory.buffer, p, n)));
      total += n;
    }
    dv().setUint32(pnum, total, true);
    return 0;
  },
  fd_read(_fd, _iov, _cnt, pnum) {
    dv().setUint32(pnum, 0, true); // EOF
    return 0;
  },
  fd_close: () => 0,
  proc_exit(code) { process.exit(code); },
};

const shim = new WebAssembly.Instance(
  new WebAssembly.Module(readFileSync(join(shimDir, 'shim.wasm'))),
  {
    env: { memory },
    wasi_snapshot_preview1: wasi,
    host: {
      miss(id) { console.error(`gate miss: ${sidecar.misses[id]} — translate it in make-shim.mjs`); },
    },
  },
);

// boot-ritual gates the wasm shim cannot serve: they call back into
// the module's own exports mid-ctors, so they live here, late-bound
const I32 = () => new Int32Array(memory.buffer);
const HOST_KINDS = {
  // Emscripten pthreads main-thread init: allocate the thread struct
  // and its TLS from the module's heap, mark it main (the 42 is
  // Emscripten's own magic), and register it
  'pthread-main-init': () => () => {
    const tb = call('_malloc', 232);
    I32().fill(0, tb >> 2, (tb >> 2) + 58);
    I32()[(tb + 12) >> 2] = tb;
    I32()[(tb + 156) >> 2] = tb + 156;
    const tls = call('_malloc', 512);
    I32().fill(0, tls >> 2, (tls >> 2) + 128);
    Atomics.store(I32(), (tb + 104) >> 2, tls);
    Atomics.store(I32(), (tb + 40) >> 2, tb);
    Atomics.store(I32(), (tb + 44) >> 2, 42);
    // the glue state the setter would have written (thread ptr,
    // is-main, can-block) lives in memory slots the shim reads
    const [ptrVar, mainVar, blockVar] = sidecar.pthreadStateVars ?? [];
    const slot = (v, x) => { if (sidecar.stateSlots?.[v] != null) I32()[sidecar.stateSlots[v] >> 2] = x; };
    slot(ptrVar, tb);
    slot(mainVar, 1);
    slot(blockVar, 1);
    call('_emscripten_register_main_browser_thread_id', tb);
  },
};
const deferred = [];
HOST_KINDS['deferred-table-call'] = () => (fn, arg) => { deferred.push([fn, arg]); };
const atexits = [];
HOST_KINDS['atexit-table-call'] = () => (fn, arg) => { atexits.unshift([fn, arg]); return 0; };

const hostGates = {};
for (const [nm, kind] of Object.entries(sidecar.hostGates ?? {})) {
  if (!HOST_KINDS[kind]) throw new Error(`no host implementation for gate kind ${kind}`);
  hostGates[nm] = HOST_KINDS[kind]();
}

const coreMod = new WebAssembly.Module(readFileSync(corePath));
const ns = WebAssembly.Module.imports(coreMod).find((i) => i.kind === 'memory');
const core = new WebAssembly.Instance(coreMod, {
  [ns.module]: { ...shim.exports, ...hostGates, [ns.name]: memory },
});

// the boot ritual, read from the glue but performed without it
const ex = sidecar.exports; // public name → minified export
const asm = core.exports;
const call = (name, ...a) => {
  if (!(ex[name] && asm[ex[name]])) throw new Error(`no export mapping for ${name}`);
  return asm[ex[name]](...a);
};

call('___wasm_call_ctors');
// the runtime is up: flush calls that ctors deferred to it
const table = Object.values(asm).find((v) => v instanceof WebAssembly.Table);
for (const [fn, arg] of deferred.splice(0)) table.get(fn)(arg);
const cmd = ['program', ...progArgs];
const argv = call('_malloc', 4 * (cmd.length + 1));
cmd.forEach((s, i) => {
  const b = Buffer.from(s + '\0');
  const p = call('_malloc', b.length);
  new Uint8Array(memory.buffer, p, b.length).set(b);
  dv().setUint32(argv + 4 * i, p, true);
});
dv().setUint32(argv + 4 * cmd.length, 0, true);
const rc = call('_main', cmd.length, argv);
for (const [fn, arg] of atexits) table.get(fn)(arg);
process.exit(rc);
