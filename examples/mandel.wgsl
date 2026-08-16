// mandel.wgsl — the set, on whatever silicon answers.
//
// The same escape-time iteration and the same palette as
// examples/deepzoom.nacre, in WGSL compute. One dispatch per frame;
// the zoom parameters arrive as uniforms from the hot glue. f32 is
// the deepest this dialect dives — the mantissa is the seabed.

struct Params {
  x0: f32,
  y0: f32,
  step: f32,
  iters: u32,
}

@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read_write> pix: array<u32>;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= 256u || id.y >= 256u) {
    return;
  }
  let c = vec2f(p.x0 + p.step * f32(id.x), p.y0 + p.step * f32(id.y));
  var z = vec2f(0.0, 0.0);
  var i = 0u;
  loop {
    if (i >= p.iters || dot(z, z) > 4.0) {
      break;
    }
    z = vec2f(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + c;
    i = i + 1u;
  }
  var r = 0u;
  var g = 0u;
  var b = 0u;
  if (i < p.iters) {
    r = 255u - ((2u * i) & 255u);
    g = (5u * i) & 255u;
    b = 64u + ((3u * i) & 191u);
  }
  pix[id.y * 256u + id.x] = r | (g << 8u) | (b << 16u) | 0xff000000u;
}
