/*
 * shop-pixels.js — بكسلات التاجر على صفحات متجره بس (migration 0097)
 *
 * التاجر بيحط IDs بتاعته في متجري → «الربط والتكاملات» → «البكسل والتاجز»
 * (shops.tracking). الملف ده مش بيتحمّل على صفحة مُجتمعي الرئيسية خالص:
 * store-lite.js وصفحة المتجر في Flutter (lib/core/shops/shop_pixels_web.dart)
 * بيضيفوه بس لما تتفتح صفحة متجر عنده IDs.
 *
 *   Meta Pixel (fbq) · TikTok (ttq) · Snapchat (snaptr) · GA4 + Google Ads
 *   (gtag على dataLayer منفصل اسمه mgShopLayer، فأحداث المنصة وأحداث التاجر
 *   مايختلطوش) · Google Tag Manager (نفس الـ mgShopLayer، أحداث GA4 ecommerce).
 *
 * الأحداث: PageView, ViewContent, AddToCart, InitiateCheckout, Purchase
 * (Purchase بـ value/currency/contents ورقم الطلب كـ event id لمنع التكرار).
 *
 * الأداء: الـ stubs بتتعمل فوراً (الأحداث بتتحفظ في طابور)، وسكربتات
 * المنصات نفسها بتتحمّل async بعد أول لمسة/سكرول أو لما المتصفح يفضى
 * (requestIdleCallback، 4 ثواني بالكتير). مفيش تحميل خالص من localhost.
 *
 * الواجهة (Flutter وstore-lite بيستخدموها بنفس الشكل):
 *   window.mogtama3yShopPixels.cmd(name, json)
 *     'init'  {shop, tracking}         'event' {name, data, key?}     'close' {}
 *   ولو الملف لسه ماتحمّلش: (window.__mgPixelsQ ||= []).push([name, json])
 *
 * Node: module.exports = { buildCalls, cleanIds } (backend/tests/run.js «tint»).
 */
(function (root) {
  'use strict';

  // ------------------------------------------------------------ pure part

  var FORMATS = {
    meta_pixel: /^[0-9]{10,20}$/,
    tiktok_pixel: /^[A-Z0-9]{16,24}$/,
    snap_pixel: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    ga4: /^G-[A-Z0-9]{6,12}$/,
    gtm: /^GTM-[A-Z0-9]{5,9}$/,
    google_ads: /^AW-[0-9]{8,12}(\/[A-Za-z0-9_-]{6,40})?$/
  };

  // Only well-formed IDs ever reach a script URL.
  function cleanIds(t) {
    var out = {};
    if (!t || typeof t !== 'object') return out;
    for (var k in FORMATS) {
      if (typeof t[k] === 'string' && FORMATS[k].test(t[k])) out[k] = t[k];
    }
    return out;
  }

  function num(v) {
    var n = Number(v);
    return isFinite(n) ? Math.round(n * 1000) / 1000 : 0;
  }

  // data: {currency, value?, contents:[{id, name, price, quantity}], order_id?}
  function norm(data) {
    data = data || {};
    var contents = (data.contents || []).filter(function (c) { return c && c.id != null; }).map(function (c) {
      return { id: String(c.id), name: c.name ? String(c.name).slice(0, 100) : '', price: num(c.price), quantity: Math.max(1, parseInt(c.quantity, 10) || 1) };
    });
    var value = data.value != null ? num(data.value)
      : num(contents.reduce(function (s, c) { return s + c.price * c.quantity; }, 0));
    var cur = typeof data.currency === 'string' && /^[A-Z]{3}$/.test(data.currency) ? data.currency : 'EGP';
    var items = contents.reduce(function (s, c) { return s + c.quantity; }, 0);
    return { contents: contents, value: value, currency: cur, num_items: items, order_id: data.order_id ? String(data.order_id) : null };
  }

  var GA = { PageView: 'page_view', ViewContent: 'view_item', AddToCart: 'add_to_cart', InitiateCheckout: 'begin_checkout', Purchase: 'purchase' };
  var TT = { ViewContent: 'ViewContent', AddToCart: 'AddToCart', InitiateCheckout: 'InitiateCheckout', Purchase: 'CompletePayment' };
  var SC = { PageView: 'PAGE_VIEW', ViewContent: 'VIEW_CONTENT', AddToCart: 'ADD_CART', InitiateCheckout: 'START_CHECKOUT', Purchase: 'PURCHASE' };

  // One standard event → the vendor calls, as data: [vendor, ...arguments].
  // vendor: 'fbq' | 'ttq' (args[0] = pixel id, then method + args) | 'snaptr' | 'gtag' | 'dl' (mgShopLayer push).
  function buildCalls(name, data, ids, page) {
    ids = cleanIds(ids);
    page = page || {};
    var d = norm(data);
    var calls = [];
    var eventId = d.order_id ? 'order-' + d.order_id : undefined;
    var isPage = name === 'PageView';
    if (!isPage && !GA[name]) return calls;

    if (ids.meta_pixel) {
      if (isPage) {
        calls.push(['fbq', 'trackSingle', ids.meta_pixel, 'PageView']);
      } else {
        var fb = {
          content_ids: d.contents.map(function (c) { return c.id; }),
          content_type: 'product',
          contents: d.contents.map(function (c) { return { id: c.id, quantity: c.quantity, item_price: c.price }; }),
          value: d.value,
          currency: d.currency
        };
        if (name === 'ViewContent' && d.contents[0]) fb.content_name = d.contents[0].name;
        if (name === 'InitiateCheckout' || name === 'Purchase') fb.num_items = d.num_items;
        calls.push(eventId ? ['fbq', 'trackSingle', ids.meta_pixel, name, fb, { eventID: eventId }] : ['fbq', 'trackSingle', ids.meta_pixel, name, fb]);
      }
    }

    if (ids.tiktok_pixel) {
      if (isPage) {
        calls.push(['ttq', ids.tiktok_pixel, 'page']);
      } else {
        var tt = {
          contents: d.contents.map(function (c) { return { content_id: c.id, content_type: 'product', content_name: c.name, quantity: c.quantity, price: c.price }; }),
          value: d.value,
          currency: d.currency
        };
        calls.push(eventId ? ['ttq', ids.tiktok_pixel, 'track', TT[name], tt, { event_id: eventId }] : ['ttq', ids.tiktok_pixel, 'track', TT[name], tt]);
      }
    }

    if (ids.snap_pixel) {
      if (isPage) {
        calls.push(['snaptr', 'track', 'PAGE_VIEW']);
      } else {
        var sc = { item_ids: d.contents.map(function (c) { return c.id; }), price: d.value, currency: d.currency, number_items: d.num_items };
        if (name === 'Purchase' && d.order_id) { sc.transaction_id = d.order_id; sc.client_dedup_id = eventId; }
        calls.push(['snaptr', 'track', SC[name], sc]);
      }
    }

    var gaTargets = [ids.ga4, ids.google_ads ? ids.google_ads.split('/')[0] : null].filter(Boolean);
    var gaItems = d.contents.map(function (c) { return { item_id: c.id, item_name: c.name, price: c.price, quantity: c.quantity }; });
    if (gaTargets.length) {
      if (isPage) {
        calls.push(['gtag', 'event', 'page_view', { send_to: gaTargets, page_location: page.location, page_title: page.title }]);
      } else {
        var ga = { send_to: gaTargets, currency: d.currency, value: d.value, items: gaItems };
        if (name === 'Purchase' && d.order_id) ga.transaction_id = d.order_id;
        calls.push(['gtag', 'event', GA[name], ga]);
      }
      if (name === 'Purchase' && ids.google_ads && ids.google_ads.indexOf('/') > 0) {
        calls.push(['gtag', 'event', 'conversion', { send_to: ids.google_ads, value: d.value, currency: d.currency, transaction_id: d.order_id || '' }]);
      }
    }

    if (ids.gtm) {
      if (isPage) {
        calls.push(['dl', { event: 'mg_page_view', page_location: page.location, page_title: page.title }]);
      } else {
        var ec = { currency: d.currency, value: d.value, items: gaItems };
        if (name === 'Purchase' && d.order_id) ec.transaction_id = d.order_id;
        calls.push(['dl', { ecommerce: null }]);
        calls.push(['dl', { event: GA[name], event_id: eventId, ecommerce: ec }]);
      }
    }
    return calls;
  }

  if (typeof module === 'object' && module.exports) {
    module.exports = { buildCalls: buildCalls, cleanIds: cleanIds };
    return;
  }

  // -------------------------------------------------------- browser part
  var w = root;
  var d = w.document;
  var state = { shop: null, ids: {}, active: false, lastKey: null, loaded: {}, inited: {} };
  var local = !!w.mogtama3yIsLocal || /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  var debug = false;
  try { debug = w.localStorage && w.localStorage.getItem('mgPixelsDebug') === '1'; } catch (e) { /* private mode */ }

  function addScript(src) {
    if (local) { if (debug) console.log('[shop-pixels] (local, not loaded)', src); return; }
    var s = d.createElement('script');
    s.async = true;
    s.src = src;
    d.head.appendChild(s);
  }

  // Vendor scripts wait for the first touch / scroll / key, or idle time.
  var pendingLoads = [];
  var loadNow = false;
  function lazyLoad(src) {
    if (state.loaded[src]) return;
    state.loaded[src] = true;
    if (loadNow) addScript(src); else pendingLoads.push(src);
  }
  function flushLoads() {
    if (loadNow) return;
    loadNow = true;
    pendingLoads.splice(0).forEach(addScript);
  }
  ['pointerdown', 'scroll', 'keydown', 'touchstart'].forEach(function (ev) {
    w.addEventListener(ev, flushLoads, { once: true, passive: true });
  });
  if (w.requestIdleCallback) w.requestIdleCallback(flushLoads, { timeout: 4000 });
  else setTimeout(flushLoads, 3500);

  // ---- vendor stubs (calls queue until the real script arrives)
  function ensureMeta(id) {
    if (!w.fbq) {
      var n = w.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); };
      if (!w._fbq) w._fbq = n;
      n.push = n; n.loaded = true; n.version = '2.0'; n.queue = [];
      n.disablePushState = true; // no automatic page views on SPA navigation
    }
    if (!state.inited['fb' + id]) { state.inited['fb' + id] = true; w.fbq('init', id); }
    lazyLoad('https://connect.facebook.net/en_US/fbevents.js');
  }

  function ensureTikTok(id) {
    var t = 'ttq';
    var ttq = w[t] = w[t] || [];
    if (!ttq.methods) {
      w.TiktokAnalyticsObject = t;
      ttq.methods = ['page', 'track', 'identify', 'instances', 'debug', 'on', 'off', 'once', 'ready', 'alias', 'group',
        'enableCookie', 'disableCookie', 'holdConsent', 'revokeConsent', 'grantConsent'];
      ttq.setAndDefer = function (o, m) { o[m] = function () { o.push([m].concat(Array.prototype.slice.call(arguments, 0))); }; };
      for (var i = 0; i < ttq.methods.length; i++) ttq.setAndDefer(ttq, ttq.methods[i]);
      ttq.instance = function (x) { for (var e = ttq._i[x] || [], j = 0; j < ttq.methods.length; j++) ttq.setAndDefer(e, ttq.methods[j]); return e; };
    }
    if (!state.inited['tt' + id]) {
      state.inited['tt' + id] = true;
      var u = 'https://analytics.tiktok.com/i18n/pixel/events.js';
      ttq._i = ttq._i || {}; ttq._i[id] = []; ttq._i[id]._u = u;
      ttq._t = ttq._t || {}; ttq._t[id] = +new Date();
      ttq._o = ttq._o || {}; ttq._o[id] = {};
      lazyLoad(u + '?sdkid=' + encodeURIComponent(id) + '&lib=' + t);
    }
  }

  function ensureSnap(id) {
    if (!w.snaptr) {
      var a = w.snaptr = function () { a.handleRequest ? a.handleRequest.apply(a, arguments) : a.queue.push(arguments); };
      a.queue = [];
    }
    if (!state.inited['sc' + id]) { state.inited['sc' + id] = true; w.snaptr('init', id, {}); }
    lazyLoad('https://sc-static.net/scevent.min.js');
  }

  function layer() { return (w.mgShopLayer = w.mgShopLayer || []); }
  function mgGtag() { layer().push(arguments); }

  function ensureGtag(ids) {
    var targets = [ids.ga4, ids.google_ads ? ids.google_ads.split('/')[0] : null].filter(Boolean);
    if (!targets.length) return;
    if (!state.inited.gtagjs) { state.inited.gtagjs = true; mgGtag('js', new Date()); }
    targets.forEach(function (t) {
      w['ga-disable-' + t] = false;
      if (!state.inited['g' + t]) { state.inited['g' + t] = true; mgGtag('config', t, { send_page_view: false }); }
    });
    lazyLoad('https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(targets[0]) + '&l=mgShopLayer');
  }

  function ensureGtm(id) {
    if (!state.inited['gtm' + id]) {
      state.inited['gtm' + id] = true;
      layer().push({ 'gtm.start': new Date().getTime(), event: 'gtm.js' });
    }
    lazyLoad('https://www.googletagmanager.com/gtm.js?id=' + encodeURIComponent(id) + '&l=mgShopLayer');
  }

  function run(call) {
    if (debug) console.log('[shop-pixels]', JSON.stringify(call));
    try {
      var v = call[0];
      var args = call.slice(1);
      if (v === 'fbq' && w.fbq) w.fbq.apply(null, args);
      else if (v === 'ttq' && w.ttq) { var inst = w.ttq.instance(args[0]); inst[args[1]].apply(inst, args.slice(2)); }
      else if (v === 'snaptr' && w.snaptr) w.snaptr.apply(null, args);
      else if (v === 'gtag') mgGtag.apply(null, args);
      else if (v === 'dl') layer().push(args[0]);
    } catch (e) { /* a pixel must never break the store */ }
  }

  function consent(grant) {
    try { if (w.fbq && state.ids.meta_pixel) w.fbq('consent', grant ? 'grant' : 'revoke'); } catch (e) { /* ignore */ }
    try { if (w.ttq && w.ttq.methods && state.ids.tiktok_pixel) w.ttq[grant ? 'grantConsent' : 'revokeConsent'](); } catch (e) { /* ignore */ }
    [state.ids.ga4, state.ids.google_ads ? state.ids.google_ads.split('/')[0] : null].forEach(function (t) {
      if (t) w['ga-disable-' + t] = !grant;
    });
  }

  var api = {
    init: function (p) {
      var ids = cleanIds(p && p.tracking);
      var shop = p && p.shop ? String(p.shop) : null;
      if (!shop || !Object.keys(ids).length) { api.close(); return; }
      if (state.shop && state.shop !== shop) { consent(false); state.lastKey = null; }
      var wasClosed = !state.active;
      state.shop = shop; state.ids = ids; state.active = true;
      if (ids.meta_pixel) ensureMeta(ids.meta_pixel);
      if (ids.tiktok_pixel) ensureTikTok(ids.tiktok_pixel);
      if (ids.snap_pixel) ensureSnap(ids.snap_pixel);
      ensureGtag(ids);
      if (ids.gtm) ensureGtm(ids.gtm);
      if (wasClosed) consent(true);
    },
    // {name, data, key}: PageView with the same key twice in a row is
    // ignored (store-lite and Flutter both open the same store page).
    event: function (p) {
      if (!state.active || !p || !p.name) return;
      if (p.name === 'PageView') {
        var key = p.key || location.hash || location.pathname;
        if (key === state.lastKey) return;
        state.lastKey = key;
      }
      buildCalls(p.name, p.data, state.ids, { location: location.href, title: d.title }).forEach(run);
    },
    // Leaving the store for the rest of مُجتمعي: our events stop, and the
    // pixels that support it are told to stop sending.
    close: function () {
      if (!state.active) return;
      state.active = false;
      state.lastKey = null;
      consent(false);
      layer().push({ event: 'mg_store_leave' });
    }
  };

  w.mogtama3yShopPixels = {
    cmd: function (name, json) {
      var p = {};
      try { p = typeof json === 'string' ? JSON.parse(json || '{}') : (json || {}); } catch (e) { return; }
      if (api[name]) api[name](p);
    }
  };
  var q = w.__mgPixelsQ;
  w.__mgPixelsQ = { push: function (c) { w.mogtama3yShopPixels.cmd(c[0], c[1]); } };
  if (q && q.length) q.forEach(function (c) { w.mogtama3yShopPixels.cmd(c[0], c[1]); });
})(typeof window !== 'undefined' ? window : this);
