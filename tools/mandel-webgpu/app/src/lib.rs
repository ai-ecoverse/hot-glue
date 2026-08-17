// mandel — the deep zoom as a wasi:webgpu guest.
//
// The same dispatch as scripts/gpu-render.mjs in the allegorithm
// repo, with the browser removed: the WGSL arrives from the host
// (shader-source), the zoom schedule lives here in the renderer
// exactly as it lived in the page, and every finished frame goes
// back through emit-frame as raw RGB24. No JavaScript, no browser,
// no window — a component talking to wgpu-core through wit.

use wasi::webgpu::webgpu;

wit_bindgen::generate!({
    path: "../../wit",
    world: "example:example/example",
    generate_all,
});

export!(Mandel);

struct Mandel;

impl Guest for Mandel {
    async fn start() {
        render().await;
    }
}

const W: u32 = 256;
const H: u32 = 256;
const PIXBYTES: u64 = (W * H * 4) as u64;

async fn render() {
    let frames = frame_count();
    let wgsl = shader_source();

    let device = webgpu::get_gpu()
        .request_adapter(None)
        .await
        .unwrap()
        .request_device(None)
        .await
        .unwrap();

    let module = device.create_shader_module(&webgpu::GpuShaderModuleDescriptor {
        label: None,
        code: wgsl,
        compilation_hints: None,
    });

    // uniforms: x0, y0, step (f32) + iters (u32) — 16 bytes
    let uni = device.create_buffer(&webgpu::GpuBufferDescriptor {
        label: Some("Params".to_string()),
        size: 16,
        usage: webgpu::GpuBufferUsage::UNIFORM | webgpu::GpuBufferUsage::COPY_DST,
        mapped_at_creation: None,
    });

    let pix = device.create_buffer(&webgpu::GpuBufferDescriptor {
        label: Some("Pixels".to_string()),
        size: PIXBYTES,
        usage: webgpu::GpuBufferUsage::STORAGE | webgpu::GpuBufferUsage::COPY_SRC,
        mapped_at_creation: None,
    });

    let staging = device.create_buffer(&webgpu::GpuBufferDescriptor {
        label: None,
        size: PIXBYTES,
        usage: webgpu::GpuBufferUsage::MAP_READ | webgpu::GpuBufferUsage::COPY_DST,
        mapped_at_creation: None,
    });

    let pipeline = device.create_compute_pipeline(webgpu::GpuComputePipelineDescriptor {
        label: None,
        layout: webgpu::GpuLayoutMode::Auto,
        compute: webgpu::GpuProgrammableStage {
            module: &module,
            entry_point: Some("main".to_string()),
            constants: None,
        },
    });

    let layout = pipeline.get_bind_group_layout(0);
    let bind = device.create_bind_group(&webgpu::GpuBindGroupDescriptor {
        label: None,
        layout: &layout,
        entries: vec![
            webgpu::GpuBindGroupEntry {
                binding: 0,
                resource: webgpu::GpuBindingResource::GpuBufferBinding(webgpu::GpuBufferBinding {
                    buffer: &uni,
                    offset: Some(0),
                    size: None,
                }),
            },
            webgpu::GpuBindGroupEntry {
                binding: 1,
                resource: webgpu::GpuBindingResource::GpuBufferBinding(webgpu::GpuBufferBinding {
                    buffer: &pix,
                    offset: Some(0),
                    size: None,
                }),
            },
        ],
    });

    for f in 0..frames {
        // the zoom schedule — identical to gpu-render.mjs
        let span = 3.5_f64 * 0.933_f64.powi(f as i32);
        let mut params = [0u8; 16];
        params[0..4].copy_from_slice(&((-0.743643887037151 - span / 2.0) as f32).to_le_bytes());
        params[4..8].copy_from_slice(&((0.131825904205330 - span / 2.0) as f32).to_le_bytes());
        params[8..12].copy_from_slice(&((span / 256.0) as f32).to_le_bytes());
        params[12..16].copy_from_slice(&128u32.to_le_bytes());
        device
            .queue()
            .write_buffer_with_copy(&uni, 0, &params, None, None)
            .unwrap();

        let encoder = device
            .create_command_encoder(Some(&webgpu::GpuCommandEncoderDescriptor { label: None }));
        {
            let cpass = encoder.begin_compute_pass(None);
            cpass.set_pipeline(&pipeline);
            cpass
                .set_bind_group(0, Some(&bind), None, None, None)
                .unwrap();
            cpass.dispatch_workgroups(W / 16, Some(H / 16), Some(1));
            cpass.end();
        }
        encoder.copy_buffer_to_buffer(&pix, None, &staging, None, None);
        device.queue().submit(&[&encoder.finish(None)]);

        staging
            .map_async(webgpu::GpuMapMode::READ, Some(0), None)
            .await
            .unwrap();
        let rgba = staging.get_mapped_range_get_with_copy(None, None).unwrap();
        let mut rgb = Vec::with_capacity((W * H * 3) as usize);
        for px in rgba.chunks_exact(4) {
            rgb.extend_from_slice(&px[..3]);
        }
        staging.unmap().unwrap();

        emit_frame(&rgb);
    }

    print(&format!(
        "mandel: {frames} frames of {W}x{H} RGB dispatched via wasi:webgpu"
    ));
}
