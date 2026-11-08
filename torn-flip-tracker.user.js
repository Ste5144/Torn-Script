// ==UserScript==
// @name         Torn Flip Tracker (display only)
// @namespace    sterlingarcher.flip
// @version      1.2.0
// @description  Tracks prices of hold-and-flip items and compares them against the stock blocks you could sell to fund them. Read-only API calls with a Public/Minimal key. No game actions.
// @match        https://www.torn.com/page.php?sid=ItemMarket*
// @match        https://www.torn.com/page.php?sid=stocks*
// @grant        none
// @homepageURL  https://github.com/Ste5144/Torn-Script
// @updateURL    https://raw.githubusercontent.com/Ste5144/Torn-Script/main/torn-flip-tracker.user.js
// @downloadURL  https://raw.githubusercontent.com/Ste5144/Torn-Script/main/torn-flip-tracker.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ---------- CONFIG (edit freely) ----------
  // Items to track. Names must match Torn item names exactly; unmatched names are listed in the panel.
  const WATCHLIST = [
    'Business Class Ticket', 'Casino Pass', 'Feathery Hotel Coupon', 'Xanax',
    'Can of Red Cow', 'Can of Taurine Elite', 'Can of Munster', 'Can of Goose Juice',
    'Can of Damp Valley', 'Can of Crocozade', 'Can of Santa Boogie', 'Can of Rockstar Rudolph',
    'Can of X-MASS', 'Six-Pack of Energy Drink', 'Drug Pack', 'Erotic DVD',
    'Lottery Voucher', 'Box of Grenades', 'Six-Pack of Alcohol', 'Box of Medical Supplies'
  ];

  // Stock blocks you could sell. shares = shares in THAT block only (incremental).
  // payout: an item name (valued at live market value), or cash: amount. days = payout interval.
  // valueOverride: $ per payout for non-tradeable benefits (nerve, happiness, points).
  const BLOCKS = [
    { acr: 'SYM', blk: 2, shares: 1000000,  payout: 'Drug Pack', days: 7 },
    { acr: 'FHG', blk: 2, shares: 4000000,  payout: 'Feathery Hotel Coupon', days: 7 },
    { acr: 'PRN', blk: 2, shares: 2000000,  payout: 'Erotic DVD', days: 7 },
    { acr: 'MUN', blk: 1, shares: 5000000,  payout: 'Six-Pack of Energy Drink', days: 7 },
    { acr: 'TMI', blk: 1, shares: 6000000,  cash: 25000000, days: 31 },
    { acr: 'IOU', blk: 1, shares: 3000000,  cash: 12000000, days: 31 },
    { acr: 'GRN', blk: 1, shares: 500000,   cash: 4000000,  days: 31 },
    { acr: 'HRG', blk: 1, shares: 10000000, payout: 'property', valueOverride: 5000000, days: 31, note: 'Edit valueOverride to avg property sale' },
    { acr: 'PRN', blk: 1, shares: 1000000,  payout: 'Erotic DVD', days: 7 },
    { acr: 'FHG', blk: 1, shares: 2000000,  payout: 'Feathery Hotel Coupon', days: 7 },
    { acr: 'SYM', blk: 1, shares: 500000,   payout: 'Drug Pack', days: 7 }
  ];

  // 12-month baseline read from in-game item charts (approx., read by eye 6 Nov 2026).
  // ref = typical price before the Halloween crash; yago = price a year ago, early Nov 2025.
  const HISTORY = {
    'Can of Red Cow':           { hi: 2550000,  hiDate: 'late Oct 26', lo: 1800000, loDate: 'Feb 26', ref: 2400000,  yago: 1900000 },
    'Six-Pack of Energy Drink': { hi: 16600000, hiDate: 'early Sep 26', lo: 11900000, loDate: 'Feb 26', ref: 16000000, yago: 13000000 },
    'Business Class Ticket':    { hi: 9400000,  hiDate: 'late Oct 26', lo: 5100000, loDate: 'Jan 26', ref: 8200000,  yago: 5600000 },
    'Can of Rockstar Rudolph':  { hi: 2500000,  hiDate: 'late Oct 26', lo: 1650000, loDate: 'Jan 26', ref: 2350000,  yago: 2250000 },
    'Erotic DVD':               { hi: 4350000,  hiDate: 'Jul-Oct 26', lo: 3850000, loDate: 'Nov 26', ref: 4300000,  yago: 4600000 },
    'Casino Pass':              { hi: 17300000, hiDate: 'Aug-Sep 26', lo: 9500000, loDate: 'Nov 25', ref: 15500000, yago: 10000000 }
  };

  // Use the holdings the Stock Payout Calculator detected (same browser), else the fixed BLOCKS list.
  function getBlocks() {
    try {
      const st = JSON.parse(localStorage.getItem('stockPayoutCalc.v3')) || {};
      const d = st.data || {}, list = d.blocks;
      if (!list || !list.length) return BLOCKS;
      const rc = d.prices && d.prices['Can of Red Cow'];
      const ePer = st.energyVal || (rc ? (rc.low || rc.mv) / 25 : 0);
      return list.map((b) => {
        const base = { acr: b.acr, blk: b.blk, shares: b.shares, days: b.days };
        if (b.kind === 'cash') return { ...base, cash: b.amount };
        if (b.kind === 'item') return { ...base, payout: b.item };
        const v = b.kind === 'property' ? (st.propVal || 5000000)
          : b.kind === 'nerve' ? b.qty * (st.nerveVal || 5000)
          : b.kind === 'happy' ? b.qty * (st.happyVal || 0)
          : b.kind === 'points' ? b.qty * (st.pointVal || d.pointLow || 0)
          : b.kind === 'energy' ? b.qty * ePer : 0;
        return { ...base, payout: b.kind, valueOverride: v, note: b.kind === 'unknown' ? b.label : '' };
      });
    } catch (e) { return BLOCKS; }
  }

  const MARKET_FEE = 0.05;   // item market sales tax; set 0 if you sell via bazaar/trade
  const STOCK_FEE = 0.001;   // stock sale fee (check current)
  const LS_KEY = 'flipTracker.v1';

  // ---------- STORAGE ----------
  const load = () => { try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch { return {}; } };
  const save = (s) => { try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch {} };
  let S = Object.assign({ key: '', snaps: [], positions: {}, months: 5, ids: {} }, load());

  const fmt = (n) => n == null || isNaN(n) ? '–' : '$' + Math.round(n).toLocaleString();
  const pct = (n) => n == null || isNaN(n) ? '–' : (n * 100).toFixed(1) + '%';
  const api = async (url) => {
    const r = await fetch(url + (url.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(S.key) + '&comment=fliptracker');
    const j = await r.json();
    if (j.error) throw new Error('API ' + j.error.code + ': ' + j.error.error);
    return j;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- DATA PULL ----------
  async function snapshot(status) {
    status('Loading item list…');
    const items = (await api('https://api.torn.com/torn/?selections=items')).items || {};
    const byName = {};
    for (const [id, it] of Object.entries(items)) byName[it.name] = { id: +id, mv: it.market_value };
    S.ids = {};
    WATCHLIST.forEach((n) => { if (byName[n]) S.ids[n] = byName[n].id; });

    status('Loading stocks…');
    const stocks = (await api('https://api.torn.com/torn/?selections=stocks')).stocks || {};
    const stockPx = {};
    Object.values(stocks).forEach((s) => { stockPx[s.acronym] = s.current_price; });

    const prices = {};
    const names = WATCHLIST.filter((n) => byName[n]);
    for (let i = 0; i < names.length; i++) {
      const n = names[i];
      status(`Item market ${i + 1}/${names.length}: ${n}`);
      let low = null;
      try {
        const m = await api(`https://api.torn.com/v2/market/${byName[n].id}/itemmarket`);
        const l = (m.itemmarket && m.itemmarket.listings) || [];
        if (l.length) low = Math.min(...l.map((x) => x.price));
      } catch (e) { /* keep market value only */ }
      prices[n] = { mv: byName[n].mv, low };
      await sleep(700); // stays well under the 100 calls/min limit
    }
    // payout item values for blocks (may not be on watchlist)
    const payoutMv = {};
    getBlocks().forEach((b) => { if (b.payout && byName[b.payout]) payoutMv[b.payout] = byName[b.payout].mv; });

    S.snaps.push({ t: Date.now(), prices, stockPx, payoutMv });
    if (S.snaps.length > 400) S.snaps = S.snaps.slice(-400);
    save(S);
    status('Snapshot saved ' + new Date().toLocaleString());
  }

  // ---------- ANALYSIS ----------
  const last = () => S.snaps[S.snaps.length - 1];
  function priceAt(name, daysAgo) {
    const target = Date.now() - daysAgo * 864e5;
    let best = null;
    for (const s of S.snaps) if (s.t <= target && s.prices[name]) best = s;
    return best ? (best.prices[name].low ?? best.prices[name].mv) : null;
  }
  function range(name) {
    const v = S.snaps.map((s) => s.prices[name] && (s.prices[name].low ?? s.prices[name].mv)).filter((x) => x);
    const b = HISTORY[name]; if (b) v.push(b.hi, b.lo);
    return v.length ? [Math.min(...v), Math.max(...v)] : [null, null];
  }
  function blockStats(b, snap) {
    const px = snap.stockPx[b.acr];
    const value = px ? px * b.shares : null;
    const per = b.cash ?? b.valueOverride ?? snap.payoutMv[b.payout] ?? 0;
    const annual = per * (365 / b.days);
    const yld = value ? annual / value : null;
    // appreciation the item needs over the hold to beat keeping the block, net of fees
    const holdYrs = S.months / 12;
    const need = yld == null ? null : (1 + yld * holdYrs + STOCK_FEE) / (1 - MARKET_FEE) - 1;
    return { value, per, annual, yld, need };
  }

  // ---------- UI ----------
  const css = `
  #ftp,#ftp *{color:#e8e8e8 !important;font-family:Arial,sans-serif !important}
  #ftp h3,#ftp b{color:#fff !important}#ftp .up,#ftp .up *{color:#6f6 !important}#ftp .dn,#ftp .dn *{color:#ff7a7a !important}#ftp .muted{color:#aaa !important}
  #ftp th{color:#ffd77a !important;background:#262626 !important}#ftp td{background:transparent !important}
  #ftp input{background:#000 !important;color:#fff !important}#ftp button{background:#3a3a3a !important;color:#fff !important}
  #ftp{position:fixed;left:10px;bottom:10px;z-index:99999;width:min(760px,96vw);max-height:80vh;overflow:auto;
    background:#1d1d1d;color:#ddd;font:12px/1.4 Arial,sans-serif;border:1px solid #444;border-radius:6px;box-shadow:0 4px 18px #000a;display:none}
  #ftp h3{margin:8px 0 4px;font-size:13px;color:#fff}#ftp .bar{display:flex;gap:6px;flex-wrap:wrap;align-items:center;padding:8px;border-bottom:1px solid #333;position:sticky;top:0;background:#1d1d1d}
  #ftp table{width:100%;border-collapse:collapse;margin-bottom:8px}#ftp th,#ftp td{padding:3px 5px;border-bottom:1px solid #2c2c2c;text-align:right;white-space:nowrap}
  #ftp th:first-child,#ftp td:first-child{text-align:left}#ftp .up{color:#7c7}#ftp .dn{color:#e77}#ftp .muted{color:#888}
  #ftp input{background:#111;color:#ddd;border:1px solid #444;padding:2px 4px;width:90px}#ftp button{background:#333;color:#eee;border:1px solid #555;padding:3px 8px;cursor:pointer;border-radius:3px}
  #ftp .sec{padding:0 8px 8px}#ftb{position:fixed;left:10px;bottom:10px;z-index:99998;background:#2a5;color:#fff;border:0;border-radius:4px;padding:6px 10px;cursor:pointer;font:12px Arial}`;
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
  const btn = document.createElement('button'); btn.id = 'ftb'; btn.textContent = 'Flip tracker'; document.body.appendChild(btn);
  const P = document.createElement('div'); P.id = 'ftp'; document.body.appendChild(P);
  btn.onclick = () => { P.style.display = 'block'; btn.style.display = 'none'; render(); };

  function render(msg) {
    const snap = last();
    let h = `<div class="bar">
      <b style="color:#fff">Flip tracker</b>
      <span>Public key: <input id="ftk" type="password" value="${S.key}" placeholder="Public/Minimal"></span>
      <span>Hold (months): <input id="ftm" type="number" min="1" max="12" value="${S.months}" style="width:45px"></span>
      <button id="ftr">Snapshot now</button><button id="ftc">Copy CSV</button><button id="ftx">Close</button>
      <span id="fts" class="muted">${msg || (snap ? 'Last snapshot ' + new Date(snap.t).toLocaleString() + ' · ' + S.snaps.length + ' saved' : 'No snapshots yet')}</span></div>`;
    if (snap) {
      const missing = WATCHLIST.filter((n) => !snap.prices[n]);
      // Funding table
      const bs = getBlocks().map((b) => ({ b, ...blockStats(b, snap) })).sort((x, y) => (x.yld ?? 9) - (y.yld ?? 9));
      h += `<div class="sec"><h3>Funding sources (cheapest to give up first)</h3>
        <table><tr><th>Block</th><th>Value now</th><th>Payout</th><th>Yield/yr</th><th>Item must rise</th><th>Note</th></tr>`;
      bs.forEach(({ b, value, per, yld, need }) => {
        h += `<tr><td>${b.acr} #${b.blk}</td><td>${fmt(value)}</td><td>${fmt(per)}/${b.days}d</td><td>${pct(yld)}</td><td>${pct(need)}</td><td class="muted">${b.note || ''}</td></tr>`;
      });
      h += `</table><div class="muted">"Item must rise" = gain needed over ${S.months} months to beat holding the block, after ${pct(MARKET_FEE)} market tax and ${pct(STOCK_FEE)} stock fee. Excludes share price movement and the cost of rebuying the block later.</div></div>`;

      // Items table
      const minNeed = Math.min(...bs.map((x) => x.need).filter((x) => x != null));
      h += `<div class="sec"><h3>Watchlist</h3><table><tr><th>Item</th><th>Lowest</th><th>Mkt value</th><th>7d</th><th>30d</th><th>12m Low–High</th><th>Signal</th><th>Net to pre-crash</th><th>Net to 12m high</th><th>Target (cheapest block)</th><th>Qty held</th><th>Avg cost</th><th>Net P/L</th></tr>`;
      WATCHLIST.filter((n) => snap.prices[n]).forEach((n) => {
        const p = snap.prices[n]; const cur = p.low ?? p.mv;
        const c7 = priceAt(n, 7), c30 = priceAt(n, 30);
        const ch = (o) => o ? `<span class="${cur >= o ? 'up' : 'dn'}">${pct(cur / o - 1)}</span>` : '<span class="muted">–</span>';
        const [lo, hi] = range(n);
        const hb = HISTORY[n];
        const posn = hi > lo ? (cur - lo) / (hi - lo) : null;
        const sig = posn == null ? '<span class="muted">–</span>' : posn < 0.25 ? '<span class="up">Cheap</span>' : posn < 0.6 ? 'Fair' : '<span class="dn">Dear</span>';
        const netTo = (x) => x ? (x * (1 - MARKET_FEE)) / cur - 1 : null;
        const nr = hb ? netTo(hb.ref) : null, nh = netTo(hi);
        const pos = S.positions[n] || { q: '', c: '' };
        const pl = pos.q && pos.c ? pos.q * (cur * (1 - MARKET_FEE) - pos.c) : null;
        const tgt = pos.c ? pos.c * (1 + minNeed) : cur * (1 + minNeed);
        h += `<tr><td>${n}</td><td>${fmt(p.low)}</td><td>${fmt(p.mv)}</td><td>${ch(c7)}</td><td>${ch(c30)}</td><td title="${hb ? 'High ' + hb.hiDate + ', low ' + hb.loDate : 'From your snapshots only'}">${fmt(lo)} – ${fmt(hi)}${hb ? '' : ' <span class=muted>*</span>'}</td>
          <td>${sig}</td><td class="${nr > 0 ? 'up' : nr < 0 ? 'dn' : ''}">${pct(nr)}</td><td class="${nh > 0 ? 'up' : 'dn'}">${pct(nh)}</td>
          <td>${fmt(tgt)}</td><td><input data-n="${n}" data-f="q" value="${pos.q}" style="width:55px"></td>
          <td><input data-n="${n}" data-f="c" value="${pos.c}"></td><td class="${pl > 0 ? 'up' : pl < 0 ? 'dn' : ''}">${fmt(pl)}</td></tr>`;
      });
      h += `</table>${missing.length ? '<div class="dn">Name not found: ' + missing.join(', ') + ' (fix spelling in WATCHLIST)</div>' : ''}
        <div class="muted">Prices use lowest item market listing, falling back to Torn market value. 12m range uses chart readings where entered (hover for dates); * = your snapshots only. Signal: Cheap = bottom 25% of range, Dear = top 40%. Net figures are after market tax.</div></div>`;
    }
    P.innerHTML = h;
    P.querySelector('#ftx').onclick = () => { P.style.display = 'none'; btn.style.display = 'block'; };
    P.querySelector('#ftk').onchange = (e) => { S.key = e.target.value.trim(); save(S); };
    P.querySelector('#ftm').onchange = (e) => { S.months = +e.target.value || 5; save(S); render(); };
    P.querySelectorAll('input[data-n]').forEach((i) => i.onchange = (e) => {
      const n = e.target.dataset.n; S.positions[n] = S.positions[n] || { q: '', c: '' };
      S.positions[n][e.target.dataset.f] = +e.target.value.replace(/[$,]/g, '') || ''; save(S); render();
    });
    P.querySelector('#ftr').onclick = async () => {
      if (!S.key) return render('Enter a Public key first');
      const s = (m) => { const el = P.querySelector('#fts'); if (el) el.textContent = m; };
      try { await snapshot(s); render(); } catch (e) { render('Error: ' + e.message); }
    };
    P.querySelector('#ftc').onclick = async () => {
      const rows = [['time', 'item', 'lowest', 'market_value']];
      S.snaps.forEach((s) => Object.entries(s.prices).forEach(([n, p]) => rows.push([new Date(s.t).toISOString(), n, p.low ?? '', p.mv ?? ''])));
      try { await navigator.clipboard.writeText(rows.map((r) => r.join(',')).join('\n')); render('CSV copied (' + (rows.length - 1) + ' rows)'); }
      catch { render('Clipboard blocked by browser'); }
    };
  }

  // Auto snapshot once per 20h when the panel script loads, if a key is saved.
  const snap = last();
  if (S.key && (!snap || Date.now() - snap.t > 20 * 3600e3)) snapshot(() => {}).catch(() => {});
})();
