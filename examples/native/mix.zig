// mix.zig — the splitmix64 finalizer, folded to 32 bits.
//
// Built banded at --global-base=1179648, the second Zig band in the
// braid. The u64 parameter is the point: Hot Glue's implicit
// signatures are i32-only, so this import crosses through
// examples/stamp-seam.hma, the explicit-typed adapter module.
export fn stamp(x: u64) u32 {
    var z = x;
    z ^= z >> 30;
    z *%= 0xbf58476d1ce4e5b9;
    z ^= z >> 27;
    z *%= 0x94d049bb133111eb;
    z ^= z >> 31;
    return @truncate(z ^ (z >> 32));
}
