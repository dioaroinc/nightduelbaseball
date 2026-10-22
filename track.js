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
  if (!cfg || !cfg.databaseURL || location.protocol === 'file:' || h === 'localhost' || h === '127.0.0.1') { window.ndTrack = function () {}; return; }
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
  add('stats', seen('nd-'));
  add('stats/g/' + sec, seen('nd-' + sec + '-'));
})();
