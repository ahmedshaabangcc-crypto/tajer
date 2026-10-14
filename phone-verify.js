// Phone number verification with Firebase Phone Auth (migration 0074).
// Firebase sends the SMS code and checks it; we only keep the resulting ID
// token long enough to hand it to the verify-phone Edge Function. The
// Firebase SDK (~150 KB) is loaded only when someone verifies a number.
(function () {
  var CONFIG = {
    apiKey: 'AIzaSyD0wkQjlD7BleTi70DYLgm1c_veh321Fl0',
    authDomain: 'mogtama3y-dad8d.firebaseapp.com',
    projectId: 'mogtama3y-dad8d',
    appId: '1:278897121230:web:75ade0b909b1a639abfd9f',
  };
  var SDK = 'https://www.gstatic.com/firebasejs/10.14.1/';
  var loading = null;
  var confirmation = null;
  var verifier = null;

  function load(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = function () { reject({ code: 'sdk-load-failed' }); };
      document.head.appendChild(s);
    });
  }

  function ready() {
    if (!loading) {
      loading = load(SDK + 'firebase-app-compat.js')
        .then(function () { return load(SDK + 'firebase-auth-compat.js'); })
        .then(function () {
          if (!firebase.apps.length) firebase.initializeApp(CONFIG);
          firebase.auth().languageCode = 'ar';
        })
        .catch(function (e) { loading = null; throw e; });
    }
    return loading;
  }

  // A fresh element for every attempt: reCAPTCHA refuses to render twice
  // into the same one ("already been rendered in this element").
  var slots = 0;
  function slot() {
    var old = document.querySelectorAll('.mg-recaptcha');
    for (var i = 0; i < old.length; i++) old[i].remove();
    var el = document.createElement('div');
    el.className = 'mg-recaptcha';
    el.id = 'mg-recaptcha-' + (++slots);
    document.body.appendChild(el);
    return el.id;
  }

  function codeOf(e) {
    if (e && e.code) return e.code;
    return 'error:' + String((e && e.message) || e).slice(0, 80);
  }

  // SMS verification is Egypt-only (0089): 01XXXXXXXXX in any form (+20…,
  // 0020…, 20…, Arabic-Indic digits, spaces) → +201XXXXXXXXX, else null.
  function egyptE164(phone) {
    var d = String(phone || '').replace(/[٠-٩]/g, function (c) { return String(c.charCodeAt(0) - 0x660); })
      .replace(/[۰-۹]/g, function (c) { return String(c.charCodeAt(0) - 0x6F0); })
      .replace(/[^0-9+]/g, '');
    d = d.replace(/^\+/, '').replace(/^00/, '');
    if (/^20/.test(d) && d.length >= 12) d = d.slice(2);
    d = d.replace(/^0/, '');
    return /^1[0125][0-9]{8}$/.test(d) ? '+20' + d : null;
  }

  // phone: 01XXXXXXXXX. Resolves '' when the SMS is on its way, otherwise a
  // Firebase error code (e.g. 'auth/too-many-requests').
  window.mogtama3yPhoneSend = function (phone) {
    var e164 = egyptE164(phone);
    if (!e164) return Promise.resolve('auth/invalid-phone-number');
    return ready()
      .then(function () {
        if (verifier) {
          try { verifier.clear(); } catch (_) {}
          verifier = null;
        }
        verifier = new firebase.auth.RecaptchaVerifier(slot(), { size: 'invisible' });
        return firebase.auth().signInWithPhoneNumber(e164, verifier);
      })
      .then(function (c) { confirmation = c; return ''; })
      .catch(function (e) {
        if (window.console) console.warn('phone verify send failed', e);
        return codeOf(e);
      });
  };

  // Resolves the Firebase ID token for the typed code, or 'ERR:<code>'.
  window.mogtama3yPhoneConfirm = function (code) {
    if (!confirmation) return Promise.resolve('ERR:no-code-sent');
    return confirmation.confirm(String(code))
      .then(function (r) { return r.user.getIdToken(); })
      .then(function (token) {
        confirmation = null;
        // The Firebase session is only a proof; mogtama3y's own login is Supabase.
        firebase.auth().signOut();
        return token;
      })
      .catch(function (e) { return 'ERR:' + codeOf(e); });
  };
})();
