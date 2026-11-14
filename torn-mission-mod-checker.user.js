// ==UserScript==
// @name         Torn Mission Mod Checker
// @namespace    sterlingarcher.torn
// @version      1.0.4
// @description  Display only. Grades weapon mods in the mission rewards shop against known normal and special-offer credit ranges.
// @author       SterlingArcher
// @match        https://www.torn.com/*
// @match        https://torn.com/*
// @grant        none
// @run-at       document-idle
// @homepageURL  https://github.com/Ste5144/Torn-Script
// @updateURL    https://raw.githubusercontent.com/Ste5144/Torn-Script/main/torn-mission-mod-checker.user.js
// @downloadURL  https://raw.githubusercontent.com/Ste5144/Torn-Script/main/torn-mission-mod-checker.user.js
// ==/UserScript==

/*
  Display only: reads the page, never clicks or buys. No API key used.
  Works in Tampermonkey/Violentmonkey and Torn PDA (no GM_ functions).

  Data source: Stephen's "Weapon Mods" sheet (credit price ranges).
  Grade = where the price sits between the lowest special-offer price and
  the highest normal price for that mod.
*/

(function () {
  'use strict';
  console.log('[Mod Checker] script loaded on', location.href);
  const onMissions = () => /sid=missions/i.test(location.href);

  // ---------- Mod data (credits) ----------
  // n = normal price range, s = special offer range, use = general value tier
  const MODS = [
    // Sights
    { name: 'Reflex Sight',        type: 'Sight',      n: [599, 1049],  s: [364, 734],   bonus: 'Accuracy +1',               fits: 'MCG, PST, RFL, SMG', excl: 'Dual weapons', use: 'High' },
    { name: 'Holographic Sight',   type: 'Sight',      n: [1450, 2098], s: [708, 1468],  bonus: 'Accuracy +1.25',            fits: 'MCG, PST, RFL, SMG', excl: 'Dual weapons', use: 'High' },
    { name: 'Acog Sight',          type: 'Sight',      n: [2947, 4197], s: [1597, 2921], bonus: 'Accuracy +1.5',             fits: 'MCG, PST, RFL, SMG', excl: 'Dual weapons', use: 'High' },
    { name: 'Thermal Sight',       type: 'Sight',      n: [5908, 8399], s: [2146, 5872], bonus: 'Accuracy +1.75',            fits: 'MCG, PST, RFL, SMG', excl: 'Dual weapons', use: 'High' },
    // Lasers
    { name: '1mw Laser',           type: 'Laser',      n: [441, 749],   s: [239, 520],   bonus: 'Critical +2%',              fits: 'HRT, MCG, PST, RFL, SHT, SMG', excl: 'None', use: 'High' },
    { name: '5mw Laser',           type: 'Laser',      n: [1033, 1499], s: [645, 1041],  bonus: 'Critical +3%',              fits: 'HRT, MCG, PST, RFL, SHT, SMG', excl: 'None', use: 'High' },
    { name: '30mw Laser',          type: 'Laser',      n: [2120, 2999], s: [1075, 2095], bonus: 'Critical +4%',              fits: 'HRT, MCG, PST, RFL, SHT, SMG', excl: 'None', use: 'High' },
    { name: '100mw Laser',         type: 'Laser',      n: [4207, 6000], s: [1756, 4200], bonus: 'Critical +5%',              fits: 'HRT, MCG, PST, RFL, SHT, SMG', excl: 'None', use: 'High' },
    // Suppressors
    { name: 'Small Suppressor',    type: 'Suppressor', n: [493, 899],   s: [250, 630],   bonus: 'Stealth +3, DMG -5%',       fits: 'PST, RFL, SMG', excl: 'None', use: 'Low' },
    { name: 'Standard Suppressor', type: 'Suppressor', n: [1288, 1799], s: [622, 1266],  bonus: 'Stealth +4, DMG -5%',       fits: 'PST, RFL, SMG', excl: 'None', use: 'Low' },
    { name: 'Large Suppressor',    type: 'Suppressor', n: [5042, 7197], s: [1966, 5029], bonus: 'Stealth +5, DMG -5%',       fits: 'PST, RFL, SMG', excl: 'None', use: 'Low' },
    // Magazine sizes
    { name: 'Extended Mags',       type: 'Magazine',   n: [474, 674],   s: [235, 472],   bonus: 'Clip size +20%',            fits: 'MCG, PST, RFL, SMG', excl: 'Dual weapons', use: 'Medium' },
    { name: 'High Capacity Mags',  type: 'Magazine',   n: [1902, 2700], s: [982, 1888],  bonus: 'Clip size +30%',            fits: 'MCG, PST, RFL, SMG', excl: 'Dual weapons', use: 'Medium' },
    // Extra mags
    { name: 'Extra Clip x1',       type: 'Extra mags', n: [316, 644],   s: [104, 312],   bonus: 'Clip +1',                   fits: 'HRT, MCG, PST, RFL, SHT, SMG', excl: 'Dual weapons', use: 'Medium' },
    { name: 'Extra Clip x2',       type: 'Extra mags', n: [631, 899],   s: [422, 629],   bonus: 'Clip +2',                   fits: 'HRT, MCG, PST, RFL, SHT, SMG', excl: 'Dual weapons', use: 'Medium' },
    // Triggers
    { name: 'Adjustable Trigger',  type: 'Trigger',    n: [449, 675],   s: [250, 471],   bonus: 'Accuracy +5 on 1st turn',   fits: 'MCG, PST, RFL, SHT, SMG', excl: 'None', use: 'High' },
    { name: 'Hair Trigger',        type: 'Trigger',    n: [1914, 2700], s: [885, 1880],  bonus: 'Accuracy +7.5 on 1st turn', fits: 'MCG, PST, RFL, SHT, SMG', excl: 'None', use: 'High' },
    // Mounts
    { name: 'Bipod',               type: 'Mount',      n: [369, 522],   s: [143, 364],   bonus: 'Accuracy +1.75, Dexterity -30%', fits: 'HRT, MCG, RFL', excl: 'Dual weapons', use: 'Low' },
    { name: 'Tripod',              type: 'Mount',      n: [1493, 2099], s: [721, 1452],  bonus: 'Accuracy +2, Dexterity -30%',    fits: 'HRT, MCG, RFL', excl: 'Dual weapons', use: 'Low' },
    // Grips
    { name: 'Custom Grip',         type: 'Grip',       n: [250, 374],   s: [101, 261],   bonus: 'Accuracy +0.75',            fits: 'MCG, PST, RFL, SHT, SMG', excl: 'None', use: 'Medium' },
    // Chokes
    { name: 'Skeet Choke',         type: 'Choke',      n: [579, 824],   s: [241, 576],   bonus: 'DMG +6%',                   fits: 'SHT', excl: 'None', use: 'High' },
    { name: 'Improved Choke',      type: 'Choke',      n: [1157, 1649], s: [786, 1150],  bonus: 'DMG +8%',                   fits: 'SHT', excl: 'None', use: 'High' },
    { name: 'Full Choke',          type: 'Choke',      n: [2323, 3291], s: [958, 2298],  bonus: 'DMG +10%',                  fits: 'SHT', excl: 'None', use: 'High' },
    // Recoil pads
    { name: 'Recoil Pad',          type: 'Recoil pad', n: [526, 748],   s: [220, 524],   bonus: 'Ammo Control +25%',         fits: 'MCG, RFL, SHT', excl: 'None', use: 'Medium' },
    // Brakes
    { name: 'Standard Brake',      type: 'Brake',      n: [418, 599],   s: [178, 419],   bonus: 'Accuracy +1, Stealth -3',   fits: 'MCG, PST, RFL, SMG', excl: 'None', use: 'Medium' },
    { name: 'Heavy Duty Brake',    type: 'Brake',      n: [840, 1199],  s: [252, 839],   bonus: 'Accuracy +1.25, Stealth -3', fits: 'MCG, PST, RFL, SMG', excl: 'None', use: 'Medium' },
    { name: 'Tactical Brake',      type: 'Brake',      n: [1716, 2399], s: [946, 1655],  bonus: 'Accuracy +1.5, Stealth -3', fits: 'MCG, PST, RFL, SMG', excl: 'None', use: 'Medium' },
    // Lights
    { name: 'Small Light',         type: 'Light',      n: [407, 598],   s: [184, 419],   bonus: 'Opp accuracy -3, Opp stealth -2',   fits: 'PST, RFL, SHT, SMG', excl: 'None', use: 'Medium' },
    { name: 'Precision Light',     type: 'Light',      n: [841, 1200],  s: [442, 837],   bonus: 'Opp accuracy -4, Opp stealth -2.5', fits: 'PST, RFL, SHT, SMG', excl: 'None', use: 'Medium' },
    { name: 'Tactical Illuminator', type: 'Light',     n: [3370, 4799], s: [1812, 3334], bonus: 'Opp accuracy -5, Opp stealth -3',   fits: 'PST, RFL, SHT, SMG', excl: 'None', use: 'Medium' },
  ];

  // ---------- Settings (saved in localStorage) ----------
  const LS_KEY = 'sa_mission_mod_checker_v1';
  const DEFAULTS = {
    myTypes: 'PST, RFL',        // weapon types you would fit mods to (Derringer = PST, planned rifle = RFL)
    creditValue: 0,             // $ per credit; 0 = read from other rewards on the page
  };
  function loadSettings() {
    try { return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(LS_KEY) || '{}')); }
    catch (e) { return Object.assign({}, DEFAULTS); }
  }
  function saveSettings(s) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch (e) { /* ignore */ }
  }
  let settings = loadSettings();

  // ---------- Helpers ----------
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const MOD_INDEX = MODS.map((m) => ({ key: norm(m.name), mod: m }))
    .sort((a, b) => b.key.length - a.key.length); // longest first, so "Extra Clip x2" beats "Extra Clip"
  const fmt = (n) => Number(n).toLocaleString('en-US');
  const fmtMoney = (n) => {
    if (!isFinite(n) || n <= 0) return '?';
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'b';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'm';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(0) + 'k';
    return '$' + Math.round(n);
  };
  const parseMoney = (txt) => {
    const m = String(txt).replace(/,/g, '').match(/\$\s*([\d.]+)\s*(k|m|mil|b|bil)?/i);
    if (!m) return NaN;
    let v = parseFloat(m[1]);
    const u = (m[2] || '').toLowerCase();
    if (u === 'k') v *= 1e3;
    else if (u === 'm' || u === 'mil') v *= 1e6;
    else if (u === 'b' || u === 'bil') v *= 1e9;
    return v;
  };

  // Torn's in-game names that differ from the sheet's names.
  const byName = (n) => MODS.find((m) => m.name === n);
  const ALIASES = [
    // "Extra Magazine" = sheet's Extra Clip; two-magazine version = Extra Clip x2
    [/(2x|x2|two|double)extramagazine|extramagazines|extramagazinex2/, 'Extra Clip x2'],
    [/extramagazine/, 'Extra Clip x1'],
    [/extendedmagazine/, 'Extended Mags'],
    [/highcapacitymagazine/, 'High Capacity Mags'],
  ];
  function matchMod(text) {
    const t = norm(text);
    if (!t) return null;
    for (const [re, name] of ALIASES) if (re.test(t)) return byName(name);
    for (const { key, mod } of MOD_INDEX) if (t.includes(key)) return mod;
    return null;
  }

  // Grade a price against a mod's ranges.
  function grade(mod, price) {
    const lo = mod.s[0];
    const hi = mod.n[1];
    const p = (price - lo) / (hi - lo); // 0 = cheapest seen, 1 = dearest seen
    let label, cls;
    if (price < lo)          { label = 'Below known range: buy';      cls = 'ex'; }
    else if (p <= 0.25)      { label = 'Excellent: bottom of range';  cls = 'ex'; }
    else if (price <= mod.s[1] && p <= 0.5) { label = 'Good: special-offer price'; cls = 'gd'; }
    else if (price <= mod.s[1]) { label = 'Fair: top of special range'; cls = 'fr'; }
    else if (price <= hi)    { label = 'Poor: normal price, wait';    cls = 'pr'; }
    else                     { label = 'Above known range: skip';     cls = 'pr'; }
    const pct = Math.max(0, Math.min(100, Math.round(p * 100)));
    return { label, cls, pct, isSpecial: price <= mod.s[1] };
  }

  function fitsMine(mod) {
    const mine = settings.myTypes.split(/[,\s]+/).map((x) => x.trim().toUpperCase()).filter(Boolean);
    const fits = mod.fits.split(/[,\s]+/).map((x) => x.trim().toUpperCase()).filter(Boolean);
    const hit = mine.filter((t) => fits.includes(t));
    return hit;
  }

  function candidatesByPrice(price) {
    return MODS.filter((m) => price >= m.s[0] && price <= m.n[1]);
  }

  // ---------- Page reading ----------
  function findRewardCells() {
    const buttons = Array.from(document.querySelectorAll('button, a, span, div'))
      .filter((el) => el.children.length === 0 && /^\s*buy\s*$/i.test(el.textContent));
    const cells = [];
    for (const btn of buttons) {
      let cell = btn;
      // climb while the parent still holds only this one BUY button
      while (cell.parentElement && cell.parentElement !== document.body) {
        const parent = cell.parentElement;
        const buys = Array.from(parent.querySelectorAll('button, a, span, div'))
          .filter((el) => el.children.length === 0 && /^\s*buy\s*$/i.test(el.textContent));
        if (buys.length > 1) break;
        cell = parent;
      }
      if (!cells.includes(cell)) cells.push(cell);
    }
    return cells;
  }

  function readPrice(cell) {
    // Pure-integer text not inside the image/quantity area and not a duration (4d, 17h)
    const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
    const nums = [];
    let node;
    while ((node = walker.nextNode())) {
      const t = node.textContent.trim();
      if (!/^\d[\d,]*$/.test(t)) continue;
      const el = node.parentElement;
      if (el && el.closest('.sa-mmc-badge')) continue;
      // skip numbers sitting with the item image (quantity overlay)
      let inImg = false;
      let a = el;
      for (let i = 0; i < 3 && a && a !== cell; i++, a = a.parentElement) {
        if (a.querySelector && a.querySelector('img') && !/buy/i.test(a.textContent)) { inImg = true; break; }
      }
      if (inImg) continue;
      nums.push(parseInt(t.replace(/,/g, ''), 10));
    }
    return nums.length ? nums[0] : NaN;
  }

  // Name text from the reward only. The script's own badge is removed first: it lists
  // candidate mod names, and reading it back caused wrong matches (fixed in 1.0.4).
  function readNameText(cell) {
    const c = cell.cloneNode(true);
    c.querySelectorAll('.sa-mmc-badge').forEach((x) => x.remove());
    const bits = [];
    c.querySelectorAll('*').forEach((el) => {
      ['alt', 'title', 'aria-label', 'data-title', 'data-name', 'data-item-name', 'src'].forEach((a) => {
        const v = el.getAttribute && el.getAttribute(a);
        if (v) bits.push(v);
      });
    });
    bits.push(c.textContent || '');
    return bits.join(' | ');
  }

  function readCreditValues() {
    // "Credit value: $8,752" on tradeable rewards = $ per credit for that reward
    const vals = [];
    const re = /credit value:\s*(\$[\d,.]+\s*(?:k|m|mil|b|bil)?)/gi;
    const txt = document.body.innerText || '';
    let m;
    while ((m = re.exec(txt))) {
      const v = parseMoney(m[1]);
      if (isFinite(v) && v > 0) vals.push(v);
    }
    return vals;
  }

  // ---------- Rendering ----------
  function injectStyles() {
    if (document.getElementById('sa-mmc-style')) return;
    const st = document.createElement('style');
    st.id = 'sa-mmc-style';
    st.textContent = `
      .sa-mmc-badge{margin-top:4px;padding:4px 5px;border-radius:4px;font:11px/1.3 Arial,sans-serif;color:#fff;background:#222;border:1px solid #555;text-align:left}
      .sa-mmc-badge b{font-size:11px}
      .sa-mmc-badge .t{font-weight:bold;margin-bottom:2px}
      .sa-mmc-ex{border-color:#3fbf3f;background:#163016}
      .sa-mmc-gd{border-color:#8fd14f;background:#25301a}
      .sa-mmc-fr{border-color:#e0b030;background:#332b14}
      .sa-mmc-pr{border-color:#d04040;background:#331616}
      .sa-mmc-un{border-color:#888;background:#2a2a2a}
      .sa-mmc-bar{height:4px;background:#444;border-radius:2px;margin:3px 0;position:relative}
      .sa-mmc-bar i{position:absolute;top:-2px;width:3px;height:8px;background:#fff}
      #sa-mmc-panel{position:fixed;right:10px;top:90px;z-index:2147483647;width:250px;background:#1c1c1c;color:#fff;border:1px solid #666;border-radius:6px;font:12px Arial,sans-serif;padding:8px}
      #sa-mmc-panel input,#sa-mmc-panel select{width:100%;box-sizing:border-box;margin:2px 0 5px;background:#333;color:#fff;border:1px solid #666;padding:3px}
      #sa-mmc-panel button{background:#444;color:#fff;border:1px solid #777;padding:3px 6px;margin-right:4px;cursor:pointer}
      #sa-mmc-panel .h{font-weight:bold;cursor:pointer}
      #sa-mmc-out{margin-top:4px}
    `;
    document.head.appendChild(st);
  }

  function dollarsPerCredit() {
    if (settings.creditValue > 0) return { v: settings.creditValue, src: 'set' };
    const vals = readCreditValues().sort((a, b) => a - b);
    if (!vals.length) return { v: 0, src: 'none' };
    const med = vals[Math.floor(vals.length / 2)];
    return { v: med, src: 'page median' };
  }

  function badgeHtml(mod, price, guessList) {
    const dpc = dollarsPerCredit();
    const costLine = dpc.v > 0
      ? `Credit cost approx. ${fmtMoney(price * dpc.v)} in other rewards (${fmtMoney(dpc.v)}/credit, ${dpc.src})`
      : '';
    if (!mod) {
      const g = guessList && guessList.length
        ? 'Price fits: ' + guessList.map((m) => m.name).join(', ')
        : 'Not a known mod';
      return { cls: 'un', html: `<div class="t">Mod not identified (${fmt(price)} cr)</div><div>${g}</div><div>Hover the item for its name, then use the panel checker.</div>${costLine ? `<div>${costLine}</div>` : ''}` };
    }
    const g = grade(mod, price);
    const mine = fitsMine(mod);
    const fitTxt = mine.length ? `Fits your ${mine.join('/')}` : `Does not fit your ${settings.myTypes}`;
    const useTxt = mod.use === 'Low' ? 'Low value mod' : mod.use + ' value mod';
    return {
      cls: g.cls,
      html: `<div class="t">${mod.name}: ${g.label}</div>
        <div class="sa-mmc-bar"><i style="left:${g.pct}%"></i></div>
        <div>${fmt(price)} cr. Special ${fmt(mod.s[0])} to ${fmt(mod.s[1])}; normal ${fmt(mod.n[0])} to ${fmt(mod.n[1])}</div>
        <div>${mod.bonus}. ${useTxt}. ${fitTxt}${mod.excl !== 'None' ? '; not on ' + mod.excl.toLowerCase() : ''}</div>
        ${costLine ? `<div>${costLine}</div>` : ''}`,
    };
  }

  function scan() {
    const cells = findRewardCells();
    cells.forEach((cell) => {
      const price = readPrice(cell);
      if (!isFinite(price)) return;
      const text = readNameText(cell);
      const mod = matchMod(text);
      // Mods are untradeable, so the page shows no "Total value" for them
      const noValue = !/total value/i.test(text);
      if (!mod && !noValue) return; // tradeable item, not a mod

      const sig = (mod ? mod.name : '?') + '|' + price + '|' + settings.myTypes + '|' + settings.creditValue;
      let badge = cell.querySelector(':scope > .sa-mmc-badge');
      if (badge && badge.dataset.sig === sig) return;
      if (!badge) {
        badge = document.createElement('div');
        badge.className = 'sa-mmc-badge';
        cell.appendChild(badge);
      }
      const b = badgeHtml(mod, price, mod ? null : candidatesByPrice(price));
      badge.className = 'sa-mmc-badge sa-mmc-' + b.cls;
      badge.innerHTML = b.html;
      badge.dataset.sig = sig;
    });
  }

  function buildPanel() {
    if (document.getElementById('sa-mmc-panel')) return;
    const p = document.createElement('div');
    p.id = 'sa-mmc-panel';
    const opts = MODS.map((m, i) => `<option value="${i}">${m.type}: ${m.name}</option>`).join('');
    p.innerHTML = `
      <div class="h" id="sa-mmc-toggle">Mod Checker v1.0.4 [–]</div>
      <div id="sa-mmc-body">
        <label>Manual check: mod</label>
        <select id="sa-mmc-mod">${opts}</select>
        <label>Price (credits)</label>
        <input id="sa-mmc-price" type="number" min="1" placeholder="e.g. 1721">
        <div id="sa-mmc-out"></div>
        <hr style="border-color:#444">
        <label>My weapon types (PST, RFL, SMG, SHT, MCG, HRT)</label>
        <input id="sa-mmc-types" value="${settings.myTypes}">
        <label>$ per credit (0 = read from page)</label>
        <input id="sa-mmc-dpc" type="number" min="0" value="${settings.creditValue}">
        <button id="sa-mmc-save">Save</button><button id="sa-mmc-debug">Debug</button>
      </div>`;
    document.body.appendChild(p);

    const out = p.querySelector('#sa-mmc-out');
    const runManual = () => {
      const mod = MODS[+p.querySelector('#sa-mmc-mod').value];
      const price = +p.querySelector('#sa-mmc-price').value;
      if (!price) { out.innerHTML = ''; return; }
      const b = badgeHtml(mod, price);
      out.innerHTML = `<div class="sa-mmc-badge sa-mmc-${b.cls}">${b.html}</div>`;
    };
    p.querySelector('#sa-mmc-mod').addEventListener('change', runManual);
    p.querySelector('#sa-mmc-price').addEventListener('input', runManual);
    p.querySelector('#sa-mmc-save').addEventListener('click', () => {
      settings.myTypes = p.querySelector('#sa-mmc-types').value || DEFAULTS.myTypes;
      settings.creditValue = Math.max(0, +p.querySelector('#sa-mmc-dpc').value || 0);
      saveSettings(settings);
      scan(); runManual();
    });
    p.querySelector('#sa-mmc-debug').addEventListener('click', () => {
      const cells = findRewardCells();
      const dump = cells.map((c, i) => `--- cell ${i} price=${readPrice(c)} ---\n${c.outerHTML.slice(0, 3000)}`).join('\n\n');
      console.log('[Mod Checker] reward cells:\n' + dump);
      try { navigator.clipboard.writeText(dump); out.textContent = `Copied ${cells.length} reward cells to clipboard (also in console).`; }
      catch (e) { out.textContent = `Logged ${cells.length} reward cells to console.`; }
    });
    const body = p.querySelector('#sa-mmc-body');
    p.querySelector('#sa-mmc-toggle').addEventListener('click', (e) => {
      const hide = body.style.display !== 'none';
      body.style.display = hide ? 'none' : '';
      e.target.textContent = 'Mod Checker v1.0.4 ' + (hide ? '[+]' : '[–]');
    });
  }

  // ---------- Start ----------
  // Torn changes pages without full reloads, so check the address every second.
  let timer = null;
  let obs = null;
  function start() {
    injectStyles();
    buildPanel();
    if (!obs) {
      obs = new MutationObserver((muts) => {
        if (muts.every((m) => m.target.closest && m.target.closest('.sa-mmc-badge, #sa-mmc-panel'))) return;
        clearTimeout(timer);
        timer = setTimeout(scan, 400);
      });
      obs.observe(document.body, { childList: true, subtree: true });
    }
    scan();
  }
  function stop() {
    if (obs) { obs.disconnect(); obs = null; }
    const p = document.getElementById('sa-mmc-panel');
    if (p) p.remove();
  }
  function check() {
    try { onMissions() ? start() : stop(); }
    catch (e) { console.error('[Mod Checker] error', e); }
  }
  const boot = () => { check(); setInterval(check, 1000); };
  if (document.body) boot(); else window.addEventListener('DOMContentLoaded', boot);
})();
