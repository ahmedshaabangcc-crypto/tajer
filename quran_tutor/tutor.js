// «المحفّظ» — page-side helper (ES module, imported by the Dart tutor
// screen only when it opens). Owns the speech worker, the microphone and
// the reciter audio; the Dart side only calls these functions.

let worker = null;
let seq = 0;
const pending = new Map();
let loadWaiters = null;
let progressCb = null;
let modelInfo = null;

const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

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
  };
}

function fail(code, message) {
  const e = new Error(message || code);
  e.code = code;
  return e;
}

function rejectAll(err) {
  for (const p of pending.values()) p.reject(err);
  pending.clear();
  if (loadWaiters) { loadWaiters.reject(err); loadWaiters = null; }
}

function ensureWorker() {
  if (worker) return worker;
  if (typeof Worker === 'undefined') throw fail('unsupported', 'no Worker');
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (ev) => {
    const m = ev.data || {};
    if (m.type === 'progress') {
      if (progressCb) try { progressCb(m.loaded, m.total); } catch (_) {}
    } else if (m.type === 'ready') {
      modelInfo = { device: m.device, dtype: m.dtype, ms: m.ms, cached: !!m.cached };
      if (loadWaiters) { loadWaiters.resolve(modelInfo); loadWaiters = null; }
    } else if (m.type === 'result') {
      const p = pending.get(m.id);
      if (p) { pending.delete(m.id); p.resolve({ text: m.text || '', ms: m.ms || 0, seconds: m.seconds || 0 }); }
    } else if (m.type === 'error') {
      const err = fail(m.code || 'failed', m.message);
      if (m.id != null && pending.has(m.id)) { pending.get(m.id).reject(err); pending.delete(m.id); }
      else if (loadWaiters) { loadWaiters.reject(err); loadWaiters = null; }
    }
  };
  worker.onerror = (e) => {
    // Typically: the module could not be fetched (offline / CDN blocked).
    try { e.preventDefault(); } catch (_) {}
    const err = fail('network', (e && e.message) || 'worker failed');
    worker = null;
    rejectAll(err);
  };
  return worker;
}

export function modelReady() { return !!modelInfo; }

export function loadModel(onProgress, prefer) {
  progressCb = onProgress || null;
  if (modelInfo) return Promise.resolve(modelInfo);
  if (loadWaiters) return loadWaiters.promise;
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  loadWaiters = { promise, resolve, reject };
  try {
    ensureWorker().postMessage({ type: 'load', prefer: prefer || 'auto' });
  } catch (e) {
    loadWaiters = null;
    return Promise.reject(e.code ? e : fail('unsupported', String(e)));
  }
  return promise;
}

export function transcribe(audio, rate) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    try {
      ensureWorker().postMessage({ type: 'transcribe', id, audio, rate }, [audio.buffer]);
    } catch (e) {
      pending.delete(id);
      reject(e.code ? e : fail('failed', String(e)));
    }
  });
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
  try { if (micCtx.state === 'suspended') micCtx.resume(); } catch (_) {}
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

function decode(ctx, ab) {
  return new Promise((resolve, reject) => {
    // Old Safari only has the callback form.
    const p = ctx.decodeAudioData(ab, resolve, reject);
    if (p && p.then) p.then(resolve, reject);
  });
}

/**
 * Starts recording. Must be called from a tap (iOS needs the AudioContext
 * created inside the gesture). opts: {maxMs, autoStop, onLevel(level 0..1),
 * onAutoStop(reason)}.
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
  try { if (ctx.state === 'suspended') await ctx.resume(); } catch (_) {}

  const r = { ctx, stream, chunks: [], pcm: [], pcmRate: ctx.sampleRate, timers: [], stopped: false, recorder: null, mime: '' };
  rec = r;
  const src = ctx.createMediaStreamSource(stream);
  r.src = src;
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  src.connect(analyser);

  // Raw PCM capture (no decoding needed afterwards — the most reliable path,
  // also on iOS). MediaRecorder is the fallback.
  if (ctx.createScriptProcessor) {
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    const mute = ctx.createGain();
    mute.gain.value = 0;
    proc.onaudioprocess = (ev) => { if (!r.stopped) r.pcm.push(new Float32Array(ev.inputBuffer.getChannelData(0))); };
    src.connect(proc);
    proc.connect(mute);
    mute.connect(ctx.destination);
    r.proc = proc;
  } else if (typeof MediaRecorder !== 'undefined') {
    const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/aac', 'audio/ogg;codecs=opus'];
    r.mime = types.find((t) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) || '';
    const mr = new MediaRecorder(stream, r.mime ? { mimeType: r.mime } : undefined);
    mr.ondataavailable = (e) => { if (e.data && e.data.size) r.chunks.push(e.data); };
    mr.start(250);
    r.recorder = mr;
  } else {
    cancelRecording();
    throw fail('unsupported', 'no recorder');
  }

  // Level meter + optional stop after ~1.6 s of silence once speech began.
  const buf = new Float32Array(analyser.fftSize);
  let noise = 0.005, spoke = false, quietFor = 0, t = 0;
  r.timers.push(setInterval(() => {
    analyser.getFloatTimeDomainData(buf);
    let s = 0;
    for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
    const rms = Math.sqrt(s / buf.length);
    t += 100;
    if (t <= 400) noise = Math.max(noise, rms);
    const loud = rms > Math.max(0.015, noise * 2.5);
    if (loud) { spoke = true; quietFor = 0; } else quietFor += 100;
    if (o.onLevel) try { o.onLevel(Math.min(1, rms * 6)); } catch (_) {}
    if (o.autoStop && spoke && quietFor >= 1600 && t > 1500 && !r.autoFired) {
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

/** Stops and returns {audio: Float32Array (mono), rate, seconds}. */
export async function stopRecording() {
  const r = rec;
  rec = null;
  if (!r) throw fail('no_recording', 'not recording');
  if (r.recorder) {
    const done = new Promise((res) => { r.recorder.onstop = res; });
    try { r.recorder.stop(); } catch (_) {}
    await done;
  }
  release(r);
  try {
    let audio, rate;
    if (r.recorder) {
      const blob = new Blob(r.chunks, { type: r.mime || 'audio/webm' });
      const decoded = await decode(r.ctx, await blob.arrayBuffer());
      audio = mono(decoded);
      rate = decoded.sampleRate;
    } else {
      const n = r.pcm.reduce((a, c) => a + c.length, 0);
      audio = new Float32Array(n);
      let o = 0;
      for (const c of r.pcm) { audio.set(c, o); o += c.length; }
      rate = r.pcmRate;
    }
    return { audio, rate, seconds: audio.length / rate };
  } catch (e) {
    throw fail('decode', String(e));
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
export async function transcribeUrl(url) {
  const ab = await (await fetch(url)).arrayBuffer();
  const ctx = newContext();
  try {
    const decoded = await decode(ctx, ab);
    const audio = mono(decoded);
    const t0 = performance.now();
    const out = await transcribe(audio, decoded.sampleRate);
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
