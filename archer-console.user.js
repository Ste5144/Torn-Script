// ==UserScript==
// @name         Archer Console (Torn weapon and auction dashboard)
// @namespace    sterlingarcher.torn
// @version      1.5.0
// @description  Display only. Auction history with ceiling bids, item market finder, weapon ranking index, mod price reference. Public API key only.
// @author       SterlingArcher
// @match        https://www.torn.com/*
// @grant        none
// @run-at       document-idle
// @homepageURL  https://github.com/Ste5144/Torn-Script
// @updateURL    https://raw.githubusercontent.com/Ste5144/Torn-Script/main/archer-console.user.js
// @downloadURL  https://raw.githubusercontent.com/Ste5144/Torn-Script/main/archer-console.user.js
// ==/UserScript==

/*
  RULES
  - Display only: never clicks, bids or buys. Reads the official Torn API v2 with a PUBLIC key.
  - Endpoints used (all "public access"): market/{id}/auctionhouse, market/auctionhouse,
    market/{id}/itemmarket, torn/items.
  - Requests are queued at 1 per second by default (Torn limit is 100 per minute per key).
  - Live auctions are not in the API: paste rows from the Swervelord live floor into the Import tab.
  - Works in Tampermonkey/Violentmonkey and Torn PDA (no GM_ functions).
*/

(function () {
  'use strict';
  if (window.__archerConsole) return;
  window.__archerConsole = true;

  const VERSION = '1.5.0';
  const LS = 'archer_console_v1';
  const API = 'https://api.torn.com/v2/';

  // ================= Settings =================
  const DEFAULTS = {
    key: '',
    armour: 50,        // % of damage the target's armour absorbs (assumption for index)
    critChance: 12,    // % base crit chance (assumption)
    critMult: 3,       // crit damage multiple vs a normal hit (assumption)
    days: 180,         // history window for comparables
    gapMs: 1000,       // spacing between API calls
    minComps: 5,       // comparable sales needed before a deal is graded
    gradeWithinMin: 60, // auctions are graded only when ending within this many minutes
    dmgPerPt: 2.26,    // % more damage per weapon damage point (mug's guide: 10 points ≈ 25%)
    myTypes: 'PST, RFL',
  };
  let S = load();
  function load() {
    try { return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(LS) || '{}')); }
    catch (e) { return Object.assign({}, DEFAULTS); }
  }
  function save() { try { localStorage.setItem(LS, JSON.stringify(S)); } catch (e) { /* ignore */ } }

  // ================= Helpers =================
  const $ = (sel, root) => (root || document).querySelector(sel);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n, d = 0) => (n == null || !isFinite(n) ? '–' : Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
  const money = (n) => {
    if (n == null || !isFinite(n)) return '–';
    const a = Math.abs(n);
    if (a >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'b';
    if (a >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'm';
    if (a >= 1e3) return '$' + (n / 1e3).toFixed(0) + 'k';
    return '$' + Math.round(n);
  };
  const parseMoney = (t) => {
    const m = String(t).replace(/,/g, '').match(/\$?\s*([\d.]+)\s*(k|m|mil|b|bil)?/i);
    if (!m) return NaN;
    let v = parseFloat(m[1]);
    const u = (m[2] || '').toLowerCase();
    if (u === 'k') v *= 1e3; else if (u[0] === 'm') v *= 1e6; else if (u[0] === 'b') v *= 1e9;
    return v;
  };
  const ago = (ts) => {
    const s = Date.now() / 1000 - ts;
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago';
    return Math.round(s / 86400) + 'd ago';
  };
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ================= Bonus maths (index) =================
  // Returns the average-damage multiplier for one bonus, using the settings' assumptions.
  function bonusMult(title, value) {
    const t = norm(title);
    const v = (Number(value) || 0) / 100;
    const a = Math.min(0.95, Math.max(0, S.armour / 100));
    const c = Math.min(1, Math.max(0, S.critChance / 100));
    const M = Math.max(1, S.critMult);
    const base = 1 - c + c * M;
    switch (t) {
      case 'powerful':
      case 'specialist':
        return 1 + v;
      case 'puncture': // chance to ignore armour completely
        return a >= 1 ? 1 : ((1 - v) * (1 - a) + v) / (1 - a);
      case 'penetrate': // ignores v of armour mitigation on every hit
        return a >= 1 ? 1 : (1 - a * (1 - v)) / (1 - a);
      case 'deadeye': // crit damage +v
        return (1 - c + c * M * (1 + v)) / base;
      case 'expose': { // crit chance +v (percentage points)
        const c2 = Math.min(1, c + v);
        return (1 - c2 + c2 * M) / base;
      }
      default:
        return 1; // situational or non-damage bonuses are not scored
    }
  }
  const SCORED = ['powerful', 'specialist', 'puncture', 'penetrate', 'deadeye', 'expose'];
  // Index: 100 = a 70-damage weapon with no scored bonus. Damage compounds per point (guide rule).
  function dmgFactor(dmg) { return Math.pow(1 + (S.dmgPerPt || 0) / 100, dmg - 70); }
  function indexOf(dmg, bonuses) {
    if (!isFinite(dmg)) return NaN;
    let m = 1;
    (bonuses || []).forEach((b) => { m *= bonusMult(b.t, b.v); });
    return 100 * dmgFactor(dmg) * m;
  }

  // mug's Legendary Guide (Torn forums): damage tier and roll ranges by colour (Y, O, R).
  const GUIDE = {
    eviscerate: ['God', [15, 19], [19, 24], [25, 32]],
    execute: ['Below God', [15, 17], [18, 22], [23, 29]],
    bleed: ['Below God', [20, 30], [31, 49], [50, 67]],
    specialist: ['Below God', [20, 28], [28, 37], [40, 59]],
    fury: ['A', [10, 15], [16, 23], [26, 34]],
    deadeye: ['A', [25, 44], [45, 74], [76, 118]],
    rage: ['A', [4, 6], [6, 10], [12, 15]],
    expose: ['A', [7, 9], [9, 13], [14, 21]],
    penetrate: ['A', [25, 29], [30, 37], [41, 49]],
    puncture: ['A', [20, 27], [28, 38], [41, 54]],
    powerful: ['A', [15, 21], [22, 32], [33, 43]],
    quicken: ['B', [50, 86], [96, 145], [155, 219]],
    motivation: ['B', [15, 19], [19, 23], [25, 35]],
    empower: ['B', [50, 86], [90, 140], [156, 234]],
    focus: ['B?', [15, 19], [20, 24], [26, 34]],
    sureshot: ['C', [3, 4], [5, 6], [8, 11]],
    deadly: ['C', [2, 3], [3, 5], [8, 10]],
    frenzy: ['C', [5, 6], [7, 10], [10, 13]],
    demoralize: ['C', [20, 23], null, null],
    assassinate: ['D', [50, 69], [70, 99], [100, 141]],
    blindside: ['D', [25, 39], [40, 59], [70, 94]],
    finale: ['D', [10, 11], [12, 13], [14, 17]],
    throttle: ['D', [50, 74], [75, 110], [120, 170]],
    cupid: ['D', [50, 74], [75, 110], [124, 157]],
    crusher: ['D', [50, 74], [75, 99], [120, 133]],
    roshambo: ['D', [50, 74], [75, 101], [131, 132]],
    windup: ['D', [125, 142], [147, 170], [177, 220]],
    doubletap: ['D', [15, 23], [25, 35], [36, 42]],
    wither: ['D', [20, 28], [29, 41], [43, 60]],
    weaken: ['D', [20, 28], [29, 41], [43, 63]],
    slow: ['D', [20, 28], [29, 41], [43, 61]],
    comeback: ['F', [50, 69], [70, 99], [100, 127]],
    berserk: ['F', [20, 34], [35, 59], [60, 73]],
    grace: ['F', [20, 34], [35, 52], [53, 60]],
    achilles: ['F', [50, 74], [75, 99], [100, 168]],
    doubleedged: ['F', [10, 15], [17, 24], [25, 32]],
    cripple: ['F', [20, 28], [29, 41], [43, 58]],
    paralyze: ['F', [5, 7], [8, 10], [11, 15]],
    conserve: ['Utility', [25, 29], [30, 36], [38, 49]],
    backstab: ['Utility', [30, 39], [40, 59], [60, 79]],
    warlord: ['Support A', [15, 19], [20, 27], [28, 37]],
    revitalize: ['Support God', [10, 13], [13, 16], [18, 24]],
    bloodlust: ['Support God', [10, 12], [12, 14], [15, 17]],
    plunder: ['Support God', [20, 25], [26, 33], [36, 45]],
    stun: ['Support', [10, 15], [16, 23], [25, 40]],
    suppress: ['Support', [25, 30], [33, 37], [43, 49]],
    disarm: ['Support', [3, 5], [5, 8], [10, 15]],
    stricken: ['Support B', [30, 43], [45, 53], [69, 85]],
  };
  // e.g. "A tier · orange 30–37 · low"
  function guideNote(title, v, rarity) {
    const g = GUIDE[norm(title)];
    if (!g) return '';
    // Judge each bonus by its own value: a weapon's colour comes from its best bonus,
    // so a second bonus can be a lower-colour roll. Use the band that contains the value,
    // else the highest band it reaches; the weapon's colour only breaks ties.
    const cols = { yellow: 1, orange: 2, red: 3 };
    let ci = 0;
    const inside = [1, 2, 3].filter((i) => g[i] && v >= g[i][0] && v <= g[i][1]);
    if (inside.length) ci = inside.includes(cols[rarity]) ? cols[rarity] : inside[inside.length - 1];
    if (!ci) for (let i = 3; i >= 1; i--) if (g[i] && v >= g[i][0]) { ci = i; break; }
    if (!ci) ci = 1;
    const band = g[ci];
    let pos = '';
    if (band) {
      const f = band[1] > band[0] ? (v - band[0]) / (band[1] - band[0]) : 0.5;
      pos = v < band[0] ? 'below range' : v > band[1] ? 'above range' : f < 1 / 3 ? 'low roll' : f < 2 / 3 ? 'mid roll' : 'high roll';
    }
    const cname = ['', 'yellow', 'orange', 'red'][ci];
    return `${g[0]} tier · ${cname} ${band ? band[0] + '–' + band[1] + '%' : '?'} · ${pos}`;
  }
  function multOf(bonuses) {
    let m = 1;
    (bonuses || []).forEach((b) => { m *= bonusMult(b.t, b.v); });
    return m;
  }

  // ================= API queue =================
  let lastCall = 0;
  let apiQueue = Promise.resolve();
  function api(path, params) {
    const run = async () => {
      if (!/^[A-Za-z0-9]{16}$/.test(S.key)) throw new Error('Set a 16-character Public API key in Settings.');
      const wait = lastCall + S.gapMs - Date.now();
      if (wait > 0) await sleep(wait);
      const q = new URLSearchParams(Object.assign({}, params || {}, { key: S.key, comment: 'ArcherConsole' }));
      for (let attempt = 0; attempt < 3; attempt++) {
        lastCall = Date.now();
        const res = await fetch(API + path + '?' + q.toString());
        const j = await res.json();
        if (j && j.error) {
          if (j.error.code === 5) { status('Torn rate limit hit; waiting 30s…'); await sleep(30000); continue; }
          throw new Error('Torn API error ' + j.error.code + ': ' + j.error.error);
        }
        return j;
      }
      throw new Error('Torn API: rate limited three times; try later.');
    };
    const p = apiQueue.then(run, run);
    apiQueue = p.catch(() => {});
    return p;
  }

  // ================= IndexedDB cache of auction sales =================
  const DB_NAME = 'archer-console';
  let dbp = null;
  function db() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains('sales')) d.createObjectStore('sales', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    return dbp;
  }
  async function dbAll(store) {
    const d = await db();
    return new Promise((res, rej) => {
      const r = d.transaction(store).objectStore(store).getAll();
      r.onsuccess = () => res(r.result || []);
      r.onerror = () => rej(r.error);
    });
  }
  async function dbPut(store, rows) {
    const d = await db();
    return new Promise((res, rej) => {
      const tx = d.transaction(store, 'readwrite');
      const os = tx.objectStore(store);
      rows.forEach((x) => os.put(x));
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  }
  async function kvGet(k) {
    const d = await db();
    return new Promise((res) => {
      const r = d.transaction('kv').objectStore('kv').get(k);
      r.onsuccess = () => res(r.result);
      r.onerror = () => res(undefined);
    });
  }
  async function kvSet(k, v) {
    const d = await db();
    return new Promise((res) => {
      const tx = d.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(v, k);
      tx.oncomplete = () => res();
      tx.onerror = () => res();
    });
  }
  async function clearSales() {
    const d = await db();
    return new Promise((res) => {
      const tx = d.transaction('sales', 'readwrite');
      tx.objectStore('sales').clear();
      tx.oncomplete = () => res();
    });
  }

  let SALES = [];          // in-memory cache
  let ITEMS = [];          // [{id,name,type,sub}] weapons and armour

  function normSale(e) {
    const it = e.item || {};
    const st = it.stats || {};
    if (!(it.type === 'Weapon' || it.type === 'Armor')) return null;
    return {
      id: e.id,
      ts: e.timestamp,
      price: e.price,
      bids: e.bids,
      itemId: it.id,
      name: it.name,
      type: it.type,
      sub: it.sub_type || '',
      rarity: (it.rarity || '').toLowerCase() || null,
      q: st.quality,
      dmg: st.damage,
      acc: st.accuracy,
      arm: st.armor,
      b: (it.bonuses || []).map((x) => ({ t: x.title, v: x.value })),
      seller: e.seller ? e.seller.name : '',
      buyer: e.buyer ? e.buyer.name : '',
    };
  }

  // Pull completed sales for one item, newest first, until the cache already holds them or maxPages.
  async function fetchItemHistory(itemId, maxPages) {
    let to = null;
    let added = 0;
    const have = new Set(SALES.filter((s) => s.itemId === itemId).map((s) => s.id));
    for (let p = 0; p < maxPages; p++) {
      const params = { limit: 100, sort: 'DESC' };
      if (to) params.to = to;
      const j = await api('market/' + itemId + '/auctionhouse', params);
      const rows = (j.auctionhouse || []).map(normSale).filter(Boolean);
      const fresh = rows.filter((r) => !have.has(r.id));
      if (fresh.length) { await dbPut('sales', fresh); fresh.forEach((r) => { SALES.push(r); have.add(r.id); }); added += fresh.length; }
      status(`Item ${itemId}: page ${p + 1}, ${added} new sales`);
      if ((j.auctionhouse || []).length < 100 || !fresh.length) break;
      to = Math.min(...(j.auctionhouse || []).map((r) => r.timestamp)) - 1;
    }
    return added;
  }

  // Pull recent sales across all items (weapons and armour kept).
  async function fetchRecentAll(maxPages) {
    let to = null;
    let added = 0;
    const have = new Set(SALES.map((s) => s.id));
    for (let p = 0; p < maxPages; p++) {
      const params = { limit: 100, sort: 'DESC' };
      if (to) params.to = to;
      const j = await api('market/auctionhouse', params);
      const raw = j.auctionhouse || [];
      const rows = raw.map(normSale).filter(Boolean);
      const fresh = rows.filter((r) => !have.has(r.id));
      if (fresh.length) { await dbPut('sales', fresh); fresh.forEach((r) => { SALES.push(r); have.add(r.id); }); added += fresh.length; }
      status(`All items: page ${p + 1}, ${added} new sales`);
      if (raw.length < 100) break;
      to = Math.min(...raw.map((r) => r.timestamp)) - 1;
    }
    return added;
  }

  async function loadItems(force) {
    const cached = await kvGet('items');
    if (!force && cached && cached.ts > Date.now() - 7 * 864e5 && cached.list.length) { ITEMS = cached.list; return; }
    const list = [];
    for (const cat of ['Weapon', 'Armor']) {
      const j = await api('torn/items', { cat });
      (j.items || []).forEach((i) => list.push({ id: i.id, name: i.name, type: i.type, sub: i.sub_type || '' }));
    }
    ITEMS = list.sort((a, b) => a.name.localeCompare(b.name));
    await kvSet('items', { ts: Date.now(), list: ITEMS });
  }
  const itemByName = (name) => ITEMS.find((i) => norm(i.name) === norm(name)) || null;

  // ================= Valuation from comparables =================
  function wQuantile(pairs, q) { // pairs [{v,w}]
    const s = pairs.slice().sort((a, b) => a.v - b.v);
    const tot = s.reduce((a, b) => a + b.w, 0);
    let acc = 0;
    for (const p of s) { acc += p.w; if (acc >= q * tot) return p.v; }
    return s.length ? s[s.length - 1].v : NaN;
  }
  // target: {name, rarity, b:[{t,v}], dmg, acc, arm}
  function valuate(target) {
    const now = Date.now() / 1000;
    const minTs = now - S.days * 86400;
    const tb = (target.b || []).filter((x) => x.t);
    const tKeys = tb.map((x) => norm(x.t)).sort().join('+');
    const pool = SALES.filter((s) => norm(s.name) === norm(target.name) && s.ts >= minTs && s.price > 0);
    const scored = [];
    for (const s of pool) {
      const sKeys = (s.b || []).map((x) => norm(x.t)).sort().join('+');
      // must share the main bonus (first bonus of the target)
      if (tb.length && !(s.b || []).some((x) => norm(x.t) === norm(tb[0].t))) continue;
      if (!tb.length && (s.b || []).length) continue;
      let d = 0;
      tb.forEach((x) => {
        const m = (s.b || []).find((y) => norm(y.t) === norm(x.t));
        d += m ? Math.abs(m.v - x.v) / 4 : 3;
      });
      if (sKeys !== tKeys) d += 1.5;
      if (target.rarity && s.rarity && target.rarity !== s.rarity) d += 2;
      if (isFinite(target.dmg) && isFinite(s.dmg)) d += Math.abs(s.dmg - target.dmg) / 2;
      if (isFinite(target.acc) && isFinite(s.acc)) d += Math.abs(s.acc - target.acc) / 2;
      if (isFinite(target.arm) && isFinite(s.arm)) d += Math.abs(s.arm - target.arm) / 1.5;
      const ageDays = (now - s.ts) / 86400;
      const w = Math.exp(-d) * Math.pow(0.5, ageDays / 60);
      scored.push({ s, d, w });
    }
    scored.sort((a, b) => b.w - a.w);
    const top = scored.slice(0, 15).filter((x) => x.w > 1e-6);
    // Weights choose the closest sales; the price bands treat those sales equally,
    // so one near-identical sale (often the same weapon resold) cannot set all three figures.
    const pairs = top.map((x) => ({ v: x.s.price, w: 1 }));
    return {
      n: top.length,
      pool: pool.length,
      p25: wQuantile(pairs, 0.25),
      p50: wQuantile(pairs, 0.5),
      p75: wQuantile(pairs, 0.75),
      comps: top.map((x) => x.s),
    };
  }

  // Deal grade: price against the comparable-sales quartiles.
  function dealOf(price, v) {
    if (!v || !v.n || !isFinite(price) || price <= 0) return { k: '', label: 'No history', cls: 'muted', pct: NaN };
    if (v.n < (S.minComps || 5)) return { k: '', label: `Only ${v.n} comparable sale${v.n === 1 ? '' : 's'}`, cls: 'muted', pct: (price / v.p50 - 1) * 100, thin: true };
    const pct = (price / v.p50 - 1) * 100; // + = above fair
    if (price <= v.p25) return { k: 'great', label: 'Great deal', cls: 'g-ex', pct };
    if (price <= v.p50) return { k: 'good', label: 'Good', cls: 'g-gd', pct };
    if (price <= v.p75) return { k: 'fair', label: 'Fair', cls: 'g-fr', pct };
    return { k: 'over', label: 'Over', cls: 'g-pr', pct };
  }

  // ================= Mods data (credits) =================
  const MODS = [
    ['Reflex Sight', 'Sight', [599, 1049], [364, 734], 'Accuracy +1', 'MCG, PST, RFL, SMG'],
    ['Holographic Sight', 'Sight', [1450, 2098], [708, 1468], 'Accuracy +1.25', 'MCG, PST, RFL, SMG'],
    ['Acog Sight', 'Sight', [2947, 4197], [1597, 2921], 'Accuracy +1.5', 'MCG, PST, RFL, SMG'],
    ['Thermal Sight', 'Sight', [5908, 8399], [2146, 5872], 'Accuracy +1.75', 'MCG, PST, RFL, SMG'],
    ['1mw Laser', 'Laser', [441, 749], [239, 520], 'Critical +2%', 'HRT, MCG, PST, RFL, SHT, SMG'],
    ['5mw Laser', 'Laser', [1033, 1499], [645, 1041], 'Critical +3%', 'HRT, MCG, PST, RFL, SHT, SMG'],
    ['30mw Laser', 'Laser', [2120, 2999], [1075, 2095], 'Critical +4%', 'HRT, MCG, PST, RFL, SHT, SMG'],
    ['100mw Laser', 'Laser', [4207, 6000], [1756, 4200], 'Critical +5%', 'HRT, MCG, PST, RFL, SHT, SMG'],
    ['Small Suppressor', 'Suppressor', [493, 899], [250, 630], 'Stealth +3, DMG -5%', 'PST, RFL, SMG'],
    ['Standard Suppressor', 'Suppressor', [1288, 1799], [622, 1266], 'Stealth +4, DMG -5%', 'PST, RFL, SMG'],
    ['Large Suppressor', 'Suppressor', [5042, 7197], [1966, 5029], 'Stealth +5, DMG -5%', 'PST, RFL, SMG'],
    ['Extended Mags', 'Magazine', [474, 674], [235, 472], 'Clip size +20%', 'MCG, PST, RFL, SMG'],
    ['High Capacity Mags', 'Magazine', [1902, 2700], [982, 1888], 'Clip size +30%', 'MCG, PST, RFL, SMG'],
    ['Extra Clip x1', 'Extra mags', [316, 644], [104, 312], 'Clip +1', 'HRT, MCG, PST, RFL, SHT, SMG'],
    ['Extra Clip x2', 'Extra mags', [631, 899], [422, 629], 'Clip +2', 'HRT, MCG, PST, RFL, SHT, SMG'],
    ['Adjustable Trigger', 'Trigger', [449, 675], [250, 471], 'Accuracy +5 on 1st turn', 'MCG, PST, RFL, SHT, SMG'],
    ['Hair Trigger', 'Trigger', [1914, 2700], [885, 1880], 'Accuracy +7.5 on 1st turn', 'MCG, PST, RFL, SHT, SMG'],
    ['Bipod', 'Mount', [369, 522], [143, 364], 'Accuracy +1.75, Dexterity -30%', 'HRT, MCG, RFL'],
    ['Tripod', 'Mount', [1493, 2099], [721, 1452], 'Accuracy +2, Dexterity -30%', 'HRT, MCG, RFL'],
    ['Custom Grip', 'Grip', [250, 374], [101, 261], 'Accuracy +0.75', 'MCG, PST, RFL, SHT, SMG'],
    ['Skeet Choke', 'Choke', [579, 824], [241, 576], 'DMG +6%', 'SHT'],
    ['Improved Choke', 'Choke', [1157, 1649], [786, 1150], 'DMG +8%', 'SHT'],
    ['Full Choke', 'Choke', [2323, 3291], [958, 2298], 'DMG +10%', 'SHT'],
    ['Recoil Pad', 'Recoil pad', [526, 748], [220, 524], 'Ammo Control +25%', 'MCG, RFL, SHT'],
    ['Standard Brake', 'Brake', [418, 599], [178, 419], 'Accuracy +1, Stealth -3', 'MCG, PST, RFL, SMG'],
    ['Heavy Duty Brake', 'Brake', [840, 1199], [252, 839], 'Accuracy +1.25, Stealth -3', 'MCG, PST, RFL, SMG'],
    ['Tactical Brake', 'Brake', [1716, 2399], [946, 1655], 'Accuracy +1.5, Stealth -3', 'MCG, PST, RFL, SMG'],
    ['Small Light', 'Light', [407, 598], [184, 419], 'Opp accuracy -3, Opp stealth -2', 'PST, RFL, SHT, SMG'],
    ['Precision Light', 'Light', [841, 1200], [442, 837], 'Opp accuracy -4, Opp stealth -2.5', 'PST, RFL, SHT, SMG'],
    ['Tactical Illuminator', 'Light', [3370, 4799], [1812, 3334], 'Opp accuracy -5, Opp stealth -3', 'PST, RFL, SHT, SMG'],
  ].map(([name, type, n, s, bonus, fits]) => ({ name, type, n, s, bonus, fits }));
  function modGrade(mod, price) {
    const lo = mod.s[0], hi = mod.n[1];
    const p = (price - lo) / (hi - lo);
    if (price < lo) return ['Below known range: buy', 'ex'];
    if (p <= 0.25) return ['Excellent', 'ex'];
    if (price <= mod.s[1] && p <= 0.5) return ['Good: special-offer price', 'gd'];
    if (price <= mod.s[1]) return ['Fair: top of special range', 'fr'];
    if (price <= hi) return ['Poor: normal price, wait', 'pr'];
    return ['Above known range: skip', 'pr'];
  }

  // ================= Import (Swervelord rows pasted) =================
  const RARITY = /^(yellow|orange|red)$/i;
  const TIME = /^(\d+\s*[dhm]\s*)+$/i;
  function parsePaste(text) {
    const tok = [];
    String(text).split(/\r?\n/).forEach((line) => line.split('\t').forEach((t) => { t = t.trim(); if (t) tok.push(t); }));
    const anchors = [];
    tok.forEach((t, i) => { if (RARITY.test(t) && i > 0) anchors.push(i); });
    const rows = [];
    anchors.forEach((ai, k) => {
      const end = k + 1 < anchors.length ? anchors[k + 1] - 1 : tok.length; // exclusive (next name)
      const name = tok[ai - 1];
      const nums = [];
      let j = ai + 1;
      while (j < end && nums.length < 3 && /^[\d.,]+$/.test(tok[j])) { nums.push(parseFloat(tok[j].replace(/,/g, ''))); j++; }
      const rest = tok.slice(j, end);
      let ends = '', seller = '', price = NaN;
      const bonusTok = [];
      // last time-like token = ends; token before = seller
      let ti = -1;
      for (let x = rest.length - 1; x >= 0; x--) if (TIME.test(rest[x])) { ti = x; break; }
      let upto = rest.length;
      if (ti >= 0) { ends = rest[ti]; seller = rest[ti - 1] || ''; upto = ti - 1; }
      for (let x = 0; x < upto; x++) {
        const t = rest[x];
        if (/^\$[\d.,]+\s*[kmb]?/i.test(t)) { price = parseMoney(t); continue; }
        bonusTok.push(t);
      }
      const b = [];
      for (let x = 0; x < bonusTok.length; x++) {
        const t = bonusTok[x];
        if (t === '—' || t === '-' || t === '–') continue;
        const comb = t.match(/^(.+?)\s*\+\s*(\d+)%?$/);
        if (comb) { b.push({ t: comb[1].trim(), v: +comb[2] }); continue; }
        const nx = bonusTok[x + 1];
        if (nx && /^\+?\d+%?$/.test(nx) && /[a-z]/i.test(t)) { b.push({ t, v: parseInt(nx.replace(/\D/g, ''), 10) }); x++; }
      }
      rows.push({ name, rarity: tok[ai].toLowerCase(), q: nums[0], dmg: nums[1], acc: nums[2], b, seller, ends, price });
    });
    return rows.filter((r) => r.name && !/^item$/i.test(r.name));
  }

  // ================= UI =================
  const CSS = `
  #ac-btn{position:fixed;left:8px;bottom:90px;z-index:2147483646;background:#7b3fe4;color:#fff;border:none;border-radius:20px;padding:7px 12px;font:bold 12px Arial,sans-serif;cursor:pointer;box-shadow:0 2px 6px #0008}
  #ac{position:fixed;inset:0;z-index:2147483647;background:#14111b;color:#e8e6ef;font:13px/1.4 Arial,sans-serif;display:none;flex-direction:column}
  #ac.open{display:flex}
  #ac *{box-sizing:border-box}
  #ac header{display:flex;align-items:center;gap:6px;padding:8px 10px;background:#1d1928;border-bottom:1px solid #2e2840;flex-wrap:wrap}
  #ac header b{margin-right:8px}
  #ac .tab{background:#262035;border:1px solid #3a3150;color:#cfc8e6;border-radius:6px;padding:5px 10px;cursor:pointer}
  #ac .tab.on{background:#3a2b5e;color:#fff;border-color:#7b3fe4}
  #ac .x{margin-left:auto;background:#3a1d24;border:1px solid #6a2c38;color:#fff;border-radius:6px;padding:5px 10px;cursor:pointer}
  #ac main{flex:1;overflow:auto;padding:10px}
  #ac footer{padding:4px 10px;background:#1d1928;border-top:1px solid #2e2840;font-size:11px;color:#a69fc0;min-height:22px}
  #ac .row{display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end;margin-bottom:8px}
  #ac label{display:flex;flex-direction:column;font-size:11px;color:#a69fc0;gap:2px}
  #ac input,#ac select,#ac textarea{background:#0f0d15;color:#fff;border:1px solid #3a3150;border-radius:5px;padding:5px 6px;font-size:12px}
  #ac input[type=number]{width:80px}
  #ac button.b{background:#3a2b5e;color:#fff;border:1px solid #7b3fe4;border-radius:5px;padding:6px 10px;cursor:pointer;font-size:12px}
  #ac button.b2{background:#262035;color:#ddd;border:1px solid #3a3150;border-radius:5px;padding:6px 10px;cursor:pointer;font-size:12px}
  #ac table{border-collapse:collapse;width:100%;font-size:12px}
  #ac th{position:sticky;top:-10px;background:#1d1928;color:#c4bde0 !important;text-align:left;font-weight:normal;font-size:11px;text-transform:uppercase;padding:6px;border-bottom:1px solid #2e2840;cursor:pointer;white-space:nowrap}
  #ac td{padding:5px 6px;border-bottom:1px solid #221d2e;white-space:nowrap;color:#e8e6ef !important;background:transparent}
  #ac td b,#ac td span,#ac .stats b,#ac label,#ac .hint,#ac .card{color:inherit}
  #ac,#ac div,#ac b,#ac table,#ac tbody,#ac tr{color:#e8e6ef}
  #ac tr:hover td{background:#1c1726}
  #ac .num{text-align:right}
  #ac .pill{display:inline-block;background:#262035;border-radius:10px;padding:1px 7px;margin-right:3px;color:#e8e6ef !important}
  #ac .pill i{color:#c39bff;font-style:normal}
  #ac .pill .gt{color:#8fd1ff !important;font-size:10px}
  #ac .r-yellow{color:#f2d24b !important}#ac .r-orange{color:#ff9a3d !important}#ac .r-red{color:#ff5a5a !important}
  #ac .card{background:#1b1724;border:1px solid #2e2840;border-radius:8px;padding:10px;margin-bottom:10px}
  #ac .stats{display:flex;gap:16px;flex-wrap:wrap;margin:6px 0}
  #ac .stats div{min-width:90px}#ac .stats small{display:block;color:#a69fc0;font-size:10px;text-transform:uppercase}
  #ac .stats b{font-size:15px}
  #ac .g-ex{color:#5be37a !important}#ac .g-gd{color:#a6e35b !important}#ac .g-fr{color:#f2c94b !important}#ac .g-pr{color:#ff6b6b !important}
  #ac .muted{color:#a9a2c4 !important}
  #ac .star{color:#f2d24b !important}
  #ac .tblwrap{overflow-x:auto}
  #ac tr.deal-great td{background:#14301c !important}
  #ac tr.deal-good td{background:#1f2a14 !important}
  #ac .chk{flex-direction:row;align-items:center;gap:4px;font-size:12px;color:#e8e6ef}
  #ac .hint{font-size:11px;color:#8d86a6;margin:4px 0 8px}
  `;
  let current = 'history';
  let sortState = {};

  function status(t) { const f = $('#ac footer'); if (f) f.textContent = t; }
  function rarityCell(r) { return r ? `<span class="r-${esc(r)}">${esc(r[0].toUpperCase() + r.slice(1))}</span>` : '<span class="muted">–</span>'; }
  function bonusCell(b, rarity) { return (b || []).map((x) => { const n = guideNote(x.t, x.v, rarity); return `<span class="pill" title="${esc(n)}">${esc(x.t)} <i>${esc(x.v)}%</i>${n ? ' <small class="gt">' + esc(n.split(' · ')[0].replace(' tier', '')) + (/low roll/.test(n) ? '↓' : /high roll|above/.test(n) ? '↑' : '') + '</small>' : ''}</span>`; }).join('') || '<span class="muted">–</span>'; }

  function build() {
    if ($('#ac')) return;
    const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    const btn = document.createElement('button'); btn.id = 'ac-btn'; btn.textContent = 'Archer Console';
    btn.onclick = () => toggle(true);
    document.body.appendChild(btn);
    const el = document.createElement('div'); el.id = 'ac';
    el.innerHTML = `
      <header><b>Archer Console v${VERSION}</b>
        <button class="tab" data-t="history">Auction history</button>
        <button class="tab" data-t="value">Ceiling bid</button>
        <button class="tab" data-t="import">Import live</button>
        <button class="tab" data-t="market">Item market</button>
        <button class="tab" data-t="rank">Ranking</button>
        <button class="tab" data-t="mods">Mods</button>
        <button class="tab" data-t="settings">Settings</button>
        <button class="x">Close</button></header>
      <main></main><footer></footer>`;
    document.body.appendChild(el);
    el.querySelectorAll('.tab').forEach((t) => (t.onclick = () => show(t.dataset.t)));
    el.querySelector('.x').onclick = () => toggle(false);
    document.addEventListener('keydown', (e) => { if (e.altKey && (e.key === 'a' || e.key === 'A')) toggle(!el.classList.contains('open')); if (e.key === 'Escape') toggle(false); });
  }
  async function toggle(on) {
    const el = $('#ac');
    el.classList.toggle('open', on);
    if (on) {
      if (!SALES.length) { try { SALES = await dbAll('sales'); } catch (e) { status('Cache unavailable: ' + e.message); } }
      if (!ITEMS.length) { try { const c = await kvGet('items'); if (c) ITEMS = c.list; } catch (e) { /* ignore */ } }
      if (!S.key) current = 'settings';
      show(current);
    }
  }
  function show(t) {
    current = t;
    document.querySelectorAll('#ac .tab').forEach((x) => x.classList.toggle('on', x.dataset.t === t));
    const m = $('#ac main');
    ({ history: viewHistory, value: viewValue, import: viewImport, market: viewMarket, rank: viewRank, mods: viewMods, settings: viewSettings })[t](m);
  }
  const itemDatalist = () => `<datalist id="ac-items">${ITEMS.map((i) => `<option value="${esc(i.name)}">`).join('')}</datalist>`;
  const BONUSES = ['Achilles', 'Assassinate', 'Backstab', 'Berserk', 'Bleed', 'Blindfire', 'Blindside', 'Bloodlust', 'Burn', 'Comeback', 'Conserve', 'Cripple', 'Crusher', 'Cupid', 'Deadeye', 'Deadly', 'Demoralize', 'Disarm', 'Double-edged', 'Double Tap', 'Emasculate', 'Empower', 'Eviscerate', 'Execute', 'Expose', 'Finale', 'Focus', 'Freeze', 'Frenzy', 'Fury', 'Grace', 'Hazardous', 'Home run', 'Irradiate', 'Lacerate', 'Motivation', 'Paralyze', 'Parry', 'Penetrate', 'Plunder', 'Poison', 'Powerful', 'Proficience', 'Puncture', 'Quicken', 'Rage', 'Revitalize', 'Roshambo', 'Shock', 'Sleep', 'Slow', 'Smash', 'Smurf', 'Specialist', 'Spray', 'Storage', 'Stricken', 'Stun', 'Suppress', 'Sure Shot', 'Throttle', 'Toxin', 'Warlord', 'Weaken', 'Wind-up', 'Wither'];
  const bonusOptions = (sel) => `<option value="">Any</option>` + BONUSES.map((b) => `<option ${sel === b ? 'selected' : ''}>${b}</option>`).join('');

  function sortable(table, rows, cols, key, render) {
    const s = sortState[key] || { c: cols.findIndex((c) => c.def) >= 0 ? cols.findIndex((c) => c.def) : 0, d: -1 };
    sortState[key] = s;
    const col = cols[s.c];
    rows.sort((a, b) => {
      const x = col.v(a), y = col.v(b);
      if (x == null || (typeof x === 'number' && !isFinite(x))) return 1;
      if (y == null || (typeof y === 'number' && !isFinite(y))) return -1;
      return (x > y ? 1 : x < y ? -1 : 0) * s.d;
    });
    table.innerHTML = `<thead><tr>${cols.map((c, i) => `<th data-i="${i}" class="${c.num ? 'num' : ''}">${c.h}${i === s.c ? (s.d < 0 ? ' ▼' : ' ▲') : ''}</th>`).join('')}</tr></thead><tbody>${rows.map(render).join('')}</tbody>`;
    table.querySelectorAll('th').forEach((th) => (th.onclick = () => {
      const i = +th.dataset.i;
      sortState[key] = { c: i, d: s.c === i ? -s.d : -1 };
      sortable(table, rows, cols, key, render);
    }));
  }

  // ---------- History ----------
  const hf = { item: '', b1: '', b1min: '', b1max: '', b2: '', rarity: '', minDmg: '', minAcc: '', days: 90 };
  function viewHistory(m) {
    m.innerHTML = `${itemDatalist()}
      <div class="card">
        <div class="row">
          <label>Item<input id="h-item" list="ac-items" value="${esc(hf.item)}" placeholder="e.g. SIG 552" style="width:180px"></label>
          <label>Pages (100 sales each)<input id="h-pages" type="number" value="5" min="1" max="50"></label>
          <button class="b" id="h-fetch">Fetch item history</button>
          <button class="b2" id="h-recent">Fetch recent (all items, 10 pages)</button>
          <span class="muted" id="h-count"></span>
        </div>
        <div class="row">
          <label>Bonus 1<select id="h-b1">${bonusOptions(hf.b1)}</select></label>
          <label>Min %<input id="h-b1min" type="number" value="${esc(hf.b1min)}"></label>
          <label>Max %<input id="h-b1max" type="number" value="${esc(hf.b1max)}"></label>
          <label>Bonus 2<select id="h-b2">${bonusOptions(hf.b2)}</select></label>
          <label>Rarity<select id="h-rar"><option value="">Any</option>${['yellow', 'orange', 'red'].map((r) => `<option ${hf.rarity === r ? 'selected' : ''}>${r}</option>`).join('')}</select></label>
          <label>Min dmg<input id="h-dmg" type="number" value="${esc(hf.minDmg)}"></label>
          <label>Min acc<input id="h-acc" type="number" value="${esc(hf.minAcc)}"></label>
          <label>Last days<input id="h-days" type="number" value="${esc(hf.days)}"></label>
          <button class="b2" id="h-apply">Apply</button>
        </div>
      </div>
      <div class="card"><div class="stats" id="h-stats"></div></div>
      <div class="tblwrap"><table id="h-tbl"></table></div>`;
    const read = () => {
      hf.item = $('#h-item').value.trim(); hf.b1 = $('#h-b1').value; hf.b1min = $('#h-b1min').value; hf.b1max = $('#h-b1max').value;
      hf.b2 = $('#h-b2').value; hf.rarity = $('#h-rar').value; hf.minDmg = $('#h-dmg').value; hf.minAcc = $('#h-acc').value; hf.days = $('#h-days').value || 90;
    };
    $('#h-apply').onclick = () => { read(); renderHistory(); };
    m.querySelectorAll('select').forEach((s) => (s.onchange = () => { read(); renderHistory(); }));
    $('#h-fetch').onclick = async () => {
      read();
      try {
        if (!ITEMS.length) { status('Loading item list…'); await loadItems(); viewHistory(m); return; }
        const it = itemByName(hf.item);
        if (!it) { status('Item not found. Pick a name from the list.'); return; }
        const n = await fetchItemHistory(it.id, Math.max(1, +$('#h-pages').value || 5));
        status(`${it.name}: ${n} new sales cached.`); renderHistory();
      } catch (e) { status(e.message); }
    };
    $('#h-recent').onclick = async () => {
      try { const n = await fetchRecentAll(10); status(`${n} new weapon and armour sales cached.`); renderHistory(); }
      catch (e) { status(e.message); }
    };
    renderHistory();
  }
  function historyFilter() {
    const minTs = Date.now() / 1000 - (+hf.days || 90) * 86400;
    return SALES.filter((s) => {
      if (s.ts < minTs) return false;
      if (hf.item && !norm(s.name).includes(norm(hf.item))) return false;
      if (hf.rarity && s.rarity !== hf.rarity) return false;
      if (hf.minDmg && !(s.dmg >= +hf.minDmg)) return false;
      if (hf.minAcc && !(s.acc >= +hf.minAcc)) return false;
      if (hf.b1) {
        const b = (s.b || []).find((x) => norm(x.t) === norm(hf.b1));
        if (!b) return false;
        if (hf.b1min !== '' && b.v < +hf.b1min) return false;
        if (hf.b1max !== '' && b.v > +hf.b1max) return false;
      }
      if (hf.b2 && !(s.b || []).some((x) => norm(x.t) === norm(hf.b2))) return false;
      return true;
    });
  }
  function renderHistory() {
    const rows = historyFilter();
    $('#h-count').textContent = `${fmt(SALES.length)} sales cached`;
    const prices = rows.map((r) => r.price).sort((a, b) => a - b);
    const med = prices.length ? prices[Math.floor(prices.length / 2)] : NaN;
    const avg = prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : NaN;
    $('#h-stats').innerHTML = `
      <div><small>Matches</small><b>${fmt(rows.length)}</b></div>
      <div><small>Median</small><b>${money(med)}</b></div>
      <div><small>Average</small><b>${money(avg)}</b></div>
      <div><small>Lowest</small><b>${money(prices[0])}</b></div>
      <div><small>Highest</small><b>${money(prices[prices.length - 1])}</b></div>`;
    const cols = [
      { h: 'Item', v: (r) => r.name },
      { h: 'Rarity', v: (r) => ({ yellow: 1, orange: 2, red: 3 }[r.rarity] || 0) },
      { h: 'Qual', v: (r) => r.q, num: 1 },
      { h: 'Dmg', v: (r) => r.dmg, num: 1 },
      { h: 'Acc', v: (r) => r.acc, num: 1 },
      { h: 'Arm', v: (r) => r.arm, num: 1 },
      { h: 'Bonuses', v: (r) => (r.b[0] ? r.b[0].v : 0) },
      { h: 'Index', v: (r) => indexOf(r.dmg, r.b), num: 1 },
      { h: 'Bids', v: (r) => r.bids, num: 1 },
      { h: 'Price', v: (r) => r.price, num: 1 },
      { h: 'Buyer', v: (r) => r.buyer },
      { h: 'Closed', v: (r) => r.ts, def: 1 },
    ];
    sortable($('#h-tbl'), rows.slice(0, 2000), cols, 'hist', (r) => `<tr>
      <td>${esc(r.name)}</td><td>${rarityCell(r.rarity)}</td><td class="num">${fmt(r.q, 1)}</td><td class="num">${fmt(r.dmg, 2)}</td>
      <td class="num">${fmt(r.acc, 2)}</td><td class="num">${fmt(r.arm, 2)}</td><td>${bonusCell(r.b, r.rarity)}</td><td class="num">${fmt(indexOf(r.dmg, r.b), 1)}</td>
      <td class="num">${fmt(r.bids)}</td><td class="num"><b>${money(r.price)}</b></td><td>${esc(r.buyer)}</td><td class="muted">${ago(r.ts)}</td></tr>`);
  }

  // ---------- Ceiling bid ----------
  const vf = { item: '', rarity: '', b1: '', v1: '', b2: '', v2: '', dmg: '', acc: '', arm: '' };
  function viewValue(m) {
    m.innerHTML = `${itemDatalist()}
      <div class="card">
        <div class="hint">Enter the auction's stats. Comparable sales: same item and main bonus, weighted by closeness of bonus %, damage, accuracy, rarity and age (60-day half-life), within the history window in Settings (${S.days} days).</div>
        <div class="row">
          <label>Item<input id="v-item" list="ac-items" value="${esc(vf.item)}" style="width:180px"></label>
          <label>Rarity<select id="v-rar"><option value="">Any</option>${['yellow', 'orange', 'red'].map((r) => `<option ${vf.rarity === r ? 'selected' : ''}>${r}</option>`).join('')}</select></label>
          <label>Bonus 1<select id="v-b1">${bonusOptions(vf.b1)}</select></label>
          <label>%<input id="v-v1" type="number" value="${esc(vf.v1)}"></label>
          <label>Bonus 2<select id="v-b2">${bonusOptions(vf.b2)}</select></label>
          <label>%<input id="v-v2" type="number" value="${esc(vf.v2)}"></label>
          <label>Dmg<input id="v-dmg" type="number" step="0.01" value="${esc(vf.dmg)}"></label>
          <label>Acc<input id="v-acc" type="number" step="0.01" value="${esc(vf.acc)}"></label>
          <label>Armour<input id="v-arm" type="number" step="0.01" value="${esc(vf.arm)}"></label>
          <button class="b" id="v-go">Value it</button>
          <button class="b2" id="v-fetch">Fetch history first</button>
        </div>
      </div><div id="v-out"></div>`;
    const read = () => {
      vf.item = $('#v-item').value.trim(); vf.rarity = $('#v-rar').value; vf.b1 = $('#v-b1').value; vf.v1 = $('#v-v1').value;
      vf.b2 = $('#v-b2').value; vf.v2 = $('#v-v2').value; vf.dmg = $('#v-dmg').value; vf.acc = $('#v-acc').value; vf.arm = $('#v-arm').value;
    };
    $('#v-go').onclick = () => { read(); renderValue(); };
    $('#v-fetch').onclick = async () => {
      read();
      try {
        if (!ITEMS.length) { status('Loading item list…'); await loadItems(); }
        const it = itemByName(vf.item);
        if (!it) { status('Item not found. Pick a name from the list.'); return; }
        await fetchItemHistory(it.id, 10);
        renderValue();
      } catch (e) { status(e.message); }
    };
    if (vf.item) renderValue();
  }
  function targetFrom(f) {
    const b = [];
    if (f.b1) b.push({ t: f.b1, v: +f.v1 || 0 });
    if (f.b2) b.push({ t: f.b2, v: +f.v2 || 0 });
    return { name: f.item, rarity: f.rarity || null, b, dmg: f.dmg === '' ? NaN : +f.dmg, acc: f.acc === '' ? NaN : +f.acc, arm: f.arm === '' ? NaN : +f.arm };
  }
  function valueCard(t, v) {
    if (!v.n) return `<div class="card">No comparable sales cached for <b>${esc(t.name)}</b>${t.b[0] ? ' with ' + esc(t.b[0].t) : ''} (${v.pool} sales of this item in the window). Press "Fetch history first", or widen the window in Settings.</div>`;
    const thin = v.n < (S.minComps || 5) ? '<div class="g-fr">Fewer than 5 comparables: treat as a rough guide.</div>' : '';
    return `<div class="card">
      <b>${esc(t.name)}</b> ${rarityCell(t.rarity)} ${bonusCell(t.b, t.rarity)} <span class="muted">Index ${fmt(indexOf(t.dmg, t.b), 1)} (x${fmt(multOf(t.b), 2)})</span>
      <div class="stats">
        <div><small>Great buy at or below</small><b class="g-ex">${money(v.p25)}</b></div>
        <div><small>Fair price</small><b class="g-gd">${money(v.p50)}</b></div>
        <div><small>Ceiling bid</small><b class="g-fr">${money(v.p75)}</b></div>
        <div><small>Comparables</small><b>${v.n}</b> <span class="muted">of ${v.pool}</span></div>
      </div>${thin}${t.b.length ? '<div class="hint">Guide: ' + t.b.map((x) => esc(x.t) + ' ' + esc(guideNote(x.t, x.v, t.rarity))).join('; ') + '</div>' : ''}
      <div class="tblwrap"><table><thead><tr><th>Closest sales</th><th>Rarity</th><th class="num">Dmg</th><th class="num">Acc</th><th>Bonuses</th><th class="num">Price</th><th>When</th></tr></thead><tbody>
      ${v.comps.map((s) => `<tr><td>${esc(s.name)}</td><td>${rarityCell(s.rarity)}</td><td class="num">${fmt(s.dmg, 2)}</td><td class="num">${fmt(s.acc, 2)}</td><td>${bonusCell(s.b, s.rarity)}</td><td class="num"><b>${money(s.price)}</b></td><td class="muted">${ago(s.ts)}</td></tr>`).join('')}
      </tbody></table></div></div>`;
  }
  function renderValue() {
    const t = targetFrom(vf);
    if (!t.name) return;
    $('#v-out').innerHTML = valueCard(t, valuate(t));
  }

  // ---------- Import live (paste, saved) ----------
  // Pasted rows are merged into a saved list (IndexedDB) and kept until their auction ends.
  // Current bids seen on Torn's Auction House page fill the Price column when the weapon matches.
  let IMPORTED = [];
  let SEEN = {}; // weapon key -> {price, ts, endsAt}  (from Auction House badges)
  let importLoaded = false;
  const wKey = (r) => [norm(r.name), isFinite(r.dmg) ? (+r.dmg).toFixed(2) : '', isFinite(r.acc) ? (+r.acc).toFixed(2) : ''].join('|');
  const rowKey = (r) => wKey(r) + '|' + (r.b || []).map((x) => norm(x.t) + x.v).sort().join(',') + '|' + norm(r.seller);
  function durSec(str) {
    let sec = 0, any = false;
    String(str || '').replace(/(\d+)\s*([dhms])/gi, (_, n, u) => { any = true; sec += +n * { d: 86400, h: 3600, m: 60, s: 1 }[u.toLowerCase()]; });
    return any ? sec : NaN;
  }
  const leftText = (endsAt) => {
    const s2 = Math.round((endsAt - Date.now()) / 1000);
    if (!isFinite(s2)) return '?';
    if (s2 <= 0) return 'ended';
    const d = Math.floor(s2 / 86400), h = Math.floor((s2 % 86400) / 3600), mi = Math.floor((s2 % 3600) / 60);
    return d ? `${d}d ${h}h` : h ? `${h}h ${mi}m` : `${mi}m`;
  };
  async function loadImported() {
    if (importLoaded) return;
    try { IMPORTED = (await kvGet('imported')) || []; SEEN = (await kvGet('ahseen')) || {}; } catch (e) { /* ignore */ }
    importLoaded = true;
    pruneImported();
  }
  function pruneImported() {
    const now = Date.now();
    IMPORTED = IMPORTED.filter((r) => !isFinite(r.endsAt) || r.endsAt > now - 15 * 60000); // keep 15 min after end
  }
  async function saveImported() { try { await kvSet('imported', IMPORTED); } catch (e) { /* ignore */ } }
  function mergeImported(rows) {
    const now = Date.now();
    let added = 0, updated = 0;
    rows.forEach((r) => {
      const sec = durSec(r.ends);
      const rec = Object.assign({}, r, { importedAt: now, endsAt: isFinite(sec) ? now + sec * 1000 : NaN });
      const k = rowKey(rec);
      const i = IMPORTED.findIndex((x) => rowKey(x) === k);
      if (i >= 0) { IMPORTED[i] = Object.assign({}, IMPORTED[i], rec); updated++; } else { IMPORTED.push(rec); added++; }
    });
    pruneImported();
    return { added, updated };
  }
  function viewImport(m) {
    m.innerHTML = `
      <div class="card">
        <div class="hint">Live auctions are not in the Torn API. Copy rows from the Swervelord live floor and paste them here; each paste is added to your saved list (duplicates replaced), kept until the auction ends. Price fills in from the current bid when you have viewed that auction on Torn's Auction House page.</div>
        <textarea id="i-txt" rows="5" style="width:100%" placeholder="Paste rows here"></textarea>
        <div class="row" style="margin-top:6px"><button class="b" id="i-go">Add to saved list</button>
        <button class="b2" id="i-fetch">Fetch history for these items</button>
        <button class="b2" id="i-clear">Clear saved list</button><span class="muted" id="i-n"></span></div>
      </div><div class="tblwrap"><table id="i-tbl"></table></div>`;
    $('#i-go').onclick = async () => {
      await loadImported();
      const rows = parsePaste($('#i-txt').value);
      const r = mergeImported(rows);
      await saveImported();
      $('#i-txt').value = '';
      status(`${rows.length} rows read: ${r.added} added, ${r.updated} updated. ${IMPORTED.length} saved.`);
      renderImport();
    };
    $('#i-clear').onclick = async () => { IMPORTED = []; await saveImported(); renderImport(); status('Saved list cleared.'); };
    $('#i-fetch').onclick = async () => {
      try {
        if (!ITEMS.length) { status('Loading item list…'); await loadItems(); }
        const names = [...new Set(IMPORTED.map((r) => r.name))];
        for (const n of names) { const it = itemByName(n); if (it) await fetchItemHistory(it.id, 5); }
        status(`History fetched for ${names.length} items.`); renderImport();
      } catch (e) { status(e.message); }
    };
    loadImported().then(renderImport);
  }
  function renderImport() {
    if (!$('#i-tbl')) return;
    pruneImported();
    $('#i-n').textContent = `${IMPORTED.length} saved`;
    const rows = IMPORTED.map((r) => {
      const seen = SEEN[wKey(r)];
      const price = seen && seen.ts > (r.importedAt || 0) - 6 * 3600e3 ? seen.price : r.price;
      const v = valuate({ name: r.name, rarity: r.rarity, b: r.b, dmg: r.dmg, acc: r.acc });
      return Object.assign({}, r, { price, seenTs: seen ? seen.ts : null, idx: indexOf(r.dmg, r.b), mult: multOf(r.b), v, deal: dealOf(price, v) });
    });
    const cols = [
      { h: 'Item', v: (r) => r.name },
      { h: 'Rarity', v: (r) => ({ yellow: 1, orange: 2, red: 3 }[r.rarity] || 0) },
      { h: 'Dmg', v: (r) => r.dmg, num: 1 },
      { h: 'Acc', v: (r) => r.acc, num: 1 },
      { h: 'Bonuses', v: (r) => (r.b[0] ? r.b[0].v : 0) },
      { h: 'Mult', v: (r) => r.mult, num: 1 },
      { h: 'Index', v: (r) => r.idx, num: 1, def: 1 },
      { h: 'Fair', v: (r) => r.v.p50, num: 1 },
      { h: 'Ceiling', v: (r) => r.v.p75, num: 1 },
      { h: 'Comps', v: (r) => r.v.n, num: 1 },
      { h: 'Bid', v: (r) => r.price, num: 1 },
      { h: 'Deal', v: (r) => (isFinite(r.deal.pct) ? -r.deal.pct : -1e9), num: 1 },
      { h: 'Seller', v: (r) => r.seller },
      { h: 'Ends in', v: (r) => (isFinite(r.endsAt) ? r.endsAt : 9e15) },
    ];
    sortable($('#i-tbl'), rows, cols, 'imp', (r) => `<tr class="${r.deal.k ? 'deal-' + r.deal.k : ''}"><td>${esc(r.name)}</td><td>${rarityCell(r.rarity)}</td><td class="num">${fmt(r.dmg, 2)}</td><td class="num">${fmt(r.acc, 2)}</td>
      <td>${bonusCell(r.b, r.rarity)}</td><td class="num">${fmt(r.mult, 2)}</td><td class="num"><b>${fmt(r.idx, 1)}</b></td>
      <td class="num g-gd">${r.v.n ? money(r.v.p50) : '<span class="muted">–</span>'}</td><td class="num g-fr">${r.v.n ? money(r.v.p75) : '<span class="muted">–</span>'}</td>
      <td class="num">${r.v.n || '<span class="muted">0</span>'}</td>
      <td class="num">${isFinite(r.price) ? money(r.price) + (r.seenTs ? ' <span class="muted">(' + ago(r.seenTs / 1000) + ')</span>' : '') : '<span class="muted">view on AH</span>'}</td>
      <td class="num ${r.deal.cls}">${r.deal.k ? '<b>' + esc(r.deal.label) + '</b>' : '<span class="muted">' + (r.deal.thin ? 'few sales' : '–') + '</span>'}</td>
      <td>${esc(r.seller)}</td><td>${isFinite(r.endsAt) ? leftText(r.endsAt) : esc(r.ends)}</td></tr>`);
  }


  // ---------- Item market finder ----------
  const mf = { items: 'ArmaLite M-15A4, SIG 552, Tavor TAR-21, Enfield SA-80', bonus: '', pages: 2, dealsOnly: false };
  let MARKET = [];
  function viewMarket(m) {
    m.innerHTML = `${itemDatalist()}
      <div class="card">
        <div class="hint">Searches live item market listings. Value = index per dollar against the best listing shown (100 = best). Star = no other listing is at least as cheap with at least the same damage, accuracy and bonus %. Armour is scored on armour rating.</div>
        <div class="row">
          <label>Items (comma separated)<input id="m-items" value="${esc(mf.items)}" style="width:360px" list="ac-items"></label>
          <label>Bonus<select id="m-bonus">${bonusOptions(mf.bonus)}</select></label>
          <label>Pages<input id="m-pages" type="number" value="${esc(mf.pages)}" min="1" max="10"></label>
          <button class="b" id="m-go">Search</button>
          <button class="b2" id="m-hist">Fetch auction history for these items</button>
          <label class="chk"><input type="checkbox" id="m-deals" ${mf.dealsOnly ? 'checked' : ''}> Deals only (at or below fair)</label>
        </div>
        <div class="hint">Deal = listing price against auction sales of comparable weapons: Great at or below the lower quarter, Good at or below the median, Fair at or below the upper quarter, otherwise Over. Needs auction history cached for the item.</div>
      </div><div class="tblwrap"><table id="m-tbl"></table></div>`;
    $('#m-go').onclick = async () => {
      mf.items = $('#m-items').value; mf.bonus = $('#m-bonus').value; mf.pages = Math.max(1, +$('#m-pages').value || 1);
      try {
        if (!ITEMS.length) { status('Loading item list…'); await loadItems(); }
        MARKET = [];
        const names = mf.items.split(',').map((x) => x.trim()).filter(Boolean);
        for (const n of names) {
          const it = itemByName(n);
          if (!it) { status('Not found: ' + n); continue; }
          for (let p = 0; p < mf.pages; p++) {
            const params = { limit: 100, offset: p * 100 };
            if (mf.bonus) params.bonus = mf.bonus;
            const j = await api('market/' + it.id + '/itemmarket', params);
            const L = (j.itemmarket && j.itemmarket.listings) || [];
            L.forEach((x) => {
              const d = x.item_details || {};
              const st = d.stats || {};
              MARKET.push({ name: it.name, type: it.type, price: x.price, amount: x.amount, rarity: (d.rarity || '').toLowerCase() || null, q: st.quality, dmg: st.damage, acc: st.accuracy, arm: st.armor, b: (d.bonuses || []).map((y) => ({ t: y.title, v: y.value })) });
            });
            status(`${it.name}: ${MARKET.length} listings loaded`);
            if (L.length < 100) break;
          }
        }
        renderMarket();
      } catch (e) { status(e.message); }
    };
    $('#m-deals').onchange = () => { mf.dealsOnly = $('#m-deals').checked; renderMarket(); };
    $('#m-hist').onclick = async () => {
      try {
        if (!ITEMS.length) { status('Loading item list…'); await loadItems(); }
        const names = $('#m-items').value.split(',').map((x) => x.trim()).filter(Boolean);
        for (const n of names) { const it = itemByName(n); if (it) await fetchItemHistory(it.id, 5); }
        status('Auction history updated.'); if (MARKET.length) renderMarket();
      } catch (e) { status(e.message); }
    };
    if (MARKET.length) renderMarket();
  }
  function renderMarket() {
    const rows = MARKET.map((r) => {
      const idx = r.type === 'Armor' ? r.arm : indexOf(r.dmg, r.b);
      return Object.assign({}, r, { idx, vpd: idx / r.price });
    });
    const best = Math.max(...rows.map((r) => r.vpd).filter(isFinite), 0);
    const bsum = (r) => (r.b || []).reduce((a, b) => a + b.v, 0);
    rows.forEach((r) => {
      r.value = best ? Math.round((100 * r.vpd) / best) : NaN;
      r.star = !rows.some((o) => o !== r && o.name === r.name && o.price <= r.price &&
        (o.dmg || 0) >= (r.dmg || 0) && (o.acc || 0) >= (r.acc || 0) && (o.arm || 0) >= (r.arm || 0) && bsum(o) >= bsum(r) &&
        (o.price < r.price || (o.dmg || 0) > (r.dmg || 0) || (o.acc || 0) > (r.acc || 0) || bsum(o) > bsum(r)));
      r.v = valuate({ name: r.name, rarity: r.rarity, b: r.b, dmg: r.dmg, acc: r.acc, arm: r.arm });
      r.deal = dealOf(r.price, r.v);
    });
    const shown = mf.dealsOnly ? rows.filter((r) => r.deal.k === 'great' || r.deal.k === 'good') : rows;
    status(`${rows.length} listings; ${rows.filter((r) => r.deal.k === 'great').length} great deals, ${rows.filter((r) => r.deal.k === 'good').length} good.`);
    const grade = (v) => (v >= 90 ? 'g-ex' : v >= 75 ? 'g-gd' : v >= 60 ? 'g-fr' : 'g-pr');
    const cols = [
      { h: '★', v: (r) => (r.star ? 1 : 0) },
      { h: 'Item', v: (r) => r.name },
      { h: 'Price', v: (r) => r.price, num: 1 },
      { h: 'Rarity', v: (r) => ({ yellow: 1, orange: 2, red: 3 }[r.rarity] || 0) },
      { h: 'Qual', v: (r) => r.q, num: 1 },
      { h: 'Dmg', v: (r) => r.dmg, num: 1 },
      { h: 'Acc', v: (r) => r.acc, num: 1 },
      { h: 'Arm', v: (r) => r.arm, num: 1 },
      { h: 'Bonuses', v: (r) => (r.b[0] ? r.b[0].v : 0) },
      { h: 'Index', v: (r) => r.idx, num: 1 },
      { h: 'Value', v: (r) => r.value, num: 1, def: 1 },
      { h: 'Auction fair', v: (r) => r.v.p50, num: 1 },
      { h: 'Deal', v: (r) => (isFinite(r.deal.pct) ? -r.deal.pct : -1e9), num: 1 },
    ];
    sortable($('#m-tbl'), shown, cols, 'mkt', (r) => `<tr class="${r.deal.k ? 'deal-' + r.deal.k : ''}"><td class="star">${r.star ? '★' : ''}</td><td>${esc(r.name)}</td><td class="num"><b>${money(r.price)}</b></td>
      <td>${rarityCell(r.rarity)}</td><td class="num">${fmt(r.q, 1)}</td><td class="num">${fmt(r.dmg, 2)}</td><td class="num">${fmt(r.acc, 2)}</td><td class="num">${fmt(r.arm, 2)}</td>
      <td>${bonusCell(r.b, r.rarity)}</td><td class="num">${fmt(r.idx, 1)}</td><td class="num ${grade(r.value)}"><b>${fmt(r.value)}</b></td>
      <td class="num">${r.v.n ? money(r.v.p50) + ' <span class="muted">(' + r.v.n + ')</span>' : '<span class="muted">–</span>'}</td>
      <td class="num ${r.deal.cls}"><b>${esc(r.deal.label)}</b>${isFinite(r.deal.pct) ? ' <span class="muted">' + (r.deal.pct > 0 ? '+' : '') + fmt(r.deal.pct) + '%</span>' : ''}</td></tr>`);
  }

  // ---------- Ranking ----------
  let RANK = [];
  function viewRank(m) {
    m.innerHTML = `
      <div class="card">
        <div class="hint">Index = 100 × damage factor × bonus multiplier; 100 = a 70-damage weapon with no scored bonus. Damage factor compounds ${S.dmgPerPt}% per damage point (mug's guide: 10 points ≈ 25%). Assumptions (change in Settings): armour absorbs ${S.armour}% of damage (guide: about 1% per armour point; Assault is rated 46 to 51), crit chance ${S.critChance}%, crits ${S.critMult}× normal. Blue tags on bonuses show the guide's damage tier; ↓ low roll, ↑ high roll for that colour. Auction House badges: solid green/amber/red = graded in the last hour (green outline on Great and Good); dashed teal/blue/amber/red = auction not ending yet, coloured by where the current bid sits; purple = too few comparable sales; grey = no history. Scored bonuses: ${SCORED.join(', ')}; others count as 1.0. Weapon damage does not translate one-for-one into damage dealt, so use the index to rank, not to predict.</div>
        <div class="row">
          <label>Weapon<input id="r-n" style="width:160px"></label>
          <label>Dmg<input id="r-d" type="number" step="0.01"></label>
          <label>Acc<input id="r-a" type="number" step="0.01"></label>
          <label>Bonus 1<select id="r-b1">${bonusOptions('')}</select></label><label>%<input id="r-v1" type="number"></label>
          <label>Bonus 2<select id="r-b2">${bonusOptions('')}</select></label><label>%<input id="r-v2" type="number"></label>
          <label>Price<input id="r-p" placeholder="e.g. 850m" style="width:90px"></label>
          <button class="b" id="r-add">Add</button><button class="b2" id="r-clr">Clear</button>
        </div>
        <div class="row"><label>Armour absorbs %<input id="r-arm" type="number" value="${S.armour}"></label><button class="b2" id="r-re">Recalculate</button></div>
      </div><div class="tblwrap"><table id="r-tbl"></table></div>`;
    $('#r-add').onclick = () => {
      const b = [];
      if ($('#r-b1').value) b.push({ t: $('#r-b1').value, v: +$('#r-v1').value || 0 });
      if ($('#r-b2').value) b.push({ t: $('#r-b2').value, v: +$('#r-v2').value || 0 });
      RANK.push({ name: $('#r-n').value || 'Weapon', dmg: +$('#r-d').value, acc: +$('#r-a').value, b, price: parseMoney($('#r-p').value) });
      renderRank();
    };
    $('#r-clr').onclick = () => { RANK = []; renderRank(); };
    $('#r-re').onclick = () => { S.armour = +$('#r-arm').value || 0; save(); renderRank(); };
    renderRank();
  }
  function renderRank() {
    const rows = RANK.map((r) => Object.assign({}, r, { mult: multOf(r.b), idx: indexOf(r.dmg, r.b), per: isFinite(r.price) && r.price > 0 ? indexOf(r.dmg, r.b) / (r.price / 1e9) : NaN }));
    const cols = [
      { h: 'Weapon', v: (r) => r.name }, { h: 'Dmg', v: (r) => r.dmg, num: 1 }, { h: 'Acc', v: (r) => r.acc, num: 1 },
      { h: 'Bonuses', v: (r) => (r.b[0] ? r.b[0].v : 0) }, { h: 'Mult', v: (r) => r.mult, num: 1 },
      { h: 'Index', v: (r) => r.idx, num: 1, def: 1 }, { h: 'Price', v: (r) => r.price, num: 1 }, { h: 'Index per $1b', v: (r) => r.per, num: 1 },
    ];
    sortable($('#r-tbl'), rows, cols, 'rank', (r) => `<tr><td>${esc(r.name)}</td><td class="num">${fmt(r.dmg, 2)}</td><td class="num">${fmt(r.acc, 2)}</td><td>${bonusCell(r.b, r.rarity)}</td>
      <td class="num">${fmt(r.mult, 2)}</td><td class="num"><b>${fmt(r.idx, 1)}</b></td><td class="num">${money(r.price)}</td><td class="num">${fmt(r.per, 1)}</td></tr>`);
  }

  // ---------- Mods ----------
  function viewMods(m) {
    const mine = S.myTypes.split(/[,\s]+/).map((x) => x.toUpperCase()).filter(Boolean);
    m.innerHTML = `
      <div class="card"><div class="row">
        <label>Mod<select id="o-mod">${MODS.map((x, i) => `<option value="${i}">${x.type}: ${x.name}</option>`).join('')}</select></label>
        <label>Price (credits)<input id="o-p" type="number"></label><span id="o-out" style="font-weight:bold"></span></div>
        <div class="hint">Grades: position between the lowest special-offer price and the highest normal price. On the missions page, the Mission Mod Checker script badges rewards directly.</div></div>
      <div class="tblwrap"><table><thead><tr><th>Type</th><th>Mod</th><th>Bonus</th><th class="num">Special offer</th><th class="num">Normal</th><th>Fits</th></tr></thead><tbody>
      ${MODS.map((x) => { const fit = x.fits.split(/[,\s]+/).some((t) => mine.includes(t)); return `<tr><td>${x.type}</td><td>${x.name}</td><td>${x.bonus}</td><td class="num">${fmt(x.s[0])} to ${fmt(x.s[1])}</td><td class="num">${fmt(x.n[0])} to ${fmt(x.n[1])}</td><td class="${fit ? 'g-ex' : 'muted'}">${x.fits}</td></tr>`; }).join('')}
      </tbody></table></div>`;
    const run = () => {
      const mod = MODS[+$('#o-mod').value]; const p = +$('#o-p').value;
      if (!p) { $('#o-out').textContent = ''; return; }
      const [label, cls] = modGrade(mod, p);
      $('#o-out').className = 'g-' + cls; $('#o-out').textContent = `${mod.name} at ${fmt(p)}: ${label}`;
    };
    $('#o-mod').onchange = run; $('#o-p').oninput = run;
  }

  // ---------- Settings ----------
  function viewSettings(m) {
    m.innerHTML = `
      <div class="card">
        <div class="hint">Use a <b>Public</b> access key (Torn: Settings > API Keys > Create, access level Public). Never paste a Full Access key. The key stays in this browser's localStorage and is sent only to api.torn.com.</div>
        <div class="row"><label>Public API key<input id="s-key" type="password" value="${esc(S.key)}" style="width:200px" autocomplete="off"></label></div>
        <div class="row">
          <label>Armour absorbs %<input id="s-arm" type="number" value="${S.armour}"></label>
          <label>Crit chance %<input id="s-cc" type="number" value="${S.critChance}"></label>
          <label>Crit multiple<input id="s-cm" type="number" step="0.1" value="${S.critMult}"></label>
          <label>Min comparable sales<input id="s-mc" type="number" value="${S.minComps}"></label>
          <label>Grade auctions ending within (min)<input id="s-gw" type="number" value="${S.gradeWithinMin}"></label>
          <label>% damage per damage point<input id="s-dpp" type="number" step="0.01" value="${S.dmgPerPt}"></label>
          <label>Comparables window (days)<input id="s-days" type="number" value="${S.days}"></label>
          <label>Gap between calls (ms)<input id="s-gap" type="number" value="${S.gapMs}" min="650"></label>
          <label>My weapon types<input id="s-types" value="${esc(S.myTypes)}"></label>
        </div>
        <div class="row"><button class="b" id="s-save">Save</button><button class="b2" id="s-items">Reload item list</button><button class="b2" id="s-clear">Clear sales cache</button></div>
        <div class="muted">Cache: ${fmt(SALES.length)} sales, ${fmt(ITEMS.length)} items.</div>
      </div>`;
    $('#s-save').onclick = () => {
      const k = $('#s-key').value.trim();
      if (k && !/^[A-Za-z0-9]{16}$/.test(k)) { status('Key should be 16 letters and numbers.'); return; }
      S.key = k; S.armour = +$('#s-arm').value || 0; S.critChance = +$('#s-cc').value || 0; S.critMult = +$('#s-cm').value || 1;
      S.days = +$('#s-days').value || 180; S.dmgPerPt = +$('#s-dpp').value || 0; S.minComps = Math.max(1, +$('#s-mc').value || 5); S.gradeWithinMin = Math.max(1, +$('#s-gw').value || 60); S.gapMs = Math.max(650, +$('#s-gap').value || 1000); S.myTypes = $('#s-types').value;
      save(); status('Saved.');
    };
    $('#s-items').onclick = async () => { try { await loadItems(true); status(`${ITEMS.length} items loaded.`); viewSettings(m); } catch (e) { status(e.message); } };
    $('#s-clear').onclick = async () => { await clearSales(); SALES = []; status('Sales cache cleared.'); viewSettings(m); };
  }

  // ================= Auction House badges (amarket.php) =================
  // Each live auction is ul.items-list > li#<auctionId>. Current bid comes from the page;
  // exact stats, bonuses and rarity come from market/{id}/auctionhouselisting (Public key).
  // If the API returns nothing for a live auction, stats are read from the page text instead.
  const AH = new Map(); // auctionId -> {status:'pending'|'api'|'dom', data}
  const AH_CSS = `
    .ac-ah{margin:4px 6px 6px;padding:4px 6px;border-radius:5px;font:11px/1.35 Arial,sans-serif;color:#fff !important;background:#2a2a2a;border:1px solid #666;clear:both}
    .ac-ah b{color:#fff !important}
    .ac-ah .m{color:#cfcfcf !important}
    .ac-ah.great{background:#163016;border-color:#3fbf3f}
    .ac-ah.good{background:#25301a;border-color:#8fd14f}
    .ac-ah.fair{background:#332b14;border-color:#e0b030}
    .ac-ah.over{background:#331616;border-color:#d04040}
    .ac-ah.e-great{background:#10302b;border-color:#2fc4a8;border-style:dashed}
    .ac-ah.e-good{background:#14282a;border-color:#6fb7c9;border-style:dashed}
    .ac-ah.e-fair{background:#2e2914;border-color:#c9a53a;border-style:dashed}
    .ac-ah.e-over{background:#2e1616;border-color:#c04848;border-style:dashed}
    .ac-ah.thin{background:#24233a;border-color:#7a76b8}
    .ac-ah.none{background:#2a2a2a;border-color:#666}
    li.ac-hl-great{outline:2px solid #3fbf3f !important;outline-offset:-2px}
    li.ac-hl-good{outline:2px solid #8fd14f !important;outline-offset:-2px}
    .ac-ah button{background:#444;color:#fff;border:1px solid #777;border-radius:4px;padding:1px 6px;cursor:pointer;font-size:11px;margin-left:4px}
  `;
  function ahListings() {
    return Array.from(document.querySelectorAll('ul.items-list > li')).filter((li) => /^\d+$/.test(li.id));
  }
  function ahFromDom(liOrig) {
    const li = liOrig.cloneNode(true);
    li.querySelectorAll('.ac-ah').forEach((x) => x.remove());
    const toks = leafTexts(li);
    const name = (toks.find((t) => /[a-z]/i.test(t) && !/^\(/.test(t)) || '').replace(/\s*\(.*$/, '').trim();
    let priceV = NaN;
    for (const t of toks) { const m = t.replace(/\s/g, '').match(/\$([\d,]{2,})/); if (m) { priceV = +m[1].replace(/,/g, ''); break; } }
    const priceM = [0, priceV];
    // numeric leaf text such as 82.10 and 46.03
    const nums = [];
    li.querySelectorAll('*').forEach((el) => {
      if (el.children.length) return;
      const t = (el.textContent || '').trim();
      if (/^\d{1,3}\.\d{2}$/.test(t)) nums.push(parseFloat(t));
    });
    // bonuses from tooltips/attributes, e.g. "Puncture 23%" or "23% Puncture"
    const b = [];
    li.querySelectorAll('[title],[aria-label],[data-title],[data-bonus],i,span').forEach((el) => {
      const txt = [el.getAttribute('title'), el.getAttribute('aria-label'), el.getAttribute('data-title'), el.getAttribute('data-bonus')].filter(Boolean).join(' ');
      if (!txt) return;
      const clean = txt.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
      BONUSES.forEach((bn) => {
        if (b.some((x) => norm(x.t) === norm(bn))) return;
        const name = bn.replace(/[-\s]/g, '[-\\s]');
        if (!new RegExp('\\b' + name + '\\b', 'i').test(clean)) return;
        // number% after the name (before the next %), else number% just before the name
        const after = clean.match(new RegExp('\\b' + name + '\\b[^%]{0,80}?(\\d+(?:\\.\\d+)?)\\s*%', 'i'));
        const before = clean.match(new RegExp('(\\d+(?:\\.\\d+)?)\\s*%[^%\\d]{0,30}\\b' + name + '\\b', 'i'));
        const v = after || before;
        b.push({ t: bn, v: v ? Math.round(+v[1]) : 0 });
      });
    });
    const cls = (li.className || '') + ' ' + Array.from(li.querySelectorAll('[class]')).map((e) => (typeof e.className === 'string' ? e.className : '')).join(' ');
    const rm = cls.match(/\b(?:glow-)?(yellow|orange|red)\b/i);
    return { name, price: priceM ? +priceM[1] : NaN, dmg: nums[0], acc: nums[1], b, rarity: rm ? rm[1].toLowerCase() : null };
  }
  // Text of each element's own text nodes, in page order, skipping our badge.
  function leafTexts(root) {
    const out = [];
    const walk = (el) => {
      if (el.classList && el.classList.contains('ac-ah')) return;
      el.childNodes.forEach((n) => {
        if (n.nodeType === 3) { const t = n.textContent.replace(/\s+/g, ' ').trim(); if (t) out.push(t); }
        else if (n.nodeType === 1) walk(n);
      });
    };
    walk(root);
    return out;
  }
  function ahTimeLeft(li) {
    const toks = leafTexts(li);
    for (let i = toks.length - 1; i >= 0; i--) {
      const t = toks[i];
      if (/^(\d+\s*d)?\s*(\d+\s*h)?\s*(\d+\s*m)?\s*(\d+\s*s)?$/i.test(t) && /\d\s*[dhms]/i.test(t)) {
        let sec = 0;
        t.replace(/(\d+)\s*([dhms])/gi, (_, n, u) => { sec += +n * { d: 86400, h: 3600, m: 60, s: 1 }[u.toLowerCase()]; });
        return sec;
      }
    }
    // fallback: time at the end of the listing text, e.g. "... 8h 19m"
    const m = toks.join(' ').match(/(?:^|[^\d,.$])((?:\d+\s*d\s*)?(?:\d+\s*h\s*)?(?:\d+\s*m\s*)?(?:\d+\s*s)?)\s*$/i);
    if (m && /\d\s*[dhms]/i.test(m[1])) { let sec = 0; m[1].replace(/(\d+)\s*([dhms])/gi, (_, n, u) => { sec += +n * { d: 86400, h: 3600, m: 60, s: 1 }[u.toLowerCase()]; }); return sec; }
    return NaN;
  }
  async function ahFetch(id) {
    try {
      const j = await api('market/' + id + '/auctionhouselisting', {});
      const L = j.auctionhouselisting;
      if (!L || !L.item) return null;
      const it = L.item, st = it.stats || {};
      return { itemId: it.id, name: it.name, rarity: (it.rarity || '').toLowerCase() || null, q: st.quality, dmg: st.damage, acc: st.accuracy, arm: st.armor, b: (it.bonuses || []).map((x) => ({ t: x.title, v: x.value })) };
    } catch (e) { return null; }
  }
  let seenTimer = null;
  function recordSeen(d, price, left) {
    if (!d || !d.name || !isFinite(price)) return;
    SEEN[wKey(d)] = { price, ts: Date.now(), endsAt: isFinite(left) ? Date.now() + left * 1000 : NaN };
    clearTimeout(seenTimer);
    seenTimer = setTimeout(async () => {
      const now = Date.now();
      Object.keys(SEEN).forEach((k) => { if (now - SEEN[k].ts > 3 * 864e5) delete SEEN[k]; });
      try { const old = (await kvGet('ahseen')) || {}; await kvSet('ahseen', Object.assign(old, SEEN)); } catch (e) { /* ignore */ }
    }, 1500);
  }
  function ahBadge(li, d, price) {
    const left = ahTimeLeft(li);
    recordSeen(d, price, left);
    let box = li.querySelector(':scope > .ac-ah');
    if (!box) { box = document.createElement('div'); box.className = 'ac-ah'; li.appendChild(box); }
    const t = { name: d.name, rarity: d.rarity, b: d.b, dmg: d.dmg, acc: d.acc, arm: d.arm };
    const v = valuate(t);
    let deal = dealOf(price, v);
    const early = isFinite(left) && left > (S.gradeWithinMin || 60) * 60;
    let tone = '';
    if (early && deal.k) { tone = 'e-' + deal.k; deal = Object.assign({}, deal, { early: true, k: '' }); }
    li.classList.remove('ac-hl-great', 'ac-hl-good');
    if (deal.k === 'great' || deal.k === 'good') li.classList.add('ac-hl-' + deal.k);
    if (!tone) tone = deal.k || (deal.thin ? 'thin' : 'none');
    box.className = 'ac-ah ' + tone;
    const src = d.src === 'api' ? '' : ' <span class="m">(stats read from page)</span>';
    const idx = d.type === 'Armor' || (!isFinite(d.dmg) && isFinite(d.arm)) ? '' : ` · Index <b>${fmt(indexOf(d.dmg, d.b), 1)}</b>`;
    const bon = (d.b || []).map((x) => { const n = guideNote(x.t, x.v, d.rarity); return esc(x.t) + ' ' + esc(x.v) + '%' + (n ? ' [' + esc(n) + ']' : ''); }).join(', ') || 'no bonus';
    const hrs = isFinite(left) ? (left >= 3600 ? Math.floor(left / 3600) + 'h ' + Math.floor((left % 3600) / 60) + 'm' : Math.floor(left / 60) + 'm') : '?';
    if (!v.n) {
      box.innerHTML = `<b>No auction history cached</b> for ${esc(d.name)} (${bon})${idx}${src} <button data-f="1">Fetch history</button>`;
    } else if (deal.thin) {
      box.innerHTML = `<b>Not enough history</b>: only ${v.n} comparable sale${v.n === 1 ? '' : 's'} (need ${S.minComps}). Nearest sold for ${money(v.p50)}${idx} <span class="m">(${bon})</span>${src} <button data-f="1">Fetch more history</button>`;
    } else if (deal.early) {
      const band = { great: 'still in great-buy range', good: 'still below fair', fair: 'above fair, below ceiling', over: 'already over ceiling' }[tone.slice(2)] || '';
      box.innerHTML = `<b>Ends in ${hrs}: bid not final, ${band}.</b> Current ${money(price)} (${deal.pct > 0 ? '+' : ''}${fmt(deal.pct)}% vs fair) · bid up to <b>${money(v.p50)}</b> for fair value, <b>${money(v.p25)}</b> or less is a great buy, ceiling <b>${money(v.p75)}</b> · ${v.n} comps${idx} <span class="m">(${bon})</span>${src} <button data-f="1">Refresh</button>`;
    } else {
      box.innerHTML = `<b>${esc(deal.label)}</b> at ${money(price)} (${deal.pct > 0 ? '+' : ''}${fmt(deal.pct)}% vs fair) · Great ≤ <b>${money(v.p25)}</b> · Fair <b>${money(v.p50)}</b> · Ceiling <b>${money(v.p75)}</b> · ${v.n} comps${idx} <span class="m">(${bon})</span>${src} <button data-f="1">Refresh</button>`;
    }
    const btn = box.querySelector('button[data-f]');
    if (btn) btn.onclick = async (e) => {
      e.preventDefault(); e.stopPropagation();
      btn.textContent = 'Fetching…';
      try {
        if (!ITEMS.length) await loadItems();
        const it = d.itemId ? { id: d.itemId } : itemByName(d.name);
        if (it) await fetchItemHistory(it.id, 5);
      } catch (err) { btn.textContent = err.message; return; }
      ahScan(true);
    };
  }
  let ahBusy = false;
  let ahMiss = 0; // live auctions are not served by the listing endpoint; stop after 3 misses
  async function ahScan(force) {
    if (ahBusy && !force) return;
    ahBusy = true;
    try {
      if (!SALES.length) { try { SALES = await dbAll('sales'); } catch (e) { /* ignore */ } }
      if (!ITEMS.length) { try { const c = await kvGet('items'); if (c) ITEMS = c.list; } catch (e) { /* ignore */ } }
      const lis = ahListings();
      for (const li of lis) {
        const id = li.id;
        const dom = ahFromDom(li);
        let rec = AH.get(id);
        if (!rec) {
          rec = { status: 'pending', data: Object.assign({ src: 'dom' }, dom) };
          AH.set(id, rec);
          ahBadge(li, rec.data, dom.price);
          if (/^[A-Za-z0-9]{16}$/.test(S.key) && ahMiss < 3) {
            const a = await ahFetch(id);
            if (a && a.name) { rec.data = Object.assign({ src: 'api' }, a); ahMiss = 0; } else ahMiss++;
          }
          rec.status = 'done';
        }
        ahBadge(li, rec.data, dom.price);
      }
    } finally { ahBusy = false; }
  }
  function installAH() {
    if (!/amarket\.php/i.test(location.href) || window.__acAH) return;
    window.__acAH = true;
    const st = document.createElement('style'); st.textContent = AH_CSS; document.head.appendChild(st);
    let tmr = null;
    const obs = new MutationObserver((muts) => {
      if (muts.every((m) => m.target.closest && m.target.closest('.ac-ah'))) return;
      clearTimeout(tmr); tmr = setTimeout(() => ahScan(false), 500);
    });
    obs.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => ahScan(false), 800);
    // Capture button kept for troubleshooting the page layout.
    const b = document.createElement('button');
    b.textContent = 'Capture auction page';
    b.style.cssText = 'position:fixed;left:8px;bottom:130px;z-index:2147483646;background:#2e6b3a;color:#fff;border:none;border-radius:20px;padding:7px 12px;font:bold 12px Arial,sans-serif;cursor:pointer';
    b.onclick = () => {
      const lis = ahListings();
      const dump = '=== URL ===\n' + location.href + '\n=== LISTINGS: ' + lis.length + ' ===\n\n' +
        lis.slice(0, 3).map((li, i) => '--- li ' + i + ' ---\n' + li.outerHTML.replace(/<div class="ac-ah[\s\S]*?<\/div>/, '').slice(0, 8000) + '\n\nPARSED: ' + JSON.stringify(ahFromDom(li)) + '\nAPI: ' + JSON.stringify((AH.get(li.id) || {}).data || null)).join('\n\n');
      const box = document.createElement('div');
      box.style.cssText = 'position:fixed;inset:10%;z-index:2147483647;background:#14111b;color:#fff;border:1px solid #7b3fe4;border-radius:8px;padding:10px;display:flex;flex-direction:column;gap:6px;font:12px Arial';
      box.innerHTML = '<b style="color:#fff">Auction page capture: copy all of this and send it to Claude</b>';
      const ta = document.createElement('textarea'); ta.value = dump; ta.style.cssText = 'flex:1;background:#0f0d15;color:#ddd;font:11px monospace';
      const row = document.createElement('div');
      const c = document.createElement('button'); c.textContent = 'Copy'; c.onclick = () => { ta.select(); try { navigator.clipboard.writeText(dump).then(() => (c.textContent = 'Copied'), () => document.execCommand('copy')); } catch (e) { document.execCommand('copy'); } };
      const x = document.createElement('button'); x.textContent = 'Close'; x.onclick = () => box.remove();
      row.append(c, ' ', x); box.append(ta, row); document.body.appendChild(box);
    };
    document.body.appendChild(b);
  }

  // ================= Boot =================
  const boot = () => { try { build(); } catch (e) { console.error('[Archer Console]', e); } try { installAH(); } catch (e) { console.error('[Archer Console AH]', e); } };
  if (document.body) boot(); else window.addEventListener('DOMContentLoaded', boot);

  // exposed for testing in Node (no effect in browser)
  if (typeof module !== 'undefined') module.exports = { mergeImported, getImported: () => IMPORTED, ahTimeLeft, guideNote, ahFromDom, dealOf, bonusMult, indexOf, multOf, parsePaste, valuate, setSales: (s) => { SALES = s; }, S };
})();
