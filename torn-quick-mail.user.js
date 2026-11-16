// ==UserScript==
// @name         Torn Quick Mail
// @namespace    sterlingarcher.torn
// @version      1.1.0
// @description  Adds a mail icon next to player names that opens Torn's compose page and pre-fills your recruitment subject and message. You press Send yourself. Remembers who you've mailed.
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
  The icon is an ordinary link: it opens the compose page in a new tab. When you arrive
  that way, the script fills in the subject and message below; you check it and press
  Send yourself. Nothing is ever sent or clicked by the script. No API key used.
  Composing a mail any other way is left untouched.
  Works in Tampermonkey/Violentmonkey and Torn PDA (no GM_ functions).

  Icon colours:
    grey  = not mailed from this browser
    green = mailed before (hover to see the date)

  Shift+click an icon to clear that player's "mailed" mark.
*/

(function () {
  'use strict';

  const VERSION = '1.1.0';

  // Compose page address. {ID} is replaced with the player's ID.
  // If Torn changes it, copy the address of the "Send message" button on any profile and paste it here.
  const COMPOSE_URL = 'https://www.torn.com/messages.php#/p=compose&XID={ID}';

  // Pre-filled mail. Edit these to change the message.
  const SUBJECT = 'Quick Message from our sponsor: TWGSA  Wait!';
  const IMAGE_URL = 'https://i.imgur.com/yl9Tnn4.png';
  // Optional line under the image, e.g. 'Apply here: https://www.torn.com/...'. Leave '' for none.
  const FOOTER = '';

  const STORE_KEY = 'tqm_mailed_v1';
  const PENDING_KEY = 'tqm_pending_v1';
  const PENDING_MAX_AGE = 120000; // fill only if the icon was clicked in the last 2 minutes
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
        try { localStorage.setItem(PENDING_KEY, JSON.stringify({ id, t: Date.now() })); } catch (err) { /* ignore */ }
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

  // ---------- Pre-fill on the compose page ----------

  function bodyHtml() {
    let html = `<img src="${IMAGE_URL}" alt="Archer Mining Co is hiring">`;
    if (FOOTER) html += `<br>${FOOTER.replace(/</g, '&lt;')}`;
    return html;
  }

  function takePending() {
    let p = null;
    try { p = JSON.parse(localStorage.getItem(PENDING_KEY)); } catch (e) { /* ignore */ }
    if (!p || Date.now() - p.t > PENDING_MAX_AGE) return null;
    const m = location.hash.match(/XID=(\d+)/);
    if (m && m[1] !== String(p.id)) return null;
    try { localStorage.removeItem(PENDING_KEY); } catch (e) { /* ignore */ }
    return p;
  }

  function setNativeValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function findSubject() {
    return document.querySelector(
      'input[name="subject"], input#subject, input[placeholder*="ubject" i], input[aria-label*="ubject" i]'
    );
  }

  function findBody() {
    // Rich text editor in an iframe (TinyMCE / CKEditor style).
    for (const f of document.querySelectorAll('iframe')) {
      try {
        const b = f.contentDocument && f.contentDocument.body;
        if (b && (b.isContentEditable || b.getAttribute('contenteditable') === 'true')) return { kind: 'iframe', el: b, doc: f.contentDocument };
      } catch (e) { /* cross-origin frame */ }
    }
    const ce = document.querySelector('[contenteditable="true"]');
    if (ce) return { kind: 'ce', el: ce, doc: document };
    const ta = document.querySelector('textarea[name="message"], textarea');
    if (ta) return { kind: 'ta', el: ta };
    return null;
  }

  function fillBody(target) {
    const html = bodyHtml();
    if (target.kind === 'ta') { setNativeValue(target.el, html); return; }
    target.el.focus();
    let ok = false;
    try { ok = target.doc.execCommand('insertHTML', false, html); } catch (e) { ok = false; }
    if (!ok || !target.el.querySelector('img')) target.el.innerHTML = html;
    target.el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function showFallback(missing) {
    if (document.getElementById('tqm-fallback')) return;
    const box = document.createElement('div');
    box.id = 'tqm-fallback';
    box.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:99999;background:#222;color:#eee;border:1px solid #c9a227;' +
      'padding:10px 12px;font:12px Arial,sans-serif;max-width:300px;border-radius:4px';
    box.innerHTML = `<b>Quick Mail</b>: couldn't fill the ${missing}. Copy and paste instead:<br>`;
    const btn = (label, text) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = 'margin:6px 6px 0 0;padding:3px 8px;cursor:pointer';
      b.onclick = () => { navigator.clipboard && navigator.clipboard.writeText(text); b.textContent = 'Copied'; };
      box.appendChild(b);
    };
    btn('Copy subject', SUBJECT);
    btn('Copy image link', IMAGE_URL);
    const x = document.createElement('button');
    x.textContent = 'Close';
    x.style.cssText = 'margin:6px 0 0;padding:3px 8px;cursor:pointer';
    x.onclick = () => box.remove();
    box.appendChild(x);
    document.body.appendChild(box);
  }

  function prefillCompose() {
    if (!/messages\.php/.test(location.pathname) || !/compose/.test(location.hash)) return;
    if (!takePending()) return;
    let subjectDone = false, bodyDone = false, tries = 0;
    const timer = setInterval(() => {
      tries++;
      if (!subjectDone) {
        const s = findSubject();
        if (s) { setNativeValue(s, SUBJECT); subjectDone = true; }
      }
      if (!bodyDone) {
        const b = findBody();
        if (b) { fillBody(b); bodyDone = true; }
      }
      if ((subjectDone && bodyDone) || tries > 30) {
        clearInterval(timer);
        const missing = [!subjectDone && 'subject', !bodyDone && 'message'].filter(Boolean).join(' and ');
        if (missing) showFallback(missing);
      }
    }, 500);
  }

  function start() {
    addStyles();
    prefillCompose();
    window.addEventListener('hashchange', prefillCompose);
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
