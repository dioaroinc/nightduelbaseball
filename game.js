(() => {
  const E = Engine;
  const $ = (id) => document.getElementById(id);
  const cv = $('cv'), ctx = cv.getContext('2d');
  let W = 0, H = 0, DPR = 1;
  const KMH = 1.609;

  // ---------------- Persistence ----------------
  const KEY = 'nightduel_v1';
  const fresh = () => ({
    settings: { role: 'pitcher', myHand: 'R', cpuHand: 'R', speed: 0.75, zone: true, sound: true },
    stats: E.newStats(),
    games: { pitcher: E.newState(), batter: E.newState() },
    logs: { pitcher: [], batter: [] },
  });
  let save = (() => {
    try {
      const s = JSON.parse(localStorage.getItem(KEY));
      if (s && s.stats && s.games && s.settings) return s;
    } catch (e) { /* storage unavailable */ }
    return fresh();
  })();
  const persist = () => { try { localStorage.setItem(KEY, JSON.stringify(save)); } catch (e) { /* ignore */ } };
  const S = save.settings;
  if (!save.mpStats) save.mpStats = E.newStats();
  if (!save.mpLogs) save.mpLogs = [];
  if (!S.myThrow) { S.myThrow = S.myHand || 'R'; S.myBat = S.myHand || 'R'; S.cpuThrow = S.cpuHand || 'R'; S.cpuBat = S.cpuHand || 'R'; }
  if (!S.batMixV3) { S.cpuBat = 'X'; S.batMixV3 = true; } // each CPU batter steps in as a random lefty or righty by default
  const newDuel = () => Object.assign(E.newState(), { half: 0, score: { me: 0, opp: 0 } });
  if (!save.games.duel) save.games.duel = newDuel();
  const st = () => (G.mp ? G.mp.state : save.games.duel);
  if (!S.units) S.units = 'mph';
  if (S.cpuPitchLv == null) S.cpuPitchLv = 1;
  if (S.cpuBatLv == null) S.cpuBatLv = 1;
  if (![3, 6, 9].includes(S.mpInn)) S.mpInn = 3;
  if (![0, 3, 6, 9].includes(S.innings)) S.innings = 9; // vs CPU; 0 = endless
  const metric = () => S.units === 'kmh';
  const spd = (mph, d = 0) => (metric() ? `${(mph * KMH).toFixed(d)} km/h` : `${mph.toFixed(d)} mph`);
  const distNum = (ft) => String(Math.round(metric() ? ft * 0.3048 : ft));
  const dist = (ft) => `${distNum(ft)} ${metric() ? 'm' : 'ft'}`;

  // ---------------- Runtime ----------------
  const G = {
    started: false, paused: false, phase: 'idle', t0: 0, now: 0,
    pHand: 'R', bHand: 'R',
    pitchType: 'FF', target: { x: 0.45, y: 2.1 },
    pitch: null, cpuDec: null, swing: null, swingAnim: null, outcome: null,
    trail: [], hit: null, fa: null, hudFrozen: false, afterInfo: null, basesBefore: [0, 0, 0],
    reticle: null, pendingInning: false, aim: null, pwr: null, tsLock: 0, freeze: null,
  };
  const TURN_SECS = 20, REMOTE_SECS = 30;
  const POWER_PERIOD = 1300;
  // the first two cycles can reach 100%; after that the peak drops 5% per cycle so stalling costs velocity
  const powerCap = (now) => { const n = Math.floor((now - G.pwr.t0) / POWER_PERIOD); return n < 2 ? 1 : Math.max(0.5, 1 - (n - 1) * 0.05); };
  const powerAt = (now) => { const u = ((now - G.pwr.t0) / POWER_PERIOD) % 1; return (u < 0.5 ? u * 2 : 2 - u * 2) * powerCap(now); };

  // ---------------- Audio ----------------
  let AC = null;
  function audio() {
    if (!S.sound) return null;
    try { if (!AC) AC = new (window.AudioContext || window.webkitAudioContext)(); if (AC.state === 'suspended') AC.resume(); } catch (e) { AC = null; }
    return AC;
  }
  function noise(dur, freq, type, gain) {
    const a = audio(); if (!a) return;
    const n = Math.floor(a.sampleRate * dur), buf = a.createBuffer(1, n, a.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 3);
    const src = a.createBufferSource(); src.buffer = buf;
    const f = a.createBiquadFilter(); f.type = type; f.frequency.value = freq;
    const g = a.createGain(); g.gain.value = gain;
    src.connect(f); f.connect(g); g.connect(a.destination); src.start();
  }
  const sfx = {
    mitt: () => noise(0.09, 700, 'lowpass', 1.4),
    bat: (q) => { noise(0.05, 1800, 'highpass', 0.9 + q); noise(0.12, 500, 'bandpass', 0.6); },
    foul: () => noise(0.04, 2200, 'highpass', 0.5),
  };
  const buzz = (ms) => { try { navigator.vibrate && navigator.vibrate(ms); } catch (e) { /* ignore */ } };

  // ---------------- Camera ----------------
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]); return [a[0] / l, a[1] / l, a[2] / l]; };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  function makeCam(eye, target, f, cyF) {
    const fw = norm(sub(target, eye));
    const r = norm(cross([0, 1, 0], fw));
    const u = cross(fw, r);
    return { eye, fw, r, u, f, cx: W / 2, cy: H * cyF };
  }
  let cam = null;
  function viewCam() {
    if (S.role === 'batter') return makeCam([0, 4.4, -8.8], [0, 1.9, 30], Math.min(H * 1.45, W * 2.1), 0.5);
    return makeCam([0, 22, 180], [0, 3.6, 0], Math.min(H * 9.5, W * 11), 0.42);
  }
  function toCam(c, p) {
    const dx = p[0] - c.eye[0], dy = p[1] - c.eye[1], dz = p[2] - c.eye[2];
    return [dx * c.r[0] + dy * c.r[1] + dz * c.r[2], dx * c.u[0] + dy * c.u[1] + dz * c.u[2], dx * c.fw[0] + dy * c.fw[1] + dz * c.fw[2]];
  }
  const scr = (c, q) => [c.cx + (q[0] / q[2]) * c.f, c.cy - (q[1] / q[2]) * c.f];
  function P(c, x, y, z) {
    const q = toCam(c, [x, y, z]);
    if (q[2] < 0.5) return null;
    const s = scr(c, q);
    return { x: s[0], y: s[1], k: c.f / q[2] };
  }
  function polyPath(c, pts) {
    const q = pts.map((p) => toCam(c, p)), n = 0.5, out = [];
    for (let i = 0; i < q.length; i++) {
      const a = q[i], b = q[(i + 1) % q.length], ain = a[2] >= n, bin = b[2] >= n;
      if (ain) out.push(a);
      if (ain !== bin) { const t = (n - a[2]) / (b[2] - a[2]); out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, n]); }
    }
    if (out.length < 3) return false;
    ctx.beginPath();
    out.forEach((qq, i) => { const s = scr(c, qq); if (i) ctx.lineTo(s[0], s[1]); else ctx.moveTo(s[0], s[1]); });
    ctx.closePath();
    return true;
  }
  const fillPoly = (c, pts, color) => { if (polyPath(c, pts)) { ctx.fillStyle = color; ctx.fill(); } };
  function screenToPlate(c, sx, sy) {
    const a = (sx - c.cx) / c.f, b = -(sy - c.cy) / c.f;
    const d = [c.fw[0] + c.r[0] * a + c.u[0] * b, c.fw[1] + c.r[1] * a + c.u[1] * b, c.fw[2] + c.r[2] * a + c.u[2] * b];
    if (Math.abs(d[2]) < 1e-6) return null;
    const t = (0 - c.eye[2]) / d[2];
    if (t <= 0) return null;
    return { x: c.eye[0] + d[0] * t, y: c.eye[1] + d[1] * t };
  }

  // ---------------- Ballpark geometry ----------------
  const COL = {
    sky0: '#050912', sky1: '#0f2236', grassA: '#2f6f3d', grassB: '#2a6437', foul: '#245632', track: '#8a5a3a',
    dirt: '#a5704a', dirtD: '#94613f', chalk: '#f1ecdc', wall: '#163a33', wallTop: '#f2c94c', stand: '#141c2c', stand2: '#1b2638',
  };
  const g = (x, z, y = 0) => [x, y, z];
  const arc = (cx, cz, r, a0, a1, n, y = 0) => { const pts = []; for (let i = 0; i <= n; i++) { const a = (a0 + (a1 - a0) * i / n) * Math.PI / 180; pts.push(g(cx + r * Math.sin(a), cz + r * Math.cos(a), y)); } return pts; };
  const circle = (cx, cz, r, n = 28) => arc(cx, cz, r, 0, 360, n);
  const GEO = (() => {
    const fan = (inset) => { const p = [g(0, 0)]; for (let a = -45; a <= 45; a += 2.5) { const [x, z] = E.fieldXY(a, E.fenceDist(a) - inset); p.push(g(x, z)); } return p; };
    const dirtArc = arc(0, 60.5, 95, 71.8, -71.8, 30);
    const quadLine = (x0, z0, x1, z1, w) => { const dx = x1 - x0, dz = z1 - z0, l = Math.hypot(dx, dz), nx = -dz / l * w / 2, nz = dx / l * w / 2; return [g(x0 + nx, z0 + nz), g(x1 + nx, z1 + nz), g(x1 - nx, z1 - nz), g(x0 - nx, z0 - nz)]; };
    const base = (bx, bz) => [g(bx, bz - 0.9), g(bx + 0.9, bz), g(bx, bz + 0.9), g(bx - 0.9, bz)];
    const wallB = [], wallT = [], standT = [];
    for (let a = -45; a <= 45; a += 3) {
      const r = E.fenceDist(a), [x, z] = E.fieldXY(a, r), [x2, z2] = E.fieldXY(a, r + 150);
      wallB.push(g(x, z, 0)); wallT.push(g(x, z, 10)); standT.push(g(x2, z2, 85));
    }
    const box = (side) => { const x0 = side * (0.708 + 0.5), x1 = side * (0.708 + 4.5), z0 = -3.6, z1 = 2.4, w = 0.22; return [quadLine(x0, z0, x0, z1, w), quadLine(x1, z0, x1, z1, w), quadLine(x0, z1, x1, z1, w), quadLine(x0, z0, x1, z0, w)]; };
    const crowd = [];
    for (let i = 0; i < 700; i++) {
      const a = -44 + Math.random() * 88, u = Math.random();
      const [x, z] = E.fieldXY(a, E.fenceDist(a) + 6 + u * 140);
      crowd.push({ p: [x, 11 + u * 72, z], c: ['#2c3850', '#3b4a66', '#5a4b52', '#28406a', '#6b6f7e'][i % 5] });
    }
    for (let i = 0; i < 1400; i++) { const u = Math.random(); crowd.push({ p: [-180 + Math.random() * 360, 5.5 + u * 78, -62 - u * 130], c: ['#2c3850', '#3b4a66', '#5a4b52', '#28406a', '#6b6f7e'][i % 5] }); }
    // seat rows between the wall top and the back of the stands
    const standRows = [];
    for (let k = 0; k < 10; k++) {
      const mix = (u) => wallT.map((w, i) => [w[0] + (standT[i][0] - w[0]) * u, w[1] + (standT[i][1] - w[1]) * u, w[2] + (standT[i][2] - w[2]) * u]);
      const a = mix(k / 10), b = mix((k + 0.5) / 10);
      standRows.push([...a, ...b.slice().reverse()]);
    }
    // padded wall panels, alternating shades, with an ad board every few panels
    const wallPanels = [];
    for (let i = 0; i < wallB.length - 1; i++) wallPanels.push({ poly: [wallB[i], wallB[i + 1], wallT[i + 1], wallT[i]], ad: i % 6 === 2 });
    const stars = []; for (let i = 0; i < 90; i++) stars.push([Math.random(), Math.random() * 0.55, 0.6 + Math.random() * 1.1]);
    // packed front rows behind the plate, seen up close from the mound
    const homeCrowd = [];
    const cols = ['#2c3850', '#3b4a66', '#5a4b52', '#28406a', '#6b6f7e', '#7a4a3a', '#8a8a95', '#3d5a6e'];
    for (let k = 0; k < 8; k++) for (let x = -70; x <= 70; x += 2.3) { if (Math.random() < 0.12) continue; homeCrowd.push({ p: [x + (Math.random() - 0.5) * 0.8, 6.2 + k * 2.6, -63 - k * 4.5], c: cols[Math.floor(Math.random() * cols.length)] }); }
    return {
      standRows, wallPanels, stars, homeCrowd,
      board: [g(-56, 500, 30), g(56, 500, 30), g(56, 500, 66), g(-56, 500, 66)],
      boardPost: [g(-3, 499, 10), g(3, 499, 10), g(3, 499, 30), g(-3, 499, 30)],
      vStripes: (() => { const s = []; for (let x = -480; x < 480; x += 30) s.push([g(x, 0), g(x + 15, 0), g(x + 15, 460), g(x, 460)]); return s; })(),
      onDeck: [circle(-25, -40, 2.5, 14), circle(25, -40, 2.5, 14)],
      foul: [g(-700, -59), g(700, -59), g(700, 650), g(-700, 650)],
      track: fan(0), grass: fan(15),
      dirt: [g(0, 0), ...dirtArc, g(0, 0)].slice(0, -1),
      infGrass: [g(0, 9.5), g(54.5, 63.6), g(0, 117.8), g(-54.5, 63.6)],
      mound: circle(0, 60.5, 9), homeDirt: circle(0, -0.7, 13), cut1: circle(63.6, 63.6, 7, 16), cut3: circle(-63.6, 63.6, 7, 16),
      lines: [quadLine(0, 0, 233.3, 233.3, 0.33), quadLine(0, 0, -233.3, 233.3, 0.33), ...box(1), ...box(-1)],
      plate: [g(-0.708, 0), g(0.708, 0), g(0.708, -0.708), g(0, -1.416), g(-0.708, -0.708)],
      rubber: [g(-1, 60.3), g(1, 60.3), g(1, 60.8), g(-1, 60.8)],
      bases: [base(62.8, 63.6), base(0, 127.3), base(-62.8, 63.6)],
      wall: [...wallB, ...wallT.slice().reverse()],
      wallTop: [...wallT, ...wallT.map((p) => [p[0], p[1] + 0.8, p[2]]).reverse()],
      stands: [...wallT, ...standT.slice().reverse()],
      backWall: [g(-200, -60, 0), g(200, -60, 0), g(200, -60, 4.5), g(-200, -60, 4.5)],
      backRail: [g(-200, -59.9, 4.0), g(200, -59.9, 4.0), g(200, -59.9, 4.5), g(-200, -59.9, 4.5)],
      backStand: [g(-200, -61, 4.5), g(200, -61, 4.5), g(220, -200, 85), g(-220, -200, 85)],
      backRows: (() => { const r = []; for (let k = 0; k < 30; k++) { const u0 = k / 30, u1 = (k + 0.5) / 30, L = (u) => [4.5 + 80.5 * u, -61 - 139 * u]; const [y0, z0] = L(u0), [y1, z1] = L(u1); r.push([g(-200 - 20 * u0, z0, y0), g(200 + 20 * u0, z0, y0), g(200 + 20 * u1, z1, y1), g(-200 - 20 * u1, z1, y1)]); } return r; })(),
      net: { x: 42, top: 34 },
      poles: [[233.3, 233.3], [-233.3, 233.3]],
      lights: [[-215, 125, 430], [215, 125, 430], [-95, 140, 520], [95, 140, 520], [-230, 120, -150], [230, 120, -150]],
      crowd,
      stripes: (() => { const s = []; for (let z = 0; z < 430; z += 26) s.push([g(-500, z), g(500, z), g(500, z + 13), g(-500, z + 13)]); return s; })(),
    };
  })();

  function drawPark(c) {
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, COL.sky0); sky.addColorStop(0.6, COL.sky1); sky.addColorStop(1, '#0c1a2a');
    ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(255,255,255,.55)';
    for (const [u, v, r] of GEO.stars) { ctx.beginPath(); ctx.arc(u * W, v * H * 0.5, r, 0, 7); ctx.fill(); }
    // light towers glow
    for (const L of GEO.lights) {
      const p = P(c, L[0], L[1], L[2]); if (!p) continue;
      const r = Math.max(30, p.k * 40);
      const gr = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
      gr.addColorStop(0, 'rgba(255,248,225,.55)'); gr.addColorStop(0.25, 'rgba(255,240,200,.12)'); gr.addColorStop(1, 'rgba(255,240,200,0)');
      ctx.fillStyle = gr; ctx.fillRect(p.x - r, p.y - r, r * 2, r * 2);
    }
    fillPoly(c, GEO.stands, COL.stand);
    for (const r of GEO.standRows) fillPoly(c, r, COL.stand2);
    fillPoly(c, GEO.backStand, COL.stand);
    for (const r of GEO.backRows) fillPoly(c, r, COL.stand2);
    for (const q of (c.eye[2] > 0 ? GEO.crowd.concat(GEO.homeCrowd) : GEO.crowd)) {
      const p = P(c, q.p[0], q.p[1], q.p[2]); if (!p) continue; const s = Math.max(1, p.k * 1.4);
      ctx.fillStyle = q.c;
      if (s < 7) ctx.fillRect(p.x, p.y, s, s);
      else { // close enough to read as a person: shoulders plus a head
        ctx.beginPath(); ctx.ellipse(p.x, p.y + s * 0.25, s * 0.55, s * 0.4, 0, 0, 7); ctx.fill();
        ctx.fillStyle = '#c99272'; ctx.beginPath(); ctx.arc(p.x, p.y - s * 0.3, s * 0.22, 0, 7); ctx.fill();
      }
    }
    fillPoly(c, GEO.foul, COL.foul);
    fillPoly(c, GEO.track, COL.track);
    if (polyPath(c, GEO.grass)) {
      ctx.fillStyle = COL.grassA; ctx.fill();
      ctx.save(); ctx.clip();
      for (const s of GEO.stripes) fillPoly(c, s, COL.grassB);
      ctx.globalAlpha = 0.35;
      for (const s of GEO.vStripes) fillPoly(c, s, COL.grassB);
      ctx.restore();
    }
    for (const o of GEO.onDeck) fillPoly(c, o, COL.dirt);
    fillPoly(c, GEO.dirt, COL.dirt);
    fillPoly(c, GEO.infGrass, COL.grassA);
    fillPoly(c, GEO.cut1, COL.dirt); fillPoly(c, GEO.cut3, COL.dirt);
    fillPoly(c, GEO.mound, COL.dirtD);
    fillPoly(c, GEO.homeDirt, COL.dirt);
    for (const l of GEO.lines) fillPoly(c, l, COL.chalk);
    fillPoly(c, GEO.plate, '#ffffff');
    fillPoly(c, GEO.rubber, '#ffffff');
    for (const b of GEO.bases) fillPoly(c, b, '#ffffff');
    for (let i = 0; i < GEO.wallPanels.length; i++) { const w = GEO.wallPanels[i]; fillPoly(c, w.poly, w.ad ? '#1f3d6b' : i % 2 ? COL.wall : '#1a443c'); }
    fillPoly(c, GEO.wallTop, COL.wallTop);
    // distance markers painted on the wall
    ctx.fillStyle = COL.chalk; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const a of [-45, -22, 0, 22, 45]) {
      const r = E.fenceDist(a), [x, z] = E.fieldXY(a, r - 0.5), m = P(c, x, 5.5, z);
      if (m && m.k > 0.5) { ctx.font = `700 ${Math.max(6, m.k * 5.5)}px "Saira Condensed", sans-serif`; ctx.fillText(distNum(r), m.x, m.y); }
    }
    ctx.textBaseline = 'alphabetic';
    drawTowers(c);
    fillPoly(c, GEO.backWall, '#1c4a44');
    for (let x = -200; x <= 200; x += 8) fillPoly(c, [g(x - 0.15, -59.95, 0), g(x + 0.15, -59.95, 0), g(x + 0.15, -59.95, 4.5), g(x - 0.15, -59.95, 4.5)], '#143730');
    fillPoly(c, GEO.backRail, COL.wallTop);
    drawNet(c);
    for (const [x, z] of GEO.poles) {
      const a = P(c, x, 0, z), b = P(c, x, 60, z);
      if (a && b) { ctx.strokeStyle = COL.wallTop; ctx.lineWidth = Math.max(1, a.k * 0.8); ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
    }
  }

  // protective netting behind the plate, only visible from the mound
  function drawNet(c) {
    if (c.eye[2] < 0) return;
    const N = GEO.net, a = P(c, -N.x, 4.5, -60), b = P(c, N.x, N.top, -60); if (!a || !b) return;
    ctx.save(); ctx.strokeStyle = 'rgba(10,16,28,.5)'; ctx.lineWidth = 1; ctx.beginPath();
    for (let x = -N.x; x <= N.x; x += 2.5) { const p = P(c, x, 4.5, -60), q = P(c, x, N.top, -60); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); }
    for (let y = 4.5; y <= N.top; y += 2.5) { const p = P(c, -N.x, y, -60), q = P(c, N.x, y, -60); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); }
    ctx.stroke();
    // net poles
    ctx.strokeStyle = '#3a4559'; ctx.lineWidth = Math.max(1.5, a.k * 0.6); ctx.beginPath();
    for (const x of [-N.x, N.x]) { const p = P(c, x, 0, -60), q = P(c, x, N.top, -60); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); }
    ctx.stroke(); ctx.restore();
  }
  // center field scoreboard, showing the live score
  function drawScoreboard(c) {
    fillPoly(c, GEO.boardPost, '#2a3447');
    if (!polyPath(c, GEO.board)) return;
    ctx.fillStyle = '#0b0f16'; ctx.fill(); ctx.strokeStyle = '#3a4559'; ctx.lineWidth = 1; ctx.stroke();
    const m = P(c, 0, 48, 500); if (!m || m.k < 0.4) return;
    const s = st(), k = m.k;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = COL.wallTop; ctx.font = `800 ${k * 7}px "Saira Condensed", sans-serif`;
    ctx.fillText('NIGHT DUEL', m.x, m.y - k * 11);
    ctx.fillStyle = '#ffd36a'; ctx.font = `800 ${k * 12}px "Saira Condensed", sans-serif`;
    ctx.fillText(`${G.mp ? 'FRIEND' : 'CPU'} ${s.score.opp}   YOU ${s.score.me}`, m.x, m.y + k * 1);
    ctx.fillStyle = '#9bb0d6'; ctx.font = `700 ${k * 6}px "Saira Condensed", sans-serif`;
    ctx.fillText(`${s.half ? 'BOT' : 'TOP'} ${s.inning}   B ${s.balls}  S ${s.strikes}  O ${s.outs}`, m.x, m.y + k * 12);
    ctx.textBaseline = 'alphabetic';
  }
  // light towers: pole plus a bank of bulbs, billboarded toward the camera
  function drawTowers(c) {
    for (const L of GEO.lights) {
      const a = P(c, L[0], 0, L[2]), b = P(c, L[0], L[1], L[2]); if (!a || !b) continue;
      ctx.strokeStyle = '#2a3346'; ctx.lineWidth = Math.max(1, b.k * 2.5); ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      const w = b.k * 26, h = b.k * 11; if (w < 3) continue;
      ctx.fillStyle = '#1b2232'; ctx.fillRect(b.x - w / 2, b.y - h, w, h);
      ctx.fillStyle = '#fff6dc';
      const cols = 6, rows = 2, bw = w / cols, bh = h / rows;
      for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) ctx.fillRect(b.x - w / 2 + i * bw + bw * 0.15, b.y - h + j * bh + bh * 0.15, bw * 0.7, bh * 0.7);
    }
  }

  function drawZone(c, alpha) {
    const Z = E.ZONE;
    const pts = [[-Z.x, Z.bot], [Z.x, Z.bot], [Z.x, Z.top], [-Z.x, Z.top]].map(([x, y]) => P(c, x, y, 0));
    if (pts.some((p) => !p)) return;
    ctx.save(); ctx.globalAlpha = alpha;
    ctx.strokeStyle = COL.chalk; ctx.lineWidth = 1.5;
    ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath(); ctx.stroke();
    ctx.globalAlpha = alpha * 0.4; ctx.lineWidth = 1; ctx.setLineDash([3, 4]);
    for (let i = 1; i < 3; i++) {
      const x = -Z.x + (2 * Z.x * i) / 3, y = Z.bot + ((Z.top - Z.bot) * i) / 3;
      const a = P(c, x, Z.bot, 0), b = P(c, x, Z.top, 0), d = P(c, -Z.x, y, 0), e = P(c, Z.x, y, 0);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.moveTo(d.x, d.y); ctx.lineTo(e.x, e.y); ctx.stroke();
    }
    ctx.restore();
  }

  // ---------------- Figures ----------------
  // Each player is drawn in feet on an offscreen canvas (origin at the feet, +y up),
  // then shaded with stadium light and composited into the scene.
  const TEAM = {
    me: { jersey: '#ede8db', jerseyD: '#c9c3b3', trim: '#1d3a78', pants: '#e6e0d1', sock: '#1d3a78', helmet: '#1d3a78', cap: '#1d3a78', glove: '#7a4a24', skin: '#c99272', name: 'KIM', num: '21' },
    cpu: { jersey: '#9aa1b0', jerseyD: '#7b8292', trim: '#a51e2e', pants: '#aeb4c1', sock: '#a51e2e', helmet: '#a51e2e', cap: '#a51e2e', glove: '#5b3a1e', skin: '#b98263', name: 'CPU', num: '45' },
  };
  const ease = (t) => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  const lerp = (a, b, t) => a + (b - a) * t;
  function keyf(frames, t) {
    if (t <= frames[0][0]) return frames[0].slice(1);
    for (let i = 1; i < frames.length; i++) {
      if (t <= frames[i][0]) { const a = frames[i - 1], b = frames[i], u = ease((t - a[0]) / (b[0] - a[0])); return a.slice(1).map((v, j) => lerp(v, b[j + 1], u)); }
    }
    return frames[frames.length - 1].slice(1);
  }

  const oc = document.createElement('canvas');
  let X = oc.getContext('2d');
  // tapered limb segment between two joints
  function seg(a, b, ra, rb, col) {
    const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1e-6;
    const nx = -dy / l, ny = dx / l;
    X.fillStyle = col; X.beginPath();
    X.moveTo(a[0] + nx * ra, a[1] + ny * ra); X.lineTo(b[0] + nx * rb, b[1] + ny * rb);
    X.lineTo(b[0] - nx * rb, b[1] - ny * rb); X.lineTo(a[0] - nx * ra, a[1] - ny * ra); X.closePath(); X.fill();
    X.beginPath(); X.arc(a[0], a[1], ra, 0, 7); X.fill();
    X.beginPath(); X.arc(b[0], b[1], rb, 0, 7); X.fill();
  }
  const dot = (p, r, col) => { X.fillStyle = col; X.beginPath(); X.arc(p[0], p[1], r, 0, 7); X.fill(); };
  const ell = (x, y, rx, ry, rot, col) => { X.fillStyle = col; X.beginPath(); X.ellipse(x, y, rx, ry, rot, 0, 7); X.fill(); };
  function poly(pts, col) { X.fillStyle = col; X.beginPath(); pts.forEach((p, i) => (i ? X.lineTo(p[0], p[1]) : X.moveTo(p[0], p[1]))); X.closePath(); X.fill(); }
  // smooth closed shape through points (quadratic midpoints)
  function blob(pts, col) {
    X.fillStyle = col; X.beginPath();
    const n = pts.length, mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    let m = mid(pts[n - 1], pts[0]); X.moveTo(m[0], m[1]);
    for (let i = 0; i < n; i++) { const p = pts[i], q = mid(p, pts[(i + 1) % n]); X.quadraticCurveTo(p[0], p[1], q[0], q[1]); }
    X.closePath(); X.fill();
  }
  // leg = hip -> knee -> ankle with pants, sock and cleat
  function leg(hip, knee, ankle, T, toeDir, shade) {
    const pants = shade ? T.jerseyD : T.pants;
    seg(hip, knee, 0.34, 0.24, pants);
    const calf = [lerp(knee[0], ankle[0], 0.55), lerp(knee[1], ankle[1], 0.55)];
    seg(knee, calf, 0.24, 0.2, pants);
    seg(calf, ankle, 0.2, 0.13, T.sock);
    ell(ankle[0] + toeDir * 0.22, ankle[1] - 0.08, 0.38, 0.15, 0, '#15171c');
  }

  function renderFigure(sx, sy, k, flip, alpha, wft, hft, draw, shade = 1) {
    if (k * hft < 4) return;
    const s = k * DPR;
    const pw = Math.ceil(wft * s), ph = Math.ceil(hft * s);
    if (pw > 4096 || ph > 4096) return;
    if (oc.width < pw || oc.height < ph) { oc.width = Math.max(oc.width, pw); oc.height = Math.max(oc.height, ph); X = oc.getContext('2d'); }
    X.setTransform(1, 0, 0, 1, 0, 0); X.globalCompositeOperation = 'source-over'; X.globalAlpha = 1;
    X.clearRect(0, 0, pw, ph);
    const base = 0.4 * s;
    X.setTransform(s * flip, 0, 0, -s, pw / 2, ph - base);
    X.lineCap = 'round'; X.lineJoin = 'round';
    draw();
    // stadium lighting: bright from above, falling off toward the feet, rim on one side
    X.setTransform(1, 0, 0, 1, 0, 0);
    X.globalCompositeOperation = 'source-atop';
    let gr = X.createLinearGradient(0, 0, 0, ph);
    gr.addColorStop(0, `rgba(255,250,235,${0.16 * shade})`); gr.addColorStop(0.45, 'rgba(255,250,235,0)'); gr.addColorStop(1, `rgba(5,10,20,${0.42 * shade})`);
    X.fillStyle = gr; X.fillRect(0, 0, pw, ph);
    gr = X.createLinearGradient(0, 0, pw, 0);
    gr.addColorStop(0, `rgba(255,255,255,${0.10 * shade})`); gr.addColorStop(0.5, 'rgba(0,0,0,0)'); gr.addColorStop(1, `rgba(5,10,20,${0.30 * shade})`);
    X.fillStyle = gr; X.fillRect(0, 0, pw, ph);
    X.globalCompositeOperation = 'source-over';
    // contact shadow on the dirt
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,.32)'; ctx.beginPath(); ctx.ellipse(sx, sy, k * 1.5, k * 0.28, 0, 0, 7); ctx.fill();
    ctx.globalAlpha = alpha;
    ctx.drawImage(oc, 0, 0, pw, ph, sx - pw / 2 / DPR, sy - (ph - base) / DPR, pw / DPR, ph / DPR);
    ctx.restore();
  }

  // ---- Batter (side view, facing +x toward the plate) ----
  // keyframes: t, backKnee(x,y), frontKnee(x,y), frontFootX, hands(x,y), backElbow(x,y), frontElbow(x,y), batDeg, chestX, headX, hipY
  const SWING = [
    [0.00, -0.70, 1.62, 0.60, 1.62, 0.95, -0.30, 5.00, -0.92, 4.55, 0.05, 4.30, 108, 0.18, 0.30, 3.05],
    [0.18, -0.74, 1.58, 0.82, 1.95, 1.15, -0.55, 4.95, -1.00, 4.62, -0.20, 4.40, 128, 0.10, 0.24, 3.10],
    [0.50, -0.50, 1.45, 0.92, 1.58, 1.30, 0.55, 4.05, 0.02, 4.15, 0.45, 4.55, 0, 0.12, 0.22, 2.95],
    [0.75, -0.42, 1.48, 0.95, 1.60, 1.30, 0.75, 4.75, 0.25, 4.45, 0.75, 5.05, -115, 0.05, 0.12, 2.98],
    [1.00, -0.40, 1.52, 0.95, 1.62, 1.30, 0.05, 5.35, -0.35, 5.05, 0.45, 5.25, -205, -0.05, 0.05, 3.02],
  ];
  function batterArt(T, t, face, idle) {
    let [bkx, bky, fkx, fky, ffx, hx, hy, bex, bey, fex, fey, bat, chx, hdx, hipY] = keyf(SWING, t);
    if (idle != null && t === 0) { // waiting for the pitch: bat waggle and a little knee bounce
      const w = Math.sin(idle / 420), k2 = (Math.sin(idle / 950) + 1) / 2;
      bat += w * 7; hy += w * 0.06; hx += w * 0.03; hipY -= k2 * 0.06; bky -= k2 * 0.04; fky -= k2 * 0.04;
    }
    const hipB = [-0.18, hipY], hipF = [0.18, hipY];
    const neck = [chx, 5.15], shB = [chx - 0.22, 4.95], shF = [chx + 0.18, 4.95];
    // back leg & back arm sit behind the body
    leg(hipB, [bkx, bky], [-1.02, 0.12], T, -1, true);
    seg(shB, [bex, bey], 0.2, 0.16, T.jerseyD); seg([bex, bey], [hx, hy], 0.16, 0.12, T.jerseyD);
    leg(hipF, [fkx, fky], [ffx, 0.12], T, 1, false);
    // torso: jersey with belt
    blob([[-0.5, hipY - 0.05], [-0.62, 4.0], [chx - 0.58, 5.05], [chx + 0.05, 5.32], [chx + 0.52, 5.0], [0.55, 4.0], [0.48, hipY - 0.05]], T.jersey);
    poly([[-0.5, hipY - 0.05], [0.5, hipY - 0.05], [0.5, hipY + 0.17], [-0.5, hipY + 0.17]], '#202228');
    X.strokeStyle = T.trim; X.lineWidth = 0.06; X.beginPath(); X.moveTo(chx - 0.45, 5.05); X.quadraticCurveTo(chx + 0.05, 5.35, chx + 0.42, 5.02); X.stroke();
    const hd = [hdx, 5.66];
    if (face) {
      // seen from the mound: the head is turned toward the pitcher, eyes locked on the ball
      ell(hd[0], hd[1] - 0.1, 0.34, 0.4, 0, T.skin);
      ell(hd[0], hd[1] + 0.14, 0.44, 0.34, 0, T.helmet);
      ell(hd[0], hd[1] + 0.06, 0.54, 0.1, 0, T.helmet);
      ell(hd[0] - 0.33, hd[1] - 0.12, 0.13, 0.2, 0, T.helmet); // ear flap on the pitcher-facing side
      ell(hd[0] + 0.13, hd[1] - 0.1, 0.07, 0.055, 0, '#1a1410'); ell(hd[0] - 0.11, hd[1] - 0.1, 0.07, 0.055, 0, '#1a1410');
      ell(hd[0] + 0.13, hd[1] - 0.09, 0.025, 0.02, 0, '#fff'); ell(hd[0] - 0.11, hd[1] - 0.09, 0.025, 0.02, 0, '#fff');
      ell(hd[0] + 0.01, hd[1] - 0.34, 0.09, 0.025, 0, 'rgba(60,30,20,.7)');
      ell(hd[0] + 0.02, hd[1] - 0.22, 0.04, 0.05, 0, 'rgba(120,70,50,.5)');
      ell(hd[0] + 0.1, hd[1] + 0.2, 0.16, 0.06, 0, 'rgba(255,255,255,.3)');
    } else {
      // seen from the umpire: ear flap faces the catcher
      ell(hd[0] + 0.18, hd[1] - 0.12, 0.2, 0.26, 0, T.skin);
      ell(hd[0], hd[1], 0.42, 0.4, 0, T.helmet);
      ell(hd[0] - 0.2, hd[1] - 0.25, 0.22, 0.24, 0.3, T.helmet);
      poly([[hd[0] + 0.25, hd[1] - 0.02], [hd[0] + 0.72, hd[1] - 0.1], [hd[0] + 0.7, hd[1] - 0.18], [hd[0] + 0.2, hd[1] - 0.14]], T.helmet);
      ell(hd[0] - 0.12, hd[1] + 0.16, 0.16, 0.08, -0.4, 'rgba(255,255,255,.35)');
    }
    // bat: knob, handle, barrel
    const a = bat * Math.PI / 180, ux = Math.cos(a), uy = Math.sin(a);
    const at = (d) => [hx + ux * d, hy + uy * d];
    seg(at(-0.12), at(1.1), 0.055, 0.07, '#d4a66f');
    seg(at(1.1), at(2.75), 0.07, 0.13, '#c99558');
    seg(at(1.6), at(2.7), 0.035, 0.06, 'rgba(255,236,200,.55)');
    dot(at(-0.14), 0.08, '#2a1c12');
    // front arm over the bat, batting gloves
    seg(shF, [fex, fey], 0.2, 0.16, T.jersey); seg([fex, fey], [hx + 0.05, hy], 0.16, 0.12, T.jersey);
    dot([hx, hy], 0.15, '#f3f3f0'); dot([hx + ux * 0.18, hy + uy * 0.18], 0.14, '#1c1d22');
  }
  function drawBatter(c, hand, swingT, team, alpha, now) {
    const bx = hand === 'R' ? -2.9 : 2.9;
    const foot = P(c, bx, 0, -0.4), plate = P(c, 0, 0, -0.4);
    if (!foot || !plate) return;
    if (team === 'me') { foot.x = Math.max(W * 0.07, Math.min(W * 0.93, foot.x)); foot.k *= 0.5; } // keep the user's batter in frame, out of the zone
    const dir = plate.x > foot.x ? 1 : -1;
    const t = swingT == null ? 0 : Math.min(1, swingT);
    renderFigure(foot.x, foot.y, foot.k, dir, alpha, 7.5, 8.6, () => batterArt(TEAM[team], t, team === 'cpu', now));
  }

  // ---- Pitcher (front or back view). Throwing arm drawn on +x, mirrored for the other hand ----
  // keyframes: w, strideKnee(x,y), strideFoot(x,y), pivotKnee(x,y), pivotFoot(x,y), hand(x,y), elbow(x,y), glove(x,y), gElbow(x,y), drop
  const DELIVERY = [
    [0.00, -0.38, 1.62, -0.42, 0.10, 0.38, 1.62, 0.42, 0.10, 0.12, 4.30, 0.62, 3.90, -0.05, 4.32, -0.62, 3.90, 0.00],
    [0.35, -0.22, 3.25, -0.42, 1.95, 0.36, 1.62, 0.40, 0.10, 0.05, 4.65, 0.60, 4.15, -0.02, 4.66, -0.60, 4.15, 0.05],
    [0.60, -0.85, 2.15, -1.20, 0.65, 0.40, 1.55, 0.42, 0.10, 1.15, 3.75, 0.92, 4.45, -1.35, 4.90, -0.95, 4.62, 0.22],
    [0.82, -1.00, 1.40, -1.25, 0.10, 0.48, 1.50, 0.55, 0.12, 1.30, 5.95, 1.32, 4.90, -1.20, 4.70, -0.95, 4.45, 0.45],
    [1.00, -0.95, 1.35, -1.20, 0.10, 0.55, 1.60, 0.70, 0.35, 1.55, 5.95, 1.22, 5.10, -0.55, 4.30, -0.95, 4.02, 0.55],
    [1.30, -0.90, 1.30, -1.15, 0.10, 0.50, 2.05, 0.65, 1.05, -0.70, 3.10, 0.05, 3.90, -0.60, 3.95, -0.95, 3.80, 0.72],
  ];
  function pitcherArt(T, w, fromBehind, flip) {
    const [skx, sky, sfx, sfy, pkx, pky, pfx, pfy, hx, hy, ex, ey, gx, gy, gex, gey, drop] = keyf(DELIVERY, w);
    const hipY = 3.1 - drop * 0.6, shY = 5.0 - drop;
    const hipS = [-0.3, hipY], hipP = [0.3, hipY];
    const shS = [-0.78, shY], shP = [0.78, shY];
    leg(hipP, [pkx, pky], [pfx, pfy], T, 0.3, true);
    leg(hipS, [skx, sky], [sfx, sfy], T, -0.3, false);
    const throwArm = () => { seg(shP, [ex, ey], 0.21, 0.17, T.jersey); seg([ex, ey], [hx, hy], 0.17, 0.13, T.skin); dot([hx, hy], 0.15, T.skin); if (w < 1) dot([hx, hy + 0.05], 0.12, '#ffffff'); };
    const gloveArm = () => { seg(shS, [gex, gey], 0.21, 0.17, T.jerseyD); seg([gex, gey], [gx, gy], 0.17, 0.13, T.skin); blob([[gx - 0.32, gy - 0.25], [gx - 0.4, gy + 0.2], [gx - 0.05, gy + 0.42], [gx + 0.3, gy + 0.18], [gx + 0.22, gy - 0.3]], T.glove); };
    // seen from behind, hands in front of the chest are hidden by the body
    const armUp = w > 0.5 && w < 0.97;
    if (fromBehind) { gloveArm(); if (!armUp) throwArm(); }
    // torso
    blob([[-0.48, hipY - 0.1], [-0.6, hipY + 1.0], [-0.86, shY - 0.05], [-0.3, shY + 0.25], [0.3, shY + 0.25], [0.86, shY - 0.05], [0.6, hipY + 1.0], [0.48, hipY - 0.1]], T.jersey);
    poly([[-0.5, hipY - 0.12], [0.5, hipY - 0.12], [0.5, hipY + 0.1], [-0.5, hipY + 0.1]], '#202228');
    if (fromBehind) {
      X.save(); X.scale(flip, -1); X.fillStyle = T.trim; X.textAlign = 'center';
      X.font = '700 0.36px "Saira Condensed", sans-serif'; X.fillText(T.name, 0, -(shY - 0.32));
      X.font = '800 1.05px "Saira Condensed", sans-serif'; X.fillText(T.num, 0, -(hipY + 0.75));
      X.restore();
    } else {
      X.strokeStyle = T.trim; X.lineWidth = 0.05; X.beginPath(); X.moveTo(0.02, shY + 0.15); X.lineTo(0.02, hipY + 0.1); X.stroke();
      X.save(); X.scale(flip, -1); X.fillStyle = T.trim; X.textAlign = 'center'; X.font = 'italic 700 0.5px "Saira Condensed", sans-serif'; X.fillText('Road', 0, -(shY - 0.65)); X.restore();
    }
    if (!fromBehind) gloveArm();
    // head & cap
    const hd = [0, shY + 0.62];
    seg([0, shY + 0.15], [0, shY + 0.4], 0.17, 0.16, T.skin);
    ell(hd[0], hd[1], 0.36, 0.42, 0, fromBehind ? '#2a211c' : T.skin);
    if (fromBehind) { ell(-0.37, hd[1] - 0.02, 0.07, 0.12, 0, T.skin); ell(0.37, hd[1] - 0.02, 0.07, 0.12, 0, T.skin); }
    X.fillStyle = T.cap; X.beginPath(); X.ellipse(hd[0], hd[1] + 0.12, 0.39, 0.34, 0, 0, Math.PI); X.fill();
    if (fromBehind) { ell(hd[0], hd[1] + 0.12, 0.39, 0.12, 0, T.cap); }
    else { ell(hd[0], hd[1] + 0.1, 0.48, 0.1, 0, T.cap); ell(hd[0], hd[1] - 0.05, 0.3, 0.07, 0, 'rgba(0,0,0,.25)'); }
    if (!fromBehind || armUp) throwArm();
  }
  function drawPitcher(c, hand, w, team, fromBehind, alpha) {
    const foot = P(c, 0, 0, 60.5);
    if (!foot) return;
    const rel = P(c, hand === 'R' ? -1.9 : 1.9, 5.9, 60.5);
    const arm = rel && rel.x > foot.x ? 1 : -1;
    renderFigure(foot.x, foot.y, foot.k, arm, alpha, 5.6, 8, () => pitcherArt(TEAM[team], w == null ? 0 : w, fromBehind, arm));
  }

  // ---- Fielder (ready stance, facing the plate) ----
  function fielderArt(T, sway) {
    const S2 = { pants: T.pants, jerseyD: T.jerseyD, sock: T.sock };
    leg([-0.32, 2.95], [-0.8, 1.55], [-0.95, 0.12], S2, -1, false);
    leg([0.32, 2.95], [0.8, 1.55], [0.95, 0.12], S2, 1, false);
    blob([[-0.55, 2.85], [-0.75, 4.0], [-0.72, 4.95], [0, 5.15], [0.72, 4.95], [0.75, 4.0], [0.55, 2.85]], T.jersey);
    poly([[-0.52, 2.8], [0.52, 2.8], [0.52, 3.02], [-0.52, 3.02]], '#202228');
    seg([-0.68, 4.8], [-1.05, 3.9 + sway], 0.19, 0.15, T.jersey); seg([-1.05, 3.9 + sway], [-1.0, 3.0], 0.15, 0.12, T.skin);
    seg([0.68, 4.8], [1.05, 3.9 - sway], 0.19, 0.15, T.jersey); seg([1.05, 3.9 - sway], [1.0, 3.0], 0.15, 0.12, T.skin);
    blob([[-1.3, 2.7], [-1.4, 3.15], [-1.0, 3.4], [-0.65, 3.1], [-0.75, 2.65]], T.glove);
    dot([1.0, 2.95], 0.16, T.skin);
    seg([0, 5.05], [0, 5.3], 0.16, 0.15, T.skin);
    ell(0, 5.6, 0.35, 0.4, 0, T.skin);
    X.fillStyle = T.cap; X.beginPath(); X.ellipse(0, 5.72, 0.38, 0.33, 0, 0, Math.PI); X.fill();
    ell(0, 5.7, 0.47, 0.1, 0, T.cap);
  }
  function drawFielders(c, team, now) {
    const list = Object.keys(E.FIELDERS).filter((f) => f !== 'P' && f !== 'C').map((f) => { const [a, r] = E.FIELDERS[f]; const [x, z] = E.fieldXY(a, r); return { f, x, z }; });
    list.sort((a, b) => b.z - a.z);
    for (const q of list) {
      const p = P(c, q.x, 0, q.z); if (!p) continue;
      const sway = Math.sin(now / 900 + q.x) * 0.08;
      renderFigure(p.x, p.y, p.k, 1, 1, 3.2, 6.4, () => fielderArt(TEAM[team], sway), 0.9);
    }
  }

  function drawCatcherUmp(c, mitt) {
    let p = P(c, 0, 0, -5.2);
    if (p) renderFigure(p.x, p.y, p.k, 1, 1, 3.4, 5.6, () => {
      leg([-0.35, 2.4], [-0.75, 1.3], [-0.6, 0.1], { pants: '#2b2f38', jerseyD: '#2b2f38', sock: '#15171c' }, -1, false);
      leg([0.35, 2.4], [0.75, 1.3], [0.6, 0.1], { pants: '#2b2f38', jerseyD: '#2b2f38', sock: '#15171c' }, 1, false);
      blob([[-0.6, 2.3], [-0.95, 3.4], [-0.75, 4.1], [0.75, 4.1], [0.95, 3.4], [0.6, 2.3]], '#17202e');
      ell(0, 4.5, 0.36, 0.4, 0, '#101722');
      poly([[-0.3, 4.3], [0.3, 4.3], [0.25, 4.7], [-0.25, 4.7]], '#2c3442');
    }, 0.8);
    p = P(c, 0, 0, -2.7);
    if (p) renderFigure(p.x, p.y, p.k, 1, 1, 3.4, 4.2, () => {
      const T = { pants: '#c9c4b6', jerseyD: '#b7b2a4', sock: '#1d3a78' };
      leg([-0.4, 1.35], [-0.95, 1.2], [-0.7, 0.1], T, -1, false);
      leg([0.4, 1.35], [0.95, 1.2], [0.7, 0.1], T, 1, false);
      blob([[-0.65, 1.1], [-0.9, 2.1], [-0.6, 2.75], [0.6, 2.75], [0.9, 2.1], [0.65, 1.1]], '#1d3a78');
      poly([[-0.45, 1.3], [0.45, 1.3], [0.4, 2.55], [-0.4, 2.55]], '#2d3442');
      ell(0, 3.15, 0.4, 0.42, 0, '#1d3a78');
      X.strokeStyle = '#9aa0ad'; X.lineWidth = 0.05; X.beginPath(); for (let i = 0; i < 3; i++) { X.moveTo(-0.25, 3.0 + i * 0.1); X.lineTo(0.25, 3.0 + i * 0.1); } X.stroke();
    }, 0.8);
    if (mitt) {
      const m = P(c, mitt.x, mitt.y, -1.2);
      if (m) { const r = Math.max(4, m.k * 0.5); const gr = ctx.createRadialGradient(m.x - r * 0.3, m.y - r * 0.3, 1, m.x, m.y, r); gr.addColorStop(0, '#9a6236'); gr.addColorStop(1, '#4e2f17'); ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(m.x, m.y, r, 0, 7); ctx.fill(); }
    }
  }

  function drawBall3D(c, pos, glow) {
    const sh = P(c, pos.x, 0, pos.z);
    const p = P(c, pos.x, pos.y, pos.z);
    if (!p) return null;
    if (sh) { ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.beginPath(); ctx.ellipse(sh.x, sh.y, Math.max(2, sh.k * 0.18), Math.max(1, sh.k * 0.07), 0, 0, 7); ctx.fill(); }
    const r = Math.max(2.4, p.k * 0.121);
    if (glow) { ctx.fillStyle = 'rgba(255,255,255,.18)'; ctx.beginPath(); ctx.arc(p.x, p.y, r * 2.2, 0, 7); ctx.fill(); }
    ctx.fillStyle = '#fbfaf5'; ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 7); ctx.fill();
    if (r > 5) {
      ctx.strokeStyle = '#c8333a'; ctx.lineWidth = Math.max(1, r * 0.12);
      ctx.beginPath(); ctx.arc(p.x - r * 0.9, p.y, r * 0.7, -0.9, 0.9); ctx.stroke();
      ctx.beginPath(); ctx.arc(p.x + r * 0.9, p.y, r * 0.7, Math.PI - 0.9, Math.PI + 0.9); ctx.stroke();
    }
    return p;
  }

  // ---------------- Pitch flow ----------------
  function timeScale() { return G.tsLock || (S.role === 'batter' ? S.speed : 1); } // locked per pitch so a settings change waits for the next one
  function setPhase(ph) { G.phase = ph; G.t0 = G.now; }
  const statsBucket = () => (G.mp ? save.mpStats : save.stats);
  const logBucket = () => (G.mp ? save.mpLogs : save.logs[S.role]);
  const PITCH_HINT = 'Hold the zone pad, lift at the top of the gauge for power';

  function startPA() {
    const s = st();
    s.balls = 0; s.strikes = 0; s.history = [];
    if (G.mp) {
      if (S.role === 'pitcher') { G.pHand = S.myThrow; G.bHand = G.mp.oppBat || 'R'; } else { G.bHand = S.myBat; G.pHand = G.mp.oppThrow || 'R'; }
    } else if (S.role === 'pitcher') { G.pHand = S.myThrow; G.bHand = S.cpuBat === 'X' ? (Math.random() < 0.5 ? 'R' : 'L') : S.cpuBat; }
    else {
      G.bHand = S.myBat;
      // the CPU keeps one pitcher for the whole half inning
      if (!s.cpuP || s.cpuP.half !== s.half || s.cpuP.inn !== s.inning) s.cpuP = { half: s.half, inn: s.inning, hand: S.cpuThrow === 'X' ? (Math.random() < 0.7 ? 'R' : 'L') : S.cpuThrow };
      G.pHand = s.cpuP.hand;
    }
    G.basesBefore = s.bases.slice();
    renderMatchup(); renderPad(); renderHUD();
    nextPitch();
  }
  function nextPitch() {
    G.tsLock = 0; G.pitch = null; G.cpuDec = null; G.swing = null; G.swingAnim = null; G.outcome = null; G.trail = []; G.hit = null; G.reticle = null;
    G.basesBefore = st().bases.slice();
    if (S.role === 'pitcher') { setPhase('idle'); $('throw').disabled = false; banner(PITCH_HINT); }
    else if (G.mp) { setPhase('waitPitch'); banner('Waiting for your friend to pitch…'); if (G.mp.pendingPitch) takePitch(G.mp.pendingPitch); else mpReplay(); }
    else { setPhase('think'); banner(''); }
  }

  function throwPitch(power) {
    if (G.phase !== 'idle' || S.role !== 'pitcher') return;
    if (G.mp && !G.mp.oppPeer) return;
    audio();
    $('throw').disabled = true;
    G.pitch = E.executePitch(G.pitchType, G.target.x, G.target.y, G.pHand, null, power == null ? 0.5 : power);
    G.tsLock = timeScale();
    if (G.mp) { G.mp.seq++; G.cpuDec = null; mpSend({ t: 'pitch', seq: G.mp.seq, p: G.pitch }); }
    else G.cpuDec = E.cpuBatter(G.pitch, st(), G.bHand, S.cpuBatLv);
    setPhase('windup'); banner('');
  }

  function cpuPitch() {
    const c = E.cpuChoosePitch(st(), G.pHand, G.bHand, S.cpuPitchLv);
    G.pitch = E.executePitch(c.type, c.tx, c.ty, G.pHand, S.cpuPitchLv);
    G.tsLock = timeScale();
    setPhase('windup');
  }
  // multiplayer: the friend's pitch arrived
  function takePitch(msg) {
    G.mp.pendingPitch = null;
    if (msg.seq <= G.mp.lastPitchSeq) return;
    if (G.phase !== 'waitPitch') { G.mp.pendingPitch = msg; return; }
    G.mp.lastPitchSeq = msg.seq;
    G.pitch = msg.p; banner(''); G.tsLock = timeScale();
    setPhase('windup');
  }

  const WINDUP = 0.9;
  function flightDur() { return G.pitch.T / timeScale(); } // seconds of wall time

  function update(now) {
    const el = (now - G.t0) / 1000;
    switch (G.phase) {
      case 'think': if (el > 1.1) cpuPitch(); break;
      case 'idle':
        if (G.mp && G.mp.started) { const left = TURN_SECS - el; if (left <= 0) mpForfeit(); else if (left <= 10) banner(`Throw within ${Math.ceil(left)}s or you forfeit`); }
        break;
      case 'waitPitch': if (G.mp && el > REMOTE_SECS) mpEnd(true, 'Your friend stopped playing.'); break;
      case 'windup':
        if (el >= WINDUP) { setPhase('flight'); if (S.role === 'pitcher') showPitchInfo(); }
        break;
      case 'flight': {
        const fd = flightDur();
        if (S.role === 'pitcher') {
          if (G.mp) { if (el >= fd) { setPhase('waitResult'); if (G.mp.pendingResult) takeResult(G.mp.pendingResult); } break; }
          if (G.cpuDec.swing && !G.swingAnim && el > fd - 0.14) G.swingAnim = { t0: now };
          if (el >= fd) resolve(G.cpuDec.swing ? G.cpuDec : { swing: false });
        } else {
          if (G.swing && el >= fd && G.swing.wall <= G.t0 + fd * 1000) resolveUserSwing();
          else if (!G.swing && el >= fd + (E.TIMING_WIN * 1.05) / timeScale()) resolve({ swing: false });
        }
        break;
      }
      case 'waitResult': if (el > 1.2) banner('Waiting for your friend…'); if (G.mp && el > REMOTE_SECS) mpEnd(true, 'Your friend stopped playing.'); break;
      case 'contact': if (el > 0.6) startField(); break;
      case 'after': if (el > (G.afterInfo && G.afterInfo.paEnd ? 1.7 : 1.05)) afterDone(); break;
      case 'fieldDone': if (el > 2.6) afterDone(); break;
      default: break;
    }
  }

  function onCanvasTap(e) {
    audio();
    const rect = cv.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    if (G.phase === 'fieldDone') { afterDone(); return; }
    if (S.role === 'pitcher') {
      if (G.phase !== 'idle') return;
      const pt = screenToPlate(cam, sx, sy);
      if (pt) setTarget(pt.x, pt.y);
      return;
    }
    // batter: hold to aim, release to swing
    G.aim = { id: e.pointerId, sx, sy, off: e.pointerType === 'mouse' ? 0 : 46 };
    try { cv.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  }
  function onCanvasMove(e) {
    if (!G.aim || e.pointerId !== G.aim.id) return;
    const rect = cv.getBoundingClientRect();
    G.aim.sx = e.clientX - rect.left; G.aim.sy = e.clientY - rect.top;
  }
  function onCanvasUp(e) {
    if (!G.aim || e.pointerId !== G.aim.id) return;
    const rect = cv.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top - G.aim.off;
    G.aim = null;
    if (e.type === 'pointercancel' || S.role !== 'batter' || G.phase !== 'flight' || G.swing) return;
    const pt = screenToPlate(cam, sx, sy);
    if (!pt) return;
    const tap = Math.min(e.timeStamp || performance.now(), performance.now());
    G.swing = { wall: tap, x: pt.x, y: pt.y };
    G.swingAnim = { t0: tap - 100 };
    G.reticle = { x: pt.x, y: pt.y, t0: tap };
    // late tap: resolve right away
    if ((tap - G.t0) / 1000 >= flightDur()) resolveUserSwing();
  }

  function resolveUserSwing() {
    const fd = flightDur();
    const dtWall = (G.swing.wall - G.t0) / 1000 - fd;
    const dtReal = dtWall * timeScale();
    const r = E.userSwing(G.pitch, G.swing.x, G.swing.y, dtReal, G.bHand);
    r.dt = dtReal;
    resolve(r);
  }

  // Decide what happened on this pitch and update the count/bases. The batter's
  // device does this in multiplayer and sends the outcome to the pitcher.
  function resolve(dec) {
    const s = st(), p = G.pitch;
    s.history.push({ type: p.type, px: p.px, py: p.py, mph: p.mph });
    let ev = null, bb = null, label = '', kind = 'neutral', subl = '', hitV = null;
    if (!dec.swing) {
      const call = E.callPitch(p, G.bHand);
      if (call === 'hbp') { ev = 'HBP'; }
      else if (call === 'ball') { s.balls++; label = 'Ball'; kind = 'ball'; if (s.balls >= 4) ev = 'BB'; }
      else { s.strikes++; label = 'Strike'; kind = 'strike'; if (s.strikes >= 3) { ev = 'K'; subl = 'Called strike three'; } }
    } else if (dec.result === 'miss') {
      s.strikes++; label = 'Swinging strike'; kind = 'strike';
      if (dec.why === 'early') subl = 'Too early'; else if (dec.why === 'late') subl = 'Too late'; else if (dec.why === 'location') subl = 'Missed the ball';
      if (s.strikes >= 3) { ev = 'K'; subl = 'Swinging strike three'; }
    } else if (dec.result === 'foul') {
      if (s.strikes < 2) s.strikes++; label = 'Foul'; kind = 'strike';
      hitV = { foul: true, ...foulVec() };
    } else {
      bb = E.resolveBattedBall(dec.ev, dec.la, dec.spray);
      hitV = { foul: false, ev: dec.ev, la: dec.la, spray: dec.spray };
      if (bb.result === 'FOUL') { if (s.strikes < 2) s.strikes++; label = 'Foul'; kind = 'strike'; }
      else ev = bb.result;
    }
    let r = null;
    const cnt = `${Math.min(s.balls, 3)}-${Math.min(s.strikes, 2)}`;
    if (ev) { r = E.applyEvent(s, ev, bb); if (r.runs) s.score[S.role === 'batter' ? 'me' : 'opp'] += r.runs; }
    const bbS = bb ? Object.fromEntries(Object.entries(bb).filter(([k]) => k !== 'pts')) : null;
    const O = {
      dec: { swing: !!dec.swing, result: dec.result || null, dt: dec.dt, quality: dec.quality || 0.5 },
      label, kind, ev, subl, bb: bbS, hitV, r, cnt,
    };
    if (G.mp) mpSend({ t: 'result', seq: G.mp.lastPitchSeq, o: O, state: { inning: s.inning, half: s.half, outs: s.outs, balls: s.balls, strikes: s.strikes, bases: s.bases, runs: s.runs, score: { me: s.score.opp, opp: s.score.me } } });
    present(O);
  }

  // multiplayer: the batter's result for our pitch arrived
  function takeResult(msg) {
    G.mp.pendingResult = null;
    if (msg.seq !== G.mp.seq || G.mp.resultSeq === msg.seq) return;
    if (G.phase !== 'waitResult') { G.mp.pendingResult = msg; return; }
    G.mp.resultSeq = msg.seq;
    const s = st(), x = msg.state || {};
    s.inning = x.inning | 0 || 1; s.outs = x.outs | 0; s.balls = x.balls | 0; s.strikes = x.strikes | 0; s.runs = x.runs | 0;
    s.bases = Array.isArray(x.bases) ? x.bases.slice(0, 3).map((v) => (v ? 1 : 0)) : [0, 0, 0];
    s.half = x.half ? 1 : 0;
    if (x.score) s.score = { me: Math.max(0, x.score.me | 0), opp: Math.max(0, x.score.opp | 0) };
    if (msg.o.dec.swing) G.swingAnim = { t0: G.now - 120 };
    banner('');
    present(msg.o);
  }

  // Show an outcome and record it in this viewer's stats.
  function present(O) {
    const st0 = statsBucket();
    if (S.role === 'pitcher') { st0.pitcher.pitches++; if (O.kind !== 'ball' && O.ev !== 'HBP') st0.pitcher.strikes++; }
    else st0.batter.pitches++;
    G.hit = O.hitV ? { ...O.hitV, t0: G.now } : null;
    if (!O.dec.swing || O.dec.result === 'miss') { sfx.mitt(); G.freeze = { kind: 'plate', t0: G.now, dur: 380 }; } // hold the frame so the location is readable
    else if (O.dec.result === 'foul') sfx.foul();
    else {
      sfx.bat(O.dec.quality); buzz(25);
      if (O.dec.result === 'play' && O.dec.quality >= 0.74 && G.pitch) { // sweet-spot contact: freeze the frame for a beat
        const c = P(cam, G.pitch.px, G.pitch.py, 0);
        G.freeze = { kind: 'hit', t0: G.now, dur: 220, x: c ? c.x : W / 2, y: c ? c.y : H / 2, q: O.dec.quality };
        buzz([30, 30, 60]);
      }
    }
    const bb = O.bb ? { ...O.bb, pts: E.flight(O.bb.ev, O.bb.la).pts } : null;
    G.outcome = { dec: O.dec, label: O.label, kind: O.kind, ev: O.ev, bb, subl: O.subl };
    if (S.role === 'batter') showPitchInfo();
    if (O.ev) {
      const r = O.r;
      E.recordPA(st0, S.role, O.ev, r.runs, r.outs, bb);
      const txt = evLabel(O.ev, r, bb, O.subl);
      const log = logBucket();
      log.unshift({ inn: st().inning, txt: txt.main, sub: txt.sub, cnt: O.cnt });
      if (log.length > 40) log.length = 40;
      G.afterInfo = { paEnd: true, ev: O.ev, r, txt, ended: r.ended };
    } else G.afterInfo = { paEnd: false };
    persist();
    if (bb && bb.result !== 'FOUL') { G.hudFrozen = true; setPhase('contact'); G.fieldBB = bb; return; }
    setPhase('after');
    renderHUD();
    if (G.afterInfo.paEnd) toast(G.afterInfo.txt.main, G.afterInfo.txt.sub, G.afterInfo.txt.good);
    else toast(O.label, O.subl, null, O.kind);
  }

  function foulVec() {
    const back = Math.random() < 0.5;
    return { fx: (Math.random() - 0.5) * 60, fy: 30 + Math.random() * 40, fz: back ? -(40 + Math.random() * 50) : 30 + Math.random() * 40, side: Math.random() < 0.5 ? -1 : 1 };
  }

  function evLabel(ev, r, bb, subl) {
    const me = S.role;
    const good = me === 'pitcher' ? ['K', 'OUT'].includes(ev) : !['K', 'OUT'].includes(ev);
    let main = { K: 'STRIKEOUT!', BB: 'Walk', HBP: 'Hit by pitch', '1B': 'Single', '2B': 'Double', '3B': 'Triple', HR: 'HOME RUN!' }[ev] || r.text;
    if (ev === 'HR' && r.runs === 4) main = 'GRAND SLAM!';
    if (ev === '1B' && bb && bb.how === 'Infield single') main = 'Infield single';
    if (ev === 'OUT') main = r.text;
    let sub = subl || '';
    if (r.runs > 0) sub = me === 'pitcher' ? `${r.runs} run${r.runs > 1 ? 's' : ''} allowed` : `${r.runs} RBI`;
    return { main, sub, good };
  }

  function afterDone() {
    G.hudFrozen = false;
    const info = G.afterInfo;
    hideToast();
    if (info && info.paEnd) {
      const s = st(), len = gameLen();
      // walk-off: the side batting in the bottom of the last inning (or later) takes the lead
      if (!info.ended && s.half && s.inning >= len && battingScore(S.role) > battingScore(S.role === 'pitcher' ? 'batter' : 'pitcher')) { endGame(s.score.me > s.score.opp, `Walk-off in the ${ordinal(s.inning)}!`); return; }
      if (info.ended) {
        s.outs = 0; s.bases = [0, 0, 0]; s.inningRuns = 0;
        const wasBottom = s.half;
        if (s.half) { s.half = 0; s.inning++; } else s.half = 1;
        const nextRole = S.role === 'pitcher' ? 'batter' : 'pitcher';
        if (wasBottom && s.inning > len && s.score.me !== s.score.opp) { endGame(s.score.me > s.score.opp, `Final after ${s.inning - 1} innings.`); return; }
        // no need for the bottom half when the side batting next already leads
        if (!wasBottom && s.inning >= len && battingScore(nextRole) > battingScore(S.role)) { endGame(s.score.me > s.score.opp, `Final after ${s.inning} innings, no bottom half needed.`); return; }
        S.role = nextRole;
        if (G.mp) { G.mp.myRole = S.role; mpPresence(); } else s.role = S.role;
        setRolePanels(); persist();
        bannerFlash(`3 outs! Switch sides: you're ${S.role === 'pitcher' ? 'pitching' : 'batting'} now`);
      }
      startPA();
    } else { renderHUD(); nextPitch(); }
  }

  const gameLen = () => (G.mp ? G.mp.innings : (S.innings || Infinity));
  const battingScore = (role) => (role === 'batter' ? st().score.me : st().score.opp); // the score of whoever is batting when I hold `role`
  const ordinal = (n) => `${n}${['st', 'nd', 'rd'][n - 1] || 'th'}`;
  function endGame(win, reason) {
    if (G.mp) { mpEnd(win, reason); return; }
    const s = st();
    showEnd(win, reason, s.score.me, s.score.opp, 'CPU', Math.min(s.inning, S.innings || s.inning));
    save.games.duel = newDuel(); persist();
    G.started = false; G.phase = 'menu'; G.pwr = null; renderPower(0); hideToast(); banner('');
  }
  function showEnd(win, reason, me, opp, oppName, inn) {
    $('endTitle').textContent = ''; const em = document.createElement('em');
    $('endTitle').append('YOU ', em); em.textContent = win ? 'WIN' : 'LOSE';
    $('endSub').textContent = reason;
    $('endScore').textContent = `YOU ${me}   :   ${opp} ${oppName}   ·   ${inn} inn`;
    closeAllOv(); openOv('endOv');
  }

  // ---------------- Field view ----------------
  function startField() {
    const bb = G.fieldBB;
    const fa = { bb, t0: G.now };
    const fpos = (f) => { const [a, r] = E.FIELDERS[f]; return E.fieldXY(a, r); };
    const dirXY = (d) => E.fieldXY(bb.phi, d);
    const ptAt = (t) => { // air trajectory sample
      const pts = bb.pts; if (t >= bb.T) { const l = pts[pts.length - 1]; return { d: l.d, h: 0 }; }
      const i = Math.min(pts.length - 1, Math.floor(t / 0.01)); return { d: pts[i].d, h: pts[i].h };
    };
    const animScale = Math.max(1, bb.T / 3.2);
    if (bb.kind === 'GB') {
      const v = bb.ev * 1.4667 * 0.75;
      const stopD = bb.result === 'OUT' || bb.how === 'Infield single' ? bb.gbAlong : Math.min(250, 120 + bb.ev * 1.3);
      const tStop = bb.result === 'OUT' || bb.how === 'Infield single' ? bb.gbT : (stopD / v) * 1.6;
      fa.dur = tStop;
      fa.ball = (t) => { const u = Math.min(1, t / tStop); const d = bb.result === 'OUT' || bb.how === 'Infield single' ? stopD * u : stopD * (1 - (1 - u) * (1 - u)); const [x, z] = dirXY(d); return { x, z, h: Math.abs(Math.sin(d / 18)) * Math.max(0, 4 - d / 40) }; };
      const end = dirXY(stopD);
      let f = bb.fielder;
      if (!(bb.result === 'OUT' || bb.how === 'Infield single')) f = bb.phi < -15 ? 'LF' : bb.phi > 15 ? 'RF' : 'CF';
      fa.fielder = f; fa.from = fpos(f); fa.to = end;
      fa.land = end; fa.landT = tStop; fa.caught = bb.result === 'OUT';
      fa.scale = 1; fa.movers = [];
      if (bb.result === 'OUT' || bb.how === 'Infield single') {
        // the infielder gets to the ball right as it arrives
        fa.movers.push(mover(f, fpos(f), end, 0.3, Math.hypot(end[0] - fpos(f)[0], end[1] - fpos(f)[1]) / Math.max(0.25, tStop - 0.3)));
      } else {
        // nearest infielder lunges toward where the ball goes by, and comes up short; the outfielder collects it
        const inf = bb.fielder && E.FIELDERS[bb.fielder] && E.FIELDERS[bb.fielder][1] < 200 ? bb.fielder : null;
        if (inf) { const pass = dirXY(bb.gbAlong); fa.movers.push(mover(inf, fpos(inf), pass, 0.4, 9, bb.gbT + 0.4)); }
        const m = mover(f, fpos(f), end, 0.5, 26); fa.movers.push(m);
        fa.dur = Math.max(fa.dur, m.arrive + 0.3);
      }
      if (bb.result === 'OUT') fa.throwTo = f === '1B' ? null : [62.8, 63.6];
    } else {
      let tEnd = bb.T;
      if (bb.result === 'OUT' && bb.catchT) tEnd = bb.catchT;
      fa.dur = tEnd / animScale;
      const roll = bb.result === 'OUT' || bb.result === 'HR' ? 0 : Math.min(60, bb.ev * 0.45);
      fa.roll = roll;
      fa.ball = (tA) => {
        const t = tA * animScale;
        if (t <= tEnd) { const s = ptAt(t); const [x, z] = dirXY(s.d); return { x, z, h: s.h }; }
        const u = Math.min(1, (t - tEnd) / 1.2); const d = ptAt(tEnd).d + roll * (1 - (1 - u) * (1 - u)); const [x, z] = dirXY(d); return { x, z, h: roll ? Math.abs(Math.sin(u * Math.PI * 2.5)) * 6 * Math.pow(1 - u, 1.6) : 0 };
      };
      fa.fielder = bb.fielder || 'CF';
      fa.from = fpos(fa.fielder);
      const landD = bb.result === 'OUT' && bb.catchD ? bb.catchD : Math.min(bb.dist, E.fenceDist(bb.phi) - 3);
      fa.to = bb.result === 'HR' ? dirXY(E.fenceDist(bb.phi) - 6) : dirXY(bb.result === 'OUT' ? landD : landD + roll);
      fa.land = bb.result === 'HR' ? dirXY(Math.min(bb.dist, E.fenceDist(bb.phi) + 40)) : dirXY(landD);
      fa.landT = tEnd / animScale; fa.caught = bb.result === 'OUT'; fa.hr = bb.result === 'HR';
      fa.scale = animScale; fa.movers = [];
      const isOF = E.FIELDERS[fa.fielder][1] > 200, base = isOF ? 21 : 15;
      if (bb.result === 'OUT') {
        // camp under it: arrive by the catch
        const D = Math.hypot(fa.to[0] - fa.from[0], fa.to[1] - fa.from[1]);
        fa.movers.push(mover(fa.fielder, fa.from, fa.to, 0.6, Math.max(base, D / Math.max(0.3, tEnd - 0.6))));
      } else if (bb.result === 'HR') {
        fa.movers.push(mover(fa.fielder, fa.from, fa.to, 0.6, base));
      } else {
        // run for it at real speed, come up short, then chase the ball down after it bounces
        // a slower, later break on hits so the gap between glove and ball is obvious on the small map
        const m = mover(fa.fielder, fa.from, fa.land, 0.9, base * 0.7, null, fa.to, tEnd);
        fa.movers.push(m);
        fa.dur = Math.max(fa.dur + 1.2, (m.arrive + 0.4) / animScale);
      }
    }
    fa.runners = planRunners(fa);
    G.fa = fa;
    setPhase('field');
  }

  // Work out where each runner ends up from the bases before and after the play, then give each a path and a speed.
  const BASE_XY = [[0, 0], [62.8, 63.6], [0, 127.3], [-62.8, 63.6], [0, 0]]; // home, 1B, 2B, 3B, home
  function planRunners(fa) {
    const before = G.basesBefore, after = st().bases, info = G.afterInfo || {};
    let runs = info.r ? info.r.runs : 0;
    const free = [2, 1, 0].filter((i) => after[i]); // occupied after-bases, lead base first
    const list = [];
    const runnerAt = (i) => { // i = base index (0 = 1B) or -1 for the batter; base numbers are 1..4
      const start = i + 1;
      let dest, out = false;
      if (runs > 0) { dest = 4; runs--; }
      else { const j = free.find((b) => b + 1 > start); if (j !== undefined) { dest = j + 1; free.splice(free.indexOf(j), 1); } else { dest = Math.min(4, start + 1); out = true; } }
      return { start, dest, out };
    };
    for (let i = 2; i >= 0; i--) if (before[i]) list.push(runnerAt(i));
    if (fa.bb) list.push(runnerAt(-1));
    for (const r of list) {
      const dist = (r.dest - r.start) * 90;
      r.speed = Math.max(27, dist / (fa.dur + 1.6));
      r.T = dist / r.speed;
      if (r.out) r.T = Math.min(r.T, fa.dur + 0.4); // called out when the throw beats them
    }
    return list;
  }
  function runnerPos(r, t) {
    const u = Math.min(1, t / r.T), d = (r.start + (r.dest - r.start) * u);
    const seg = Math.min(3, Math.floor(d)), f = d - seg;
    const a = BASE_XY[seg], b = BASE_XY[seg + 1];
    return [lerp(a[0], b[0], f), lerp(a[1], b[1], f), u >= 1];
  }
  function drawRunners(T, fa, el) {
    const mine = S.role === 'batter';
    ctx.font = `700 ${Math.max(8, T.sc * 11)}px "Saira Condensed", sans-serif`; ctx.textAlign = 'center';
    for (const r of fa.runners) {
      const [x, z, done] = runnerPos(r, el);
      const s = F(T, x, z);
      const since = el - r.T;
      if (done && r.dest === 4 && !r.out) { // scored: fade out at the plate
        const a = Math.max(0, 1 - since / 1.2); if (a <= 0) continue;
        ctx.globalAlpha = a; ctx.fillStyle = COL.wallTop; ctx.beginPath(); ctx.arc(s[0], s[1], Math.max(4, T.sc * 6), 0, 7); ctx.fill();
        ctx.fillText('+1', s[0], s[1] - Math.max(8, T.sc * 10) - since * 12); ctx.globalAlpha = 1; continue;
      }
      if (done && r.out) {
        const a = Math.max(0, 1 - Math.max(0, since - 0.8) / 0.8); if (a <= 0) continue;
        ctx.globalAlpha = a; ctx.strokeStyle = '#ff5d52'; ctx.lineWidth = 2.5; const k = Math.max(4, T.sc * 6);
        ctx.beginPath(); ctx.moveTo(s[0] - k, s[1] - k); ctx.lineTo(s[0] + k, s[1] + k); ctx.moveTo(s[0] + k, s[1] - k); ctx.lineTo(s[0] - k, s[1] + k); ctx.stroke();
        ctx.fillStyle = '#ff5d52'; ctx.fillText('OUT', s[0], s[1] - k - 4); ctx.globalAlpha = 1; continue;
      }
      const bob = done ? 0 : Math.abs(Math.sin(el * 14)) * 2;
      ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.beginPath(); ctx.ellipse(s[0], s[1] + 2, Math.max(4, T.sc * 6), 2.5, 0, 0, 7); ctx.fill();
      ctx.fillStyle = mine ? '#e9e4d4' : '#9aa3b5'; ctx.strokeStyle = COL.wallTop; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(s[0], s[1] - bob, Math.max(4, T.sc * 6), 0, 7); ctx.fill(); ctx.stroke();
    }
  }
  // A fielder's run: toward A at a set speed from t0, then (optionally) on to B once the ball is down at tB.
  function mover(f, from, A, t0, speed, stopAt, B, tB) {
    const DA = Math.hypot(A[0] - from[0], A[1] - from[1]);
    const arriveA = t0 + DA / speed;
    const m = { f, from, A, t0, speed, stopAt, B, tB, arrive: arriveA };
    if (B) { const DB = Math.hypot(B[0] - A[0], B[1] - A[1]); m.startB = Math.max(arriveA, tB || 0); m.arrive = m.startB + DB / speed; }
    m.pos = (t) => {
      if (stopAt != null) t = Math.min(t, stopAt);
      const d1 = Math.min(DA, Math.max(0, (t - t0) * speed));
      if (d1 < DA || !B) { const u = DA ? d1 / DA : 1; return [lerp(from[0], A[0], u), lerp(from[1], A[1], u)]; }
      const DB = Math.hypot(B[0] - A[0], B[1] - A[1]);
      const d2 = Math.min(DB, Math.max(0, (t - m.startB) * speed)); const u = DB ? d2 / DB : 1;
      return [lerp(A[0], B[0], u), lerp(A[1], B[1], u)];
    };
    return m;
  }
  function fieldTransform() {
    const sc = Math.min((W - 20) / 520, (H - 110) / 440);
    return { sc, ox: W / 2, oy: Math.min(H - 22, (H + 470 * sc) / 2 + 40) };
  }
  function F(T, x, z, h = 0) { return [T.ox + x * T.sc, T.oy - z * T.sc - h * T.sc * 0.55]; }

  function drawField(now) {
    const T = fieldTransform();
    ctx.fillStyle = '#0b1424'; ctx.fillRect(0, 0, W, H);
    const poly = (pts, col) => { ctx.beginPath(); pts.forEach((p, i) => { const s = F(T, p[0], p[2]); if (i) ctx.lineTo(s[0], s[1]); else ctx.moveTo(s[0], s[1]); }); ctx.closePath(); ctx.fillStyle = col; ctx.fill(); };
    // stands ring
    const ring = []; for (let a = -50; a <= 50; a += 2.5) { const [x, z] = E.fieldXY(a, E.fenceDist(Math.max(-45, Math.min(45, a))) + 40); ring.push([x, 0, z]); }
    poly([[0, 0, -30], ...ring], '#141c2c');
    poly([[-280, 0, -20], [280, 0, -20], [280, 0, 430], [-280, 0, 430]].map((p) => p), 'rgba(0,0,0,0)');
    poly(GEO.track.map((p) => p), COL.track);
    ctx.save(); poly(GEO.grass, COL.grassA); ctx.clip();
    for (let z = 0; z < 430; z += 26) { const a = F(T, -400, z), b = F(T, 400, z + 13); ctx.fillStyle = COL.grassB; ctx.fillRect(a[0], b[1], b[0] - a[0], a[1] - b[1]); }
    ctx.restore();
    poly(GEO.dirt, COL.dirt); poly(GEO.infGrass, COL.grassA); poly(GEO.cut1, COL.dirt); poly(GEO.cut3, COL.dirt); poly(GEO.mound, COL.dirtD); poly(GEO.homeDirt, COL.dirt);
    ctx.strokeStyle = COL.chalk; ctx.lineWidth = 1.2;
    ctx.beginPath(); let a0 = F(T, 0, 0), a1 = F(T, 233.3, 233.3), a2 = F(T, -233.3, 233.3); ctx.moveTo(a1[0], a1[1]); ctx.lineTo(a0[0], a0[1]); ctx.lineTo(a2[0], a2[1]); ctx.stroke();
    // fence
    ctx.strokeStyle = COL.wallTop; ctx.lineWidth = 2.5; ctx.beginPath();
    for (let a = -45; a <= 45; a += 2.5) { const [x, z] = E.fieldXY(a, E.fenceDist(a)); const s = F(T, x, z); if (a === -45) ctx.moveTo(s[0], s[1]); else ctx.lineTo(s[0], s[1]); }
    ctx.stroke();
    ctx.fillStyle = 'rgba(241,236,220,.7)'; ctx.font = `600 ${Math.max(9, T.sc * 14)}px "Saira Condensed", sans-serif`; ctx.textAlign = 'center';
    for (const a of [-45, -22, 0, 22, 45]) { const r = E.fenceDist(a); const [x, z] = E.fieldXY(a, r + 14); const s = F(T, x, z); ctx.fillText(distNum(r), s[0], s[1]); }
    // bases
    for (const [bx, bz] of [[62.8, 63.6], [0, 127.3], [-62.8, 63.6]]) { const s = F(T, bx, bz); ctx.fillStyle = '#fff'; ctx.fillRect(s[0] - 2.5, s[1] - 2.5, 5, 5); }
    const hp = F(T, 0, 0); ctx.fillStyle = '#fff'; ctx.fillRect(hp[0] - 2.5, hp[1] - 2.5, 5, 5);
    const fa = G.fa; if (!fa) return;
    const el = (now - fa.t0) / 1000;
    drawRunners(T, fa, el);
    const t = Math.min(el, fa.dur);
    // fielders
    ctx.font = `700 ${Math.max(8, T.sc * 12)}px "Saira Condensed", sans-serif`;
    for (const f in E.FIELDERS) {
      const [fa2, fr] = E.FIELDERS[f]; let [x, z] = E.fieldXY(fa2, fr);
      const mv = fa.movers && fa.movers.find((m) => m.f === f);
      if (mv) [x, z] = mv.pos(t * fa.scale);
      const s = F(T, x, z);
      ctx.fillStyle = S.role === 'pitcher' ? '#e9e4d4' : '#9aa3b5';
      ctx.beginPath(); ctx.arc(s[0], s[1], Math.max(4, T.sc * 7), 0, 7); ctx.fill();
      ctx.fillStyle = '#0b1424'; ctx.fillText(f, s[0], s[1] + Math.max(3, T.sc * 4.5));
    }
    drawLanding(T, fa, t, el);
    // ball trail + ball
    ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.lineWidth = 1.5; ctx.setLineDash([2, 4]); ctx.beginPath();
    for (let i = 0; i <= 30; i++) { const b = fa.ball((t * i) / 30); const s = F(T, b.x, b.z, b.h); if (i) ctx.lineTo(s[0], s[1]); else ctx.moveTo(s[0], s[1]); }
    ctx.stroke(); ctx.setLineDash([]);
    let b = fa.ball(t);
    if (fa.throwTo && el > fa.dur) { const v = Math.min(1, (el - fa.dur) / 0.5); b = { x: lerp(fa.to[0], fa.throwTo[0], v), z: lerp(fa.to[1], fa.throwTo[1], v), h: 4 * Math.sin(v * Math.PI) }; }
    const sh = F(T, b.x, b.z), bs = F(T, b.x, b.z, b.h);
    ctx.fillStyle = 'rgba(0,0,0,.4)'; ctx.beginPath(); ctx.ellipse(sh[0], sh[1], 4, 2, 0, 0, 7); ctx.fill();
    const br = 3.5 + Math.min(5, b.h / 25);
    ctx.fillStyle = '#fff'; ctx.shadowColor = '#fff'; ctx.shadowBlur = 8; ctx.beginPath(); ctx.arc(bs[0], bs[1], br, 0, 7); ctx.fill(); ctx.shadowBlur = 0;

    // the call goes up the moment the ball lands or is caught, while the runners finish the play
    if (G.phase === 'field' && !fa.called && el >= fa.landT) {
      fa.called = true;
      const info = G.afterInfo;
      toast(info.txt.main, statcastLine(fa.bb) + (info.txt.sub ? `  ·  ${info.txt.sub}` : ''), info.txt.good);
    }
    if (G.phase === 'field' && el > fa.dur + (fa.throwTo ? 0.5 : 0.15)) {
      setPhase('fieldDone');
      renderHUD(); G.hudFrozen = false;
    }
  }
  // where the ball will come down: a shrinking target during the flight, then a dust burst and a lasting mark
  function drawLanding(T, fa, t, el) {
    if (!fa.land) return;
    const s = F(T, fa.land[0], fa.land[1]);
    const col = fa.hr ? '#ffbb4a' : fa.caught ? '#9aa3b5' : '#4fd88a';
    ctx.save();
    if (t < fa.landT) {
      const u = t / fa.landT, r = Math.max(5, T.sc * (26 - u * 18));
      ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.setLineDash([4, 4]); ctx.lineDashOffset = -el * 40;
      ctx.beginPath(); ctx.ellipse(s[0], s[1], r, r * 0.55, 0, 0, 7); ctx.stroke(); ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(s[0] - 5, s[1]); ctx.lineTo(s[0] + 5, s[1]); ctx.moveTo(s[0], s[1] - 3); ctx.lineTo(s[0], s[1] + 3); ctx.stroke();
    } else {
      const a = Math.min(1, (el - fa.landT) / 0.7);
      if (a < 1 && fa.caught) { // glove flash
        ctx.strokeStyle = '#fff'; ctx.globalAlpha = 1 - a; ctx.lineWidth = 3 - a * 2;
        ctx.beginPath(); ctx.arc(s[0], s[1], T.sc * (8 + a * 26), 0, 7); ctx.stroke();
        ctx.fillStyle = '#fff'; ctx.font = `800 ${Math.max(10, T.sc * 13)}px "Saira Condensed", sans-serif`; ctx.textAlign = 'center';
        ctx.fillText('CAUGHT', s[0], s[1] - T.sc * 12 - a * 10); ctx.globalAlpha = 1;
      } else if (a < 1) { // dust burst
        ctx.strokeStyle = col; ctx.globalAlpha = 1 - a; ctx.lineWidth = 3 - a * 2;
        const r = T.sc * (6 + a * 40);
        ctx.beginPath(); ctx.ellipse(s[0], s[1], r, r * 0.5, 0, 0, 7); ctx.stroke();
        ctx.fillStyle = fa.hr ? 'rgba(255,220,120,.9)' : 'rgba(210,180,140,.85)';
        ctx.font = `800 ${Math.max(10, T.sc * 13)}px "Saira Condensed", sans-serif`; ctx.textAlign = 'center';
        if (!fa.hr) ctx.fillText('SAFE', s[0], s[1] - T.sc * 12 - a * 10);
        for (let i = 0; i < 7; i++) { const an = i * 0.9 + 0.4, d = T.sc * (4 + a * 22); ctx.beginPath(); ctx.arc(s[0] + Math.cos(an) * d, s[1] - Math.abs(Math.sin(an)) * d * 0.6 - a * 6, (3 - a * 2.5) * Math.max(1, T.sc), 0, 7); ctx.fill(); }
        ctx.globalAlpha = 1;
      }
      // lasting mark
      ctx.fillStyle = col; ctx.beginPath(); ctx.ellipse(s[0], s[1], Math.max(4, T.sc * 7), Math.max(2.5, T.sc * 4), 0, 0, 7); ctx.fill();
      ctx.strokeStyle = '#0b1424'; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(s[0] - 4, s[1] - 3); ctx.lineTo(s[0] + 4, s[1] + 3); ctx.moveTo(s[0] + 4, s[1] - 3); ctx.lineTo(s[0] - 4, s[1] + 3); ctx.stroke();
      if (fa.hr) { ctx.fillStyle = col; ctx.font = `800 ${Math.max(11, T.sc * 16)}px "Saira Condensed", sans-serif`; ctx.textAlign = 'center'; ctx.fillText('HR', s[0], s[1] - Math.max(8, T.sc * 10)); }
    }
    ctx.restore();
  }
  function statcastLine(bb) {
    const base = `Exit velo ${spd(bb.ev, 1)} · Launch ${Math.round(bb.la)}°`;
    return bb.kind === 'GB' ? base : `${base} · ${dist(bb.dist)}`;
  }

  // ---------------- Pitch view render ----------------
  function drawPitchView(now) {
    cam = viewCam();
    drawPark(cam);
    const el = (now - G.t0) / 1000;
    const pv = S.role === 'pitcher';
    if (!pv && S.zone) drawZone(cam, 0.55);

    // swing progress
    let swingT = null;
    if (G.swingAnim) swingT = (now - G.swingAnim.t0) / 300;

    // ball position
    let ball = null, s = 0;
    const p = G.pitch;
    if (p && (G.phase === 'flight' || G.phase === 'after' || G.phase === 'contact' || G.phase === 'waitResult')) {
      const fd = p.T / timeScale();
      const tFlight = G.phase === 'flight' ? el : fd + (now - G.t0) / 1000;
      s = tFlight / fd;
      if (G.hit && (G.phase === 'contact' || G.phase === 'after')) {
        const ht = (now - G.hit.t0) / 1000;
        if (G.hit.foul && G.hit.fx !== undefined) {
          ball = { x: p.px + G.hit.fx * ht, y: p.py + G.hit.fy * ht - 16 * ht * ht, z: G.hit.fz * ht };
        } else {
          const v = G.hit.ev * 1.4667, la = G.hit.la * Math.PI / 180, ph = G.hit.spray * Math.PI / 180;
          ball = { x: p.px + v * Math.cos(la) * Math.sin(ph) * ht, y: Math.max(0, p.py + v * Math.sin(la) * ht - 16 * ht * ht), z: v * Math.cos(la) * Math.cos(ph) * ht };
        }
        if (ht > 0.9) ball = null;
      } else if (s <= 1.06) ball = E.pitchPos(p, Math.min(s, 1.06));
      else if (G.phase === 'after' && el < 0.5) ball = E.pitchPos(p, 1.06);
    }

    if (pv) {
      // far: catcher, umpire, batter; near: pitcher from behind
      drawCatcherUmp(cam, G.phase === 'idle' ? G.target : (p ? { x: lerp(p.tx, p.px, Math.min(1, Math.max(0, s - 0.6) * 2.5)), y: lerp(p.ty, p.py, Math.min(1, Math.max(0, s - 0.6) * 2.5)) } : G.target));
      drawZone(cam, 0.45);
      drawBatter(cam, G.bHand, swingT, 'cpu', 1, now);
      if (G.phase === 'idle') {
        const m = P(cam, G.target.x, G.target.y, 0);
        if (m) { ctx.strokeStyle = 'rgba(255,187,74,.9)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(m.x, m.y, Math.max(6, m.k * 0.35), 0, 7); ctx.stroke(); }
      }
      if (ball) drawTrail(ball);
      const w = G.phase === 'windup' ? el / WINDUP : (G.phase === 'flight' || G.phase === 'after' || G.phase === 'contact' || G.phase === 'waitResult') ? 1 + Math.min(0.3, (G.phase === 'flight' ? el : 0.3)) : 0;
      drawPitcher(cam, G.pHand, w, 'me', true, 0.92);
      if (ball) drawBall3D(cam, ball, true);
    } else {
      const w = G.phase === 'windup' ? el / WINDUP : (G.phase === 'flight') ? 1 + Math.min(0.3, el) : (G.phase === 'after' || G.phase === 'contact') ? 1.3 : 0;
      drawFielders(cam, 'cpu', now);
      drawPitcher(cam, G.pHand, w, 'cpu', false, 1);
      if (ball) { drawTrail(ball); drawBall3D(cam, ball, false); }
      drawBatter(cam, G.bHand, swingT, 'me', 0.75);
      // aim reticle while the finger is down
      if (G.aim) {
        const pt = screenToPlate(cam, G.aim.sx, G.aim.sy - G.aim.off);
        const c = pt && P(cam, pt.x, pt.y, 0);
        if (c) {
          ctx.save();
          ctx.fillStyle = 'rgba(255,187,74,.16)'; ctx.strokeStyle = COL.wallTop; ctx.lineWidth = 2.5;
          ctx.beginPath(); ctx.ellipse(c.x, c.y, c.k * E.SWEET.x, c.k * E.SWEET.y, 0, 0, 7); ctx.fill(); ctx.stroke();
          ctx.fillStyle = 'rgba(255,187,74,.28)'; ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.ellipse(c.x, c.y, c.k * E.SWEET.x * 0.5, c.k * E.SWEET.y * 0.5, 0, 0, 7); ctx.fill(); ctx.stroke();
          ctx.lineWidth = 2.5;
          ctx.beginPath(); ctx.moveTo(c.x - 7, c.y); ctx.lineTo(c.x + 7, c.y); ctx.moveTo(c.x, c.y - 7); ctx.lineTo(c.x, c.y + 7); ctx.stroke();
          ctx.restore();
        }
      }
      // swing reticle
      if (G.reticle) {
        const age = (now - G.reticle.t0) / 1000;
        const c = P(cam, G.reticle.x, G.reticle.y, 0);
        if (c && age < 1.4) {
          ctx.save(); ctx.globalAlpha = Math.max(0, 1 - age / 1.4);
          ctx.strokeStyle = COL.wallTop; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.ellipse(c.x, c.y, c.k * E.SWEET.x, c.k * E.SWEET.y, 0, 0, 7); ctx.stroke();
          ctx.beginPath(); ctx.ellipse(c.x, c.y, c.k * E.SWEET.x * 0.5, c.k * E.SWEET.y * 0.5, 0, 0, 7); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(c.x - 5, c.y); ctx.lineTo(c.x + 5, c.y); ctx.moveTo(c.x, c.y - 5); ctx.lineTo(c.x, c.y + 5); ctx.stroke();
          ctx.restore();
        }
      }
    }
    // pitch location marker after the pitch
    if (G.phase === 'after' && p && !(G.hit && !G.hit.foul)) {
      const m = P(cam, p.px, p.py, 0);
      const hold = G.freeze && G.freeze.kind === 'plate';
      if (hold) drawZone(cam, 0.95);
      if (m) {
        const zone = E.inZone(p.px, p.py), col = zone ? 'rgba(255,187,74,.9)' : 'rgba(79,216,138,.9)';
        if (hold) {
          const u = Math.min(1, (now - G.freeze.t0) / G.freeze.dur);
          ctx.strokeStyle = col; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(m.x, m.y, Math.max(10, m.k * 0.25) + u * 10, 0, 7); ctx.stroke();
          ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(m.x - 16, m.y); ctx.lineTo(m.x + 16, m.y); ctx.moveTo(m.x, m.y - 16); ctx.lineTo(m.x, m.y + 16); ctx.stroke();
        }
        ctx.fillStyle = col;
        ctx.beginPath(); ctx.arc(m.x, m.y, Math.max(4, m.k * 0.121), 0, 7); ctx.fill();
        ctx.strokeStyle = '#0a111d'; ctx.lineWidth = 1.5; ctx.stroke();
      }
    }
    // timing feedback for the batter
    if (!pv && G.phase === 'after' && G.outcome && G.outcome.dec.swing && G.outcome.dec.dt !== undefined) drawTimingBar(G.outcome.dec.dt);
  }

  // flash and rings at the contact point during and just after the hit stop
  function drawImpact(now) {
    const f = G.freeze, age = (now - f.t0) / 1000, total = f.dur / 1000 + 0.45;
    if (age > total) { G.freeze = null; return; }
    const u = age / total;
    ctx.save();
    if (age < f.dur / 1000) { ctx.fillStyle = `rgba(255,255,255,${0.55 * (1 - age / (f.dur / 1000))})`; ctx.fillRect(0, 0, W, H); }
    const r0 = 10 + u * 140;
    ctx.strokeStyle = `rgba(255,220,120,${1 - u})`; ctx.lineWidth = 4 * (1 - u) + 1;
    ctx.beginPath(); ctx.arc(f.x, f.y, r0, 0, 7); ctx.stroke();
    ctx.beginPath(); ctx.arc(f.x, f.y, r0 * 0.6, 0, 7); ctx.stroke();
    ctx.fillStyle = `rgba(255,255,255,${0.9 * (1 - u)})`;
    for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4 + 0.3, d = 14 + u * 90; ctx.beginPath(); ctx.arc(f.x + Math.cos(a) * d, f.y + Math.sin(a) * d, 3 * (1 - u) + 0.5, 0, 7); ctx.fill(); }
    ctx.font = `800 ${28 + u * 10}px "Saira Condensed", sans-serif`; ctx.textAlign = 'center'; ctx.fillStyle = `rgba(255,187,74,${1 - u})`;
    ctx.fillText(f.q >= 0.9 ? 'PERFECT!' : 'SWEET SPOT!', f.x, f.y - 40 - u * 30);
    ctx.restore();
  }
  function drawTrail(ball) {
    const pr = P(cam, ball.x, ball.y, ball.z); if (!pr) return;
    G.trail.push([pr.x, pr.y]); if (G.trail.length > 7) G.trail.shift();
    ctx.strokeStyle = 'rgba(255,255,255,.25)'; ctx.lineWidth = 2; ctx.beginPath();
    G.trail.forEach((q, i) => (i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]))); ctx.stroke();
  }

  function drawTimingBar(dt) {
    const w = Math.min(220, W - 60), x0 = (W - w) / 2, y = H - 46;
    ctx.fillStyle = 'rgba(8,14,26,.75)'; ctx.fillRect(x0 - 10, y - 18, w + 20, 34);
    ctx.fillStyle = 'rgba(79,216,138,.35)'; ctx.fillRect(x0 + w / 2 - w * 0.18, y - 4, w * 0.36, 8);
    ctx.strokeStyle = 'rgba(241,236,220,.6)'; ctx.lineWidth = 1; ctx.strokeRect(x0, y - 4, w, 8);
    const v = Math.max(-1, Math.min(1, dt / (E.TIMING_WIN * 2)));
    const mx = x0 + w / 2 + v * w / 2;
    ctx.fillStyle = COL.wallTop; ctx.fillRect(mx - 2, y - 9, 4, 18);
    ctx.fillStyle = COL.chalk; ctx.font = '600 10px "IBM Plex Sans KR", sans-serif'; ctx.textAlign = 'left'; ctx.fillText('Early', x0, y - 8); ctx.textAlign = 'right'; ctx.fillText('Late', x0 + w, y - 8);
    ctx.textAlign = 'center'; ctx.fillText(`${dt >= 0 ? '+' : ''}${Math.round(dt * 1000)}ms`, x0 + w / 2, y + 15);
  }

  // ---------------- UI ----------------
  let toastTimer = null;
  function toast(main, subt, good, kind) {
    const el = $('toast');
    el.textContent = '';
    el.append(document.createTextNode(main));
    if (subt) { const sm = document.createElement('small'); sm.textContent = subt; el.append(sm); }
    let color = '#f1ecdc';
    if (good === true) color = '#ffbb4a';
    else if (good === false) color = '#ff8a80';
    else if (kind === 'ball') color = '#4fd88a';
    else if (kind === 'strike') color = '#ffbb4a';
    el.style.color = color;
    el.style.fontSize = good == null ? '34px' : '44px';
    el.style.top = (G.phase === 'field' || G.phase === 'fieldDone' || G.phase === 'contact') ? '22%' : '';
    el.classList.add('show');
    clearTimeout(toastTimer);
  }
  const hideToast = () => $('toast').classList.remove('show');
  function banner(t) { const b = $('banner'); b.textContent = ''; if (t) { const s = document.createElement('span'); s.textContent = t; b.append(s); } }
  let bannerTimer = null;
  function bannerFlash(t) { banner(t); clearTimeout(bannerTimer); bannerTimer = setTimeout(() => { if (G.phase !== 'idle') banner(''); else banner(PITCH_HINT); }, 2600); }

  function showPitchInfo() {
    const p = G.pitch; const el = $('pinfo'); el.textContent = '';
    const b = document.createElement('b'); b.textContent = spd(p.mph, 1);
    const pw = p.pw == null ? 0.5 : p.pw;
    const eff = pw >= 0.95 ? ' · PERFECT power' : pw >= 0.8 ? ' · Max effort' : pw <= 0.25 ? ' · Easy' : '';
    const s = document.createElement('span'); s.textContent = E.PITCHES[p.type].name + eff;
    el.append(b, s);
  }

  function renderHUD() {
    if (G.hudFrozen) return;
    const s = st();
    $('hInning').textContent = `${s.half ? '▼' : '▲'}${s.inning}`;
    const set = (id, n) => [...$(id).children].forEach((c, i) => c.classList.toggle('on', i < n));
    set('hB', Math.min(3, s.balls)); set('hS', Math.min(2, s.strikes)); set('hO', Math.min(2, s.outs));
    $('hMe').textContent = s.score.me; $('hOpp').textContent = s.score.opp;
    $('hOppLab').textContent = G.mp ? 'FRIEND' : 'CPU';
    $('hMeLab').classList.toggle('bat', S.role === 'batter'); $('hOppLab').classList.toggle('bat', S.role === 'pitcher');
    ['b1', 'b2', 'b3'].forEach((id, i) => { const r = $(id); r.setAttribute('fill', s.bases[i] ? '#ffbb4a' : '#1f2b40'); r.setAttribute('stroke', s.bases[i] ? '#ffbb4a' : '#3a4c6e'); r.setAttribute('stroke-width', '1.5'); });
  }
  const handName = (h, role) => (role === 'pitcher' ? (h === 'R' ? 'RHP' : 'LHP') : (h === 'R' ? 'RHB' : 'LHB'));
  function renderMatchup() {
    const me = S.role === 'pitcher' ? `You ${handName(G.pHand, 'pitcher')}` : `You ${handName(G.bHand, 'batter')}`;
    const cpu = S.role === 'pitcher' ? `CPU ${handName(G.bHand, 'batter')}` : `CPU ${handName(G.pHand, 'pitcher')}`;
    const opp = G.mp ? cpu.replace('CPU', 'Friend') + `  ·  ${G.mp.innings} inn` : cpu;
    $('matchup').textContent = `${me}  vs  ${opp}`;
  }

  // pitcher controls
  function buildPitchList() {
    const box = $('pitchList'); box.textContent = '';
    for (const k of Object.keys(E.PITCHES)) {
      const b = document.createElement('button'); b.className = 'pbtn'; b.dataset.k = k;
      const n = document.createElement('b'); n.textContent = E.PITCHES[k].name;
      const i = document.createElement('i'); i.textContent = spd(E.PITCHES[k].mph);
      b.append(n, i); b.setAttribute('aria-pressed', k === G.pitchType ? 'true' : 'false');
      b.addEventListener('click', () => { G.pitchType = k; [...box.children].forEach((c) => c.setAttribute('aria-pressed', c.dataset.k === k ? 'true' : 'false')); });
      box.append(b);
    }
  }
  const PAD = { x0: -1.6, x1: 1.6, y0: 0.5, y1: 4.5 };
  function setTarget(x, y) {
    G.target = { x: E.clamp(x, PAD.x0, PAD.x1), y: E.clamp(y, PAD.y0, PAD.y1) };
    renderPad();
  }
  function renderPad() {
    // pad is drawn from the pitcher's point of view: screen-left = 1B side (+x)
    const u = (PAD.x1 - G.target.x) / (PAD.x1 - PAD.x0), v = (PAD.y1 - G.target.y) / (PAD.y1 - PAD.y0);
    const mk = $('padMk'); mk.style.left = `${u * 100}%`; mk.style.top = `${v * 100}%`;
    const side = $('padSide');
    const batterOnRight = G.bHand === 'R';
    side.textContent = batterOnRight ? 'Batter ▸' : '◂ Batter';
    side.style.left = batterOnRight ? '' : '22px'; side.style.right = batterOnRight ? '4px' : '';
  }
  function padPointer(e) {
    if (G.phase !== 'idle') return;
    const r = $('pad').getBoundingClientRect();
    const u = E.clamp((e.clientX - r.left) / r.width, 0, 1), v = E.clamp((e.clientY - r.top) / r.height, 0, 1);
    setTarget(PAD.x1 - u * (PAD.x1 - PAD.x0), PAD.y1 - v * (PAD.y1 - PAD.y0));
  }

  // ---------------- Stats overlay ----------------
  const f3 = (v) => (v == null ? '-' : v.toFixed(3).replace(/^0/, ''));
  const f2 = (v) => (v == null ? '-' : v.toFixed(2));
  const pct = (v) => (v == null ? '-' : `${(v * 100).toFixed(1)}%`);
  let statTab = 'pitcher';
  function statBlock(body, stats, which, title) {
    const d = E.derived(stats);
    if (title) { const h = document.createElement('div'); h.className = 'note'; h.style.marginTop = '6px'; h.textContent = title; body.append(h); }
    const grid = document.createElement('div'); grid.className = 'statgrid';
    const add = (lab, val, key) => { const c = document.createElement('div'); c.className = 'stat' + (key ? ' key' : ''); const s = document.createElement('span'); s.textContent = lab; const b = document.createElement('b'); b.textContent = val; c.append(s, b); grid.append(c); };
    const line = document.createElement('div'); line.className = 'line';
    if (which === 'pitcher') {
      const p = stats.pitcher;
      add('ERA', f2(d.era), true); add('Strikeouts', p.K, true); add('WHIP', f2(d.whip), true);
      add('Innings', d.ipText); add('Opp AVG', f3(d.oppAvg)); add('K/9', f2(d.k9));
      add('Walks', p.BB); add('HR allowed', p.HR); add('Pitches', p.pitches);
      line.textContent = `IP ${d.ipText}   H ${p.H}   R ${p.R}   ER ${p.ER}   BB ${p.BB}   K ${p.K}   HBP ${p.HBP}   BF ${p.BF}`;
    } else {
      const b = stats.batter;
      add('AVG', f3(d.avg), true); add('OPS', f3(d.ops), true); add('Home runs', b.HR, true);
      add('OBP', f3(d.obp)); add('SLG', f3(d.slg)); add('RBI', b.RBI);
      add('Walks', b.BB); add('Strikeouts', b.K); add('BB% / K%', `${pct(d.bBBPct)} / ${pct(d.bKPct)}`.replace(/%/g, ''));
      line.textContent = `PA ${b.PA}   AB ${b.AB}   H ${b.H}   2B ${b.d2}   3B ${b.d3}   HR ${b.HR}   BB ${b.BB}   HBP ${b.HBP}   K ${b.K}   SF ${b.SF}`;
    }
    body.append(grid, line);
  }
  function renderStats() {
    [...$('statTabs').children].forEach((b) => b.setAttribute('aria-pressed', b.dataset.t === statTab ? 'true' : 'false'));
    const body = $('statBody'); body.textContent = '';
    const note = document.createElement('div'); note.className = 'note';
    let logs;
    if (statTab === 'friend') {
      statBlock(body, save.mpStats, 'pitcher', 'YOUR PITCHING VS FRIENDS');
      statBlock(body, save.mpStats, 'batter', 'YOUR HITTING VS FRIENDS');
      note.textContent = 'Games against a friend are kept apart from your stats against the CPU.';
      logs = save.mpLogs;
    } else {
      statBlock(body, save.stats, statTab);
      const LV = ['Rookie', 'MLB average', 'All-Star'];
      note.textContent = statTab === 'pitcher'
        ? `Average MLB starter: about 4.20 ERA, 1.30 WHIP, 8.5 K/9. CPU hitters are set to ${LV[S.cpuBatLv]} (change in Settings).`
        : `Average MLB hitter: about .245 AVG, .315 OBP, .400 SLG, .715 OPS. The CPU pitcher is set to ${LV[S.cpuPitchLv]} (change in Settings).`;
      logs = save.logs[statTab];
    }
    body.append(note);
    if (logs.length) {
      const h = document.createElement('div'); h.className = 'note'; h.style.marginTop = '12px'; h.textContent = 'Recent plate appearances';
      const lg = document.createElement('div'); lg.className = 'log';
      logs.slice(0, 12).forEach((l) => { const r = document.createElement('div'); const a = document.createElement('span'); a.textContent = `Inn ${l.inn}  ${l.txt}${l.sub ? ' · ' + l.sub : ''}`; const c = document.createElement('span'); c.textContent = `${l.cnt}`; r.append(a, c); lg.append(r); });
      body.append(h, lg);
    }
    renderQuit(false);
    renderReset();
  }
  function renderReset(confirming) {
    const ra = $('resetArea'); ra.textContent = '';
    const name = statTab === 'pitcher' ? 'pitching' : statTab === 'batter' ? 'hitting' : 'vs friend';
    if (!confirming) {
      const b = document.createElement('button'); b.className = 'ghost'; b.style.width = '100%'; b.textContent = `Reset ${name} stats`;
      b.addEventListener('click', () => renderReset(true)); ra.append(b);
    } else {
      const w = document.createElement('div'); w.className = 'confirm';
      const t = document.createElement('span'); t.textContent = `Delete all ${name} stats and the game in progress?`;
      const y = document.createElement('button'); y.textContent = 'Delete';
      const n = document.createElement('button'); n.textContent = 'Cancel'; n.style.borderColor = '#26385a'; n.style.color = '#f1ecdc';
      y.addEventListener('click', () => {
        if (statTab === 'friend') { save.mpStats = E.newStats(); save.mpLogs = []; persist(); renderStats(); return; }
        const fs = E.newStats(); save.stats[statTab] = fs[statTab]; save.games.duel = newDuel(); save.logs[statTab] = [];
        persist(); renderStats(); if (statTab === S.role && G.started) startPA();
      });
      n.addEventListener('click', () => renderReset(false));
      w.append(t, y, n); ra.append(w);
    }
  }

  // ---------------- Overlay navigation ----------------
  // Sub-screens stack on top of each other; Back (or the phone's back gesture) returns one level.
  const ovStack = [];
  function openOv(id) {
    const cur = ovStack[ovStack.length - 1]; if (cur) $(cur).hidden = true;
    if (!ovStack.length) $('startOv').hidden = true;
    ovStack.push(id); $(id).hidden = false;
    try { history.pushState({ ov: ovStack.length }, ''); } catch (e) { /* ignore */ }
  }
  function closeOv() {
    const id = ovStack.pop(); if (!id) return;
    $(id).hidden = true;
    const prev = ovStack[ovStack.length - 1];
    if (prev) $(prev).hidden = false;
    else { if (!G.started) $('startOv').hidden = false; G.paused = false; }
  }
  function closeAllOv() { while (ovStack.length) closeOv(); }
  function back() { if (history.state && history.state.ov && ovStack.length) history.back(); else closeOv(); }
  window.addEventListener('popstate', (e) => { const depth = (e.state && e.state.ov) || 0; while (ovStack.length > depth) closeOv(); });
  document.querySelectorAll('.backbtn').forEach((b) => b.addEventListener('click', back));

  // ---------------- Start overlay ----------------
  function renderStart() {
    $('rolePitcher').setAttribute('aria-pressed', S.role === 'pitcher' ? 'true' : 'false');
    $('roleBatter').setAttribute('aria-pressed', S.role === 'batter' ? 'true' : 'false');
    const segs = { myThrowSeg: 'myThrow', myBatSeg: 'myBat', cpuThrowSeg: 'cpuThrow', cpuBatSeg: 'cpuBat', mpInnSeg: 'mpInn' };
    for (const id in segs) [...$(id).children].forEach((b) => b.setAttribute('aria-pressed', b.dataset.v === String(S[segs[id]]) ? 'true' : 'false'));
  }
  function setRolePanels() {
    $('pitcherPanel').hidden = S.role !== 'pitcher';
    $('batterPanel').hidden = S.role !== 'batter';
    $('pinfo').textContent = '';
    resize();
  }
  function startGame() {
    mpLeave(); mpStatus(null);
    $('startOv').hidden = true; G.started = true; G.paused = false;
    setRolePanels();
    $('pinfo').textContent = '';
    persist(); resize();
    const s = st();
    // resume the current at-bat count only between pitches
    s.balls = 0; s.strikes = 0;
    if (!G.mp) { if (duelInProgress() && s.role) S.role = s.role; s.role = S.role; setRolePanels(); }
    if (window.ndTrack) ndTrack('single');
    startPA();
  }

  // ---------------- Multiplayer (room code) ----------------
  // Two phones join the same named room. Each side publishes its role, hand
  // and latest message in its presence. The pitcher sends pitches; the
  // batter's phone decides each outcome and sends it back with the new state.
  let roomApi = null, roomApiTried = false;
  async function getRoomApi() {
    if (roomApi || roomApiTried) return roomApi;
    roomApiTried = true;
    try {
      if (window.claude && typeof window.claude.use === 'function') roomApi = await window.claude.use('room');
      else if (window.firebase && window.FIREBASE_CONFIG) roomApi = firebaseRoom();
      else if (location.protocol === 'file:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1') roomApi = mockRoom();
    } catch (e) { roomApi = null; }
    if (!roomApi) roomApiTried = false;
    return roomApi;
  }
  // Public web build: rooms live in Firebase Realtime Database at rooms/<name>/peers/<peerId>
  function firebaseRoom() {
    if (!firebase.apps.length) firebase.initializeApp(window.FIREBASE_CONFIG);
    const db = firebase.database();
    const me = db.ref().push().key;
    return {
      join: async (name) => {
        const base = db.ref('rooms/' + name + '/peers'), mineRef = base.child(me);
        let mine = {}, list = [], prev = new Map(), live = false;
        const hs = [];
        await mineRef.onDisconnect().remove();
        await mineRef.set({ p: JSON.stringify(mine), t: firebase.database.ServerValue.TIMESTAMP });
        const conRef = db.ref('.info/connected');
        const onCon = conRef.on('value', (v) => { live = !!v.val(); if (live) { mineRef.onDisconnect().remove(); mineRef.set({ p: JSON.stringify(mine), t: firebase.database.ServerValue.TIMESTAMP }); } });
        const onVal = base.on('value', (snap) => {
          const val = snap.val() || {}, next = new Map();
          for (const id in val) { let pr = {}; try { pr = JSON.parse(val[id].p || '{}'); } catch (e) { pr = {}; } next.set(id, prev.get(id) && JSON.stringify(prev.get(id).presence) === JSON.stringify(pr) ? prev.get(id) : { peer: id, isMe: id === me, sameTab: id === me, presence: pr }); }
          const joined = [...next.values()].filter((p) => !prev.has(p.peer)), left = [...prev.values()].filter((p) => !next.has(p.peer));
          prev = next; list = [...next.values()];
          hs.forEach((h) => h({ peers: list, joined, left, updated: [] }));
        });
        return {
          name,
          presence: async (patch) => { mine = { ...mine, ...patch }; await mineRef.set({ p: JSON.stringify(mine), t: firebase.database.ServerValue.TIMESTAMP }); },
          onPeers: (h) => { hs.push(h); if (list.length) setTimeout(() => h({ peers: list, joined: list, left: [], updated: [] }), 0); return () => { const i = hs.indexOf(h); if (i >= 0) hs.splice(i, 1); }; },
          peers: () => list, connected: () => live,
          leave: async () => { base.off('value', onVal); conRef.off('value', onCon); hs.length = 0; await mineRef.remove(); },
        };
      },
    };
  }
  function mockRoom() { // local testing only: tabs of one browser talk over BroadcastChannel
    const me = Math.random().toString(36).slice(2, 10);
    return {
      join: async (name) => {
        const bc = new BroadcastChannel('mock-' + name); let mine = {}; const others = new Map(); const hs = [];
        const snap = () => [{ peer: me, isMe: true, sameTab: true, presence: mine }, ...[...others].map(([peer, v]) => ({ peer, isMe: false, sameTab: false, presence: v }))];
        const fire = (joined = [], left = []) => { const peers = snap(); hs.forEach((h) => h({ peers, joined, left, updated: [] })); };
        bc.onmessage = (e) => {
          const d = e.data;
          if (d.type === 'bye') { if (others.delete(d.peer)) fire([], [{ peer: d.peer }]); return; }
          const isNew = !others.has(d.peer); others.set(d.peer, d.presence);
          if (d.type === 'hello') bc.postMessage({ type: 'state', peer: me, presence: mine });
          fire(isNew ? [{ peer: d.peer }] : []);
        };
        bc.postMessage({ type: 'hello', peer: me, presence: mine });
        window.addEventListener('beforeunload', () => bc.postMessage({ type: 'bye', peer: me }));
        return {
          name,
          presence: async (patch) => { mine = { ...mine, ...patch }; bc.postMessage({ type: 'state', peer: me, presence: mine }); fire(); },
          onPeers: (h) => { hs.push(h); setTimeout(() => h({ peers: snap(), joined: snap(), left: [], updated: [] }), 0); return () => {}; },
          peers: snap, connected: () => true,
          leave: async () => { bc.postMessage({ type: 'bye', peer: me }); bc.close(); hs.length = 0; },
        };
      },
    };
  }

  function mpStatus(nodes) {
    const el = $('mpStatus'); el.textContent = '';
    el.hidden = !nodes; if (!nodes) return;
    nodes.forEach((n) => el.append(n));
  }
  const elt = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  function cancelBtn() { const b = elt('button', '', 'Cancel'); b.addEventListener('click', () => { mpLeave(); mpStatus(null); }); return b; }

  async function mpOpen(code, host) {
    mpLeave();
    const api = await getRoomApi();
    if (!api) { mpStatus([elt('div', '', 'Multiplayer is not available here. Check your internet connection and reload.')]); return; }
    let room;
    try { room = await api.join(`nd-${code}`); } catch (e) { mpStatus([elt('div', '', 'Could not open the room. Check your connection and try again.')]); return; }
    G.mp = {
      code, room, host, myRole: host ? S.role : null, oppPeer: null, oppHand: 'R', seq: 0, lastPitchSeq: 0, resultSeq: 0,
      pendingPitch: null, pendingResult: null, state: newDuel(), started: false, unsub: null, leftTimer: null, innings: S.mpInn,
    };
    G.mp.unsub = room.onPeers(mpPeers, () => mpGone('The connection to the room was lost.'));
    mpPresence();
  }
  function mpPresence(msg) {
    const m = G.mp; if (!m) return;
    if (msg !== undefined) m.out = msg;
    m.room.presence({ app: 'nd', v: 1, host: m.host, role: m.myRole, th: S.myThrow, bh: S.myBat, inn: m.innings, msg: m.out || null }).catch(() => {});
  }
  const mpSend = (msg) => mpPresence(msg);

  function mpPeers(change) {
    const m = G.mp; if (!m) return;
    const others = change.peers.filter((p) => !p.isMe && p.presence && p.presence.app === 'nd');
    if (!m.oppPeer) {
      const cand = m.host ? others.find((p) => !p.presence.host && (p.presence.role === 'pitcher' || p.presence.role === 'batter'))
        : others.find((p) => p.presence.host && (p.presence.role === 'pitcher' || p.presence.role === 'batter'));
      if (!cand) return;
      m.oppPeer = cand.peer;
      if (!m.host) { m.myRole = cand.presence.role === 'pitcher' ? 'batter' : 'pitcher'; S.role = m.myRole; m.innings = [3, 6, 9].includes(cand.presence.inn) ? cand.presence.inn : 3; mpPresence(); }
    }
    const opp = others.find((p) => p.peer === m.oppPeer);
    if (!opp) { if (m.started && !m.leftTimer) m.leftTimer = setTimeout(() => mpGone('Your friend left the room.'), 4000); return; }
    clearTimeout(m.leftTimer); m.leftTimer = null;
    m.oppThrow = opp.presence.th === 'L' ? 'L' : 'R'; m.oppBat = opp.presence.bh === 'L' ? 'L' : 'R';
    if (!m.started) {
      if (m.host && opp.presence.role !== (S.role === 'pitcher' ? 'batter' : 'pitcher')) return;
      mpStart();
    }
    const msg = opp.presence.msg;
    if (!msg || typeof msg !== 'object') return;
    m.lastMsg = msg;
    mpDispatch(msg);
  }
  function mpReplay() { if (G.mp && G.mp.lastMsg) mpDispatch(G.mp.lastMsg); }
  function mpDispatch(msg) {
    const m = G.mp; if (!m || !m.started) return;
    if (msg.t === 'pitch' && m.myRole === 'batter') { const p = cleanPitch(msg.p); if (p) takePitch({ seq: msg.seq | 0, p }); }
    else if (msg.t === 'result' && m.myRole === 'pitcher' && msg.o && msg.o.dec) takeResult(cleanResult(msg));
    else if (msg.t === 'forfeit') mpEnd(true, msg.why === 'quit' ? 'Your friend quit the game.' : 'Your friend ran out of time.');
  }
  const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
  function cleanPitch(p) {
    if (!p || !E.PITCHES[p.type]) return null;
    const rel = p.release || {};
    return {
      type: p.type, mph: num(p.mph, 90), pw: p.pw == null ? null : num(p.pw, 0.5), px: num(p.px), py: num(p.py, 2.5), tx: num(p.tx), ty: num(p.ty, 2.5), hand: p.hand === 'L' ? 'L' : 'R',
      brk: [num(p.brk && p.brk[0]), num(p.brk && p.brk[1])], release: { x: num(rel.x), y: num(rel.y, 5.9), z: num(rel.z, E.RELEASE_Z) },
      T: Math.min(1, Math.max(0.3, num(p.T, 0.43))),
    };
  }
  const EVENTS = ['K', 'BB', 'HBP', '1B', '2B', '3B', 'HR', 'OUT'];
  function cleanResult(msg) {
    const o = msg.o, txt = (v) => String(v || '').slice(0, 40);
    const bb = o.bb && typeof o.bb === 'object' ? {
      ev: num(o.bb.ev, 80), la: num(o.bb.la), phi: num(o.bb.phi), dist: num(o.bb.dist), T: num(o.bb.T), kind: ['GB', 'LD', 'FB', 'PU'].includes(o.bb.kind) ? o.bb.kind : 'GB',
      result: [...EVENTS, 'FOUL'].includes(o.bb.result) ? o.bb.result : 'OUT', how: txt(o.bb.how), fielder: E.FIELDERS[o.bb.fielder] ? o.bb.fielder : 'CF',
      catchT: o.bb.catchT == null ? undefined : num(o.bb.catchT), catchD: o.bb.catchD == null ? undefined : num(o.bb.catchD),
      gbAlong: num(o.bb.gbAlong, 120), gbT: num(o.bb.gbT, 1), gb: !!o.bb.gb, sf: !!o.bb.sf,
    } : null;
    const h = o.hitV && typeof o.hitV === 'object' ? (o.hitV.foul ? { foul: true, fx: num(o.hitV.fx), fy: num(o.hitV.fy, 30), fz: num(o.hitV.fz, -40) } : { foul: false, ev: num(o.hitV.ev, 80), la: num(o.hitV.la), spray: num(o.hitV.spray) }) : null;
    const r = o.r && typeof o.r === 'object' ? { runs: Math.max(0, Math.min(4, num(o.r.runs) | 0)), outs: Math.max(0, Math.min(3, num(o.r.outs) | 0)), text: txt(o.r.text), ended: !!o.r.ended } : null;
    const ev = EVENTS.includes(o.ev) ? o.ev : null;
    return {
      seq: msg.seq | 0, state: msg.state,
      o: { dec: { swing: !!o.dec.swing, result: ['miss', 'foul', 'play'].includes(o.dec.result) ? o.dec.result : null, quality: num(o.dec.quality, 0.5) },
        label: txt(o.label), kind: ['ball', 'strike', 'neutral'].includes(o.kind) ? o.kind : 'neutral', ev: ev && r ? ev : null, subl: txt(o.subl), bb, hitV: h, r, cnt: txt(o.cnt) },
    };
  }

  function mpStart() {
    const m = G.mp; m.started = true;
    if (m.host && window.ndTrack) ndTrack('multi');
    closeAllOv(); $('startOv').hidden = true; mpStatus(null);
    G.started = true; G.paused = false;
    setRolePanels();
    persist();
    bannerFlash(S.role === 'pitcher' ? `${G.mp.innings}-inning game. You pitch first!` : `${G.mp.innings}-inning game. Get ready to hit!`);
    startPA();
  }
  function mpGone(text) {
    if (!G.mp) return;
    if (G.mp.started) { mpEnd(true, 'Your friend left the game.'); return; }
    mpLeave();
    mpStatus([elt('div', '', text)]);
  }
  // the game is over: show the result and drop the room
  function mpEnd(win, reason, keepRoomMs) {
    const m = G.mp; if (!m || !m.started) return;
    const s = m.state;
    G.started = false; G.phase = 'menu'; G.pwr = null; renderPower(0); hideToast(); banner('');
    if (keepRoomMs) { G.mp = null; setTimeout(() => { G.mp = m; mpLeave(); }, keepRoomMs); } else mpLeave();
    showEnd(win, reason, s.score.me, s.score.opp, 'FRIEND', Math.min(s.inning, m.innings));
  }
  function mpForfeit() {
    const m = G.mp; if (!m) return;
    m.seq++; mpSend({ t: 'forfeit', seq: m.seq });
    mpEnd(false, `You did not pitch within ${TURN_SECS} seconds.`, 1500);
  }
  $('endBack').addEventListener('click', () => { closeAllOv(); $('startOv').hidden = false; renderStart(); });
  function mpLeave() {
    const m = G.mp; if (!m) return;
    G.mp = null;
    clearTimeout(m.leftTimer);
    try { m.unsub && m.unsub(); } catch (e) { /* ignore */ }
    m.room.leave().catch(() => {});
  }
  $('mpCreate').addEventListener('click', async () => {
    audio();
    $('mpJoinRow').hidden = true;
    const code = String(Math.floor(1000 + Math.random() * 9000));
    mpStatus([elt('div', '', 'Opening a room…')]);
    await mpOpen(code, true);
    if (!G.mp) return;
    mpStatus([elt('div', '', `${S.mpInn}-inning game. You play ${S.role === 'pitcher' ? 'pitcher' : 'batter'}. Ask your friend to tap Join with code and enter:`), elt('div', 'code', code), elt('div', '', 'Waiting for your friend…'), cancelBtn()]);
  });
  $('mpJoinShow').addEventListener('click', () => { $('mpJoinRow').hidden = false; mpStatus(null); $('mpCode').focus(); });
  $('mpCode').addEventListener('input', (e) => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4); });
  async function joinByCode() {
    audio();
    const code = $('mpCode').value.trim();
    if (!/^\d{4}$/.test(code)) { mpStatus([elt('div', '', 'Enter the 4-digit code from your friend’s screen.')]); return; }
    mpStatus([elt('div', '', `Joining room ${code}…`)]);
    await mpOpen(code, false);
    if (!G.mp) return;
    mpStatus([elt('div', '', `In room ${code}. Waiting for the room creator…`), elt('div', '', 'If nothing happens, check the code with your friend.'), cancelBtn()]);
  }
  $('mpJoin').addEventListener('click', joinByCode);
  $('mpCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinByCode(); });
  window.addEventListener('pagehide', () => mpLeave());

  // ---------------- Wiring ----------------
  function resize() {
    const r = $('stage').getBoundingClientRect();
    DPR = Math.min(2, window.devicePixelRatio || 1);
    W = Math.max(1, r.width); H = Math.max(1, r.height);
    cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }
  window.addEventListener('resize', resize);
  if (window.ResizeObserver) new ResizeObserver(resize).observe($('stage'));
  cv.addEventListener('pointerdown', onCanvasTap);
  cv.addEventListener('pointermove', onCanvasMove);
  cv.addEventListener('pointerup', onCanvasUp);
  cv.addEventListener('pointercancel', onCanvasUp);
  $('pad').addEventListener('pointerdown', (e) => { $('pad').setPointerCapture?.(e.pointerId); padPointer(e); if (G.phase === 'idle') G.pwr = { t0: performance.now() }; });
  $('pad').addEventListener('pointermove', (e) => { if (e.buttons) padPointer(e); });
  // lifting the finger off the pad throws right away, at whatever the power gauge reads
  $('pad').addEventListener('pointerup', (e) => { const pw = G.pwr ? powerAt(performance.now()) : 0.5; G.pwr = null; renderPower(0); if (G.phase !== 'idle') return; padPointer(e); throwPitch(pw); });
  $('pad').addEventListener('pointercancel', () => { G.pwr = null; renderPower(0); });
  $('throw').addEventListener('click', () => throwPitch(0.5));
  function renderPower(v) {
    const f = $('pwrFill'), lab = $('pwrLab'), cap = $('pwrCap');
    const c = G.pwr ? powerCap(performance.now()) : 1;
    cap.style.bottom = `${Math.round(c * 100)}%`; cap.hidden = c >= 1;
    f.style.height = `${Math.round(v * 100)}%`;
    f.classList.toggle('max', v >= 0.95);
    lab.textContent = v >= 0.95 ? 'MAX' : v > 0 ? `${Math.round(v * 100)}` : '';
  }
  document.querySelectorAll('.role').forEach((b) => b.addEventListener('click', () => { S.role = b.dataset.role; renderStart(); }));
  for (const [id, key] of [['myThrowSeg', 'myThrow'], ['myBatSeg', 'myBat'], ['cpuThrowSeg', 'cpuThrow'], ['cpuBatSeg', 'cpuBat'], ['mpInnSeg', 'mpInn']]) {
    $(id).addEventListener('click', (e) => { const v = e.target.closest('button')?.dataset.v; if (v) { S[key] = key === 'mpInn' ? Number(v) : v; persist(); renderStart(); } });
  }
  const duelInProgress = () => { const d = save.games.duel; return d.inning > 1 || d.half > 0 || d.outs > 0 || d.score.me > 0 || d.score.opp > 0 || d.bases.some(Boolean); };
  $('startBtn').addEventListener('click', () => {
    audio();
    if (!duelInProgress()) { startGame(); return; }
    const d = save.games.duel, box = $('resumeBox'); box.textContent = ''; box.hidden = false;
    box.append(elt('div', '', `You have a game in progress: ${d.half ? 'bottom' : 'top'} of the ${d.inning}${['st', 'nd', 'rd'][d.inning - 1] || 'th'}, YOU ${d.score.me} : ${d.score.opp} CPU, ${d.outs} out.`));
    const c = elt('button', 'cta', 'Continue that game'); c.addEventListener('click', () => { box.hidden = true; startGame(); });
    const n = elt('button', 'ghost', 'Start a new game'); n.addEventListener('click', () => { box.hidden = true; save.games.duel = newDuel(); S.role = S.role; startGame(); });
    box.append(c, n);
    box.scrollIntoView({ block: 'nearest' });
  });
  $('startStats').addEventListener('click', () => { statTab = S.role; openOv('statsOv'); renderStats(); });
  $('menuBtn').addEventListener('click', () => { statTab = G.mp ? 'friend' : S.role; G.paused = !G.mp; openOv('statsOv'); renderStats(); });
  $('closeStats').addEventListener('click', back);
  function toMenu() { closeAllOv(); G.started = false; G.phase = 'menu'; G.pwr = null; renderPower(0); hideToast(); banner(''); $('startOv').hidden = false; renderStart(); }
  $('changeRole').addEventListener('click', () => { if (G.mp) { renderQuit(true); return; } toMenu(); });
  // quit: single player keeps the saved game; friend mode forfeits
  function renderQuit(confirming) {
    const qa = $('quitArea'); qa.textContent = '';
    if (!G.started) return;
    if (!confirming) {
      const b = elt('button', 'ghost', G.mp ? 'Quit game' : 'Quit (game is saved)'); b.style.width = '100%';
      b.addEventListener('click', () => renderQuit(true)); qa.append(b); return;
    }
    const w = elt('div', 'confirm');
    const t = elt('span', '', G.mp ? 'Quitting now counts as a forfeit. Your friend wins.' : 'Your game is saved. You can continue it next time from the start screen.');
    const y = elt('button', '', G.mp ? 'Forfeit & quit' : 'Quit');
    const n = elt('button', '', 'Cancel'); n.style.borderColor = '#26385a'; n.style.color = '#f1ecdc';
    y.addEventListener('click', () => { if (G.mp) { const m = G.mp; m.seq++; mpSend({ t: 'forfeit', seq: m.seq, why: 'quit' }); mpEnd(false, 'You quit the game.', 1500); } else { persist(); toMenu(); } });
    n.addEventListener('click', () => renderQuit(false));
    w.append(t, y, n); qa.append(w);
  }
  $('statTabs').addEventListener('click', (e) => { const t = e.target.closest('button')?.dataset.t; if (t) { statTab = t; renderStats(); } });
  // ---------------- Settings overlay ----------------
  const SET_SEGS = { unitSeg: ['units', String], innSeg: ['innings', Number], speedSeg: ['speed', Number], cpuPitchSeg: ['cpuPitchLv', Number], cpuBatSeg: ['cpuBatLv', Number] };
  function renderSettings() {
    for (const id in SET_SEGS) { const [key] = SET_SEGS[id]; [...$(id).children].forEach((b) => b.setAttribute('aria-pressed', String(S[key]) === b.dataset.v ? 'true' : 'false')); }
    $('zoneChk').checked = S.zone; $('soundChk').checked = S.sound;
  }
  for (const id in SET_SEGS) {
    $(id).addEventListener('click', (e) => {
      const v = e.target.closest('button')?.dataset.v; if (v == null) return;
      const [key, cast] = SET_SEGS[id]; S[key] = cast(v); persist(); renderSettings();
      if (key === 'units') { buildPitchList(); if (G.pitch && S.role === 'pitcher' && $('pinfo').textContent) showPitchInfo(); }
    });
  }
  $('zoneChk').addEventListener('change', (e) => { S.zone = e.target.checked; persist(); });
  $('soundChk').addEventListener('change', (e) => { S.sound = e.target.checked; persist(); });
  const openSettings = () => { renderSettings(); openOv('setOv'); };
  $('setDone').addEventListener('click', back);
  $('startSet').addEventListener('click', openSettings);
  $('statsSet').addEventListener('click', openSettings);
  $('setBtn').addEventListener('click', () => { G.paused = !G.mp; openSettings(); });
  window.addEventListener('keydown', (e) => { if (e.code === 'Space' && S.role === 'pitcher' && G.started && !e.repeat) { e.preventDefault(); throwPitch(); } });

  buildPitchList(); renderSettings(); renderStart(); renderHUD();

  let last = performance.now();
  function frame(now) {
    const dt = now - last; last = now;
    const frozen = !!(G.freeze && now - G.freeze.t0 < G.freeze.dur);
    if (G.paused || frozen) { G.t0 += dt; if (G.hit) G.hit.t0 += dt; if (G.swingAnim) G.swingAnim.t0 += dt; }
    G.now = now;
    if (W < 2) resize();
    if (G.started && !G.paused && !frozen) update(now);
    if (G.pwr) renderPower(powerAt(now));
    if (G.phase === 'field' || G.phase === 'fieldDone') { if (G.fa && G.paused) G.fa.t0 += dt; drawField(now); }
    else {
      if (frozen && G.freeze.kind === 'hit') { const j = 3; ctx.save(); ctx.translate((Math.random() - 0.5) * j * 2, (Math.random() - 0.5) * j * 2); drawPitchView(now); ctx.restore(); }
      else drawPitchView(now);
      if (G.freeze && G.freeze.kind === 'hit') drawImpact(now);
      else if (G.freeze && now - G.freeze.t0 >= G.freeze.dur) G.freeze = null;
    }
    requestAnimationFrame(frame);
  }
  window.__nd = G; window.__ndS = S; window.__ndStartPA = startPA; window.__ndState = st;
  window.__ndProj = () => { const p = G.pitch; if (!p || !cam) return null; const q = P(cam, p.px + (Math.random() - 0.5) * 0.4, p.py + (Math.random() - 0.5) * 0.3, 0); return q ? [q.x, q.y] : null; };
  // idle preview behind the start screen
  G.pHand = S.myThrow; G.bHand = 'R';
  resize();
  requestAnimationFrame(frame);
})();
