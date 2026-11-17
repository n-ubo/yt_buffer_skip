// ==UserScript==
// @name         YT Preview Handoff
// @namespace    yt-preview-handoff
// @version      1.0.0
// @description  Keeps the hover preview playing until the real YouTube player is ready, then hands off at the same timestamp.
// @match        https://www.youtube.com/*
// @match        https://m.youtube.com/*
// @run-at       document-idle
// @grant        none
// @inject-into  page
// ==/UserScript==

// Keeps the hover preview playing over the watch page until the real player
// is ready, then hands off at the same timestamp.

(() => {
  'use strict';

  if (window.__ytHandoffLoaded) return console.log('[handoff] already running');
  window.__ytHandoffLoaded = true;
  console.log('[handoff] loaded');

  const DEBUG = false;
  const log = (...a) => DEBUG && console.log('[handoff]', ...a);

  const P = HTMLMediaElement.prototype;
  const d = (k) => Object.getOwnPropertyDescriptor(P, k);
  const SRC = d('src');
  const MUTED = d('muted');
  const VOL = d('volume');

  const NAV_WINDOW_MS = 1000;   // how long to wait for a navigation after the click
  const GIVE_UP_MS = 15000;     // max time the overlay stays up after navigating
  const SYNC_TOLERANCE = 0.35;  // seconds of drift we accept at handoff
  const PREVIEW_WAIT_MS = 2500; // early click: max wait for the preview to start before navigating anyway

  let state = null;
  let pending = null; // early click waiting for the preview to start
  let bypass = false; // lets our own re-dispatched click through

  // ---------- helpers ----------

  const mainPlayer = () =>
    document.querySelector('ytd-watch-flexy #movie_player') ||
    document.getElementById('movie_player');

  const isWatch = () => location.pathname.startsWith('/watch');

  function findPreviewVideo(x, y) {
    for (const v of document.querySelectorAll('video')) {
      if (v.closest('ytd-watch-flexy, ytd-miniplayer')) continue; // that's the real player
      if (v.paused || v.currentTime === 0 || v.readyState < 2) continue;
      const r = v.getBoundingClientRect();
      if (r.width < 50 || r.height < 30) continue;
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
      return v;
    }
    return null;
  }

  // YouTube's inline player will try to kill the element once you navigate.
  // Block the calls it uses to do that while we're borrowing it.
  function guard(v) {
    const noop = function () {};
    v.pause = noop;
    v.load = noop;
    v.removeAttribute = function (n) {
      if (String(n).toLowerCase() === 'src') return;
      return Element.prototype.removeAttribute.call(this, n);
    };
    for (const [k, desc] of [['src', SRC], ['muted', MUTED], ['volume', VOL]]) {
      Object.defineProperty(v, k, {
        configurable: true,
        get() { return desc.get.call(this); },
        set() {},
      });
    }
  }

  function unguard(v) {
    for (const k of ['pause', 'load', 'removeAttribute', 'src', 'muted', 'volume']) delete v[k];
  }

  // ---------- lifecycle ----------

  function start(v) {
    cleanup(true);

    const rect = v.getBoundingClientRect();
    const box = document.createElement('div');
    Object.assign(box.style, {
      position: 'fixed',
      left: rect.left + 'px',
      top: rect.top + 'px',
      width: rect.width + 'px',
      height: rect.height + 'px',
      zIndex: '2147483647',
      background: '#000',
      overflow: 'hidden',
      borderRadius: '12px',
      pointerEvents: 'none',
      transition: 'left .25s ease, top .25s ease, width .25s ease, height .25s ease, border-radius .25s ease',
    });

    const pl = mainPlayer();
    state = {
      v,
      box,
      home: { parent: v.parentNode, next: v.nextSibling, css: v.style.cssText },
      origMuted: MUTED.get.call(v),
      navigated: false,
      navAt: 0,
      placed: false,
      mutedMain: false,
      mainWasMuted: false,
      seekAt: 0,
      raf: 0,
      revertTimer: 0,
    };

    guard(v);
    // A synchronous remove+insert doesn't trigger the "paused because removed" rule,
    // so the video keeps playing through the move.
    box.appendChild(v);
    document.body.appendChild(box);
    v.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:contain;';

    // We're inside a click, so unmuted playback is allowed.
    if (pl && pl.isMuted && !pl.isMuted()) {
      VOL.set.call(v, Math.min(1, (pl.getVolume?.() ?? 100) / 100));
      MUTED.set.call(v, false);
    }
    P.play.call(v).catch(() => {});

    // Clicked something on the preview that didn't navigate (e.g. some overlay) -> give it back.
    state.revertTimer = setTimeout(() => {
      if (state && !state.navigated) cleanup(true);
    }, NAV_WINDOW_MS);

    log('started at', v.currentTime);
    state.raf = requestAnimationFrame(tick);
  }

  function place(r) {
    const b = state.box;
    b.style.left = r.left + 'px';
    b.style.top = r.top + 'px';
    b.style.width = r.width + 'px';
    b.style.height = r.height + 'px';
    if (!state.placed) {
      state.placed = true;
      b.style.borderRadius = '0';
      const s = state;
      setTimeout(() => { if (state === s) b.style.transition = 'none'; }, 300);
    }
  }

  function tick() {
    if (!state) return;

    if (state.navigated) {
      if (performance.now() - state.navAt > GIVE_UP_MS) return cleanup();

      const pl = document.querySelector('ytd-watch-flexy:not([hidden]) #movie_player');
      if (pl) {
        const r = pl.getBoundingClientRect();
        if (r.width > 100 && r.height > 50) place(r);
      }
      if (tryHandoff()) return;
    }

    state.raf = requestAnimationFrame(tick);
  }

  // Returns true once the handoff is done.
  function tryHandoff() {
    if (!isWatch()) return false;
    const pl = mainPlayer();
    const mv = pl?.querySelector('video.html5-main-video');
    if (!pl || !mv || mv === state.v) return false;

    // Keep the real player quiet so you don't get double audio during the gap.
    if (!state.mutedMain && pl.mute) {
      state.mainWasMuted = !!pl.isMuted?.();
      pl.mute();
      state.mutedMain = true;
    }

    if (pl.classList.contains('ad-showing')) return false;
    if (mv.readyState < 3) return false;

    const target = state.v.currentTime;

    if (Math.abs(mv.currentTime - target) > SYNC_TOLERANCE) {
      if (performance.now() - state.seekAt > 1200) {
        log('seeking main to', target);
        pl.seekTo(target + 0.15, true);
        state.seekAt = performance.now();
      }
      return false;
    }

    if (mv.paused) {
      pl.playVideo?.();
      return false;
    }

    log('handoff at', mv.currentTime);
    finish();
    return true;
  }

  function finish() {
    const s = state;
    if (s.mutedMain && !s.mainWasMuted) mainPlayer()?.unMute?.();
    s.mutedMain = false;
    s.box.style.transition = 'opacity .15s';
    s.box.style.opacity = '0';
    setTimeout(() => { if (state === s) cleanup(); }, 160);
  }

  function cleanup(revert = false) {
    if (!state) return;
    const s = state;
    state = null;

    cancelAnimationFrame(s.raf);
    clearTimeout(s.revertTimer);

    if (s.mutedMain && !s.mainWasMuted) mainPlayer()?.unMute?.();

    if (revert) {
      MUTED.set.call(s.v, s.origMuted);
    } else {
      P.pause.call(s.v);
      MUTED.set.call(s.v, true);
    }

    unguard(s.v);
    s.v.style.cssText = s.home.css;
    if (s.home.parent && s.home.parent.isConnected) {
      const next = s.home.next && s.home.next.parentNode === s.home.parent ? s.home.next : null;
      s.home.parent.insertBefore(s.v, next);
    } else {
      s.v.remove();
    }
    s.box.remove();
    log('cleaned up', revert ? '(reverted)' : '');
  }

  // ---------- early clicks ----------

  // Only hold clicks on thumbnails (where previews play), not titles/channel links.
  function onThumbnail(e, a) {
    if (e.target.closest('ytd-video-preview, #video-preview')) return true;
    const img = a.querySelector('img');
    if (!img) return false;
    const r = img.getBoundingClientRect();
    return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  }

  // Re-fire the click on YouTube's own link so it does its normal in-page navigation.
  function go(a) {
    if (!a.isConnected) { location.href = a.href; return; }
    bypass = true;
    try { a.click(); } finally { bypass = false; }
  }

  function clearPending() {
    if (!pending) return;
    cancelAnimationFrame(pending.raf);
    document.documentElement.style.cursor = pending.prevCursor;
    pending = null;
  }

  function waitForPreview(a, x, y) {
    const root = document.documentElement;
    pending = { a, x, y, raf: 0, t0: performance.now(), prevCursor: root.style.cursor };
    root.style.cursor = 'progress';
    log('early click, waiting for preview');

    const loop = () => {
      if (!pending) return;
      const p = pending;
      const v = findPreviewVideo(p.x, p.y);
      if (v && v.currentTime > 0.1) {
        log('preview started, navigating');
        clearPending();
        start(v);
        go(p.a);
        return;
      }
      if (performance.now() - p.t0 > PREVIEW_WAIT_MS) {
        log('no preview, navigating anyway');
        clearPending();
        go(p.a);
        return;
      }
      p.raf = requestAnimationFrame(loop);
    };
    pending.raf = requestAnimationFrame(loop);
  }

  // ---------- events ----------

  document.addEventListener('click', (e) => {
    if (bypass) return;
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    if (e.target.closest?.('button, [role="button"], .ytp-button, yt-icon-button')) return;

    // Preview already playing: hand it off and let the click navigate normally.
    const v = findPreviewVideo(e.clientX, e.clientY);
    if (v) {
      clearPending();
      start(v);
      return;
    }

    // Second click while we're waiting: stop waiting and just go.
    if (pending) {
      e.preventDefault();
      e.stopImmediatePropagation();
      const a = pending.a;
      clearPending();
      go(a);
      return;
    }

    // Clicked a thumbnail before its preview started: hold the navigation.
    const a = e.target.closest?.('a[href*="/watch"]');
    if (!a || !onThumbnail(e, a)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    waitForPreview(a, e.clientX, e.clientY);
  }, true); // capture phase: grab it before YouTube reacts to the click

  document.addEventListener('yt-navigate-start', () => {
    if (pending) clearPending(); // navigated some other way, drop the wait
    if (!state) return;
    if (state.navigated) return cleanup(); // navigating somewhere else again
    state.navigated = true;
    state.navAt = performance.now();
    clearTimeout(state.revertTimer);
  });

  document.addEventListener('yt-navigate-finish', () => {
    if (state && !isWatch()) cleanup();
  });

  window.addEventListener('popstate', () => cleanup());
})();