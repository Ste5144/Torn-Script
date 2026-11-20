// ==UserScript==
// @name         Archer War Board
// @namespace    sterlingarcher.torn
// @version      1.11
// @description  Enemy hospital countdowns sorted by soonest out, optional time filter, and a one-click "next N to chat" message with attack links. Display only: reads the Torn API with a Public key and never acts for you.
// @match        https://www.torn.com/factions.php*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_setClipboard
// @grant        GM_notification
// @connect      api.torn.com
// @run-at       document-idle
// @author       SterlingArcher
// @homepageURL  https://github.com/Ste5144/Torn-Script
// @updateURL    https://raw.githubusercontent.com/Ste5144/Torn-Script/main/archer-war-board.user.js
// @downloadURL  https://raw.githubusercontent.com/Ste5144/Torn-Script/main/archer-war-board.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ---------- Settings ----------
  const POLL_MS = 15000;            // API refresh: every 15 s, plus an early refresh when the page shows a status change (well under the 100/min key limit)
  if (GM_getValue('awb_ver', 0) < 13) { GM_setValue('awb_enemy', ''); GM_setValue('awb_ver', 13); }
  if (GM_getValue('awb_ver', 0) < 162) { GM_setValue('awb_newtab', true); GM_setValue('awb_ver', 162); }
  const S = {
    key:         GM_getValue('awb_key', ''),
    enemy:       GM_getValue('awb_enemy', ''),     // manual override; blank = your current ranked war opponent (from the API)
    count:       GM_getValue('awb_count', 3),      // how many targets go in the chat message
    windowMin:   GM_getValue('awb_window', 0),     // only show hospital targets out within N minutes (0 = show all)
    includeOkay: GM_getValue('awb_okay', true),    // list enemies already out (Okay) at the top
    newTab:      GM_getValue('awb_newtab', true),  // open attack links in a new tab (untick in ⚙ for same tab)
    multiLine:   GM_getValue('awb_multiline', true), // chat message: one target per line
    pageSort:    GM_getValue('awb_pagesort', false), // re-order the page's enemy list by hospital time
    collapsed:   GM_getValue('awb_collapsed', false),
    inline:      GM_getValue('awb_inline', true),     // put countdowns in Torn's own Hospital status cells
    myStats:     GM_getValue('awb_mystats', ''),      // your total battle stats, e.g. 2.5b (for BSP colouring)
    hideRed:     GM_getValue('awb_hidered', false),   // hide targets BSP says are much stronger than you
    alertSec:    GM_getValue('awb_alertsec', 10),     // watch-list alert this many seconds before release
    sound:       GM_getValue('awb_sound', true),      // beep for watch-list and chain alerts
    notify:      GM_getValue('awb_notify', true),     // browser notification for watch-list alerts
    chainWarn:   GM_getValue('awb_chainwarn', 60),    // warn when your chain timer is below N seconds (0 = off)
    calledMin:   GM_getValue('awb_calledmin', 3),     // skip targets already posted to chat for N minutes (0 = off)
    showTravel:  GM_getValue('awb_showtravel', false), // travellers list expanded
    bspChat:     GM_getValue('awb_bspchat', false), // include BSP figures in the chat message (off: BSP is a paid service; check its terms before sharing)
    rows:        GM_getValue('awb_rows', 12),         // target rows visible before scrolling (0 = as many as fit the screen)
  };
  const save = () => {
    GM_setValue('awb_key', S.key);
    GM_setValue('awb_enemy', S.enemy);
    GM_setValue('awb_count', S.count);
    GM_setValue('awb_window', S.windowMin);
    GM_setValue('awb_okay', S.includeOkay);
    GM_setValue('awb_newtab', S.newTab);
    GM_setValue('awb_multiline', S.multiLine);
    GM_setValue('awb_pagesort', S.pageSort);
    GM_setValue('awb_collapsed', S.collapsed);
    GM_setValue('awb_inline', S.inline);
    GM_setValue('awb_mystats', S.myStats);
    GM_setValue('awb_hidered', S.hideRed);
    GM_setValue('awb_alertsec', S.alertSec);
    GM_setValue('awb_sound', S.sound);
    GM_setValue('awb_notify', S.notify);
    GM_setValue('awb_chainwarn', S.chainWarn);
    GM_setValue('awb_calledmin', S.calledMin);
    GM_setValue('awb_showtravel', S.showTravel);
    GM_setValue('awb_rows', S.rows);
    GM_setValue('awb_bspchat', S.bspChat);
  };

  // ---------- State ----------
  let members = [];        // {id, name, level, state, until, desc, pending}
  const pageHosp = new Map(); // player id -> time the page showed "Hospital" while our data said out
  // In hospital? "pending" = the page says Hospital but we don't have the new release time yet.
  const inHosp = (m, t) => m.state === 'Hospital' && (m.pending || m.until > t);
  let factionName = '';
  let offset = 0;          // Torn server clock minus local clock (seconds)
  let lastFetch = 0;
  let lastError = '';
  let lastChatBox = null;  // the chat textarea you last clicked into
  const watch = new Set(GM_getValue('awb_watch', []).map(String));  // starred player ids
  const alerted = new Map();  // player id -> release time we already alerted for
  const called = new Map();   // player id -> {at, until} when posted to chat
  const travelSeen = new Map(); // player id -> {desc, since} first time we saw this trip
  let chain = null;           // {current, max, timeout, cooldown, at}
  let chainAlertedAt = 0;

  const now = () => Math.floor(Date.now() / 1000) + offset;
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const attackUrl = id => `https://www.torn.com/page.php?sid=attack&user2ID=${id}`;
  const profileUrl = id => `https://www.torn.com/profiles.php?XID=${id}`;

  function fmtLeft(sec) {
    if (sec <= 0) return 'now';
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  }
  const fmtTct = ts => new Date(ts * 1000).toISOString().substr(11, 8); // TCT = UTC

  // ---------- API ----------
  function api(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET', url, timeout: 15000,
        onload: r => {
          const d = /^date:\s*(.+)$/im.exec(r.responseHeaders || '');
          if (d) { const t = Date.parse(d[1]); if (!isNaN(t)) offset = Math.round((t - Date.now()) / 1000); }
          try {
            const j = JSON.parse(r.responseText);
            if (j.error) reject(new Error(`API error ${j.error.code}: ${j.error.error}`));
            else resolve(j);
          } catch (e) { reject(new Error('Unreadable API response')); }
        },
        onerror: () => reject(new Error('Network error')),
        ontimeout: () => reject(new Error('API timeout')),
      });
    });
  }

  function parseMembers(j) {
    const norm = (id, m) => ({
      id: +id, name: m.name, level: m.level,
      state: (m.status && m.status.state) || 'Unknown',
      until: (m.status && m.status.until) || 0,
      desc: (m.status && m.status.description) || '',
      act: ((m.last_action && m.last_action.status) || '').toLowerCase(),        // online / idle / offline
      actRel: (m.last_action && m.last_action.relative) || '',
    });
    if (Array.isArray(j.members)) return j.members.map(m => norm(m.id, m));                       // API v2
    if (j.members && typeof j.members === 'object') return Object.entries(j.members).map(([id, m]) => norm(id, m)); // API v1
    return [];
  }

  // ---------- Who are we fighting? ----------
  // Blank enemy ID = ask the API for your own faction's current ranked war. Never guessed from the page.
  let enemyId = '', enemySource = '', warCheckedAt = 0;
  const RW_RECHECK = 300; // seconds between ranked-war look-ups

  function pickRankedWar(wars, ownId) {
    // wars: [{start, end, factions:[{id,name}]}]
    const t = now();
    const live = wars.filter(w => !w.end || w.end > t).sort((a, b) => b.start - a.start);
    if (!live.length) return null;
    const other = live[0].factions.find(f => String(f.id) !== String(ownId));
    return other ? { id: String(other.id), name: other.name || '' } : null;
  }

  async function findRankedEnemy() {
    try { // API v1: own faction basic includes ranked_wars
      const j = await api(`https://api.torn.com/faction/?selections=basic&key=${S.key}&comment=ArcherWarBoard`);
      const wars = Object.values(j.ranked_wars || {}).map(w => ({
        start: (w.war && w.war.start) || 0, end: (w.war && w.war.end) || 0,
        factions: Object.entries(w.factions || {}).map(([id, f]) => ({ id, name: f.name })),
      }));
      if (j.ID || j.id) return pickRankedWar(wars, j.ID || j.id);
    } catch (e) { /* fall through to v2 */ }
    const b = await api(`https://api.torn.com/v2/faction/basic?key=${S.key}&comment=ArcherWarBoard`);
    const w = await api(`https://api.torn.com/v2/faction/wars?key=${S.key}&comment=ArcherWarBoard`);
    const r = w.wars && w.wars.ranked;
    const list = (Array.isArray(r) ? r : r ? [r] : []).map(x => ({ start: x.start || 0, end: x.end || 0, factions: x.factions || [] }));
    return pickRankedWar(list, b.basic && b.basic.id);
  }

  async function resolveEnemy() {
    if (S.enemy) { enemySource = 'manual'; return S.enemy; }
    if (enemyId && enemySource === 'auto' && now() - warCheckedAt < RW_RECHECK) return enemyId;
    warCheckedAt = now();
    const e = await findRankedEnemy();
    enemySource = 'auto';
    return e ? e.id : '';
  }

  let inflight = false, queued = null;
  function requestRefresh() {           // early refresh, at most one every 4 s
    if (queued || inflight) return;
    const wait = Math.max(0, 4 - (now() - lastFetch)) * 1000;
    queued = setTimeout(() => { queued = null; refresh(); }, wait);
  }

  async function refresh() {
    if (inflight) return;
    inflight = true;
    try { await doRefresh(); } finally { inflight = false; }
  }

  async function doRefresh() {
    if (!S.key) { lastError = 'Enter your Public API key in ⚙.'; render(); return; }
    try {
      const id = await resolveEnemy();
      if (!id) { enemyId = ''; members = []; factionName = ''; lastError = 'No active ranked war found. Enter the enemy faction ID in ⚙.'; render(); return; }
      if (id !== enemyId) { enemyId = id; members = []; factionName = ''; }
      let j;
      try { j = await api(`https://api.torn.com/faction/${id}?selections=basic&key=${S.key}&comment=ArcherWarBoard&timestamp=${now()}`); }
      catch (e1) { j = await api(`https://api.torn.com/v2/faction/${id}/members?key=${S.key}&comment=ArcherWarBoard`); }
      members = parseMembers(j);
      // The page's live status can be ahead of the API. Keep anyone the page showed in hospital
      // in the last 90 s as "in hospital, time updating" until the API catches up.
      const t = now();
      members.forEach(m => {
        const seen = pageHosp.get(m.id);
        if (m.state === 'Hospital' && m.until > t) { pageHosp.delete(m.id); return; }
        if (seen && t - seen < 90) { m.state = 'Hospital'; m.pending = true; requestRefresh(); }
        else pageHosp.delete(m.id);
      });
      if (j.name) factionName = j.name;
      lastFetch = now();
      trackTravel();
      fetchChain();
      lastError = members.length ? '' : 'No members returned. Check the faction ID.';
    } catch (e) {
      lastError = e.message;
    }
    render();
  }


  // ---------- Your chain (own faction; Public key) ----------
  async function fetchChain() {
    if (!S.chainWarn) { chain = null; return; }
    try {
      let c;
      try { c = (await api(`https://api.torn.com/faction/?selections=chain&key=${S.key}&comment=ArcherWarBoard&timestamp=${now()}`)).chain; }
      catch (e) { c = (await api(`https://api.torn.com/v2/faction/chain?key=${S.key}&comment=ArcherWarBoard`)).chain; }
      if (c) chain = { current: c.current || 0, max: c.max || 0, timeout: c.timeout || 0, cooldown: c.cooldown || 0, at: now() };
    } catch (e) { /* chain is optional */ }
  }
  const chainLeft = () => chain ? Math.max(0, chain.timeout - (now() - chain.at)) : 0;

  // ---------- Travellers ----------
  const seenHome = new Set();  // ids we have seen not travelling, so a later trip start time is real
  function trackTravel() {
    const t = now();
    members.forEach(m => {
      if (m.state === 'Traveling' || m.state === 'Abroad') {
        const prev = travelSeen.get(m.id);
        if (!prev || prev.desc !== m.desc) travelSeen.set(m.id, { desc: m.desc, since: t, known: !!prev || seenHome.has(m.id) });
      } else { travelSeen.delete(m.id); seenHome.add(m.id); }
    });
  }

  // ---------- BSP vs your stats ----------
  function parseBig(txt) {
    const m = /^\s*([\d.,]+)\s*([kmbtq]?)\s*$/i.exec(String(txt || '')); if (!m) return 0;
    const mult = { '': 1, k: 1e3, m: 1e6, b: 1e9, t: 1e12, q: 1e15 }[m[2].toLowerCase()];
    return parseFloat(m[1].replace(/,/g, '')) * mult;
  }
  function bspClass(id) {
    const mine = parseBig(S.myStats), theirs = parseBig(bsp.get(String(id)));
    if (!mine || !theirs) return '';
    const r = theirs / mine;
    return r <= 0.8 ? 'g' : r <= 1.25 ? 'a' : 'r';
  }

  // ---------- Called targets ----------
  function isCalled(m, t) {
    const c = called.get(m.id);
    if (!c || !S.calledMin) return false;
    if (t - c.at > S.calledMin * 60) { called.delete(m.id); return false; }
    if (inHosp(m, t) && (m.pending ? c.until !== -1 : m.until > c.until + 5)) { called.delete(m.id); return false; } // hit since the call
    return true;
  }

  // ---------- Alerts ----------
  let audio = null;
  function beep(times = 1) {
    if (!S.sound) return;
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      for (let i = 0; i < times; i++) {
        const o = audio.createOscillator(), g = audio.createGain();
        o.frequency.value = 880; o.connect(g); g.connect(audio.destination);
        const st = audio.currentTime + i * 0.25;
        g.gain.setValueAtTime(0.15, st); g.gain.exponentialRampToValueAtTime(0.001, st + 0.18);
        o.start(st); o.stop(st + 0.2);
      }
    } catch (e) { /* sound blocked until you click the page once */ }
  }
  function notifyUser(title, text) {
    if (!S.notify) return;
    try { GM_notification({ title, text, timeout: 8000 }); } catch (e) { /* notifications not allowed */ }
  }
  const prevState = new Map();
  function checkAlerts() {
    const t = now();
    members.forEach(m => {
      const was = prevState.get(m.id); prevState.set(m.id, m.state);
      if (!watch.has(String(m.id)) || m.pending) return;
      let msg = '';
      if (m.state === 'Hospital') {
        const left = m.until - t;
        if (left <= S.alertSec && left > -5 && alerted.get(m.id) !== m.until) {
          alerted.set(m.id, m.until);
          msg = left > 0 ? `out in ${left}s` : 'is out';
        }
      } else if (m.state === 'Okay' && was === 'Hospital') {
        if (typeof alerted.get(m.id) !== 'number') msg = 'is out';   // released early (revive or meds), not already announced
        alerted.delete(m.id);
      }
      if (msg) {
        beep(2);
        notifyUser(`★ ${m.name} ${msg}`, 'Open War Board and click Attack.');
        toast(`★ ${m.name} ${msg}`);
      }
    });
    // chain
    if (chain && S.chainWarn && chain.current >= 10 && !chain.cooldown) {
      const left = chainLeft();
      if (left > 0 && left <= S.chainWarn && t - chainAlertedAt > S.chainWarn) {
        chainAlertedAt = t; beep(3); toast(`⛓ Chain ${chain.current}: ${fmtLeft(left)} left. Hit someone!`);
      }
    }
  }

  // ---------- Target list ----------
  function targets() {
    const t = now();
    const okay = S.includeOkay
      ? members.filter(m => m.state === 'Okay' || (m.state === 'Hospital' && !inHosp(m, t)))
      : [];
    let hosp = members.filter(m => inHosp(m, t));
    if (S.hideRed) hosp = hosp.filter(m => bspClass(m.id) !== 'r');
    if (S.windowMin > 0) hosp = hosp.filter(m => m.pending || m.until - t <= S.windowMin * 60);
    const key = m => m.pending ? Infinity : m.until;
    hosp.sort((a, b) => key(a) - key(b));
    okay.sort((a, b) => b.level - a.level);
    const ok2 = S.hideRed ? okay.filter(m => bspClass(m.id) !== 'r') : okay;
    return [...ok2, ...hosp];
  }

  let lastMessageIds = [];
  function buildMessage() {
    const t = now();
    const list = targets().filter(m => !isCalled(m, t)).slice(0, Math.max(1, S.count));
    lastMessageIds = list;
    if (!list.length) return '';
    const lines = list.map((m, i) => {
      const when = !inHosp(m, t) ? 'OUT NOW' : m.pending ? 'in hospital (time updating)' : `${fmtTct(m.until)} (in ${fmtLeft(m.until - t)})`;
      const b = bsp.get(String(m.id));
      const act = m.act === 'offline' ? ' · offline' : m.act === 'idle' ? ' · idle' : m.act === 'online' ? ' · online' : '';
      return { head: `${i + 1}. ${m.name}${b && S.bspChat ? ` [BSP ${b}]` : ''} · ${when}${act}`, link: attackUrl(m.id) };
    });
    if (S.multiLine) {
      // One target per block: name and release time on one line, attack link underneath.
      return ['🎯 Next out (TCT)', ...lines.map(l => `${l.head}\n${l.link}`)].join('\n');
    }
    return `🎯 Next out (TCT): ${lines.map(l => `${l.head} ${l.link}`).join('  ▸  ')}`;
  }


  // ---------- Chat ----------
  // Remember the chat box you last clicked into, so the message can be dropped into it.
  document.addEventListener('focusin', e => {
    const el = e.target;
    if (el && el.tagName === 'TEXTAREA' && el.closest('[class*="chat" i], [id*="chat" i]')) lastChatBox = el;
  }, true);

  function sendToChat() {
    const msg = buildMessage();
    if (!msg) {
      toast(targets().length ? `Every listed target was already called in the last ${S.calledMin} min.` : 'No targets match the current filter.');
      return;
    }
    GM_setClipboard(msg, 'text');
    const tc = now();
    lastMessageIds.forEach(m => called.set(m.id, { at: tc, until: m.pending ? -1 : m.until }));
    const box = lastChatBox && document.contains(lastChatBox) ? lastChatBox : null;
    if (box) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(box, msg);
      box.dispatchEvent(new Event('input', { bubbles: true }));
      box.focus();
      toast('Message placed in chat. Press Enter to send.');
    } else {
      toast('Copied. Click into faction chat and paste (Ctrl+V), then Enter.');
    }
  }



  // ---------- UI ----------
  const css = `
    #awb{position:fixed;right:12px;bottom:12px;width:330px;max-height:92vh;z-index:99999;background:#1e1e1e;color:#ddd;
      font:12px/1.35 Arial,sans-serif;border:1px solid #444;border-radius:6px;box-shadow:0 2px 10px rgba(0,0,0,.5);display:flex;flex-direction:column}
    #awb header{display:flex;align-items:center;gap:6px;padding:6px 8px;background:#2b2b2b;border-radius:6px 6px 0 0;cursor:move;user-select:none;touch-action:none}
    #awb header b{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    #awb button{background:#3a3a3a;color:#eee;border:1px solid #555;border-radius:4px;padding:2px 7px;cursor:pointer;font-size:12px}
    #awb button:hover{background:#4a4a4a}
    #awb .send{background:#8a2b2b;border-color:#a33}
    #awb .body{overflow:auto;padding:4px 8px;min-height:0;flex:0 1 auto}
    #awb .rowsize{display:flex;justify-content:center;gap:6px;padding:2px 0;border-top:1px solid #2a2a2a}
    #awb .rowsize button{font-size:10px!important;padding:0 8px!important;background:#2b2b2b!important;color:#999!important}
    #awb.collapsed .rowsize{display:none!important}
    #awb, #awb *{box-sizing:border-box;line-height:1.3}
    #awb .row{display:flex!important;flex-wrap:nowrap!important;align-items:center;gap:6px;padding:3px 4px 3px 6px;border-bottom:1px solid #2a2a2a;border-left:3px solid transparent;min-height:24px}
    #awb .row.out{border-left-color:#43a047;background:rgba(67,160,71,.08)}
    #awb .row.watched{background:rgba(255,213,79,.10)}
    #awb .row.out.watched{background:rgba(255,213,79,.14)}
    #awb .row > *, #awb .nm > *{display:inline-block!important;float:none!important;margin:0!important;vertical-align:middle;width:auto!important}
    #awb .row .t{flex:none}#awb .row a.atk{flex:none}
    #awb .row a{color:#9cf;text-decoration:none}
    #awb .row a.atk{background:#c62828;color:#fff;border-radius:3px;padding:1px 7px;font-weight:bold;font-size:11px}
    #awb .row a.atk:hover{background:#e53935}
    #awb .nm{flex:1 1 auto;min-width:0;display:flex!important;align-items:center;gap:4px;white-space:nowrap;overflow:hidden}
    #awb .nm a{overflow:hidden;text-overflow:ellipsis;min-width:0;flex:0 1 auto}
    #awb .nm .star,#awb .nm .dot,#awb .nm .bsp,#awb .nm .muted{flex:none}
    #awb .nm .muted{font-size:10px}
    #awb .dot{width:7px!important;height:7px!important;display:inline-block!important;flex:none}
    #awb button, #awb button *{display:inline-block!important;white-space:nowrap!important;float:none!important}
    #awb .foot{flex-wrap:nowrap!important}#awb .foot .status{display:inline!important;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
    #awb .t{font-family:monospace;font-weight:bold;min-width:62px;text-align:right}
    #awb .bsp:not(:empty){background:#b71c1c;color:#fff;border-radius:3px;padding:0 4px;font-size:10px;font-weight:bold}
    #awb .hosp{color:#ff6b6b}#awb .soon{color:#ffb84d}#awb .ok{color:#6bdc6b}
    #awb .foot{padding:5px 8px;border-top:1px solid #333;display:flex;gap:6px;align-items:center;flex-wrap:wrap}
    #awb .muted{color:#888}
    #awb .cfg{padding:6px 8px;border-top:1px solid #333;display:none}
    #awb .cfg label{display:flex;justify-content:space-between;align-items:center;margin:3px 0;gap:6px}
    #awb .cfg input[type=text],#awb .cfg input[type=password],#awb .cfg input[type=number]{width:140px;background:#111;color:#eee;border:1px solid #555;border-radius:3px;padding:2px 4px}
    #awb.collapsed .body,#awb.collapsed .foot,#awb.collapsed .cfg{display:none!important}
    #awb .chain{display:none;padding:4px 8px;border-bottom:1px solid #333;font-weight:bold}
    #awb .chain.warn{background:#7a1c1c;animation:awbflash 1s infinite}
    @keyframes awbflash{50%{background:#b71c1c}}
    #awb .trav{padding:2px 8px 4px;font-size:11px;border-top:1px solid #333}
    #awb .trav .th{cursor:pointer;user-select:none}#awb .trav .th:hover{color:#ccc}
    #awb .trav .tl{max-height:120px;overflow:auto}
    #awb .tl > div{display:flex!important;align-items:center;gap:4px;white-space:nowrap;overflow:hidden;padding:1px 0}
    #awb .tl > div > *{display:inline-block!important;flex:none;float:none!important;margin:0!important}
    #awb .tl > div > .muted{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}
    #awb .trav:empty{display:none}
    #awb .dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:3px;background:#555}
    #awb .dot.online{background:#43a047}#awb .dot.idle{background:#fbc02d}#awb .dot.offline{background:#757575}
    #awb .star{cursor:pointer;color:#666;user-select:none}#awb .star.on{color:#ffd54f}
    #awb .bsp.g{background:#2e7d32!important}#awb .bsp.a{background:#f9a825!important;color:#000!important}
    #awb .row.called{opacity:.55}#awb .row.called .nm::after{content:" 📢";font-size:10px}
    .awb-inl{font-family:monospace!important;font-weight:bold!important}
    .awb-inl.awb-h{color:#ff6b6b!important}.awb-inl.awb-s{color:#ffb84d!important}.awb-inl.awb-o{color:#6bdc6b!important}
    #awb-toast{position:fixed;right:12px;bottom:calc(70vh + 24px);z-index:100000;background:#333;color:#fff;padding:6px 10px;border-radius:4px;font:12px Arial;opacity:0;transition:opacity .2s}
  `;
  const style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);

  const box = document.createElement('div');
  box.id = 'awb';
  box.innerHTML = `
    <header><b>⚔️ War Board</b>
      <button data-a="sort" title="Sort the page's enemy list by hospital time (out first, then soonest out)">⇅</button>
      <button data-a="refresh" title="Refresh now">↻</button>
      <button data-a="cfg" title="Settings">⚙</button>
      <button data-a="min" title="Collapse">–</button></header>
    <div class="chain"></div>
    <div class="body"></div>
    <div class="trav"></div>
    <div class="rowsize"><button data-a="rows-" title="Show fewer targets">▲ fewer</button><button data-a="rows+" title="Show more targets">more ▼</button></div>
    <div class="foot">
      <button class="send" data-a="send">📢 Next <span class="n"></span> to chat</button>
      <span class="muted status"></span>
    </div>
    <div class="cfg">
      <label>Public API key <input type="password" data-k="key"></label>
      <label>Enemy faction ID (blank = auto) <input type="text" data-k="enemy" style="width:90px" placeholder="auto"></label>
      <label>Targets per message <input type="number" min="1" max="10" data-k="count"></label>
      <label>Only out within (min, 0 = all) <input type="number" min="0" max="600" data-k="windowMin"></label>
      <label>Show enemies already out <input type="checkbox" data-k="includeOkay"></label>
      <label>Open attacks in a new tab <input type="checkbox" data-k="newTab"></label>
      <label>Chat message on separate lines <input type="checkbox" data-k="multiLine"></label>
      <label>Countdowns in the page's status column <input type="checkbox" data-k="inline"></label>
      <label>Your total battle stats (e.g. 2.5b) <input type="text" data-k="myStats" style="width:90px" placeholder="for BSP colours"></label>
      <label>Hide targets much stronger than you <input type="checkbox" data-k="hideRed"></label>
      <label title="BSP is a paid service; check its terms before posting its figures where others can see them">Include BSP figures in chat message <input type="checkbox" data-k="bspChat"></label>
      <label>★ alert seconds before release <input type="number" min="0" max="300" data-k="alertSec"></label>
      <label>Alert sound <input type="checkbox" data-k="sound"></label>
      <label>★ browser notification <input type="checkbox" data-k="notify"></label>
      <label>Chain warning below (s, 0 = off) <input type="number" min="0" max="300" data-k="chainWarn"></label>
      <label>Skip already-called targets (min, 0 = off) <input type="number" min="0" max="30" data-k="calledMin"></label>
      <label>Targets visible before scrolling (0 = fit screen) <input type="number" min="0" max="60" data-k="rows"></label>
      <button data-a="save">Save</button>
    </div>`;
  document.body.appendChild(box);
  if (S.collapsed) box.classList.add('collapsed');

  // ---------- Dragging (grab the title bar; double-click it to reset) ----------
  const header = box.querySelector('header');
  header.style.cursor = 'move';
  header.title = 'Drag to move · double-click to reset position';
  function clampAndPlace(x, y) {
    const maxX = window.innerWidth - box.offsetWidth;
    const maxY = window.innerHeight - header.offsetHeight;
    x = Math.min(Math.max(0, x), Math.max(0, maxX));
    y = Math.min(Math.max(0, y), Math.max(0, maxY));
    box.style.left = x + 'px'; box.style.top = y + 'px';
    box.style.right = 'auto'; box.style.bottom = 'auto';
    return { x, y };
  }
  const savedPos = GM_getValue('awb_pos', null);
  if (savedPos) clampAndPlace(savedPos.x, savedPos.y);

  let drag = null;
  header.addEventListener('pointerdown', e => {
    if (e.button !== 0 || e.target.closest('button')) return;
    const r = box.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    header.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  header.addEventListener('pointermove', e => {
    if (drag) clampAndPlace(e.clientX - drag.dx, e.clientY - drag.dy);
  });
  header.addEventListener('pointerup', e => {
    if (!drag) return;
    drag = null;
    header.releasePointerCapture(e.pointerId);
    const r = box.getBoundingClientRect();
    GM_setValue('awb_pos', { x: Math.round(r.left), y: Math.round(r.top) });
  });
  header.addEventListener('dblclick', e => {
    if (e.target.closest('button')) return;
    GM_setValue('awb_pos', null);
    box.style.left = box.style.top = 'auto';
    box.style.right = '12px'; box.style.bottom = '12px';
  });
  window.addEventListener('resize', () => {
    if (box.style.left && box.style.left !== 'auto') {
      const r = box.getBoundingClientRect();
      clampAndPlace(r.left, r.top);
    }
  });

  const toastEl = document.createElement('div'); toastEl.id = 'awb-toast'; document.body.appendChild(toastEl);
  let toastT;
  function toast(t) {
    const r = box.getBoundingClientRect();
    toastEl.style.right = 'auto'; toastEl.style.bottom = 'auto';
    toastEl.style.left = Math.max(4, Math.min(r.left, window.innerWidth - 260)) + 'px';
    toastEl.style.top = (r.top > 40 ? r.top - 34 : r.bottom + 6) + 'px';
    toastEl.textContent = t; toastEl.style.opacity = 1; clearTimeout(toastT); toastT = setTimeout(() => toastEl.style.opacity = 0, 3500); }

  const cfg = box.querySelector('.cfg');
  function loadCfg() {
    cfg.querySelectorAll('[data-k]').forEach(i => {
      const k = i.dataset.k;
      if (i.type === 'checkbox') i.checked = !!S[k]; else i.value = S[k];
    });
  }

  box.addEventListener('click', e => {
    const star = e.target.closest('[data-star]');
    if (star) {
      const id = star.dataset.star;
      if (watch.has(id)) watch.delete(id); else watch.add(id);
      GM_setValue('awb_watch', [...watch]);
      beep(0); // unlocks sound after a click
      render(); return;
    }
    const a = e.target.closest('[data-a]'); if (!a) return;
    switch (a.dataset.a) {
      case 'refresh': refresh(); break;
      case 'rows-': case 'rows+': {
        const cur = S.rows || Math.floor(box.querySelector('.body').clientHeight / ROW_PX);
        S.rows = Math.max(3, Math.min(60, cur + (a.dataset.a === 'rows+' ? 3 : -3)));
        save(); applyRows(); toast(`Showing ${S.rows} targets`);
        break;
      }
      case 'trav': S.showTravel = !S.showTravel; save(); render(); break;
      case 'sort':
        S.pageSort = !S.pageSort; save(); sortPage();
        toast(S.pageSort ? 'Enemy list sorted by hospital time.' : 'Enemy list back to Torn\'s order.');
        break;
      case 'send': sendToChat(); break;
      case 'min': S.collapsed = !S.collapsed; box.classList.toggle('collapsed', S.collapsed); save(); break;
      case 'cfg': loadCfg(); cfg.style.display = cfg.style.display === 'block' ? 'none' : 'block'; break;
      case 'save':
        cfg.querySelectorAll('[data-k]').forEach(i => {
          const k = i.dataset.k;
          if (i.type === 'checkbox') S[k] = i.checked;
          else if (i.type === 'number') S[k] = Math.max(0, parseInt(i.value, 10) || 0);
          else S[k] = i.value.trim();
        });
        if (S.count < 1) S.count = 3;
        save(); applyRows(); cfg.style.display = 'none'; members = []; factionName = ''; enemyId = ''; warCheckedAt = 0; refresh();
        break;
    }
  });

  function renderChain(t) {
    const el = box.querySelector('.chain');
    if (!chain || !S.chainWarn || !chain.current || chain.cooldown) { el.style.display = 'none'; return; }
    const left = chainLeft();
    el.style.display = 'block';
    const warn = left > 0 && left <= S.chainWarn;
    el.classList.toggle('warn', warn);
    const best = targets().find(m => !inHosp(m, t));
    const txt = `⛓ Chain ${chain.current}/${chain.max} · ${fmtLeft(left)}`;
    const sig = txt.split(' · ')[0] + '|' + warn + '|' + (warn && best ? best.id : '');
    if (el.dataset.sig !== sig) {
      el.dataset.sig = sig;
      el.innerHTML = `<span class="ct"></span>${warn && best ? ` · next: <a class="atk" href="${attackUrl(best.id)}"${S.newTab ? ' target="_blank"' : ''}>${esc(best.name)}</a>` : ''}`;
    }
    const ct = el.querySelector('.ct'); if (ct.textContent !== txt) ct.textContent = txt;
  }

  function renderTravel(t) {
    const el = box.querySelector('.trav');
    const list = members.filter(m => travelSeen.has(m.id));
    const head = `<div class="muted th" data-a="trav">✈ Travelling / abroad (${list.length}) ${S.showTravel ? '▾' : '▸'}</div>`;
    const html = !list.length ? '' : !S.showTravel ? head : head + '<div class="tl">' + list.map(m => {
      const tr = travelSeen.get(m.id);
      const since = tr.known ? ` · seen ${fmtTct(tr.since).substr(0, 5)} TCT` : '';
      return `<div><span class="dot ${m.act || ''}"></span><a href="${profileUrl(m.id)}" target="_blank" style="color:#9cf">${esc(m.name)}</a> <span class="muted">${esc(m.desc)}${since}</span></div>`;
    }).join('') + '</div>';
    if (el.dataset.html !== html) { el.dataset.html = html; el.innerHTML = html; }
  }

  let lastSig = '';
  const ROW_PX = 25; // height of one target row
  function applyRows() {
    const b = box.querySelector('.body');
    b.style.maxHeight = S.rows > 0 ? `${S.rows * ROW_PX + 8}px` : '';
  }

  function render() {
    const t = now();
    box.querySelector('header b').textContent = factionName ? `⚔️ ${factionName}${enemySource === 'manual' ? ' (manual)' : ''}` : '⚔️ War Board';
    box.querySelector('.n').textContent = S.count;
    const body = box.querySelector('.body');
    if (lastError) { lastSig = ''; body.innerHTML = `<div class="muted" style="padding:6px 0">${esc(lastError)}</div>`; }
    else {
      const list = targets();
      // Rebuild the rows only when the list itself changes (order, members, out/in). Every other
      // second just the timer text is updated, so links under the mouse are never replaced mid-click.
      const sig = list.map(m => `${m.id}:${inHosp(m, t) ? 'h' : 'o'}`).join(',') + `|${S.newTab}`;
      if (sig !== lastSig || !body.querySelector('.row')) {
        lastSig = sig;
        const tgt = S.newTab ? ' target="_blank"' : '';
        body.innerHTML = list.length ? list.map(m => `<div class="row" data-id="${m.id}">
          <span class="nm"><span class="star" data-star="${m.id}" title="Watch: alert before release">☆</span> <span class="dot"></span><a href="${profileUrl(m.id)}" target="_blank">${esc(m.name)}</a> <span class="bsp"></span> <span class="muted">L${m.level}</span></span>
          <span class="t"></span>
          <a class="atk" href="${attackUrl(m.id)}"${tgt} title="Attack ${esc(m.name)}">Attack</a></div>`).join('')
          : '<div class="muted" style="padding:6px 0">No targets match the filter.</div>';
      }
      const byId = new Map(list.map(m => [String(m.id), m]));
      body.querySelectorAll('.row').forEach(row => {
        const m = byId.get(row.dataset.id); if (!m) return;
        const left = m.until - t;
        const h = inHosp(m, t);
        const b = row.querySelector('.bsp'), bv = bsp.get(String(m.id)) || '';
        if (b.textContent !== bv) { b.textContent = bv; b.title = bv ? 'BSP estimate' : ''; }
        b.className = 'bsp ' + bspClass(m.id);
        const st = row.querySelector('.star'), on = watch.has(String(m.id));
        if (st.classList.contains('on') !== on) { st.classList.toggle('on', on); st.textContent = on ? '★' : '☆'; }
        const dot = row.querySelector('.dot');
        dot.className = 'dot ' + (m.act || ''); dot.title = m.actRel ? `${m.act} · ${m.actRel}` : '';
        row.classList.toggle('called', isCalled(m, t));
        row.classList.toggle('out', !h);
        row.classList.toggle('watched', on);
        const el = row.querySelector('.t');
        const text = !h ? 'OUT' : m.pending ? 'Hosp…' : fmtLeft(left);
        if (el.textContent !== text) el.textContent = text;
        el.className = 't ' + (!h ? 'ok' : m.pending ? 'hosp' : left <= 120 ? 'soon' : 'hosp');
        el.title = m.desc || '';
      });
    }
    renderChain(t);
    renderTravel(t);
    const hospCount = members.filter(m => inHosp(m, t)).length;
    // A timer just ran out: refresh soon so a re-hospitalised player isn't left showing OUT.
    if (members.some(m => m.state === 'Hospital' && !m.pending && m.until <= t && m.until > t - 2)) requestRefresh();
    box.querySelector('.status').textContent = lastFetch
      ? `${hospCount} in hosp · updated ${Math.max(0, t - lastFetch)}s ago`
      : '';
  }

  // ---------- Loop ----------
  refresh();
  setInterval(() => { if (!document.hidden && !S.collapsed) refresh(); }, POLL_MS);
  // ---------- Countdowns in Torn's own member list ----------
  // For every player link on the page that belongs to the enemy faction, find the status
  // cell in the same row (the element whose text is "Hospital", or one we already changed)
  // and write the countdown into it. Torn may redraw the list at any time; the loop and the
  // observer below simply write it again.
  const STATUS_RE = /^\s*(okay|hospital|traveling|travelling|abroad|jail|federal|fallen)\b/i;
  function findStatusCell(row) {
    const marked = row.querySelector('[data-awb-cell]');
    if (marked) return marked;
    const leaves = row.querySelectorAll('[class*="status" i], [class*="status" i] *');
    for (const el of leaves) {
      if (el.childElementCount === 0 && STATUS_RE.test(el.textContent)) return el;
    }
    return null;
  }


  // The largest element around a name link that still belongs to that one player
  // (stops before an ancestor holding a different player's link).
  function playerRow(a) {
    let row = a, up = a.parentElement;
    for (let i = 0; up && i < 10 && up !== document.body; i++, up = up.parentElement) {
      const ids = new Set([...up.querySelectorAll('a[href*="profiles.php?XID="]')].map(x => (/XID=(\d+)/.exec(x.href) || [])[1]));
      if (ids.size > 1) break;
      row = up;
    }
    return row;
  }

  // ---------- BSP (Battle Stats Predictor) ----------
  // Read-only: picks up the BSP figure your BSP script has already drawn next to each player on
  // the page, with BSP's own browser cache as a fallback. Nothing is requested from BSP's servers.
  const bsp = new Map();          // player id -> text such as "2q"
  const BSP_RE = /^\s*[\d.,]+\s*[kmbtq]?\s*$/i;
  function fmtBig(n) {
    n = Number(n); if (!isFinite(n) || n <= 0) return '';
    const u = [['q', 1e15], ['t', 1e12], ['b', 1e9], ['m', 1e6], ['k', 1e3]];
    for (const [s, v] of u) if (n >= v) { const x = n / v; return (x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2)).replace(/\.?0+$/, '') + s; }
    return String(Math.round(n));
  }
  function scanBspPage() {
    document.querySelectorAll('a[href*="profiles.php?XID="]').forEach(a => {
      if (a.closest('#awb, [class*="chat" i], [id*="chat" i]')) return;
      const id = (/XID=(\d+)/.exec(a.href) || [])[1]; if (!id) return;
      const row = playerRow(a);
      for (const el of row.querySelectorAll('.iconStats, [class*="iconStats"], [class*="bsp" i]')) {
        const txt = el.textContent.trim();
        if (txt && BSP_RE.test(txt)) { bsp.set(id, txt.replace(/\s+/g, '')); break; }
      }
    });
  }
  function scanBspStorage() {
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!/battlestatspredictor/i.test(k)) continue;   // BSP's own cache entries only
        const id = (/(\d{3,})\D*$/.exec(k) || [])[1];
        if (!id || bsp.has(id)) continue;
        let v; try { v = JSON.parse(localStorage.getItem(k)); } catch (e) { continue; }
        const n = v && (v.TBS ?? v.TBS_Raw ?? v.Result ?? v.tbs ?? v.Score);
        const f = fmtBig(n); if (f) bsp.set(id, f);
      }
    } catch (e) { /* storage not readable; page scan still works */ }
  }

  // ---------- Sort the page's enemy list by hospital time ----------
  // Uses CSS "order" on the existing rows, so Torn's own elements are never moved or removed.
  const sortedParents = new Set();
  function sortPage() {
    const btn = box.querySelector('[data-a=sort]');
    if (btn) btn.style.background = S.pageSort ? '#2e7d32' : '';
    if (!S.pageSort || !members.length) {
      sortedParents.forEach(p => { p.style.display = ''; p.style.flexDirection = ''; [...p.children].forEach(c => c.style.order = ''); });
      sortedParents.clear();
      return;
    }
    const t = now();
    const byId = new Map(members.map(m => [m.id, m]));
    const rank = m => {
      if (m.state === 'Okay' || (m.state === 'Hospital' && !inHosp(m, t))) return 0;   // out now
      if (m.pending) return 999998;                                                        // in hospital, time updating
      if (m.state === 'Hospital') return Math.min(999997, m.until - t);                  // soonest out next
      return 1000000;                                                                    // travelling, jail etc. last
    };
    const done = new Set();
    document.querySelectorAll('a[href*="profiles.php?XID="]').forEach(a => {
      if (a.closest('#awb, [class*="chat" i], [id*="chat" i]')) return;
      const m = byId.get(+((/XID=(\d+)/.exec(a.href) || [])[1])); if (!m) return;
      const row = playerRow(a); const parent = row.parentElement;
      if (!parent || done.has(row)) return;
      done.add(row);
      if (!sortedParents.has(parent)) {
        parent.style.display = 'flex'; parent.style.flexDirection = 'column';
        sortedParents.add(parent);
      }
      const o = String(rank(m));
      if (row.style.order !== o) row.style.order = o;
    });
  }

  function paintInline() {
    if (!members.length) return;
    const t = now();
    const byId = new Map(members.map(m => [m.id, m]));
    const seen = new Set();
    document.querySelectorAll('a[href*="profiles.php?XID="]').forEach(a => {
      if (a.closest('#awb, [class*="chat" i], [id*="chat" i]')) return;
      const mId = /XID=(\d+)/.exec(a.href); if (!mId) return;
      const m = byId.get(+mId[1]); if (!m) return;
      const row = playerRow(a);
      const cell = findStatusCell(row);
      if (!cell || seen.has(cell)) return;
      seen.add(cell);

      // Torn updates this cell live. If it now says something we didn't write, it is newer than our data.
      const ours = cell.dataset.awbLast !== undefined && cell.textContent === cell.dataset.awbLast;
      if (!ours) {
        const page = cell.textContent.trim().toLowerCase();
        if (page.startsWith('hospital') && !inHosp(m, t)) {
          m.state = 'Hospital'; m.pending = true; pageHosp.set(m.id, t); requestRefresh();
        } else if (page.startsWith('okay') && inHosp(m, t)) {
          m.state = 'Okay'; m.pending = false; pageHosp.delete(m.id); requestRefresh();
        }
      }
      if (!S.inline) return;

      let text, cls;
      if (inHosp(m, t)) {
        const left = m.until - t;
        text = m.pending ? 'Hosp…' : fmtLeft(left);
        cls = m.pending ? 'awb-h' : left <= 120 ? 'awb-s' : 'awb-h';
      } else if (m.state === 'Hospital') {
        text = 'Out'; cls = 'awb-o';         // timer ran out; confirmed on next refresh
      } else if (cell.dataset.awbCell) {
        text = m.state; cls = 'awb-o';       // left hospital since we marked it
      } else return;
      if (cell.textContent !== text) cell.textContent = text;
      cell.dataset.awbLast = text;
      cell.dataset.awbCell = '1';
      cell.classList.add('awb-inl');
      cell.classList.remove('awb-h', 'awb-s', 'awb-o');
      cell.classList.add(cls);
      cell.title = m.desc || '';
    });
  }

  let paintQueued = false;
  new MutationObserver(() => {
    if (paintQueued) return;
    paintQueued = true;
    requestAnimationFrame(() => { paintQueued = false; paintInline(); });
  }).observe(document.body, { childList: true, subtree: true });

  applyRows();
  setInterval(() => { scanBspPage(); render(); paintInline(); sortPage(); checkAlerts(); }, 1000);
  scanBspStorage(); setInterval(scanBspStorage, POLL_MS);
})();
