// fnv.zig — FNV-1a over bytes it does not own.
//
// Built banded: --import-memory --global-base=1048576 --stack 8192,
// so data and stack both live in [1 MB, 1 MB + ~8.2 KB) of a memory
// somebody else exports. fnv1a reads wherever the pointer says —
// including the Hot Glue string pool on the far side of the module
// boundary that wasm-merge dissolved.
const motto = "the pearl remembers";
export fn fnv1a(ptr: [*]const u8, len: u32) u32 {
    var h: u32 = 2166136261;
    var i: u32 = 0;
    while (i < len) : (i += 1) h = (h ^ ptr[i]) *% 16777619;
    return h;
}
export fn motto_ptr() u32 {
    return @intFromPtr(&motto[0]);
}
export fn motto_len() u32 {
    return motto.len;
}
