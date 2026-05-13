// Tape Runner — host page for the Three.js game.
//
// Loaded by the Flutter app via webview_flutter at
//   https://tapemembers.com/runner?embed=1
//
// `embed=1` is a hint that we're inside the Flutter WebView (vs.
// loaded directly in a browser tab for development). We use it
// to hide the cursor / show debug controls accordingly — but the
// game itself runs the same in both modes, so the page is
// testable standalone.
//
// Lifecycle:
//   1. Page mounts → canvas + RunnerGame instance created
//   2. We expose `window.tapeRunner` so Flutter can call .init()
//      with user data + admin settings
//   3. We post a `ready` message — Flutter waits for it before
//      sending `init`
//   4. Game loop runs until collision → posts `gameOver` back
//      with telemetry → Flutter writes to runnerScoreSubmissions
//      (same backend validator + leaderboard fan-out as the Flame
//      version, untouched)

'use client';

import { useEffect, useRef } from 'react';
import { RunnerGame } from './game/game';
import { postToFlutter, type InitPayload } from './game/bridge';
import { fetchRunnerSettings } from './game/settings';

export default function RunnerPage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Lock body to full-bleed game viewport. Counters any
    // global padding/margins the rest of the site might set.
    const prevHtml = {
      overflow: document.documentElement.style.overflow,
      margin: document.body.style.margin,
      padding: document.body.style.padding,
      touchAction: document.body.style.touchAction,
      overscroll: document.body.style.overscrollBehavior,
    };
    document.documentElement.style.overflow = 'hidden';
    document.body.style.margin = '0';
    document.body.style.padding = '0';
    document.body.style.touchAction = 'none';
    document.body.style.overscrollBehavior = 'none';

    const game = new RunnerGame(canvas);

    // Expose the bridge surface for Flutter to call.
    window.tapeRunner = {
      init: (payload: InitPayload) => game.init(payload),
      pause: () => game.pause(),
      resume: () => game.resume(),
      forceGameOver: () => game.forceGameOver(),
    };

    // Fetch admin tunables directly from the Cloud Function in
    // parallel with the rest of init. Decouples settings from the
    // Flutter release cycle — admins can tweak any value in
    // /runnerAdmin → Tuning and the next run picks it up, no app
    // rebuild needed. Also makes browser-only testing
    // (localhost:3000/runner, admin.tapemembers.com/runner in a
    // tab) work fully — no Flutter required.
    //
    // The game starts immediately with built-in defaults; when
    // this promise resolves it calls init() to overwrite them.
    // Failure (CORS / network / 500) is silent — fetchRunnerSettings
    // resolves to {} on any error, which leaves the defaults intact.
    //
    // Flutter (if present) calls init() independently with its own
    // payload. The two calls are idempotent per-field — last write
    // wins. In practice both sources read the same Firestore doc
    // so the result is identical.
    let cancelled = false;
    fetchRunnerSettings()
      .then((settings) => {
        if (cancelled) return;
        if (Object.keys(settings).length === 0) return;
        game.init({ settings });
      })
      .catch(() => {
        // fetchRunnerSettings never rejects, but TS doesn't know that
        // — keep the no-op catch so a future change can't accidentally
        // unhandle a rejection.
      });

    // Tell Flutter we're ready to receive init. Flutter waits on
    // this before pushing user settings — avoids a race where
    // settings arrive before the game class exists.
    postToFlutter({ type: 'ready', version: 2 });

    return () => {
      cancelled = true;
      game.dispose();
      delete window.tapeRunner;
      document.documentElement.style.overflow = prevHtml.overflow;
      document.body.style.margin = prevHtml.margin;
      document.body.style.padding = prevHtml.padding;
      document.body.style.touchAction = prevHtml.touchAction;
      document.body.style.overscrollBehavior = prevHtml.overscroll;
    };
  }, []);

  return (
    <main
      style={{
        position: 'fixed',
        inset: 0,
        background: '#070707',
        overflow: 'hidden',
        userSelect: 'none',
        WebkitUserSelect: 'none',
        WebkitTapHighlightColor: 'transparent',
      }}
    >
      <canvas
        ref={canvasRef}
        style={{
          width: '100%',
          height: '100%',
          display: 'block',
          touchAction: 'none',
        }}
      />
      <DevHud />
    </main>
  );
}

/**
 * Tiny dev-mode HUD with a "force game-over" button so we can test
 * the JS→Flutter bridge without actually dying. Removed once the
 * real game-over flow is wired in subsequent commits.
 *
 * Hidden when the URL has `?embed=1` (i.e. we're inside Flutter)
 * AND the host doesn't have `&dev=1` — admin can append `&dev=1`
 * to see the button even from inside the app for debugging.
 */
function DevHud() {
  const visible =
      typeof window === 'undefined'
          ? true
          : (() => {
              const sp = new URLSearchParams(window.location.search);
              return sp.get('embed') !== '1' || sp.get('dev') === '1';
            })();
  if (!visible) return null;
  return (
    <div
      style={{
        position: 'absolute',
        bottom: 16,
        right: 16,
        display: 'flex',
        gap: 8,
        zIndex: 10,
      }}
    >
      <button
        onClick={() => window.tapeRunner?.forceGameOver()}
        style={{
          background: '#b87333',
          color: '#fff',
          border: 'none',
          padding: '8px 14px',
          borderRadius: 8,
          fontSize: 12,
          fontWeight: 700,
          cursor: 'pointer',
        }}
      >
        END RUN (DEV)
      </button>
    </div>
  );
}
