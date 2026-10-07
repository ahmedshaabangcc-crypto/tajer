// Saving / printing an image the app drew (lib/core/shops/print_card_web.dart),
// e.g. the shop's A5 QR card in متجري. Called synchronously from the button
// tap, so the print window is not blocked as a pop-up.
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
