// MurmurHash3's 32-bit finalizer (Austin Appleby, public domain),
// the five lines that taught a generation what avalanche means.
//
//   rustc --target wasm32-unknown-unknown --crate-type=cdylib \
//     -C opt-level=z -C lto -C strip=symbols -C panic=abort \
//     examples/native/fmix.rs -o examples/native/fmix.wasm
#![no_std]

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    loop {}
}

#[no_mangle]
pub extern "C" fn fmix32(mut h: u32) -> u32 {
    h ^= h >> 16;
    h = h.wrapping_mul(0x85eb_ca6b);
    h ^= h >> 13;
    h = h.wrapping_mul(0xc2b2_ae35);
    h ^= h >> 16;
    h
}
