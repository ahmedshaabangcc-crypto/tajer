// Saving / printing an image the app drew (lib/core/shops/print_card_web.dart),
// e.g. the shop's A5 QR card in متجري — plus متجري's orders CSV download,
// invoice / packing-slip printing and the new-order chime. Called
// synchronously from the button tap, so the print window is not blocked as
// a pop-up.
(function () {
  function clean(s) { return String(s || '').replace(/[<>&"]/g, ''); }

  window.mogtama3yDownloadImage = function (dataUrl, filename) {
    try {
      var a = document.createElement('a');
      a.href = dataUrl;
      a.download = clean(filename) || 'image.png';
      document.body.appendChild(a);
      a.click();
      a.parentNode.removeChild(a);
      return true;
    } catch (e) {
      return false;
    }
  };

  // Saves text (e.g. the orders CSV of متجري) as a file.
  window.mogtama3yDownloadText = function (text, filename, mime) {
    try {
      var blob = new Blob([String(text)], { type: clean(mime) || 'text/plain;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = clean(filename) || 'file.txt';
      document.body.appendChild(a);
      a.click();
      a.parentNode.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
      return true;
    } catch (e) {
      return false;
    }
  };

  // Prints a whole HTML document the app built (invoices / packing slips
  // of متجري — every value in it is escaped by the app). Waits for its
  // images (shop logo, product photos) before printing.
  window.mogtama3yPrintHtml = function (html, title) {
    function fill(doc, win, after) {
      doc.open();
      doc.write(String(html));
      doc.close();
      try { doc.title = clean(title); } catch (e) {}
      var imgs = Array.prototype.slice.call(doc.images || []);
      var left = imgs.length, done = false;
      function go() {
        if (done) return;
        done = true;
        setTimeout(function () { win.focus(); win.print(); if (after) after(); }, 250);
      }
      if (!left) return go();
      imgs.forEach(function (img) {
        if (img.complete) { if (--left === 0) go(); return; }
        img.onload = img.onerror = function () { if (--left === 0) go(); };
      });
      setTimeout(go, 4000); // a slow photo never blocks printing
    }
    try {
      var w = window.open('', '_blank');
      if (w) { fill(w.document, w); return true; }
      var f = document.createElement('iframe');
      f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
      document.body.appendChild(f);
      fill(f.contentWindow.document, f.contentWindow, function () {
        setTimeout(function () { if (f.parentNode) f.parentNode.removeChild(f); }, 60000);
      });
      return true;
    } catch (e) {
      return false;
    }
  };

  // A short two-note chime for a new order (Web Audio, no sound file).
  var audioCtx = null;
  window.mogtama3yChime = function () {
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      audioCtx = audioCtx || new AC();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      var t = audioCtx.currentTime;
      [[880, 0], [1318.5, 0.16]].forEach(function (n) {
        var o = audioCtx.createOscillator(), g = audioCtx.createGain();
        o.type = 'sine';
        o.frequency.value = n[0];
        g.gain.setValueAtTime(0.0001, t + n[1]);
        g.gain.exponentialRampToValueAtTime(0.25, t + n[1] + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + n[1] + 0.45);
        o.connect(g);
        g.connect(audioCtx.destination);
        o.start(t + n[1]);
        o.stop(t + n[1] + 0.5);
      });
      return true;
    } catch (e) {
      return false;
    }
  };

  // Prints the image alone on an A5 portrait page.
  window.mogtama3yPrintA5 = function (dataUrl, title) {
    var html = '<!doctype html><html dir="rtl"><head><meta charset="utf-8"><title>' + clean(title) + '</title>' +
      '<style>@page{size:A5 portrait;margin:0}html,body{margin:0;padding:0;background:#fff}' +
      'img{display:block;width:148mm;height:209mm;object-fit:contain;margin:0 auto}' +
      '@media screen{body{padding:16px;background:#eee}img{width:min(148mm,92vw);height:auto;box-shadow:0 2px 14px rgba(0,0,0,.2)}}</style></head>' +
      '<body><img id="card" alt=""></body></html>';
    function fill(doc, win, after) {
      doc.open();
      doc.write(html);
      doc.close();
      var img = doc.getElementById('card');
      img.onload = function () { setTimeout(function () { win.focus(); win.print(); if (after) after(); }, 300); };
      img.src = dataUrl;
    }
    try {
      var w = window.open('', '_blank');
      if (w) { fill(w.document, w); return true; }
      // Pop-ups blocked: print from a hidden frame instead.
      var f = document.createElement('iframe');
      f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
      document.body.appendChild(f);
      fill(f.contentWindow.document, f.contentWindow, function () {
        setTimeout(function () { if (f.parentNode) f.parentNode.removeChild(f); }, 60000);
      });
      return true;
    } catch (e) {
      return false;
    }
  };
})();
