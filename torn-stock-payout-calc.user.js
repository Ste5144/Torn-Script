// ==UserScript==
// @name         Torn Stock Payout Calculator (display only)
// @namespace    sterlingarcher.payout
// @version      1.2.0
// @description  Values every benefit block at live item market prices over a chosen horizon (7 days to 12 months) and flags blocks worth selling. Read-only API calls with a Public key. No game actions.
// @match        https://www.torn.com/page.php?sid=stocks*
// @grant        none
// @homepageURL  https://github.com/Ste5144/Torn-Script
// @updateURL    https://raw.githubusercontent.com/Ste5144/Torn-Script/main/torn-stock-payout-calc.user.js
// @downloadURL  https://raw.githubusercontent.com/Ste5144/Torn-Script/main/torn-stock-payout-calc.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ---------- CONFIG: your benefit blocks (edit shares if your holdings change) ----------
  // shares = shares in THAT block only. kind: item (payout item name), cash, energy, nerve, points, happy.
  const BLOCKS = [
    { acr: 'SYM', blk: 1, shares: 500000,   kind: 'item', item: 'Drug Pack', days: 7 },
    { acr: 'SYM', blk: 2, shares: 1000000,  kind: 'item', item: 'Drug Pack', days: 7 },
    { acr: 'FHG', blk: 1, shares: 2000000,  kind: 'item', item: 'Feathery Hotel Coupon', days: 7 },
    { acr: 'FHG', blk: 2, shares: 4000000,  kind: 'item', item: 'Feathery Hotel Coupon', days: 7 },
    { acr: 'PRN', blk: 1, shares: 1000000,  kind: 'item', item: 'Erotic DVD', days: 7 },
    { acr: 'PRN', blk: 2, shares: 2000000,  kind: 'item', item: 'Erotic DVD', days: 7 },
    { acr: 'MUN', blk: 1, shares: 5000000,  kind: 'item', item: 'Six-Pack of Energy Drink', days: 7 },
    { acr: 'GRN', blk: 1, shares: 500000,   kind: 'cash', amount: 4000000,  days: 31 },
    { acr: 'IOU', blk: 1, shares: 3000000,  kind: 'cash', amount: 12000000, days: 31 },
    { acr: 'TMI', blk: 1, shares: 6000000,  kind: 'cash', amount: 25000000, days: 31 },
    { acr: 'HRG', blk: 1, shares: 10000000, kind: 'property', days: 31, note: 'Set $/property to your average sale price' },
    { acr: 'PTS', blk: 1, shares: 10000000, kind: 'points', qty: 100, days: 7, note: 'Used for nerve refills' },
    { acr: 'MCS', blk: 1, shares: 350000,   kind: 'energy', qty: 100, days: 7 }
  ];
  const HORIZONS = [[7, '7 days'], [14, '14 days'], [30, '1 month'], [61, '2 months'], [91, '3 months'], [182, '6 months'], [273, '9 months'], [365, '12 months']];
  const ENERGY_REF = { item: 'Can of Red Cow', energy: 25 }; // default $/energy = cheapest Red Cow / 25
  const LS = 'stockPayoutCalc.v2';

  // ---------- STATE ----------
  const load = () => { try { return JSON.parse(localStorage.getItem(LS)) || {}; } catch { return {}; } };
  const save = () => { try { localStorage.setItem(LS, JSON.stringify(S)); } catch {} };
  const S = Object.assign({
    key: '', days: 91, altRate: 0, sellItems: true, priceMode: 'low',
    nerveVal: 5000, energyVal: null, happyVal: 0, propVal: 5000000, pointVal: null, data: null, off: {}, showHidden: false
  }, load());
  // reuse the flip tracker's key if this one is blank
  if (!S.key) { try { S.key = (JSON.parse(localStorage.getItem('stockPayoutCalc.v1')) || {}).key || (JSON.parse(localStorage.getItem('flipTracker.v1')) || {}).key || ''; } catch {} }

  const $ = (n) => n == null || isNaN(n) ? '–' : (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString();
  const $m = (n) => n == null || isNaN(n) ? '–' : (n < 0 ? '-$' : '$') + (Math.abs(n) / 1e6).toFixed(Math.abs(n) >= 1e8 ? 0 : 1) + 'm';
  const pct = (n) => n == null || isNaN(n) ? '–' : (n * 100).toFixed(1) + '%';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function api(url) {
    const r = await fetch(url + (url.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(S.key) + '&comment=payoutcalc');
    const j = await r.json();
    if (j.error) throw new Error('API ' + j.error.code + ': ' + j.error.error);
    return j;
  }

  // ---------- DATA ----------
  async function refresh(status) {
    status('Loading items…');
    const items = (await api('https://api.torn.com/torn/?selections=items')).items || {};
    const byName = {};
    for (const [id, it] of Object.entries(items)) byName[it.name] = { id: +id, mv: it.market_value };
    status('Loading stock prices…');
    const stocks = (await api('https://api.torn.com/torn/?selections=stocks')).stocks || {};
    const px = {};
    Object.values(stocks).forEach((s) => { px[s.acronym] = s.current_price; });

    const names = [...new Set(BLOCKS.filter((b) => b.kind === 'item').map((b) => b.item).concat(ENERGY_REF.item))];
    const prices = {}, missing = [];
    for (let i = 0; i < names.length; i++) {
      const n = names[i];
      if (!byName[n]) { missing.push(n); continue; }
      status(`Item market ${i + 1}/${names.length}: ${n}`);
      let low = null;
      try {
        const m = await api(`https://api.torn.com/v2/market/${byName[n].id}/itemmarket`);
        const l = (m.itemmarket && m.itemmarket.listings) || [];
        if (l.length) low = Math.min(...l.map((x) => x.price));
      } catch (e) {}
      prices[n] = { low, mv: byName[n].mv };
      await sleep(650);
    }
    let pointLow = null;
    try {
      status('Loading points market…');
      const pm = (await api('https://api.torn.com/market/?selections=pointsmarket')).pointsmarket || {};
      const c = Object.values(pm).map((x) => x.cost).filter((x) => x > 0);
      if (c.length) pointLow = Math.min(...c);
    } catch (e) {}
    S.data = { t: Date.now(), px, prices, pointLow, missing };
    save();
    status('Updated ' + new Date().toLocaleString());
  }

  // ---------- MATHS ----------
  function itemPrice(n) {
    const p = S.data && S.data.prices[n];
    if (!p) return null;
    return S.priceMode === 'low' ? (p.low ?? p.mv) : (p.mv ?? p.low);
  }
  function energyVal() {
    if (S.energyVal) return S.energyVal;
    const p = itemPrice(ENERGY_REF.item);
    return p ? p / ENERGY_REF.energy : null;
  }
  function pointVal() { return S.pointVal || (S.data && S.data.pointLow) || null; }

  function calc(b) {
    const d = S.data, price = d && d.px[b.acr];
    const value = price ? price * b.shares : null;
    let per = null, basis = '';
    if (b.kind === 'cash') { per = b.amount; basis = 'cash'; }
    else if (b.kind === 'item') {
      const p = itemPrice(b.item);
      per = p == null ? null : p * (S.sellItems ? 0.95 : 1);
      basis = b.item + (p ? ' @ ' + $m(p) : ' (no price)');
    } else if (b.kind === 'points') { const v = pointVal(); per = v ? v * b.qty : null; basis = b.qty + ' points @ ' + $(v); }
    else if (b.kind === 'energy') { const v = energyVal(); per = v ? v * b.qty : null; basis = b.qty + ' energy @ ' + $(v) + '/E'; }
    else if (b.kind === 'nerve') { per = S.nerveVal * b.qty; basis = b.qty + ' nerve @ ' + $(S.nerveVal) + '/N'; }
    else if (b.kind === 'property') { per = S.propVal; basis = 'property @ ' + $m(S.propVal); }
    else if (b.kind === 'happy') { per = S.happyVal * b.qty; basis = b.qty + ' happy @ ' + $(S.happyVal) + '/H'; }
    const payouts = S.days / b.days;
    const income = per == null ? null : per * payouts;
    const yld = per != null && value ? (per * 365 / b.days) / value : null;
    // what the sale proceeds would earn elsewhere over the horizon, after 0.1% sale fee
    const alt = value ? value * 0.999 * (S.altRate / 100) * (S.days / 365) - value * 0.001 : null;
    const edge = income != null && alt != null ? income - alt : null;
    return { value, per, basis, payouts, income, yld, alt, edge };
  }

  // ---------- UI ----------
  const css = `
  #spc,#spc *{color:#e8e8e8 !important;font-family:Arial,sans-serif !important}
  #spc{position:fixed;left:10px;bottom:10px;z-index:99999;width:min(900px,97vw);max-height:82vh;overflow:auto;background:#1d1d1d !important;
    border:1px solid #444;border-radius:6px;box-shadow:0 4px 18px #000a;display:none;font-size:12px !important;line-height:1.4}
  #spc .bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;padding:8px;border-bottom:1px solid #333;position:sticky;top:0;background:#1d1d1d !important;z-index:1}
  #spc table{width:100%;border-collapse:collapse}#spc th,#spc td{padding:3px 6px;border-bottom:1px solid #2c2c2c;text-align:right;white-space:nowrap}
  #spc th{color:#ffd77a !important;background:#262626 !important;cursor:pointer}#spc th:first-child,#spc td:first-child,#spc td.l{text-align:left}
  #spc .up,#spc .up *{color:#6f6 !important}#spc .dn,#spc .dn *{color:#ff7a7a !important}#spc .muted{color:#aaa !important}#spc b{color:#fff !important}
  #spc input,#spc select{background:#000 !important;color:#fff !important;border:1px solid #555;padding:2px 4px}
  #spc button{background:#3a3a3a !important;color:#fff !important;border:1px solid #555;padding:3px 8px;cursor:pointer;border-radius:3px}
  #spc .sec{padding:8px}#spc tr.off td{opacity:.35}
  #spcb{position:fixed;left:10px;bottom:52px;z-index:99998;background:#2a6fb0;color:#fff;border:0;border-radius:4px;padding:6px 10px;cursor:pointer;font:12px Arial}`;
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
  const btn = document.createElement('button'); btn.id = 'spcb'; btn.textContent = 'Stock payouts'; document.body.appendChild(btn);
  const P = document.createElement('div'); P.id = 'spc'; document.body.appendChild(P);
  btn.onclick = () => { P.style.display = 'block'; btn.style.display = 'none'; render(); };
  let sortKey = 'yld', sortDir = 1;

  function render(msg) {
    const d = S.data;
    const hOpts = HORIZONS.map(([v, l]) => `<option value="${v}" ${+S.days === v ? 'selected' : ''}>${l}</option>`).join('');
    let h = `<div class="bar"><b>Stock payouts</b>
      <span>Key <input id="k" type="password" value="${S.key}" style="width:110px" placeholder="Public key"></span>
      <span>Period <select id="h">${hOpts}</select></span>
      <span title="What you could earn on the sale money elsewhere, per year. 0 = cash sits idle.">Alt return <input id="a" type="number" value="${S.altRate}" style="width:50px">%/yr</span>
      <span>Price <select id="pm"><option value="low" ${S.priceMode === 'low' ? 'selected' : ''}>Lowest listing</option><option value="mv" ${S.priceMode === 'mv' ? 'selected' : ''}>Market value</option></select></span>
      <label><input id="t" type="checkbox" ${S.sellItems ? 'checked' : ''}> less 5% tax</label>
      <button id="all">Tick all</button><button id="none">Untick all</button>
      <label title="Show unticked rows so you can tick them again"><input id="sh" type="checkbox" ${S.showHidden ? 'checked' : ''}> Show hidden (${Object.values(S.off).filter(Boolean).length})</label>
      <button id="r">Refresh prices</button><button id="x">Close</button>
      <span class="muted" id="st">${msg || (d ? 'Prices ' + new Date(d.t).toLocaleString() : 'Press Refresh prices')}</span></div>
      <div class="bar" style="top:auto;position:static">
      <span>$/nerve <input id="nv" type="number" value="${S.nerveVal}" style="width:70px"></span>
      <span>$/energy <input id="ev" type="number" value="${S.energyVal || ''}" placeholder="${energyVal() ? Math.round(energyVal()) : 'auto'}" style="width:80px"></span>
      <span>$/point <input id="pv" type="number" value="${S.pointVal || ''}" placeholder="${d && d.pointLow ? d.pointLow : 'auto'}" style="width:70px"></span>
      <span>$/happy <input id="hv" type="number" value="${S.happyVal}" style="width:60px"></span>
      <span title="Average sale price of the HRG random property">$/property <input id="prv" type="number" value="${S.propVal}" style="width:100px"></span>
      <span class="muted">Blank = live price (energy from ${ENERGY_REF.item} ÷ ${ENERGY_REF.energy}). Untick a row to hide it and leave it out of the totals.</span></div>`;
    if (d) {
      const rows = BLOCKS.map((b, i) => ({ b, i, ...calc(b) }));
      rows.sort((x, y) => sortKey === 'acr' ? (x.b.acr + x.b.blk).localeCompare(y.b.acr + y.b.blk) * sortDir : ((x[sortKey] ?? -1e18) - (y[sortKey] ?? -1e18)) * sortDir);
      const label = HORIZONS.find(([v]) => v === +S.days)[1];
      let tv = 0, ti = 0, ta = 0;
      h += `<div class="sec"><table><tr><th></th><th data-s="acr">Block</th><th class="l">Pays</th><th data-s="value">Block value</th><th data-s="per">Per payout</th>
        <th data-s="payouts">Payouts</th><th data-s="income">Income ${label}</th><th data-s="yld">Yield/yr</th><th data-s="alt">Sale money earns</th><th data-s="edge">Keep advantage</th><th>Verdict</th></tr>`;
      rows.forEach(({ b, i, value, per, basis, payouts, income, yld, alt, edge }) => {
        const off = S.off[i];
        if (off && !S.showHidden) return;
        if (!off) { tv += value || 0; ti += income || 0; ta += alt || 0; }
        const verdict = edge == null ? '<span class="muted">–</span>'
          : edge > 0 ? '<span class="up">Keep</span>' : '<span class="dn">Sell candidate</span>';
        h += `<tr class="${off ? 'off' : ''}"><td><input type="checkbox" data-i="${i}" ${off ? '' : 'checked'}></td>
          <td>${b.acr} #${b.blk}${b.note ? ' <span class="muted" title="' + b.note + '">*</span>' : ''}</td><td class="l muted">${basis} / ${b.days}d</td>
          <td>${$m(value)}</td><td>${$m(per)}</td><td>${payouts.toFixed(1)}</td><td>${$m(income)}</td><td>${pct(yld)}</td><td>${$m(alt)}</td>
          <td class="${edge > 0 ? 'up' : edge < 0 ? 'dn' : ''}">${$m(edge)}</td><td>${verdict}</td></tr>`;
      });
      h += `<tr><td></td><td><b>Total (${BLOCKS.length - Object.values(S.off).filter(Boolean).length} ticked)</b></td><td></td><td><b>${$m(tv)}</b></td><td></td><td></td><td><b>${$m(ti)}</b></td><td><b>${pct(tv ? ti / tv * 365 / S.days : null)}</b></td><td><b>${$m(ta)}</b></td><td><b>${$m(ti - ta)}</b></td><td></td></tr></table>
        <div class="muted" style="margin-top:6px">Income = per-payout value × (period ÷ payout interval), pro-rata. Cash blocks pay every 31 days, so short periods may see 0 or 1 actual payout.
        "Sale money earns" = block value × alt return over the period, less the 0.1% sale fee. Selling resets the benefit timer and rebuying later is at the then share price.
        ${d.missing.length ? '<br><span class="dn">Item not found: ' + d.missing.join(', ') + '</span>' : ''}</div></div>`;
    }
    P.innerHTML = h;
    const on = (id, ev, fn) => { const el = P.querySelector(id); if (el) el[ev] = fn; };
    on('#x', 'onclick', () => { P.style.display = 'none'; btn.style.display = 'block'; });
    on('#k', 'onchange', (e) => { S.key = e.target.value.trim(); save(); });
    on('#h', 'onchange', (e) => { S.days = +e.target.value; save(); render(); });
    on('#a', 'onchange', (e) => { S.altRate = +e.target.value || 0; save(); render(); });
    on('#pm', 'onchange', (e) => { S.priceMode = e.target.value; save(); render(); });
    on('#t', 'onchange', (e) => { S.sellItems = e.target.checked; save(); render(); });
    on('#nv', 'onchange', (e) => { S.nerveVal = +e.target.value || 0; save(); render(); });
    on('#ev', 'onchange', (e) => { S.energyVal = +e.target.value || null; save(); render(); });
    on('#pv', 'onchange', (e) => { S.pointVal = +e.target.value || null; save(); render(); });
    on('#prv', 'onchange', (e) => { S.propVal = +e.target.value || 0; save(); render(); });
    on('#hv', 'onchange', (e) => { S.happyVal = +e.target.value || 0; save(); render(); });
    on('#all', 'onclick', () => { S.off = {}; save(); render(); });
    on('#none', 'onclick', () => { BLOCKS.forEach((b, i) => { S.off[i] = true; }); S.showHidden = true; save(); render(); });
    on('#sh', 'onchange', (e) => { S.showHidden = e.target.checked; save(); render(); });
    P.querySelectorAll('input[data-i]').forEach((c) => c.onchange = (e) => { S.off[e.target.dataset.i] = !e.target.checked; save(); render(); });
    P.querySelectorAll('th[data-s]').forEach((th) => th.onclick = () => {
      const k = th.dataset.s; sortDir = sortKey === k ? -sortDir : (k === 'acr' ? 1 : -1); sortKey = k; render();
    });
    on('#r', 'onclick', async () => {
      if (!S.key) return render('Enter a Public key first');
      const s = (m) => { const el = P.querySelector('#st'); if (el) el.textContent = m; };
      try { await refresh(s); render(); } catch (e) { render('Error: ' + e.message); }
    });
  }
})();
