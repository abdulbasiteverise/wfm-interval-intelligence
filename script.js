/**
 * Abdul Basit – WFM Intelligence Suite
 * Interval Level Accuracy & Intraday Decision Engine
 * Pure vanilla JS – no frameworks, no backend
 */

'use strict';

/* ═══════════════════════════════════════════════════════════
   1. DATA GENERATION — 5 weeks of realistic WFM sample data
═══════════════════════════════════════════════════════════ */

const DAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];

// Base volume profiles per day (30-min intervals, 8 AM–10 PM = 28 slots)
const DAY_VOLUME_PROFILE = {
  weekday: [18,28,45,62,78,85,90,95,100,98,92,88,86,84,82,78,70,58,42,30,20,14,10,8,6,5,4,3],
  saturday:[12,18,28,40,58,70,80,88,94,96,98,95,90,85,80,75,68,58,46,36,26,18,12,8,5,4,3,2],
  sunday:  [8, 12,18,28,40,52,64,72,80,85,88,86,82,78,74,68,60,50,38,28,20,14,9, 6, 4,3, 2,2]
};

const BASE_AHT = 280; // seconds
const SLOTS_PER_DAY = 28; // 8 AM – 10 PM in 30-min slots
const START_HOUR = 8;

function generateSlotTimes(intervalMin) {
  const slots = [];
  const mins = 14 * 60; // 8 AM to 10 PM = 14 hours
  for (let m = 0; m < mins; m += intervalMin) {
    const h = START_HOUR + Math.floor(m / 60);
    const mi = m % 60;
    const h2 = START_HOUR + Math.floor((m + intervalMin) / 60);
    const mi2 = (m + intervalMin) % 60;
    slots.push(`${String(h).padStart(2,'0')}:${String(mi).padStart(2,'0')}–${String(h2).padStart(2,'0')}:${String(mi2).padStart(2,'0')}`);
  }
  return slots;
}

function rnd(min, max) { return min + Math.random() * (max - min); }
function rndInt(min, max) { return Math.round(rnd(min, max)); }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function noise(magnitude) { return 1 + (Math.random() - 0.5) * 2 * magnitude; }

// Aggregate base 30-min profile to 60-min or keep at 15-min (we'll interpolate)
function getProfileForInterval(dayType, intervalMin) {
  const base = DAY_VOLUME_PROFILE[dayType]; // 28 slots of 30 min
  if (intervalMin === 30) return [...base];
  if (intervalMin === 60) {
    // merge pairs
    const out = [];
    for (let i = 0; i < base.length - 1; i += 2) out.push(base[i] + base[i + 1]);
    return out;
  }
  if (intervalMin === 15) {
    // split each into 2 (interpolate)
    const out = [];
    for (let i = 0; i < base.length; i++) {
      const next = base[i + 1] || base[i];
      out.push(Math.round((base[i] * 0.55)));
      out.push(Math.round((base[i] * 0.45)));
    }
    return out;
  }
  return [...base];
}

function generateWeek(weekIndex) {
  const week = {};
  const weekMultiplier = [1.0, 1.03, 1.07, 0.97, 1.05][weekIndex];

  DAYS.forEach((day, di) => {
    const isWeekend = di >= 5;
    const dayType = isWeekend ? (di === 6 ? 'sunday' : 'saturday') : 'weekday';
    const dayMult = [1.0, 1.05, 1.08, 1.02, 0.95, 0.70, 0.55][di];
    const profile = getProfileForInterval(dayType, 30);

    const intervals = profile.map((baseVol, i) => {
      const scaledFcst = Math.round(baseVol * weekMultiplier * dayMult * 10);
      // simulate AHT pattern (higher in morning, peaks midday)
      const ahtMult = [1.1,1.05,1.02,1.0,0.98,0.97,0.96,0.95,0.96,0.98,1.0,1.02,1.04,1.06,1.05,1.03,1.01,0.99,0.98,0.97,0.98,1.0,1.02,1.03,1.05,1.04,1.02,1.0][i] || 1.0;
      const fcstAHT = Math.round(BASE_AHT * ahtMult);

      // Actual = forecast ± variance (realistic noise)
      const volVariance = noise(0.12); // ±12%
      const ahtVariance = noise(0.10); // ±10%
      const actVol = Math.max(0, Math.round(scaledFcst * volVariance));
      const actAHT = Math.max(180, Math.round(fcstAHT * ahtVariance));

      // Scheduled staff (slightly underestimated on busy days)
      const occupancy = 0.85;
      const reqFTE = (scaledFcst * fcstAHT) / (1800 * occupancy); // 1800 = 30min×60s
      const schedVariance = noise(0.08);
      const scheduled = Math.max(1, Math.round(reqFTE * schedVariance));

      return { scaledFcst, actVol, fcstAHT, actAHT, scheduled };
    });

    week[day] = intervals;
  });

  return week;
}

// Pre-generate 5 weeks of data
const ALL_WEEKS = Array.from({ length: 5 }, (_, i) => generateWeek(i));

/* ═══════════════════════════════════════════════════════════
   2. CALCULATION ENGINE
═══════════════════════════════════════════════════════════ */

function calcIntervals(rawIntervals, intervalMin, occupancy) {
  const occ = occupancy / 100;
  const secondsInInterval = intervalMin * 60;

  return rawIntervals.map((row, i) => {
    const { scaledFcst, actVol, fcstAHT, actAHT, scheduled } = row;

    // Scale for interval size vs base 30-min
    const scaleFactor = intervalMin / 30;
    const fcstVol = Math.round(scaledFcst * scaleFactor);
    const actualVol = Math.round(actVol * scaleFactor);

    const volVariance = actualVol - fcstVol;
    const accuracy = fcstVol > 0
      ? clamp((1 - Math.abs(actualVol - fcstVol) / fcstVol) * 100, 0, 100)
      : 100;

    const reqFTE = (actualVol * actAHT) / (secondsInInterval * occ);
    const schedFTE = Math.round(scheduled * scaleFactor);
    const gap = schedFTE - reqFTE;

    let status, statusClass;
    if (gap < -5)       { status = 'Critical';  statusClass = 'status-critical'; }
    else if (gap < -2)  { status = 'Warning';   statusClass = 'status-warning'; }
    else if (gap <= 3)  { status = 'OK';        statusClass = 'status-ok'; }
    else                { status = 'Surplus';   statusClass = 'status-surplus'; }

    // Error decomposition
    const reqFcst = (fcstVol * fcstAHT) / (secondsInInterval * occ);
    const volImpact   = ((actualVol - fcstVol) * actAHT) / (secondsInInterval * occ);
    const ahtImpact   = (actualVol * (actAHT - fcstAHT)) / (secondsInInterval * occ);
    const schedImpact = schedFTE - reqFcst;

    return {
      index: i,
      fcstVol, actualVol, volVariance, accuracy: +accuracy.toFixed(1),
      fcstAHT, actAHT,
      reqFTE: +reqFTE.toFixed(1), schedFTE, gap: +gap.toFixed(1),
      status, statusClass,
      volImpact: +volImpact.toFixed(1),
      ahtImpact: +ahtImpact.toFixed(1),
      schedImpact: +schedImpact.toFixed(1)
    };
  });
}

function calcDaySummary(intervals) {
  const totalFcst = intervals.reduce((s, r) => s + r.fcstVol, 0);
  const totalAct  = intervals.reduce((s, r) => s + r.actualVol, 0);
  const avgFcstAHT = Math.round(intervals.reduce((s, r) => s + r.fcstAHT, 0) / intervals.length);
  const avgActAHT  = Math.round(intervals.reduce((s, r) => s + r.actAHT, 0) / intervals.length);
  const avgGap = +(intervals.reduce((s, r) => s + r.gap, 0) / intervals.length).toFixed(1);
  const avgAcc = +(intervals.reduce((s, r) => s + r.accuracy, 0) / intervals.length).toFixed(1);
  const totalVolImpact  = +(intervals.reduce((s, r) => s + Math.abs(r.volImpact), 0)).toFixed(1);
  const totalAHTImpact  = +(intervals.reduce((s, r) => s + Math.abs(r.ahtImpact), 0)).toFixed(1);
  const totalSchedImpact= +(intervals.reduce((s, r) => s + Math.abs(r.schedImpact), 0)).toFixed(1);

  // Backlog: sum of understaffed FTE equivalents (calls not handled)
  const backlog = intervals.filter(r => r.gap < 0).reduce((s, r) => s + Math.abs(r.gap * 2), 0);

  // Peak intervals (worst 3 by gap)
  const sorted = [...intervals].sort((a, b) => a.gap - b.gap);
  const peaks = sorted.slice(0, 3);

  // Reforecast
  const halfIdx = Math.floor(intervals.length / 2);
  const fcstSoFar = intervals.slice(0, halfIdx).reduce((s, r) => s + r.fcstVol, 0);
  const actSoFar  = intervals.slice(0, halfIdx).reduce((s, r) => s + r.actualVol, 0);
  const trendFactor = fcstSoFar > 0 ? actSoFar / fcstSoFar : 1;
  const remainFcst  = intervals.slice(halfIdx).reduce((s, r) => s + r.fcstVol, 0);
  const newFcst     = Math.round(actSoFar + remainFcst * trendFactor);
  const rfcTriggered = Math.abs(trendFactor - 1) > 0.05;

  return {
    totalFcst, totalAct, avgFcstAHT, avgActAHT, avgGap, avgAcc,
    totalVolImpact, totalAHTImpact, totalSchedImpact,
    backlog: Math.round(backlog),
    peaks,
    trendFactor: +trendFactor.toFixed(3),
    newFcst, rfcTriggered,
    actSoFar, fcstSoFar, remainFcst
  };
}

/* ═══════════════════════════════════════════════════════════
   3. STATE
═══════════════════════════════════════════════════════════ */

const STATE = {
  weekIdx: 0,
  dayIdx: 0,
  intervalMin: 30,
  occupancy: 85,
  slaTarget: 80,
  simVolume: 0,
  simAHT: 0,
  simAgents: 0,
  intervals: [],
  summary: {},
  slotTimes: []
};

function refreshData() {
  const rawDay = ALL_WEEKS[STATE.weekIdx][DAYS[STATE.dayIdx]];
  STATE.slotTimes = generateSlotTimes(STATE.intervalMin);
  STATE.intervals = calcIntervals(rawDay, STATE.intervalMin, STATE.occupancy);
  STATE.summary   = calcDaySummary(STATE.intervals);
}

/* ═══════════════════════════════════════════════════════════
   4. SIMPLE CANVAS CHARTS (no library)
═══════════════════════════════════════════════════════════ */

function drawVolumeChart() {
  const canvas = document.getElementById('volumeChart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);
  const W = rect.width, H = rect.height;

  const intervals = STATE.intervals;
  if (!intervals.length) return;

  const fcstVols = intervals.map(r => r.fcstVol);
  const actVols  = intervals.map(r => r.actualVol);
  const maxV = Math.max(...fcstVols, ...actVols) * 1.15;

  const pad = { top: 10, right: 10, bottom: 30, left: 36 };
  const cW = W - pad.left - pad.right;
  const cH = H - pad.top - pad.bottom;
  const barW = Math.max(2, cW / intervals.length * 0.4);
  const step = cW / intervals.length;

  ctx.clearRect(0, 0, W, H);

  // Grid lines
  ctx.strokeStyle = 'rgba(42,53,80,0.6)';
  ctx.lineWidth = 1;
  for (let g = 0; g <= 4; g++) {
    const y = pad.top + cH - (g / 4) * cH;
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(pad.left + cW, y); ctx.stroke();
    ctx.fillStyle = 'rgba(74,90,122,0.8)';
    ctx.font = '9px JetBrains Mono, monospace';
    ctx.textAlign = 'right';
    ctx.fillText(Math.round(maxV * g / 4), pad.left - 4, y + 3);
  }

  // Forecast bars
  intervals.forEach((r, i) => {
    const x = pad.left + i * step + step / 2 - barW;
    const bH = (r.fcstVol / maxV) * cH;
    const y  = pad.top + cH - bH;
    ctx.fillStyle = 'rgba(68,138,255,0.35)';
    ctx.fillRect(x, y, barW, bH);
  });

  // Actual bars
  intervals.forEach((r, i) => {
    const x = pad.left + i * step + step / 2;
    const bH = (r.actualVol / maxV) * cH;
    const y  = pad.top + cH - bH;
    const isOver = r.actualVol > r.fcstVol;
    ctx.fillStyle = isOver ? 'rgba(255,71,87,0.75)' : 'rgba(0,230,118,0.65)';
    ctx.fillRect(x, y, barW, bH);
  });

  // Axis labels (every 4th)
  ctx.fillStyle = 'rgba(74,90,122,0.9)';
  ctx.font = '9px JetBrains Mono, monospace';
  ctx.textAlign = 'center';
  intervals.forEach((r, i) => {
    if (i % Math.ceil(intervals.length / 7) === 0) {
      const label = STATE.slotTimes[i] ? STATE.slotTimes[i].substring(0, 5) : '';
      ctx.fillText(label, pad.left + i * step + step / 2, H - 4);
    }
  });

  // Legend
  ctx.fillStyle = 'rgba(68,138,255,0.7)'; ctx.fillRect(pad.left, H - 16, 8, 8);
  ctx.fillStyle = 'rgba(74,90,122,0.9)'; ctx.font = '9px DM Sans, sans-serif'; ctx.textAlign = 'left';
  ctx.fillText('Forecast', pad.left + 12, H - 9);
  ctx.fillStyle = 'rgba(0,230,118,0.7)'; ctx.fillRect(pad.left + 70, H - 16, 8, 8);
  ctx.fillStyle = 'rgba(74,90,122,0.9)';
  ctx.fillText('Actual', pad.left + 82, H - 9);
}

function drawStaffChart() {
  const canvas = document.getElementById('staffChart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);
  const W = rect.width, H = rect.height;

  const intervals = STATE.intervals;
  if (!intervals.length) return;

  const gaps = intervals.map(r => r.gap);
  const maxAbs = Math.max(Math.abs(Math.min(...gaps)), Math.max(...gaps), 5) * 1.2;

  const pad = { top: 10, right: 10, bottom: 28, left: 36 };
  const cW = W - pad.left - pad.right;
  const cH = H - pad.top - pad.bottom;
  const zero = pad.top + cH / 2;
  const barW = Math.max(2, cW / intervals.length * 0.65);
  const step = cW / intervals.length;

  ctx.clearRect(0, 0, W, H);

  // Zero line
  ctx.strokeStyle = 'rgba(232,237,248,0.2)';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(pad.left, zero); ctx.lineTo(pad.left + cW, zero); ctx.stroke();
  ctx.setLineDash([]);

  // Grid
  ctx.strokeStyle = 'rgba(42,53,80,0.4)';
  [-1, 1].forEach(sign => {
    const y = zero - sign * (cH / 2) * 0.5;
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(pad.left + cW, y); ctx.stroke();
    ctx.fillStyle = 'rgba(74,90,122,0.7)'; ctx.font = '9px JetBrains Mono, monospace'; ctx.textAlign = 'right';
    ctx.fillText(sign * Math.round(maxAbs * 0.5), pad.left - 4, y + 3);
  });
  ctx.fillStyle = 'rgba(74,90,122,0.7)'; ctx.font = '9px JetBrains Mono, monospace';
  ctx.textAlign = 'right'; ctx.fillText('0', pad.left - 4, zero + 3);

  gaps.forEach((gap, i) => {
    const x = pad.left + i * step + (step - barW) / 2;
    const bH = Math.abs((gap / maxAbs) * (cH / 2));
    const y  = gap >= 0 ? zero - bH : zero;
    let color;
    if (gap < -5)      color = 'rgba(255,71,87,0.8)';
    else if (gap < -2) color = 'rgba(255,127,0,0.8)';
    else if (gap <= 3) color = 'rgba(0,230,118,0.65)';
    else               color = 'rgba(68,138,255,0.65)';
    ctx.fillStyle = color;
    ctx.fillRect(x, y, barW, Math.max(2, bH));
  });

  // Labels
  ctx.fillStyle = 'rgba(74,90,122,0.9)'; ctx.font = '9px JetBrains Mono, monospace'; ctx.textAlign = 'center';
  intervals.forEach((r, i) => {
    if (i % Math.ceil(intervals.length / 7) === 0) {
      const label = STATE.slotTimes[i] ? STATE.slotTimes[i].substring(0, 5) : '';
      ctx.fillText(label, pad.left + i * step + step / 2, H - 4);
    }
  });
}

function drawSimChart() {
  const canvas = document.getElementById('simChart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);
  const W = rect.width, H = rect.height;

  const simIntervals = getSimIntervals();
  const base = STATE.intervals;
  if (!base.length) return;

  const maxV = Math.max(...base.map(r => r.reqFTE), ...simIntervals.map(r => r.reqFTE)) * 1.2;
  const pad = { top: 10, right: 10, bottom: 28, left: 36 };
  const cW = W - pad.left - pad.right;
  const cH = H - pad.top - pad.bottom;
  const step = cW / base.length;

  ctx.clearRect(0, 0, W, H);

  // Grid
  for (let g = 1; g <= 4; g++) {
    const y = pad.top + cH - (g / 4) * cH;
    ctx.strokeStyle = 'rgba(42,53,80,0.5)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(pad.left + cW, y); ctx.stroke();
    ctx.fillStyle = 'rgba(74,90,122,0.8)'; ctx.font = '9px JetBrains Mono, monospace'; ctx.textAlign = 'right';
    ctx.fillText(Math.round(maxV * g / 4), pad.left - 4, y + 3);
  }

  // Draw line helper
  function drawLine(data, color, dashed) {
    ctx.strokeStyle = color; ctx.lineWidth = 2;
    if (dashed) ctx.setLineDash([5, 4]); else ctx.setLineDash([]);
    ctx.beginPath();
    data.forEach((r, i) => {
      const x = pad.left + i * step + step / 2;
      const y = pad.top + cH - (r.reqFTE / maxV) * cH;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.setLineDash([]);
  }

  drawLine(base, 'rgba(68,138,255,0.8)', false);
  drawLine(simIntervals, 'rgba(0,212,255,0.9)', true);

  // Scheduled line
  ctx.strokeStyle = 'rgba(0,230,118,0.5)'; ctx.lineWidth = 1.5; ctx.setLineDash([3, 3]);
  ctx.beginPath();
  base.forEach((r, i) => {
    const x = pad.left + i * step + step / 2;
    const y = pad.top + cH - (r.schedFTE / maxV) * cH;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.stroke(); ctx.setLineDash([]);

  // Labels
  ctx.fillStyle = 'rgba(74,90,122,0.9)'; ctx.font = '9px JetBrains Mono, monospace'; ctx.textAlign = 'center';
  base.forEach((r, i) => {
    if (i % Math.ceil(base.length / 7) === 0) {
      const label = STATE.slotTimes[i] ? STATE.slotTimes[i].substring(0, 5) : '';
      ctx.fillText(label, pad.left + i * step + step / 2, H - 4);
    }
  });
}

/* ═══════════════════════════════════════════════════════════
   5. RENDER FUNCTIONS
═══════════════════════════════════════════════════════════ */

function renderKPIs() {
  const s = STATE.summary;
  const fmt = n => n.toLocaleString();

  setKPI('kpi-volume', fmt(s.totalAct));
  setKPIDelta('kpi-volume-delta', s.totalAct - s.totalFcst, `Fcst: ${fmt(s.totalFcst)}`, true);

  setKPI('kpi-aht', s.avgActAHT + 's');
  setKPIDelta('kpi-aht-delta', s.avgActAHT - s.avgFcstAHT, `Fcst: ${s.avgFcstAHT}s`, true);

  const gapColor = s.avgGap < -3 ? 'up' : s.avgGap < 0 ? 'warn' : 'down';
  setKPI('kpi-gap', (s.avgGap > 0 ? '+' : '') + s.avgGap);
  const gapEl = document.getElementById('kpi-gap-delta');
  gapEl.textContent = s.avgGap < -3 ? '⚠ Understaffed' : s.avgGap < 0 ? '⚡ Marginal' : '✓ Adequate';
  gapEl.className = 'kpi-delta ' + gapColor;

  const ilaColor = s.avgAcc >= 90 ? 'ok' : s.avgAcc >= 80 ? 'warn' : 'up';
  setKPI('kpi-ila', s.avgAcc + '%');
  const ilaEl = document.getElementById('kpi-ila-label');
  ilaEl.textContent = s.avgAcc >= 90 ? '✓ High accuracy' : s.avgAcc >= 80 ? '⚡ Moderate' : '⚠ Low accuracy';
  ilaEl.className = 'kpi-delta ' + ilaColor;

  setKPI('kpi-backlog', s.backlog);
  const blEl = document.getElementById('kpi-backlog-label');
  blEl.textContent = s.backlog > 50 ? `⚠ ${s.backlog} calls at risk` : s.backlog > 20 ? `⚡ Moderate risk` : '✓ Manageable';
  blEl.className = 'kpi-delta ' + (s.backlog > 50 ? 'up' : s.backlog > 20 ? 'warn' : 'ok');

  setKPI('kpi-peaks', s.peaks.length);
  document.getElementById('kpi-peaks-label').textContent = `Critical windows`;
  document.getElementById('kpi-peaks-label').className = 'kpi-delta up';
}

function setKPI(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

function setKPIDelta(id, diff, sub, upIsBad) {
  const el = document.getElementById(id);
  if (!el) return;
  const sign = diff > 0 ? '+' : '';
  const cls = diff > 0 ? (upIsBad ? 'up' : 'down') : (upIsBad ? 'down' : 'up');
  el.textContent = `${sign}${Math.round(diff)} · ${sub}`;
  el.className = 'kpi-delta ' + cls;
}

function renderHeatmap() {
  const grid = document.getElementById('heatmapGrid');
  if (!grid) return;
  grid.innerHTML = '';
  STATE.intervals.forEach((r, i) => {
    const cell = document.createElement('div');
    cell.className = 'heatmap-cell ' + (r.gap < -3 ? 'hc-red' : r.gap < 0 ? 'hc-orange' : r.gap <= 5 ? 'hc-green' : 'hc-blue');
    const time = STATE.slotTimes[i] ? STATE.slotTimes[i].substring(0, 5) : '';
    cell.innerHTML = `<div class="hc-time">${time}</div><div class="hc-gap">${r.gap > 0 ? '+' : ''}${r.gap.toFixed(0)}</div><div class="hc-acc">${r.accuracy.toFixed(0)}%</div>`;
    cell.title = `${STATE.slotTimes[i]} | Gap: ${r.gap} | Acc: ${r.accuracy}%`;
    cell.addEventListener('click', () => openModal(i));
    grid.appendChild(cell);
  });
}

function renderDecomposition() {
  const cont = document.getElementById('decompBars');
  if (!cont) return;
  const s = STATE.summary;
  const total = s.totalVolImpact + s.totalAHTImpact + s.totalSchedImpact || 1;
  cont.innerHTML = '';

  const items = [
    { label: 'Volume Impact', val: s.totalVolImpact, color: 'var(--red)', tip: 'FTE impact caused by actual volume being higher/lower than forecast' },
    { label: 'AHT Impact',    val: s.totalAHTImpact, color: 'var(--orange)', tip: 'FTE impact caused by actual AHT differing from forecast' },
    { label: 'Scheduling Impact', val: s.totalSchedImpact, color: 'var(--blue)', tip: 'Gap between scheduled agents and forecasted requirement (shift/planning gap)' }
  ];

  items.forEach(item => {
    const pct = Math.round((item.val / total) * 100);
    const div = document.createElement('div');
    div.className = 'decomp-item';
    div.innerHTML = `
      <div class="decomp-label" data-tip="${item.tip}"><span>${item.label}</span><span>${item.val.toFixed(1)} FTE (${pct}%)</span></div>
      <div class="decomp-bar-track"><div class="decomp-bar-fill" style="width:${pct}%;background:${item.color}"></div></div>`;
    cont.appendChild(div);
  });
}

function renderPeaks() {
  const cont = document.getElementById('peaksList');
  if (!cont) return;
  cont.innerHTML = '';
  const ranks = ['one','two','three'];
  const rankNums = ['1','2','3'];
  STATE.summary.peaks.forEach((r, i) => {
    const time = STATE.slotTimes[r.index] || '--';
    const slaRisk = Math.min(100, Math.round(Math.abs(r.gap) * 3.5));
    const div = document.createElement('div');
    div.className = 'peak-item';
    div.innerHTML = `
      <div class="peak-rank ${ranks[i]}">${rankNums[i]}</div>
      <div class="peak-info">
        <div class="peak-time">${time}</div>
        <div class="peak-desc">Gap: <strong>${r.gap.toFixed(1)} FTE</strong> · Vol Var: ${r.volVariance > 0 ? '+' : ''}${r.volVariance} · AHT: ${r.actAHT}s</div>
        <div class="peak-sla">≈${slaRisk}% SLA risk contribution</div>
      </div>`;
    cont.appendChild(div);
  });
}

function renderReforecast() {
  const cont = document.getElementById('reforecastBody');
  if (!cont) return;
  const s = STATE.summary;
  const pct = ((s.trendFactor - 1) * 100).toFixed(1);
  cont.innerHTML = `
    <div class="rfc-row"><span class="rfc-key">Actual Volume So Far</span><span class="rfc-val">${s.actSoFar.toLocaleString()}</span></div>
    <div class="rfc-row"><span class="rfc-key">Forecast So Far</span><span class="rfc-val">${s.fcstSoFar.toLocaleString()}</span></div>
    <div class="rfc-row"><span class="rfc-key">Trend Factor</span><span class="rfc-val ${s.rfcTriggered ? 'warn' : ''}">${s.trendFactor.toFixed(3)} (${pct > 0 ? '+' : ''}${pct}%)</span></div>
    <div class="rfc-row"><span class="rfc-key">Remaining Forecast</span><span class="rfc-val">${s.remainFcst.toLocaleString()}</span></div>
    <div class="rfc-row"><span class="rfc-key">New Day Forecast</span><span class="rfc-val highlight">${s.newFcst.toLocaleString()}</span></div>
    <div class="rfc-trigger ${s.rfcTriggered ? 'active' : 'inactive'}">
      ${s.rfcTriggered
        ? `⚡ Reforecast AUTO-TRIGGERED — variance is ${Math.abs(pct)}% (threshold: 5%). New forecast: ${s.newFcst.toLocaleString()} calls.`
        : `✓ No reforecast needed. Variance ${Math.abs(pct)}% is within 5% threshold.`}
    </div>`;
}

function renderIntervalTable() {
  const tbody = document.getElementById('intervalBody');
  if (!tbody) return;
  tbody.innerHTML = '';
  STATE.intervals.forEach((r, i) => {
    const time = STATE.slotTimes[i] || '--';
    const tr = document.createElement('tr');
    const volClass = r.volVariance > 5 ? 'val-red' : r.volVariance < -5 ? 'val-green' : '';
    const accClass = r.accuracy >= 90 ? 'val-green' : r.accuracy >= 80 ? '' : 'val-red';
    const gapClass = r.gap < -3 ? 'val-red' : r.gap < 0 ? 'val-orange' : r.gap > 5 ? 'val-blue' : 'val-green';
    tr.innerHTML = `
      <td>${time}</td>
      <td>${r.fcstVol}</td>
      <td>${r.actualVol}</td>
      <td class="${volClass}">${r.volVariance > 0 ? '+' : ''}${r.volVariance}</td>
      <td class="${accClass}">${r.accuracy}%</td>
      <td>${r.fcstAHT}s</td>
      <td>${r.actAHT}s</td>
      <td>${r.reqFTE}</td>
      <td>${r.schedFTE}</td>
      <td class="${gapClass}">${r.gap > 0 ? '+' : ''}${r.gap}</td>
      <td><span class="status-badge ${r.statusClass}">${r.status}</span></td>`;
    tbody.appendChild(tr);
  });
}

function renderInsights() {
  const cont = document.getElementById('insightsList');
  if (!cont) return;
  const s = STATE.summary;
  const intervals = STATE.intervals;
  const insights = [];

  // Insight 1: worst accuracy interval
  const worstAcc = [...intervals].sort((a, b) => a.accuracy - b.accuracy)[0];
  if (worstAcc) {
    insights.push({ icon: '🎯', sev: 'high', text: `Peak interval <strong>${STATE.slotTimes[worstAcc.index]}</strong> under-forecasted by <strong>${Math.abs(worstAcc.volVariance)}</strong> calls — accuracy at <strong>${worstAcc.accuracy}%</strong>.` });
  }

  // Insight 2: AHT spike
  const ahtSpike = [...intervals].sort((a, b) => (b.actAHT - b.fcstAHT) - (a.actAHT - a.fcstAHT))[0];
  if (ahtSpike && ahtSpike.actAHT > ahtSpike.fcstAHT + 20) {
    const extra = Math.abs(ahtSpike.ahtImpact).toFixed(1);
    insights.push({ icon: '⏱', sev: 'high', text: `AHT spike at <strong>${STATE.slotTimes[ahtSpike.index]}</strong> (+${ahtSpike.actAHT - ahtSpike.fcstAHT}s) added <strong>${extra} FTE</strong> workload.` });
  }

  // Insight 3: Overall ILA
  if (s.avgAcc < 85) {
    insights.push({ icon: '📉', sev: 'high', text: `Overall ILA is <strong>${s.avgAcc}%</strong> — below 85% threshold. Review forecast model inputs for ${DAYS[STATE.dayIdx]}.` });
  }

  // Insight 4: Overstaffed windows
  const surplus = intervals.filter(r => r.gap > 5).length;
  if (surplus > 2) {
    insights.push({ icon: '💼', sev: 'med', text: `<strong>${surplus} intervals</strong> are overstaffed by 5+ FTE. Consider shift flexibility or early logout options.` });
  }

  // Insight 5: volume trend
  const volTrend = s.trendFactor;
  if (volTrend > 1.1) {
    insights.push({ icon: '📈', sev: 'high', text: `Volume running <strong>+${((volTrend - 1) * 100).toFixed(0)}% above forecast</strong>. Reforecast triggered — review staffing for remaining day.` });
  } else if (volTrend < 0.9) {
    insights.push({ icon: '📉', sev: 'med', text: `Volume tracking <strong>${((1 - volTrend) * 100).toFixed(0)}% below forecast</strong>. Consider early shrinkage or training opportunities.` });
  }

  // Insight 6: Backlog risk
  if (s.backlog > 40) {
    insights.push({ icon: '🔴', sev: 'high', text: `Backlog risk: approximately <strong>${s.backlog} calls</strong> may not be handled at current staffing. Escalation recommended.` });
  }

  // Insight 7: Peak cluster
  const critCount = intervals.filter(r => r.gap < -5).length;
  if (critCount >= 3) {
    insights.push({ icon: '⚠', sev: 'high', text: `<strong>${critCount} consecutive critical intervals</strong> detected. Break clustering may be contributing — review break schedule.` });
  }

  // Insight 8: positive note
  const goodCount = intervals.filter(r => r.accuracy >= 90).length;
  if (goodCount > intervals.length * 0.6) {
    insights.push({ icon: '✅', sev: 'low', text: `<strong>${goodCount} of ${intervals.length} intervals</strong> hit ≥90% accuracy. Forecast model performing well for lower-volume windows.` });
  }

  cont.innerHTML = insights.map(ins => `
    <div class="insight-card insight-sev-${ins.sev}">
      <div class="insight-icon">${ins.icon}</div>
      <div class="insight-text">${ins.text}</div>
    </div>`).join('');
}

/* ═══════════════════════════════════════════════════════════
   6. SIMULATOR
═══════════════════════════════════════════════════════════ */

function getSimIntervals() {
  const rawDay = ALL_WEEKS[STATE.weekIdx][DAYS[STATE.dayIdx]];
  const occ = STATE.occupancy / 100;
  const secInInterval = STATE.intervalMin * 60;
  const scaleFactor = STATE.intervalMin / 30;

  return rawDay.map(row => {
    const vol = Math.round(row.actVol * scaleFactor * (1 + STATE.simVolume / 100));
    const aht = Math.max(60, row.actAHT + STATE.simAHT);
    const reqFTE = (vol * aht) / (secInInterval * occ);
    const schedFTE = Math.round(row.scheduled * scaleFactor) + STATE.simAgents;
    const gap = schedFTE - reqFTE;
    return { reqFTE: +reqFTE.toFixed(1), schedFTE, gap: +gap.toFixed(1) };
  });
}

function renderSimulator() {
  const simIntervals = getSimIntervals();
  const base = STATE.intervals;
  if (!base.length) return;

  const baseReqFTE = base.reduce((s, r) => s + r.reqFTE, 0);
  const simReqFTE  = simIntervals.reduce((s, r) => s + r.reqFTE, 0);
  const baseGap    = +(base.reduce((s, r) => s + r.gap, 0) / base.length).toFixed(1);
  const simGap     = +(simIntervals.reduce((s, r) => s + r.gap, 0) / simIntervals.length).toFixed(1);
  const baseCrit   = base.filter(r => r.gap < -3).length;
  const simCrit    = simIntervals.filter(r => r.gap < -3).length;

  const grid = document.getElementById('simImpactGrid');
  if (!grid) return;

  function card(label, before, after, unit, upIsBad) {
    const diff = +(after - before).toFixed(1);
    const cls = diff === 0 ? 'neutral' : (diff > 0 === upIsBad ? 'positive' : 'negative');
    const sign = diff > 0 ? '+' : '';
    return `<div class="sim-impact-card">
      <div class="sic-label">${label}</div>
      <div class="sic-before">Before: ${(+before).toFixed(1)}${unit}</div>
      <div class="sic-after ${cls}">${(+after).toFixed(1)}${unit}</div>
      <div class="sic-delta ${cls}">${sign}${diff}${unit}</div>
    </div>`;
  }

  grid.innerHTML =
    card('Total Req FTE', baseReqFTE, simReqFTE, '', true) +
    card('Avg Gap', baseGap, simGap, '', true) +
    card('Critical Intervals', baseCrit, simCrit, '', true);

  drawSimChart();
}

/* ═══════════════════════════════════════════════════════════
   7. AI COPILOT
═══════════════════════════════════════════════════════════ */

const COPILOT_RESPONSES = {
  'sla dropping': () => {
    const s = STATE.summary;
    const worst = STATE.summary.peaks[0];
    const time = worst ? STATE.slotTimes[worst.index] : 'peak window';
    return `<strong>Root Cause Analysis:</strong><br><br>
SLA is dropping primarily due to:<br><br>
• <strong>Volume spike</strong>: Actual volume is running ${s.trendFactor > 1 ? '+' : ''}${((s.trendFactor - 1) * 100).toFixed(0)}% vs forecast (trend factor: ${s.trendFactor.toFixed(2)})<br>
• <strong>Staffing gap</strong>: Average gap of ${s.avgGap.toFixed(1)} FTE across the day<br>
• <strong>Critical window</strong>: ${time} is the worst interval — understaffed by ${worst ? Math.abs(worst.gap).toFixed(1) : 'N/A'} FTE<br><br>
${s.rfcTriggered ? '⚡ Reforecast has been triggered. New projected volume: ' + s.newFcst.toLocaleString() + ' calls.' : ''}
<div class="action-item">✅ Immediate: Pull forward breaks from over-staffed windows to cover ${time}</div>
<div class="action-item">✅ Short-term: Authorize OT for agents available on-site</div>
<div class="action-item">✅ Notify team leads to reduce wrap-up time (AHT reduction target: -${Math.round(s.avgActAHT * 0.05)}s)</div>`;
  },
  'do now': () => {
    const s = STATE.summary;
    const critCount = STATE.intervals.filter(r => r.gap < -3).length;
    return `<strong>Immediate Action Plan:</strong><br><br>
Priority actions for the next 60 minutes:<br><br>
<div class="action-item">🔴 Act on <strong>${critCount} critical intervals</strong> — check agent availability for voluntary OT</div>
<div class="action-item">🟡 Review break schedule — redistribute ${Math.abs(s.avgGap).toFixed(0)} FTE gap using staggered breaks</div>
<div class="action-item">🟢 Communicate volume trend (+${((s.trendFactor - 1) * 100).toFixed(0)}%) to operations team for same-day capacity decisions</div>
<div class="action-item">📊 Update intraday forecast — new projection: <strong>${s.newFcst.toLocaleString()} calls</strong></div>
<div class="action-item">📞 Escalate to WFM Manager if gap exceeds 10 FTE within next 2 intervals</div>`;
  },
  'worst interval': () => {
    const worst = STATE.summary.peaks[0];
    if (!worst) return 'No data available yet. Please ensure data is loaded.';
    const time = STATE.slotTimes[worst.index];
    const slaRisk = Math.min(100, Math.round(Math.abs(worst.gap) * 3.5));
    return `<strong>Worst Interval: ${time}</strong><br><br>
• <strong>Staffing Gap:</strong> ${worst.gap.toFixed(1)} FTE (${Math.abs(worst.gap).toFixed(0)} agents short)<br>
• <strong>Volume Variance:</strong> ${worst.volVariance > 0 ? '+' : ''}${worst.volVariance} calls vs forecast<br>
• <strong>Actual AHT:</strong> ${worst.actAHT}s (forecast: ${worst.fcstAHT}s)<br>
• <strong>Accuracy:</strong> ${worst.accuracy}%<br>
• <strong>SLA Risk Contribution:</strong> ~${slaRisk}%<br><br>
<div class="action-item">📋 Recommend: Pre-position agents 15 min before ${time} to absorb incoming volume</div>
<div class="action-item">📋 Consider: Reduce non-phone activity in adjacent intervals</div>`;
  },
  'staffing gap': () => {
    const s = STATE.summary;
    const total = s.totalVolImpact + s.totalAHTImpact + s.totalSchedImpact || 1;
    const volPct = Math.round((s.totalVolImpact / total) * 100);
    const ahtPct = Math.round((s.totalAHTImpact / total) * 100);
    const schPct = Math.round((s.totalSchedImpact / total) * 100);
    return `<strong>Staffing Gap Decomposition:</strong><br><br>
The total staffing gap is caused by three factors:<br><br>
• <strong>Volume variance:</strong> ${volPct}% of gap (${s.totalVolImpact.toFixed(1)} FTE)<br>
  → Actual calls ${s.trendFactor > 1 ? 'exceeded' : 'came in below'} forecast by ${Math.abs(((s.trendFactor - 1) * 100)).toFixed(1)}%<br><br>
• <strong>AHT variance:</strong> ${ahtPct}% of gap (${s.totalAHTImpact.toFixed(1)} FTE)<br>
  → Agents spent ${s.avgActAHT > s.avgFcstAHT ? '+' : ''}${s.avgActAHT - s.avgFcstAHT}s more per call than forecast<br><br>
• <strong>Scheduling gap:</strong> ${schPct}% of gap (${s.totalSchedImpact.toFixed(1)} FTE)<br>
  → Shift planning did not account for actual demand pattern<br><br>
<div class="action-item">💡 Primary lever: ${volPct >= ahtPct && volPct >= schPct ? 'Volume forecasting improvement — review pattern assumptions' : ahtPct >= schPct ? 'AHT reduction initiative — coaching on wrap-up and hold time' : 'Scheduling model update — better shift alignment with forecast peaks'}</div>`;
  }
};

function getCopilotResponse(question) {
  const q = question.toLowerCase();
  if (q.includes('sla') || q.includes('drop') || q.includes('service level')) return COPILOT_RESPONSES['sla dropping']();
  if (q.includes('do now') || q.includes('action') || q.includes('recommend')) return COPILOT_RESPONSES['do now']();
  if (q.includes('worst') || q.includes('interval') || q.includes('attention')) return COPILOT_RESPONSES['worst interval']();
  if (q.includes('gap') || q.includes('staffing') || q.includes('caused') || q.includes('cause')) return COPILOT_RESPONSES['staffing gap']();
  // Fallback generic
  const s = STATE.summary;
  return `Based on current data for <strong>${DAYS[STATE.dayIdx]}</strong>:<br><br>
• ILA Score: <strong>${s.avgAcc}%</strong><br>
• Average Staffing Gap: <strong>${s.avgGap}</strong> FTE<br>
• Total Volume: <strong>${s.totalAct.toLocaleString()}</strong> (fcst: ${s.totalFcst.toLocaleString()})<br>
• Backlog Risk: <strong>${s.backlog}</strong> calls<br>
• Reforecast: <strong>${s.rfcTriggered ? 'ACTIVE — new forecast: ' + s.newFcst.toLocaleString() : 'Not triggered'}</strong><br><br>
Try asking: <em>"Why is SLA dropping?"</em>, <em>"What should I do now?"</em>, or <em>"Which interval is worst?"</em>`;
}

function appendCopilotMsg(text, isUser) {
  const hist = document.getElementById('copilotHistory');
  const msg = document.createElement('div');
  msg.className = 'copilot-msg ' + (isUser ? 'user' : 'bot');
  msg.innerHTML = `
    <div class="copilot-avatar">${isUser ? '👤' : 'AB'}</div>
    <div class="copilot-bubble">${isUser ? text : text}</div>`;
  hist.appendChild(msg);
  hist.scrollTop = hist.scrollHeight;
}

function showTypingIndicator() {
  const hist = document.getElementById('copilotHistory');
  const typing = document.createElement('div');
  typing.className = 'copilot-msg bot';
  typing.id = 'typingIndicator';
  typing.innerHTML = `<div class="copilot-avatar">AB</div><div class="copilot-bubble"><div class="typing-dots"><span></span><span></span><span></span></div></div>`;
  hist.appendChild(typing);
  hist.scrollTop = hist.scrollHeight;
}

function removeTypingIndicator() {
  const el = document.getElementById('typingIndicator');
  if (el) el.remove();
}

/* ═══════════════════════════════════════════════════════════
   8. EOD EMAIL
═══════════════════════════════════════════════════════════ */

function renderEODEmail() {
  const el = document.getElementById('emailPreview');
  if (!el) return;
  const s = STATE.summary;
  const day = DAYS[STATE.dayIdx];
  const week = `Week ${STATE.weekIdx + 1}`;
  const date = new Date();
  const dateStr = date.toLocaleDateString('en-GB', { weekday:'long', year:'numeric', month:'long', day:'numeric' });
  const volDiff = s.totalAct - s.totalFcst;
  const worst3 = STATE.summary.peaks.map((r, i) => `${i + 1}. ${STATE.slotTimes[r.index] || '--'} — Gap: ${r.gap.toFixed(1)} FTE, Accuracy: ${r.accuracy}%, Vol Var: ${r.volVariance > 0 ? '+' : ''}${r.volVariance}`).join('\n');

  const rootCause = [];
  if (Math.abs(s.trendFactor - 1) > 0.05) rootCause.push(`Volume was ${s.trendFactor > 1 ? '+' : ''}${((s.trendFactor - 1) * 100).toFixed(1)}% vs forecast (trend factor: ${s.trendFactor.toFixed(2)})`);
  if (s.avgActAHT > s.avgFcstAHT + 10) rootCause.push(`AHT exceeded forecast by ${s.avgActAHT - s.avgFcstAHT}s per call`);
  if (s.avgGap < -2) rootCause.push(`Staffing gap averaged ${s.avgGap} FTE across the day`);
  if (!rootCause.length) rootCause.push('No major deviations — performance within acceptable thresholds');

  el.innerHTML = `
<div class="email-subject">📨 WFM Intraday Summary – ${day}, ${dateStr} (${week})</div>
<div>To: WFM Leadership | Operations Management | Resource Planning</div>
<div>From: Abdul Basit – WFM Intelligence Suite (Auto-Generated)</div>
<br>

<div class="email-section">
<div class="email-section-title">📊 Daily Volume Summary</div>
<div class="email-row"><span class="email-key">Total Actual Volume:</span><span class="email-val">${s.totalAct.toLocaleString()} calls</span></div>
<div class="email-row"><span class="email-key">Total Forecast Volume:</span><span class="email-val">${s.totalFcst.toLocaleString()} calls</span></div>
<div class="email-row"><span class="email-key">Variance:</span><span class="email-val">${volDiff > 0 ? '+' : ''}${volDiff} calls (${((volDiff / s.totalFcst) * 100).toFixed(1)}%)</span></div>
<div class="email-row"><span class="email-key">ILA Score:</span><span class="email-val">${s.avgAcc}%</span></div>
<div class="email-row"><span class="email-key">Avg AHT (Actual/Forecast):</span><span class="email-val">${s.avgActAHT}s / ${s.avgFcstAHT}s</span></div>
<div class="email-row"><span class="email-key">Avg Staffing Gap:</span><span class="email-val">${s.avgGap} FTE</span></div>
<div class="email-row"><span class="email-key">Backlog Risk:</span><span class="email-val">${s.backlog} calls</span></div>
</div>

<div class="email-section">
<div class="email-section-title">⚠ Worst Performing Intervals</div>
<pre style="font-family:var(--font-mono);font-size:11.5px;color:var(--text-secondary);line-height:1.8;">${worst3}</pre>
</div>

<div class="email-section">
<div class="email-section-title">🔍 Root Cause Analysis</div>
${rootCause.map(r => `<div style="padding:3px 0;color:var(--text-secondary);">• ${r}</div>`).join('')}
</div>

<div class="email-section">
<div class="email-section-title">⚡ Error Decomposition</div>
<div class="email-row"><span class="email-key">Volume Impact:</span><span class="email-val">${s.totalVolImpact.toFixed(1)} FTE</span></div>
<div class="email-row"><span class="email-key">AHT Impact:</span><span class="email-val">${s.totalAHTImpact.toFixed(1)} FTE</span></div>
<div class="email-row"><span class="email-key">Scheduling Impact:</span><span class="email-val">${s.totalSchedImpact.toFixed(1)} FTE</span></div>
</div>

<div class="email-section">
<div class="email-section-title">✅ Actions Taken Today</div>
<div style="color:var(--text-secondary);line-height:1.8;">
• Intraday reforecast ${s.rfcTriggered ? 'triggered and communicated — new forecast: ' + s.newFcst.toLocaleString() + ' calls' : 'not required (variance within threshold)'}<br>
• Break schedule reviewed and adjusted for peak intervals<br>
• OT authorization communicated to operations team<br>
• WFM alerts distributed for ${STATE.summary.peaks.length} critical intervals
</div>
</div>

<div class="email-section">
<div class="email-section-title">📅 Next Day Recommendations</div>
<div style="color:var(--text-secondary);line-height:1.8;">
• ${s.trendFactor > 1.05 ? 'Adjust upward by ' + ((s.trendFactor - 1) * 100).toFixed(0) + '% — volume is tracking above historical forecast' : 'Maintain current forecast — volume tracking within normal range'}<br>
• ${s.avgActAHT > s.avgFcstAHT + 15 ? 'Review AHT forecast assumptions — actual is consistently ' + (s.avgActAHT - s.avgFcstAHT) + 's higher than forecast' : 'AHT forecast is aligned — no adjustment needed'}<br>
• Pre-plan OT coverage for ${STATE.slotTimes[STATE.summary.peaks[0]?.index] || 'peak window'} window based on today\'s pattern<br>
• Review break clustering to avoid FTE loss during high-volume periods
</div>
</div>

<hr style="border-color:var(--border);margin:16px 0;"/>
<div style="font-size:11px;color:var(--text-muted);">
Auto-generated by Abdul Basit – WFM Intelligence Suite | Interval Level Accuracy & Intraday Decision Engine<br>
Keywords: WFM tool, interval accuracy, call center forecasting, intraday management, ILA, staffing gap, SLA projection
</div>`;
}

/* ═══════════════════════════════════════════════════════════
   9. INTERVAL DETAIL MODAL
═══════════════════════════════════════════════════════════ */

function openModal(idx) {
  const r = STATE.intervals[idx];
  const time = STATE.slotTimes[idx] || '--';
  const content = document.getElementById('modalContent');
  content.innerHTML = `
    <h3>Interval Detail: ${time}</h3>
    <div class="modal-row"><span class="modal-key">Time Slot</span><span class="modal-val">${time}</span></div>
    <div class="modal-row"><span class="modal-key">Forecast Volume</span><span class="modal-val">${r.fcstVol}</span></div>
    <div class="modal-row"><span class="modal-key">Actual Volume</span><span class="modal-val">${r.actualVol}</span></div>
    <div class="modal-row"><span class="modal-key">Volume Variance</span><span class="modal-val ${r.volVariance > 0 ? 'val-red' : 'val-green'}">${r.volVariance > 0 ? '+' : ''}${r.volVariance}</span></div>
    <div class="modal-row"><span class="modal-key">Accuracy %</span><span class="modal-val ${r.accuracy >= 85 ? 'val-green' : 'val-red'}">${r.accuracy}%</span></div>
    <div class="modal-row"><span class="modal-key">Forecast AHT</span><span class="modal-val">${r.fcstAHT}s</span></div>
    <div class="modal-row"><span class="modal-key">Actual AHT</span><span class="modal-val">${r.actAHT}s</span></div>
    <div class="modal-row"><span class="modal-key">Required FTE</span><span class="modal-val">${r.reqFTE}</span></div>
    <div class="modal-row"><span class="modal-key">Scheduled FTE</span><span class="modal-val">${r.schedFTE}</span></div>
    <div class="modal-row"><span class="modal-key">Staffing Gap</span><span class="modal-val ${r.gap < 0 ? 'val-red' : 'val-green'}">${r.gap > 0 ? '+' : ''}${r.gap}</span></div>
    <div class="modal-row"><span class="modal-key">Status</span><span class="modal-val"><span class="status-badge ${r.statusClass}">${r.status}</span></span></div>
    <div class="modal-row"><span class="modal-key">Volume Impact</span><span class="modal-val">${r.volImpact} FTE</span></div>
    <div class="modal-row"><span class="modal-key">AHT Impact</span><span class="modal-val">${r.ahtImpact} FTE</span></div>
    <div class="modal-formula">
Accuracy % = (1 – |${r.actualVol} – ${r.fcstVol}| / ${r.fcstVol}) × 100 = ${r.accuracy}%
Req FTE = (${r.actualVol} × ${r.actAHT}) / (${STATE.intervalMin * 60} × ${STATE.occupancy / 100}) = ${r.reqFTE}
Gap = ${r.schedFTE} – ${r.reqFTE} = ${r.gap}</div>`;
  document.getElementById('modalOverlay').classList.add('open');
}

/* ═══════════════════════════════════════════════════════════
   10. TOOLTIP ENGINE
═══════════════════════════════════════════════════════════ */

const tooltip = document.getElementById('tooltipBox');

document.addEventListener('mouseover', e => {
  const el = e.target.closest('[data-tip]');
  if (el) {
    tooltip.textContent = el.getAttribute('data-tip');
    tooltip.classList.add('visible');
  }
});

document.addEventListener('mouseout', e => {
  if (!e.target.closest('[data-tip]')) tooltip.classList.remove('visible');
});

document.addEventListener('mousemove', e => {
  tooltip.style.left = (e.clientX + 14) + 'px';
  tooltip.style.top  = (e.clientY + 14) + 'px';
  if (e.clientX + 280 > window.innerWidth) tooltip.style.left = (e.clientX - 270) + 'px';
});

/* ═══════════════════════════════════════════════════════════
   11. MASTER RENDER
═══════════════════════════════════════════════════════════ */

function renderAll() {
  refreshData();
  renderKPIs();
  renderHeatmap();
  drawVolumeChart();
  drawStaffChart();
  renderDecomposition();
  renderPeaks();
  renderReforecast();
  renderIntervalTable();
  renderInsights();
  renderSimulator();
  renderEODEmail();
}

/* ═══════════════════════════════════════════════════════════
   12. EVENTS
═══════════════════════════════════════════════════════════ */

// Tab switching
document.querySelectorAll('.nav-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-tab').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
    // Redraw charts when switching to their tab
    setTimeout(() => {
      if (btn.dataset.tab === 'dashboard') { drawVolumeChart(); drawStaffChart(); }
      if (btn.dataset.tab === 'simulator') drawSimChart();
    }, 50);
  });
});

// Controls
document.getElementById('weekSelector').addEventListener('change', e => { STATE.weekIdx = +e.target.value; renderAll(); });
document.getElementById('daySelector').addEventListener('change', e => { STATE.dayIdx = +e.target.value; renderAll(); });
document.getElementById('intervalSize').addEventListener('change', e => { STATE.intervalMin = +e.target.value; renderAll(); });
document.getElementById('occupancyInput').addEventListener('input', e => { STATE.occupancy = clamp(+e.target.value, 50, 100); renderAll(); });
document.getElementById('slaTarget').addEventListener('input', e => { STATE.slaTarget = clamp(+e.target.value, 50, 100); renderAll(); });

// Simulator sliders
document.getElementById('simVolume').addEventListener('input', e => {
  STATE.simVolume = +e.target.value;
  document.getElementById('simVolLabel').textContent = (STATE.simVolume >= 0 ? '+' : '') + STATE.simVolume + '%';
  renderSimulator();
});
document.getElementById('simAHT').addEventListener('input', e => {
  STATE.simAHT = +e.target.value;
  document.getElementById('simAHTLabel').textContent = (STATE.simAHT >= 0 ? '+' : '') + STATE.simAHT + 's';
  renderSimulator();
});
document.getElementById('simAgents').addEventListener('input', e => {
  STATE.simAgents = +e.target.value;
  document.getElementById('simAgentsLabel').textContent = (STATE.simAgents >= 0 ? '+' : '') + STATE.simAgents;
  renderSimulator();
});
document.getElementById('resetSimBtn').addEventListener('click', () => {
  STATE.simVolume = 0; STATE.simAHT = 0; STATE.simAgents = 0;
  document.getElementById('simVolume').value = 0;
  document.getElementById('simAHT').value = 0;
  document.getElementById('simAgents').value = 0;
  document.getElementById('simVolLabel').textContent = '+0%';
  document.getElementById('simAHTLabel').textContent = '+0s';
  document.getElementById('simAgentsLabel').textContent = '+0';
  renderSimulator();
});

// Copilot
function sendCopilotQuestion(q) {
  const question = q.trim();
  if (!question) return;
  appendCopilotMsg(question, true);
  showTypingIndicator();
  setTimeout(() => {
    removeTypingIndicator();
    appendCopilotMsg(getCopilotResponse(question), false);
  }, 900 + Math.random() * 400);
}

document.getElementById('copilotSend').addEventListener('click', () => {
  const input = document.getElementById('copilotInput');
  sendCopilotQuestion(input.value);
  input.value = '';
});
document.getElementById('copilotInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    const input = document.getElementById('copilotInput');
    sendCopilotQuestion(input.value);
    input.value = '';
  }
});
document.querySelectorAll('.suggestion-pill').forEach(pill => {
  pill.addEventListener('click', () => sendCopilotQuestion(pill.dataset.q));
});

// Modal close
document.getElementById('modalClose').addEventListener('click', () => document.getElementById('modalOverlay').classList.remove('open'));
document.getElementById('modalOverlay').addEventListener('click', e => { if (e.target === e.currentTarget) e.currentTarget.classList.remove('open'); });

// Copy email
document.getElementById('copyEmailBtn').addEventListener('click', () => {
  const text = document.getElementById('emailPreview').innerText;
  navigator.clipboard.writeText(text).then(() => {
    const btn = document.getElementById('copyEmailBtn');
    btn.textContent = '✓ Copied!';
    setTimeout(() => { btn.textContent = '📋 Copy to Clipboard'; }, 2000);
  });
});

// Resize charts
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    drawVolumeChart();
    drawStaffChart();
    drawSimChart();
  }, 150);
});

/* ═══════════════════════════════════════════════════════════
   13. BOOT
═══════════════════════════════════════════════════════════ */

window.addEventListener('DOMContentLoaded', () => {
  renderAll();
  // Redraw charts after layout settles
  setTimeout(() => {
    drawVolumeChart();
    drawStaffChart();
  }, 100);
});
