// Anonymous usage counters for the admin page (admin/).
// Adds 1 to counters at stats/total/<key> and stats/days/<YYYY-MM-DD KST>/<key>
// through the Realtime Database REST API, so visitors do not hold a live connection.
// Keys: visits (page loads, once per tab), visitors (new browsers), dayVisitors
// (browsers seen today), single (CPU games started), multi (friend games started).
(function () {
  var cfg = window.FIREBASE_CONFIG;
  var h = location.hostname;
  if (!cfg || !cfg.databaseURL || location.protocol === 'file:' || h === 'localhost' || h === '127.0.0.1') { window.ndTrack = function () {}; return; }
  function day() { return new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10); }
  function ls(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } }
  function ss(k, v) { try { if (v === undefined) return sessionStorage.getItem(k); sessionStorage.setItem(k, v); } catch (e) { return null; } }
  function add(keys) {
    var d = day(), body = {}, inc = { '.sv': { increment: 1 } };
    keys.forEach(function (k) { body['total/' + k] = inc; body['days/' + d + '/' + k] = inc; });
    try { fetch(cfg.databaseURL + '/stats.json', { method: 'PATCH', body: JSON.stringify(body), keepalive: true }).catch(function () {}); } catch (e) { /* ignore */ }
  }
  window.ndTrack = function (k) { if (k === 'single' || k === 'multi') add([k]); };
  if (!ss('nd-visit')) {
    ss('nd-visit', '1');
    var keys = ['visits'];
    if (!ls('nd-seen')) { ls('nd-seen', '1'); keys.push('visitors'); }
    if (ls('nd-seen-day') !== day()) { ls('nd-seen-day', day()); keys.push('dayVisitors'); }
    add(keys);
  }
})();
