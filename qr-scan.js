// Camera QR scanning for the guard console (lib/core/guard/qr_scan_web.dart).
// Opens a full-screen camera view on top of the app and resolves with the
// first QR code it reads, '' when the guard cancels, or 'ERR:<name>' when
// the camera can't be used. Uses the browser's own BarcodeDetector where it
// reads QR codes (Chrome on Android / macOS); elsewhere (iOS Safari, Windows,
// Firefox) the small jsQR decoder (~130 KB) is loaded only on first use.
(function () {
  var JSQR = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js';
  var jsqrLoading = null;

  function loadJsQR() {
    if (window.jsQR) return Promise.resolve();
    if (!jsqrLoading) {
      jsqrLoading = new Promise(function (resolve, reject) {
        var s = document.createElement('script');
        s.src = JSQR;
        s.onload = function () { resolve(); };
        s.onerror = function () { jsqrLoading = null; reject({ name: 'decoder-load-failed' }); };
        document.head.appendChild(s);
      });
    }
    return jsqrLoading;
  }

  function nativeDetector() {
    if (!('BarcodeDetector' in window)) return Promise.resolve(null);
    var formats = window.BarcodeDetector.getSupportedFormats ? window.BarcodeDetector.getSupportedFormats() : Promise.resolve(['qr_code']);
    return formats.then(function (list) {
      if (list.indexOf('qr_code') < 0) return null;
      return new window.BarcodeDetector({ formats: ['qr_code'] });
    }).catch(function () { return null; });
  }

  function el(tag, css, text) {
    var e = document.createElement(tag);
    e.style.cssText = css;
    if (text) e.textContent = text;
    return e;
  }

  window.mogtama3yCanScanQr = function () {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.isSecureContext !== false);
  };

  // hint / cancelLabel come from the app (Arabic copy lives in Dart).
  window.mogtama3yQrScan = function (hint, cancelLabel) {
    return new Promise(function (resolve) {
      if (!window.mogtama3yCanScanQr()) { resolve('ERR:unsupported'); return; }

      var overlay = el('div', 'position:fixed;inset:0;z-index:2147483647;background:#000;display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:system-ui,sans-serif;direction:rtl');
      var video = el('video', 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover');
      video.setAttribute('playsinline', '');
      video.setAttribute('muted', '');
      video.muted = true;
      var frame = el('div', 'position:relative;width:min(70vw,300px);height:min(70vw,300px);border:3px solid #F2B661;border-radius:22px;box-shadow:0 0 0 9999px rgba(0,0,0,.45)');
      var label = el('div', 'position:relative;margin-top:22px;color:#fff;font-size:16px;font-weight:700;text-align:center;padding:0 24px', hint || '');
      var cancel = el('button', 'position:absolute;bottom:32px;left:50%;transform:translateX(-50%);background:#fff;color:#0B1530;border:0;border-radius:14px;padding:13px 26px;font-size:15px;font-weight:700;cursor:pointer', cancelLabel || 'X');
      overlay.appendChild(video);
      overlay.appendChild(frame);
      overlay.appendChild(label);
      overlay.appendChild(cancel);
      document.body.appendChild(overlay);

      var stream = null;
      var done = false;
      var timer = null;

      function finish(result) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        resolve(result);
      }
      cancel.onclick = function () { finish(''); };

      function makeDecoder() {
        return nativeDetector().then(function (det) {
          if (det) {
            return function () {
              return det.detect(video).then(function (codes) { return codes.length ? codes[0].rawValue : null; });
            };
          }
          return loadJsQR().then(function () {
            var canvas = document.createElement('canvas');
            var ctx = canvas.getContext('2d', { willReadFrequently: true });
            return function () {
              var w = video.videoWidth, h = video.videoHeight;
              if (!w || !h) return Promise.resolve(null);
              var scale = Math.min(1, 720 / Math.max(w, h));
              canvas.width = Math.round(w * scale);
              canvas.height = Math.round(h * scale);
              ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
              var img = ctx.getImageData(0, 0, canvas.width, canvas.height);
              var r = window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
              return Promise.resolve(r && r.data ? r.data : null);
            };
          });
        });
      }

      function loop(decode) {
        if (done) return;
        decode().then(function (value) {
          if (value) finish(String(value));
          else timer = setTimeout(function () { loop(decode); }, 180);
        }).catch(function () {
          timer = setTimeout(function () { loop(decode); }, 300);
        });
      }

      navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
        .then(function (s) {
          stream = s;
          if (done) { s.getTracks().forEach(function (t) { t.stop(); }); return null; }
          video.srcObject = s;
          return video.play();
        })
        .then(function () { return done ? null : makeDecoder(); })
        .then(function (decode) { if (decode) loop(decode); })
        .catch(function (e) { finish('ERR:' + ((e && e.name) || 'camera')); });
    });
  };
})();
