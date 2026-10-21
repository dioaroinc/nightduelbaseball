// Baseball engine: rules, pitch physics, CPU AI, batted-ball outcomes.
// Coordinates (feet): x = toward 1B side (catcher's right), y = up, z = toward the mound.
// Plate front at z = 0. Field: spray angle phi in degrees, 0 = CF, + = RF side, - = LF side.
const Engine = (() => {
  const rnd = Math.random;
  const gauss = () => {
    let u = 0, v = 0;
    while (u === 0) u = rnd();
    while (v === 0) v = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const pick = (weights) => {
    let s = 0;
    for (const k in weights) s += weights[k];
    let r = rnd() * s;
    for (const k in weights) { r -= weights[k]; if (r <= 0) return k; }
    return Object.keys(weights)[0];
  };

  // brk[0]: glove-side break (+) / arm-side (-), brk[1]: vertical vs straight line (ft)
  const PITCHES = {
    FF: { name: 'Four-Seam', mph: 94.0, brk: [-0.55, -1.0], ctl: 1.0, color: '#f2f2f2' },
    SI: { name: 'Sinker', mph: 93.2, brk: [-1.3, -1.9], ctl: 1.0 },
    FC: { name: 'Cutter', mph: 89.0, brk: [0.4, -1.6], ctl: 1.0 },
    SL: { name: 'Slider', mph: 85.5, brk: [0.85, -2.4], ctl: 1.1 },
    ST: { name: 'Sweeper', mph: 82.0, brk: [1.55, -2.5], ctl: 1.15 },
    CU: { name: 'Curveball', mph: 79.5, brk: [0.7, -4.1], ctl: 1.2 },
    CH: { name: 'Changeup', mph: 85.5, brk: [-1.0, -3.0], ctl: 1.1 },
    FS: { name: 'Splitter', mph: 86.0, brk: [-0.5, -3.5], ctl: 1.15 },
  };
  const BREAKING = { SL: 1, ST: 1, CU: 1 };
  const OFFSPEED = { CH: 1, FS: 1 };

  const ZONE = { x: 0.83, bot: 1.5, top: 3.5 };
  const RELEASE_Z = 54.0;

  // MLB-average command (miss from target, ft)
  const CMD_SD = { x: 0.40, y: 0.43 };

  function inZone(px, py, m = 0) {
    return Math.abs(px) <= ZONE.x + m && py >= ZONE.bot - m && py <= ZONE.top + m;
  }
  // distance outside the zone (0 when inside)
  function outDist(px, py) {
    const dx = Math.max(0, Math.abs(px) - ZONE.x);
    const dy = Math.max(0, ZONE.bot - py, py - ZONE.top);
    return Math.hypot(dx, dy);
  }
  // how deep inside the zone (0 at edge, ~0.8 at heart)
  function inDepth(px, py) {
    return Math.min(ZONE.x - Math.abs(px), py - ZONE.bot, ZONE.top - py);
  }

  function newState() {
    return { inning: 1, outs: 0, balls: 0, strikes: 0, bases: [0, 0, 0], runs: 0, inningRuns: 0, pitches: 0, history: [] };
  }

  // ---------- Pitch execution ----------
  // CPU skill levels: 0 = Rookie, 1 = MLB average, 2 = All-Star
  const PITCHER_LV = [
    { cmd: 1.45, velo: -3.5, heart: 0.32, zone: 0.04 },
    { cmd: 1.0, velo: 0, heart: 0, zone: 0 },
    { cmd: 0.72, velo: 2.5, heart: -0.08, zone: -0.02 },
  ];
  const BATTER_LV = [
    { chase: 1.35, contact: -0.09, ev: -4.5 },
    { chase: 1.0, contact: 0, ev: 0 },
    { chase: 0.78, contact: 0.05, ev: 3 },
  ];
  const lv = (arr, k) => arr[k == null ? 1 : clamp(Math.round(k), 0, 2)];
  function executePitch(type, tx, ty, hand, level) {
    const P = PITCHES[type];
    const L = level == null ? PITCHER_LV[1] : lv(PITCHER_LV, level);
    const ctl = P.ctl * L.cmd;
    const px = tx + gauss() * CMD_SD.x * ctl;
    const py = ty + gauss() * CMD_SD.y * ctl;
    const mph = P.mph + L.velo + gauss() * 0.9;
    const handSign = hand === 'R' ? 1 : -1; // glove side direction for RHP = +x
    const brk = [P.brk[0] * handSign * (1 + gauss() * 0.08), P.brk[1] * (1 + gauss() * 0.06)];
    const release = { x: hand === 'R' ? -1.9 : 1.9, y: 5.9 + gauss() * 0.1, z: RELEASE_Z };
    // average speed ~ 92% of release speed
    const T = RELEASE_Z / (mph * 1.4667 * 0.92);
    return { type, mph: Math.round(mph * 10) / 10, px, py, tx, ty, brk, release, T, hand };
  }

  // Position of the ball at fraction s (0..1) of the flight
  function pitchPos(p, s) {
    const ex = p.px - p.brk[0], ey = p.py - p.brk[1];
    return {
      x: p.release.x + (ex - p.release.x) * s + p.brk[0] * s * s,
      y: p.release.y + (ey - p.release.y) * s + p.brk[1] * s * s,
      z: p.release.z * (1 - s),
    };
  }

  // ---------- CPU pitcher ----------
  const CPU_ARSENAL = { FF: 40, SI: 10, SL: 20, CU: 10, CH: 14, FC: 6 };
  function cpuChoosePitch(st, pHand, bHand, level) {
    const L = lv(PITCHER_LV, level);
    const b = st.balls, s = st.strikes;
    const same = pHand === bHand;
    const w = Object.assign({}, CPU_ARSENAL);
    if (same) { w.SL += 8; w.CH -= 8; } else { w.CH += 6; w.SL -= 6; }
    if (b - s >= 2 || (b === 3)) { w.FF += 30; w.SI += 8; }
    if (s === 2) { w.SL += 8; w.CU += 6; w.CH += 4; }
    const type = pick(w);
    // zone intent
    let pZone = 0.59;
    if (b === 3) pZone = 0.8;
    else if (b - s >= 2) pZone = 0.72;
    else if (s === 2 && b < 2) pZone = 0.35;
    else if (s - b >= 1) pZone = 0.45;
    pZone += L.zone;
    const gloveX = pHand === 'R' ? 1 : -1;
    let tx, ty;
    if (rnd() < pZone) {
      // aim at the edges / corners inside the zone
      const heart = (b === 3 || b - s >= 2 ? 0.45 : 0.15) + L.heart;
      if (rnd() < heart) { tx = gauss() * 0.25; ty = 2.5 + gauss() * 0.3; }
      else {
        tx = (rnd() < 0.5 ? -1 : 1) * (0.45 + rnd() * 0.3);
        ty = (rnd() < 0.55 ? 1.85 + rnd() * 0.4 : 2.7 + rnd() * 0.6);
      }
      if (BREAKING[type] || OFFSPEED[type]) ty = Math.min(ty, 2.3);
    } else {
      if (BREAKING[type]) { tx = gloveX * (0.8 + rnd() * 0.5); ty = 1.0 + rnd() * 0.6; }
      else if (OFFSPEED[type]) { tx = (rnd() - 0.5) * 1.2; ty = 0.9 + rnd() * 0.6; }
      else if (rnd() < 0.5) { tx = (rnd() - 0.5) * 1.4; ty = 3.7 + rnd() * 0.4; }
      else { tx = (rnd() < 0.5 ? -1 : 1) * (1.0 + rnd() * 0.3); ty = 1.8 + rnd() * 1.4; }
    }
    return { type, tx, ty };
  }

  // ---------- Umpire ----------
  function callPitch(p, bHand) {
    const inside = bHand === 'R' ? -p.px : p.px; // positive toward batter
    if (inside > 1.75 && p.py > 0.8 && p.py < 5.0 && rnd() < 0.4) return 'hbp';
    const n = gauss() * 0.06;
    return inZone(p.px, p.py, n) ? 'strike' : 'ball';
  }

  // ---------- CPU batter ----------
  function cpuBatter(p, st, bHand, level) {
    const L = lv(BATTER_LV, level);
    const zone = inZone(p.px, p.py);
    const od = outDist(p.px, p.py), dep = zone ? inDepth(p.px, p.py) : 0;
    const b = st.balls, s = st.strikes;
    const last = st.history[st.history.length - 1];
    let swing;
    if (zone) swing = 0.62 + dep * 0.28;
    else swing = 0.6 * Math.exp(-od / 0.45) * L.chase;
    if (s === 2) swing += zone ? 0.18 : 0.12;
    if (b === 3 && s === 0) swing *= 0.15;
    else if (b - s >= 2) swing *= zone ? 1.05 : 0.8;
    if (!zone && (BREAKING[p.type] || OFFSPEED[p.type])) swing += 0.05 * Math.exp(-od / 0.6);
    if (rnd() >= clamp(swing, 0, 0.97)) return { swing: false };

    let contact = zone ? 0.79 + dep * 0.16 : 0.66 * Math.exp(-od / 1.6);
    const tm = { FF: 0, SI: 0.04, FC: 0.0, SL: -0.08, ST: -0.09, CU: -0.06, CH: -0.07, FS: -0.09 }[p.type];
    contact += tm - (p.mph - PITCHES[p.type].mph) * 0.01;
    if (p.type === 'FF') contact -= (p.py - 2.5) * 0.03; // high heat is harder
    if (last) {
      if (last.type === p.type && Math.hypot(last.px - p.px, last.py - p.py) < 0.8) contact += 0.05;
      if (Math.abs(last.mph - p.mph) > 8) contact -= 0.03;
    }
    if (s === 2) contact += 0.01; // protect mode
    contact += L.contact;
    if (rnd() >= clamp(contact, 0.2, 0.97)) return { swing: true, result: 'miss' };

    const foulP = zone ? 0.48 - dep * 0.15 : 0.6;
    if (rnd() < foulP) return { swing: true, result: 'foul' };

    let evMu = 86.6 + dep * 7 - od * 10 + L.ev;
    if (BREAKING[p.type] || OFFSPEED[p.type]) evMu -= 1.5;
    const ev = clamp(evMu + gauss() * 12.5, 35, 117);
    const la = clamp(11 + (p.py - 2.45) * 10 + gauss() * 25, -60, 80);
    const pullSign = bHand === 'R' ? -1 : 1;
    const inside = (bHand === 'R' ? -p.px : p.px);
    const spray = pullSign * (6 + inside * 9) + gauss() * 21;
    return { swing: true, result: 'play', ev, la, spray };
  }

  // ---------- User batter ----------
  // tap: point on plate plane (x, y ft). dt: tap time - arrival time (s, real time).
  const TIMING_WIN = 0.16;
  const SWEET = { x: 0.78, y: 0.58 };
  function userSwing(p, tapX, tapY, dt, bHand) {
    const ex = (tapX - p.px) / SWEET.x, ey = (tapY - p.py) / SWEET.y, et = dt / TIMING_WIN;
    const sp = Math.hypot(ex, ey);
    if (Math.abs(et) > 1 || sp > 1) {
      // near misses on timing/location can still tick a foul
      if (Math.abs(et) < 1.4 && sp < 1.3 && rnd() < 0.6) return { swing: true, result: 'foul', quality: 0 };
      return { swing: true, result: 'miss', quality: 0, why: Math.abs(et) > 1 ? (et < 0 ? 'early' : 'late') : 'location' };
    }
    const q = (1 - sp * sp * 0.6) * (1 - et * et * 0.5);
    if (q < 0.25 && rnd() < 0.5) return { swing: true, result: 'foul', quality: q };
    const ev = clamp(58 + q * 50 + gauss() * 4, 35, 117);
    // tapping below the ball (bat under it) lifts it; above it beats it into the ground
    const la = clamp(13 + (p.py - tapY) * 70 + gauss() * 7, -60, 80);
    const pullSign = bHand === 'R' ? -1 : 1;
    const spray = -et * 38 * pullSign + gauss() * 6;
    return { swing: true, result: 'play', ev, la, spray, quality: q };
  }

  // ---------- Batted ball ----------
  const FIELDERS = {
    P: [0, 60.5], C: [0, -3], '1B': [34, 108], '2B': [13, 148], SS: [-13, 148], '3B': [-33, 108],
    LF: [-27, 290], CF: [0, 318], RF: [27, 290],
  };
  const fieldXY = (phi, r) => [r * Math.sin(phi * Math.PI / 180), r * Math.cos(phi * Math.PI / 180)];
  function fenceDist(phi) {
    const a = Math.abs(phi);
    return a <= 22 ? 400 - (a / 22) * 25 : 375 - ((a - 22) / 23) * 45;
  }

  // Flight path with drag + lift. Returns samples [{t, d, h}] (d = horizontal dist)
  function flight(ev, la) {
    const v0 = ev * 1.4667, a = la * Math.PI / 180;
    let vx = v0 * Math.cos(a), vy = v0 * Math.sin(a), d = 0, h = 3, t = 0;
    const dt = 0.01, k = 0.0017, lift = la > 6 ? 0.0006 : 0;
    const pts = [{ t, d, h }];
    while (h > 0 && t < 9) {
      const v = Math.hypot(vx, vy);
      const ax = -k * v * vx - lift * v * vy;
      const ay = -32.2 - k * v * vy + lift * v * vx;
      vx += ax * dt; vy += ay * dt; d += vx * dt; h += vy * dt; t += dt;
      pts.push({ t, d, h: Math.max(h, 0) });
    }
    return { pts, T: t, dist: d, vxEnd: vx };
  }

  function resolveBattedBall(ev, la, spray) {
    const phi = spray;
    const fl = flight(ev, la);
    const res = { ev, la, phi, dist: fl.dist, T: fl.T, pts: fl.pts, kind: la < 10 ? 'GB' : la < 25 ? 'LD' : la < 50 ? 'FB' : 'PU' };
    if (Math.abs(phi) > 45) {
      // foul unless it's a pop-up caught in foul territory
      if (res.kind === 'PU' && fl.dist < 200 && Math.abs(phi) < 70 && rnd() < 0.6) {
        res.result = 'OUT'; res.how = 'Foul pop out'; res.fielder = phi > 0 ? '1B' : '3B';
      } else res.result = 'FOUL';
      return res;
    }
    // home run?
    const fd = fenceDist(phi);
    const fenceH = Math.abs(phi) > 38 ? 8 : 10;
    for (const p of fl.pts) {
      if (p.d >= fd) {
        if (p.h > fenceH) { res.result = 'HR'; res.how = 'Home run'; return res; }
        break;
      }
    }
    const land = fieldXY(phi, Math.min(fl.dist, fd - 2));
    if (res.kind === 'GB') return groundBall(res, ev, phi);

    // air ball: can any fielder get there?
    let best = null;
    for (const f in FIELDERS) {
      if (f === 'C') continue;
      const [fa, fr] = FIELDERS[f];
      const fp = fieldXY(fa, fr);
      const D = Math.hypot(fp[0] - land[0], fp[1] - land[1]);
      const isOF = fr > 200;
      const speed = isOF ? 27.5 : 23;
      const reach = (isOF ? 21 : 15) * Math.max(0, fl.T - 0.6) + 5;
      const slack = reach - D;
      if (!best || slack > best.slack) best = { f, slack, D, fp };
      // infielders spear line drives passing nearby
      if (!isOF && res.kind === 'LD') {
        for (const p of fl.pts) {
          if (p.h > 7.5) continue;
          const bp = fieldXY(phi, p.d);
          const dd = Math.hypot(bp[0] - fp[0], bp[1] - fp[1]);
          if (dd < 3.5 + 12 * Math.max(0, p.t - 0.15) && p.t < 1.0) {
            if (p.t > 0.12) { res.result = 'OUT'; res.how = 'Lineout'; res.fielder = f; res.catchT = p.t; res.catchD = p.d; return res; }
          }
        }
      }
    }
    res.fielder = best.f;
    if (best.slack >= 0) {
      res.result = 'OUT';
      res.how = res.kind === 'PU' ? 'Pop out' : res.kind === 'LD' ? 'Lineout' : 'Flyout';
      if (FIELDERS[best.f][1] < 200 && res.kind === 'FB') res.how = 'Flyout';
      return res;
    }
    // hit
    const gap = -best.slack;
    if (fl.dist > 275 && gap > 22 && rnd() < 0.3) res.result = '3B';
    else if (fl.dist > 225 && gap > 9) res.result = '2B';
    else if (fl.dist > 200 && Math.abs(phi) > 36 && rnd() < 0.6) res.result = '2B';
    else res.result = '1B';
    res.how = { '1B': 'Single', '2B': 'Double', '3B': 'Triple' }[res.result];
    return res;
  }

  function groundBall(res, ev, phi) {
    const v = ev * 1.4667 * 0.75; // average ground speed through the infield
    let best = null;
    for (const f of ['P', '1B', '2B', 'SS', '3B']) {
      const [fa, fr] = FIELDERS[f];
      const ang = Math.abs(fa - phi) * Math.PI / 180;
      const along = fr * Math.cos(ang), lat = fr * Math.sin(ang);
      if (along < 0) continue;
      const t = along / v;
      const reach = (f === 'P' ? 3 : 5) + (f === 'P' ? 7 : 12) * Math.max(0, t - 0.35);
      const slack = reach - lat;
      if (!best || slack > best.slack) best = { f, slack, along, t };
    }
    res.fielder = best.f; res.gbAlong = best.along; res.gbT = best.t;
    if (best.slack >= 0) {
      // slow rollers to the left side / deep can beat the throw
      const deep = best.f === 'SS' || best.f === '3B';
      let ifh = 0;
      if (ev < 72) ifh = deep ? 0.22 : 0.08;
      if (best.slack < 4) ifh += 0.12;
      if (rnd() < ifh) { res.result = '1B'; res.how = 'Infield single'; return res; }
      res.result = 'OUT'; res.how = 'Groundout'; res.gb = true; return res;
    }
    res.result = ev > 92 && Math.abs(phi) > 38 && rnd() < 0.4 ? '2B' : '1B';
    res.how = res.result === '2B' ? 'Double' : 'Single';
    return res;
  }

  // ---------- Applying results ----------
  // Returns { runs, outsAdded, text, ended:bool, rbi }
  function applyEvent(st, ev, bb) {
    const b = st.bases;
    let runs = 0, outs = 0, text = '';
    const pushAll = (n) => { // batter to base n (1..4), forced-style advance of everyone n bases
      for (let i = 2; i >= 0; i--) {
        if (b[i]) { const to = i + n; if (to >= 3) runs++; else b[to] = 1; b[i] = 0; }
      }
      if (n >= 4) runs++; else b[n - 1] = 1;
    };
    switch (ev) {
      case 'BB': case 'HBP': {
        if (b[0]) { if (b[1]) { if (b[2]) runs++; b[2] = 1; } b[1] = 1; }
        b[0] = 1; text = ev === 'BB' ? 'Walk' : 'Hit by pitch'; break;
      }
      case 'K': outs = 1; text = 'Strikeout'; break;
      case '1B': {
        if (b[2]) { runs++; b[2] = 0; }
        if (b[1]) { if (rnd() < 0.6) runs++; else b[2] = 1; b[1] = 0; }
        if (b[0]) { if (!b[2] && rnd() < 0.28) b[2] = 1; else b[1] = 1; b[0] = 0; }
        b[0] = 1; text = bb && bb.how === 'Infield single' ? 'Infield single' : 'Single'; break;
      }
      case '2B': {
        if (b[2]) runs++; if (b[1]) runs++;
        b[2] = 0; b[1] = 0;
        if (b[0]) { if (rnd() < 0.42) runs++; else b[2] = 1; b[0] = 0; }
        b[1] = 1; text = 'Double'; break;
      }
      case '3B': pushAll(3); text = 'Triple'; break;
      case 'HR': pushAll(4); text = runs === 4 ? 'GRAND SLAM!' : 'HOME RUN!'; break;
      case 'OUT': {
        outs = 1; text = bb ? bb.how : 'Out';
        if (bb && bb.gb) {
          if (b[0] && st.outs < 2 && rnd() < 0.45) {
            outs = 2; text = 'Double play'; b[0] = 0;
            if (b[2] && st.outs === 0) { runs++; b[2] = 0; }
            if (b[1]) { b[2] = 1; b[1] = 0; }
          } else {
            if (st.outs < 2) {
              if (b[2] && rnd() < 0.55) { runs++; b[2] = 0; }
              if (b[1] && !b[2]) { b[2] = 1; b[1] = 0; }
            }
            if (b[0]) { // force at second, batter safe at first
              if (b[1] && !b[2] && st.outs < 2) { b[2] = 1; b[1] = 0; }
              b[1] = b[1] || 0; b[0] = 1; text = 'Fielder\'s choice';
            }
          }
        } else if (bb && (bb.kind === 'FB' || bb.kind === 'LD') && st.outs < 2 && bb.dist > 230) {
          if (b[2] && rnd() < 0.85) { runs++; b[2] = 0; text = 'Sacrifice fly'; bb.sf = true; }
          if (b[1] && bb.dist > 300 && !b[2] && rnd() < 0.5) { b[2] = 1; b[1] = 0; }
        }
        break;
      }
    }
    st.outs += outs;
    if (st.outs >= 3) {
      // A run on the third out (force/fly) does not count
      if (outs > 0) runs = 0;
    }
    st.runs += runs;
    st.inningRuns += runs;
    let ended = false;
    if (st.outs >= 3) ended = true;
    return { runs, outs, text, ended };
  }

  function nextInning(st) {
    st.inning++; st.outs = 0; st.bases = [0, 0, 0]; st.inningRuns = 0;
  }

  function newStats() {
    return {
      pitcher: { BF: 0, outs: 0, H: 0, HR: 0, BB: 0, HBP: 0, K: 0, R: 0, ER: 0, pitches: 0, strikes: 0 },
      batter: { PA: 0, AB: 0, H: 0, d2: 0, d3: 0, HR: 0, BB: 0, HBP: 0, K: 0, RBI: 0, SF: 0, pitches: 0 },
    };
  }

  function recordPA(stats, role, ev, runs, outs, bb) {
    if (role === 'pitcher') {
      const s = stats.pitcher;
      s.BF++; s.outs += outs; s.R += runs; s.ER += runs;
      if (['1B', '2B', '3B', 'HR'].includes(ev)) s.H++;
      if (ev === 'HR') s.HR++;
      if (ev === 'BB') s.BB++;
      if (ev === 'HBP') s.HBP++;
      if (ev === 'K') s.K++;
    } else {
      const s = stats.batter;
      s.PA++; s.RBI += (ev === 'OUT' && outs >= 2) ? 0 : runs;
      if (ev === 'BB') s.BB++;
      else if (ev === 'HBP') s.HBP++;
      else if (bb && bb.sf) s.SF++;
      else s.AB++;
      if (['1B', '2B', '3B', 'HR'].includes(ev)) s.H++;
      if (ev === '2B') s.d2++;
      if (ev === '3B') s.d3++;
      if (ev === 'HR') s.HR++;
      if (ev === 'K') s.K++;
    }
  }

  function derived(stats) {
    const p = stats.pitcher, b = stats.batter;
    const ip = p.outs / 3;
    const tb = b.H + b.d2 + 2 * b.d3 + 3 * b.HR;
    const avg = b.AB ? b.H / b.AB : 0;
    const obpD = b.AB + b.BB + b.HBP + b.SF;
    const obp = obpD ? (b.H + b.BB + b.HBP) / obpD : 0;
    const slg = b.AB ? tb / b.AB : 0;
    const pAB = p.BF - p.BB - p.HBP;
    return {
      ipText: `${Math.floor(p.outs / 3)}${p.outs % 3 ? '.' + (p.outs % 3) : ''}`,
      era: p.outs ? (p.ER * 27) / p.outs : null,
      whip: p.outs ? (p.BB + p.H) / ip : null,
      k9: p.outs ? (p.K * 27) / p.outs : null,
      bb9: p.outs ? (p.BB * 27) / p.outs : null,
      oppAvg: pAB > 0 ? p.H / pAB : null,
      kPct: p.BF ? p.K / p.BF : null,
      avg, obp, slg, ops: obp + slg,
      bKPct: b.PA ? b.K / b.PA : null,
      bBBPct: b.PA ? b.BB / b.PA : null,
    };
  }

  return {
    PITCHES, ZONE, RELEASE_Z, FIELDERS, gauss, clamp, rnd,
    inZone, outDist, newState, executePitch, pitchPos, cpuChoosePitch, callPitch,
    cpuBatter, userSwing, TIMING_WIN, SWEET, resolveBattedBall, flight, fenceDist, fieldXY,
    applyEvent, nextInning, newStats, recordPA, derived,
  };
})();
if (typeof module !== 'undefined') module.exports = Engine;
