// ==UserScript==
// @name         Archer Mining Co Advisor
// @namespace    sterlingarcher.torn
// @version      2.0.1
// @description  Display-only company advisor for a Mining Corporation: staff allocation by total EE with Sales Executive and Secretary filled first, staff health, and a best-guess setup model. Reads the Torn API with your Limited key only when you open or refresh the panel.
// @match        https://www.torn.com/companies.php*
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      api.torn.com
// @homepageURL  https://github.com/Ste5144/Torn-Script
// @updateURL    https://raw.githubusercontent.com/Ste5144/Torn-Script/main/archer-mining-advisor.user.js
// @downloadURL  https://raw.githubusercontent.com/Ste5144/Torn-Script/main/archer-mining-advisor.user.js
// ==/UserScript==

(function () {
  'use strict';
// Archer Mining Co best-guess model. Pure functions, shared by the page and tests.
const Model = {
  production(p, mo) { return Math.max(0, p.prodBase + p.prodPerMO * mo); },
  adLift(p, ads) { return 1 + p.adA * (1 - Math.exp(-ads / p.adK)); },
  priceFactor(p, price) { return Math.pow(price / p.refPrice, p.elast); },
  demand(p, price, ads) { return p.D0 * Model.priceFactor(p, price) * Model.adLift(p, ads); },

  // One day. useStock: sell from stock if production is short.
  day(p, o) {
    const price = o.price ?? p.price, ads = o.ads ?? p.ads, mo = o.mo ?? p.mo;
    const wages = o.wages ?? p.wages;
    const prod = Model.production(p, mo);
    const dem = Model.demand(p, price, ads);
    const supply = o.useStock ? prod + Math.max(0, p.stock) : prod;
    const sold = Math.min(dem, supply);
    const revenue = sold * price;
    const cost = wages + ads * 1e6 + p.otherCosts;
    return { price, ads, mo, prod, dem, sold, revenue, cost, profit: revenue - cost,
             stockChange: prod - sold, capped: dem <= supply };
  },

  // Best ad budget ($m) for given price and MO count, steady state (no stock drawdown).
  bestAds(p, price, mo, useStock) {
    let best = null;
    for (let a = 0; a <= 40.0001; a += 0.25) {
      const d = Model.day(p, { price, ads: a, mo, useStock });
      if (!best || d.profit > best.profit) best = d;
    }
    return best;
  },

  // Fit demand curve to log rows that were demand-capped.
  fit(p, rows, opts) {
    const use = rows.filter(r => r.capped && r.sold > 0 && r.price > 0 && r.days > 0);
    if (use.length < 2) return { error: 'Need at least 2 logged rows marked "stock available".' };
    const As = opts.fitAds ? range(0, 1.5, 0.01) : [p.adA];
    const Ks = opts.fitAds ? range(1, 30, 0.5) : [p.adK];
    const Es = opts.fitPrice ? range(-4, 0, 0.05) : [p.elast];
    let best = null;
    for (const A of As) for (const K of Ks) for (const E of Es) {
      let num = 0, den = 0;
      const g = use.map(r => Math.pow(r.price / p.refPrice, E) * (1 + A * (1 - Math.exp(-r.ads / K))));
      use.forEach((r, i) => { num += r.days * r.sold * g[i]; den += r.days * g[i] * g[i]; });
      const D0 = num / den;
      let sse = 0;
      use.forEach((r, i) => { const e = r.sold - D0 * g[i]; sse += r.days * e * e; });
      if (!best || sse < best.sse) best = { A, K, E, D0, sse };
    }
    let wsum = 0, mean = 0;
    use.forEach(r => { wsum += r.days; mean += r.days * r.sold; });
    mean /= wsum;
    let sst = 0; use.forEach(r => { sst += r.days * (r.sold - mean) ** 2; });
    best.r2 = sst > 0 ? 1 - best.sse / sst : null;
    best.rmse = Math.sqrt(best.sse / wsum);
    best.n = use.length; best.days = wsum;
    best.resid = use.map(r => ({ label: r.label,
      pred: best.D0 * Math.pow(r.price / p.refPrice, best.E) * (1 + best.A * (1 - Math.exp(-r.ads / best.K))),
      sold: r.sold }));
    // Production: regress made on MO where both given.
    const pr = rows.filter(r => r.made > 0 && r.mo > 0);
    if (pr.length) {
      const mos = new Set(pr.map(r => r.mo));
      if (mos.size >= 2) {
        let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
        pr.forEach(r => { const w = r.days || 1; sw += w; sx += w * r.mo; sy += w * r.made; sxx += w * r.mo * r.mo; sxy += w * r.mo * r.made; });
        const slope = (sw * sxy - sx * sy) / (sw * sxx - sx * sx);
        best.prod = { perMO: slope, base: (sy - slope * sx) / sw, method: 'regression' };
      } else {
        let sw = 0, sy = 0, m = 0;
        pr.forEach(r => { const w = r.days || 1; sw += w; sy += w * r.made; m = r.mo; });
        best.prod = { perMO: p.prodPerMO, base: sy / sw - p.prodPerMO * m, method: 'base only (MO count never varied)' };
      }
    }
    return best;
  }
};
function range(a, b, s) { const o = []; for (let x = a; x <= b + 1e-9; x += s) o.push(Math.round(x * 1000) / 1000); return o; }

const REQ = {
  'sales executive':    { p: ['int', 83000], s: ['end', 41500], special: '' },
  'mill operator':      { p: ['man', 75000], s: ['end', 37500], special: '' },
  'production foreman': { p: ['end', 79000], s: ['man', 39500], special: '' },
  'mine engineer':      { p: ['int', 81000], s: ['end', 40500], special: '' },
  'electrician':        { p: ['end', 78000], s: ['man', 39000], special: '' },
  'safety inspector':   { p: ['int', 95000], s: ['man', 47500], special: 'Cleaner' },
  'site manager':       { p: ['int', 97500], s: ['end', 48750], special: 'Manager' },
  'secretary':          { p: ['end', 78000], s: ['int', 39000], special: 'Secretary' }
};
const ROLE_NAMES = { 'sales executive': 'Sales Executive', 'mill operator': 'Mill Operator', 'production foreman': 'Production Foreman',
  'mine engineer': 'Mine Engineer', 'electrician': 'Electrician', 'safety inspector': 'Safety Inspector', 'site manager': 'Site Manager', 'secretary': 'Secretary' };

// Hungarian algorithm (minimise cost), square matrix.
function hungarian(c) {
  const n = c.length, INF = 1e18, u = Array(n + 1).fill(0), v = Array(n + 1).fill(0), p = Array(n + 1).fill(0), way = Array(n + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i; let j0 = 0; const minv = Array(n + 1).fill(INF), used = Array(n + 1).fill(false);
    do {
      used[j0] = true; const i0 = p[j0]; let delta = INF, j1 = 0;
      for (let j = 1; j <= n; j++) if (!used[j]) {
        const cur = c[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= n; j++) { if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta; }
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }
  const a = Array(n).fill(-1);
  for (let j = 1; j <= n; j++) if (p[j]) a[p[j] - 1] = j - 1;
  return a; // a[row] = col
}


  // ---------------- Settings and storage ----------------
  const get = (k, d) => { try { const v = GM_getValue(k); return v === undefined ? d : JSON.parse(v); } catch (e) { return d; } };
  const set = (k, v) => GM_setValue(k, JSON.stringify(v));
  const DEF = {
    key: '', bonus: 0, weights: {}, locks: {}, lockRoles: ['site manager', 'safety inspector'], minGain: 10, floor: 90, floorRoles: ['mine engineer', 'production foreman', 'electrician', 'secretary'],
    model: { D0: 6848, refPrice: 8625, adA: 0.40, adK: 3.5, elast: -0.8, prodBase: 1980, prodPerMO: 920, otherCosts: 0, warehouseCap: 0 },
    seedLog: [
      { label: '4-11 Oct', days: 8, price: 8500, ads: 7.5, sold: 9415, capped: true },
      { label: '12-17 Oct', days: 6, price: 8625, ads: 7.5, sold: 9283, capped: true },
      { label: '18-24 Oct', days: 7, price: 8500, ads: 7.5, sold: 9303, capped: true },
      { label: '25 Oct', days: 1, price: 8625, ads: 7.5, sold: 9635, made: 10250, mo: 9, capped: true },
      { label: '26 Oct', days: 1, price: 8625, ads: 7.5, sold: 9699, made: 10250, mo: 9, capped: true },
      { label: '27 Oct (ad bug)', days: 1, price: 8625, ads: 0, sold: 6842, capped: true },
      { label: '28 Oct-1 Nov', days: 5, price: 8625, ads: 7.5, sold: 9043, made: 10260, mo: 9, capped: true },
      { label: '2 Nov', days: 1, price: 8625, ads: 10, sold: 9428, mo: 9, capped: true }
    ]
  };
  const cfg = Object.assign({}, DEF, get('cfg', {}));
  cfg.model = Object.assign({}, DEF.model, cfg.model || {});
  // Sales Executive and Secretary earn the money in a mine; support roles must meet requirements; Mill Operator takes the rest.
  const EARN = ['sales executive', 'secretary'];
  const DEF_W = { 'sales executive': 10, 'secretary': 10, 'site manager': 1, 'safety inspector': 1, 'mine engineer': 1, 'electrician': 1, 'production foreman': 1, 'mill operator': 0.1 };
  if (cfg.wv !== 3) { cfg.weights = Object.assign({}, DEF_W); cfg.lockRoles = DEF.lockRoles.slice(); cfg.minGain = DEF.minGain; cfg.wv = 3; set('cfg', cfg); }
  const saveCfg = () => set('cfg', cfg);
  let snaps = get('snaps', {});   // reportDay -> { sold, made, price, ads, stock, mo, wages, income, customers }
  let eeHist = get('eeHist', {}); // reportDay -> { name: totalEE }

  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const t = v => Math.round(+v || 0).toLocaleString('en-AU');
  const m$ = v => (v < 0 ? '−' : '') + '$' + Math.abs(v / 1e6).toFixed(2) + 'm';
  const d$ = v => (v >= 0 ? '+' : '−') + '$' + Math.abs(v / 1e6).toFixed(2) + 'm';
  const sg = v => (v >= 0 ? '+' : '−') + t(Math.abs(v));
  const norm = s => String(s || '').trim().toLowerCase();

  // Company day closes about 18:10 TCT (UTC). Data fetched before that belongs to the previous report day.
  function reportDay(ts) {
    const d = new Date(ts * 1000 || Date.now());
    const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
    if (mins < 18 * 60 + 15) d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  }

  // ---------------- Effectiveness maths ----------------
  function statEE(stat, req, b) {
    if (!(stat > 0)) return 0;
    const x = stat * b / req;
    return Math.floor(Math.min(45, 45 * x) + Math.max(0, 5 * Math.log2(x)));
  }
  function wsEE(e, role, b) {
    const r = REQ[norm(role)]; if (!r) return null;
    return statEE(e[r.p[0]], r.p[1], b) + statEE(e[r.s[0]], r.s[1], b);
  }
  const baseOf = e => (e.total && e.tornWS) ? e.total - e.tornWS : 0;
  const tot = (e, role, b) => { const w = wsEE(e, role, b); return w == null ? null : w + baseOf(e); };
  function fitBonus(emps) {
    const known = emps.filter(e => e.tornWS > 0 && REQ[norm(e.position)]);
    if (!known.length) return { b: 1, err: null, n: 0 };
    let best = null;
    for (let b = 1; b <= 1.3001; b += 0.005) {
      let err = 0; known.forEach(e => err += Math.abs(wsEE(e, e.position, b) - e.tornWS));
      if (!best || err < best.err - 1e-9) best = { b: Math.round(b * 1000) / 1000, err, n: known.length };
    }
    best.err /= best.n; return best;
  }

  // ---------------- API ----------------
  let data = null, lastErr = '';
  async function load() {
    if (!cfg.key) { lastErr = 'Enter a Limited access API key in Settings.'; render(); return; }
    lastErr = ''; setStatus('Loading…');
    try {
      const r = await fetch(`https://api.torn.com/company/?selections=profile,detailed,employees,stock&key=${encodeURIComponent(cfg.key)}&comment=AMCadvisor`);
      const j = await r.json();
      if (j.error) throw new Error(`Torn API error ${j.error.code}: ${j.error.error}`);
      data = parse(j);
      record(data);
      setStatus(`Updated ${new Date().toLocaleTimeString()}`);
    } catch (e) { lastErr = e.message; setStatus(''); }
    render();
  }
  function parse(j) {
    const prof = j.company || {}, det = j.company_detailed || {}, st = j.company_stock || {};
    const emps = Object.entries(j.company_employees || {}).map(([id, e]) => ({
      id, name: e.name, position: e.position, days: e.days_in_company, wage: +e.wage || 0,
      man: +e.manual_labor || 0, int: +e.intelligence || 0, end: +e.endurance || 0,
      eff: e.effectiveness || {}, tornWS: +(e.effectiveness && e.effectiveness.working_stats) || 0,
      total: +(e.effectiveness && e.effectiveness.total) || 0,
      last: e.last_action ? (e.last_action.relative || '') : '', lastTs: e.last_action ? e.last_action.timestamp : 0,
      status: e.status ? e.status.description || e.status.state || '' : ''
    }));
    let inStock = 0, sold = 0, made = 0, price = 0, soldWorth = 0;
    Object.values(st).forEach(s => { inStock += +s.in_stock || 0; sold += +s.sold_amount || 0; made += +s.created_amount || 0; soldWorth += +s.sold_worth || 0; if (!price) price = +s.price || 0; });
    return {
      ts: j.timestamp || Math.floor(Date.now() / 1000), name: prof.name, income: prof.daily_income, customers: prof.daily_customers, weekly: prof.weekly_income,
      funds: det.company_funds, popularity: det.popularity, efficiency: det.efficiency, environment: det.environment,
      ads: (+det.advertising_budget || 0) / 1e6, emps, inStock, sold, made, price, soldWorth,
      stockKeys: Object.keys(st), hasStats: emps.some(e => e.man || e.int || e.end)
    };
  }
  function record(d) {
    const day = reportDay(d.ts);
    const mo = d.emps.filter(e => norm(e.position) === 'mill operator').length;
    snaps[day] = { sold: d.sold, made: d.made, price: d.price, ads: d.ads, stock: d.inStock, mo, income: d.income, customers: d.customers,
      wages: d.emps.reduce((a, e) => a + e.wage, 0) };
    const h = {}; d.emps.forEach(e => h[e.name] = e.total); eeHist[day] = h;
    const keep = Object.keys(snaps).sort().slice(-120); snaps = Object.fromEntries(keep.map(k => [k, snaps[k]]));
    const keepE = Object.keys(eeHist).sort().slice(-120); eeHist = Object.fromEntries(keepE.map(k => [k, eeHist[k]]));
    set('snaps', snaps); set('eeHist', eeHist);
  }

  // ---------------- UI ----------------
  const css = `
  #amc-btn{position:fixed;right:14px;bottom:70px;z-index:99999;background:#1f6f6b;color:#fff;border:0;border-radius:18px;padding:7px 13px;font:600 12px Arial;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,.4)}
  #amc{position:fixed;right:14px;bottom:110px;z-index:99999;width:min(760px,calc(100vw - 28px));max-height:calc(100vh - 140px);overflow:auto;background:#1c2220;color:#e6ebe8;border:1px solid #2f3835;border-radius:8px;font:13px/1.45 Arial,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.5);display:none}
  #amc header{position:sticky;top:0;background:#1c2220;padding:10px 12px;border-bottom:1px solid #2f3835;display:flex;flex-wrap:wrap;gap:6px;align-items:center}
  #amc h2{font-size:15px;margin:0 8px 0 0;color:#e6ebe8} #amc h3{font-size:13px;margin:12px 0 6px;color:#e6ebe8}
  #amc .tab{background:transparent;color:#5fb8b1;border:1px solid #5fb8b1;border-radius:4px;padding:3px 9px;cursor:pointer;font-size:12px}
  #amc .tab.on{background:#5fb8b1;color:#141917}
  #amc .act{background:#5fb8b1;color:#141917;border:0;border-radius:4px;padding:4px 10px;cursor:pointer;font-weight:600;font-size:12px}
  #amc .body{padding:10px 12px 14px}
  #amc table{border-collapse:collapse;width:100%;font-size:12px} #amc .sc{overflow-x:auto}
  #amc th,#amc td{padding:3px 6px;border-bottom:1px solid #2f3835;text-align:right;white-space:nowrap;color:#e6ebe8}
  #amc th{color:#9aa6a1;font-weight:600} #amc th:first-child,#amc td:first-child{text-align:left}
  #amc .l{text-align:left} #amc .mut{color:#9aa6a1;font-size:12px} #amc .pos{color:#6cc57a} #amc .neg{color:#ec7a6f} #amc .wrn{color:#e0a640}
  #amc .tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}
  #amc .tile{border:1px solid #2f3835;border-radius:6px;padding:7px 9px} #amc .tile b{display:block;font-size:17px}
  #amc .rec{border-left:3px solid #5fb8b1;background:#1f3432;padding:6px 9px;margin:6px 0;border-radius:0 4px 4px 0}
  #amc .rec.w{border-color:#e0a640}
  #amc input{background:#141917;color:#e6ebe8;border:1px solid #2f3835;border-radius:4px;padding:3px 5px;font-size:12px}
  #amc input[type=number]{width:80px} #amc label{display:inline-flex;flex-direction:column;gap:2px;margin:0 10px 8px 0;color:#9aa6a1;font-size:11px}
  #amc .cur{outline:2px solid #5fb8b1;outline-offset:-2px} #amc .new{color:#6cc57a;font-weight:700}
  #amc .spark{vertical-align:middle}`;
  const style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);
  const btn = document.createElement('button'); btn.id = 'amc-btn'; btn.textContent = 'AMC advisor'; document.body.appendChild(btn);
  const box = document.createElement('div'); box.id = 'amc'; document.body.appendChild(box);
  let tab = 'alloc', status = '';
  function setStatus(s) { status = s; const n = box.querySelector('#amc-status'); if (n) n.textContent = s; }
  btn.addEventListener('click', () => { const open = box.style.display !== 'block'; box.style.display = open ? 'block' : 'none'; if (open && !data) load(); else render(); });

  function render() {
    const tabs = [['alloc', 'Allocation'], ['health', 'Staff health'], ['setup', 'Setup'], ['settings', 'Settings']];
    let h = `<header><h2>Archer Mining Co advisor</h2>${tabs.map(([k, l]) => `<button class="tab ${tab === k ? 'on' : ''}" data-tab="${k}">${l}</button>`).join('')}
      <button class="act" data-act="refresh">Refresh</button><span class="mut" id="amc-status">${esc(status)}</span></header><div class="body">`;
    if (lastErr) h += `<div class="rec w">${esc(lastErr)}</div>`;
    if (tab === 'settings') h += viewSettings();
    else if (!data) h += `<p class="mut">No data yet. ${cfg.key ? 'Press Refresh.' : 'Add your Limited key in Settings.'}</p>`;
    else if (tab === 'alloc') h += viewAlloc();
    else if (tab === 'health') h += viewHealth();
    else if (tab === 'setup') h += viewSetup();
    box.innerHTML = h + '</div>';
  }

  // ---- Allocation
  const W = r => cfg.weights[r] === undefined ? 1 : +cfg.weights[r];
  const isLocked = e => !!cfg.locks[e.id] || (cfg.lockRoles || []).includes(norm(e.position));
  function solve(emps, b) {
    const slots = [];
    emps.forEach(e => { if (REQ[norm(e.position)]) slots.push(norm(e.position)); }); // keep current role counts
    const n = Math.max(slots.length, emps.length);
    const cost = [];
    for (let i = 0; i < n; i++) { const row = []; for (let j = 0; j < n; j++) {
      const e = emps[i], s = slots[j];
      if (!e || !s) row.push(0);
      else if (isLocked(e) && norm(e.position) !== s) row.push(1e9);
      else if ((cfg.floorRoles || []).includes(s) && (wsEE(e, s, b) || 0) < (+cfg.floor || 0)) row.push(1e7 - (wsEE(e, s, b) || 0));
      else row.push(-(tot(e, s, b) || 0) * W(s) - (norm(e.position) === s ? 0.01 : 0));
    } cost.push(row); }
    const a = hungarian(cost);
    return emps.map((e, i) => slots[a[i]] || null);
  }
  // Split moves into independent chains: A->B, B->C ... ->A. Each chain can be done on its own.
  function chains(moves) {
    const rem = moves.slice(), out = [];
    while (rem.length) {
      const start = rem.shift(), ch = [start]; let cur = start.to;
      while (cur !== start.from) {
        let k = rem.findIndex(m => m.from === cur && m.to === start.from);
        if (k < 0) k = rem.findIndex(m => m.from === cur);
        if (k < 0) break;
        const m = rem.splice(k, 1)[0]; ch.push(m); cur = m.to;
      }
      const raw = ch.reduce((a, m) => a + m.n - m.c, 0);
      const wtd = ch.reduce((a, m) => a + W(m.to) * m.n - W(m.from) * m.c, 0);
      const slotRows = ch.map((m, i) => { const nx = ch[(i + 1) % ch.length]; return { role: m.to, out: nx.e.name, outEE: nx.c, inn: m.e.name, inEE: m.n, d: m.n - nx.c }; });
      const earn = slotRows.filter(r => EARN.includes(r.role)).reduce((x, r) => x + r.d, 0);
      const sup = slotRows.filter(r => r.role !== 'mill operator');
      out.push({ ch, raw, wtd, slotRows, earn, worst: sup.length ? Math.min(...sup.map(r => r.d)) : 0 });
    }
    return out.sort((x, y) => y.wtd - x.wtd);
  }
  function viewAlloc() {
    if (!data.hasStats) return `<div class="rec w">The API returned no working stats for your employees, so allocation cannot run. Check the key belongs to you as director.</div>`;
    const fb = fitBonus(data.emps);
    const b = cfg.bonus > 0 ? cfg.bonus : fb.b;
    const asg = solve(data.emps, b);
    let cur = 0, nw = 0, ecur = 0, enw = 0; const moves = [];
    data.emps.forEach((e, i) => { const c = tot(e, e.position, b) || 0, n = asg[i] ? tot(e, asg[i], b) : 0; cur += c; nw += n;
      if (EARN.includes(norm(e.position))) ecur += c; if (EARN.includes(asg[i])) enw += n;
      if (asg[i] && asg[i] !== norm(e.position)) moves.push({ e, from: norm(e.position), to: asg[i], c, n }); });
    const chs = chains(moves), min = +cfg.minGain || 0;
    const worth = chs.filter(c => c.wtd >= min), small = chs.filter(c => c.wtd < min);
    let h = `<div class="tiles"><div class="tile">Sales + Secretary EE now<b>${t(ecur)}</b><span class="mut">the roles that earn</span></div>
      <div class="tile">Sales + Secretary EE, best setup<b>${t(enw)}</b><span class="mut">${sg(enw - ecur)}; ${worth.reduce((a, c) => a + c.ch.length, 0)} moves</span></div>
      <div class="tile">Whole company EE<b>${t(cur)}</b><span class="mut">best setup ${t(nw)}; edu ×${b}</span></div></div>
      <div class="rec">Scores are total EE (as TornStats shows): role working stats plus settled-in, merits, education, management, addiction and inactivity. Sales Executive and Secretary are filled first. Make changes in small steps and check the next day's income before the next one.</div>
      ${data.emps.filter(e => (cfg.floorRoles || []).includes(norm(e.position)) && (wsEE(e, e.position, b) || 0) < (+cfg.floor || 0)).map(e =>
        `<div class="rec w"><b>${esc(e.name)}</b> is ${esc(e.position)} with ${wsEE(e, e.position, b)} working-stats EE, below the ${cfg.floor} minimum for support roles. Top mines put their weakest staff in Mill Operator.</div>`).join('')}
      <p class="mut">Support roles need ${cfg.floor}+ EE: ${(cfg.floorRoles || []).map(r => ROLE_NAMES[r]).join(', ')}. Locked roles: ${(cfg.lockRoles || []).map(r => ROLE_NAMES[r]).join(', ') || 'none'}. Weights: Sales Executive and Secretary 10, support roles 1, Mill Operator 0.1. Change in Settings.</p>`;
    const chainRows = (c, i) => `<tr><td colspan="4" class="l" style="padding-top:10px;border-bottom:1px solid #5fb8b1"><b>Change ${i + 1}</b> · ${c.ch.length} moves · Sales + Secretary <span class="${c.earn >= 0 ? 'pos' : 'neg'}">${sg(c.earn)} EE</span> <span class="mut">(whole company ${sg(c.raw)})</span>${c.worst <= -10 ? ' <span class="wrn">· a support role drops 10+</span>' : ''}</td></tr>` +
      c.slotRows.map(r => `<tr><td class="l">${EARN.includes(r.role) ? '<b>' + ROLE_NAMES[r.role] + '</b>' : ROLE_NAMES[r.role]}</td><td class="l">${esc(r.out)} <span class="mut">${r.outEE}</span></td><td class="l"><b>${esc(r.inn)}</b> <span class="mut">${r.inEE}</span></td><td class="${r.role === 'mill operator' ? 'mut' : r.d <= -10 ? 'neg' : r.d >= 0 ? 'pos' : 'wrn'}">${sg(r.d)}</td></tr>`).join('');
    const tableOf = list => `<div class="sc"><table><tr><th class="l">Slot</th><th class="l">Out (EE)</th><th class="l">In (EE)</th><th>Slot change</th></tr>${list.map(([c, i]) => chainRows(c, i)).join('')}</table></div>`;
    h += worth.length ? `<h3>Worthwhile changes (each can be done on its own)</h3>${tableOf(worth.map((c, i) => [c, i]))}`
      : `<p class="pos">No change clears the minimum gain of ${min} weighted EE. Keep the current setup.</p>`;
    if (small.length) h += `<details><summary class="mut" style="cursor:pointer">${small.length} smaller change(s) below the ${min} EE minimum</summary>${tableOf(small.map((c, i) => [c, worth.length + i]))}</details>`;
    const roles = Object.keys(REQ);
    h += `<h3>Total EE by role</h3><p class="mut">Outline = current role, green = suggested. Torn's current total is in brackets (updates at 18:10 TCT).</p>
      <div class="sc"><table><tr><th>Employee</th><th>Lock</th>${roles.map(r => `<th>${ROLE_NAMES[r].replace(' ', '<br>')}<br><input type="number" step="0.1" data-w="${r}" value="${cfg.weights[r] ?? 1}" style="width:46px" title="Weight"></th>`).join('')}</tr>` +
      data.emps.map((e, i) => `<tr><td>${esc(e.name)}</td><td><input type="checkbox" data-lock="${e.id}" ${isLocked(e) ? 'checked' : ''} ${(cfg.lockRoles || []).includes(norm(e.position)) ? 'disabled title="Role is locked in Settings"' : ''}></td>${roles.map(r => {
        const v = tot(e, r, b), c = norm(e.position) === r;
        return `<td class="${c ? 'cur' : ''} ${asg[i] === r ? 'new' : ''}">${v}${c && e.total ? ` <span class="mut">(${e.total})</span>` : ''}</td>`; }).join('')}</tr>`).join('') + `</table></div>
      <p class="mut">Role changes do not reset settled-in (checked 7 Nov).</p>`;
    return h;
  }

  // ---- Staff health
  function spark(vals) {
    const v = vals.filter(x => x != null); if (v.length < 2) return '';
    const W = 90, H = 18, lo = Math.min(...v, 60), hi = Math.max(...v, 140);
    const pts = vals.map((x, i) => x == null ? null : `${(i / (vals.length - 1) * W).toFixed(1)},${(H - (x - lo) / (hi - lo) * H).toFixed(1)}`).filter(Boolean).join(' ');
    return `<svg class="spark" width="${W}" height="${H}"><polyline points="${pts}" fill="none" stroke="#5fb8b1" stroke-width="1.5"/></svg>`;
  }
  function viewHealth() {
    const days = Object.keys(eeHist).sort().slice(-30);
    const rows = data.emps.map(e => {
      const hist = days.map(d => eeHist[d][e.name] ?? null);
      const f = e.eff || {};
      const flags = [];
      if ((+f.addiction || 0) <= -5) flags.push(`addiction ${f.addiction}`);
      if ((+f.inactivity || 0) < 0) flags.push(`inactivity ${f.inactivity}`);
      if (e.lastTs && Date.now() / 1000 - e.lastTs > 86400) flags.push(`last seen ${e.last}`);
      return { e, f, hist, flags };
    }).sort((a, b) => a.e.total - b.e.total);
    const avg = data.emps.reduce((a, e) => a + e.total, 0) / data.emps.length;
    let h = `<div class="tiles"><div class="tile">Average total EE<b>${avg.toFixed(1)}</b></div><div class="tile">Staff flagged<b>${rows.filter(r => r.flags.length).length}</b></div>
      <div class="tile">History stored<b>${days.length} days</b><span class="mut">builds each day you refresh</span></div></div>
      <h3>Employees, lowest first</h3><div class="sc"><table><tr><th>Employee</th><th class="l">Role</th><th>Total</th><th>Stats</th><th>Settled</th><th>Merits</th><th>Edu</th><th>Mgmt</th><th>Addic.</th><th>Inact.</th><th>Days</th><th>Wage</th><th class="l">Trend</th><th class="l">Flags</th></tr>` +
      rows.map(({ e, f, hist, flags }) => `<tr><td>${esc(e.name)}</td><td class="l">${esc(e.position)}</td><td><b>${e.total}</b></td><td>${f.working_stats ?? ''}</td><td>${f.settled_in ?? ''}</td><td>${f.merits ?? ''}</td><td>${f.director_education ?? ''}</td><td>${f.management ?? ''}</td><td class="${(+f.addiction || 0) < 0 ? 'neg' : ''}">${f.addiction ?? ''}</td><td class="${(+f.inactivity || 0) < 0 ? 'neg' : ''}">${f.inactivity ?? ''}</td><td>${t(e.days)}</td><td>${m$(e.wage)}</td><td class="l">${spark(hist)}</td><td class="l wrn">${esc(flags.join('; '))}</td></tr>`).join('') + `</table></div>`;
    return h;
  }

  // ---- Setup model
  function modelParams() {
    const mo = data.emps.filter(e => norm(e.position) === 'mill operator');
    const p = Object.assign({}, cfg.model, {
      price: data.price || 8625, ads: data.ads, stock: data.inStock, mo: mo.length,
      wages: data.emps.reduce((a, e) => a + e.wage, 0), moWage: mo.length ? mo.reduce((a, e) => a + e.wage, 0) / mo.length : 0 });
    return p;
  }
  const dayFor = (p, o) => { const mo = o.mo ?? p.mo; return Model.day(p, Object.assign({}, o, { mo, wages: p.wages + (mo - p.mo) * p.moWage })); };
  function logRows() {
    const auto = Object.entries(snaps).sort().map(([d, s]) => ({ label: d, days: 1, price: s.price, ads: s.ads, sold: s.sold, made: s.made, mo: s.mo, capped: s.stock > 0 }))
      .filter(r => r.sold > 0 && r.label > '2026-11-02');
    return DEF.seedLog.concat(auto);
  }
  function viewSetup() {
    const p = modelParams();
    const now = dayFor(p, {}), withStock = dayFor(p, { useStock: true });
    let best = null; for (let a = 0; a <= 30.0001; a += 0.25) { const d = dayFor(p, { ads: a }); if (!best || d.profit > best.profit) best = d; }
    const moRows = []; for (let n = Math.max(0, p.mo - 3); n <= p.mo + 2; n++) moRows.push({ n, s: dayFor(p, { mo: n }) });
    const bestMo = moRows.reduce((a, r) => r.s.profit > a.s.profit ? r : a);
    const up = dayFor(p, { price: p.price + 125 });
    let h = `<div class="tiles">
      <div class="tile">Daily income (Torn)<b>${m$(data.income || 0)}</b><span class="mut">${t(data.customers)} customers</span></div>
      <div class="tile">Sold / made (API)<b>${t(data.sold)} / ${t(data.made)} t</b><span class="mut">period not stated by Torn; check against the company page</span></div>
      <div class="tile">Stock<b>${t(data.inStock)} t</b><span class="mut">price $${t(p.price)}, ads $${p.ads}m</span></div>
      <div class="tile">Model profit/day<b>${m$(withStock.profit)}</b><span class="mut">wages ${m$(p.wages)} + ads</span></div></div>
      <h3>Best guesses</h3>
      <div class="rec ${Math.abs(best.ads - p.ads) >= 0.5 ? 'w' : ''}">Ads: best about $${best.ads.toFixed(2)}m vs $${p.ads}m now (${d$(best.profit - now.profit)}/day). Low confidence until more ad levels are logged.</div>
      <div class="rec ${bestMo.n !== p.mo ? 'w' : ''}">Mill Operators: best steady count ${bestMo.n} vs ${p.mo} now (${d$(bestMo.s.profit - now.profit)}/day). Made ${t(bestMo.s.prod)} t vs demand ${t(bestMo.s.dem)} t. Uses the average MO wage of ${m$(p.moWage)}.</div>
      <div class="rec">Price: next test step $${t(p.price + 125)}, model ${d$(up.profit - now.profit)}/day. Elasticity is barely measured, so test for a week with ads unchanged.</div>
      <h3>Structure vs top mines</h3>${(() => {
        const cnt = r => data.emps.filter(e => norm(e.position) === r).length;
        const se = cnt('sales executive'), mo = cnt('mill operator');
        const sup = ['site manager', 'safety inspector', 'mine engineer', 'production foreman', 'electrician'].filter(r => cnt(r) !== 1).map(r => ROLE_NAMES[r]);
        return `<div class="sc"><table><tr><th>Mine</th><th>Sales Exec</th><th>Mill Op</th><th class="l">Support roles</th></tr>
          <tr><td>Top mine 1</td><td>5</td><td>8</td><td class="l">1 each, 2 Secretaries</td></tr><tr><td>Top mine 2</td><td>4</td><td>9</td><td class="l">1 each, 2 Secretaries</td></tr>
          <tr><td>Top mine 3</td><td>3</td><td>10</td><td class="l">1 each, 2 Secretaries</td></tr>
          <tr class="cur"><td><b>Yours</b></td><td>${se}</td><td>${mo}</td><td class="l">${sup.length ? '<span class="wrn">Not 1 each: ' + sup.join(', ') + '</span>' : '1 each'}, ${cnt('secretary')} Secretaries</td></tr></table></div>
          <div class="rec">Test to run after the ad test: 5 SE / 8 MO for a week, nothing else changed. If sold tonnes rise, Sales Executives drive demand. Snapshot 6 Nov; role mixes only, not their income or stats.</div>`; })()}
      <h3>Mill Operator count</h3><div class="sc"><table><tr><th>MOs</th><th>Made t</th><th>Demand t</th><th>Profit/day</th><th>vs now</th></tr>${moRows.map(r =>
        `<tr><td>${r.n}${r.n === p.mo ? ' (now)' : ''}</td><td>${t(r.s.prod)}</td><td>${t(r.s.dem)}</td><td>${m$(r.s.profit)}</td><td class="${r.s.profit >= now.profit ? 'pos' : 'neg'}">${d$(r.s.profit - now.profit)}</td></tr>`).join('')}</table></div>
      <h3>Daily log</h3><p class="mut">Seed rows from your notes plus one row per report day you refresh after the 18:10 TCT update. Fit refines demand from all of them.</p>
      <div class="sc"><table><tr><th>Day</th><th>Price</th><th>Ads $m</th><th>Sold</th><th>Made</th><th>MOs</th></tr>${logRows().slice(-14).map(r =>
        `<tr><td>${esc(r.label)}</td><td>${t(r.price)}</td><td>${r.ads}</td><td>${t(r.sold)}</td><td>${r.made ? t(r.made) : ''}</td><td>${r.mo || ''}</td></tr>`).join('')}</table></div>
      <p><button class="act" data-act="fit">Fit to log</button> <label style="flex-direction:row;align-items:center"><input type="checkbox" id="amc-fitprice" ${cfg.fitPrice ? 'checked' : ''}> fit price elasticity</label></p><div id="amc-fit"></div>`;
    return h;
  }
  function doFit() {
    const p = modelParams();
    const f = Model.fit(p, logRows(), { fitAds: true, fitPrice: !!cfg.fitPrice });
    const out = box.querySelector('#amc-fit');
    if (f.error) { out.innerHTML = `<p class="neg">${esc(f.error)}</p>`; return; }
    out.innerHTML = `<div class="rec">Base demand ${t(f.D0)} t; max ad lift ${(f.A * 100).toFixed(0)}%; ad scale $${f.K}m; elasticity ${f.E}; error ±${t(f.rmse)} t/day${f.r2 != null ? `, R² ${f.r2.toFixed(2)}` : ''}. <button class="act" data-act="applyfit">Apply</button></div>`;
    out._fit = f;
  }

  // ---- Settings
  function viewSettings() {
    const m = cfg.model;
    const fld = (k, l) => `<label>${l}<input type="number" step="any" data-m="${k}" value="${m[k]}"></label>`;
    return `<h3>API key</h3><p class="mut">Use a <b>Limited</b> access key (Settings, API Keys on Torn), never Full access. It is stored only in Tampermonkey on this browser and sent only to api.torn.com when you press Refresh or open the panel.</p>
      <label>Limited API key<input type="password" id="amc-key" value="${esc(cfg.key)}" style="width:220px"></label> <button class="act" data-act="savekey">Save key</button>
      <h3>Effectiveness</h3><label>Education bonus (0 = fit automatically)<input type="number" step="0.005" data-cfg="bonus" value="${cfg.bonus}"></label>
      <label>Minimum gain to suggest a change (weighted EE)<input type="number" step="0.5" data-cfg="minGain" value="${cfg.minGain}"></label>
      <label>Minimum EE for support roles<input type="number" step="1" data-cfg="floor" value="${cfg.floor}"></label>
      <p class="mut">Support roles with a minimum: ${Object.keys(REQ).map(r => `<label style="flex-direction:row;align-items:center;gap:4px"><input type="checkbox" data-floorrole="${r}" ${(cfg.floorRoles || []).includes(r) ? 'checked' : ''}>${ROLE_NAMES[r]}</label>`).join('')}</p>
      <h3>Locked roles</h3><p class="mut">Holders of these roles are never moved. Site Manager (Manager special) and Safety Inspector (Cleaner special) are locked by default.</p>
      <p>${Object.keys(REQ).map(r => `<label style="flex-direction:row;align-items:center;gap:4px"><input type="checkbox" data-lockrole="${r}" ${(cfg.lockRoles || []).includes(r) ? 'checked' : ''}>${ROLE_NAMES[r]}</label>`).join('')}</p>
      <p><button class="act" data-act="resetw">Reset weights and locks to defaults</button></p>
      <h3>Demand and production model</h3>
      ${fld('D0', 'Base demand at $0 ads (t)')}${fld('refPrice', 'Reference price $')}${fld('adA', 'Max ad lift')}${fld('adK', 'Ad scale $m')}${fld('elast', 'Price elasticity')}
      ${fld('prodBase', 'Non-MO production (t)')}${fld('prodPerMO', 'Per MO (t)')}${fld('otherCosts', 'Other daily costs $')}
      <p><button class="act" data-act="clearhist">Clear stored history</button> <span class="mut">${Object.keys(snaps).length} report days stored.</span></p>`;
  }

  // ---- Events
  box.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.tab) { tab = b.dataset.tab; render(); }
    else if (b.dataset.act === 'refresh') load();
    else if (b.dataset.act === 'savekey') { cfg.key = box.querySelector('#amc-key').value.trim(); saveCfg(); tab = 'alloc'; load(); }
    else if (b.dataset.act === 'fit') doFit();
    else if (b.dataset.act === 'applyfit') { const f = box.querySelector('#amc-fit')._fit; if (f) { Object.assign(cfg.model, { D0: Math.round(f.D0), adA: f.A, adK: f.K, elast: f.E }); saveCfg(); render(); } }
    else if (b.dataset.act === 'resetw') { cfg.weights = Object.assign({}, DEF_W); cfg.lockRoles = DEF.lockRoles.slice(); cfg.locks = {}; cfg.minGain = DEF.minGain; cfg.floor = DEF.floor; cfg.floorRoles = DEF.floorRoles.slice(); saveCfg(); render(); }
    else if (b.dataset.act === 'clearhist') { snaps = {}; eeHist = {}; set('snaps', snaps); set('eeHist', eeHist); render(); }
  });
  box.addEventListener('change', e => {
    const el = e.target;
    if (el.dataset.lock) { cfg.locks[el.dataset.lock] = el.checked; saveCfg(); render(); }
    else if (el.dataset.floorrole) { const r = el.dataset.floorrole; cfg.floorRoles = (cfg.floorRoles || []).filter(x => x !== r); if (el.checked) cfg.floorRoles.push(r); saveCfg(); render(); }
    else if (el.dataset.lockrole) { const r = el.dataset.lockrole; cfg.lockRoles = (cfg.lockRoles || []).filter(x => x !== r); if (el.checked) cfg.lockRoles.push(r); saveCfg(); render(); }
    else if (el.dataset.w) { cfg.weights[el.dataset.w] = parseFloat(el.value) || 0; saveCfg(); render(); }
    else if (el.dataset.m) { cfg.model[el.dataset.m] = parseFloat(el.value) || 0; saveCfg(); }
    else if (el.dataset.cfg) { cfg[el.dataset.cfg] = parseFloat(el.value) || 0; saveCfg(); }
    else if (el.id === 'amc-fitprice') { cfg.fitPrice = el.checked; saveCfg(); }
  });
})();
