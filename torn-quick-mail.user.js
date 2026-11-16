// ==UserScript==
// @name         Torn Quick Mail
// @namespace    sterlingarcher.torn
// @version      1.0.1
// @description  Display only. Adds a small mail icon next to player names that opens Torn's compose page for that player in a new tab. Remembers who you've mailed.
// @author       SterlingArcher
// @match        https://www.torn.com/*
// @match        https://torn.com/*
// @grant        none
// @run-at       document-idle
// @homepageURL  https://github.com/Ste5144/Torn-Script
// @updateURL    https://raw.githubusercontent.com/Ste5144/Torn-Script/main/torn-quick-mail.user.js
// @downloadURL  https://raw.githubusercontent.com/Ste5144/Torn-Script/main/torn-quick-mail.user.js
// ==/UserScript==

/*
  Display only. The icon is an ordinary link: it opens the compose page in a new tab
  and you type or paste the message and press Send yourself. Nothing is sent, filled in
  or clicked by the script. No API key used.
  Works in Tampermonkey/Violentmonkey and Torn PDA (no GM_ functions).

  Icon colours:
    grey  = not mailed from this browser
    green = mailed before (hover to see the date)

  Shift+click an icon to clear that player's "mailed" mark.
*/

(function () {
  'use strict';

  const VERSION = '1.0.1';

  // Compose page address. {ID} is replaced with the player's ID.
  // If Torn changes it, copy the address of the "Send message" button on any profile and paste it here.
  const COMPOSE_URL = 'https://www.torn.com/messages.php#/p=compose&XID={ID}';

  const STORE_KEY = 'tqm_mailed_v1';
  const DONE_ATTR = 'data-tqm';

  // Areas where icons would only get in the way.
  const SKIP_SELECTORS = ['#chatRoot', '[class*="chat-box"]', '[class*="chat_"]', '.tqm-icon'];

  function loadLog() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch (e) { return {}; }
  }
  function saveLog(log) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(log)); } catch (e) { /* storage blocked */ }
  }

  function fmtDate(ts) {
    return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }

  function addStyles() {
    if (document.getElementById('tqm-style')) return;
    const s = document.createElement('style');
    s.id = 'tqm-style';
    s.textContent = `
      .tqm-icon{display:inline-block;margin-left:4px;padding:0 3px;font-size:11px;line-height:14px;
        border-radius:3px;text-decoration:none!important;vertical-align:middle;cursor:pointer;
        background:#555;color:#fff!important;font-family:Arial,sans-serif}
      .tqm-icon:hover{background:#c9a227;color:#111!important}
      .tqm-icon.tqm-done{background:#2e7d32}
    `;
    document.head.appendChild(s);
  }

  function paint(icon, id, name, log) {
    const rec = log[id];
    if (rec) {
      icon.classList.add('tqm-done');
      icon.title = `Mailed ${fmtDate(rec.t)}. Click to mail ${name} again (Shift+click clears the mark). Quick Mail v${VERSION}`;
    } else {
      icon.classList.remove('tqm-done');
      icon.title = `Mail ${name} (opens compose in a new tab). Quick Mail v${VERSION}`;
    }
  }

  // Player name from the link text, or from an honor bar image's alt/title.
  function playerName(a) {
    const txt = a.textContent.trim();
    if (txt) return txt.replace(/\s*\[\d+\]$/, '');
    const img = a.querySelector('img[alt], img[title]');
    const fromImg = img && (img.getAttribute('alt') || img.getAttribute('title') || '').trim();
    return (fromImg || a.getAttribute('title') || '').replace(/\s*\[\d+\]$/, '');
  }

  function shouldSkip(a) {
    if (a.hasAttribute(DONE_ATTR)) return true;
    if (SKIP_SELECTORS.some(sel => a.closest(sel))) return true;
    // Skip avatar pictures (tall images); keep honor bars (short and wide).
    const img = a.querySelector('img');
    if (img && !a.textContent.trim()) {
      const h = img.getBoundingClientRect().height || img.height;
      if (h > 30) return true;
    }
    return false;
  }

  function decorate(root) {
    const log = loadLog();
    const links = root.querySelectorAll ? root.querySelectorAll('a[href*="profiles.php?XID="]') : [];
    links.forEach(a => {
      if (shouldSkip(a)) return;
      const m = a.href.match(/XID=(\d+)/);
      if (!m) return;
      const id = m[1];
      const name = playerName(a) || `player ${id}`;
      a.setAttribute(DONE_ATTR, '1');

      const icon = document.createElement('a');
      icon.className = 'tqm-icon';
      icon.textContent = '✉';
      icon.href = COMPOSE_URL.replace('{ID}', id);
      icon.target = '_blank';
      icon.rel = 'noopener';
      paint(icon, id, name, log);

      icon.addEventListener('click', e => {
        const current = loadLog();
        if (e.shiftKey) {
          e.preventDefault();
          delete current[id];
          saveLog(current);
          refreshAll(id);
          return;
        }
        current[id] = { n: name, t: Date.now() };
        saveLog(current);
        refreshAll(id);
      });

      a.insertAdjacentElement('afterend', icon);
    });
  }

  // Keep every icon for the same player in step after a click.
  function refreshAll(id) {
    const log = loadLog();
    document.querySelectorAll('.tqm-icon').forEach(icon => {
      const m = icon.href.match(/XID=(\d+)/);
      if (m && m[1] === id) {
        const link = icon.previousElementSibling;
        const name = (link && playerName(link)) || `player ${id}`;
        paint(icon, id, name, log);
      }
    });
  }

  function start() {
    addStyles();
    decorate(document);
    let pending = false;
    new MutationObserver(() => {
      if (pending) return;
      pending = true;
      setTimeout(() => { pending = false; decorate(document); }, 300);
    }).observe(document.body, { childList: true, subtree: true });
  }

  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);
})();
