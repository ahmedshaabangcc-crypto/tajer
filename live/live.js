// «دروس أونلاين» — the live-lesson page (/live/?s=<lesson id>), outside the
// Flutter bundle so main.dart.js stays lean. Same origin as the app, so it
// reads the app's Supabase session from localStorage, asks the
// `livekit-token` Edge Function (migration 0085) for a LiveKit token and
// joins the room with livekit-client (UMD from jsdelivr, pinned + SRI).
// Nothing is recorded or stored: the chat and ✋ are LiveKit data messages.
(function () {
  'use strict';

  var SUPABASE_URL = 'https://pxiabifybakbsqlycffc.supabase.co';
  // The app's public publishable key (lib/core/supabase/supabase_config.dart),
  // only used to refresh an expired session.
  var PUBLISHABLE_KEY = 'sb_publishable_3QS4C4PPUUCZuvjUi8Ifmg_EJ44uxhE';
  // The function's slug in the Supabase dashboard (see backend/functions/README.md).
  var FUNCTION_SLUG = 'livekit-token';
  var STORAGE_KEY = 'sb-pxiabifybakbsqlycffc-auth-token';

  var params = new URLSearchParams(location.search);
  var sessionId = (params.get('s') || '').trim();
  var isLocal = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  // Local testing only: ?api=<functions base> instead of production.
  var FUNCTIONS = (isLocal && params.get('api')) || (SUPABASE_URL + '/functions/v1/');
  if (!/\/$/.test(FUNCTIONS)) FUNCTIONS += '/';

  var $ = function (id) { return document.getElementById(id); };
  var LK = null;            // window.LivekitClient
  var room = null;
  var me = null;            // { role, identity, name, can_speak, session }
  var lesson = null;        // session json
  var handRaised = false;
  var videoOff = false;
  var leaving = false;
  var connected = false;    // the current room got connected at least once
  var chatUnread = 0;
  var lastChatAt = 0;
  var hostHands = [];
  var pollTimer = null;
  var countTimer = null;
  var videoEls = {};        // track sid → its <video>, reused across renders

  // ------------------------------------------------------------ helpers
  function el(tag, attrs, text) {
    var e = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (k === 'class') e.className = attrs[k];
      else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), attrs[k]);
      else e.setAttribute(k, attrs[k]);
    }
    if (text != null) e.textContent = text;
    return e;
  }

  var toastTimer = null;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('on'); }, 3500);
  }

  function fmtTime(iso) {
    try {
      return new Date(iso).toLocaleString('ar-EG', { weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' });
    } catch (e) {
      return '';
    }
  }

  function initial(name) {
    var s = String(name || '؟').trim();
    return s ? s.charAt(0) : '؟';
  }

  // A panel in place of the room: title, text, buttons [{label, href|onClick, ghost}].
  function screen(title, text, buttons, opts) {
    $('room').classList.remove('on');
    var p = $('screen');
    p.style.display = '';
    p.textContent = '';
    if (opts && opts.spinner) p.appendChild(el('div', { class: 'spin' }));
    if (title) p.appendChild(el('h1', null, title));
    (Array.isArray(text) ? text : [text]).forEach(function (t) { if (t) p.appendChild(el('p', null, t)); });
    if (opts && opts.note) p.appendChild(el('p', { class: 'note' }, opts.note));
    if (buttons && buttons.length) {
      var row = el('div', { class: 'row' });
      buttons.forEach(function (b) {
        var n = b.href
          ? el('a', { href: b.href, class: 'btn' + (b.ghost ? ' ghost' : ''), style: 'text-decoration:none;display:inline-block;border-radius:14px;padding:12px 16px;font-weight:700' }, b.label)
          : el('button', { class: 'btn' + (b.ghost ? ' ghost' : ''), onclick: b.onClick }, b.label);
        row.appendChild(n);
      });
      p.appendChild(row);
    }
  }

  function setLesson(s) {
    if (!s) return;
    lesson = s;
    $('title').textContent = s.title || 'درس أونلاين';
    $('sub').textContent = [s.mosque_name, s.sheikh ? 'مع ' + s.sheikh : null, s.mode === 'video' ? 'صوت وصورة' : 'صوت بس'].filter(Boolean).join(' • ');
    if (s.mosque_id) $('back').href = '/#/masjid/' + encodeURIComponent(s.mosque_id);
    document.title = (s.title || 'درس أونلاين') + ' — مسجدي';
  }

  var mosqueLink = function (label) {
    return { label: label || 'ارجع للمسجد', href: lesson && lesson.mosque_id ? '/#/masjid/' + encodeURIComponent(lesson.mosque_id) : '/#/masjid', ghost: true };
  };

  // ------------------------------------------------------------ session
  function readSession() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      var s = JSON.parse(raw);
      return s && s.access_token ? s : null;
    } catch (e) {
      return null;
    }
  }

  function jwtExp(token) {
    try {
      var p = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      return JSON.parse(atob(p + '==='.slice((p.length + 3) % 4))).exp || 0;
    } catch (e) {
      return 0;
    }
  }

  // A valid access token, refreshing (and saving back for the app) if needed.
  function accessToken() {
    var s = readSession();
    if (!s) return Promise.resolve(null);
    var exp = s.expires_at || jwtExp(s.access_token);
    if (exp * 1000 - Date.now() > 60000) return Promise.resolve(s.access_token);
    if (!s.refresh_token) return Promise.resolve(null);
    return fetch(SUPABASE_URL + '/auth/v1/token?grant_type=refresh_token', {
      method: 'POST',
      headers: { apikey: PUBLISHABLE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: s.refresh_token }),
    }).then(function (r) { return r.ok ? r.json() : null; }).then(function (n) {
      if (!n || !n.access_token) return null;
      if (!n.expires_at && n.expires_in) n.expires_at = Math.floor(Date.now() / 1000) + n.expires_in;
      if (!n.user) n.user = s.user;
      if (!n.token_type) n.token_type = 'bearer';
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(n)); } catch (e) {}
      return n.access_token;
    }).catch(function () { return null; });
  }

  // POST to the Edge Function → { status, body } (status 0 = unreachable).
  function call(action, extra) {
    return accessToken().then(function (token) {
      if (!token) return { status: 401, body: { reason: 'sign_in', error: 'سجّل دخول الأول' } };
      var body = Object.assign({ action: action, session: sessionId }, extra || {});
      return fetch(FUNCTIONS + FUNCTION_SLUG, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, apikey: PUBLISHABLE_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (b) { return { status: r.status, body: b || {} }; });
      }, function () {
        return { status: 0, body: {} };
      });
    });
  }

  // ------------------------------------------------------------ flow
  function start() {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) {
      return screen('لينك الدرس ناقص', 'افتح الدرس من صفحة المسجد على مسجدي.', [mosqueLink('روح لمسجدي')]);
    }
    if (!window.LivekitClient) {
      return screen('مقدرناش نحمّل الدرس', 'اتأكد من النت وجرّب تاني.', [{ label: 'جرّب تاني', onClick: function () { location.reload(); } }, mosqueLink()]);
    }
    LK = window.LivekitClient;
    if (!readSession()) {
      return screen('سجّل دخول الأول', 'لازم تكون مسجّل دخول على مسجدي عشان تحضر الدرس.', [{ label: 'سجّل دخول', href: '/' }, mosqueLink()]);
    }
    fetchToken();
  }

  function fetchToken() {
    screen(null, 'بنجهّز الدرس…', null, { spinner: true });
    call('join').then(function (r) {
      if (r.body && r.body.session) setLesson(r.body.session);
      if (r.status === 200 && r.body.token) {
        me = r.body;
        handRaised = !!r.body.hand_raised;
        return lobby();
      }
      handleRefusal(r);
    });
  }

  function handleRefusal(r) {
    var b = r.body || {};
    var reason = b.reason;
    clearTimeout(pollTimer);
    if (r.status === 0) {
      return screen('مش قادرين نوصل للسيرفر', 'اتأكد من النت وجرّب تاني بعد شوية.', [{ label: 'جرّب تاني', onClick: fetchToken }, mosqueLink()]);
    }
    if (r.status === 404 || reason === 'not_configured' || r.status === 503) {
      return screen('الدروس الأونلاين لسه مش متفعّلة', 'جرّب تاني بعد شوية.', [{ label: 'جرّب تاني', onClick: fetchToken }, mosqueLink()]);
    }
    if (reason === 'sign_in' || r.status === 401) {
      return screen('سجّل دخول الأول', 'جلستك انتهت — افتح مسجدي وسجّل دخول، وبعدها ارجع للدرس.', [{ label: 'سجّل دخول', href: '/' }, mosqueLink()]);
    }
    if (reason === 'not_live') {
      var when = lesson && lesson.scheduled_at ? 'ميعاده: ' + fmtTime(lesson.scheduled_at) : '';
      if (b.is_host) {
        return screen('الدرس لسه مابدأش', [when, 'أول ما تبدأ، المتابعين والأعضاء هيوصلهم إشعار.'], [
          { label: '🔴 ابدأ الدرس دلوقتي', onClick: startLesson }, mosqueLink(),
        ], { note: 'الدرس مباشر ومش بيتسجّل' });
      }
      pollTimer = setTimeout(fetchToken, 30000);
      return screen('الدرس لسه مابدأش', [when, 'سيب الصفحة مفتوحة — هندخّلك أول ما يبدأ.'], [mosqueLink()], { note: 'الدرس مباشر ومش بيتسجّل', spinner: true });
    }
    if (reason === 'members_only') {
      return screen('الدرس ده لأعضاء المسجد', 'انضم للمسجد من صفحته وبعدها ادخل الدرس.', [mosqueLink('افتح صفحة المسجد وانضم')]);
    }
    if (reason === 'ended') return screen('الدرس خلص', 'الدروس المباشرة مش بتتسجّل — تابع المسجد عشان يوصلك الدرس الجاي.', [mosqueLink()]);
    if (reason === 'cancelled') return screen('الدرس اتلغى', b.error || '', [mosqueLink()]);
    if (reason === 'removed') return screen('مش هتقدر تدخل الدرس ده', b.error || '', [mosqueLink()]);
    if (reason === 'not_found') return screen('الدرس ده مش موجود', 'يمكن اللينك غلط.', [mosqueLink('روح لمسجدي')]);
    screen('حصلت مشكلة', b.error || 'جرّب تاني بعد شوية.', [{ label: 'جرّب تاني', onClick: fetchToken }, mosqueLink()]);
  }

  function startLesson() {
    screen(null, 'بنبدأ الدرس…', null, { spinner: true });
    call('start').then(function (r) {
      if (r.status === 200) return fetchToken();
      if (r.status === 0) return handleRefusal(r);
      screen('مقدرناش نبدأ الدرس', r.body.error || 'جرّب تاني.', [{ label: 'جرّب تاني', onClick: fetchToken }, mosqueLink()]);
    });
  }

  // The tap that joins is also the user gesture iOS / Android need for audio.
  function lobby() {
    var host = me.role === 'host';
    var lines = [
      'إنت داخل ' + (host ? 'كإدارة المسجد (هتتكلم وتدير الدرس)' : me.role === 'speaker' ? 'كمتكلم' : 'كمستمع') + ' باسم «' + me.name + '».',
      lesson && lesson.mode === 'video' ? 'الدرس صوت وصورة — لو النت ضعيف اختار «صوت بس» جوه الدرس.' : 'الدرس صوت بس — مش بيستهلك نت كتير.',
    ];
    screen(lesson ? lesson.title : 'درس أونلاين', lines, [{ label: host ? '🎙️ ادخل وابدأ الكلام' : '🎧 ادخل الدرس', onClick: join }, mosqueLink()],
      { note: 'الدرس مباشر ومش بيتسجّل' });
  }

  function join() {
    screen(null, 'بندخّلك الدرس…', null, { spinner: true });
    var audio = !lesson || lesson.mode !== 'video';
    room = new LK.Room({
      adaptiveStream: true,
      dynacast: true,
      audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      videoCaptureDefaults: { resolution: LK.VideoPresets.h540.resolution },
      publishDefaults: { audioPreset: LK.AudioPresets.speech, dtx: true, red: true, simulcast: true },
    });
    connected = false;
    wire(room);
    // Unlock audio inside the click (Safari / Chrome autoplay rules).
    try { var unlock = room.startAudio(); if (unlock && unlock.catch) unlock.catch(function () {}); } catch (e) {}
    room.connect(me.url, me.token, { autoSubscribe: true }).then(function () {
      connected = true;
      $('screen').style.display = 'none';
      $('room').classList.add('on');
      $('stage').classList.toggle('audio-mode', audio);
      $('liveBadge').classList.add('on');
      setupBar();
      if (me.role === 'host') {
        setMic(true);
        if (!audio) setCam(true);
        refreshHands();
      }
      render();
      checkAudio();
      clearInterval(countTimer);
      countTimer = setInterval(render, 5000);
    }).catch(function (e) {
      console.error(e);
      if (room) { leaving = true; room.disconnect(); leaving = false; }
      room = null;
      screen('مقدرناش ندخّلك الدرس', 'يمكن الدرس اتملى أو النت ضعيف. جرّب تاني.', [{ label: 'جرّب تاني', onClick: fetchToken }, mosqueLink()]);
    });
  }

  function checkAudio() {
    $('tap').classList.toggle('on', !!room && !room.canPlaybackAudio);
  }

  function wire(r) {
    var E = LK.RoomEvent;
    r.on(E.TrackSubscribed, function (track, pub, participant) {
      if (track.kind === 'audio') {
        var a = track.attach();
        a.dataset.sid = pub.trackSid;
        $('audioSink').appendChild(a);
      } else if (videoOff) {
        pub.setSubscribed(false);
      }
      render();
    });
    r.on(E.TrackUnsubscribed, function (track, pub) {
      track.detach().forEach(function (e) { e.remove(); });
      if (pub) delete videoEls[pub.trackSid];
      render();
    });
    r.on(E.LocalTrackUnpublished, function (pub) {
      if (pub) delete videoEls[pub.trackSid];
      render();
    });
    ['ParticipantConnected', 'ParticipantDisconnected', 'TrackMuted', 'TrackUnmuted', 'TrackPublished', 'TrackUnpublished',
      'LocalTrackPublished', 'ActiveSpeakersChanged', 'ParticipantMetadataChanged', 'ParticipantNameChanged']
      .forEach(function (ev) { if (E[ev]) r.on(E[ev], render); });
    r.on(E.AudioPlaybackStatusChanged, checkAudio);
    r.on(E.Reconnecting, function () { $('netBanner').classList.add('on'); });
    r.on(E.SignalReconnecting, function () { $('netBanner').classList.add('on'); });
    r.on(E.Reconnected, function () { $('netBanner').classList.remove('on'); render(); });
    r.on(E.ParticipantPermissionsChanged, function (prev, participant) {
      if (!participant || participant.identity !== r.localParticipant.identity) return render();
      var can = !!(r.localParticipant.permissions && r.localParticipant.permissions.canPublish);
      if (can && me.role === 'listener') {
        me.role = 'speaker';
        handRaised = false;
        toast('إدارة المسجد سمحتلك تتكلم — افتح المايك 🎙️');
      } else if (!can && me.role === 'speaker') {
        me.role = 'listener';
        toast('رجعت مستمع — شكراً على مشاركتك');
      }
      setupBar();
      render();
    });
    r.on(E.DataReceived, function (payload, participant, kind, topic) {
      var msg;
      try { msg = JSON.parse(new TextDecoder().decode(payload)); } catch (e) { return; }
      if (!participant) return;
      if (topic === 'chat' && msg && typeof msg.text === 'string') addChat(participant, msg.text.slice(0, 300));
      if (topic === 'hand' && me.role === 'host') {
        if (msg && msg.raised) toast('✋ ' + (participant.name || 'مستمع') + ' رافع إيده');
        refreshHands();
      }
    });
    r.on(E.Disconnected, function (reason) {
      if (room && room !== r) return; // an older room
      clearInterval(countTimer);
      $('liveBadge').classList.remove('on');
      $('netBanner').classList.remove('on');
      $('tap').classList.remove('on');
      closeSheets();
      $('audioSink').textContent = '';
      videoEls = {};
      room = null;
      if (leaving || !connected) return; // a failed first connect is handled by join()
      var R = LK.DisconnectReason || {};
      if (reason === R.ROOM_DELETED) return screen('الدرس خلص', 'جزاكم الله خيراً — الدرس مش بيتسجّل.', [mosqueLink()]);
      if (reason === R.PARTICIPANT_REMOVED) return screen('خرجت من الدرس', 'إدارة المسجد طلّعتك من الدرس.', [mosqueLink()]);
      if (reason === R.DUPLICATE_IDENTITY) return screen('إنت داخل الدرس من مكان تاني', 'اقفل الصفحة التانية أو ادخل من هنا.', [{ label: 'ادخل من هنا', onClick: fetchToken }, mosqueLink()]);
      screen('الاتصال اتقطع', 'بنحاول ندخّلك تاني…', [{ label: 'ادخل تاني', onClick: fetchToken }, mosqueLink()], { spinner: true });
      setTimeout(function () { if (!room && !leaving) fetchToken(); }, 3000);
    });
  }

  // ------------------------------------------------------------ render
  function roleOf(p) {
    try { return (JSON.parse(p.metadata || '{}').role) || ''; } catch (e) { return ''; }
  }

  function publishing(p) {
    var any = false;
    p.trackPublications.forEach(function (pub) { if (pub.source !== 'unknown') any = true; });
    return any || roleOf(p) === 'host' || roleOf(p) === 'speaker' || !!(p.permissions && p.permissions.canPublish);
  }

  function pubOf(p, source) {
    var found = null;
    p.trackPublications.forEach(function (pub) { if (pub.source === source) found = pub; });
    return found;
  }

  function tile(p, big) {
    var role = p === room.localParticipant ? me.role : roleOf(p);
    var t = el('div', { class: big ? 'main-tile' : 'tile' });
    if (p.isSpeaking) t.classList.add('speaking');
    var cam = pubOf(p, LK.Track.Source.Camera);
    var hasVideo = cam && cam.track && !cam.isMuted && !(videoOff && p !== room.localParticipant);
    if (hasVideo) {
      var v = videoEls[cam.trackSid];
      if (!v || v._track !== cam.track) {
        v = cam.track.attach();
        v._track = cam.track;
        videoEls[cam.trackSid] = v;
      }
      v.muted = true;
      v.playsInline = true;
      if (p === room.localParticipant) v.style.transform = 'scaleX(-1)';
      t.appendChild(v);
    } else {
      t.appendChild(el('div', { class: 'av' }, initial(p.name)));
    }
    t.appendChild(el('div', { class: 'nm' }, (p.name || 'مشارك') + (p === room.localParticipant ? ' (إنت)' : '')));
    if (role === 'host') t.appendChild(el('div', { class: 'tag' }, 'إدارة المسجد'));
    var mic = pubOf(p, LK.Track.Source.Microphone);
    if (!mic || mic.isMuted) t.appendChild(el('span', { class: 'muted-ic', title: 'المايك مقفول' }, '🔇'));
    return t;
  }

  function render() {
    if (!room) return;
    var stage = $('stage');
    var everyone = [room.localParticipant];
    room.remoteParticipants.forEach(function (p) { everyone.push(p); });
    var pubs = everyone.filter(publishing);
    var main = pubs.filter(function (p) { return (p === room.localParticipant ? me.role : roleOf(p)) === 'host'; })
      .sort(function (a, b) { return (pubOf(b, LK.Track.Source.Camera) ? 1 : 0) - (pubOf(a, LK.Track.Source.Camera) ? 1 : 0); })[0] || pubs[0];
    stage.textContent = '';
    if (main) stage.appendChild(tile(main, true));
    else stage.appendChild(el('div', { class: 'main-tile' }, 'مستنيين الشيخ يبدأ…'));
    var rest = pubs.filter(function (p) { return p !== main; });
    if (rest.length) {
      var g = el('div', { class: 'grid' });
      rest.forEach(function (p) { g.appendChild(tile(p, false)); });
      stage.appendChild(g);
    }
    var n = room.numParticipants || everyone.length;
    var listeners = Math.max(0, n - pubs.length);
    stage.appendChild(el('p', { class: 'hint' }, '👥 ' + n + ' في الدرس' + (listeners ? ' • ' + listeners + ' مستمع' : '') + ' — الدرس مباشر ومش بيتسجّل'));
    if (me.role === 'host') renderPeople();
  }

  // ------------------------------------------------------------ controls
  function setupBar() {
    var pub = me.role === 'host' || me.role === 'speaker';
    var video = lesson && lesson.mode === 'video';
    $('bMic').hidden = !pub;
    $('bCam').hidden = !(pub && video);
    $('bHand').hidden = pub;
    $('bVideoOff').hidden = !video || me.role === 'host';
    $('bHost').hidden = me.role !== 'host';
    syncButtons();
  }

  function syncButtons() {
    if (!room) return;
    var lp = room.localParticipant;
    $('bMic').classList.toggle('on', lp.isMicrophoneEnabled);
    $('bMic').textContent = lp.isMicrophoneEnabled ? '🎙️ المايك شغال' : '🔇 افتح المايك';
    $('bCam').classList.toggle('on', lp.isCameraEnabled);
    $('bCam').textContent = lp.isCameraEnabled ? '📷 الكاميرا شغالة' : '📷 افتح الكاميرا';
    $('bHand').classList.toggle('on', handRaised);
    $('bHand').textContent = handRaised ? '✋ نزّل إيدك' : '✋ ارفع إيدك';
    $('bVideoOff').classList.toggle('on', videoOff);
  }

  function setMic(on) {
    if (!room) return;
    room.localParticipant.setMicrophoneEnabled(on).then(syncButtons, function () {
      toast('المتصفح مانع المايك — اسمح بيه من إعدادات الموقع');
      syncButtons();
    });
  }

  function setCam(on) {
    if (!room) return;
    room.localParticipant.setCameraEnabled(on).then(function () { syncButtons(); render(); }, function () {
      toast('المتصفح مانع الكاميرا — اسمح بيها من إعدادات الموقع');
      syncButtons();
    });
  }

  function send(topic, obj) {
    if (!room) return Promise.resolve();
    return room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify(obj)), { reliable: true, topic: topic });
  }

  function toggleHand() {
    var want = !handRaised;
    $('bHand').disabled = true;
    call('hand', { raise: want }).then(function (r) {
      $('bHand').disabled = false;
      if (r.status !== 200) {
        if (r.body && r.body.hint === 'phone_unverified') return toast('لازم توثّق رقم موبايلك الأول (من شات المسجد في التطبيق) عشان تتكلم');
        return toast((r.body && r.body.error) || 'مقدرناش نوصّل طلبك، جرّب تاني');
      }
      handRaised = want;
      syncButtons();
      send('hand', { raised: want });
      toast(want ? 'إدارة المسجد شافت إيدك ✋ — استنى لحد ما يسمحولك' : 'نزّلت إيدك');
    });
  }

  function toggleVideoOff() {
    videoOff = !videoOff;
    room.remoteParticipants.forEach(function (p) {
      p.trackPublications.forEach(function (pub) {
        if (pub.kind === 'video') pub.setSubscribed(!videoOff);
      });
    });
    syncButtons();
    render();
    toast(videoOff ? 'وقفنا الصورة — هتسمع الصوت بس (نت أقل)' : 'رجّعنا الصورة');
  }

  function leave() {
    leaving = true;
    clearTimeout(pollTimer);
    if (room) room.disconnect();
    room = null;
    screen('خرجت من الدرس', 'جزاك الله خيراً.', [{ label: 'ادخل تاني', onClick: function () { leaving = false; fetchToken(); } }, mosqueLink()]);
  }

  // ------------------------------------------------------------ chat
  function addChat(participant, text) {
    var role = participant === (room && room.localParticipant) ? me.role : roleOf(participant);
    var m = el('div', { class: 'msg' + (role === 'host' ? ' host' : '') });
    m.appendChild(el('b', null, participant.name || 'مشارك'));
    m.appendChild(document.createTextNode(text));
    var list = $('chatList');
    list.appendChild(m);
    while (list.children.length > 200) list.removeChild(list.firstChild);
    list.scrollTop = list.scrollHeight;
    if (!$('chatSheet').classList.contains('on')) {
      chatUnread++;
      $('chatBadge').textContent = chatUnread > 99 ? '99+' : String(chatUnread);
    }
  }

  function sendChat(e) {
    e.preventDefault();
    var input = $('chatInput');
    var text = input.value.trim().slice(0, 300);
    if (!text || !room) return;
    if (Date.now() - lastChatAt < 2000) return toast('استنى ثانيتين قبل الرسالة الجاية');
    lastChatAt = Date.now();
    send('chat', { text: text }).then(function () {
      addChat(room.localParticipant, text);
      input.value = '';
    }, function () { toast('الرسالة ماوصلتش'); });
  }

  // ------------------------------------------------------------ host
  function refreshHands() {
    if (!me || me.role !== 'host') return;
    call('hands').then(function (r) {
      if (r.status !== 200) return;
      hostHands = r.body.hands || [];
      var raised = hostHands.filter(function (h) { return h.hand_raised_at; }).length;
      $('handBadge').textContent = raised ? String(raised) : '';
      renderHands();
    });
  }

  function hostAction(action, extra, done) {
    call(action, extra).then(function (r) {
      if (r.status !== 200) return toast((r.body && r.body.error) || 'مقدرناش، جرّب تاني');
      if (done) toast(done);
      refreshHands();
    });
  }

  function renderHands() {
    var box = $('handsList');
    box.textContent = '';
    if (!hostHands.length) return box.appendChild(el('p', { class: 'hint' }, 'مفيش حد رافع إيده'));
    hostHands.forEach(function (h) {
      var row = el('div', { class: 'item' });
      row.appendChild(el('span', { class: 'n' }, (h.is_speaker ? '🎙️ ' : '✋ ') + h.name + (h.can_speak ? '' : ' (رقمه مش موثّق)')));
      if (h.is_speaker) {
        row.appendChild(el('button', { class: 'btn ghost small', onclick: function () { hostAction('speaker', { participant: h.participant_id, speaker: false }, 'رجع مستمع'); } }, 'رجّعه مستمع'));
      } else {
        var b = el('button', { class: 'btn small', onclick: function () { hostAction('speaker', { participant: h.participant_id, speaker: true }, 'دلوقتي يقدر يتكلم'); } }, 'خليه يتكلم');
        if (!h.can_speak) b.disabled = true;
        row.appendChild(b);
      }
      box.appendChild(row);
    });
  }

  function renderPeople() {
    var box = $('peopleList');
    if (!$('hostSheet').classList.contains('on')) return;
    box.textContent = '';
    var any = false;
    room.remoteParticipants.forEach(function (p) {
      any = true;
      var role = roleOf(p);
      var row = el('div', { class: 'item' });
      row.appendChild(el('span', { class: 'n' }, (role === 'host' ? '🛡️ ' : role === 'speaker' ? '🎙️ ' : '🎧 ') + (p.name || 'مشارك')));
      if (role !== 'host') {
        var mic = pubOf(p, LK.Track.Source.Microphone);
        if (mic && !mic.isMuted) {
          row.appendChild(el('button', { class: 'btn ghost small', onclick: function () { hostAction('mute', { participant: p.identity, track_sid: mic.trackSid }, 'اتكتم'); } }, 'اكتم'));
        }
        if (role === 'speaker') {
          row.appendChild(el('button', { class: 'btn ghost small', onclick: function () { hostAction('speaker', { participant: p.identity, speaker: false }, 'رجع مستمع'); } }, 'مستمع'));
        }
        row.appendChild(el('button', { class: 'btn danger small', onclick: function () {
          if (confirm('تطلّع «' + (p.name || 'المشارك') + '» من الدرس؟ مش هيقدر يدخل تاني.')) hostAction('remove', { participant: p.identity }, 'طلع من الدرس');
        } }, 'طلّعه'));
      }
      box.appendChild(row);
    });
    if (!any) box.appendChild(el('p', { class: 'hint' }, 'لسه محدش دخل'));
  }

  function endLesson() {
    if (!confirm('تنهي الدرس للكل؟')) return;
    $('bEnd').disabled = true;
    call('end').then(function (r) {
      $('bEnd').disabled = false;
      if (r.status !== 200) return toast((r.body && r.body.error) || 'مقدرناش ننهي الدرس');
      leaving = true;
      if (room) room.disconnect();
      room = null;
      screen('الدرس خلص', 'جزاك الله خيراً — الدرس مش بيتسجّل.', [mosqueLink()]);
    });
  }

  // ------------------------------------------------------------ sheets
  function closeSheets() {
    document.querySelectorAll('.sheet.on').forEach(function (s) { s.classList.remove('on'); });
  }

  function openSheet(id) {
    var on = $(id).classList.contains('on');
    closeSheets();
    if (on) return;
    $(id).classList.add('on');
    if (id === 'chatSheet') {
      chatUnread = 0;
      $('chatBadge').textContent = '';
      $('chatList').scrollTop = $('chatList').scrollHeight;
    }
    if (id === 'hostSheet') {
      refreshHands();
      renderPeople();
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    $('bMic').addEventListener('click', function () { setMic(!room.localParticipant.isMicrophoneEnabled); });
    $('bCam').addEventListener('click', function () { setCam(!room.localParticipant.isCameraEnabled); });
    $('bHand').addEventListener('click', toggleHand);
    $('bVideoOff').addEventListener('click', toggleVideoOff);
    $('bChat').addEventListener('click', function () { openSheet('chatSheet'); });
    $('bHost').addEventListener('click', function () { openSheet('hostSheet'); });
    $('bLeave').addEventListener('click', leave);
    $('bEnd').addEventListener('click', endLesson);
    $('chatForm').addEventListener('submit', sendChat);
    $('bTap').addEventListener('click', function () {
      if (room) room.startAudio().then(checkAudio, checkAudio);
    });
    document.querySelectorAll('[data-close]').forEach(function (b) {
      b.addEventListener('click', function () { $(b.getAttribute('data-close')).classList.remove('on'); });
    });
    window.addEventListener('pagehide', function () { if (room) { leaving = true; room.disconnect(); } });
    start();
  });
})();
