// «المحفّظ» — speech recognition worker (module worker, created only when
// the tutor screen opens). Runs Tarteel's whisper-base-ar-quran
// (Apache-2.0) as ONNX (iqbalaesthetic/Basira) with Transformers.js, so the
// recitation never leaves the phone. The model files (~100 MB) come from
// Hugging Face once and are then kept by the browser's Cache Storage.
//
// Speed (an ayah used to take 14+ s on a phone):
//  - Multithreaded WASM when the page is cross-origin isolated (the tutor
//    opens at /tutor/, whose service worker adds COOP/COEP — see
//    web/tutor/sw.js). Single-threaded otherwise.
//  - No fixed 30 s window: this export accepts a shorter mel input (its
//    positional embeddings are sliced), so the encoder only sees the
//    recording + 2 s (min 8 s, in 2 s buckets) — 3-5x less encoder work.
//    Short windows can make Whisper loop at the end; a loop guard stops the
//    decoder and that ayah is re-run on the classic 30 s window.
//  - Backend: see load() — WASM ×N threads when isolated, else the fp16
//    encoder on WebGPU if available; a backend whose warm-up fails falls
//    back to plain WASM.
//  - Greedy decoding with the prompt forced (<|ar|><|transcribe|>
//    <|notimestamps|>), max_new_tokens bounded by the ayah's word count.
//  - Warm-up right after load; one pipeline reused; audio transferred.
//
// Messages in:  {type:'load', prefer:'auto'|'wasm'|'webgpu'|'gpu'|'wasm-q4', threads?}
//               {type:'transcribe', id, audio: Float32Array, rate, words?, full?}
// Messages out: {type:'progress', loaded, total, file}
//               {type:'ready', device, backend, dtype, threads, isolated, ms, warmMs, cached}
//               {type:'result', id, text, ms, seconds, frames, tokens, retried, encMs, decMs, featMs}
//               {type:'error', id?, code, message}

import { pipeline, env, StoppingCriteria } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0';

const MODEL = 'iqbalaesthetic/Basira';
const REVISION = '314f3d74186e1904b02d653868f6dd6870d5d744';
const RATE = 16000;
// <|startoftranscript|><|ar|><|transcribe|><|notimestamps|> — the model's
// generation_config isn't multilingual, so these are passed as ids.
const PROMPT = [50258, 50272, 50359, 50363];
const FULL_FRAMES = 3000; // 30 s (100 mel frames per second)
const MIN_FRAMES = 800; // 8 s — shorter windows loop more often
const PAD_FRAMES = 200; // 2 s of padding after the recitation
const BUCKET = 200; // window sizes in 2 s steps (re-used kernels on WebGPU)
const SHORT_MAX_S = 27; // longer recordings use the chunked pipeline

env.allowLocalModels = false;
env.useBrowserCache = true;

const onnx = env.backends && env.backends.onnx;
const ISOLATED = self.crossOriginIsolated === true;

// Approximate download sizes (bytes) so the bar moves smoothly even before
// every file has reported its size.
const SIZES = {
  wasm: 23186936 + 79409343 + 2600000,
  'wasm-q4': 18754220 + 79409343 + 2600000,
  hybrid: 41314374 + 79409343 + 2600000,
  gpu: 41314374 + 157661080 + 2600000,
};

const KINDS = {
  wasm: { device: 'wasm', dtype: 'q8', label: 'wasm', dtypeLabel: 'q8' },
  'wasm-q4': { device: 'wasm', dtype: { encoder_model: 'q4', decoder_model_merged: 'q8' }, label: 'wasm', dtypeLabel: 'q4+q8' },
  hybrid: {
    device: { encoder_model: 'webgpu', decoder_model_merged: 'wasm' },
    dtype: { encoder_model: 'fp16', decoder_model_merged: 'q8' },
    label: 'webgpu+wasm',
    dtypeLabel: 'fp16+q8',
  },
  gpu: { device: 'webgpu', dtype: { encoder_model: 'fp16', decoder_model_merged: 'fp16' }, label: 'webgpu', dtypeLabel: 'fp16' },
};

let asr = null;
let loading = null;
let info = null;
let threads = 1;
let queue = Promise.resolve();
const timing = { enc: 0, dec: 0 };

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

/** Threads for onnxruntime-web: needs SharedArrayBuffer (cross-origin
 * isolation). Up to 4 — more doesn't help a base-size model on phones. */
function pickThreads(requested) {
  if (!ISOLATED || typeof SharedArrayBuffer === 'undefined') return 1;
  const hc = (self.navigator && navigator.hardwareConcurrency) || 4;
  const n = requested > 0 ? requested : Math.min(4, Math.ceil(hc / 2));
  return Math.max(1, Math.min(n, hc));
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
  const k = KINDS[kind];
  // NB: no language/task — the model's generation_config is not
  // multilingual and Transformers.js throws if they are passed.
  const p = await pipeline('automatic-speech-recognition', MODEL, { revision: REVISION, device: k.device, dtype: k.dtype, progress_callback });
  // Time spent in each ONNX session (debug panel).
  const sessions = (p.model && p.model.sessions) || {};
  for (const [name, s] of Object.entries(sessions)) {
    if (!s || typeof s.run !== 'function' || s.__timed) continue;
    const run = s.run.bind(s);
    const key = /decoder/.test(name) ? 'dec' : 'enc';
    s.run = async (...a) => {
      const t = performance.now();
      try { return await run(...a); } finally { timing[key] += performance.now() - t; }
    };
    s.__timed = true;
  }
  return p;
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

async function load(prefer, requestedThreads) {
  if (asr) return info;
  if (loading) return loading;
  loading = (async () => {
    const t0 = performance.now();
    const cached = await cachedBefore();
    threads = pickThreads(requestedThreads || 0);
    if (onnx && onnx.wasm) onnx.wasm.numThreads = threads;
    // 'auto': multithreaded WASM when isolated (with the short window the
    // encoder is cheap and the decoder — on WASM either way — dominates;
    // also no 41 MB fp16 encoder and no WebGPU shader compiles). Without
    // threads, the fp16 encoder on WebGPU (when the GPU has shader-f16).
    const order = [];
    if (prefer === 'gpu' || prefer === 'wasm-q4' || prefer === 'wasm') order.push(prefer);
    else if (prefer === 'webgpu' || prefer === 'hybrid' || (threads === 1 && await gpuHasF16())) order.push('hybrid');
    if (!order.includes('wasm')) order.push('wasm');
    let lastErr = null;
    for (const kind of order) {
      try {
        asr = await build(kind);
        // Warm-up (allocations, WebGPU shader compilation) on a second of
        // silence; a failure here (e.g. a WebGPU driver problem) falls back
        // to the next backend instead of failing the first real check.
        const w0 = performance.now();
        await recognise(new Float32Array(RATE), { cap: 3, frames: MIN_FRAMES });
        const warmMs = Math.round(performance.now() - w0);
        const k = KINDS[kind];
        const usesWasm = kind !== 'gpu';
        info = {
          device: k.label,
          backend: kind,
          dtype: k.dtypeLabel,
          threads: usesWasm ? threads : 0,
          isolated: ISOLATED,
          ms: Math.round(performance.now() - t0),
          warmMs,
          cached,
        };
        return info;
      } catch (e) {
        lastErr = e;
        try { if (asr && asr.dispose) await asr.dispose(); } catch (_) {}
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

// Trim leading/trailing silence (on a 20 ms energy envelope, so a click
// or a breath doesn't count as speech) and normalise the level a little:
// quiet phone recordings transcribe noticeably worse.
function tidy(a) {
  let peak = 0;
  for (let i = 0; i < a.length; i++) { const v = Math.abs(a[i]); if (v > peak) peak = v; }
  if (peak < 1e-4) return a;
  const win = Math.floor(RATE * 0.02);
  const n = Math.floor(a.length / win);
  if (n < 3) return a;
  const env = new Float32Array(n);
  let top = 0;
  for (let w = 0; w < n; w++) {
    let s = 0;
    for (let i = w * win, e = i + win; i < e; i++) s += a[i] * a[i];
    env[w] = Math.sqrt(s / win);
    if (env[w] > top) top = env[w];
  }
  const thr = top * 0.06;
  let first = 0, last = n - 1;
  while (first < n && env[first] < thr) first++;
  while (last > first && env[last] < thr) last--;
  const pad = Math.floor(RATE * 0.3);
  const s = Math.max(0, first * win - pad), e = Math.min(a.length, (last + 1) * win + pad);
  const out = a.slice(s, e);
  const gain = Math.min(8, 0.9 / peak);
  if (gain > 1.05) for (let i = 0; i < out.length; i++) out[i] *= gain;
  return out;
}

/** Stops the decoder when the tail of the output repeats itself (a block of
 * >= 6 tokens twice in a row) — Whisper's failure mode on short windows. */
class LoopGuard extends StoppingCriteria {
  constructor(start) {
    super();
    this.start = start;
    this.hit = false;
  }

  _call(input_ids) {
    return input_ids.map((ids) => {
      const n = ids.length - this.start;
      for (let p = 6; p * 2 <= n && p <= 90; p++) {
        let same = true;
        for (let i = 1; i <= p; i++) {
          if (ids[ids.length - i] !== ids[ids.length - i - p]) { same = false; break; }
        }
        if (same) { this.hit = true; return true; }
      }
      return false;
    });
  }
}

function framesFor(samples) {
  const need = Math.ceil((samples / RATE) * 100) + PAD_FRAMES;
  return Math.min(FULL_FRAMES, Math.max(MIN_FRAMES, Math.ceil(need / BUCKET) * BUCKET));
}

/** One greedy decode of [audio] (<= 30 s) on a [frames]-long mel window. */
async function recognise(audio, { frames, cap }) {
  const f0 = performance.now();
  const { input_features } = await asr.processor.feature_extractor(audio, { max_length: frames * 160 });
  const featMs = performance.now() - f0;
  const guard = new LoopGuard(PROMPT.length);
  const ids = await asr.model.generate({
    inputs: input_features,
    decoder_input_ids: PROMPT,
    max_new_tokens: cap,
    stopping_criteria: [guard],
  });
  const n = ids.dims ? ids.dims.at(-1) - PROMPT.length : 0;
  const text = asr.tokenizer.batch_decode(ids, { skip_special_tokens: true })[0].trim();
  return { text, tokens: n, looped: guard.hit, capped: n >= cap, featMs };
}

async function transcribe(id, audio, words, full) {
  const t0 = performance.now();
  timing.enc = 0;
  timing.dec = 0;
  const seconds = audio.length / RATE;
  let text, frames = FULL_FRAMES, tokens = 0, retried = false, featMs = 0;
  if (seconds <= SHORT_MAX_S) {
    // ~6 tokens per word; room for an isti'adha + basmala before the ayah.
    const cap = words > 0 ? Math.min(440, 70 + words * 10) : Math.min(440, 40 + Math.ceil(seconds * 14));
    frames = full ? FULL_FRAMES : framesFor(audio.length);
    let r = await recognise(audio, { frames, cap });
    featMs += r.featMs;
    if ((r.looped || r.capped) && frames < FULL_FRAMES) {
      retried = true;
      frames = FULL_FRAMES;
      r = await recognise(audio, { frames, cap });
      featMs += r.featMs;
    }
    text = r.text;
    tokens = r.tokens;
  } else {
    const out = await asr(audio, { chunk_length_s: 30, stride_length_s: 5 });
    text = (Array.isArray(out) ? out.map((o) => o.text).join(' ') : out.text || '').trim();
  }
  post({
    type: 'result',
    id,
    text,
    ms: Math.round(performance.now() - t0),
    seconds,
    frames,
    tokens,
    retried,
    encMs: Math.round(timing.enc),
    decMs: Math.round(timing.dec),
    featMs: Math.round(featMs),
  });
}

self.onmessage = async (ev) => {
  const m = ev.data || {};
  try {
    if (m.type === 'load') {
      const i = await load(m.prefer || 'auto', m.threads || 0);
      post({ type: 'ready', ...i });
    } else if (m.type === 'transcribe') {
      if (!asr) await load('auto', 0);
      const a = tidy(resample(m.audio, m.rate));
      if (a.length < RATE * 0.4) {
        post({ type: 'result', id: m.id, text: '', ms: 0, seconds: a.length / RATE, frames: 0, tokens: 0, retried: false });
        return;
      }
      // One at a time (the review mode queues several ayahs).
      const job = queue.then(() => transcribe(m.id, a, m.words || 0, !!m.full));
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
