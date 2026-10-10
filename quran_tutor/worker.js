// «المحفّظ» — speech recognition worker (module worker, created only when
// the tutor screen opens). Runs Tarteel's whisper-base-ar-quran
// (Apache-2.0) as ONNX (iqbalaesthetic/Basira) with Transformers.js, so the
// recitation never leaves the phone. The model files (~100 MB) come from
// Hugging Face once and are then kept by the browser's Cache Storage.
//
// Messages in:  {type:'load', prefer:'auto'|'wasm'|'webgpu'}
//               {type:'transcribe', id, audio: Float32Array, rate: number}
// Messages out: {type:'progress', loaded, total, file}
//               {type:'ready', device, dtype, ms, cached}
//               {type:'result', id, text, ms, seconds}
//               {type:'error', id?, code, message}

import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0';

const MODEL = 'iqbalaesthetic/Basira';
const REVISION = '314f3d74186e1904b02d653868f6dd6870d5d744';
const RATE = 16000;

env.allowLocalModels = false;
env.useBrowserCache = true;

// Approximate download sizes (bytes) so the bar moves smoothly even before
// every file has reported its size.
const SIZES = {
  wasm: 23186936 + 79409343 + 2600000,
  hybrid: 41314374 + 79409343 + 2600000,
};

let asr = null;
let loading = null;
let info = null;
let warming = null;
let queue = Promise.resolve();

const post = (m, transfer) => self.postMessage(m, transfer || []);

async function gpuHasF16() {
  try {
    if (!self.navigator || !navigator.gpu) return false;
    const adapter = await navigator.gpu.requestAdapter();
    return !!adapter && adapter.features.has('shader-f16');
  } catch (_) {
    return false;
  }
}

async function build(kind) {
  const files = {};
  const expected = SIZES[kind];
  let lastSent = 0;
  const progress_callback = (p) => {
    if (p.status !== 'progress' || !p.file) return;
    files[p.file] = { loaded: p.loaded || 0, total: p.total || 0 };
    let loaded = 0, total = 0;
    for (const f of Object.values(files)) { loaded += f.loaded; total += f.total; }
    const now = Date.now();
    if (now - lastSent < 150 && loaded < total) return;
    lastSent = now;
    post({ type: 'progress', loaded, total: Math.max(total, expected), file: p.file });
  };
  const options = kind === 'hybrid'
    ? {
        revision: REVISION,
        device: { encoder_model: 'webgpu', decoder_model_merged: 'wasm' },
        dtype: { encoder_model: 'fp16', decoder_model_merged: 'q8' },
        progress_callback,
      }
    : { revision: REVISION, device: 'wasm', dtype: 'q8', progress_callback };
  // NB: no language/task — the model's generation_config is not
  // multilingual and Transformers.js throws if they are passed.
  return pipeline('automatic-speech-recognition', MODEL, options);
}

async function cachedBefore() {
  try {
    const c = await caches.open('transformers-cache');
    const keys = await c.keys();
    return keys.some((k) => k.url.includes('Basira') && k.url.includes('decoder_model_merged'));
  } catch (_) {
    return false;
  }
}

async function load(prefer) {
  if (asr) return info;
  if (loading) return loading;
  loading = (async () => {
    const t0 = performance.now();
    const cached = await cachedBefore();
    const order = [];
    if (prefer === 'webgpu' || (prefer !== 'wasm' && await gpuHasF16())) order.push('hybrid');
    order.push('wasm');
    let lastErr = null;
    for (const kind of order) {
      try {
        asr = await build(kind);
        // Warm-up on a second of silence after 'ready' (the user is still
        // listening to the reciter); a transcription waits for it.
        warming = asr(new Float32Array(RATE), {}).catch(() => {});
        info = { device: kind === 'hybrid' ? 'webgpu+wasm' : 'wasm', dtype: kind === 'hybrid' ? 'fp16+q8' : 'q8', ms: Math.round(performance.now() - t0), cached };
        return info;
      } catch (e) {
        lastErr = e;
        asr = null;
      }
    }
    throw lastErr || new Error('load failed');
  })();
  try {
    return await loading;
  } finally {
    loading = null;
  }
}

// Down-mix is done by the page; here: resample to 16 kHz (box-filtered
// linear interpolation — plenty for speech recognition).
function resample(input, rate) {
  if (!rate || rate === RATE) return input;
  const ratio = rate / RATE;
  const n = Math.floor(input.length / ratio);
  const out = new Float32Array(n);
  const half = Math.max(0, Math.floor(ratio / 2));
  for (let i = 0; i < n; i++) {
    const c = i * ratio;
    if (half === 0) {
      const j = Math.floor(c), f = c - j;
      const a = input[j] || 0, b = input[j + 1] ?? a;
      out[i] = a + (b - a) * f;
    } else {
      const j = Math.round(c);
      let s = 0, k = 0;
      for (let t = j - half; t <= j + half; t++) {
        if (t >= 0 && t < input.length) { s += input[t]; k++; }
      }
      out[i] = k ? s / k : 0;
    }
  }
  return out;
}

// Trim leading/trailing silence and normalise the level a little: quiet
// phone recordings transcribe noticeably worse.
function tidy(a) {
  let peak = 0;
  for (let i = 0; i < a.length; i++) { const v = Math.abs(a[i]); if (v > peak) peak = v; }
  if (peak < 1e-4) return a;
  const thr = peak * 0.04, pad = Math.floor(RATE * 0.25);
  let s = 0, e = a.length - 1;
  while (s < a.length && Math.abs(a[s]) < thr) s++;
  while (e > s && Math.abs(a[e]) < thr) e--;
  s = Math.max(0, s - pad); e = Math.min(a.length, e + pad);
  const out = a.slice(s, e);
  const gain = Math.min(8, 0.9 / peak);
  if (gain > 1.05) for (let i = 0; i < out.length; i++) out[i] *= gain;
  return out;
}

async function transcribe(id, audio) {
  if (warming) await warming;
  const t0 = performance.now();
  const out = await asr(audio, { chunk_length_s: 30, stride_length_s: 5 });
  const text = (Array.isArray(out) ? out.map((o) => o.text).join(' ') : out.text || '').trim();
  post({ type: 'result', id, text, ms: Math.round(performance.now() - t0), seconds: audio.length / RATE });
}

self.onmessage = async (ev) => {
  const m = ev.data || {};
  try {
    if (m.type === 'load') {
      const i = await load(m.prefer || 'auto');
      post({ type: 'ready', ...i });
    } else if (m.type === 'transcribe') {
      if (!asr) await load('auto');
      const a = tidy(resample(m.audio, m.rate));
      if (a.length < RATE * 0.4) {
        post({ type: 'result', id: m.id, text: '', ms: 0, seconds: a.length / RATE });
        return;
      }
      // One at a time (the review mode queues several ayahs).
      const job = queue.then(() => transcribe(m.id, a));
      queue = job.catch(() => {});
      await job;
    }
  } catch (e) {
    const msg = String((e && e.message) || e);
    const code = /fetch|network|Failed to fetch|NetworkError|load/i.test(msg) && !asr ? 'network'
      : /memory|allocation|OOM/i.test(msg) ? 'memory' : 'failed';
    post({ type: 'error', id: m.id, code, message: msg });
  }
};
