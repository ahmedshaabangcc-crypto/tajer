// «المحفّظ» — page-side helper (ES module, imported by the Dart tutor
// screen only when it opens). Owns the speech worker, the microphone and
// the reciter audio; the Dart side only calls these functions.
//
// Never hang (0089 — «بنسمع تسميعك…» stuck forever on real phones): a
// worker that runs out of memory is killed without a word, and one stuck in
// WASM can't answer at all, so every request has a watchdog. Loading: no
// message from the worker for LOAD_STALL_MS. Recognition: no result within
// max(20 s, 4× the expected time). Either way (and on a worker error) the
// worker is terminated, a fresh one is loaded in safe mode (single-threaded
// WASM, no WebGPU, the classic 30 s window) and the request is retried
// once; after that the error is reported with its details (diag()).

let worker = null;
let gen = 0; // worker generation (messages from a killed worker are ignored)
let seq = 0;
const pending = new Map(); // id -> {resolve, reject, timer}
let loadJob = null; // {promise, resolve, reject, timer}
let progressCb = null;
let modelInfo = null;
let wanted = { prefer: 'auto', threads: 0 };
let safe = false;
let rtf = 0; // learnt ms of recognition per second of audio
let lastRec = null;
const diagState = { errors: [], last: null, stage: '', gpuFailed: '', recoveries: 0 };

const LOAD_STALL_MS = 120000;
const MIN_WATCHDOG_MS = 20000;
const NOGPU_KEY = 'mt.tutor.nogpu';
const SAFE_KEY = 'mt.tutor.safe';
const SAFE_DAYS = 7;

const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isMobile = () => isIOS() || /Android|Mobi/i.test(navigator.userAgent);

function lsGet(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (_) {} }

// Debug-only fault injection: ?debug=1&tutor_sim=hang|crash|error|loadhang
// (first worker only) or hang-all|crash-all|error-all (the retry too).
function simFlag() {
  try {
    const q = new URLSearchParams(location.search);
    return q.get('debug') === '1' ? q.get('tutor_sim') || '' : '';
  } catch (_) {
    return '';
  }
}

// A device that hung/crashed recently starts in safe mode right away.
(function () {
  const t = +(lsGet(SAFE_KEY) || 0);
  if (t && Date.now() - t < SAFE_DAYS * 864e5) safe = true;
})();

export function support() {
  const AC = window.AudioContext || window.webkitAudioContext;
  return {
    worker: typeof Worker !== 'undefined',
    wasm: typeof WebAssembly === 'object',
    mic: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
    recorder: typeof MediaRecorder !== 'undefined',
    audio: !!AC,
    webgpu: !!navigator.gpu,
    secure: !!window.isSecureContext,
    ios: isIOS(),
    memory: navigator.deviceMemory || 0,
    isolated: window.crossOriginIsolated === true,
    cores: navigator.hardwareConcurrency || 0,
  };
}

function fail(code, message) {
  const e = new Error(message || code);
  e.code = code;
  return e;
}

function noteError(where, err) {
  diagState.errors.push({ where, code: (err && err.code) || 'failed', message: String((err && err.message) || err).slice(0, 400), at: Date.now() });
  if (diagState.errors.length > 6) diagState.errors.shift();
}

/** Terminates the worker; everything waiting on it fails with [err]. */
function killWorker(err) {
  const w = worker;
  worker = null;
  modelInfo = null;
  gen++;
  if (w) try { w.terminate(); } catch (_) {}
  for (const p of pending.values()) { clearTimeout(p.timer); p.reject(err); }
  pending.clear();
  if (loadJob) { clearTimeout(loadJob.timer); loadJob.reject(err); loadJob = null; }
}

function ensureWorker() {
  if (worker) return worker;
  if (typeof Worker === 'undefined') throw fail('unsupported', 'no Worker');
  // A blob worker that imports worker.js: a blob worker inherits the page's
  // cross-origin isolation (/tutor/), whereas a worker script served
  // without a COEP header of its own is refused in an isolated page.
  const src = new URL('./worker.js?v=3', import.meta.url).href;
  let w;
  try {
    const blob = new Blob([`import ${JSON.stringify(src)};`], { type: 'text/javascript' });
    w = new Worker(URL.createObjectURL(blob), { type: 'module' });
  } catch (_) {
    w = new Worker(src, { type: 'module' });
  }
  const my = ++gen;
  worker = w;
  w.onmessage = (ev) => {
    if (my !== gen) return;
    const m = ev.data || {};
    if (m.type === 'progress') {
      armLoadTimer();
      if (progressCb) try { progressCb(m.loaded, m.total); } catch (_) {}
    } else if (m.type === 'stage') {
      diagState.stage = m.stage + (m.kind ? ':' + m.kind : '');
      armLoadTimer();
    } else if (m.type === 'ready') {
      modelInfo = {
        device: m.device, backend: m.backend || '', dtype: m.dtype, ms: m.ms, warmMs: m.warmMs || 0,
        threads: m.threads || 0, isolated: !!m.isolated, cached: !!m.cached, safe: !!m.safe,
      };
      diagState.stage = 'ready';
      if (m.gpuFailed) {
        // WebGPU failed its self-test here: never offer it on this device again.
        diagState.gpuFailed = m.gpuFailed;
        lsSet(NOGPU_KEY, String(Date.now()));
      }
      if (loadJob) { clearTimeout(loadJob.timer); loadJob.resolve(modelInfo); loadJob = null; }
    } else if (m.type === 'result') {
      const p = pending.get(m.id);
      if (p) {
        pending.delete(m.id);
        clearTimeout(p.timer);
        p.resolve(m);
      }
    } else if (m.type === 'error') {
      const err = fail(m.code || 'failed', m.message);
      if (m.id != null && pending.has(m.id)) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        clearTimeout(p.timer);
        p.reject(err);
      } else if (loadJob) { clearTimeout(loadJob.timer); loadJob.reject(err); loadJob = null; }
    }
  };
  w.onerror = (e) => {
    // The module couldn't be fetched (offline / CDN blocked), or an
    // uncaught error killed the worker's script.
    try { e.preventDefault(); } catch (_) {}
    if (my !== gen) return;
    const msg = (e && e.message) || 'worker failed';
    killWorker(fail(modelInfo || /memory|OOM/i.test(msg) ? 'crashed' : 'network', msg));
  };
  w.onmessageerror = () => {
    if (my !== gen) return;
    killWorker(fail('crashed', 'messageerror (a message from the speech worker could not be read)'));
  };
  return w;
}

function armLoadTimer() {
  if (!loadJob) return;
  clearTimeout(loadJob.timer);
  const job = loadJob;
  const armed = performance.now();
  const fire = () => {
    if (loadJob !== job) return;
    // Background tabs are throttled; don't call that a hang (up to a point).
    if (document.hidden && performance.now() - armed < 3 * LOAD_STALL_MS) { job.timer = setTimeout(fire, 15000); return; }
    killWorker(fail('timeout', `model load stalled at «${diagState.stage || 'download'}» for ${LOAD_STALL_MS / 1000} s`));
  };
  job.timer = setTimeout(fire, LOAD_STALL_MS);
}

function startLoad() {
  if (modelInfo && worker) return Promise.resolve(modelInfo);
  if (loadJob) return loadJob.promise;
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  loadJob = { promise, resolve, reject, timer: 0 };
  diagState.stage = 'download';
  armLoadTimer();
  try {
    ensureWorker().postMessage({
      type: 'load',
      prefer: safe ? 'wasm' : wanted.prefer || 'auto',
      threads: safe ? 1 : wanted.threads || 0,
      nogpu: !!lsGet(NOGPU_KEY),
      safe,
      sim: simFlag(),
    });
  } catch (e) {
    const err = e.code ? e : fail('unsupported', String(e));
    killWorker(err);
    return Promise.reject(err);
  }
  return promise;
}

/** Switches to safe mode (remembered on this device for a while) and
 * reloads on a fresh worker. Shared by every request that failed in the
 * same worker generation. */
let recovering = null;
function recover(failedGen) {
  if (recovering) return recovering;
  if (failedGen !== gen && worker && modelInfo) return Promise.resolve(modelInfo); // already recovered
  recovering = (async () => {
    diagState.recoveries++;
    if (lastBackend && lastBackend !== 'wasm' && lastBackend !== 'wasm-q4') lsSet(NOGPU_KEY, String(Date.now()));
    safe = true;
    lsSet(SAFE_KEY, String(Date.now()));
    killWorker(fail('crashed', 'restarting the speech worker'));
    return await startLoad();
  })();
  return recovering.finally(() => { recovering = null; });
}

let lastBackend = '';

export function modelReady() { return !!modelInfo; }

export async function loadModel(onProgress, prefer, threads) {
  progressCb = onProgress || null;
  wanted = { prefer: prefer || 'auto', threads: threads || 0 };
  if (modelInfo && worker) return modelInfo;
  const g = gen + 1;
  try {
    const i = await startLoad();
    lastBackend = i.backend;
    return i;
  } catch (e) {
    noteError('load', e);
    // One retry on a fresh single-threaded worker (files are cached by now,
    // so even a flaky download costs little to retry).
    if (e.code === 'unsupported') throw e;
    try {
      const i = await recover(g);
      lastBackend = i.backend;
      return i;
    } catch (e2) {
      noteError('load-retry', e2);
      throw e2;
    }
  }
}

function expectedMs(seconds, full) {
  const info = modelInfo || {};
  let per = rtf;
  if (!per) per = isMobile() ? (info.threads > 1 ? 1500 : 2500) : 800;
  if (full) per *= 1.6;
  return 2000 + Math.max(1, seconds) * per;
}

/** One request to the current worker, with a watchdog. */
async function attempt(audio, rate, o) {
  const seconds = audio.length / (rate || 16000);
  const info = await startLoad();
  lastBackend = info.backend;
  const myGen = gen;
  return new Promise((resolve, rejectRaw) => {
    // Errors carry the worker generation they happened in (see recover()).
    const reject = (e) => { try { e.gen = myGen; } catch (_) {} rejectRaw(e); };
    if (!worker) { reject(fail('crashed', 'speech worker gone')); return; }
    const id = ++seq;
    const limit = Math.max(MIN_WATCHDOG_MS, 4 * expectedMs(seconds, !!o.full));
    const p = { resolve, reject, timer: 0 };
    const started = performance.now();
    const fire = () => {
      if (!pending.has(id)) return;
      // A hidden page (screen locked, app switched) runs slower: give it
      // more time, but not forever.
      if (document.hidden && performance.now() - started < 3 * limit) { p.timer = setTimeout(fire, 15000); return; }
      // The worker is blocked or dead: nothing else will ever answer.
      killWorker(fail('timeout', `no result after ${Math.round(limit / 1000)} s (${seconds.toFixed(1)} s of audio, ${info.backend} ×${info.threads})`));
    };
    p.timer = setTimeout(fire, limit);
    pending.set(id, p);
    try {
      worker.postMessage({ type: 'transcribe', id, audio, rate, words: o.words || 0, full: !!o.full }, [audio.buffer]);
    } catch (e) {
      clearTimeout(p.timer);
      pending.delete(id);
      reject(e.code ? e : fail('failed', String(e)));
    }
  });
}

function shape(m, extra) {
  const r = {
    text: m.text || '', ms: m.ms || 0, seconds: m.seconds || 0, frames: m.frames || 0, tokens: m.tokens || 0,
    retried: !!m.retried, encMs: m.encMs || 0, decMs: m.decMs || 0, featMs: m.featMs || 0, prepMs: m.prepMs || 0,
    backend: modelInfo ? modelInfo.backend : '', threads: modelInfo ? modelInfo.threads : 0,
    ...extra,
  };
  diagState.last = { ...r, text: undefined };
  return r;
}

/** opts: {words: expected word count (bounds the decoder), full: force the
 * classic 30 s window}. The samples are transferred, not copied (a copy is
 * kept for the one retry). */
export async function transcribe(audio, rate, opts) {
  const o = opts || {};
  if (!audio || !audio.length) throw fail('decode', 'empty recording');
  const backup = new Float32Array(audio);
  const t0 = performance.now();
  const g = gen;
  let first;
  try {
    const m = await attempt(audio, rate, o);
    if (m.seconds > 1 && m.ms > 0) rtf = rtf ? rtf * 0.6 + (m.ms / m.seconds) * 0.4 : m.ms / m.seconds;
    return shape(m, { wallMs: Math.round(performance.now() - t0), recovered: '' });
  } catch (e) {
    first = e;
    noteError('transcribe', e);
    if (e.code === 'unsupported') throw e;
  }
  // Retry once on a fresh worker in safe mode with the full window.
  try {
    await recover(first.gen != null ? first.gen : g);
    const m = await attempt(backup, rate, { ...o, full: true });
    return shape(m, { wallMs: Math.round(performance.now() - t0), recovered: first.code || 'failed' });
  } catch (e) {
    noteError('transcribe-retry', e);
    throw fail(e.code || first.code || 'failed', `${first.code}: ${first.message} → retry ${e.code || ''}: ${e.message}`);
  }
}

/** Everything support needs to see why it failed on a phone (JSON). */
export function diag() {
  const nav = navigator;
  return JSON.stringify({
    model: modelInfo,
    backend: lastBackend,
    safe,
    nogpu: !!lsGet(NOGPU_KEY),
    stage: diagState.stage,
    gpuFailed: diagState.gpuFailed,
    recoveries: diagState.recoveries,
    rtf: Math.round(rtf),
    errors: diagState.errors,
    last: diagState.last,
    rec: lastRec,
    isolated: window.crossOriginIsolated === true,
    cores: nav.hardwareConcurrency || 0,
    memory: nav.deviceMemory || 0,
    webgpu: !!nav.gpu,
    ua: nav.userAgent,
  });
}

/** Forgets safe mode / the WebGPU ban on this device (debug panel). */
export function resetDevice() {
  try { localStorage.removeItem(SAFE_KEY); localStorage.removeItem(NOGPU_KEY); } catch (_) {}
  safe = false;
}

export async function storage() {
  try {
    if (!navigator.storage || !navigator.storage.estimate) return null;
    const e = await navigator.storage.estimate();
    return { quota: e.quota || 0, usage: e.usage || 0 };
  } catch (_) {
    return null;
  }
}

export async function persist() {
  try { return navigator.storage && navigator.storage.persist ? await navigator.storage.persist() : false; } catch (_) { return false; }
}

export async function isCached() {
  try {
    const c = await caches.open('transformers-cache');
    const keys = await c.keys();
    return keys.some((k) => k.url.includes('Basira') && k.url.includes('decoder_model_merged'));
  } catch (_) {
    return false;
  }
}

// ------------------------------------------------------------ microphone
let rec = null;
let micCtx = null;

// One AudioContext for all recordings: iOS only lets it start inside a
// tap, so it is created/resumed on the first «سمّع» and then reused (the
// review mode starts the next ayah's recording without a new gesture).
function micContext() {
  if (!micCtx || micCtx.state === 'closed') micCtx = newContext();
  try { if (micCtx.state !== 'running') micCtx.resume(); } catch (_) {}
  return micCtx;
}

function newContext() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) throw fail('unsupported', 'no AudioContext');
  return new AC();
}

function mono(buffer) {
  const n = buffer.length, ch = buffer.numberOfChannels;
  if (ch === 1) return new Float32Array(buffer.getChannelData(0));
  const out = new Float32Array(n);
  for (let c = 0; c < ch; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += d[i] / ch;
  }
  return out;
}

/** decodeAudioData, both forms (old Safari only has callbacks), with a
 * timeout — some iOS versions never call back on a bad file. */
function decode(ctx, ab, ms) {
  return new Promise((resolve, reject) => {
    let done = false;
    const t = setTimeout(() => ko(new Error('decodeAudioData timed out')), ms || 10000);
    function ok(b) { if (!done) { done = true; clearTimeout(t); resolve(b); } }
    function ko(e) { if (!done) { done = true; clearTimeout(t); reject(e || new Error('decodeAudioData failed')); } }
    try {
      const p = ctx.decodeAudioData(ab, ok, ko);
      if (p && p.then) p.then(ok, ko);
    } catch (e) {
      ko(e);
    }
  });
}

function peakOf(a) {
  let p = 0;
  for (let i = 0; i < a.length; i++) { const v = a[i] < 0 ? -a[i] : a[i]; if (v > p) p = v; }
  return p;
}

/**
 * Starts recording. Must be called from a tap (iOS needs the AudioContext
 * created inside the gesture). opts: {maxMs, autoStop, minMs, onLevel(level
 * 0..1), onAutoStop(reason)}. Auto-stop: 0.8 s of silence once the
 * recitation has gone on for minMs (the ayah's shortest plausible length),
 * 1.6 s before that (a breath between words mustn't end it).
 *
 * Two captures run side by side: raw PCM from a ScriptProcessor (no
 * decoding needed — the usual source) and, where available, a MediaRecorder
 * file (audio/webm;codecs=opus on Android, audio/mp4 on iOS) used only when
 * the PCM came out empty, silent or cut short (an AudioContext that stayed
 * suspended / was interrupted on iOS delivers no PCM at all).
 */
export async function startRecording(opts) {
  cancelRecording();
  const o = opts || {};
  if (!window.isSecureContext) throw fail('insecure', 'needs https');
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw fail('unsupported', 'no getUserMedia');
  const ctx = micContext(); // inside the gesture
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (e) {
    const n = e && e.name;
    if (n === 'NotAllowedError' || n === 'SecurityError' || n === 'PermissionDeniedError') throw fail('mic_denied', String(e));
    if (n === 'NotFoundError' || n === 'DevicesNotFoundError' || n === 'OverconstrainedError') throw fail('no_mic', String(e));
    if (n === 'NotReadableError' || n === 'AbortError') throw fail('mic_busy', String(e));
    throw fail('mic_failed', String(e));
  }
  try { if (ctx.state !== 'running') await Promise.race([ctx.resume(), new Promise((r) => setTimeout(r, 1500))]); } catch (_) {}

  const r = {
    ctx, stream, chunks: [], pcm: [], pcmRate: ctx.sampleRate, timers: [], stopped: false, recorder: null, mime: '',
    startedAt: performance.now(), ctxState: ctx.state,
  };
  rec = r;
  const src = ctx.createMediaStreamSource(stream);
  r.src = src;
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  src.connect(analyser);

  if (ctx.createScriptProcessor) {
    try {
      const proc = ctx.createScriptProcessor(4096, 1, 1);
      const mute = ctx.createGain();
      mute.gain.value = 0;
      proc.onaudioprocess = (ev) => { if (!r.stopped) r.pcm.push(new Float32Array(ev.inputBuffer.getChannelData(0))); };
      src.connect(proc);
      proc.connect(mute);
      mute.connect(ctx.destination);
      r.proc = proc;
    } catch (_) {}
  }
  if (typeof MediaRecorder !== 'undefined') {
    try {
      const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/aac', 'audio/ogg;codecs=opus'];
      r.mime = types.find((t) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) || '';
      const mr = new MediaRecorder(stream, r.mime ? { mimeType: r.mime } : undefined);
      mr.ondataavailable = (e) => { if (e.data && e.data.size) r.chunks.push(e.data); };
      mr.start(1000);
      r.recorder = mr;
      if (!r.mime) r.mime = mr.mimeType || '';
    } catch (_) {}
  }
  if (!r.proc && !r.recorder) {
    cancelRecording();
    throw fail('unsupported', 'no recorder');
  }

  // Level meter + optional stop after a short silence once speech began.
  const buf = new Float32Array(analyser.fftSize);
  let noise = 0.005, spoke = false, quietFor = 0, t = 0, spokeAt = 0;
  const minMs = Math.max(0, o.minMs || 0);
  r.timers.push(setInterval(() => {
    analyser.getFloatTimeDomainData(buf);
    let s = 0;
    for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
    const rms = Math.sqrt(s / buf.length);
    t += 100;
    if (t <= 400) noise = Math.max(noise, rms);
    const loud = rms > Math.max(0.015, noise * 2.5);
    if (loud) { if (!spoke) spokeAt = t; spoke = true; quietFor = 0; } else quietFor += 100;
    const quietNeeded = t - spokeAt - quietFor >= minMs ? 800 : 1600;
    if (o.onLevel) try { o.onLevel(Math.min(1, rms * 6)); } catch (_) {}
    if (o.autoStop && spoke && quietFor >= quietNeeded && t > 1200 && !r.autoFired) {
      r.autoFired = true;
      if (o.onAutoStop) try { o.onAutoStop('silence'); } catch (_) {}
    }
  }, 100));
  r.timers.push(setTimeout(() => {
    if (!r.autoFired && o.onAutoStop) { r.autoFired = true; try { o.onAutoStop('max'); } catch (_) {} }
  }, o.maxMs || 25000));
  return { mime: r.mime || 'pcm', rate: ctx.sampleRate };
}

function release(r) {
  r.stopped = true;
  for (const t of r.timers) { clearInterval(t); clearTimeout(t); }
  try { r.stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
  try { if (r.proc) r.proc.disconnect(); } catch (_) {}
  try { r.src.disconnect(); } catch (_) {}
}

/** Stops and returns {audio: Float32Array (mono), rate, seconds, source,
 * peak, stopMs}. */
export async function stopRecording() {
  const r = rec;
  rec = null;
  if (!r) throw fail('no_recording', 'not recording');
  const t0 = performance.now();
  const wall = (t0 - r.startedAt) / 1000;
  // Ask the recorder for its file first (before the tracks stop); its
  // onstop may never fire on some browsers, hence the timeout.
  let recDone = Promise.resolve();
  if (r.recorder && r.recorder.state !== 'inactive') {
    recDone = new Promise((res) => {
      r.recorder.onstop = res;
      r.recorder.onerror = res;
      setTimeout(res, 2500);
    });
    try { r.recorder.stop(); } catch (_) {}
  }
  release(r);
  const info = { source: 'pcm', ctxRate: r.pcmRate, ctxState: r.ctxState + '→' + r.ctx.state, wall: +wall.toFixed(2), mime: r.mime || '', blocks: r.pcm.length };
  try {
    const n = r.pcm.reduce((a, c) => a + c.length, 0);
    let audio = new Float32Array(n);
    let o = 0;
    for (const c of r.pcm) { audio.set(c, o); o += c.length; }
    let rate = r.pcmRate;
    let peak = peakOf(audio);
    info.pcmSeconds = +(n / rate).toFixed(2);
    info.pcmPeak = +peak.toFixed(4);
    // PCM missing, digitally silent (a dead capture — a real mic always
    // has some noise) or much shorter than the recording: use the file.
    const bad = n === 0 || peak < 1e-4 || (wall > 2 && n / rate < wall * 0.6);
    if (bad && r.recorder) {
      await recDone;
      if (r.chunks.length) {
        const d0 = performance.now();
        try {
          const blob = new Blob(r.chunks, { type: r.mime || 'audio/webm' });
          const decoded = await decode(r.ctx, await blob.arrayBuffer());
          const alt = mono(decoded);
          const altPeak = peakOf(alt);
          info.fileSeconds = +(alt.length / decoded.sampleRate).toFixed(2);
          info.filePeak = +altPeak.toFixed(4);
          if (alt.length > n || altPeak > peak) {
            audio = alt;
            rate = decoded.sampleRate;
            peak = altPeak;
            info.source = 'file';
          }
        } catch (e) {
          info.fileError = String(e).slice(0, 160);
        }
        info.decodeMs = Math.round(performance.now() - d0);
      }
    }
    info.stopMs = Math.round(performance.now() - t0);
    info.seconds = +(audio.length / rate).toFixed(2);
    lastRec = info;
    if (!audio.length) throw new Error('no audio captured (' + JSON.stringify(info) + ')');
    return { audio, rate, seconds: audio.length / rate, source: info.source, peak, stopMs: info.stopMs };
  } catch (e) {
    lastRec = info;
    throw fail('decode', String((e && e.message) || e));
  }
}

export function cancelRecording() {
  const r = rec;
  rec = null;
  if (!r) return;
  try { if (r.recorder && r.recorder.state !== 'inactive') r.recorder.stop(); } catch (_) {}
  release(r);
}

export function recording() { return !!rec; }

/** Debug: fetch an mp3 (e.g. everyayah), decode it and transcribe it. */
export async function transcribeUrl(url, opts) {
  const ab = await (await fetch(url)).arrayBuffer();
  const ctx = newContext();
  try {
    const decoded = await decode(ctx, ab);
    const audio = mono(decoded);
    const t0 = performance.now();
    const out = await transcribe(audio, decoded.sampleRate, opts);
    return { ...out, total: Math.round(performance.now() - t0), seconds: decoded.duration };
  } finally {
    try { ctx.close(); } catch (_) {}
  }
}

// ------------------------------------------------------------ reciter
let player = null;
let playToken = 0;

/** Plays the urls in order, the whole list [repeat] times. Resolves when
 * finished (true) or stopped/failed (false). Call from a tap. */
export function play(urls, repeat, gapMs) {
  stopPlayback();
  const token = ++playToken;
  if (!player) { player = new Audio(); player.preload = 'auto'; }
  const a = player;
  const list = [];
  for (let k = 0; k < Math.max(1, repeat || 1); k++) list.push(...urls);
  return new Promise((resolve) => {
    let i = 0;
    const next = () => {
      if (token !== playToken) return resolve(false);
      if (i >= list.length) return resolve(true);
      a.src = list[i++];
      const p = a.play();
      if (p && p.catch) p.catch(() => { if (token === playToken) { playToken++; resolve(false); } });
    };
    a.onended = () => { if (token === playToken) setTimeout(next, gapMs || 350); };
    a.onerror = () => { if (token === playToken) { playToken++; resolve(false); } };
    next();
  });
}

export function stopPlayback() {
  playToken++;
  if (player) { try { player.pause(); } catch (_) {} }
}

const prefetched = new Set();
export function prefetch(url) {
  if (prefetched.has(url) || prefetched.size > 40) return;
  prefetched.add(url);
  try { fetch(url, { mode: 'cors' }).catch(() => {}); } catch (_) {}
}
