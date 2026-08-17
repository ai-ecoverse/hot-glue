// kokoro-tract — probe: can a pure-Rust ONNX runtime, compiled to
// WASI, load and run Kokoro-82M? Loads the model, reports the graph,
// and if inputs are given, runs a tiny inference.
use tract_onnx::prelude::*;

fn main() -> TractResult<()> {
    let path = std::env::args().nth(1).unwrap_or("models/kokoro/onnx/model_quantized.onnx".into());
    eprintln!("loading {path}…");
    let tokens: Vec<i64> = vec![0, 50, 83, 54, 156, 57, 135, 0];
    let t = tokens.len();
    let mut model = tract_onnx::onnx().model_for_path(&path)?;
    if let Ok(probes) = std::env::var("PROBES") {
        let names: Vec<&str> = probes.split(',').collect();
        model = model.with_outputs_by_name(&names)?;
    }
    eprintln!("nodes: {}", model.nodes().len());
    let runnable = if std::env::var("NO_CODEGEN").is_ok() {
        model.into_typed()?.into_decluttered()?.into_runnable()?
    } else {
        model.into_optimized()?.into_runnable()?
    };
    eprintln!("optimized + runnable — tract accepts the graph");
    // minimal utterance: the token ids above, a zero style vector, speed 1
    let input_ids = tract_ndarray::Array2::<i64>::from_shape_vec((1, t), tokens)?;
    let style = {
        // the voice file is 510 style rows of 256 f32; kokoro indexes by token count
        let raw = std::fs::read("models/kokoro/voices/af_heart.bin")?;
        let off = t * 256 * 4;
        let row: Vec<f32> = raw[off..off + 256 * 4]
            .chunks_exact(4)
            .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
            .collect();
        tract_ndarray::Array2::<f32>::from_shape_vec((1, 256), row)?
    };
    let speed = tract_ndarray::Array1::<f32>::from_vec(vec![1.0]);
    let out = runnable.run(tvec!(
        Tensor::from(input_ids).into(),
        Tensor::from(style).into(),
        Tensor::from(speed).into()
    ))?;
    for (i, o) in out.iter().enumerate() {
        if let Ok(v) = o.to_plain_array_view::<f32>() {
            let nans = v.iter().filter(|x| x.is_nan()).count();
            let rms = (v.iter().filter(|x| !x.is_nan()).map(|x| (*x as f64) * (*x as f64)).sum::<f64>()
                / v.len().max(1) as f64).sqrt();
            eprintln!("out[{i}] shape {:?} rms {:.4} nans {}/{}", v.shape(), rms, nans, v.len());
            if let Ok(dir) = std::env::var("DUMP_DIR") {
                let bytes: Vec<u8> = v.iter().flat_map(|x| x.to_le_bytes()).collect();
                std::fs::write(format!("{dir}/tract-out{i}.f32"), bytes)?;
            }
        }
    }
    let audio = out[0].to_plain_array_view::<f32>()?;
    let (mut mn, mut mx, mut sumsq, mut nans) = (f32::MAX, f32::MIN, 0f64, 0usize);
    for &v in audio.iter() {
        if v.is_nan() { nans += 1; continue; }
        mn = mn.min(v); mx = mx.max(v); sumsq += (v as f64) * (v as f64);
    }
    let rms = (sumsq / audio.len() as f64).sqrt();
    println!("audio samples: {} rms: {:.4} min: {:.3} max: {:.3} nans: {}", audio.len(), rms, mn, mx, nans);
    if let Some(out_path) = std::env::args().nth(2) {
        let bytes: Vec<u8> = audio.iter().flat_map(|v| v.to_le_bytes()).collect();
        std::fs::write(&out_path, bytes)?;
        eprintln!("wrote {out_path}");
    }
    Ok(())
}
