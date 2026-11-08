// ==UserScript==
// @name         Torn High-Low Helper (display only)
// @namespace    sterlingarcher.torn
// @version      6.3.0
// @description  Tracks dealer and player cards through the deck, shows Higher/Lower odds from the cards left, advises Collect vs Continue, and logs outcomes to CSV. Display only: no clicks, no extra server requests.
// @match        https://www.torn.com/*highlow*
// @grant        none
// @run-at       document-idle
// @homepageURL  https://github.com/Ste5144/Torn-Script
// @updateURL    https://raw.githubusercontent.com/Ste5144/Torn-Script/main/torn-highlow-helper.user.js
// @downloadURL  https://raw.githubusercontent.com/Ste5144/Torn-Script/main/torn-highlow-helper.user.js
// ==/UserScript==

/*
  RULES COMPLIANCE
  - Reads only what is already on the page. Makes no requests to Torn.
  - Never clicks Higher, Lower, Start or Cash Out. You make every move yourself.

  HOW A ROUND IS TRACKED
  - Each round has two cards: the DEALER card (you guess against it) and YOUR card.
  - Both come out of the same deck, so both are removed from the counts.
  - After a win, the next dealer card is a NEW card from what is left, so the
    Collect/Continue advice averages over every card still in the deck.
  - Manual entry: click ranks in order (dealer, yours, dealer, yours...).
    The panel shows which card it expects next.
  - Press "New game" when Torn starts a new game (new shuffled deck).

  GAME MODEL (wiki.torn.com/wiki/High-Low)
  - A correct guess multiplies the pot by (1 + chance mod). A wrong guess loses it.
  - After a hand you can collect 100%; after the next dealer card is shown, only 50%.

  ASSUMPTIONS STILL TO CONFIRM
  - One 52-card deck per game; reshuffle detected automatically if a 5th card of a rank appears.
  - A draw is a push: the game continues and the pot is unchanged (Torn, confirmed 8 Nov 2026).
*/

(function () {
  'use strict';

  const RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
  const LABEL = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
  const label = r => LABEL[r] || String(r);
  const KEY = 'thl-settings-v4';

  const state = {
    hist: [],          // [{r, role:'dealer'|'yours'}] this deck, in order
    manual: false,     // auto-detect reads Torn's dealer-card / you-card boxes
    slots: null,       // cards last seen in each box
    lastCounted: { dealer: '', yours: '' },
    guess: null,       // the button you last pressed (HIGHER / LOWER)
    track: true,
    lastSig: '',
    mod: 25,
    limit: 0,
    ties: 'push',      // Torn: a draw does not end the game (confirmed 8 Nov 2026)
    log: [],
    // Outcome log (kept in this browser, exported as CSV)
    rounds: [],
    games: [],
    gameId: Date.now(),
    bet: ''
  };
  const LOGKEY = 'thl-outcomes-v5';
  try {
    const l = JSON.parse(localStorage.getItem(LOGKEY) || '{}');
    if (Array.isArray(l.rounds)) state.rounds = l.rounds;
    if (Array.isArray(l.games)) state.games = l.games;
    if (l.bet) state.bet = l.bet;
  } catch (e) { /* ignore */ }
  // One-off repair: games from earlier versions that have rounds but no game record.
  function backfillGames() {
    const logged = new Set(state.games.map(g => g.game));
    const byGame = {};
    state.rounds.forEach(r => { (byGame[r.game] = byGame[r.game] || []).push(r); });
    let added = 0;
    Object.keys(byGame).forEach(id => {
      const g = Number(id);
      if (logged.has(g)) return;
      const rs = byGame[id];
      const last = rs[rs.length - 1];
      const lost = last.result === 'lose';
      state.games.push({
        time: last.time, game: g, mod: last.mod, rounds: rs.length,
        wins: rs.filter(x => x.result === 'win').length,
        result: lost ? 'lost' : 'not recorded', bet: '', payout: lost ? 0 : '', profit: ''
      });
      added++;
    });
    if (added) {
      state.games.sort((a, b) => a.game - b.game);
      saveLog();
    }
    return added;
  }

  function saveLog() {
    try {
      if (state.rounds.length > 5000) state.rounds = state.rounds.slice(-5000);
      localStorage.setItem(LOGKEY, JSON.stringify({ rounds: state.rounds, games: state.games, bet: state.bet }));
    } catch (e) { flash('Could not save log in this browser.'); }
  }

  try {
    const s = JSON.parse(localStorage.getItem(KEY) || '{}');
    if (typeof s.track === 'boolean') state.track = s.track;
    if (typeof s.mod === 'number') state.mod = s.mod;
    if (typeof s.limit === 'number') state.limit = s.limit;
  } catch (e) { /* storage blocked: defaults */ }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify({ track: state.track, mod: state.mod, limit: state.limit, ties: state.ties })); } catch (e) { /* ignore */ }
  }

  // Game in progress: kept so a page reload (or a script update) doesn't wipe the deck.
  // Restored only if saved in the last 30 minutes.
  const GAMEKEY = 'thl-game-v6';
  try {
    const gsv = JSON.parse(localStorage.getItem(GAMEKEY) || '{}');
    if (Array.isArray(gsv.hist) && gsv.savedAt && Date.now() - gsv.savedAt < 30 * 60 * 1000) {
      state.hist = gsv.hist;
      if (gsv.gameId) state.gameId = gsv.gameId;
      if (gsv.slots) state.slots = gsv.slots;
      if (gsv.lastCounted) state.lastCounted = gsv.lastCounted;
      state.restored = gsv.hist.length;
    }
  } catch (e) { /* ignore */ }
  let lastGameSave = '';
  function saveGame() {
    const s = JSON.stringify({ hist: state.hist, gameId: state.gameId, slots: state.slots, lastCounted: state.lastCounted });
    if (s === lastGameSave) return;
    lastGameSave = s;
    try { localStorage.setItem(GAMEKEY, s.slice(0, -1) + ',"savedAt":' + Date.now() + '}'); } catch (e) { /* ignore */ }
  }

  // Reads Torn's "Current modifier: 25%" so the chance mod stays current.
  function readMod() {
    const m = (document.body.textContent || '').match(/Current modifier:\s*(\d{1,3})\s*%/i);
    if (!m) return;
    const v = Number(m[1]);
    if (v >= 0 && v <= 100 && v !== state.mod) {
      state.mod = v; save();
      const f = document.getElementById('thl-mod');
      if (f) f.value = v;
      logLine('chance mod read from page: ' + v + '%');
    }
  }

  // ---------- Derived state ----------
  const nextRole = () => {
    const last = state.hist[state.hist.length - 1];
    return !last || last.role === 'yours' ? 'dealer' : 'yours';
  };
  const lastOf = role => { for (let i = state.hist.length - 1; i >= 0; i--) if (state.hist[i].role === role) return state.hist[i].r; return null; };

  // Cards left in the deck. `upTo` limits how much history counts (to see the deck as it was).
  function remaining(upTo) {
    const left = {};
    RANKS.forEach(r => { left[r] = 4; });
    const h = upTo == null ? state.hist : state.hist.slice(0, upTo);
    if (state.track) h.forEach(c => { left[c.r] = Math.max(0, left[c.r] - 1); });
    else if (h.length) left[h[h.length - 1].r] -= 1; // fresh deck: only the card just drawn is out
    return left;
  }

  function addCard(r, role) {
    role = role || nextRole();
    if (state.track && remaining()[r] <= 0) {
      state.hist = [];
      role = 'dealer';
      flash('Reshuffle detected: deck reset.');
      logLine('reshuffle on 5th ' + label(r));
    }
    const result = role === 'yours' ? recordRound(r) : null;
    if (role === 'dealer') state.streakAtDeal = state.streak == null ? null : state.streak;
    state.hist.push({ r, role });
    logLine((role === 'dealer' ? 'dealer ' : 'yours  ') + label(r));
    state.undoGame = null;
    // A lost round ends the game: log it automatically.
    // Only a wrong guess ends the game; a draw carries on with the same deck.
    if (result === 'lose') {
      state.undoGame = { hist: state.hist.slice(), gameId: state.gameId };
      endGame('lost');
      flash('Lost round: game logged automatically.');
    }
  }

  // Logs a round when your card is entered. Assumes you guessed the advised pick.
  function recordRound(yours) {
    const d = state.hist[state.hist.length - 1];
    if (!d || d.role !== 'dealer') return;
    const o = oddsFrom(d.r, remaining());
    if (!o) return;
    // Your actual guess if the button press was seen; otherwise assume the advised pick.
    const guess = state.guess || o.pick;
    const guessSeen = !!state.guess;
    state.guess = null;
    let result = yours === d.r ? 'tie'
      : (guess === 'HIGHER' ? yours > d.r : yours < d.r) ? 'win' : 'lose';
    // If Torn's "wins in a row" has already moved, trust it over the button guess.
    const before = state.streakAtDeal, now = state.streak;
    let source = guessSeen ? 'button' : 'assumed';
    if (before != null && now != null && now > before) { result = 'win'; source = 'Torn streak'; }
    else if (before != null && before > 0 && (now == null || now < before)) { result = 'lose'; source = 'Torn streak'; }
    const after = remaining(); after[yours] = Math.max(0, after[yours] - (state.track ? 1 : 0));
    const cv = result === 'win' ? continueValue(after) : null;
    const inGame = state.rounds.filter(x => x.game === state.gameId).length;
    state.rounds.push({
      time: new Date().toISOString(), game: state.gameId, round: inGame + 1,
      mod: state.mod, dealer: label(d.r), yours: label(yours), cardsLeft: o.n,
      pHigher: +(o.hi * 100).toFixed(1), pLower: +(o.lo * 100).toFixed(1), pTie: +(o.tie * 100).toFixed(1),
      pick: o.pick, winPct: +(o.win * 100).toFixed(1),
      guess: guessSeen ? guess : guess + ' (assumed)', followedAdvice: guess === o.pick ? 'yes' : 'no', result,
      resultFrom: source, ts: Date.now(),
      continueValue: cv == null ? '' : +cv.toFixed(3),
      advice: cv == null ? '' : (cv < 1 ? 'COLLECT' : 'CONTINUE')
    });
    saveLog();
    return result;
  }

  // how: 'collected' | 'half' | 'lost' | 'unrecorded'
  function endGame(how) {
    const rs = state.rounds.filter(x => x.game === state.gameId);
    const already = state.games.some(x => x.game === state.gameId);
    if (!rs.length && how !== 'unrecorded') { flash('No rounds in this game yet.'); render(); return; }
    if (already || (how === 'unrecorded' && !rs.length)) {
      state.hist = []; state.lastSig = ''; state.gameId = Date.now();
      render(); return;
    }
    if (how !== 'lost') state.undoGame = null;
    const wins = rs.filter(x => x.result === 'win').length;
    const bet = money(state.bet);
    const payoutIn = money(document.getElementById('thl-pay').value);
    let payout = '';
    if (how === 'lost') payout = 0;
    else if (how === 'unrecorded') payout = '';
    else if (payoutIn != null) payout = payoutIn;
    else if (bet != null) payout = Math.round(bet * Math.pow(mult(), wins) * (how === 'half' ? 0.5 : 1));
    state.games.push({
      time: new Date().toISOString(), game: state.gameId, mod: state.mod,
      rounds: rs.length, wins,
      result: { lost: 'lost', half: 'took 50%', collected: 'collected', unrecorded: 'not recorded' }[how],
      bet: bet == null ? '' : bet, payout,
      profit: bet == null || payout === '' ? '' : payout - bet
    });
    document.getElementById('thl-pay').value = '';
    saveLog();
    state.hist = []; state.lastSig = ''; state.gameId = Date.now();
    flash('Game logged.');
    render();
  }

  function money(v) {
    if (v == null || v === '') return null;
    const s = String(v).trim().toLowerCase().replace(/[$,\s]/g, '');
    const m = s.match(/^([0-9.]+)([kmb]?)$/);
    if (!m) return null;
    const n = parseFloat(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[m[2]] || 1);
    return isFinite(n) ? n : null;
  }

  function toCSV(rows) {
    if (!rows.length) return '';
    const cols = [];
    rows.forEach(r => Object.keys(r).forEach(k => { if (!cols.includes(k)) cols.push(k); }));
    const esc = v => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    return [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n');
  }
  function download(name, text) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // ---------- Card detection (best effort) ----------
  function parseRank(text) {
    if (!text) return null;
    const t = String(text).toUpperCase();
    if (t === 'A' || t === 'ACE' || t === '14' || t === '1') return 14;
    if (t === 'K' || t === 'KING' || t === '13') return 13;
    if (t === 'Q' || t === 'QUEEN' || t === '12') return 12;
    if (t === 'J' || t === 'JACK' || t === '11') return 11;
    const n = parseInt(t, 10);
    return n >= 2 && n <= 10 ? n : null;
  }
  const CARD_RE = /card-(hearts|diamonds|clubs|spades)-([0-9]{1,2}|[AJQK]|ace|king|queen|jack)\b/i;

  function roleHint(el) {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      const c = String(n.className || '') + ' ' + (n.id || '');
      if (/dealer/i.test(c)) return 'dealer';
      if (/player|you|your/i.test(c)) return 'yours';
    }
    return null;
  }

  // Torn's High-Low page (confirmed 11 Oct and 8 Nov 2026):
  //   .dealer-card > .title-card "Dealers Card: 10" + .card > .face1 / .face2
  //   .you-card    > .title-card "Your Card: 8"     + .card > .face1 / .face2
  // Cards flip between face1 and face2, and the hidden face can still hold the
  // previous card. The label is the source of truth: a card counts only when the
  // label shows a rank, and the suit is taken from the face that matches it.
  // An empty label ("Dealers Card:") means face down, so nothing is read.
  const SLOTS = { dealer: '.dealer-card', yours: '.you-card' };
  const LABEL_RE = /card\s*:\s*(10|[2-9]|[AJQK]|ace|king|queen|jack)\b/i;

  function readSlot(role) {
    const box = document.querySelector(SLOTS[role]);
    if (!box || box.closest('#thl-panel') || box.offsetParent === null) return null;
    const title = box.querySelector('.title-card');
    const tm = (title ? title.textContent : box.textContent || '').match(LABEL_RE);
    const shown = tm ? parseRank(tm[1]) : null;
    if (!shown) return null;
    const faces = [];
    box.querySelectorAll('[class*="card-"]').forEach(el => {
      const m = String(el.className).match(CARD_RE);
      if (m) faces.push({ r: parseRank(m[2]), suit: m[1].toLowerCase() });
    });
    // Prefer the last matching face (the one flipped to most recently).
    const match = faces.filter(f => f.r === shown).pop();
    const suit = match ? match.suit : 'x';
    return { r: shown, suit, role, key: suit + shown };
  }

  function findCards() {
    return ['dealer', 'yours'].map(readSlot).filter(Boolean);
  }

  function detect() {
    readMod();
    detectCards();
    readStreak();
  }

  function detectCards() {
    if (state.manual) return;
    const now = { dealer: readSlot('dealer'), yours: readSlot('yours') };
    const keyOf = role => (now[role] ? now[role].key : '');
    const sig = keyOf('dealer') + '|' + keyOf('yours');
    if (sig === state.lastSig) return;

    // First look after auto-detect is switched on: take the cards already on the
    // table as a starting point, so an old round isn't logged twice.
    if (!state.slots) {
      state.slots = { dealer: keyOf('dealer'), yours: keyOf('yours') };
      state.lastSig = sig;
      if (now.dealer && !state.hist.length) addCard(now.dealer.r, 'dealer');
      logLine('auto-detect ready: ' + (sig || 'no cards'));
      render(); return;
    }
    state.lastSig = sig;
    logLine('page: dealer ' + (keyOf('dealer') || '-') + ', yours ' + (keyOf('yours') || '-'));

    // A label that clears means that card was turned over or removed, so the next
    // card shown in that box is new, even if it has the same suit and rank.
    ['dealer', 'yours'].forEach(role => { if (!now[role]) state.slots[role] = ''; });

    const changed = ['dealer', 'yours'].filter(role => {
      if (!now[role] || now[role].key === state.slots[role]) return false;
      // Guard against a label flickering off and on for the same card:
      // the same card reappearing only counts if that box is due a card.
      if (now[role].key === state.lastCounted[role] && nextRole() !== role) {
        state.slots[role] = now[role].key;
        logLine('ignored repeat ' + role + ' ' + now[role].key);
        return false;
      }
      return true;
    });
    // If both changed at once, keep the game's order: finish this round first.
    if (changed.length === 2 && nextRole() === 'yours') changed.reverse();
    changed.forEach(role => {
      state.slots[role] = now[role].key;
      state.lastCounted[role] = now[role].key;
      addCard(now[role].r, role);
    });
    render();
  }

  // Passive: notes which button you pressed, so the log records your actual guess,
  // and when you press Cash In. It never clicks anything itself.
  document.addEventListener('click', e => {
    const t = e.target;
    if (!t || !t.closest || t.closest('#thl-panel')) return;
    const b = t.closest('.action-btn-wrap');
    if (b) {
      if (b.classList.contains('high')) state.guess = 'HIGHER';
      else if (b.classList.contains('low')) state.guess = 'LOWER';
      return;
    }
    // Fallback: a button whose text is "Higher"/"Lower", or "Cash in".
    const el = t.closest('button, a, [role="button"], [class*="btn" i], [class*="button" i]') || t;
    const txt = (el.textContent || '').trim().toLowerCase();
    if (txt.length > 40) return;
    if (/^high(er)?$/.test(txt)) state.guess = 'HIGHER';
    else if (/^low(er)?$/.test(txt)) state.guess = 'LOWER';
    else if (/cash\s*in/.test(txt)) {
      state.cashClick = { t: Date.now(), how: /half/.test(txt) ? 'half' : 'collected', pot: state.pot };
      logLine('cash in pressed: ' + state.cashClick.how + (state.pot ? ' $' + state.pot.toLocaleString() : ''));
    }
  }, true);

  // ---------- Torn's own game state: "(2 wins in a row)" and "CURRENT POT: $1,562,500" ----------
  // Ground truth for wins and losses, so a missed button press can't turn a loss into a win.
  function readStreak() {
    const text = document.body.textContent || '';
    const pm = text.match(/current\s*pot\s*:?\s*\$\s*([\d,]+)/i);
    state.pot = pm ? Number(pm[1].replace(/,/g, '')) : null;
    const m = text.match(/\(\s*(\d+)\s+wins?\s+in\s+a\s+row\s*\)/i);
    const s = m ? Number(m[1]) : null;
    if (state.streak === undefined) { state.streak = s; return; }   // first look: baseline only
    if (s === state.streak) return;
    const prev = state.streak;
    state.streak = s;
    logLine('Torn streak ' + (prev == null ? '-' : prev) + ' -> ' + (s == null ? '-' : s));

    const rs = state.rounds.filter(x => x.game === state.gameId);
    const lastRound = rs[rs.length - 1];

    // Streak went UP straight after the script ended a game as lost: it was a win.
    if (s != null && prev != null && s > prev && state.undoGame && !state.hist.length) {
      const g = state.games[state.games.length - 1];
      if (g && g.game === state.undoGame.gameId) state.games.pop();
      state.hist = state.undoGame.hist;
      state.gameId = state.undoGame.gameId;
      state.undoGame = null;
      const r = state.rounds.filter(x => x.game === state.gameId).pop();
      if (r) { r.result = 'win'; r.corrected = 'Torn streak'; }
      saveLog();
      flash('Corrected: Torn shows a win, game continues.');
      logLine('corrected loss -> win from Torn streak');
      return;
    }

    // Streak went DOWN or disappeared while a game is open: the game is over.
    if (rs.length && (s == null || (prev != null && s < prev))) {
      const cash = state.cashClick && Date.now() - state.cashClick.t < 20000 ? state.cashClick : null;
      state.cashClick = null;
      if (cash) {
        if (cash.pot && !document.getElementById('thl-pay').value) {
          document.getElementById('thl-pay').value = String(cash.how === 'half' ? Math.round(cash.pot / 2) : cash.pot);
        }
        endGame(cash.how);
        flash(cash.how === 'half' ? 'Took 50%: game logged.' : 'Cashed in: game logged.');
      } else {
        // No cash-in seen. If a round was just played, Torn ended the game on it: a loss.
        const justPlayed = lastRound && lastRound.ts && Date.now() - lastRound.ts < 8000;
        if (justPlayed) {
          if (lastRound.result === 'win') {
            lastRound.result = 'lose'; lastRound.corrected = 'Torn streak';
            logLine('corrected win -> lose from Torn streak');
          }
          endGame('lost');
          flash('Torn ended the game: logged as lost.');
        } else {
          // No new card and no Cash In click seen: can't tell a cash-in from a loss.
          endGame('unrecorded');
          flash('Game ended (cash-in or loss not seen): logged as not recorded.');
        }
      }
    }
  }

  // ---------- Odds ----------
  function oddsFrom(rank, left) {
    let hi = 0, lo = 0, tie = 0, n = 0;
    RANKS.forEach(r => { n += left[r]; if (r > rank) hi += left[r]; else if (r < rank) lo += left[r]; else tie += left[r]; });
    if (!n) return null;
    return { hi: hi / n, lo: lo / n, tie: tie / n, n, pick: hi >= lo ? 'HIGHER' : 'LOWER', win: Math.max(hi, lo) / n };
  }
  const mult = () => 1 + state.mod / 100;
  const guessValue = o => o.win * mult() + (state.ties === 'push' ? o.tie : 0);

  function continueValue(left) {
    let n = 0; RANKS.forEach(r => { n += left[r]; });
    if (n < 2) return null;
    let v = 0;
    RANKS.forEach(d => {
      if (!left[d]) return;
      const after = Object.assign({}, left); after[d] -= 1;
      const o = oddsFrom(d, after);
      if (o) v += (left[d] / n) * Math.max(0.5, guessValue(o));
    });
    return v;
  }

  // ---------- Panel ----------
  const css = `
    #thl-panel{position:fixed;right:16px;bottom:16px;z-index:99999;width:270px;
      background:#1f1f1f;color:#eee;font:12px/1.4 Arial,sans-serif;border:1px solid #444;
      border-radius:6px;box-shadow:0 2px 8px rgba(0,0,0,.5)}
    #thl-panel .h{padding:6px 8px;background:#2c2c2c;border-radius:6px 6px 0 0;cursor:move;
      display:flex;justify-content:space-between;font-weight:bold;user-select:none}
    #thl-panel .b{padding:8px}
    #thl-panel .cards{display:flex;justify-content:space-around;text-align:center}
    #thl-panel .cards b{font-size:20px;display:block}
    #thl-panel .cards span{font-size:10px;color:#aaa}
    #thl-panel .next{text-align:center;font-size:11px;color:#fc6;margin:4px 0}
    #thl-panel .lbl{font-size:10px;color:#aaa;margin-top:4px}
    #thl-panel .call{text-align:center;font-size:14px;font-weight:bold;padding:4px;border-radius:4px;margin:2px 0}
    #thl-panel .hi{background:#1d5c2e}#thl-panel .lo{background:#1d3f5c}#thl-panel .eq{background:#444;color:#aaa}
    #thl-panel .col{background:#8a5a00}#thl-panel .go{background:#1d5c2e}
    #thl-panel .why{color:#ccc;font-size:11px}
    #thl-panel table{width:100%;border-collapse:collapse;margin-top:4px}
    #thl-panel td{padding:1px 2px}#thl-panel td:last-child{text-align:right}
    #thl-panel .sec{margin-top:6px;padding-top:6px;border-top:1px solid #333}
    #thl-panel .ranks{display:grid;grid-template-columns:repeat(7,1fr);gap:2px}
    #thl-panel .rk{display:flex;flex-direction:column;align-items:center}
    #thl-panel .rk small{color:#aaa;font-size:10px}#thl-panel .rk small.z{color:#d55}
    #thl-panel button{background:#333;color:#eee;border:1px solid #555;border-radius:3px;
      padding:2px 0;cursor:pointer;font-size:11px;width:100%}
    #thl-panel button.on{background:#2b5d8a}
    #thl-panel .row{display:flex;gap:4px;margin-top:4px}#thl-panel .row>*{flex:1}
    #thl-panel input,#thl-panel select{width:100%;box-sizing:border-box;background:#2a2a2a;color:#eee;
      border:1px solid #555;border-radius:3px;padding:2px 4px;font-size:11px}
    #thl-panel label{font-size:10px;color:#aaa;display:block}
    #thl-panel .hist{font-size:11px;color:#ccc;word-break:break-word}
    #thl-panel .note{color:#999;font-size:10px;margin-top:4px}
    #thl-panel textarea{width:100%;height:120px;box-sizing:border-box;background:#111;color:#cfc;
      font:10px monospace;border:1px solid #555;margin-top:4px}
    #thl-panel.min .b{display:none}
  `;

  function build() {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);

    const p = document.createElement('div');
    p.id = 'thl-panel';
    p.innerHTML = `
      <div class="h"><span>High-Low helper</span><span id="thl-min" style="cursor:pointer">_</span></div>
      <div class="b">
        <div class="cards">
          <div><b id="thl-dealer">-</b><span>Dealer card</span></div>
          <div><b id="thl-yours">-</b><span>Your card</span></div>
        </div>
        <div class="next" id="thl-next"></div>

        <div class="lbl">Guess against the dealer card</div>
        <div class="call eq" id="thl-guess">Waiting</div>
        <div class="why" id="thl-gwhy"></div>
        <table>
          <tr><td>Higher / Lower</td><td id="thl-hl">-</td></tr>
          <tr><td>Tie</td><td id="thl-tie">-</td></tr>
          <tr><td>Cards left</td><td id="thl-n">-</td></tr>
        </table>

        <div class="lbl">After a win: collect or continue?</div>
        <div class="call eq" id="thl-cont">-</div>
        <div class="why" id="thl-cwhy"></div>

        <div class="sec">
          <label>Cards left by rank (click to enter the next card)</label>
          <div class="ranks" id="thl-ranks"></div>
          <div class="row">
            <button id="thl-undo">Undo</button>
            <button id="thl-new">New game</button>
            <button id="thl-track">Track: on</button>
          </div>
          <div class="row">
            <button id="thl-auto">Auto-detect</button>
            <button id="thl-dbg">Debug</button>
          </div>
          <div class="lbl">This deck (dealer / yours)</div>
          <div class="hist" id="thl-hist">-</div>
        </div>

        <div class="sec">
          <div class="row">
            <div><label>Chance mod %</label><input id="thl-mod" type="number" min="0" max="100" step="1"></div>
            <div><label>Min win % (0=off)</label><input id="thl-lim" type="number" min="0" max="100" step="1"></div>
            <div><label>Draws</label><div style="font-size:11px;padding-top:3px">Push (game continues)</div></div>
          </div>
        </div>
        <div class="sec">
          <label>Outcome log (saved in this browser)</label>
          <div class="row">
            <div><label>Bet (e.g. 10m)</label><input id="thl-bet" placeholder="10m"></div>
            <div><label>Payout (optional)</label><input id="thl-pay" placeholder="auto"></div>
          </div>
          <div class="row">
            <button id="thl-g-col">Collected</button>
            <button id="thl-g-half">Took 50%</button>
            <button id="thl-g-lost">Lost</button>
          </div>
          <div class="row">
            <button id="thl-x-r">Export rounds</button>
            <button id="thl-x-g">Export games</button>
            <button id="thl-x-clr">Clear log</button>
          </div>
          <div class="note" id="thl-stats"></div>
        </div>
        <div class="note" id="thl-src"></div>
        <div id="thl-dbgbox" style="display:none">
          <textarea id="thl-dbgtxt" readonly></textarea>
          <div class="row"><button id="thl-copy">Copy debug text</button></div>
        </div>
      </div>`;
    document.body.appendChild(p);

    const grid = p.querySelector('#thl-ranks');
    RANKS.forEach(r => {
      const d = document.createElement('div');
      d.className = 'rk';
      d.innerHTML = `<button data-r="${r}">${label(r)}</button><small id="thl-c${r}">4</small>`;
      // Manual entry: for corrections, or when auto-detect is off.
      d.querySelector('button').onclick = () => { addCard(r); render(); };
      grid.appendChild(d);
    });

    const $ = id => p.querySelector('#' + id);
    $('thl-mod').value = state.mod;
    $('thl-lim').value = state.limit;
    $('thl-mod').oninput = e => { const v = Number(e.target.value); if (v >= 0 && v <= 100) { state.mod = v; save(); render(); } };
    $('thl-lim').oninput = e => { const v = Number(e.target.value); if (v >= 0 && v <= 100) { state.limit = v; save(); render(); } };
    $('thl-undo').onclick = () => {
      // Undo a mis-entered card that wrongly ended the game as lost.
      if (state.undoGame && !state.hist.length) {
        const g = state.games[state.games.length - 1];
        if (g && g.game === state.undoGame.gameId) state.games.pop();
        state.hist = state.undoGame.hist;
        state.gameId = state.undoGame.gameId;
        state.undoGame = null;
        saveLog();
      }
      const c = state.hist.pop();
      if (c && c.role === 'yours') {
        const last = state.rounds[state.rounds.length - 1];
        if (last && last.game === state.gameId) { state.rounds.pop(); saveLog(); }
      }
      logLine('undo'); render();
    };
    $('thl-bet').value = state.bet;
    $('thl-bet').oninput = e => { state.bet = e.target.value; saveLog(); };
    $('thl-g-col').onclick = () => endGame('collected');
    $('thl-g-half').onclick = () => endGame('half');
    $('thl-g-lost').onclick = () => endGame('lost');
    $('thl-x-r').onclick = () => {
      if (!state.rounds.length) { flash('No rounds logged yet.'); render(); return; }
      download('torn-highlow-rounds-' + new Date().toISOString().slice(0, 10) + '.csv', toCSV(state.rounds));
    };
    $('thl-x-g').onclick = () => {
      if (!state.games.length) { flash('No games logged yet.'); render(); return; }
      download('torn-highlow-games-' + new Date().toISOString().slice(0, 10) + '.csv', toCSV(state.games));
    };
    $('thl-x-clr').onclick = () => {
      if (!confirm('Clear the High-Low outcome log? Export first if you want to keep it.')) return;
      state.rounds = []; state.games = []; saveLog(); render();
    };
    // New game: if the last game was never ended, log it as "not recorded".
    // New game also re-reads the table, so a dealer card already showing is picked up.
    $('thl-new').onclick = () => {
      state.undoGame = null; endGame('unrecorded');
      state.slots = null; state.lastCounted = { dealer: '', yours: '' };
      logLine('new game'); detect(); render();
    };
    $('thl-track').onclick = () => { state.track = !state.track; save(); render(); };
    $('thl-auto').onclick = () => {
      state.manual = !state.manual;
      state.slots = null; state.lastSig = '';
      if (!state.manual) detect();
      render();
    };
    $('thl-dbg').onclick = () => {
      const box = $('thl-dbgbox');
      box.style.display = box.style.display === 'none' ? 'block' : 'none';
      $('thl-dbgtxt').value = debugText();
    };
    $('thl-copy').onclick = () => {
      $('thl-dbgtxt').value = debugText();
      $('thl-dbgtxt').select();
      try { navigator.clipboard.writeText($('thl-dbgtxt').value); } catch (e) { document.execCommand('copy'); }
      flash('Debug text copied.'); render();
    };
    $('thl-min').onclick = () => p.classList.toggle('min');
    drag(p, p.querySelector('.h'));
  }

  function debugText() {
    const classes = new Set();
    document.querySelectorAll('[class]').forEach(el => {
      if (el.closest('#thl-panel')) return;
      const c = String(el.className);
      if (/card|deck|dealer|player|suit|rank|high|low/i.test(c)) classes.add(c.trim().slice(0, 120));
    });
    // Other ways Torn might show a card: images, background images, labels, text.
    const hints = new Set();
    const cardWord = /card|hearts?|diamonds?|clubs?|spades?|dealer|player|ace|king|queen|jack/i;
    document.querySelectorAll('img, [style*="background"], [aria-label], [title], [data-card], [data-value], [data-rank]').forEach(el => {
      if (el.closest('#thl-panel') || el.offsetParent === null) return;
      const bits = [
        el.tagName.toLowerCase(),
        el.className ? 'class=' + String(el.className).slice(0, 60) : '',
        el.getAttribute('src') ? 'src=' + el.getAttribute('src').slice(-80) : '',
        el.getAttribute('alt') ? 'alt=' + el.getAttribute('alt') : '',
        el.getAttribute('aria-label') ? 'aria=' + el.getAttribute('aria-label') : '',
        el.getAttribute('title') ? 'title=' + el.getAttribute('title') : '',
        ...Array.from(el.attributes).filter(a => a.name.startsWith('data-')).map(a => a.name + '=' + a.value.slice(0, 40)),
        (el.style && el.style.backgroundImage) ? 'bg=' + el.style.backgroundImage.slice(-80) : ''
      ].filter(Boolean).join(' ');
      if (cardWord.test(bits)) hints.add(bits.slice(0, 200));
    });
    // Short visible text near anything card-like (e.g. "7", "K")
    const texts = new Set();
    document.querySelectorAll('[class*="card" i], [class*="dealer" i], [class*="player" i]').forEach(el => {
      if (el.closest('#thl-panel') || el.offsetParent === null) return;
      const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
      if (t && t.length < 40) texts.add(String(el.className).slice(0, 50) + ' => "' + t + '"');
    });
    return [
      'URL: ' + location.pathname + location.search,
      'Detected: ' + (findCards().map(c => (c.role || '?') + ' ' + label(c.r) + ' ' + c.suit).join(', ') || 'none'),
      'Deck history: ' + state.hist.map(c => (c.role === 'dealer' ? 'D' : 'Y') + label(c.r)).join(' '),
      'Torn streak: ' + (state.streak == null ? 'not shown' : state.streak) + ' | pot: ' + (state.pot == null ? 'not shown' : '$' + state.pot.toLocaleString()),
      'Pot box text: ' + (((document.body.textContent || '').match(/current\s*pot[\s\S]{0,120}/i) || ['not found'])[0]).replace(/\s+/g, ' '),
      'Buttons: ' + Array.from(document.querySelectorAll('button, a, [class*="btn" i]'))
        .filter(el => !el.closest('#thl-panel') && el.offsetParent !== null && /high|low|cash|start|bet/i.test(el.textContent + ' ' + el.className))
        .slice(0, 8).map(el => String(el.className).slice(0, 40) + ' "' + (el.textContent || '').trim().slice(0, 20) + '"').join(' | '),
      '',
      'Card-related classes on page (first 40):',
      ...Array.from(classes).slice(0, 40),
      '',
      'Images / labels / data attributes (first 30):',
      ...Array.from(hints).slice(0, 30),
      '',
      'Visible text in card areas (first 20):',
      ...Array.from(texts).slice(0, 20),
      '',
      'Recent log:',
      ...state.log.slice(-20)
    ].join('\n');
  }

  function drag(panel, handle) {
    handle.addEventListener('mousedown', e => {
      const sx = e.clientX, sy = e.clientY;
      const r = panel.getBoundingClientRect();
      const move = ev => {
        panel.style.left = r.left + ev.clientX - sx + 'px';
        panel.style.top = r.top + ev.clientY - sy + 'px';
        panel.style.right = 'auto'; panel.style.bottom = 'auto';
      };
      const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  }

  function logLine(s) {
    state.log.push(new Date().toLocaleTimeString() + '  ' + s);
    if (state.log.length > 40) state.log.shift();
  }
  let flashMsg = '', flashUntil = 0;
  function flash(msg) { flashMsg = msg; flashUntil = Date.now() + 6000; }
  const pct = x => (x * 100).toFixed(1) + '%';
  const x2 = v => '×' + v.toFixed(2);

  function render() {
    const $ = id => document.getElementById(id);
    if (!$('thl-panel')) return;
    saveGame();

    const left = remaining();
    RANKS.forEach(r => {
      const c = $('thl-c' + r);
      c.textContent = state.track ? left[r] : '-';
      c.classList.toggle('z', state.track && left[r] === 0);
    });
    $('thl-track').textContent = 'Track: ' + (state.track ? 'on' : 'off');
    $('thl-track').classList.toggle('on', state.track);
    $('thl-auto').classList.toggle('on', !state.manual);
    $('thl-auto').textContent = 'Auto-detect: ' + (state.manual ? 'off' : 'on');

    const role = nextRole();
    const last = state.hist[state.hist.length - 1];
    const dealer = last ? (last.role === 'dealer' ? last.r : lastOf('dealer')) : null;
    const yours = last && last.role === 'yours' ? last.r : null;
    $('thl-dealer').textContent = dealer != null ? label(dealer) : '-';
    $('thl-yours').textContent = yours != null ? label(yours) : '-';
    $('thl-next').textContent = 'Next card to enter: ' + (role === 'dealer' ? 'DEALER card' : 'YOUR card');
    document.querySelectorAll('#thl-ranks button').forEach(b => b.classList.remove('on'));

    // History, paired by round
    const pairs = [];
    state.hist.forEach(c => {
      if (c.role === 'dealer' || !pairs.length) pairs.push(label(c.r));
      else pairs[pairs.length - 1] += ' / ' + label(c.r);
    });
    $('thl-hist').textContent = pairs.length ? pairs.join(',  ') : '-';
    $('thl-src').textContent = (Date.now() < flashUntil ? flashMsg + ' ' : '') +
      (state.manual ? 'Manual entry' : 'Auto-detect') +
      (state.track ? ` | dealt ${state.hist.length}/52` : ' | fresh deck each draw') +
      ` | win pays ${x2(mult())}`;

    // Running totals
    const rs = state.rounds, gs = state.games;
    const w = rs.filter(x => x.result === 'win').length;
    const exp = rs.reduce((a, x) => a + x.winPct / 100, 0);
    const profit = gs.reduce((a, x) => a + (typeof x.profit === 'number' ? x.profit : 0), 0);
    $('thl-stats').textContent = rs.length
      ? `Rounds ${rs.length}: won ${w} (${pct(w / rs.length)}), expected ${pct(exp / rs.length)}. ` +
        `Games ${gs.length}, profit ${profit < 0 ? '-' : ''}$${Math.abs(Math.round(profit)).toLocaleString()}.`
      : 'No rounds logged yet.';

    const g = $('thl-guess'), gw = $('thl-gwhy'), c = $('thl-cont'), cw = $('thl-cwhy');

    // Guess box: odds against the dealer card, from the deck as it stood when it was dealt.
    if (dealer == null) {
      g.textContent = 'Enter the dealer card'; g.className = 'call eq'; gw.textContent = '';
      ['thl-hl', 'thl-tie', 'thl-n'].forEach(id => { $(id).textContent = '-'; });
    } else {
      const atDeal = yours != null ? state.hist.length - 1 : state.hist.length;
      const o = oddsFrom(dealer, remaining(atDeal));
      if (o) {
        $('thl-hl').textContent = pct(o.hi) + ' / ' + pct(o.lo);
        $('thl-tie').textContent = pct(o.tie) + (state.ties === 'push' ? ' (push)' : ' (loss)');
        $('thl-n').textContent = o.n;
        const gv = guessValue(o);
        g.textContent = gv < 0.5 ? 'TAKE 50%' : `${o.pick}  ${pct(o.win)}`;
        g.className = 'call ' + (gv < 0.5 ? 'col' : o.pick === 'HIGHER' ? 'hi' : 'lo');
        gw.textContent = `Guessing is worth ${x2(gv)} of the pot (cash-out now is ×0.50).`;
        if (yours != null) { g.className = 'call eq'; gw.textContent = 'Round played. ' + gw.textContent; }
      }
    }

    // Collect/continue: averages over every card left for the NEXT dealer card.
    const cv = continueValue(left);
    if (yours == null) {
      c.textContent = '-'; c.className = 'call eq';
      cw.textContent = cv == null ? '' : `After this round, continuing would be worth about ${x2(cv)} of the pot.`;
    } else if (cv == null) {
      c.textContent = 'COLLECT'; c.className = 'call col'; cw.textContent = 'Deck nearly empty.';
    } else {
      const lim = state.limit > 0 && cv / mult() * 100 < state.limit;
      const collect = cv < 1 || lim;
      c.textContent = collect ? 'COLLECT' : 'CONTINUE';
      c.className = 'call ' + (collect ? 'col' : 'go');
      cw.textContent = `Next dealer card comes from the ${Object.values(left).reduce((a, b) => a + b, 0)} cards left. ` +
        `Continuing is worth ${x2(cv)} of the pot; collecting is ×1.00.` +
        (lim ? ` Average win chance is under your ${state.limit}% limit.` : '');
    }
  }

  build();
  const fixed = backfillGames();
  if (fixed) flash(`Recovered ${fixed} earlier game(s) into the games log.`);
  if (state.restored) { flash(`Game in progress restored (${state.restored} cards).`); logLine('restored ' + state.restored + ' cards'); }
  readMod();
  render();
  let t = null;
  // Watch picture (class) changes AND label text changes: Torn updates them at different moments.
  new MutationObserver(() => { clearTimeout(t); t = setTimeout(detect, 400); })
    .observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class', 'style'] });
  // Backstop: re-read the two card boxes once a second. Reads the page only; no requests.
  setInterval(detect, 1000);
  detect();
})();
