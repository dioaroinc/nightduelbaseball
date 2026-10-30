// Daily play limit, shared by every page (copied inline by tools/apply-loader.py).
// Counts time on game pages while the tab is visible and the player touched it in the last minute.
// The total is per device (localStorage) and resets at local midnight.
// When it runs out mid-game, the player gets GRACE_MIN more minutes to finish that game;
// starting a new game, or opening any page, after that shows the "come back tomorrow" screen.
// A device logged in to the admin page (admin/) has no limit.
(function () {
  var LIMIT_MIN = 120;  // minutes of play per day
  var GRACE_MIN = 3;    // extra minutes to finish the game that was running when time ran out
  var WARN_MIN = 5;     // show a "5 min left" note at this point
  var IDLE_SEC = 60;    // no touch for this long = not playing

  var KEY = 'nd-playtime', ADMIN = 'f8e68e8d44bfb5314974a97f787d017ff6ac9d0046083f28665fcf96f0cef80c';
  var LIMIT = LIMIT_MIN * 60e3, GRACE = GRACE_MIN * 60e3;
  function get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function put(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
  if (get('nd-admin') === ADMIN) return;

  var sec = (location.pathname.split('/')[1] || '').toLowerCase();
  var hub = !sec || sec === 'index.html';
  function today() { var d = new Date(); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); }
  function used() { var s; try { s = JSON.parse(get(KEY)); } catch (e) { s = null; } return s && s.d === today() ? s.ms || 0 : 0; }
  function add(ms) { put(KEY, JSON.stringify({ d: today(), ms: used() + ms })); }
  function mmss(ms) { var s = Math.max(0, Math.ceil(ms / 1000)); return Math.floor(s / 60) + ':' + ('0' + s % 60).slice(-2); }
  function untilMidnight() {
    var n = new Date(), m = new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1), min = Math.ceil((m - n) / 60e3);
    return (min >= 60 ? Math.floor(min / 60) + 'h ' : '') + min % 60 + 'm';
  }

  var css = '#ptOver{position:fixed;inset:0;z-index:2147483646;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(10,17,29,.985);color:#f1ecdc;font:15px/1.5 system-ui,-apple-system,sans-serif;text-align:center;touch-action:none}' +
    '#ptOver .b{max-width:320px}#ptOver .i{font-size:54px;line-height:1}#ptOver h2{margin:14px 0 8px;font:800 34px/1 "Saira Condensed",system-ui,sans-serif;text-transform:uppercase;color:#ffbb4a}' +
    '#ptOver p{margin:0 0 6px;color:#9aa3b5}#ptOver b{color:#f1ecdc}' +
    '#ptToast{position:fixed;left:50%;top:calc(env(safe-area-inset-top,0px) + 12px);transform:translateX(-50%);z-index:2147483645;max-width:90vw;padding:8px 14px;border-radius:999px;background:#121c2e;border:1px solid #ffbb4a;color:#f1ecdc;font:600 13px/1.3 system-ui,-apple-system,sans-serif;text-align:center;pointer-events:none;transition:opacity .4s}' +
    '#ptLeft{display:inline-block;margin:0 0 18px;padding:5px 12px;border-radius:999px;background:#121c2e;border:1px solid #2a3a58;color:#9aa3b5;font-size:13px}#ptLeft b{color:#ffbb4a;font-variant-numeric:tabular-nums}';
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  var over = null, overDay = '';
  function block() {
    if (over) return;
    overDay = today();
    over = document.createElement('div'); over.id = 'ptOver'; over.setAttribute('role', 'dialog');
    over.innerHTML = '<div class="b"><div class="i">🌙</div><h2>That\'s all for today</h2>' +
      '<p>You played <b>' + LIMIT_MIN + ' minutes</b> today.</p><p>Come back tomorrow for more games!</p>' +
      '<p style="margin-top:14px;font-size:13px">New time in <b id="ptReset">' + untilMidnight() + '</b></p></div>';
    // keep taps from reaching the game underneath
    ['pointerdown', 'pointerup', 'touchstart', 'touchend', 'mousedown', 'click'].forEach(function (t) {
      over.addEventListener(t, function (e) { e.stopPropagation(); e.preventDefault(); }, { passive: false });
    });
    document.body.appendChild(over);
  }
  var toastT;
  function toast(html, ms) {
    var t = document.getElementById('ptToast');
    if (!t) { t = document.createElement('div'); t.id = 'ptToast'; document.body.appendChild(t); }
    t.innerHTML = html; t.style.opacity = '1';
    clearTimeout(toastT); toastT = setTimeout(function () { t.style.opacity = '0'; }, ms || 4000);
  }

  // over the limit already: show the screen right away, on any page
  if (used() >= LIMIT) block();

  // a new game started after time ran out (the game pages call ndTrack when a game starts)
  function hookTrack() {
    var f = window.ndTrack;
    if (typeof f !== 'function' || f.pt) return;
    var w = function (k) { if ((k === 'single' || k === 'multi') && used() >= LIMIT) block(); return f.apply(this, arguments); };
    w.pt = 1; window.ndTrack = w;
  }
  hookTrack();
  document.addEventListener('DOMContentLoaded', hookTrack);
  addEventListener('load', hookTrack);

  // remaining time chip on the game picker
  var chip = null;
  function showChip() {
    if (!hub || chip) return;
    var games = document.querySelector('.games'); if (!games) return;
    chip = document.createElement('div'); chip.id = 'ptLeft';
    games.parentNode.insertBefore(chip, games);
  }
  if (hub) document.addEventListener('DOMContentLoaded', showChip);

  var lastInput = Date.now(), last = Date.now();
  ['pointerdown', 'touchstart', 'keydown', 'wheel'].forEach(function (t) {
    addEventListener(t, function () { lastInput = Date.now(); }, { capture: true, passive: true });
  });
  var warned = used() >= LIMIT - WARN_MIN * 60e3, ended = used() >= LIMIT;
  setInterval(function () {
    var now = Date.now(), dt = Math.min(now - last, 5000); last = now;
    if (over && today() !== overDay) { over.remove(); over = null; warned = ended = false; } // a new day
    var playing = !hub && !over && document.visibilityState === 'visible' && now - lastInput < IDLE_SEC * 1000;
    if (playing) add(dt);
    var u = used();
    if (chip) chip.innerHTML = u >= LIMIT ? 'No play time left today' : 'Play time left today <b>' + mmss(LIMIT - u) + '</b>';
    if (over) { var r = document.getElementById('ptReset'); if (r) r.textContent = untilMidnight(); return; }
    if (hub) { if (u >= LIMIT) block(); return; }
    if (!warned && u >= LIMIT - WARN_MIN * 60e3) { warned = true; toast('⏱ ' + WARN_MIN + ' minutes of play left today'); }
    if (!ended && u >= LIMIT) { ended = true; toast('⏱ Time\'s up for today. Finish this game!', 6000); }
    if (u >= LIMIT + GRACE) block();
  }, 1000);
})();
