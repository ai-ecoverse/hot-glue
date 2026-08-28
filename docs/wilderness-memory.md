# Memory in the binary wilderness

How Hot Glue programs share address space — with each other, and with
the wasm modules found in the wild. Four patterns, ordered by how much
protection the platform still gives you, and the tools this repository
ships for the one where it gives you none.

The rule that governs everything here: **a module boundary is a memory
boundary.** Every pattern below is a decision about where that boundary
stands, or what replaces it when a platform takes it away.

## A — their memory stays theirs

`examples/interop.hma`. The C and Rust modules each declare their own
memory; Hot Glue calls across the boundary and only values return.
Collisions are not rare here — they are impossible. The cost is copying
at the border. This is the wasm default and the right first answer:
every import is a fence.

## B — you move into their memory

`examples/perl-driver.hma`. The supervisor imports zeroperl's memory,
owns none, and asks zeroperl's `malloc` for every byte it touches. The
discipline: **one allocator per address space, and it is theirs.** Note
that the glue libraries' compile-time bases don't apply in this world —
a `malloc` result is a runtime value. If you need them here, that is
the indirect-base variant, and it has not been needed yet.

## C — they move into yours

The reverse arrangement: exporting your memory to a module linked by
wasm-ld or Emscripten. Their data segments, shadow stack, and heap have
their own convictions about addresses and none of them read
`glue-mem.hma`. Read the foreign module's `__data_end`/`__heap_base`
exports before placing anything, or better, don't compose this way —
adopt pattern B or D instead, where the terms are explicit.

## D — the overlay: one module, one memory, on purpose

`examples/braid.hma`. Some platforms dissolve the boundary for you:
Fastly Compute runs one module per service, allows exactly one memory,
and offers no nested instantiation, so `wasm-merge` fuses everything
into one address space. Now nothing is protecting anyone — the overlay
must be *designed*. The braid is that design, exercised in
`test/braid.test.ts`:

```
0     .. ~4 KB     Hot Glue: pool from 32, library state per glue-mem
64 KB .. (taken)   bands claimed by (take …), guarded by canaries
1 MB  .. +8.2 KB   fnv.zig  — data, then stack, banded at build time
1.125 MB .. +8.2 KB  mix.zig — the second Zig band
```

Three mechanisms make it structural rather than lucky:

### Banding Zig at build time

A Zig module told

```
zig build-exe fnv.zig -target wasm32-freestanding -O ReleaseSmall
  -fno-entry --import-memory --initial-memory=2097152
  --global-base=1048576 --stack 8192 --export=fnv1a
```

places its data at `--global-base` and its stack pointer at
`global-base + data + stack`, growing down toward its own data: the
whole civilization fits in one self-contained band, and two Zig modules
at different bases coexist in one memory. (Contrast a default Zig
build, which is stack-first: 16 MB of stack at the *bottom* of memory —
squat under that and you are camping in the overflow zone with the trap
protection disarmed.) The supervisor exports the memory; the Zig
modules import it as `env.memory`; `wasm-merge` resolves the rest.

### Bands you take instead of pin

`src/glue-alloc.hma`. `(take name size)` claims the next band above
65536 and defines `(name)` as its folded base — the allocator is a
self-re-defining macro, gone before the module exists, zero runtime
cost. `(take-from addr)` moves the floor for hosts whose pages are
already spoken for. `src/glue-mem.hma` remains the pinned alternative;
the two answer the same names, and a host shadows one file either way.

### Borders that die out loud

`src/canary.hma`. `(defcanary addr)` posts a four-byte sentinel —
under a Zig band, at `(taken)`, wherever a border is; `(take-guarded
name size)` gives a band its own tripwire. `(canaries-arm)` at init,
`(canaries-check)` after foreign calls or per request: a write across
a border becomes an immediate trap, not a value that was quietly wrong.
The check is raw WAT, below the coverage meter, because its trap arm is
the one branch a healthy program never visits.

## The other seam: i64

Not a memory problem, but it arrives with the same modules. Hot Glue's
implicit signatures are i32-only, and explicit `(type …)` declarations
are viral per module — one type field and every func owes a type. So an
i64-bearing import gets an **adapter module**:
`examples/stamp-seam.hma` is fully explicit-typed, ten lines, braids
two i32s into the u64 that `mix.zig` wants, and quarantines the
virality so the module behind it stays in the implicit dialect. This is
the shape fx-proxy's generated `glue.wasm` takes; here it is written in
Hot Glue itself and merged like everything else.

## Choosing

| you control | they control | pattern |
| --- | --- | --- |
| the boundary | their memory | **A** — call across, copy at the border |
| nothing | the memory | **B** — import it, use their allocator |
| the memory | their layout | **C** — don't; choose B or D |
| the link | their build flags | **D** — band them, take yours, arm the borders |

If the platform lets modules stay modules, let them. When it doesn't,
the braid shows every part of the replacement: banded builds, a derived
map, and tripwires where the map ends.
