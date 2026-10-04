/*
 * store-lite.js — صفحة متجر خفيفة لروابط mogtama3y.com/#/s/<slug>
 *
 * المشكلة: الزبون اللي بيمسح QR المحل كان بيستنى تحميل تطبيق Flutter كله
 * (عدة ميجا) قبل ما يشوف أي منتج. الملف ده بيعرض المحل ومنتجاته في الحال
 * من Supabase REST مباشرة (HTML + JS عادي، بدون مكتبات)، وتطبيق Flutter
 * بيكمّل تحميله في الخلفية تحت الصفحة دي.
 *
 * - "اطلب من مُجتمعي" بيقفل الطبقة دي ويكشف صفحة المتجر في Flutter (نفس
 *   الرابط) عشان التسجيل والسلة والطلب. لو Flutter لسه بيحمّل، الزرار
 *   بيستنى أول frame وبعدين يكشفها.
 * - "كلّم المحل واتساب" بيفتح واتساب المحل على طول.
 * - بيسجّل زيارة واحدة (record_shop_scan) ويحط
 *   window.__mogtama3yScanRecorded = true عشان Flutter مايعدّش تاني.
 * - لو المحل مش موجود أو حصل خطأ في الشبكة، الطبقة بتختفي وFlutter يتصرف.
 *
 * التركيب: <script src="store-lite.js"></script> في index.html بعد div#splash
 * وقبل flutter_bootstrap.js (من غير async، الملف صغير ومش بيعطّل حاجة).
 */
(function () {
  'use strict';

  var m = /^#\/s\/([a-z0-9-]{3,40})\/?(?:[?#].*)?$/i.exec(location.hash || '');
  if (!m) return;
  var slug = m[1].toLowerCase();

  var SUPABASE_URL = 'https://pxiabifybakbsqlycffc.supabase.co';
  var KEY = 'sb_publishable_3QS4C4PPUUCZuvjUi8Ifmg_EJ44uxhE';
  var HEADERS = { apikey: KEY, Accept: 'application/json' };

  var flutterReady = false;
  var waitingToReveal = false;
  window.addEventListener('flutter-first-frame', function () {
    flutterReady = true;
    if (waitingToReveal) reveal();
  });

  // ---------- styles (ألوان مُجتمعي الجديدة: night / crystal / gold) ----------
  var css = '' +
    '#store-lite{position:fixed;inset:0;z-index:9999;overflow-y:auto;-webkit-overflow-scrolling:touch;' +
    'background:#0B1530;color:#fff;font-family:system-ui,-apple-system,"Segoe UI",Tahoma,sans-serif;direction:rtl;transition:opacity .25s ease}' +
    '#store-lite *{box-sizing:border-box}' +
    '#store-lite .sl-wrap{max-width:640px;margin:0 auto;padding:calc(16px + env(safe-area-inset-top,0px)) 16px calc(110px + env(safe-area-inset-bottom,0px))}' +
    '#store-lite .sl-brand{display:flex;align-items:center;gap:8px;font-size:13px;color:rgba(255,255,255,.65)}' +
    '#store-lite .sl-brand img{width:24px;height:24px;border-radius:7px}' +
    '#store-lite .sl-head{margin-top:14px;padding:18px;border-radius:18px;background:linear-gradient(135deg,#34598F 0%,#15295A 45%,#0A1630 75%,#1E3C72 100%);border:1px solid rgba(255,255,255,.18)}' +
    '#store-lite .sl-cover{width:100%;aspect-ratio:16/7;object-fit:cover;border-radius:12px;margin-bottom:12px;display:block}' +
    '#store-lite h1{margin:0;font-size:24px;line-height:1.35;font-weight:800}' +
    '#store-lite .sl-meta{margin-top:6px;font-size:14px;color:rgba(255,255,255,.72);line-height:1.6}' +
    '#store-lite .sl-cat{display:inline-block;margin-top:10px;font-size:12px;font-weight:700;color:#0B1530;background:#F2B661;border-radius:999px;padding:2px 10px}' +
    '#store-lite h2{font-size:16px;margin:22px 0 10px;color:rgba(255,255,255,.85)}' +
    '#store-lite .sl-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}' +
    '@media (min-width:560px){#store-lite .sl-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}' +
    '#store-lite .sl-p{background:rgba(255,255,255,.10);border:1px solid rgba(255,255,255,.18);border-radius:14px;overflow:hidden;display:flex;flex-direction:column}' +
    '#store-lite .sl-p .sl-img{aspect-ratio:1/1;background:#14244B;display:block;width:100%;object-fit:cover}' +
    '#store-lite .sl-p .sl-ph{aspect-ratio:1/1;background:#14244B;display:flex;align-items:center;justify-content:center;font-size:32px;color:rgba(255,255,255,.35)}' +
    '#store-lite .sl-p .sl-b{padding:10px;display:flex;flex-direction:column;gap:4px;min-width:0}' +
    '#store-lite .sl-p .sl-n{font-size:14px;line-height:1.45;overflow-wrap:anywhere}' +
    '#store-lite .sl-p .sl-pr{font-size:15px;font-weight:800;color:#F2B661;font-variant-numeric:tabular-nums}' +
    '#store-lite .sl-empty{padding:18px;border-radius:14px;background:rgba(255,255,255,.08);color:rgba(255,255,255,.75);font-size:14px;line-height:1.7}' +
    '#store-lite .sl-bar{position:fixed;left:0;right:0;bottom:0;z-index:10000;padding:12px 16px calc(12px + env(safe-area-inset-bottom,0px));' +
    'background:rgba(11,21,48,.92);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border-top:1px solid rgba(255,255,255,.12)}' +
    '#store-lite .sl-bar-in{max-width:640px;margin:0 auto;display:flex;gap:10px}' +
    '#store-lite .sl-btn{flex:1;display:flex;align-items:center;justify-content:center;gap:6px;min-height:48px;border-radius:14px;font:inherit;font-size:15px;font-weight:800;text-decoration:none;cursor:pointer;border:0}' +
    '#store-lite .sl-order{background:#F2B661;color:#0B1530}' +
    '#store-lite .sl-wa{background:#1B3A6E;color:#fff;border:1px solid rgba(255,255,255,.18)}' +
    '#store-lite .sl-btn:focus-visible{outline:2px solid #fff;outline-offset:2px}' +
    '#store-lite .sl-note{margin-top:8px;text-align:center;font-size:12px;color:rgba(255,255,255,.55)}' +
    '#store-lite .sl-add{display:block;width:100%;margin-top:10px;padding:11px;border-radius:14px;border:1px dashed rgba(242,182,97,.6);' +
    'background:rgba(242,182,97,.08);color:#F2B661;font:inherit;font-size:14px;font-weight:700;cursor:pointer}';

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function api(path, opts) {
    return fetch(SUPABASE_URL + '/rest/v1/' + path, Object.assign({ headers: HEADERS }, opts || {}))
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.status === 204 ? null : r.json(); });
  }

  function money(v) {
    var n = Number(v);
    if (!isFinite(n)) return '';
    return n.toLocaleString('ar-EG', { maximumFractionDigits: 2 }) + ' ج';
  }

  function waLink(phone, shopName) {
    // 01XXXXXXXXX → 201XXXXXXXXX
    var p = String(phone || '').replace(/\D/g, '');
    if (/^01\d{9}$/.test(p)) p = '2' + p;
    if (!/^201\d{9}$/.test(p)) return null;
    var text = 'أهلًا، شفت محل ' + shopName + ' على مُجتمعي وعايز أسأل عن…';
    return 'https://wa.me/' + p + '?text=' + encodeURIComponent(text);
  }

  var root;
  function reveal() {
    if (!root) return;
    root.style.opacity = '0';
    var r = root; root = null;
    setTimeout(function () { r.remove(); }, 260);
  }

  function render(shop, products) {
    var style = el('style'); style.textContent = css; document.head.appendChild(style);
    root = el('div'); root.id = 'store-lite';
    root.setAttribute('role', 'main');
    var wrap = el('div', 'sl-wrap');

    var brand = el('div', 'sl-brand');
    var logo = el('img'); logo.src = 'icons/Icon-192.png'; logo.alt = '';
    brand.appendChild(logo); brand.appendChild(el('span', null, 'متجر على مُجتمعي'));
    wrap.appendChild(brand);

    var head = el('div', 'sl-head');
    if (shop.cover_image_url) {
      var cov = el('img', 'sl-cover'); cov.src = shop.cover_image_url; cov.alt = ''; cov.loading = 'eager';
      cov.onerror = function () { cov.remove(); };
      head.appendChild(cov);
    }
    head.appendChild(el('h1', null, shop.name));
    if (shop.address) head.appendChild(el('div', 'sl-meta', shop.address));
    if (shop.description) head.appendChild(el('div', 'sl-meta', shop.description));
    if (shop.category) head.appendChild(el('span', 'sl-cat', shop.category));
    wrap.appendChild(head);

    // "Add this shop to your phone": the home-screen icon opens this store.
    if (!(window.mogtama3yIsStandalone && window.mogtama3yIsStandalone())) {
      var add = el('button', 'sl-add', '📲 ضيف المحل لشاشة موبايلك');
      add.type = 'button';
      add.addEventListener('click', function () {
        if (window.mogtama3yInstall && window.mogtama3yInstall()) return;
        var ios = window.mogtama3yIsIOS && window.mogtama3yIsIOS();
        alert(ios
          ? 'دوس زرار المشاركة ⬆️ تحت، وبعدين «إضافة إلى الشاشة الرئيسية».'
          : 'من قايمة المتصفح (⋮) اختار «إضافة إلى الشاشة الرئيسية» أو «تثبيت التطبيق».');
      });
      wrap.appendChild(add);
    }

    wrap.appendChild(el('h2', null, products.length ? 'المنتجات (' + products.length + ')' : 'المنتجات'));
    if (!products.length) {
      wrap.appendChild(el('div', 'sl-empty', 'المحل لسه بيضيف منتجاته. تقدر تكلّمه على واتساب وتسأله على اللي محتاجه.'));
    } else {
      var grid = el('div', 'sl-grid');
      products.forEach(function (p) {
        var card = el('div', 'sl-p');
        if (p.image_url) {
          var im = el('img', 'sl-img'); im.src = p.image_url; im.alt = p.name; im.loading = 'lazy'; im.decoding = 'async';
          im.onerror = function () { var ph = el('div', 'sl-ph', '🛍️'); im.replaceWith(ph); };
          card.appendChild(im);
        } else {
          card.appendChild(el('div', 'sl-ph', '🛍️'));
        }
        var b = el('div', 'sl-b');
        b.appendChild(el('div', 'sl-n', p.name));
        b.appendChild(el('div', 'sl-pr', money(p.price)));
        card.appendChild(b);
        grid.appendChild(card);
      });
      wrap.appendChild(grid);
    }
    root.appendChild(wrap);

    var bar = el('div', 'sl-bar');
    var barIn = el('div', 'sl-bar-in');
    var order = el('button', 'sl-btn sl-order', 'اطلب من مُجتمعي');
    order.type = 'button';
    order.addEventListener('click', function () {
      if (flutterReady) { reveal(); return; }
      waitingToReveal = true;
      order.textContent = 'بنجهّز الطلب…';
      order.disabled = true;
    });
    barIn.appendChild(order);
    var wa = waLink(shop.whatsapp, shop.name);
    if (wa) {
      var a = el('a', 'sl-btn sl-wa', 'واتساب المحل');
      a.href = wa; a.target = '_blank'; a.rel = 'noopener';
      barIn.appendChild(a);
    }
    bar.appendChild(barIn);
    bar.appendChild(el('div', 'sl-note', 'الدفع والتوصيل بتتفق عليهم مع المحل مباشرة'));
    root.appendChild(bar);

    document.body.appendChild(root);
    document.title = shop.name + ' | مُجتمعي';
    useShopAsApp(shop);
  }

  // Installing from a store page installs THE STORE: its name on the icon
  // and the store link as the start page (Android via the manifest, iPhone
  // via the apple title + the current URL).
  function useShopAsApp(shop) {
    try {
      var manifest = {
        name: shop.name,
        short_name: shop.name.length > 12 ? shop.name.slice(0, 12) : shop.name,
        start_url: location.href,
        scope: location.origin + '/',
        display: 'standalone',
        background_color: '#0B1530',
        theme_color: '#0B1530',
        lang: 'ar',
        dir: 'rtl',
        icons: [
          { src: location.origin + '/icons/Icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: location.origin + '/icons/Icon-512.png', sizes: '512x512', type: 'image/png' }
        ]
      };
      var link = document.querySelector('link[rel="manifest"]');
      if (link) link.href = URL.createObjectURL(new Blob([JSON.stringify(manifest)], { type: 'application/manifest+json' }));
      var t = document.querySelector('meta[name="apple-mobile-web-app-title"]');
      if (t) t.setAttribute('content', shop.name);
    } catch (e) { /* the store still works without it */ }
  }

  function start() {
    api('shops?slug=eq.' + encodeURIComponent(slug) + '&select=id,name,category,description,address,whatsapp,cover_image_url&limit=1')
      .then(function (rows) {
        if (!rows || !rows.length) return; // مش موجود: Flutter يعرض رسالته
        var shop = rows[0];
        // زيارة واحدة؛ Flutter يشوف العلامة دي ومايعدّش تاني
        window.__mogtama3yScanRecorded = true;
        api('rpc/record_shop_scan', {
          method: 'POST',
          headers: Object.assign({ 'Content-Type': 'application/json' }, HEADERS),
          body: JSON.stringify({ p_slug: slug })
        }).catch(function () {});
        return api('shop_products?shop_id=eq.' + shop.id + '&is_available=eq.true&select=id,name,price,image_url,category&order=category.asc.nullslast,name.asc&limit=200')
          .then(function (products) { render(shop, products || []); })
          .catch(function () { render(shop, []); });
      })
      .catch(function () { /* شبكة: نسيب Flutter يتصرف */ });
  }

  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);
})();
