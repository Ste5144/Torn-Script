// ==UserScript==
// @name         Archer War Board
// @namespace    sterlingarcher.torn
// @version      1.6
// @description  Enemy hospital countdowns sorted by soonest out, optional time filter, and a one-click "next N to chat" message with attack links. Display only: reads the Torn API with a Public key and never acts for you.
// @match        https://www.torn.com/factions.php*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_setClipboard
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
  const POLL_MS = 30000;            // API refresh: every 30 s (2 calls/min, well under the 100/min key limit)
  if (GM_getValue('awb_ver', 0) < 13) { GM_setValue('awb_enemy', ''); GM_setValue('awb_ver', 13); }
  const S = {
    key:         GM_getValue('awb_key', ''),
    enemy:       GM_getValue('awb_enemy', ''),     // manual override; blank = your current ranked war opponent (from the API)
    count:       GM_getValue('awb_count', 3),      // how many targets go in the chat message
    windowMin:   GM_getValue('awb_window', 0),     // only show hospital targets out within N minutes (0 = show all)
    includeOkay: GM_getValue('awb_okay', true),    // list enemies already out (Okay) at the top
    newTab:      GM_getValue('awb_newtab', false), // open attack links in a new tab
    multiLine:   GM_getValue('awb_multiline', true), // chat message: one target per line
    pageSort:    GM_getValue('awb_pagesort', false), // re-order the page's enemy list by hospital time
    collapsed:   GM_getValue('awb_collapsed', false),
    inline:      GM_getValue('awb_inline', true),     // put countdowns in Torn's own Hospital status cells
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
  };

  // ---------- State ----------
  let members = [];        // {id, name, level, state, until, desc}
  let factionName = '';
  let offset = 0;          // Torn server clock minus local clock (seconds)
  let lastFetch = 0;
  let lastError = '';
  let lastChatBox = null;  // the chat textarea you last clicked into

  const now = () => Math.floor(Date.now() / 1000) + offset;
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const attackUrl = id => `https://www.torn.com/loader.php?sid=attack&user2ID=${id}`;
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

  async function refresh() {
    if (!S.key) { lastError = 'Enter your Public API key in ⚙.'; render(); return; }
    try {
      const id = await resolveEnemy();
      if (!id) { enemyId = ''; members = []; factionName = ''; lastError = 'No active ranked war found. Enter the enemy faction ID in ⚙.'; render(); return; }
      if (id !== enemyId) { enemyId = id; members = []; factionName = ''; }
      let j;
      try { j = await api(`https://api.torn.com/faction/${id}?selections=basic&key=${S.key}&comment=ArcherWarBoard`); }
      catch (e1) { j = await api(`https://api.torn.com/v2/faction/${id}/members?key=${S.key}&comment=ArcherWarBoard`); }
      members = parseMembers(j);
      if (j.name) factionName = j.name;
      lastFetch = now();
      lastError = members.length ? '' : 'No members returned. Check the faction ID.';
    } catch (e) {
      lastError = e.message;
    }
    render();
  }


  // ---------- Target list ----------
  function targets() {
    const t = now();
    const okay = S.includeOkay
      ? members.filter(m => m.state === 'Okay' || (m.state === 'Hospital' && m.until <= t))
      : [];
    let hosp = members.filter(m => m.state === 'Hospital' && m.until > t);
    if (S.windowMin > 0) hosp = hosp.filter(m => m.until - t <= S.windowMin * 60);
    hosp.sort((a, b) => a.until - b.until);
    okay.sort((a, b) => b.level - a.level);
    return [...okay, ...hosp];
  }

  function buildMessage() {
    const t = now();
    const list = targets().slice(0, Math.max(1, S.count));
    if (!list.length) return '';
    const lines = list.map((m, i) => {
      const inHosp = m.state === 'Hospital' && m.until > t;
      const when = inHosp ? `${fmtTct(m.until)} (in ${fmtLeft(m.until - t)})` : 'OUT NOW';
      const b = bsp.get(String(m.id));
      return { head: `${i + 1}. ${m.name}${b ? ` [BSP ${b}]` : ''} · ${when}`, link: attackUrl(m.id) };
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
    if (!msg) { toast('No targets match the current filter.'); return; }
    GM_setClipboard(msg, 'text');
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
    #awb{position:fixed;right:12px;bottom:12px;width:330px;max-height:70vh;z-index:99999;background:#1e1e1e;color:#ddd;
      font:12px/1.35 Arial,sans-serif;border:1px solid #444;border-radius:6px;box-shadow:0 2px 10px rgba(0,0,0,.5);display:flex;flex-direction:column}
    #awb header{display:flex;align-items:center;gap:6px;padding:6px 8px;background:#2b2b2b;border-radius:6px 6px 0 0;cursor:move;user-select:none;touch-action:none}
    #awb header b{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    #awb button{background:#3a3a3a;color:#eee;border:1px solid #555;border-radius:4px;padding:2px 7px;cursor:pointer;font-size:12px}
    #awb button:hover{background:#4a4a4a}
    #awb .send{background:#8a2b2b;border-color:#a33}
    #awb .body{overflow:auto;padding:4px 8px}
    #awb .row{display:flex;align-items:center;gap:6px;padding:3px 0;border-bottom:1px solid #2e2e2e}
    #awb .row a{color:#9cf;text-decoration:none}
    #awb .row a.atk{background:#c62828;color:#fff;border-radius:3px;padding:1px 7px;font-weight:bold;font-size:11px}
    #awb .row a.atk:hover{background:#e53935}
    #awb .nm{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    #awb .t{font-family:monospace;font-weight:bold;min-width:62px;text-align:right}
    #awb .bsp:not(:empty){background:#b71c1c;color:#fff;border-radius:3px;padding:0 4px;font-size:10px;font-weight:bold}
    #awb .hosp{color:#ff6b6b}#awb .soon{color:#ffb84d}#awb .ok{color:#6bdc6b}
    #awb .foot{padding:5px 8px;border-top:1px solid #333;display:flex;gap:6px;align-items:center;flex-wrap:wrap}
    #awb .muted{color:#888}
    #awb .cfg{padding:6px 8px;border-top:1px solid #333;display:none}
    #awb .cfg label{display:flex;justify-content:space-between;align-items:center;margin:3px 0;gap:6px}
    #awb .cfg input[type=text],#awb .cfg input[type=password],#awb .cfg input[type=number]{width:140px;background:#111;color:#eee;border:1px solid #555;border-radius:3px;padding:2px 4px}
    #awb.collapsed .body,#awb.collapsed .foot,#awb.collapsed .cfg{display:none!important}
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
    <div class="body"></div>
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
    const a = e.target.closest('[data-a]'); if (!a) return;
    switch (a.dataset.a) {
      case 'refresh': refresh(); break;
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
        save(); cfg.style.display = 'none'; members = []; factionName = ''; enemyId = ''; warCheckedAt = 0; refresh();
        break;
    }
  });

  let lastSig = '';
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
      const sig = list.map(m => `${m.id}:${m.state === 'Hospital' && m.until > t ? 'h' : 'o'}`).join(',') + `|${S.newTab}`;
      if (sig !== lastSig || !body.querySelector('.row')) {
        lastSig = sig;
        const tgt = S.newTab ? ' target="_blank"' : '';
        body.innerHTML = list.length ? list.map(m => `<div class="row" data-id="${m.id}">
          <span class="nm"><a href="${profileUrl(m.id)}" target="_blank">${esc(m.name)}</a> <span class="bsp"></span> <span class="muted">L${m.level}</span></span>
          <span class="t"></span>
          <a class="atk" href="${attackUrl(m.id)}"${tgt} title="Attack ${esc(m.name)}">Attack</a></div>`).join('')
          : '<div class="muted" style="padding:6px 0">No targets match the filter.</div>';
      }
      const byId = new Map(list.map(m => [String(m.id), m]));
      body.querySelectorAll('.row').forEach(row => {
        const m = byId.get(row.dataset.id); if (!m) return;
        const left = m.until - t;
        const inHosp = m.state === 'Hospital' && left > 0;
        const b = row.querySelector('.bsp'), bv = bsp.get(String(m.id)) || '';
        if (b.textContent !== bv) { b.textContent = bv; b.title = bv ? 'BSP estimate' : ''; }
        const el = row.querySelector('.t');
        const text = inHosp ? fmtLeft(left) : 'OUT';
        if (el.textContent !== text) el.textContent = text;
        el.className = 't ' + (inHosp ? (left <= 120 ? 'soon' : 'hosp') : 'ok');
        el.title = m.desc || '';
      });
    }
    const hospCount = members.filter(m => m.state === 'Hospital' && m.until > t).length;
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
  function findStatusCell(row) {
    const marked = row.querySelector('[data-awb-cell]');
    if (marked) return marked;
    const leaves = row.querySelectorAll('[class*="status" i], [class*="status" i] *');
    for (const el of leaves) {
      if (el.childElementCount === 0 && /^\s*hospital\s*$/i.test(el.textContent)) return el;
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
        if (!/battlestatspredictor|bsp/i.test(k)) continue;
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
      if (m.state === 'Okay' || (m.state === 'Hospital' && m.until <= t)) return 0;      // out now
      if (m.state === 'Hospital') return Math.min(999999, m.until - t);                  // soonest out next
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
    if (!S.inline || !members.length) return;
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
      let text, cls;
      if (m.state === 'Hospital') {
        const left = m.until - t;
        text = left > 0 ? fmtLeft(left) : 'Out';
        cls = left <= 0 ? 'awb-o' : left <= 120 ? 'awb-s' : 'awb-h';
      } else if (cell.dataset.awbCell) {
        text = m.state; cls = 'awb-o';       // left hospital since we marked it
      } else return;
      if (cell.textContent !== text) cell.textContent = text;
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

  setInterval(() => { scanBspPage(); render(); paintInline(); sortPage(); }, 1000);
  scanBspStorage(); setInterval(scanBspStorage, POLL_MS);
})();
