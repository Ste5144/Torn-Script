// ==UserScript==
// @name         Archer Mining Co Advisor
// @namespace    sterlingarcher.torn
// @version      2.5.2
// @description  Display-only company advisor for a Mining Corporation: simple mode for a new director (next move, problems, owner summary, trains), built-in guide, house-rule checks (price, ads, wages, Mine Engineer, TCP/TGP boosts, bank floor), owner summary and an owner watch mode, daily briefing with a recommended next move, staff allocation by total EE, role-mix planner (how many Sales Executives vs Mill Operators), EE-based production with stock runway, train planner, staff health and a best-guess setup model. Reads the Torn API with your Limited key only when you open or refresh the panel.
// @match        https://www.torn.com/companies.php*
// @match        https://www.torn.com/joblist.php*
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
  // Production from Mill Operator "equivalents" (sum of MO EE / refEE). A Mine Engineer below refEE, or missing, costs up to meLoss tonnes.
  production(p, moEq, meEE) {
    const meShare = meEE == null ? 1 : Math.min(1, Math.max(0, meEE) / p.refEE);
    return Math.max(0, p.prodBase + p.prodPerMO * moEq - p.meLoss * (1 - meShare));
  },
  // Demand rises with total Sales Executive EE (measured 11-13 Nov: 4 to 5 SE, +24% SE EE, +6% sold).
  salesFactor(p, seEE) { return seEE > 0 && p.refSE > 0 ? Math.pow(seEE / p.refSE, p.seElast) : 1; },
  adLift(p, ads) { return 1 + p.adA * (1 - Math.exp(-ads / p.adK)); },
  priceFactor(p, price) { return Math.pow(price / p.refPrice, p.elast); },
  demand(p, price, ads, seEE) { return p.D0 * Model.priceFactor(p, price) * Model.adLift(p, ads) * Model.salesFactor(p, seEE); },

  // One day. useStock: sell from stock if production is short.
  day(p, o) {
    const price = o.price ?? p.price, ads = o.ads ?? p.ads, mo = o.mo ?? p.mo;
    const wages = o.wages ?? p.wages;
    const moEq = o.moEq ?? (o.mo != null && p.mo ? p.moEq * o.mo / p.mo : (p.moEq ?? mo));
    const meEE = o.meEE !== undefined ? o.meEE : p.meEE;
    const prod = Model.production(p, moEq, meEE);
    const dem = Model.demand(p, price, ads, o.seEE ?? p.seEE);
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
    key: '', bonus: 0, weights: {}, locks: {},
    house: { price: 8625, ads: 10, minIncome: 80, bankDays: 7 }, advanced: false, fixedWages: 'scorp=0', owner: 'SterlingArcher', watchId: '', lockRoles: ['site manager', 'safety inspector'], minGain: 50, floor: 90, floorRoles: ['mine engineer', 'production foreman', 'electrician', 'secretary'],
    model: { D0: 6848, refPrice: 8625, adA: 0.40, adK: 3.5, elast: -0.8, prodBase: 1980, prodPerMO: 920, otherCosts: 0, warehouseCap: 40000,
             refEE: 115, meLoss: 1600, refSE: 518, seElast: 0.25 },
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
  cfg.house = Object.assign({}, DEF.house, cfg.house || {});
  if (!cfg.v21) { if (!(+cfg.model.warehouseCap > 0)) cfg.model.warehouseCap = 40000; cfg.v21 = true; set('cfg', cfg); }
  // Sales Executive and Secretary earn the money in a mine; support roles must meet requirements; Mill Operator takes the rest.
  const EARN = ['sales executive', 'secretary'];
  const DEF_W = { 'sales executive': 10, 'secretary': 10, 'site manager': 1, 'safety inspector': 1, 'mine engineer': 1, 'electrician': 1, 'production foreman': 1, 'mill operator': 0.1 };
  if (cfg.wv !== 3) { cfg.weights = Object.assign({}, DEF_W); cfg.lockRoles = DEF.lockRoles.slice(); cfg.minGain = DEF.minGain; cfg.wv = 3; set('cfg', cfg); }
  // 2.0.3: a change must add 5+ EE to Sales + Secretary (weighted 50) before it is suggested; smaller gains are within estimate error.
  if (!cfg.mg4) { cfg.minGain = Math.max(+cfg.minGain || 0, 50); cfg.mg4 = true; set('cfg', cfg); }
  const saveCfg = () => set('cfg', cfg);
  let snaps = get('snaps', {});   // reportDay -> { sold, made, price, ads, stock, mo, wages, income, customers }
  let eeHist = get('eeHist', {}); // reportDay -> { name: totalEE }
  let obsSnaps = get('obsSnaps', {}); // reportDay -> public company figures (owner watch mode)

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
  // Fixed bonuses that move with the person: settled-in, merits, education, addiction, inactivity.
  // Management is left out: the Site Manager boosts only underperformers, so it depends on the role.
  const baseOf = e => (e.total && e.tornWS) ? e.total - e.tornWS - (+(e.eff && e.eff.management) || 0) : 0;
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
  let data = null, obs = null, lastErr = '';
  const API = 'https://api.torn.com';
  async function api(path) {
    const r = await fetch(`${API}/${path}${path.includes('?') ? '&' : '?'}key=${encodeURIComponent(cfg.key)}&comment=AMCadvisor`);
    return r.json();
  }
  function friendly(err) {
    const c = err && err.code;
    if (c === 2) return 'Torn says the API key is wrong. Copy it again from Torn: Settings, API Keys.';
    if (c === 16) return 'This key\'s access level is too low. Create a Limited access key (not Public).';
    if (c === 7) return 'This key\'s owner is not the director of a company, so the director view can\'t load.';
    if (c === 5) return 'Too many API calls in the last minute. Wait a minute and press Refresh.';
    if (c === 9) return 'The Torn API is temporarily disabled. Try again later.';
    return `Torn API error ${c}: ${err && err.error}`;
  }
  async function load() {
    if (!cfg.key) { lastErr = ''; tab = 'guide'; render(); return; }
    lastErr = ''; setStatus('Loading…');
    try {
      const j = await api('company/?selections=profile,detailed,employees,stock');
      if (j.error) {
        // Not the director: fall back to the owner's watch mode if a company ID is set.
        if ((j.error.code === 7 || j.error.code === 16) && cfg.watchId) { data = null; await loadWatch(); return; }
        throw new Error(friendly(j.error) + (j.error.code === 7 ? ' To watch a company you don\'t run, set its company ID under Settings, Owner watch mode.' : ''));
      }
      data = parse(j);
      if (!data.hasStats && cfg.watchId) { data = null; await loadWatch(); return; }
      record(data);
      data.boosts = await loadBoosts().catch(() => null);
      setStatus(`Updated ${new Date().toLocaleTimeString()}`);
      if (tab === 'watch') tab = 'brief';
    } catch (e) { lastErr = e.message; setStatus(''); }
    render();
  }

  // The director's own TCP (sales boost) and TGP (advertising boost) blocks. Passive benefits for the company they direct.
  async function loadBoosts() {
    let ts = get('tornStocks', null);
    if (!ts || Date.now() - ts.at > 864e5) {
      const j = await api('torn/?selections=stocks'); if (j.error) return null;
      ts = { at: Date.now(), list: Object.values(j.stocks || {}).map(x => ({ id: String(x.stock_id), acr: x.acronym, req: +(x.benefit && x.benefit.requirement) || 0, desc: x.benefit && x.benefit.description, price: +x.current_price || 0 })) };
      set('tornStocks', ts);
    }
    const u = await api('user/?selections=stocks'); if (u.error) return null;
    const held = u.stocks || {};
    const out = {};
    ['TCP', 'TGP'].forEach(acr => {
      const s = ts.list.find(x => x.acr === acr); if (!s) return;
      const h = Object.values(held).find(x => String(x.stock_id) === s.id);
      const shares = h ? +h.total_shares || 0 : 0;
      const b = h && h.benefit;
      out[acr] = { shares, req: s.req, full: s.req > 0 && shares >= s.req, desc: s.desc, cost: Math.max(0, s.req - shares) * s.price,
        ready: b ? (b.ready === 1 || b.ready === true) : null, progress: b && b.progress != null ? `${b.progress}/${b.frequency || '?'}` : '' };
    });
    return out;
  }

  // ---- Owner watch mode: public company figures any key can read.
  async function loadWatch() {
    try {
      const j = await api(`company/${encodeURIComponent(cfg.watchId)}?selections=profile`);
      if (j.error) throw new Error(friendly(j.error));
      const c = j.company || {};
      const emps = Object.entries(c.employees || {}).map(([id, e]) => ({ id, name: e.name, position: e.position, days: e.days_in_company,
        lastTs: e.last_action ? e.last_action.timestamp : 0, last: e.last_action ? e.last_action.relative : '', status: e.status ? e.status.description || e.status.state || '' : '' }));
      obs = { name: c.name, director: c.director, rating: c.rating, income: c.daily_income, customers: c.daily_customers, weekly: c.weekly_income,
        weeklyCustomers: c.weekly_customers, hired: c.employees_hired, capacity: c.employees_capacity, emps, ts: Math.floor(Date.now() / 1000) };
      const rc = r => emps.filter(e => norm(e.position) === r).length;
      const day = reportDay(obs.ts);
      obsSnaps[day] = { income: obs.income, customers: obs.customers, weekly: obs.weekly, staff: emps.length, cap: obs.capacity,
        se: rc('sales executive'), sec: rc('secretary'), mo: rc('mill operator'), me: rc('mine engineer'), director: obs.director };
      const keep = Object.keys(obsSnaps).sort().slice(-120); obsSnaps = Object.fromEntries(keep.map(k => [k, obsSnaps[k]]));
      set('obsSnaps', obsSnaps);
      tab = 'watch'; lastErr = '';
      setStatus(`Watch mode, updated ${new Date().toLocaleTimeString()}`);
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
      capacity: +prof.employees_capacity || 0, companyId: prof.ID || prof.id,
      funds: det.company_funds, popularity: det.popularity, efficiency: det.efficiency, environment: det.environment,
      ads: (+det.advertising_budget || 0) / 1e6, trains: det.trains_available, emps, inStock, sold, made, price, soldWorth,
      stockKeys: Object.keys(st), hasStats: emps.some(e => e.man || e.int || e.end)
    };
  }
  function record(d) {
    const day = reportDay(d.ts);
    const mo = d.emps.filter(e => norm(e.position) === 'mill operator').length;
    const c = r => d.emps.filter(e => norm(e.position) === r).length;
    const wagesNow = d.emps.reduce((a, e) => a + e.wage, 0);
    // Torn's API reports no "created" figure (always 0). Work it out from the previous day's
    // logged stock: made = stock today - stock yesterday + sold today.
    let made = d.made;
    if (!made) {
      const pd = new Date(Date.parse(day + 'T00:00:00Z') - 864e5).toISOString().slice(0, 10);
      const prev = snaps[pd];
      if (prev && prev.stock != null && d.inStock != null && d.sold != null) {
        const est = d.inStock - prev.stock + d.sold;
        if (est >= 0) made = est;
      }
    }
    snaps[day] = Object.assign({}, snaps[day] || {}, { sold: d.sold, made, price: d.price, ads: d.ads, stock: d.inStock, mo, income: d.income, customers: d.customers,
      se: c('sales executive'), sec: c('secretary'), me: c('mine engineer'), emp: d.emps.length, env: d.environment,
      wages: wagesNow, profit: d.income != null ? d.income - wagesNow - d.ads * 1e6 : undefined, src: 'api' });
    // Pasted Torn records are authoritative for that day's results; keep them.
    const prevSnap = (get('snaps', {}) || {})[day];
    if (prevSnap && /paste/.test(prevSnap.src || '')) {
      ['sold', 'made', 'stock', 'income', 'profit', 'wages'].forEach(k => { if (prevSnap[k] != null) snaps[day][k] = prevSnap[k]; });
      snaps[day].src = 'api+paste';
    }

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
  let tab = cfg.key ? 'brief' : 'guide', status = '';
  function setStatus(s) { status = s; const n = box.querySelector('#amc-status'); if (n) n.textContent = s; }
  btn.addEventListener('click', () => { const open = box.style.display !== 'block'; box.style.display = open ? 'block' : 'none'; if (open && !data) load(); else render(); });

  function render() {
    const tabs = data
      ? (cfg.advanced
        ? [['brief', 'Briefing'], ['alloc', 'Allocation'], ['mix', 'Role mix'], ['trains', 'Trains'], ['health', 'Staff health'], ['setup', 'Setup'], ['guide', 'Guide'], ['settings', 'Settings']]
        : [['brief', 'Today'], ['trains', 'Trains'], ['guide', 'Guide'], ['settings', 'Settings']])
      : [...(obs ? [['watch', 'Owner watch']] : []), ['guide', 'Guide'], ['settings', 'Settings']];
    if (!tabs.some(([k]) => k === tab)) tab = tabs[0][0];
    let h = `<header><h2>Archer Mining Co advisor</h2>${tabs.map(([k, l]) => `<button class="tab ${tab === k ? 'on' : ''}" data-tab="${k}">${l}</button>`).join('')}
      <button class="act" data-act="refresh">Refresh</button><span class="mut" id="amc-status">${esc(status)}</span></header><div class="body">`;
    if (lastErr) h += `<div class="rec w">${esc(lastErr)}</div>`;
    if (tab === 'settings') h += viewSettings();
    else if (tab === 'guide') h += viewGuide();
    else if (tab === 'watch' && obs) h += viewWatch();
    else if (!data) h += `<p class="mut">No data yet. ${cfg.key ? 'Press Refresh.' : 'Start with the <b>Guide</b> tab, then add your Limited key in Settings.'}</p>`;
    else if (tab === 'brief') h += viewBrief();
    else if (tab === 'alloc') h += runwayBanner() + viewAlloc();
    else if (tab === 'mix') h += runwayBanner() + viewMix();
    else if (tab === 'trains') h += viewTrains();
    else if (tab === 'health') h += viewHealth();
    else if (tab === 'setup') h += viewSetup();
    box.innerHTML = h + '</div>';
  }

  // ---- Allocation
  const W = r => cfg.weights[r] === undefined ? 1 : +cfg.weights[r];
  const isLocked = e => !!cfg.locks[e.id] || (cfg.lockRoles || []).includes(norm(e.position));
  function solve(emps, b, counts) {
    const slots = [];
    if (counts) Object.entries(counts).forEach(([r, n]) => { for (let k = 0; k < n; k++) slots.push(r); });
    else emps.forEach(e => { if (REQ[norm(e.position)]) slots.push(norm(e.position)); }); // keep current role counts
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
    const q = setupStats(data.emps.map(e => norm(e.position)));
    const p = Object.assign({}, cfg.model, {
      price: data.price || 8625, ads: data.ads, stock: data.inStock, mo: mo.length,
      moEq: q.moEq, meEE: q.meEE, seEE: q.seEE,
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
      <div class="tile">Sold / made<b>${t(data.sold)} / ${(snaps[reportDay(data.ts)] || {}).made ? t(snaps[reportDay(data.ts)].made) : '?'} t</b><span class="mut">made = stock change + sold, from yesterday\'s logged stock</span></div>
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

  // ---- Shared: EE totals for a given assignment (array of role per employee, same order as data.emps)
  function curB() { return cfg.bonus > 0 ? cfg.bonus : fitBonus(data.emps).b; }
  function setupStats(asg) {
    const b = curB(), m = cfg.model;
    let seEE = 0, seN = 0, moEE = 0, moN = 0, meEE = null;
    data.emps.forEach((e, i) => {
      const r = asg[i]; if (!r) return;
      // Current role: use Torn's own total minus the management boost; other roles: the estimate.
      const v = r === norm(e.position) && e.total ? e.total - (+(e.eff && e.eff.management) || 0) : (tot(e, r, b) || 0);
      if (r === 'sales executive') { seEE += v; seN++; }
      else if (r === 'mill operator') { moEE += v; moN++; }
      else if (r === 'mine engineer') meEE = v;
    });
    return { seEE, seN, moEE, moN, moEq: moEE / (m.refEE || 115), meEE: meEE == null ? 0 : meEE };
  }

  // ---- Stock runway (recent logged days first, else the model)
  function runway() {
    // Prefer days since the last setup change (2+ of them), so a new setup's drain isn't hidden by the old one.
    let days = Object.keys(snaps).sort().slice(-4).map(d => snaps[d]).filter(s => s && s.sold > 0 && s.made > 0);
    try {
      const per = periods(), cur = per[per.length - 1];
      const curDays = cur ? cur.days.filter(s => s.sold > 0 && s.made > 0).slice(-4) : [];
      if (curDays.length >= 2) days = curDays;
    } catch (e) { /* keep last 4 */ }
    // Opened every other day: "made" needs yesterday's log, so fall back to the stock change between logged days.
    const dayMs = d => Date.parse(d + 'T00:00:00Z');
    const stockDays = Object.keys(snaps).sort().filter(d => snaps[d] && snaps[d].stock != null && dayMs(d) >= Date.now() - 12 * 864e5);
    let net, src;
    if (days.length >= 2) { net = days.reduce((a, s) => a + s.made - s.sold, 0) / days.length; src = `last ${days.length} logged days on this setup`; }
    else if (stockDays.length >= 2) {
      const a = stockDays[0], z = stockDays[stockDays.length - 1], span = (dayMs(z) - dayMs(a)) / 864e5;
      net = (snaps[z].stock - snaps[a].stock) / span; src = `stock change ${a} to ${z}`;
    }
    else { const p = modelParams(), d = Model.day(p, {}); net = d.prod - d.dem; src = 'model estimate'; }
    const stock = data.inStock || 0, cap = +cfg.model.warehouseCap || 0;
    let msg, warn = false;
    if (net < -1) { const n = stock / -net; msg = `Stock ${t(stock)} t, falling about ${t(-net)} t/day: runs out in about <b>${n.toFixed(1)} days</b>.`; warn = n < 7; }
    else if (net > 1 && cap) { const n = Math.max(0, cap - stock) / net; msg = `Stock ${t(stock)} t, rising about ${t(net)} t/day: hits the ${t(cap)} t cap in about <b>${n.toFixed(1)} days</b>.`; warn = n < 7; }
    else msg = `Stock ${t(stock)} t, roughly steady.`;
    return { net, msg: msg + ` <span class="mut">(${src})</span>`, warn };
  }
  function runwayBanner() { const r = runway(); return `<div class="rec ${r.warn ? 'w' : ''}">${r.msg}</div>`; }

  // ---- Role mix planner: how many Sales Executives vs Mill Operators
  function viewMix() {
    if (!data.hasStats) return `<div class="rec w">No working stats from the API, so the planner cannot run.</div>`;
    const b = curB(), p = modelParams(), n = data.emps.length;
    const cnt = r => data.emps.filter(e => norm(e.position) === r).length;
    const fixed = { 'site manager': 1, 'safety inspector': 1, 'production foreman': 1, 'electrician': 1, 'mine engineer': 1, 'secretary': Math.max(2, cnt('secretary')) };
    const fixedN = Object.values(fixed).reduce((a, x) => a + x, 0);
    const rows = [];
    for (let se = 3; se <= 6; se++) {
      const mo = n - fixedN - se; if (mo < 1) continue;
      const counts = Object.assign({}, fixed, { 'sales executive': se, 'mill operator': mo });
      const asg = solve(data.emps, b, counts), q = setupStats(asg);
      const d = Model.day(p, { moEq: q.moEq, meEE: q.meEE, seEE: q.seEE, mo });
      const moves = data.emps.map((e, i) => ({ e, from: norm(e.position), to: asg[i] })).filter(m => m.to && m.to !== m.from);
      rows.push({ se, mo, q, d, moves });
    }
    const nowQ = setupStats(data.emps.map(e => norm(e.position)));
    const now = Model.day(p, { moEq: nowQ.moEq, meEE: nowQ.meEE, seEE: nowQ.seEE });
    // Steady-state income: once stock is gone you sell the smaller of made and demand.
    const rev = d => Math.min(d.dem, d.prod) * d.price;
    rows.unshift({ se: cnt('sales executive'), mo: cnt('mill operator'), q: nowQ, d: now, moves: [], isNow: true });
    const best = rows.reduce((a, r) => (rev(r.d) > rev(a.d) + 5e5 ? r : a), rows[0]); // must beat now by $0.5m/day
    let h = `<div class="tiles"><div class="tile">Now<b>${cnt('sales executive')} SE / ${cnt('mill operator')} MO</b><span class="mut">${cnt('mine engineer') ? 'Mine Engineer filled' : '<span class="wrn">no Mine Engineer</span>'}</span></div>
      <div class="tile">Made / demand now<b>${t(now.prod)} / ${t(now.dem)} t</b><span class="mut">${now.prod >= now.dem ? 'production covers sales' : 'production short: stock falls'}</span></div>
      <div class="tile">Best steady mix<b>${best.isNow ? 'Keep as now' : best.se + ' SE / ' + best.mo + ' MO'}</b><span class="mut">${best.isNow ? 'no mix beats it by $0.5m/day' : d$(rev(best.d) - rev(now)) + '/day vs now'}</span></div></div>
      <div class="rec">Each row re-runs the allocation with that many Sales Executives, 1 of each support role (including a Mine Engineer) and ${fixed.secretary} Secretaries, then estimates tonnes made and sold. While you have stock you sell up to demand, so "income while stock lasts" is what a mix earns now; "steady" assumes stock is gone and you sell the smaller of made and demand. A mix that earns more now but runs stock down is worth it until stock gets low, then switch back.</div>
      <div class="sc"><table><tr><th>SE</th><th>MO</th><th>SE EE</th><th>MO EE</th><th>Made t</th><th>Demand t</th><th>Income while stock lasts</th><th>vs now</th><th>Steady income</th><th>vs now</th><th class="l">Stock</th></tr>` +
      rows.map(r => {
        const gap = r.d.prod - r.d.dem, stock = data.inStock || 0;
        const st = gap < -1 ? `${(stock / -gap).toFixed(1)} days to empty` : gap > 1 && cfg.model.warehouseCap ? `${(Math.max(0, cfg.model.warehouseCap - stock) / gap).toFixed(1)} days to cap` : 'steady';
        const isNow = !!r.isNow;
        return `<tr class="${isNow ? 'cur' : ''}"><td>${r.se}${isNow ? ' (as now)' : ' (reshuffled)'}</td><td>${r.mo}</td><td>${t(r.q.seEE)}</td><td>${t(r.q.moEE)}</td><td>${t(r.d.prod)}</td><td>${t(r.d.dem)}</td><td>${m$(r.d.dem * r.d.price)}</td><td class="${r.d.dem >= now.dem ? 'pos' : 'neg'}">${d$((r.d.dem - now.dem) * r.d.price)}</td><td>${m$(rev(r.d))}</td><td class="${rev(r.d) >= rev(now) ? 'pos' : 'neg'}">${d$(rev(r.d) - rev(now))}</td><td class="l ${gap < -1 ? 'wrn' : ''}">${st}</td></tr>`;
      }).join('') + `</table></div>`;
    rows.forEach(r => {
      if (!r.moves.length) return;
      h += `<details><summary class="mut" style="cursor:pointer">Moves for ${r.se} SE / ${r.mo} MO (${r.moves.length})</summary><ul>${r.moves.map(m =>
        `<li>${esc(m.e.name)}: ${ROLE_NAMES[m.from] || esc(m.from)} → <b>${ROLE_NAMES[m.to]}</b> (${tot(m.e, m.to, b)} EE)</li>`).join('')}</ul></details>`;
    });
    h += `<p class="mut">Demand uses Sales Executive EE with elasticity ${cfg.model.seElast} (from the 11-13 Nov test) and production uses Mill Operator EE (${cfg.model.prodPerMO} t per ${cfg.model.refEE} EE) with up to ${t(cfg.model.meLoss)} t lost without a full-strength Mine Engineer. All are estimates: change one or two people at a time and check the next day's figures. Tune in Settings.</p>`;
    return h;
  }

  // ---- Train planner: each train gives +50 to the role's primary stat and +25 to the secondary.
  function viewTrains() {
    if (!data.hasStats) return `<div class="rec w">No working stats from the API, so the planner cannot run.</div>`;
    const b = curB(), avail = +data.trains || 0;
    const raw = (stat, req) => { if (!(stat > 0)) return 0; const x = stat * b / req; return Math.min(45, 45 * x) + Math.max(0, 5 * Math.log2(x)); };
    const people = data.emps.map(e => {
      const r = REQ[norm(e.position)]; if (!r) return null;
      return { e, r, role: norm(e.position), add: 0, w: 1 };
    }).filter(Boolean);
    const val = (x, k) => raw(x.e[x.r.p[0]] + 50 * k, x.r.p[1]) + raw(x.e[x.r.s[0]] + 25 * k, x.r.s[1]);
    const plan = Math.max(avail, 20);
    for (let k = 0; k < plan; k++) {
      let best = null, bg = -1;
      people.forEach(x => { const g = (val(x, x.add + 1) - val(x, x.add)) * x.w; if (g > bg) { bg = g; best = x; } });
      if (!best) break; best.add++;
    }
    const used = people.filter(x => x.add > 0).sort((a, b2) => b2.add - a.add);
    let h = `<div class="tiles"><div class="tile">Trains available<b>${data.trains == null ? '?' : t(avail)}</b><span class="mut">max 20 stored; extra is wasted</span></div>
      <div class="tile">Plan below<b>${plan} trains</b><span class="mut">${avail >= 20 ? '<span class="wrn">at the cap: use some today</span>' : 'shown for a full 20'}</span></div></div>
      <div class="rec">Trains go to whoever gains the most EE per train. Staff still below their role's stat requirement gain about 10 times more than staff above it, so new or weak hires usually come first. Each train: +50 primary, +25 secondary stat for their current role. Train after any role changes, since a move changes which stats the train raises.</div>
      <div class="sc"><table><tr><th class="l">Employee</th><th class="l">Role</th><th>Trains</th><th>Stats EE now</th><th>After</th><th>Gain</th><th class="l">Main stat vs requirement</th></tr>` +
      used.map(x => {
        const before = wsEE(x.e, x.role, b);
        const after = statEE(x.e[x.r.p[0]] + 50 * x.add, x.r.p[1], b) + statEE(x.e[x.r.s[0]] + 25 * x.add, x.r.s[1], b);
        const pct = Math.round(x.e[x.r.p[0]] * b / x.r.p[1] * 100);
        return `<tr><td class="l">${esc(x.e.name)}</td><td class="l">${ROLE_NAMES[x.role]}</td><td><b>${x.add}</b></td><td>${before}</td><td>${after}</td><td class="pos">${sg(after - before)}</td><td class="l ${pct < 100 ? 'wrn' : 'mut'}">${pct}%</td></tr>`;
      }).join('') + `</table></div>
      <p class="mut">EE shown is the working-stats part only (whole numbers, so a single train may show +0 until it tips over). If nobody is below requirement, gains are small: above the requirement each doubling of a stat adds only 5 EE.</p>`;
    return h;
  }

  // ---- Daily briefing
  const setupKey = s => s.se == null ? '' : `${s.se} SE · ${s.sec ?? '?'} Sec · ${s.mo} MO · ${s.me ? 'ME' : 'no ME'}${s.emp != null ? ' · ' + s.emp + ' staff' : ''}${s.ads != null ? ' · $' + s.ads + 'm ads' : ''} · $${t(s.price)}`;
  function loggedDays() {
    const rows = Object.keys(snaps).sort().map(d => Object.assign({ day: d }, snaps[d])).filter(s => s.sold > 0);
    // Stock-record pastes have no ad budget: fill from the nearest day that has one (earlier first, then later).
    let last = null; rows.forEach(r => { if (r.ads != null) last = r.ads; else if (last != null) r.ads = last; });
    let next = null; for (let i = rows.length - 1; i >= 0; i--) { if (rows[i].ads != null) next = rows[i].ads; else if (next != null) rows[i].ads = next; }
    return rows;
  }
  // Group consecutive days with the same setup, ads and price.
  function periods() {
    const out = [];
    loggedDays().forEach(s => {
      const k = setupKey(s), last = out[out.length - 1];
      if (last && last.key === k) last.days.push(s); else out.push({ key: k, days: [s] });
    });
    out.forEach(p => {
      const n = p.days.length, avg = f => { const v = p.days.map(f).filter(x => x != null && !isNaN(x)); return v.length ? v.reduce((a, x) => a + x, 0) / v.length : null; };
      const span = Math.round((Date.parse(p.days[n - 1].day + 'T00:00:00Z') - Date.parse(p.days[0].day + 'T00:00:00Z')) / 864e5) + 1;
      Object.assign(p, { n, span, from: p.days[0].day, to: p.days[n - 1].day, sold: avg(d => d.sold), made: avg(d => d.made || null),
        profit: avg(d => d.profit), income: avg(d => d.income), first: p.days[0] });
    });
    return out;
  }
  function verdictOf(prev, cur) {
    if (!prev || !cur || !cur.key) return null;
    if (cur.span < 3) return { wait: 3 - cur.span };
    const sd = 360, se = sd * Math.sqrt(1 / cur.n + 1 / Math.max(1, prev.n));
    const dSold = cur.sold - prev.sold, dProfit = cur.profit != null && prev.profit != null ? cur.profit - prev.profit : null;
    const call = Math.abs(dSold) < 1.5 * se ? 'too close to call' : dSold > 0 ? 'sales up' : 'sales down';
    return { dSold, dProfit, call, se };
  }
  function recommend(per, rw) {
    const b = curB(), cnt = r => data.emps.filter(e => norm(e.position) === r).length;
    const se = cnt('sales executive'), me = cnt('mine engineer');
    const cur = per[per.length - 1];
    const stock = data.inStock || 0, cap = +cfg.model.warehouseCap || 0;
    const daysEmpty = rw.net < -1 ? stock / -rw.net : Infinity, daysCap = rw.net > 1 && cap ? Math.max(0, cap - stock) / rw.net : Infinity;
    const mos = data.emps.filter(e => norm(e.position) === 'mill operator' && !isLocked(e));
    const ses = data.emps.filter(e => norm(e.position) === 'sales executive' && !isLocked(e));
    const curEE = e => e.total ? e.total - (+(e.eff && e.eff.management) || 0) : (tot(e, norm(e.position), b) || 0);
    const warnDays = +cfg.warnDays || 14; // opened every other day, so act with a buffer
    if (daysEmpty < warnDays && cur && cur.span < 2 && daysEmpty >= 5) {
      return { level: 'w', text: `Stock runs out in about ${daysEmpty.toFixed(1)} days, but the setup changed on ${cur.from}. <b>Hold</b> and recheck in ${2 - cur.span} day(s): the runway still reflects the old setup. Act sooner only if stock drops under 5 days.` };
    }
    if (daysEmpty < warnDays) {
      if (!me) {
        // With 5+ Sales Executives, fill the Mine Engineer from the weakest seller: the role uses the same stats (intelligence, endurance),
        // keeps every Mill Operator in place and brings sales and production close to balance in one move.
        const seC = se >= 5 ? ses.map(e => ({ e, seEE: curEE(e), est: tot(e, 'sales executive', b) || 0, v: tot(e, 'mine engineer', b) || 0 })).filter(x => x.v >= 120 || x.v >= x.est - 5).sort((x, y) => x.seEE - y.seEE)[0] : null;
        if (seC) return { level: 'w', text: `Stock runs out in about ${daysEmpty.toFixed(1)} days and the Mine Engineer is empty. <b>Move ${esc(seC.e.name)} from Sales Executive to Mine Engineer</b> (${seC.seEE} EE as SE; Mine Engineer uses the same stats, so about the same there). That keeps all your Mill Operators and brings sales and production close to balance.` };
        const c = mos.map(e => ({ e, v: tot(e, 'mine engineer', b) || 0 })).sort((x, y) => y.v - x.v)[0];
        return { level: 'w', text: `Stock runs out in about ${daysEmpty.toFixed(1)} days and the Mine Engineer is empty. <b>Move ${c ? esc(c.e.name) : 'your best Mill Operator'} to Mine Engineer</b>${c ? ` (${c.v} EE)` : ''}: worth roughly 1 to 2 Mill Operators of output.` };
      }
      const c = ses.map(e => ({ e, gain: (tot(e, 'mill operator', b) || 0), lose: curEE(e) })).sort((x, y) => x.lose - y.lose)[0];
      return { level: 'w', text: `Stock runs out in about ${daysEmpty.toFixed(1)} days. Production is short: <b>${c ? 'move ' + esc(c.e.name) + ' (weakest Sales Executive, ' + c.lose + ' EE) to Mill Operator' : 'add a Mill Operator'}</b>, or hire a stronger Mill Operator to replace your weakest${isFinite(rw.net) && rw.net < -1 && data.price ? ` (only if their wage is well under about ${m$(-rw.net * data.price)}/day more, the income lost once stock runs out)` : ''}. Recheck in 2 days.` };
    }
    if (cur && cur.span < 3) return { level: '', text: `Your setup changed on ${cur.from}. <b>Hold</b> for ${3 - cur.span} more day(s) so the change can be judged.` };
    if ((daysEmpty > 25 || daysCap < 20) && se < 6) {
      const c = mos.map(e => ({ e, seEE: tot(e, 'sales executive', b) || 0, moEE: curEE(e) })).filter(x => x.seEE >= 110)
        .sort((x, y) => (y.seEE - y.moEE) - (x.seEE - x.moEE))[0];
      if (c) {
        const p = modelParams(), now = Model.day(p, {});
        const after = Model.day(p, { seEE: (p.seEE || 0) + c.seEE, moEq: Math.max(0, p.moEq - c.moEE / (cfg.model.refEE || 115)) });
        const net = after.prod - after.dem;
        return { level: '', text: `Stock ${t(stock)} t with ${isFinite(daysEmpty) ? daysEmpty.toFixed(0) + ' days to empty' : 'no shortage'}${isFinite(daysCap) ? ', ' + daysCap.toFixed(0) + ' days to the cap' : ''}: room to sell more. <b>Move ${esc(c.e.name)} from Mill Operator to Sales Executive</b> (${c.moEE} EE as MO, ${c.seEE} as SE). Model: demand ${sg(after.dem - now.dem)} t/day, about ${d$((after.dem - now.dem) * p.price)}/day while stock lasts; stock then ${net < -1 ? 'falls about ' + t(-net) + ' t/day (' + (stock / -net).toFixed(0) + ' days)' : 'holds'}.` };
      }
    }
    return { level: '', text: `<b>Hold.</b> Stock ${t(stock)} t, ${rw.net < -1 ? 'falling ' + t(-rw.net) : rw.net > 1 ? 'rising ' + t(rw.net) : 'steady at'} t/day. No change clears the rules (add a Sales Executive when 25+ days of stock; cut one when under 14).` };
  }
  function costCheck() {
    const days = loggedDays().filter(s => s.income != null && s.profit != null);
    const out = [];
    if (days.length >= 2) {
      const a = days[days.length - 2], z = days[days.length - 1];
      const ca = a.income - a.profit, cz = z.income - z.profit;
      if (Math.abs(cz - ca) >= 2e6) out.push(`Daily costs ${cz > ca ? 'up' : 'down'} ${m$(Math.abs(cz - ca))} (${m$(ca)} on ${a.day} to ${m$(cz)} on ${z.day}).`);
    }
    const mult = +cfg.wageMult || 20;
    const over = data.emps.map(e => ({ e, f: mult * Math.max(e.man, e.int, e.end), w: e.wage })).filter(x => x.f > 0 && x.w - x.f >= 250000).sort((x, y) => (y.w - y.f) - (x.w - x.f));
    return { notes: out, over, mult };
  }
  function viewBrief() { return cfg.advanced ? viewBriefFull() : viewToday(); }
  // Simple mode: one instruction, problems only, the owner summary, trains.
  function viewToday() {
    const per = periods(), rw = runway(), rec = recommend(per, rw);
    const stock = data.inStock || 0, last = loggedDays().slice(-1)[0];
    const bad = houseChecks().filter(c => !c.ok);
    const trains = +data.trains || 0;
    const runTxt = rw.net < -1 ? `about <b>${(stock / -rw.net).toFixed(0)} days</b> left` : rw.net > 1 ? 'rising' : 'steady';
    let h = `<div class="tiles">
      <div class="tile">Stock<b>${t(stock)} t</b><span class="mut">${runTxt}</span></div>
      <div class="tile">Yesterday<b>${last && last.income != null ? m$(last.income) : '?'}</b><span class="mut">income${last && last.profit != null ? ', profit ' + m$(last.profit) : ''}</span></div>
      <div class="tile">Trains waiting<b>${data.trains == null ? '?' : t(trains)}</b><span class="mut">${trains >= 15 ? '<span class="wrn">use some today (max 20)</span>' : 'see the Trains tab'}</span></div></div>
      <h3>1. What to do today</h3><div class="rec ${rec.level}" style="font-size:14px">${rec.text}</div>
      <h3>2. Problems to fix</h3>${bad.length ? bad.map(c => `<div class="rec w">⚠ ${c.text}</div>`).join('') : '<div class="rec">✔ All house rules met. Nothing to fix.</div>'}
      ${reportDue()
        ? `<h3>3. Weekly report to ${esc(cfg.owner || 'the owner')} (due)</h3><div class="rec w">Copy the weekly summary and paste it into a Torn mail to ${esc(cfg.owner || 'the owner')}.</div>
           <p><button class="act" data-act="summary">Copy weekly summary</button> <span class="mut" id="amc-sum-msg"></span></p>`
        : `<p class="mut" style="margin-top:10px">Weekly report to ${esc(cfg.owner || 'the owner')}: next due ${nextReportText()}. <button class="act" data-act="summary">Copy now</button> <span id="amc-sum-msg"></span></p>`}
      <textarea id="amc-sum" rows="1" readonly style="position:absolute;left:-9999px"></textarea>
      ${trains >= 15 ? `<h3>Trains</h3><div class="rec w">${t(trains)} company trains waiting. Open the <b>Trains</b> tab and give them to the people listed; trains over 20 are lost.</div>` : ''}
      <details style="margin-top:14px"><summary class="mut" style="cursor:pointer">Fill in history (first day only)</summary>
      <p class="mut">Copy the <b>Stock records</b> and <b>Company records</b> tables from the company page (from the Date header to the last row), paste below and press Import. This lets the advisor judge changes from day one.</p>
      <textarea id="amc-import" rows="4" style="width:100%;background:#141917;color:#e6ebe8;border:1px solid #2f3835;border-radius:4px;font:12px monospace" placeholder="Paste Stock records and/or Company records here"></textarea>
      <p><button class="act" data-act="import">Import</button> <span class="mut" id="amc-import-msg"></span></p></details>
      <p class="mut" style="margin-top:12px">Open this once a day (or every other day) after 18:10 TCT. Make one change at a time; the advisor waits a few days to judge each one. More tools: Settings → Show advanced tools.</p>`;
    return h;
  }
  function viewBriefFull() {
    const per = periods(), rw = runway(), cc = costCheck();
    const cur = per[per.length - 1], prev = per[per.length - 2], v = verdictOf(prev, cur), rec = recommend(per, rw);
    const last = loggedDays().slice(-1)[0];
    let h = `<div class="tiles">
      <div class="tile">Last logged day<b>${last ? esc(last.day) : 'none yet'}</b><span class="mut">${last ? t(last.sold) + ' sold / ' + (last.made ? t(last.made) : '?') + ' made' : 'open the panel after 18:10 TCT each day'}</span></div>
      <div class="tile">Stock<b>${t(data.inStock)} t</b><span class="mut">${rw.net < -1 ? 'falling ' + t(-rw.net) + ' t/day' : rw.net > 1 ? 'rising ' + t(rw.net) + ' t/day' : 'steady'}</span></div>
      <div class="tile">Profit last day<b>${last && last.profit != null ? m$(last.profit) : '?'}</b><span class="mut">income ${last && last.income != null ? m$(last.income) : '?'}</span></div></div>
      <h3>Next move</h3><div class="rec ${rec.level}">${rec.text}</div>
      <h3>House rule checks</h3>${houseChecks().map(c => `<div class="rec ${c.ok ? '' : 'w'}">${c.ok ? '✔ ' : '⚠ '}${c.text}</div>`).join('')}
      <p><button class="act" data-act="summary">Copy summary for ${esc(cfg.owner || 'the owner')}</button> <span class="mut" id="amc-sum-msg">Weekly: paste it into a Torn mail to ${esc(cfg.owner || 'the owner')} each Sunday.</span></p>
      <textarea id="amc-sum" rows="1" readonly style="position:absolute;left:-9999px"></textarea>`;
    if (cur && prev) {
      h += `<h3>Last change</h3>`;
      if (v && v.wait) h += `<div class="rec">Changed to <b>${esc(cur.key)}</b> on ${esc(cur.from)}. Needs ${v.wait} more day(s) before it can be judged.</div>`;
      else if (v) h += `<div class="rec ${v.call === 'sales down' ? 'w' : ''}"><b>${esc(cur.key)}</b> vs before (<span class="mut">${esc(prev.key)}</span>): sold ${sg(v.dSold)} t/day${v.dProfit != null ? ', profit ' + d$(v.dProfit) + '/day' : ''}. Verdict: <b>${v.call}</b> <span class="mut">(normal day-to-day swing about ±${t(v.se * 1.5)} t)</span>.</div>`;
    }
    if (cc.notes.length || cc.over.length) {
      h += `<h3>Costs</h3>${cc.notes.map(n => `<div class="rec w">${esc(n)}</div>`).join('')}`;
      if (cc.over.length) h += `<p class="mut">Paid more than ${cc.mult}× their highest working stat:</p><div class="sc"><table><tr><th class="l">Employee</th><th class="l">Role</th><th>Wage</th><th>${cc.mult}× formula</th><th>Over by</th></tr>${cc.over.map(x =>
        `<tr><td class="l">${esc(x.e.name)}</td><td class="l">${esc(x.e.position)}</td><td>${m$(x.w)}</td><td>${m$(x.f)}</td><td class="neg">${m$(x.w - x.f)}</td></tr>`).join('')}</table></div>`;
    }
    h += `<h3>Results by setup</h3><div class="sc"><table><tr><th class="l">Setup</th><th class="l">Dates</th><th>Days</th><th>Avg sold</th><th>Avg made</th><th>Avg profit</th></tr>` +
      per.slice(-8).reverse().map(p => `<tr class="${p === cur ? 'cur' : ''}"><td class="l">${p.key ? esc(p.key) : '<span class="mut">setup unknown</span>'}</td><td class="l">${esc(p.from)}${p.to !== p.from ? ' to ' + esc(p.to) : ''}</td><td>${p.n}</td><td>${t(p.sold)}</td><td>${p.made ? t(p.made) : ''}</td><td>${p.profit != null ? m$(p.profit) : ''}</td></tr>`).join('') + `</table></div>
      <h3>Fill in history</h3><p class="mut">The briefing logs a day each time you open the panel after the 18:10 TCT update. To fill gaps, copy the <b>Stock records</b> and <b>Company records</b> tables from your company page (select from the Date header to the last row), paste below and press Import. Pasting the same days again just updates them.</p>
      <textarea id="amc-import" rows="5" style="width:100%;background:#141917;color:#e6ebe8;border:1px solid #2f3835;border-radius:4px;font:12px monospace" placeholder="Paste Stock records and/or Company records here"></textarea>
      <p><button class="act" data-act="import">Import</button> <span class="mut" id="amc-import-msg"></span></p>
      <p class="mut">Rules: add a Sales Executive when stock covers 25+ days or the cap is under 20 days away; move one back when stock runs out within 14 days; otherwise hold, and judge each change after 3 logged days. The advisor suggests; you make the change in Torn.</p>`;
    return h;
  }

  // Parse pasted Torn "Stock records" / "Company records" tables.
  function importRecords(text) {
    const num = v => { const m = String(v || '').replace(/,/g, '').match(/[-+]?\d+(\.\d+)?/); return m ? +m[0] : null; };
    const stockRows = [], compRows = [];
    String(text).split(/\r?\n/).forEach(line => {
      const m = line.match(/^\s*(\d{4})\/(\d{2})\/(\d{2})/); if (!m) return;
      const day = `${m[1]}-${m[2]}-${m[3]}`;
      const cells = line.includes('\t') ? line.split('\t').map(x => x.trim()) : line.trim().split(/\s{2,}/);
      if (/salt|\(ton\)/i.test(line) && cells.length >= 11) {
        stockRows.push({ day, emp: num(cells[2]), pos: cells[3], price: num(cells[6]), sold: num(cells[7]), stock: num(cells[9]), made: num(cells[10]) });
      } else if (cells.length >= 10 && /^\$/.test(cells[2])) {
        compRows.push({ day, emp: num(cells[1]), ads: num(cells[2]) / 1e6, env: num(cells[5]), customers: num(cells[7]), income: num(cells[8]), profit: num(cells[9]) });
      }
    });
    // Rebuild full role counts: full listings set them, "+1/-1" rows change them.
    stockRows.sort((a, b) => a.day < b.day ? -1 : 1);
    let counts = null;
    const map = { SE: 'se', Se: 'sec', MO: 'mo', ME: 'me', PF: 'pf', El: 'el', SM: 'sm', SI: 'si' };
    stockRows.forEach(r => {
      const toks = [...String(r.pos).matchAll(/\b(SE|Se|MO|ME|PF|El|SM|SI|TOT|Un)\s*:\s*([+-]?\d+)/g)];
      const isDelta = toks.some(x => /^[+-]/.test(x[2]));
      if (!isDelta && toks.length) { counts = { se: 0, sec: 0, mo: 0, me: 0, pf: 0, el: 0, sm: 0, si: 0 }; toks.forEach(([, k, v]) => { if (map[k]) counts[map[k]] = +v; }); }
      else if (counts) toks.forEach(([, k, v]) => { if (map[k]) counts[map[k]] += +v; });
      const o = { sold: r.sold, made: r.made, stock: r.stock, price: r.price, emp: r.emp };
      if (counts) Object.assign(o, { se: counts.se, sec: counts.sec, mo: counts.mo, me: counts.me });
      snaps[r.day] = Object.assign({}, snaps[r.day] || {}, o, { src: (snaps[r.day] && snaps[r.day].src === 'api') ? 'api+paste' : 'paste' });
    });
    compRows.forEach(r => {
      snaps[r.day] = Object.assign({}, snaps[r.day] || {}, { ads: r.ads, env: r.env, customers: r.customers, income: r.income, profit: r.profit, emp: r.emp,
        wages: r.income != null && r.profit != null ? r.income - r.profit - r.ads * 1e6 : undefined });
    });
    const keep = Object.keys(snaps).sort().slice(-120); snaps = Object.fromEntries(keep.map(k => [k, snaps[k]]));
    set('snaps', snaps);
    return { stock: stockRows.length, comp: compRows.length, setups: stockRows.filter(r => snaps[r.day].se != null).length };
  }

  // ---- House rule checks (shown in the Briefing and the owner summary)
  function parseFixedWages() {
    return String(cfg.fixedWages || '').split(/[\n,;]+/).map(x => x.trim()).filter(Boolean).map(x => {
      const m = x.match(/^(.+?)\s*=\s*\$?([\d.,]+)\s*(m|k)?$/i); if (!m) return null;
      let v = parseFloat(m[2].replace(/,/g, '')); if (/m/i.test(m[3] || '')) v *= 1e6; else if (/k/i.test(m[3] || '')) v *= 1e3;
      return { name: m[1].trim(), wage: v };
    }).filter(Boolean);
  }
  function houseChecks() {
    const hr = cfg.house, out = [];
    const cnt = r => data.emps.filter(e => norm(e.position) === r).length;
    if (data.price && Math.round(data.price) !== Math.round(hr.price)) out.push({ ok: false, text: `Price is $${t(data.price)}; house price is $${t(hr.price)}. Change it back unless you are running an agreed test.` });
    else out.push({ ok: true, text: `Price $${t(data.price)} (house price).` });
    if (Math.abs(data.ads - hr.ads) > 0.01) out.push({ ok: false, text: `Ad budget is $${data.ads}m; house budget is $${hr.ads}m. More than this was measured to lose money; less loses sales.` });
    else out.push({ ok: true, text: `Ads $${data.ads}m a day (house budget).` });
    if (!cnt('mine engineer')) {
      // Leaving the Mine Engineer empty is part of the normal cycle while stock is healthy; it is only a problem when stock is running out.
      let daysLeft = Infinity; try { const rw = runway(); if (rw.net < -1) daysLeft = (data.inStock || 0) / -rw.net; } catch (e) { /* ignore */ }
      const warnDays = +cfg.warnDays || 14;
      out.push(daysLeft < warnDays
        ? { ok: false, text: `No Mine Engineer, and stock runs out in about ${daysLeft.toFixed(0)} days. An empty Mine Engineer costs up to ${t(cfg.model.meLoss)} t a day; follow "What to do today".` }
        : { ok: true, text: `Mine Engineer empty on purpose: stock is healthy, so that slot is selling instead.` });
    }
    if (data.capacity && data.emps.length < data.capacity) out.push({ ok: false, text: `${data.emps.length} of ${data.capacity} staff. Hire to fill the empty slot${data.capacity - data.emps.length > 1 ? 's' : ''}.` });
    const wagesDay = data.emps.reduce((a, e) => a + e.wage, 0), costs = wagesDay + data.ads * 1e6, floor = costs * (+hr.bankDays || 7);
    if (data.funds != null) out.push(data.funds < floor
      ? { ok: false, text: `Company bank ${m$(data.funds)} is below the ${hr.bankDays}-day floor of ${m$(floor)} (wages ${m$(wagesDay)} + ads ${m$(data.ads * 1e6)} a day). Don't withdraw until it recovers.` }
      : { ok: true, text: `Company bank ${m$(data.funds)}, above the ${hr.bankDays}-day floor of ${m$(floor)}. ${m$(data.funds - floor)} could be withdrawn.` });
    parseFixedWages().forEach(f => {
      const e = data.emps.find(x => norm(x.name) === norm(f.name));
      if (e && Math.abs(e.wage - f.wage) > 1) out.push({ ok: false, text: `${esc(e.name)}'s wage is ${m$(e.wage)}; the agreed wage is ${m$(f.wage)}. Set it back (see the Guide).` });
      else if (e) out.push({ ok: true, text: `${esc(e.name)}'s wage is at the agreed ${m$(f.wage)}.` });
    });
    const b = data.boosts;
    if (b) ['TCP', 'TGP'].forEach(acr => {
      const x = b[acr]; if (!x) return;
      const what = acr === 'TCP' ? 'company sales boost' : 'company advertising boost';
      if (!x.full) out.push({ ok: false, text: `You hold ${t(x.shares)} of the ${t(x.req)} ${acr} shares needed for the ${what}. The company runs without it until you hold a full block${x.cost ? ' (about ' + m$(x.cost) + ' more)' : ''}.` });
      else out.push({ ok: x.ready !== false, text: `${acr} block held (${what})${x.ready === false ? ', not active yet' + (x.progress ? ' (' + x.progress + ')' : '') : ''}.` });
    });
    else out.push({ ok: true, text: '<span class="mut">TCP/TGP boosts could not be read with this key (needs a Limited key).</span>' });
    return out;
  }
  // Weekly owner report: due on Sunday (TCT) or once 7+ days have passed since the last copy.
  function reportDue() {
    const lastAt = +get('lastReport', 0) || 0;
    if (!lastAt) return new Date().getUTCDay() === 0;
    if (Date.now() - lastAt >= 7 * 864e5 - 6 * 36e5) return true;
    return new Date().getUTCDay() === 0 && new Date(lastAt).toISOString().slice(0, 10) !== new Date().toISOString().slice(0, 10) && Date.now() - lastAt > 2 * 864e5;
  }
  function nextReportText() {
    const d = new Date(); d.setUTCDate(d.getUTCDate() + ((7 - d.getUTCDay()) % 7 || 7));
    return 'Sunday ' + d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  }
  function summaryText() {
    const per = periods(), rw = runway(), rec = recommend(per, rw), last = loggedDays().slice(-1)[0], cur = per[per.length - 1], prev = per[per.length - 2], v = verdictOf(prev, cur);
    const plain = h => String(h).replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
    const stock = data.inStock || 0;
    const runTxt = rw.net < -1 ? `falling ${t(-rw.net)} t/day, about ${(stock / -rw.net).toFixed(0)} days left` : rw.net > 1 ? `rising ${t(rw.net)} t/day` : 'steady';
    const issues = houseChecks().filter(c => !c.ok).map(c => '- ' + plain(c.text));
    const wk = loggedDays().filter(d => Date.parse(d.day + 'T00:00:00Z') >= Date.now() - 7.5 * 864e5);
    const avg = f => { const v = wk.map(f).filter(x => x != null && !isNaN(x)); return v.length ? v.reduce((a, x) => a + x, 0) / v.length : null; };
    const wkSetups = [...new Set(wk.map(d => setupKey(d)).filter(Boolean))];
    const stockStart = wk.length ? wk[0].stock : null;
    const weekLines = wk.length >= 2 ? [
      `This week (${wk.length} logged days, ${wk[0].day} to ${wk[wk.length - 1].day}): avg sold ${t(avg(d => d.sold))} t, avg made ${avg(d => d.made) ? t(avg(d => d.made)) : '?'} t${avg(d => d.income) != null ? ', avg income ' + m$(avg(d => d.income)) : ''}${avg(d => d.profit) != null ? ', avg profit ' + m$(avg(d => d.profit)) : ''}.`,
      stockStart != null ? `Stock ${t(stockStart)} t at the start of the week, ${t(stock)} t now.` : '',
      wkSetups.length > 1 ? `Setups used this week: ${wkSetups.join(' | ')}` : ''
    ] : [];
    return [
      `${data.name || 'Company'} weekly report, ${last ? last.day : 'today'}`,
      ...weekLines,
      cur && cur.key ? `Setup: ${cur.key}` : '',
      last ? `Latest day: sold ${t(last.sold)} t, made ${last.made ? t(last.made) : '?'} t. Stock ${t(stock)} t (${runTxt}).` : `Stock ${t(stock)} t (${runTxt}).`,
      last && last.income != null ? `Latest day income ${m$(last.income)}, profit ${last.profit != null ? m$(last.profit) : '?'}. Customers ${last.customers ?? '?'}.` : '',
      `Bank ${data.funds != null ? m$(data.funds) : '?'}. Popularity ${data.popularity ?? '?'}%, environment ${data.environment ?? '?'}%.`,
      v && !v.wait ? `Last change (${cur.from}): sold ${sg(v.dSold)} t/day${v.dProfit != null ? ', profit ' + d$(v.dProfit) + '/day' : ''}: ${v.call}.` : '',
      `Advisor says: ${plain(rec.text)}`,
      issues.length ? 'Checks needing attention:\n' + issues.join('\n') : 'All house rules met.'
    ].filter(Boolean).join('\n');
  }

  // ---- Guide for a new director
  function viewGuide() {
    const hr = cfg.house, fw = parseFixedWages();
    return `<div class="rec">This advisor reads the company through the Torn API and tells you what to do next. It never changes anything in Torn: you make every change yourself.</div>
      <h3>Setting up (once)</h3><ol>
        <li>On Torn: Settings → API Keys → create a key with <b>Limited</b> access. Never use a Full access key in any script.</li>
        <li>Paste it in this panel's <b>Settings</b> tab and press Save key.</li>
        <li>On the <b>Today</b> tab, open "Fill in history", paste the company's <b>Stock records</b> and <b>Company records</b> tables (from the company page) and press Import, so the advisor can judge changes straight away.</li>
      </ol>
      <h3>Daily routine (about 2 minutes)</h3><ol>
        <li>After the daily update at 18:10 TCT (2:10 am in Perth), open the company page and click <b>AMC advisor</b>. Every other day is fine too.</li>
        <li><b>Today → What to do today</b>: do what it says, or nothing if it says Hold. Make one change at a time; it judges each change after a few days.</li>
        <li><b>Problems to fix</b>: fix anything marked ⚠.</li>
        <li>Once a week (Sunday, or when the Today tab says it's due), press <b>Copy weekly summary</b> and paste it into a Torn mail to ${esc(cfg.owner || 'the owner')}.</li>
        <li>Use any company trains (Trains tab) before they reach 20; trains over 20 are wasted.</li>
      </ol>
      <h3>House rules</h3><ul>
        <li>Price <b>$${t(hr.price)}</b> a ton. Lower prices were tested and did not earn more.</li>
        <li>Advertising <b>$${hr.ads}m</b> a day. Ads lift sales about 40%; more than this was not worth the cost.</li>
        <li>Sales Executives and Secretaries make the money. Add a Sales Executive when stock covers 25+ days; move one back to Mill Operator when stock will run out within about 2 weeks. The Briefing works this out.</li>
        <li>Keep a Mine Engineer when production is short: an empty Mine Engineer costs up to ${t(cfg.model.meLoss)} t a day.</li>
        <li>Never move more than one or two people at once (a five-move reshuffle on 6 Nov cost $9m in a day).</li>
        <li>Wages: about <b>${cfg.wageMult || 20}× the employee's highest working stat</b> a day. The Briefing lists anyone paid above that.</li>
        ${fw.length ? `<li>Agreed wages that must not change: ${fw.map(f => `<b>${esc(f.name)} ${m$(f.wage)}</b>`).join(', ')}.</li>` : ''}
        <li>Keep at least <b>${hr.bankDays} days</b> of wages + ads in the company bank. Only withdraw above that (the Briefing shows the amount).</li>
        <li>The director should hold full <b>TCP</b> (sales boost) and <b>TGP</b> (advertising boost) blocks. The Briefing checks this.</li>
        <li>Site Manager (Manager special) and Safety Inspector (Cleaner special) are locked: don't move them.</li>
      </ul>
      <h3>Why the setup goes back and forth</h3><ul>
        <li>The mine can sell more salt than it can make. So it runs in a cycle, and the Briefing tells you which step you're on:</li>
        <li><b>Plenty of stock (25+ days):</b> move a Mill Operator to <b>Sales Executive</b> to sell more (up to 6). Stock then starts falling.</li>
        <li><b>Stock under about 14 days and no Mine Engineer:</b> move your best Mill Operator to <b>Mine Engineer</b>. That's worth one to two Mill Operators of output.</li>
        <li><b>Still under 14 days with a Mine Engineer:</b> move the weakest <b>Sales Executive back to Mill Operator</b>.</li>
        <li>Between those points: <b>Hold</b>. After any change, wait for the Briefing to judge it (2 to 3 days) before the next one, unless stock is under 5 days.</li>
        <li>Never let stock reach zero: from then on you can only sell what you make each day.</li>
      </ul>
      <h3>Hiring</h3><ul>
        <li>Mill Operator: high <b>manual labour</b> and endurance. Sales Executive: high <b>intelligence</b> and endurance. Secretary: endurance then intelligence.</li>
        <li>Pick active players who log in daily and don't use drugs heavily; addiction and inactivity lower effectiveness and the company environment.</li>
        <li>New hires take just over a week to settle in, so don't judge them in week one.</li>
        <li>Torn Quick Mail (same GitHub) adds a ✉ next to player names and fills in the recruitment mail.</li>
      </ul>
      <h3>What each tab does</h3><ul>
        <li><b>Today</b> (simple mode): what to do, problems to fix, the weekly report for ${esc(cfg.owner || 'the owner')}, and trains. This is all you need day to day.</li>
        <li><b>Trains</b>: who gains most from each company train.</li>
        <li><b>Guide</b> and <b>Settings</b>: this page, your key and the house rules.</li>
      </ul><p class="mut">Advanced tools (Settings → Show advanced tools):</p><ul>
        <li><b>Briefing</b>: next move, house rule checks, last change verdict, results by setup, owner summary, history import.</li>
        <li><b>Allocation</b>: who fits which role best. Only acts on gains above the minimum.</li>
        <li><b>Role mix</b>: how many Sales Executives vs Mill Operators earns most, and how long stock lasts.</li>
        <li><b>Trains</b>: who gains most from each company train.</li>
        <li><b>Staff health</b>: lowest effectiveness first, with addiction, inactivity and trends.</li>
        <li><b>Setup</b>: model estimates for ads, Mill Operator count and price tests.</li>
      </ul>
      <h3>Words used</h3><p class="mut">SE Sales Executive · Sec/Se Secretary · MO Mill Operator · ME Mine Engineer · PF Production Foreman · El Electrician · SM Site Manager · SI Safety Inspector · EE employee effectiveness · TCT Torn City Time (UTC) · runway = days until stock runs out.</p>`;
  }

  // ---- Owner watch mode view
  function viewWatch() {
    const hr = cfg.house, o = obs;
    const days = Object.keys(obsSnaps).sort().map(d => Object.assign({ day: d }, obsSnaps[d]));
    const rc = r => o.emps.filter(e => norm(e.position) === r).length;
    const now = Date.now() / 1000;
    const idle = o.emps.filter(e => e.lastTs && now - e.lastTs > 2 * 86400).sort((a, b) => a.lastTs - b.lastTs);
    const alerts = [];
    const lowRun = days.slice(-3).filter(d => d.income != null && d.income < hr.minIncome * 1e6).length;
    if (o.income != null && o.income < hr.minIncome * 1e6) alerts.push(`Daily income ${m$(o.income)} is below your ${m$(hr.minIncome * 1e6)} benchmark${lowRun >= 3 ? ' for the last 3 logged days' : ''}.`);
    if (o.hired != null && o.capacity && o.hired < o.capacity) alerts.push(`${o.hired} of ${o.capacity} staff: ${o.capacity - o.hired} slot(s) empty.`);
    if (!rc('mine engineer')) alerts.push('No Mine Engineer.');
    if (idle.length) alerts.push(`${idle.length} employee(s) inactive for 2+ days: ${idle.map(e => esc(e.name)).join(', ')}.`);
    const y = days[days.length - 2];
    if (y && (y.se !== rc('sales executive') || y.mo !== rc('mill operator') || y.me !== rc('mine engineer'))) alerts.push(`Roles changed since ${y.day}: ${y.se} SE / ${y.mo} MO / ${y.me ? 'ME' : 'no ME'} → ${rc('sales executive')} SE / ${rc('mill operator')} MO / ${rc('mine engineer') ? 'ME' : 'no ME'}.`);
    if (y && y.director && o.director && y.director !== o.director) alerts.push(`Director changed (ID ${y.director} → ${o.director}).`);
    let h = `<div class="rec">Owner watch mode: <b>${esc(o.name || 'company ' + cfg.watchId)}</b>. This key isn't the director's, so only public figures are shown (no stock, wages, ads or profit). Ask the director for the advisor's daily summary for those.</div>
      <div class="tiles"><div class="tile">Daily income<b>${o.income != null ? m$(o.income) : '?'}</b><span class="mut">${o.customers ?? '?'} customers; benchmark ${m$(hr.minIncome * 1e6)}+</span></div>
      <div class="tile">Weekly income<b>${o.weekly != null ? m$(o.weekly) : '?'}</b><span class="mut">${o.weeklyCustomers ?? '?'} customers</span></div>
      <div class="tile">Staff<b>${o.hired ?? o.emps.length} / ${o.capacity ?? '?'}</b><span class="mut">${rc('sales executive')} SE · ${rc('secretary')} Sec · ${rc('mill operator')} MO · ${rc('mine engineer') ? 'ME' : 'no ME'}</span></div></div>
      <h3>Alerts</h3>${alerts.length ? alerts.map(a => `<div class="rec w">⚠ ${a}</div>`).join('') : '<div class="rec">✔ Nothing unusual.</div>'}
      <h3>History (logged each day you open this)</h3><div class="sc"><table><tr><th class="l">Day</th><th>Income</th><th>Customers</th><th>Weekly</th><th>Staff</th><th class="l">Roles</th></tr>` +
      days.slice(-14).reverse().map(d => `<tr><td class="l">${esc(d.day)}</td><td class="${d.income < hr.minIncome * 1e6 ? 'neg' : ''}">${d.income != null ? m$(d.income) : ''}</td><td>${d.customers ?? ''}</td><td>${d.weekly != null ? m$(d.weekly) : ''}</td><td>${d.staff}/${d.cap ?? '?'}</td><td class="l">${d.se} SE · ${d.sec} Sec · ${d.mo} MO · ${d.me ? 'ME' : 'no ME'}</td></tr>`).join('') + `</table></div>
      <h3>Staff</h3><div class="sc"><table><tr><th class="l">Employee</th><th class="l">Role</th><th>Days</th><th class="l">Last active</th><th class="l">Status</th></tr>` +
      o.emps.slice().sort((a, b) => (a.lastTs || 0) - (b.lastTs || 0)).map(e => `<tr><td class="l">${esc(e.name)}</td><td class="l">${esc(e.position)}</td><td>${e.days ?? ''}</td><td class="l ${e.lastTs && now - e.lastTs > 2 * 86400 ? 'wrn' : ''}">${esc(e.last)}</td><td class="l mut">${esc(e.status)}</td></tr>`).join('') + `</table></div>`;
    return h;
  }

  // ---- Settings
  function viewSettings() {
    const m = cfg.model;
    const fld = (k, l) => `<label>${l}<input type="number" step="any" data-m="${k}" value="${m[k]}"></label>`;
    return `<h3>View</h3><label style="flex-direction:row;align-items:center;gap:6px"><input type="checkbox" data-adv="1" ${cfg.advanced ? 'checked' : ''}>Show advanced tools (full Briefing, Allocation, Role mix, Staff health, Setup)</label>
      <p class="mut">Off = simple mode: one instruction a day, problems only, the owner report and trains.</p>
      <h3>API key</h3><p class="mut">Use a <b>Limited</b> access key (Settings, API Keys on Torn), never Full access. It is stored only in Tampermonkey on this browser and sent only to api.torn.com when you press Refresh or open the panel.</p>
      <label>Limited API key<input type="password" id="amc-key" value="${esc(cfg.key)}" style="width:220px"></label> <button class="act" data-act="savekey">Save key</button>
      <h3>House rules</h3><p class="mut">The Briefing checks these every day and the Guide explains them.</p>
      <label>House price $<input type="number" step="1" data-house="price" value="${cfg.house.price}"></label>
      <label>House ad budget $m<input type="number" step="0.5" data-house="ads" value="${cfg.house.ads}"></label>
      <label>Bank floor (days of wages + ads)<input type="number" step="1" data-house="bankDays" value="${cfg.house.bankDays}"></label>
      <label>Income benchmark $m/day (watch mode)<input type="number" step="1" data-house="minIncome" value="${cfg.house.minIncome}"></label>
      <label>Owner (summary goes to)<input type="text" data-cfgs="owner" value="${esc(cfg.owner)}"></label>
      <label style="min-width:260px">Agreed wages that must not change (name=wage, e.g. scorp=0, Bob=2.5m)<input type="text" data-cfgs="fixedWages" value="${esc(cfg.fixedWages)}" style="width:260px"></label>
      <h3>Owner watch mode</h3><p class="mut">For when you are no longer the director. Enter the company's ID (the number in its company profile link). If your key can't read the director view, the panel shows the company's public figures instead: income, customers, staff, roles and inactive staff, logged daily with alerts.</p>
      <label>Company ID to watch<input type="text" data-cfgs="watchId" value="${esc(cfg.watchId)}"></label> <button class="act" data-act="watch">Open watch mode now</button>
      <h3>Effectiveness</h3><label>Education bonus (0 = fit automatically)<input type="number" step="0.005" data-cfg="bonus" value="${cfg.bonus}"></label>
      <label>Minimum gain to suggest a change (weighted EE)<input type="number" step="0.5" data-cfg="minGain" value="${cfg.minGain}"></label>
      <label>Minimum EE for support roles<input type="number" step="1" data-cfg="floor" value="${cfg.floor}"></label>
      <label>Wage formula: × highest working stat<input type="number" step="1" data-cfg="wageMult" value="${cfg.wageMult || 20}"></label>
      <p class="mut">Support roles with a minimum: ${Object.keys(REQ).map(r => `<label style="flex-direction:row;align-items:center;gap:4px"><input type="checkbox" data-floorrole="${r}" ${(cfg.floorRoles || []).includes(r) ? 'checked' : ''}>${ROLE_NAMES[r]}</label>`).join('')}</p>
      <h3>Locked roles</h3><p class="mut">Holders of these roles are never moved. Site Manager (Manager special) and Safety Inspector (Cleaner special) are locked by default.</p>
      <p>${Object.keys(REQ).map(r => `<label style="flex-direction:row;align-items:center;gap:4px"><input type="checkbox" data-lockrole="${r}" ${(cfg.lockRoles || []).includes(r) ? 'checked' : ''}>${ROLE_NAMES[r]}</label>`).join('')}</p>
      <p><button class="act" data-act="resetw">Reset weights and locks to defaults</button></p>
      <h3>Demand and production model</h3>
      ${fld('D0', 'Base demand at $0 ads (t)')}${fld('refPrice', 'Reference price $')}${fld('adA', 'Max ad lift')}${fld('adK', 'Ad scale $m')}${fld('elast', 'Price elasticity')}
      ${fld('prodBase', 'Non-MO production (t)')}${fld('prodPerMO', 'Per MO at reference EE (t)')}${fld('refEE', 'Reference MO EE')}${fld('meLoss', 'Tonnes lost without a Mine Engineer')}${fld('otherCosts', 'Other daily costs $')}
      ${fld('refSE', 'Sales Executive EE the demand figures assume')}${fld('seElast', 'Demand elasticity to SE EE')}${fld('warehouseCap', 'Storage cap (t)')}
      <p><button class="act" data-act="clearhist">Clear stored history</button> <span class="mut">${Object.keys(snaps).length} report days stored.</span></p>`;
  }

  // ---- Events
  box.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.tab) { tab = b.dataset.tab; render(); }
    else if (b.dataset.act === 'refresh') load();
    else if (b.dataset.act === 'savekey') { cfg.key = box.querySelector('#amc-key').value.trim(); saveCfg(); tab = 'brief'; load(); }
    else if (b.dataset.act === 'watch') { if (cfg.watchId) { data = null; loadWatch(); } else { lastErr = 'Enter the company ID to watch first.'; render(); } }
    else if (b.dataset.act === 'summary') {
      const txt = summaryText(), ta = box.querySelector('#amc-sum'), msg = box.querySelector('#amc-sum-msg');
      try { GM_setValue('lastReport', JSON.stringify(Date.now())); } catch (e2) { /* ignore */ }
      const done = ok => { if (msg) msg.textContent = ok ? 'Copied. Paste it into a Torn mail.' : 'Copy blocked by the browser: select the text below and copy it.'; if (!ok && ta) { ta.style.cssText = 'width:100%;height:9em;background:#141917;color:#e6ebe8;border:1px solid #2f3835'; ta.value = txt; ta.select(); } };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(() => done(true), () => done(false)); else done(false);
    }
    else if (b.dataset.act === 'fit') doFit();
    else if (b.dataset.act === 'applyfit') { const f = box.querySelector('#amc-fit')._fit; if (f) { Object.assign(cfg.model, { D0: Math.round(f.D0), adA: f.A, adK: f.K, elast: f.E }); saveCfg(); render(); } }
    else if (b.dataset.act === 'resetw') { cfg.weights = Object.assign({}, DEF_W); cfg.lockRoles = DEF.lockRoles.slice(); cfg.locks = {}; cfg.minGain = DEF.minGain; cfg.floor = DEF.floor; cfg.floorRoles = DEF.floorRoles.slice(); saveCfg(); render(); }
    else if (b.dataset.act === 'import') {
      const ta = box.querySelector('#amc-import'); const r = importRecords(ta ? ta.value : '');
      render(); const msg = box.querySelector('#amc-import-msg');
      if (msg) msg.textContent = `Imported ${r.stock} stock row(s) and ${r.comp} company row(s); setup known for ${r.setups} day(s).`;
    }
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
    else if (el.dataset.cfgs) { cfg[el.dataset.cfgs] = el.value.trim(); saveCfg(); }
    else if (el.dataset.adv) { cfg.advanced = el.checked; saveCfg(); render(); }
    else if (el.dataset.house) { cfg.house[el.dataset.house] = parseFloat(el.value) || 0; saveCfg(); }
    else if (el.id === 'amc-fitprice') { cfg.fitPrice = el.checked; saveCfg(); }
  });
})();
