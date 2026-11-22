// ==UserScript==
// @name         Torn Bazaar Scalper (display only)
// @namespace    sterlingarcher.scalper
// @version      1.0.0
// @description  Display only. On any bazaar, badges each item with its resale value (lowest item market listing less tax, or Torn market value) and profit at the bazaar price. Green = beats your margin. Public API key only; never buys.
// @author       SterlingArcher
// @match        https://www.torn.com/bazaar.php*
// @grant        none
// @run-at       document-idle
// @homepageURL  https://github.com/Ste5144/Torn-Script
// @updateURL    https://raw.githubusercontent.com/Ste5144/Torn-Script/main/torn-bazaar-scalper.user.js
// @downloadURL  https://raw.githubusercontent.com/Ste5144/Torn-Script/main/torn-bazaar-scalper.user.js
// ==/UserScript==

/*
  RULES
  - Display only: never clicks or buys. Reads the official Torn API v2 with a PUBLIC key.
  - Endpoints: torn/items (market value, NPC sell price; cached 1 h here) and
    market/{id}/itemmarket (lowest listings; Torn caches this globally for up to 1 hour).
  - The item market lookup is made only for items already priced under market value (candidates),
    1 call per 0.8 s, cached 10 min, so a large bazaar does not hit the 100 calls/min limit.
  - Works in Tampermonkey/Violentmonkey and Torn PDA (no GM_ functions).
*/

(function () {
  'use strict';
  if (window.__bzScalper) return;
  window.__bzScalper = true;
  const VERSION = '1.0.0';
  const LS = 'bzScalper.cfg';
  const API = 'https://api.torn.com/v2/';
  const DEF = {
    key: '',
    minProfit: 100000, // $ profit per item needed for green
    minPct: 5,         // % profit needed for green
    sellVia: 'market', // market = item market (5% tax), bazaar = your bazaar (no tax, slower)
    tax: 5,
    undercut: 1,       // $ below the lowest listing you would list at
  };
  let S = load();
  function load() { try { return Object.assign({}, DEF, JSON.parse(localStorage.getItem(LS) || '{}')); } catch (e) { return Object.assign({}, DEF); } }
  function save() { try { localStorage.setItem(LS, JSON.stringify(S)); } catch (e) { /* ignore */ } }
  const keyOk = () => /^[A-Za-z0-9]{16}$/.test(S.key);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function money(v) {
    if (!isFinite(v)) return '?';
    const a = Math.abs(v), s = v < 0 ? '−$' : '$';
    if (a >= 1e9) return s + (a / 1e9).toFixed(2) + 'b';
    if (a >= 1e6) return s + (a / 1e6).toFixed(2) + 'm';
    if (a >= 1e4) return s + Math.round(a / 1e3) + 'k';
    return s + Math.round(a).toLocaleString('en-US');
  }

  // ---------- API ----------
  let lastCall = 0;
  let queue = Promise.resolve();
  let apiErr = '';
  function api(path, params) {
    const run = async () => {
      if (!keyOk()) throw new Error('Set a Public API key (Scalper button, bottom right).');
      const wait = lastCall + 800 - Date.now();
      if (wait > 0) await sleep(wait);
      lastCall = Date.now();
      const q = new URLSearchParams(Object.assign({}, params || {}, { key: S.key, comment: 'BazaarScalper' }));
      const j = await (await fetch(API + path + '?' + q.toString())).json();
      if (j && j.error) throw new Error('Torn API error ' + j.error.code + ': ' + j.error.error);
      return j;
    };
    const p = queue.then(run, run);
    queue = p.catch(() => {});
    return p;
  }

  // Item values (all items, one call per hour).
  let ITEMS = null; // id -> {name, mv, sell, tradable}
  async function loadItems() {
    if (ITEMS) return ITEMS;
    try {
      const c = JSON.parse(localStorage.getItem('bzScalper.items') || 'null');
      if (c && Date.now() - c.ts < 3600e3) { ITEMS = c.map; return ITEMS; }
    } catch (e) { /* ignore */ }
    const j = await api('torn/items', {});
    const map = {};
    (j.items || []).forEach((i) => {
      const v = i.value || {};
      map[i.id] = { name: i.name, mv: v.market_price || 0, sell: v.sell_price || 0, tradable: i.is_tradable !== false };
    });
    ITEMS = map;
    try { localStorage.setItem('bzScalper.items', JSON.stringify({ ts: Date.now(), map })); } catch (e) { /* ignore */ }
    return ITEMS;
  }

  // Lowest item market listings (cached 10 min per item).
  const IM = {};
  try { Object.assign(IM, JSON.parse(localStorage.getItem('bzScalper.im') || '{}')); } catch (e) { /* ignore */ }
  const imPending = new Set();
  async function lowest(id) {
    const c = IM[id];
    if (c && Date.now() - c.ts < 600e3) return c;
    if (imPending.has(id)) return null;
    imPending.add(id);
    try {
      const j = await api('market/' + id + '/itemmarket', { limit: 5 });
      const L = ((j.itemmarket && j.itemmarket.listings) || []).map((x) => x.price).filter((x) => x > 0).sort((a, b) => a - b);
      IM[id] = { ts: Date.now(), low: L[0] || 0, second: L[1] || 0, avg: (j.itemmarket && j.itemmarket.item && j.itemmarket.item.average_price) || 0, cached: (j.itemmarket && j.itemmarket.cache_timestamp) || 0 };
      const now = Date.now();
      Object.keys(IM).forEach((k) => { if (now - IM[k].ts > 3 * 3600e3) delete IM[k]; });
      try { localStorage.setItem('bzScalper.im', JSON.stringify(IM)); } catch (e) { /* ignore */ }
      return IM[id];
    } finally { imPending.delete(id); }
  }

  // ---------- Page reading ----------
  // Each bazaar item card holds one item image (/images/items/<id>/...) and a $ price.
  function cards() {
    const out = [];
    const seen = new Set();
    document.querySelectorAll('img[src*="/images/items/"]').forEach((img) => {
      if (img.closest('.bzs-badge, #bzs-panel')) return;
      const m = (img.getAttribute('src') || '').match(/\/images\/items\/(\d+)\//);
      if (!m) return;
      let el = img.parentElement;
      for (let i = 0; i < 7 && el; i++, el = el.parentElement) {
        if (el.querySelectorAll('img[src*="/images/items/"]').length > 1) { el = null; break; }
        const price = priceIn(el);
        if (isFinite(price)) {
          if (seen.has(el)) break;
          seen.add(el);
          out.push({ el, id: +m[1], price, qty: qtyIn(el) });
          break;
        }
      }
    });
    return out;
  }
  function ownText(el) {
    let t = '';
    const walk = (n) => {
      if (n.nodeType === 3) t += n.textContent + ' ';
      else if (n.nodeType === 1 && !n.classList.contains('bzs-badge')) n.childNodes.forEach(walk);
    };
    walk(el);
    return t.replace(/\s+/g, ' ');
  }
  function priceIn(el) {
    const m = ownText(el).match(/\$\s?([\d,]{1,15})/);
    return m ? +m[1].replace(/,/g, '') : NaN;
  }
  function qtyIn(el) {
    const t = ownText(el);
    const m = t.match(/\((\d[\d,]*)\)/) || t.match(/\bx\s?(\d[\d,]*)\b/i) || t.match(/(\d[\d,]*)\s+in stock/i);
    return m ? +m[1].replace(/,/g, '') : 1;
  }

  // ---------- Valuation ----------
  function judge(c, it, im) {
    const taxM = S.sellVia === 'market' ? 1 - (S.tax || 0) / 100 : 1;
    let basis = 0, src = '';
    if (im && im.low > 0) { basis = Math.max(0, im.low - (S.undercut || 0)); src = 'lowest listing'; }
    else if (it.mv > 0) { basis = it.mv; src = 'market value'; }
    let net = basis * taxM;
    // Selling to the NPC shop is instant and tax-free; use it when it pays more.
    const npc = it.sell > 0 && c.price < it.sell ? it.sell - c.price : 0;
    if (it.sell > net) { net = it.sell; src = 'NPC shop'; }
    const profit = net - c.price;
    const pct = c.price > 0 ? profit / c.price * 100 : NaN;
    const ok = profit >= S.minProfit && pct >= S.minPct;
    const near = !ok && profit > 0;
    return { basis, src, net, profit, pct, npc, ok, near, total: profit * (c.qty || 1) };
  }

  // ---------- Badges ----------
  const CSS = `
    .bzs-badge{display:block;margin:3px 2px 2px;padding:2px 5px;border-radius:4px;font:11px/1.3 Arial,sans-serif;color:#fff !important;background:#2a2a2a;border:1px solid #555;text-align:left;white-space:normal}
    .bzs-badge b{color:#fff !important}
    .bzs-badge.ok{background:#163016;border-color:#3fbf3f}
    .bzs-badge.near{background:#332b14;border-color:#e0b030}
    .bzs-badge.dear{background:#2a2a2a;border-color:#555;opacity:.8}
    .bzs-badge .m{color:#cfcfcf !important}
    .bzs-hl{outline:2px solid #3fbf3f !important;outline-offset:-2px}
    #bzs-btn{position:fixed;right:10px;bottom:70px;z-index:2147483646;background:#2e6b3a;color:#fff;border:none;border-radius:18px;padding:6px 11px;font:bold 12px Arial,sans-serif;cursor:pointer}
    #bzs-panel{position:fixed;right:10px;bottom:108px;z-index:2147483647;width:330px;max-height:70vh;overflow:auto;background:#17151d;color:#eee;border:1px solid #555;border-radius:8px;padding:9px;font:12px Arial,sans-serif}
    #bzs-panel input,#bzs-panel select{width:100%;box-sizing:border-box;background:#0f0d15;color:#eee;border:1px solid #555;border-radius:4px;padding:3px;margin:2px 0 6px}
    #bzs-panel button{background:#2e6b3a;color:#fff;border:none;border-radius:4px;padding:4px 9px;cursor:pointer;margin-right:4px}
    #bzs-panel table{width:100%;border-collapse:collapse;margin-top:6px}
    #bzs-panel td{padding:2px 3px;border-top:1px solid #333}
    #bzs-panel .num{text-align:right}
    #bzs-panel .m{color:#aaa}
  `;
  function badge(c, it, im) {
    let b = c.el.querySelector(':scope > .bzs-badge');
    if (!b) { b = document.createElement('div'); b.className = 'bzs-badge'; c.el.appendChild(b); b.addEventListener('click', (e) => e.stopPropagation()); }
    if (!it) { b.className = 'bzs-badge dear'; b.innerHTML = '<span class="m">Unknown item</span>'; return null; }
    if (!it.tradable) { b.className = 'bzs-badge dear'; b.innerHTML = '<span class="m">Not tradable</span>'; return null; }
    const j = judge(c, it, im);
    c.el.classList.toggle('bzs-hl', j.ok);
    b.className = 'bzs-badge ' + (j.ok ? 'ok' : j.near ? 'near' : 'dear');
    const pending = !im && imPending.has(c.id);
    const via = S.sellVia === 'market' ? `less ${S.tax}% tax` : 'no tax';
    const head = j.ok
      ? `<b>CHEAP: +${money(j.profit)} (${j.pct.toFixed(1)}%)</b>${c.qty > 1 ? ` · ${c.qty} × = <b>${money(j.total)}</b>` : ''}`
      : j.profit > 0 ? `<b>+${money(j.profit)} (${j.pct.toFixed(1)}%)</b>, under your margin` : `<b>${money(j.profit)}</b> at this price`;
    const npc = j.src === 'NPC shop' ? ` · <b>sell to NPC shop for ${money(it.sell)}</b>` : '';
    const ref = im && im.low ? `Lowest ${money(im.low)}${im.second ? ', next ' + money(im.second) : ''}` : `Market value ${money(it.mv)}${pending ? ' · checking listings…' : ''}`;
    b.innerHTML = `${head}${npc}<br><span class="m">${ref} · resale ${money(j.net)} (${j.src === 'NPC shop' ? 'NPC shop, no tax' : via})</span>`;
    return Object.assign({ id: c.id, name: it.name, price: c.price, qty: c.qty }, j);
  }

  // ---------- Scan ----------
  let busy = false;
  let rows = [];
  async function scan() {
    if (busy) return;
    busy = true;
    try {
      const cs = cards();
      if (!cs.length) return;
      if (!keyOk()) { cs.forEach((c) => { let b = c.el.querySelector(':scope > .bzs-badge'); if (!b) { b = document.createElement('div'); b.className = 'bzs-badge dear'; c.el.appendChild(b); } b.innerHTML = '<span class="m">Scalper: add a Public API key (button bottom right)</span>'; }); return; }
      const items = await loadItems();
      rows = cs.map((c) => badge(c, items[c.id], IM[c.id])).filter(Boolean);
      renderList();
      // Check live listings only for candidates priced below market value.
      const cand = [...new Set(cs.filter((c) => { const it = items[c.id]; return it && it.tradable && it.mv > 0 && c.price < it.mv; }).map((c) => c.id))]
        .filter((id) => !(IM[id] && Date.now() - IM[id].ts < 600e3));
      for (const id of cand) {
        try { await lowest(id); apiErr = ''; } catch (e) { apiErr = e.message; break; }
        rows = cards().map((c) => badge(c, items[c.id], IM[c.id])).filter(Boolean);
        renderList();
      }
    } catch (e) {
      apiErr = e.message || String(e);
      renderList();
    } finally { busy = false; }
  }

  // ---------- Panel ----------
  function renderList() {
    const box = document.getElementById('bzs-list');
    if (!box) return;
    const best = rows.filter((r) => r.profit > 0).sort((a, b) => b.total - a.total).slice(0, 15);
    box.innerHTML = (apiErr ? `<div style="color:#ff9a9a">${esc(apiErr)}</div>` : '')
      + (best.length ? `<table><tr class="m"><td>Item</td><td class="num">Price</td><td class="num">Profit</td></tr>${best.map((r) => `<tr><td>${r.ok ? '✅ ' : ''}${esc(r.name)}${r.qty > 1 ? ' ×' + r.qty : ''}</td><td class="num">${money(r.price)}</td><td class="num">${money(r.profit)}<br><span class="m">${r.pct.toFixed(1)}%</span></td></tr>`).join('')}</table>`
        : '<div class="m">No profitable items on this page.</div>');
  }
  function panel() {
    let p = document.getElementById('bzs-panel');
    if (p) { p.remove(); return; }
    p = document.createElement('div');
    p.id = 'bzs-panel';
    p.innerHTML = `<b>Bazaar Scalper ${VERSION}</b> <span class="m">display only</span>
      <div style="margin-top:6px">Public API key<input id="bzs-key" value="${esc(S.key)}" maxlength="16"></div>
      Green when profit is at least $<input id="bzs-min" type="number" value="${S.minProfit}">
      and at least %<input id="bzs-pct" type="number" step="0.5" value="${S.minPct}">
      Sell via<select id="bzs-via"><option value="market" ${S.sellVia === 'market' ? 'selected' : ''}>Item market (${S.tax}% tax, fast)</option><option value="bazaar" ${S.sellVia === 'bazaar' ? 'selected' : ''}>My bazaar (no tax, slower)</option></select>
      <button id="bzs-save">Save</button><button id="bzs-re">Recheck prices</button>
      <div class="m" style="margin-top:6px">Resale = lowest item market listing less $${S.undercut}, then tax. Torn caches listings for up to an hour, so check the item market before buying big.</div>
      <div id="bzs-list"></div>`;
    document.body.appendChild(p);
    p.querySelector('#bzs-save').onclick = () => {
      const k = p.querySelector('#bzs-key').value.trim();
      if (k && !/^[A-Za-z0-9]{16}$/.test(k)) { alertBox('Key should be 16 letters and numbers.'); return; }
      S.key = k; S.minProfit = Math.max(0, +p.querySelector('#bzs-min').value || 0); S.minPct = Math.max(0, +p.querySelector('#bzs-pct').value || 0); S.sellVia = p.querySelector('#bzs-via').value;
      save(); scan();
    };
    p.querySelector('#bzs-re').onclick = () => { Object.keys(IM).forEach((k) => delete IM[k]); ITEMS = null; try { localStorage.removeItem('bzScalper.items'); localStorage.removeItem('bzScalper.im'); } catch (e) { /* ignore */ } scan(); };
    renderList();
  }
  function alertBox(t) { const l = document.getElementById('bzs-list'); if (l) l.innerHTML = `<div style="color:#ff9a9a">${esc(t)}</div>`; }

  function boot() {
    const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    const b = document.createElement('button'); b.id = 'bzs-btn'; b.textContent = 'Scalper'; b.onclick = panel; document.body.appendChild(b);
    let tmr = null;
    new MutationObserver((muts) => {
      if (muts.every((m) => m.target.closest && m.target.closest('.bzs-badge, #bzs-panel'))) return;
      clearTimeout(tmr); tmr = setTimeout(scan, 600);
    }).observe(document.body, { childList: true, subtree: true });
    setTimeout(scan, 1000);
  }
  if (document.body) boot(); else window.addEventListener('DOMContentLoaded', boot);
})();
