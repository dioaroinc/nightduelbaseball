// Anonymous usage counters for the admin page (admin/), sent through the
// Realtime Database REST API so visitors do not hold a live connection.
//
// Site-wide (any page):  stats/total/<key> and stats/days/<YYYY-MM-DD KST>/<key>
//   visits (once per tab), visitors (new browser), dayVisitors (browser seen today)
// Per section:           stats/g/<section>/total/<key> and stats/g/<section>/days/<day>/<key>
//   the same three keys, plus single (CPU games) and multi (friend games, host side)
// The section is the first path segment (baseball, tennis, ...), or "hub" for the game picker.
// Older baseball game counts from before the per-section split live in stats/total|days single/multi.
(function () {
  var cfg = window.FIREBASE_CONFIG;
  var h = location.hostname;
  if (!cfg || !cfg.databaseURL || location.protocol === 'file:' || h === 'localhost' || h === '127.0.0.1') { window.ndTrack = window.ndRankSync = function () {}; return; }
  var sec = (location.pathname.split('/')[1] || '').toLowerCase();
  if (!/^[a-z]{2,20}$/.test(sec) || sec === 'index') sec = 'hub';
  function day() { return new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10); }
  function ls(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } }
  function ss(k, v) { try { if (v === undefined) return sessionStorage.getItem(k); sessionStorage.setItem(k, v); } catch (e) { return null; } }
  // one request per area, so a rule that refuses one area does not drop the other
  function add(base, keys) {
    if (!keys.length) return;
    var d = day(), body = {}, inc = { '.sv': { increment: 1 } };
    keys.forEach(function (k) { body['total/' + k] = inc; body['days/' + d + '/' + k] = inc; });
    try { fetch(cfg.databaseURL + '/' + base + '.json', { method: 'PATCH', body: JSON.stringify(body), keepalive: true }).catch(function () {}); } catch (e) { /* ignore */ }
  }
  // which of visits/visitors/dayVisitors are new for this storage prefix
  function seen(p) {
    var keys = [];
    if (!ss(p + 'visit')) { ss(p + 'visit', '1'); keys.push('visits'); }
    if (!ls(p + 'seen')) { ls(p + 'seen', '1'); keys.push('visitors'); }
    if (ls(p + 'seen-day') !== day()) { ls(p + 'seen-day', day()); keys.push('dayVisitors'); }
    return keys;
  }
  window.ndTrack = function (k) { if (k === 'single' || k === 'multi') add('stats/g/' + sec, [k]); };
  // ---------------- Ranking (rank/<game>/<NAME_NUM>, shown on rank/) ----------------
  // Each game's own save holds the player's name + number and their records. The best record per
  // game is sent when it beats what this browser sent before (and the rules only take higher ones).
  // Score games send r (raw best) and lv (0-2); s = r * (lv + 4), so Normal counts 1.25x and Pro 1.5x Easy.
  // Win games (baseball, tennis, soccer) send s = total wins on this device.
  function load(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }
  function arr(a) { return Array.isArray(a) ? a : []; }
  function lvBest(st) { // per-level bests, plus the old single best (counted as Easy)
    var b = arr(st.lvBest || st.best).slice(0, 3);
    if (typeof st.best === 'number') b = [Math.max(b[0] || 0, st.best), b[1] || 0, b[2] || 0];
    return b;
  }
  var RANK = {
    baseball: ['nightduel_v1', function (sv) { return { s: (sv.wins | 0) }; }],
    clay: ['skyclay_v1', lvBest],
    soccer: ['spotkick_v1', function (st) { return { s: (st.wins | 0) + (st.mpWins | 0) }; }],
    basketball: ['swishshot_v1', lvBest],
    bowling: ['bowling_v1', lvBest],
    tennis: ['bptennis_v1', function (st) { return { s: (st.wins | 0) }; }],
    ballboy: ['ballboy_v1', lvBest],
    surf: ['crestrider_v1', lvBest],
  };
  window.ndRankSync = function () {
    var mark = load('nd-rank') || {};
    Object.keys(RANK).forEach(function (g) {
      var sv = load(RANK[g][0]);
      if (!sv || !sv.stats || !sv.settings || !sv.settings.player) return;
      var pl = sv.settings.player;
      var n = String(pl.name || '').toUpperCase().replace(/[^A-Z0-9 .'-]/g, '').trim().slice(0, 10);
      var u = String(pl.num == null ? '' : pl.num).replace(/\D/g, '').slice(0, 2);
      if (!n || !u) return;
      var rec;
      try { rec = RANK[g][1](g === 'baseball' ? sv : sv.stats); } catch (e) { return; }
      if (Array.isArray(rec)) { // score game: the level whose weighted best is highest
        var top = null;
        rec.forEach(function (v, lv) { v = Math.round(+v || 0); if (v > 0 && v <= 20000 && (!top || v * (lv + 4) > top.s)) top = { s: v * (lv + 4), r: v, lv: lv }; });
        rec = top;
      }
      if (!rec || !(rec.s > 0) || rec.s > 100000) return;
      var key = n.replace(/ /g, '+').replace(/\./g, '!') + '_' + u, mk = g + '/' + key;
      if ((mark[mk] || 0) >= rec.s) return;
      var body = { n: n, u: u, s: rec.s, t: { '.sv': 'timestamp' } };
      if (rec.r != null) { body.r = rec.r; body.lv = rec.lv; }
      try {
        fetch(cfg.databaseURL + '/rank/' + g + '/' + encodeURIComponent(key) + '.json', { method: 'PATCH', body: JSON.stringify(body), keepalive: true })
          .then(function (r) {
            // a refused one (the board already has a higher record under this name) is tried again next load
            if (r.ok) { var m2 = load('nd-rank') || {}; m2[mk] = Math.max(m2[mk] || 0, rec.s); try { localStorage.setItem('nd-rank', JSON.stringify(m2)); } catch (e) { /* ignore */ } }
          }).catch(function () {});
      } catch (e) { /* ignore */ }
    });
  };
  setTimeout(window.ndRankSync, 1500);

  add('stats', seen('nd-'));
  add('stats/g/' + sec, seen('nd-' + sec + '-'));
})();
