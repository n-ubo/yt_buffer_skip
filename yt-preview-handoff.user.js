// ==UserScript==
// @name         YT Preview Handoff
// @namespace    yt-preview-handoff
// @version      1.5.0
// @description  Keeps the hover preview playing until the real YouTube player is ready, then hands off at the same timestamp.
// @match        https://www.youtube.com/*
// @run-at       document-idle
// @grant        none
// @inject-into  page
// @downloadURL  https://raw.githubusercontent.com/n-ubo/yt_buffer_skip/master/yt-preview-handoff.user.js
// @updateURL    https://raw.githubusercontent.com/n-ubo/yt_buffer_skip/master/yt-preview-handoff.user.js
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
  const MUTED = d('muted');
  const VOL = d('volume');
  // Properties YouTube's preview player must not touch while we're borrowing the video.
  const GUARDED = ['src', 'srcObject', 'currentTime', 'muted', 'volume'].map((k) => [k, d(k)]);

  const NAV_WINDOW_MS = 1000;   // how long to wait for a navigation after the click
  const GIVE_UP_MS = 15000;     // max time the overlay stays up after navigating
  const SYNC_TOLERANCE = 0.35;  // seconds of drift we accept at handoff
  const PREVIEW_WAIT_MS = 2500; // early click: max wait for the preview to start before navigating anyway
  const SNAP_MS = 200;          // how often we save the current frame (shown if the video drops out)
  const FRAME_WAIT_MS = 1000;   // max wait for the real player to paint a frame before handing off anyway
  const MAX_QUALITY = 'hd1080'; // highest quality we ask the preview to switch to

  const QUALITY_ORDER = ['highres', 'hd2880', 'hd2160', 'hd1440', 'hd1080', 'hd720', 'large', 'medium', 'small', 'tiny'];
  const VIDEO_CSS = 'position:absolute;inset:0;width:100%;height:100%;object-fit:contain;';

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
    const isSrc = (n) => String(n).toLowerCase() === 'src';
    v.pause = noop;
    v.load = noop;
    v.removeAttribute = function (n) {
      if (isSrc(n)) return;
      return Element.prototype.removeAttribute.call(this, n);
    };
    v.setAttribute = function (n, val) {
      if (isSrc(n)) return;
      return Element.prototype.setAttribute.call(this, n, val);
    };
    for (const [k, desc] of GUARDED) {
      Object.defineProperty(v, k, {
        configurable: true,
        get() { return desc.get.call(this); },
        set() {},
      });
    }
  }

  function unguard(v) {
    for (const k of ['pause', 'load', 'removeAttribute', 'setAttribute', ...GUARDED.map(([k]) => k)]) delete v[k];
  }

  // The preview is a small YouTube player; ask it for a sharper stream now that
  // it's about to be shown big.
  function previewApi(v) {
    const pp = v.closest('.html5-video-player');
    if (pp?.getAvailableQualityLevels) return pp;
    return v.closest('ytd-player')?.getPlayer?.() || null;
  }

  function upgradeQuality(api) {
    try {
      const levels = api?.getAvailableQualityLevels?.() || [];
      const best = QUALITY_ORDER.slice(QUALITY_ORDER.indexOf(MAX_QUALITY)).find((q) => levels.includes(q));
      if (!best || best === api.getPlaybackQuality?.()) return;
      api.setPlaybackQualityRange?.(best, best);
      log('preview quality ->', best);
    } catch {}
  }

  // Save the current frame, so if YouTube tears the preview down we show a
  // still image instead of a black box.
  function snapshot(s) {
    const v = s.v;
    if (v.readyState < 2 || !v.videoWidth) return;
    const c = s.snap;
    if (c.width !== v.videoWidth || c.height !== v.videoHeight) {
      c.width = v.videoWidth;
      c.height = v.videoHeight;
    }
    try { c.getContext('2d').drawImage(v, 0, 0); } catch {}
  }

  function makePlayIcon() {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '40');
    svg.setAttribute('height', '40');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', 'M8 5v14l11-7z');
    path.setAttribute('fill', '#fff');
    svg.appendChild(path);
    const icon = document.createElement('div');
    Object.assign(icon.style, {
      position: 'absolute',
      left: '50%',
      top: '50%',
      width: '72px',
      height: '72px',
      transform: 'translate(-50%, -50%)',
      borderRadius: '50%',
      background: 'rgba(0, 0, 0, .55)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      opacity: '0',
      transition: 'opacity .15s',
      pointerEvents: 'none',
    });
    icon.appendChild(svg);
    return icon;
  }

  // ---------- lifecycle ----------

  function start(v) {
    cleanup(true);

    const api = previewApi(v); // before we move it out of the player
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
      cursor: 'pointer',
      transition: 'left .25s ease, top .25s ease, width .25s ease, height .25s ease, border-radius .25s ease',
    });

    const snap = document.createElement('canvas');
    snap.style.cssText = VIDEO_CSS + 'visibility:hidden;';
    const icon = makePlayIcon();

    const pl = mainPlayer();
    state = {
      v,
      box,
      snap,
      icon,
      api,
      home: { parent: v.parentNode, next: v.nextSibling, css: v.style.cssText },
      origMuted: MUTED.get.call(v),
      css: '',
      userPaused: false,
      lastSnap: 0,
      navigated: false,
      navAt: 0,
      placed: false,
      mutedMain: false,
      mainWasMuted: false,
      seekAt: 0,
      frameFor: null,
      frameOk: false,
      frameT0: 0,
      frameCT: 0,
      raf: 0,
      revertTimer: 0,
    };

    guard(v);
    // A synchronous remove+insert doesn't trigger the "paused because removed" rule,
    // so the video keeps playing through the move.
    box.appendChild(v);
    box.appendChild(snap); // above the video, only shown when the video drops out
    box.appendChild(icon);
    document.body.appendChild(box);
    v.style.cssText = VIDEO_CSS;
    state.css = v.style.cssText;
    snapshot(state);

    // We're inside a click, so unmuted playback is allowed.
    if (pl && pl.isMuted && !pl.isMuted()) {
      VOL.set.call(v, Math.min(1, (pl.getVolume?.() ?? 100) / 100));
      MUTED.set.call(v, false);
    }
    P.play.call(v).catch(() => {});
    upgradeQuality(api);

    // Clicked something on the preview that didn't navigate (e.g. some overlay) -> give it back.
    state.revertTimer = setTimeout(() => {
      if (state && !state.navigated) cleanup(true);
    }, NAV_WINDOW_MS);

    log('started at', v.currentTime);
    state.raf = requestAnimationFrame(tick);
  }

  function togglePause() {
    const s = state;
    if (!s) return;
    s.userPaused = !s.userPaused;
    if (s.userPaused) P.pause.call(s.v);
    else P.play.call(s.v).catch(() => {});
    s.icon.style.opacity = s.userPaused ? '1' : '0';
    s.frameFor = null; // the real player has to show a frame in the new state first
    log(s.userPaused ? 'paused' : 'resumed');
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
    const s = state;
    const v = s.v;

    // YouTube's preview player keeps restyling "its" video; keep ours.
    if (v.style.cssText !== s.css) v.style.cssText = VIDEO_CSS;

    // Show the last saved frame whenever the video has nothing to show.
    const live = v.readyState >= 2 && v.videoWidth > 0;
    s.snap.style.visibility = live ? 'hidden' : 'visible';
    if (live && performance.now() - s.lastSnap > SNAP_MS) {
      s.lastSnap = performance.now();
      snapshot(s);
    }

    // Keep the preview in the play/pause state the user chose.
    if (s.userPaused && !v.paused) P.pause.call(v);
    else if (!s.userPaused && v.paused && live && !v.ended) P.play.call(v).catch(() => {});

    if (s.navigated) {
      if (performance.now() - s.navAt > GIVE_UP_MS) return cleanup();

      const pl = document.querySelector('ytd-watch-flexy:not([hidden]) #movie_player');
      if (pl) {
        const r = pl.getBoundingClientRect();
        if (r.width > 100 && r.height > 50) place(r);
      }
      if (tryHandoff()) return;
    }

    s.raf = requestAnimationFrame(tick);
  }

  // True once the real player has actually painted a frame at the current position,
  // so revealing it doesn't flash black.
  function frameShown(mv) {
    const s = state;
    if (s.frameFor !== mv) {
      s.frameFor = mv;
      s.frameOk = false;
      s.frameT0 = performance.now();
      s.frameCT = mv.currentTime;
      mv.requestVideoFrameCallback?.(() => {
        if (state === s && s.frameFor === mv) s.frameOk = true;
      });
    }
    if (s.frameOk) return true;
    if (performance.now() - s.frameT0 > FRAME_WAIT_MS) return true;
    if (!mv.requestVideoFrameCallback) {
      return s.userPaused ? performance.now() - s.frameT0 > 150 : mv.currentTime !== s.frameCT;
    }
    return false;
  }

  // Returns true once the handoff is done.
  function tryHandoff() {
    if (!isWatch()) return false;
    const s = state;
    const pl = mainPlayer();
    const mv = pl?.querySelector('video.html5-main-video');
    if (!pl || !mv || mv === s.v) return false;

    // Keep the real player quiet so you don't get double audio during the gap.
    if (!s.mutedMain && pl.mute) {
      s.mainWasMuted = !!pl.isMuted?.();
      pl.mute();
      s.mutedMain = true;
    }
    // Paused on the preview -> keep the real player paused too.
    if (s.userPaused && !mv.paused) pl.pauseVideo?.();

    if (pl.classList.contains('ad-showing')) return false;
    if (mv.readyState < (s.userPaused ? 2 : 3)) return false;

    const target = s.v.currentTime;

    if (Math.abs(mv.currentTime - target) > SYNC_TOLERANCE) {
      if (performance.now() - s.seekAt > 1200) {
        log('seeking main to', target);
        pl.seekTo(target + (s.userPaused ? 0 : 0.15), true);
        s.seekAt = performance.now();
        s.frameFor = null;
      }
      return false;
    }

    if (!s.userPaused && mv.paused) {
      pl.playVideo?.();
      return false;
    }

    if (!frameShown(mv)) return false;

    log('handoff at', mv.currentTime, s.userPaused ? '(paused)' : '');
    finish();
    return true;
  }

  function finish() {
    const s = state;
    MUTED.set.call(s.v, true);
    if (s.mutedMain && !s.mainWasMuted) mainPlayer()?.unMute?.();
    s.mutedMain = false;
    s.box.style.pointerEvents = 'none'; // clicks go to the real player from here on
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

    // Click on our overlay = play/pause, like the real player.
    if (state && state.box.contains(e.target)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      togglePause();
      return;
    }

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

  // Space / K while the overlay is up = play/pause, like the real player.
  document.addEventListener('keydown', (e) => {
    if (!state || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key !== ' ' && e.key !== 'k' && e.key !== 'K') return;
    if (e.target.closest?.('input, textarea, [contenteditable=""], [contenteditable="true"]')) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    togglePause();
  }, true);

  document.addEventListener('yt-navigate-start', () => {
    if (pending) clearPending(); // navigated some other way, drop the wait
    if (!state) return;
    if (state.navigated) return cleanup(); // navigating somewhere else again
    state.navigated = true;
    state.navAt = performance.now();
    clearTimeout(state.revertTimer);
    upgradeQuality(state.api); // again, in case the levels weren't known yet at click time
  });

  document.addEventListener('yt-navigate-finish', () => {
    if (state && !isWatch()) cleanup();
  });

  window.addEventListener('popstate', () => cleanup());
})();
