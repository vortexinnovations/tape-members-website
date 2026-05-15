// Tape Runner — DOM HUD overlay.
//
// Why DOM and not Three.js sprites? The HUD is text-heavy + lives
// outside the 3D world. Plain CSS handles font rendering, layout,
// safe-area-inset, animations, and accessibility for free. The
// game canvas sits at z-index 0; HUD elements sit above with
// `pointer-events: none` so they never steal taps from the
// gesture handler.
//
// Mounting: HUD attaches itself as a sibling of the canvas inside
// `canvas.parentElement` (the page-level `<main>`, which is
// position:fixed; inset: 0). This means the page.tsx host doesn't
// need to know the HUD exists.
//
// Tear-down: `dispose()` removes the root + cancels any pending
// fade-out timers.

import type { PickupSpec } from './tuning';

export class HUD {
  private root: HTMLDivElement;
  private scoreEl: HTMLDivElement;
  private distEl: HTMLDivElement;
  /**
   * Top-left mute toggle. Hidden when the admin has SFX disabled
   * entirely. The icon flips between speaker / speaker-slash based
   * on the player's localStorage-persisted preference.
   *
   * Positioned at top-left (NOT top-right) because the Flutter
   * WebView wrapper overlays a close button at top-right on mobile.
   */
  private muteBtn: HTMLDivElement;
  /** Caller wires this so HUD button taps reach the AudioManager. */
  onMuteToggle?: () => void;
  /** Outer wrapper for the combo readout — owns the opacity +
   *  scale transition. Contains two child rows: the big multiplier
   *  pill and the small "N in a row" caption. */
  private comboEl: HTMLDivElement;
  private comboMultEl: HTMLDivElement;
  private comboCountEl: HTMLDivElement;
  /** Container for the buzz-meter cells. Stored so `setBuzzMaxLevel`
   *  can wipe and rebuild the cells when the admin reconfigures
   *  the max level. */
  private buzzWrap!: HTMLDivElement;
  private buzzCells: HTMLDivElement[] = [];
  /** Cached max-buzz value so setBuzz() knows when to engage the
   *  danger-zone pulse. Kept in sync with Buzz.getMaxLevel(). */
  private buzzMaxLevel = 5;
  private vignetteEl: HTMLDivElement;
  /**
   * Transparent overlay positioned above the canvas. Its
   * `backdrop-filter: blur(...)` is what produces the buzz blur
   * effect — applied to anything BEHIND the overlay, i.e. the
   * WebGL canvas. We use this instead of `filter: blur()` on the
   * canvas directly because iOS WKWebView silently drops CSS
   * filters on WebGL canvases (compositor doesn't run them
   * through the filter pipeline). backdrop-filter ships with the
   * same iOS support story as the existing buzz-meter chip, so
   * it Just Works on the platforms we care about.
   */
  private blurOverlayEl: HTMLDivElement;
  /**
   * Pre-game tutorial overlay: three animated arrows (← ↑ →) and
   * a "SWIPE TO START" label. Visible at game-start; fades out the
   * moment the player's first swipe lands.
   */
  private inputHintEl: HTMLDivElement;
  /** Container for transient pickup-flash notifications. Each
   *  flashPickup() call spawns a new child element that animates
   *  in, drifts down, and removes itself. Multiple can coexist
   *  if pickups land in quick succession. */
  private flashContainer: HTMLDivElement;
  /** Thin horizontal bar above the buzz meter — width drains as
   *  the combo window expires. Driven by setComboProgress(0..1). */
  private comboBarWrap: HTMLDivElement;
  private comboBarFill: HTMLDivElement;
  private comboFadeTimer: number | null = null;
  // Cached values for the combined subline ("1234m · 12 m/s"). We
  // accept distance + speed via separate setters but render them
  // together so the HUD only mutates one DOM node.
  private subDistance = 0;
  private subSpeed = 0;

  constructor(canvas: HTMLCanvasElement) {
    const parent = canvas.parentElement ?? document.body;

    // Inject the keyframes for the danger-zone buzz pulse + the
    // input-hint arrows once. Idempotent — multiple HUDs in quick
    // succession (e.g. play again → new HUD) won't duplicate.
    if (!document.getElementById('tape-runner-hud-keyframes')) {
      const style = document.createElement('style');
      style.id = 'tape-runner-hud-keyframes';
      style.textContent = `
        @keyframes tapeRunnerBuzzPulse {
          0%, 100% { transform: scale(1.0); filter: brightness(1.0); }
          50% { transform: scale(1.12); filter: brightness(1.4); }
        }
        @keyframes tapeRunnerHintLeft {
          0%, 100% { transform: translateX(0); opacity: 0.55; }
          50% { transform: translateX(-14px); opacity: 1.0; }
        }
        @keyframes tapeRunnerHintRight {
          0%, 100% { transform: translateX(0); opacity: 0.55; }
          50% { transform: translateX(14px); opacity: 1.0; }
        }
        @keyframes tapeRunnerHintUp {
          0%, 100% { transform: translateY(0); opacity: 0.55; }
          50% { transform: translateY(-14px); opacity: 1.0; }
        }
        @keyframes tapeRunnerHintLabel {
          0%, 100% { opacity: 0.7; }
          50% { opacity: 1.0; }
        }
        @keyframes tapeRunnerSpin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
        @keyframes tapeRunnerFlash {
          0% {
            opacity: 0;
            transform: translate(-50%, -50%) scale(0.6);
          }
          12% {
            opacity: 1;
            transform: translate(-50%, -50%) scale(1.08);
          }
          22% {
            transform: translate(-50%, -50%) scale(1.0);
          }
          100% {
            opacity: 0;
            transform: translate(-50%, calc(-50% + 60px)) scale(0.95);
          }
        }
        @keyframes tapeRunnerFlashBonus {
          0% {
            opacity: 0;
            transform: translate(-50%, -50%) scale(0.5);
          }
          10% {
            opacity: 1;
            transform: translate(-50%, -50%) scale(1.35);
          }
          18% {
            transform: translate(-50%, -50%) scale(1.18);
          }
          26% {
            transform: translate(-50%, -50%) scale(1.28);
          }
          100% {
            opacity: 0;
            transform: translate(-50%, calc(-50% + 90px)) scale(1.05);
          }
        }
      `;
      document.head.appendChild(style);
    }

    this.root = document.createElement('div');
    Object.assign(this.root.style, {
      position: 'absolute',
      inset: '0',
      pointerEvents: 'none',
      // System font stack — same look as Apple platform UI,
      // cheap. We can swap for a webfont (Outfit, to match the
      // app) in a polish pass.
      fontFamily:
        '-apple-system, "SF Pro Display", "Segoe UI", Roboto, sans-serif',
      color: '#fff',
      // Honour iOS notch / Dynamic Island insets.
      paddingTop: 'max(env(safe-area-inset-top), 16px)',
      paddingLeft: 'max(env(safe-area-inset-left), 16px)',
      paddingRight: 'max(env(safe-area-inset-right), 16px)',
      paddingBottom: 'max(env(safe-area-inset-bottom), 16px)',
      boxSizing: 'border-box',
      userSelect: 'none',
      webkitUserSelect: 'none',
    } satisfies Partial<CSSStyleDeclaration>);

    // ── Top row — just the score column, centred ──
    // (Buzz meter + combo chip have both moved to bottom-centre,
    // grouped together below the running character so the player
    // doesn't need to look away from the action to read either.)
    const topRow = document.createElement('div');
    Object.assign(topRow.style, {
      display: 'flex',
      justifyContent: 'center',
      alignItems: 'flex-start',
    });
    this.root.appendChild(topRow);

    // Buzz meter — horizontal pill, positioned absolutely at the
    // BOTTOM of the screen. The cells are generated dynamically by
    // `rebuildBuzzCells` so the count tracks the admin-configured
    // maxTipsyLevel.
    //
    // Stack order (bottom to top): buzz meter → combo timer bar →
    // combo chip (×N + N IN A ROW) → flash text. This puts the
    // permanent buzz reference at the bottom and clusters all the
    // combo info as a single "what just happened → multiplier →
    // streak → time left" reading column above it.
    this.buzzWrap = document.createElement('div');
    Object.assign(this.buzzWrap.style, {
      position: 'absolute',
      left: '50%',
      // Bottom-most HUD element (after the score column, which lives
      // in the top row). Sits 30 px above safe-area so it doesn't
      // collide with the home-bar gesture area on iPhones.
      bottom: 'calc(env(safe-area-inset-bottom, 0px) + 30px)',
      transform: 'translateX(-50%)',
      display: 'flex',
      // Cell gap + padding scaled 20% from the original 4 / 6 / 8.
      // Combo bar's width-sync math (in rebuildBuzzCells) mirrors
      // these numbers — if you change them here, change them there.
      gap: '5px',
      padding: '7px 10px',
      borderRadius: '999px',
      background: 'rgba(0, 0, 0, 0.35)',
      backdropFilter: 'blur(8px)',
    } satisfies Partial<CSSStyleDeclaration>);
    // -webkit- prefix for older iOS Safari (< 18). Set via
    // setProperty since CSSStyleDeclaration doesn't expose the
    // vendor-prefixed key on its typed surface.
    this.buzzWrap.style.setProperty('-webkit-backdrop-filter', 'blur(8px)');
    // Build the cells via the dedicated helper so we can rebuild
    // them when the admin changes `maxTipsyLevel` mid-session.
    this.rebuildBuzzCells(this.buzzMaxLevel);
    // Buzz meter is absolutely positioned at the bottom of the
    // screen (see styles above), so we append it to the HUD root
    // rather than the top row.
    this.root.appendChild(this.buzzWrap);

    // Score column (centre) — wrapped in a soft dark halo so the
    // numbers stay readable against busy 3D content (ceiling lights,
    // bright walls, neon signs etc). The radial-gradient backdrop
    // fades fully to transparent at the edges so it doesn't feel
    // like a hard pill — just a darkened spot behind the text.
    const scoreCol = document.createElement('div');
    Object.assign(scoreCol.style, {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: '4px',
      padding: '14px 32px',
      background:
        'radial-gradient(ellipse at center, rgba(0,0,0,0.60) 0%, rgba(0,0,0,0.38) 50%, rgba(0,0,0,0) 85%)',
    } satisfies Partial<CSSStyleDeclaration>);
    this.scoreEl = document.createElement('div');
    Object.assign(this.scoreEl.style, {
      fontSize: '38px',
      fontWeight: '800',
      letterSpacing: '0.5px',
      fontVariantNumeric: 'tabular-nums',
      lineHeight: '1',
      // Slightly stronger shadow to give the score weight without
      // outlining it — pairs with the radial backdrop for clarity.
      textShadow: '0 2px 10px rgba(0, 0, 0, 0.75)',
    } satisfies Partial<CSSStyleDeclaration>);
    this.scoreEl.textContent = '0';
    scoreCol.appendChild(this.scoreEl);
    this.distEl = document.createElement('div');
    Object.assign(this.distEl.style, {
      fontSize: '13px',
      fontWeight: '700',
      letterSpacing: '1.5px',
      textTransform: 'uppercase',
      // Lifted from 0.55 → 0.88: the M / M/S units used to read as
      // mid-grey, now sit much closer to white while still feeling
      // secondary to the headline score above.
      opacity: '0.88',
      fontVariantNumeric: 'tabular-nums',
      textShadow: '0 1px 4px rgba(0, 0, 0, 0.7)',
    } satisfies Partial<CSSStyleDeclaration>);
    this.distEl.textContent = '0m · 0 m/s';
    scoreCol.appendChild(this.distEl);
    topRow.appendChild(scoreCol);

    // (No spacer / no right-side element in the top row anymore —
    // the buzz meter and combo chip both live at the bottom now,
    // so the top row is purely the centred score column.)

    // ── Mute button (top-left) ──────────────────────────────────
    // Absolutely positioned at top-left of the HUD root, respecting
    // the safe-area inset. NOT top-right because the Flutter
    // WebView wraps a close button there on mobile. Size 40 px so
    // it meets Apple's 44 pt touch-target guideline once the 4 px
    // visual padding is accounted for.
    this.muteBtn = document.createElement('div');
    Object.assign(this.muteBtn.style, {
      position: 'absolute',
      top: 'max(env(safe-area-inset-top), 16px)',
      left: 'max(env(safe-area-inset-left), 16px)',
      width: '40px',
      height: '40px',
      borderRadius: '20px',
      background: 'rgba(0, 0, 0, 0.4)',
      backdropFilter: 'blur(10px)',
      display: 'none', // hidden by default; setMuteVisible flips it on
      alignItems: 'center',
      justifyContent: 'center',
      pointerEvents: 'auto',
      cursor: 'pointer',
      // Stack above other overlays so taps don't miss it. Below the
      // pickup-name flash (which is at z-index 10).
      zIndex: '5',
      transition: 'background 0.15s ease',
    } satisfies Partial<CSSStyleDeclaration>);
    this.muteBtn.style.setProperty(
      '-webkit-backdrop-filter',
      'blur(10px)',
    );
    // Default to "unmuted" icon — wireSetMuted updates it once the
    // AudioManager has loaded its localStorage preference.
    this.muteBtn.innerHTML = this._speakerSvg(false);
    this.muteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.onMuteToggle?.();
    });
    this.root.appendChild(this.muteBtn);

    // Combo readout — absolutely positioned below the character so
    // it's right in the player's field of view during gameplay,
    // not tucked away in the corner. Hidden until combo >= 2.
    // Sits BELOW the buzz bar so the multiplier text stays close
    // to the bottom edge.
    //
    // Two-row layout:
    //   ┌───────┐
    //   │  ×1.5 │  ← big bold gold multiplier
    //   │ 4 in a row │  ← small caption underneath
    //   └───────┘
    //
    // Earlier inline form "×1.5 ·4" was confusing because the
    // interpunct read as multiplication ("1.5 × 4 = 6").
    this.comboEl = document.createElement('div');
    Object.assign(this.comboEl.style, {
      position: 'absolute',
      left: '50%',
      // Combo chip sits ABOVE the combo timer bar in the new stack
      // (buzz at 30 → combo bar at 82 → chip at 112 → flash text
      // at 250). Keeps the multiplier + "N IN A ROW" caption
      // grouped with the bar so the chip explains what the bar is
      // counting down.
      bottom: 'calc(env(safe-area-inset-bottom, 0px) + 112px)',
      transform: 'translateX(-50%) scale(0.85)',
      transformOrigin: 'center center',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: '2px',
      opacity: '0',
      transition: 'opacity 0.2s ease, transform 0.25s ease',
      whiteSpace: 'nowrap',
      zIndex: '4',
    } satisfies Partial<CSSStyleDeclaration>);

    // Big multiplier — the most important info, so it gets the
    // full visual weight: 30 px Outfit-900 gold with a glow.
    this.comboMultEl = document.createElement('div');
    Object.assign(this.comboMultEl.style, {
      fontSize: '30px',
      fontWeight: '900',
      letterSpacing: '0.5px',
      fontVariantNumeric: 'tabular-nums',
      lineHeight: '1',
      color: '#ffd45a',
      textShadow:
        '0 0 18px rgba(255, 212, 90, 0.65), 0 2px 8px rgba(0, 0, 0, 0.85)',
    } satisfies Partial<CSSStyleDeclaration>);
    this.comboMultEl.textContent = '';
    this.comboEl.appendChild(this.comboMultEl);

    // Caption — small, faint, all-caps. Tells the player how many
    // bottles are in the current chain. Slight letterSpacing for
    // legibility at this size.
    this.comboCountEl = document.createElement('div');
    Object.assign(this.comboCountEl.style, {
      fontSize: '11px',
      fontWeight: '700',
      letterSpacing: '1.5px',
      textTransform: 'uppercase',
      fontVariantNumeric: 'tabular-nums',
      color: 'rgba(255, 255, 255, 0.7)',
      textShadow: '0 1px 4px rgba(0, 0, 0, 0.7)',
    } satisfies Partial<CSSStyleDeclaration>);
    this.comboCountEl.textContent = '';
    this.comboEl.appendChild(this.comboCountEl);

    this.root.appendChild(this.comboEl);

    // ── Full-screen vignette ─────────────────────────────────────
    // Radial gradient mounted at the bottom of the stack so the
    // top-row HUD remains crisp. Opacity is driven by buzz level.
    // Plain alpha overlay — no `mix-blend-mode` (which can be
    // suppressed on the WebGL compositing layer in iOS WKWebView).
    // Alpha values are tuned so the vignette is clearly visible at
    // full strength without the multiply blend.
    this.vignetteEl = document.createElement('div');
    Object.assign(this.vignetteEl.style, {
      position: 'absolute',
      inset: '0',
      pointerEvents: 'none',
      background:
        'radial-gradient(ellipse at center, transparent 28%, rgba(45, 0, 25, 0.75) 75%, rgba(0, 0, 0, 0.95) 100%)',
      opacity: '0',
      transition: 'opacity 0.4s ease',
    } satisfies Partial<CSSStyleDeclaration>);

    // ── Buzz blur overlay ────────────────────────────────────────
    // Sits ABOVE the canvas but BELOW the HUD chrome — its
    // backdrop-filter blurs the canvas (the only thing behind it)
    // without blurring HUD text on top. Default 0px = no blur.
    this.blurOverlayEl = document.createElement('div');
    Object.assign(this.blurOverlayEl.style, {
      position: 'absolute',
      inset: '0',
      pointerEvents: 'none',
      backdropFilter: 'blur(0px)',
      // 0.18s lag so the blur doesn't snap — feels more like the
      // player's vision adjusting than a digital effect.
      transition: 'backdrop-filter 0.18s ease',
    } satisfies Partial<CSSStyleDeclaration>);
    // -webkit- prefix for older iOS Safari (< 18). Set via
    // setProperty since CSSStyleDeclaration doesn't expose the
    // vendor-prefixed key on its typed surface.
    this.blurOverlayEl.style.setProperty(
      '-webkit-backdrop-filter',
      'blur(0px)',
    );
    this.blurOverlayEl.style.setProperty(
      'transition',
      '-webkit-backdrop-filter 0.18s ease, backdrop-filter 0.18s ease',
    );

    // Z-stack: canvas (z=0) → vignette (z=1) → blur overlay (z=2)
    // → HUD root (z=3). HUD stays crisp; the blur applies to
    // canvas + vignette together (the latter gives the blurred
    // periphery a darker, hazier look).
    this.vignetteEl.style.zIndex = '1';
    this.blurOverlayEl.style.zIndex = '2';
    this.root.style.zIndex = '3';
    parent.appendChild(this.vignetteEl);
    parent.appendChild(this.blurOverlayEl);

    // ── Transient pickup-flash container ─────────────────────────
    // Each pickup spawns a child div positioned absolutely at the
    // container's centre. Children own their own animation +
    // self-removal — the container exists so we have one DOM node
    // to append into, not many across the body.
    //
    // Anchored from the BOTTOM (above the combo timer bar which
    // lives at safe-area + 165 px) so the flash text always lands
    // just below the running player and just above the bar — a
    // less distracting spot than the previous middle-of-screen
    // position. 250 px gives ~85 px clearance over the bar, which
    // accommodates the bonus animation's full 90 px drift without
    // colliding with the bar at the end of the fade-out.
    this.flashContainer = document.createElement('div');
    Object.assign(this.flashContainer.style, {
      position: 'absolute',
      left: '50%',
      bottom: 'calc(env(safe-area-inset-bottom, 0px) + 250px)',
      // The children translate themselves with their own transform,
      // so the container is a simple anchor point.
      width: '0',
      height: '0',
      pointerEvents: 'none',
      zIndex: '5',
    } satisfies Partial<CSSStyleDeclaration>);
    this.root.appendChild(this.flashContainer);

    // ── Combo timer bar (sits between the buzz meter + combo chip) ─
    // Width drains from 100% → 0% as the combo window expires.
    // Hidden when there's no active combo. Width matches the buzz
    // pill (synced in `rebuildBuzzCells` since the buzz pill's
    // width depends on the admin-set max-tipsy-level).
    this.comboBarWrap = document.createElement('div');
    Object.assign(this.comboBarWrap.style, {
      position: 'absolute',
      left: '50%',
      // Buzz pill bottom = 30 px, height ≈ 38 px (24 cell + 14
      // padding) → buzz top at ~68 px. 82 px gives a ~14 px gap,
      // mirroring the spacing between the chip and the bar above.
      bottom: 'calc(env(safe-area-inset-bottom, 0px) + 82px)',
      transform: 'translateX(-50%)',
      // Width is overwritten by `rebuildBuzzCells()` once the
      // buzz pill has been laid out. The default here is a safe
      // fallback for the rAF gap before the first sync.
      width: '125px',
      height: '5px',
      borderRadius: '999px',
      background: 'rgba(0, 0, 0, 0.4)',
      overflow: 'hidden',
      opacity: '0',
      transition: 'opacity 0.18s ease',
      zIndex: '4',
    } satisfies Partial<CSSStyleDeclaration>);
    this.comboBarFill = document.createElement('div');
    Object.assign(this.comboBarFill.style, {
      width: '100%',
      height: '100%',
      background:
        'linear-gradient(90deg, #ffd45a 0%, #ffaa3a 60%, #ff6b3a 100%)',
      borderRadius: '999px',
      transformOrigin: 'left center',
      transform: 'scaleX(1)',
      // No transition — width is driven each frame from game.ts,
      // CSS easing would lag behind the real timer.
    } satisfies Partial<CSSStyleDeclaration>);
    this.comboBarWrap.appendChild(this.comboBarFill);
    this.root.appendChild(this.comboBarWrap);

    // First buzz-cells build happened before comboBarWrap existed,
    // so the width-sync inside rebuildBuzzCells was skipped. Run
    // it again now that both exist — subsequent admin-driven
    // setBuzzMaxLevel calls hit the sync directly.
    this.rebuildBuzzCells(this.buzzMaxLevel);

    parent.appendChild(this.root);

    // ── Input-hint overlay (pre-game tutorial) ───────────────────
    // Three pulsing arrows (← ↑ →) above a "SWIPE TO START" label,
    // centred on screen. Z-index above the buzz overlay AND the HUD
    // chrome so it sits on top of everything during the wait state.
    // RunnerGame calls hideInputHint() on the player's first swipe.
    this.inputHintEl = document.createElement('div');
    Object.assign(this.inputHintEl.style, {
      position: 'absolute',
      inset: '0',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      pointerEvents: 'none',
      // Don't block the gesture handler on the canvas.
      gap: '24px',
      // Fade — we toggle opacity in show/hide.
      opacity: '1',
      transition: 'opacity 0.32s ease',
      zIndex: '5',
      // Soften the runway scene behind the hint a touch so the text
      // is readable on top of moving lights.
      background:
        'radial-gradient(ellipse at center, rgba(0,0,0,0.50) 0%, rgba(0,0,0,0.25) 50%, transparent 80%)',
      userSelect: 'none',
      webkitUserSelect: 'none',
    } satisfies Partial<CSSStyleDeclaration>);
    // Arrow row.
    const arrowRow = document.createElement('div');
    Object.assign(arrowRow.style, {
      display: 'flex',
      gap: '48px',
      alignItems: 'center',
    });
    const makeArrow = (
      glyph: string,
      keyframeName: string,
      label: string,
      /** Pixels to translate the wrap upward. Used to elevate the
       *  JUMP arrow so the hint reads spatially as ←  ↑  → instead
       *  of three horizontal arrows in a flat row. */
      liftY = 0,
    ): HTMLDivElement => {
      const wrap = document.createElement('div');
      Object.assign(wrap.style, {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '6px',
        transform: liftY > 0 ? `translateY(-${liftY}px)` : 'none',
      });
      const arrow = document.createElement('div');
      arrow.textContent = glyph;
      Object.assign(arrow.style, {
        fontSize: '52px',
        lineHeight: '1',
        color: '#fff',
        textShadow: '0 2px 12px rgba(0, 0, 0, 0.85)',
        animation: `${keyframeName} 1.2s ease-in-out infinite`,
      });
      const sub = document.createElement('div');
      sub.textContent = label;
      Object.assign(sub.style, {
        fontSize: '10px',
        fontWeight: '700',
        letterSpacing: '1.6px',
        color: 'rgba(255, 255, 255, 0.7)',
        textShadow: '0 1px 4px rgba(0, 0, 0, 0.8)',
      });
      wrap.appendChild(arrow);
      wrap.appendChild(sub);
      return wrap;
    };
    arrowRow.appendChild(makeArrow('←', 'tapeRunnerHintLeft', 'DODGE'));
    // JUMP sits ~28px above the dodge arrows so the three glyphs
    // form a spatial cross-pattern instead of a flat row.
    arrowRow.appendChild(makeArrow('↑', 'tapeRunnerHintUp', 'JUMP', 28));
    arrowRow.appendChild(makeArrow('→', 'tapeRunnerHintRight', 'DODGE'));
    this.inputHintEl.appendChild(arrowRow);
    this.hintArrowRow = arrowRow;

    const startLabel = document.createElement('div');
    startLabel.textContent = 'SWIPE TO START';
    Object.assign(startLabel.style, {
      fontSize: '16px',
      fontWeight: '800',
      letterSpacing: '3.5px',
      color: '#fff',
      textShadow: '0 2px 10px rgba(0, 0, 0, 0.9)',
      animation: 'tapeRunnerHintLabel 1.6s ease-in-out infinite',
    });
    this.inputHintEl.appendChild(startLabel);
    this.hintStartLabel = startLabel;

    // ── Loading state — shown until all heavy assets (player FBX
    // + jump character + bouncer + initial pre-warm) are ready.
    // Sits inside the same overlay so we don't fight z-index with
    // the "swipe to start" hint; we toggle visibility on each.
    const loadingWrap = document.createElement('div');
    Object.assign(loadingWrap.style, {
      display: 'none',
      flexDirection: 'column',
      alignItems: 'center',
      gap: '20px',
    });
    const spinner = document.createElement('div');
    Object.assign(spinner.style, {
      width: '54px',
      height: '54px',
      borderRadius: '50%',
      border: '4px solid rgba(255, 255, 255, 0.18)',
      borderTopColor: '#fff',
      animation: 'tapeRunnerSpin 0.9s linear infinite',
    });
    loadingWrap.appendChild(spinner);
    const loadingLabel = document.createElement('div');
    loadingLabel.textContent = 'LOADING…';
    Object.assign(loadingLabel.style, {
      fontSize: '15px',
      fontWeight: '800',
      letterSpacing: '3.5px',
      color: '#fff',
      textShadow: '0 2px 10px rgba(0, 0, 0, 0.9)',
    });
    loadingWrap.appendChild(loadingLabel);
    this.inputHintEl.appendChild(loadingWrap);
    this.hintLoadingWrap = loadingWrap;

    parent.appendChild(this.inputHintEl);
  }

  /** Switch the overlay between "Loading…" and the swipe-to-start
   *  hint. RunnerGame flips this once the player FBX + jump
   *  character are both loaded and the GPU pre-warm pipeline has
   *  run. While loading is true the input handler should also
   *  ignore taps/swipes.
   *
   *  Note: when un-loading, we EXPLICITLY restore each element's
   *  original `display` value rather than blanking the inline
   *  property. Setting `style.display = ''` falls through to the
   *  element's CSS default (`block` for divs), which would clobber
   *  the inline `display: flex` we set on the arrow row at
   *  construction — breaking the horizontal arrow layout. */
  setLoading(loading: boolean) {
    if (loading) {
      this.hintArrowRow.style.display = 'none';
      this.hintStartLabel.style.display = 'none';
      this.hintLoadingWrap.style.display = 'flex';
      this.inputHintEl.style.opacity = '1';
    } else {
      this.hintLoadingWrap.style.display = 'none';
      this.hintArrowRow.style.display = 'flex'; // restores horizontal arrow row
      this.hintStartLabel.style.display = 'block';
    }
  }

  private hintArrowRow!: HTMLDivElement;
  private hintStartLabel!: HTMLDivElement;
  private hintLoadingWrap!: HTMLDivElement;

  /**
   * Hide the pre-game tutorial overlay. Called by RunnerGame the
   * moment the player's first swipe/jump lands. Fades out via CSS
   * transition; the DOM node is left in place so subsequent runs
   * (after game over) can show the hint again via `showInputHint`.
   */
  hideInputHint() {
    this.inputHintEl.style.opacity = '0';
  }

  /**
   * Show the pre-game tutorial overlay. Called when a new run starts
   * (game restart) so the player gets the affordance again.
   */
  showInputHint() {
    this.inputHintEl.style.opacity = '1';
  }

  setScore(n: number) {
    this.scoreEl.textContent = formatInt(n);
  }

  setDistance(n: number) {
    this.subDistance = n;
    this.renderSubline();
  }

  /** Current m/s — surfaces in the score-column subline alongside
   *  distance ("1234m · 12 m/s"). */
  setSpeed(mps: number) {
    this.subSpeed = mps;
    this.renderSubline();
  }

  private renderSubline() {
    this.distEl.textContent =
      `${formatInt(this.subDistance)}m · ${this.subSpeed.toFixed(0)} m/s`;
  }

  setBuzz(level: number) {
    // Fill cells 0..(level-1). At max-buzz (all cells filled) the
    // whole meter pulses red — that's the "one more bottle and you
    // blackout" state. One level below max, the last filled cell
    // glows softly as a "you're close" warning.
    const max = this.buzzMaxLevel;
    const atMax = level >= max;
    const oneBelowMax = level === max - 1;
    const total = this.buzzCells.length;
    for (let i = 0; i < total; i++) {
      const cell = this.buzzCells[i];
      if (i < level) {
        cell.style.background = colorForCell(i, total);
        if (atMax) {
          // Pulse the whole bar at danger zone.
          cell.style.boxShadow = '0 0 10px rgba(255, 60, 60, 0.95)';
          cell.style.animation =
            'tapeRunnerBuzzPulse 0.55s ease-in-out infinite';
        } else if (oneBelowMax && i === level - 1) {
          // Last cell glows softly — "you're close."
          cell.style.boxShadow = '0 0 8px rgba(255, 80, 80, 0.8)';
          cell.style.animation = 'none';
        } else {
          cell.style.boxShadow = 'none';
          cell.style.animation = 'none';
        }
      } else {
        cell.style.background = 'rgba(255, 255, 255, 0.12)';
        cell.style.boxShadow = 'none';
        cell.style.animation = 'none';
      }
    }
  }

  /**
   * Tear down + rebuild the buzz-meter cells for a new max-level.
   * Called from `setBuzzMaxLevel` whenever the admin changes the
   * `maxTipsyLevel` setting, and once during HUD construction.
   */
  private rebuildBuzzCells(n: number) {
    for (const c of this.buzzCells) c.remove();
    this.buzzCells = [];
    // Narrow the per-cell width as the count grows so the whole
    // pill stays roughly the same total width on phones. Floor at
    // 10px so cells are still tappable-ish at extreme counts. Base
    // numbers are 20% larger than the original 70 / 8-14 cap (the
    // whole buzz pill grew by 20% per design).
    const cellWidth = Math.max(10, Math.min(17, Math.round(84 / n)));
    for (let i = 0; i < n; i++) {
      const cell = document.createElement('div');
      Object.assign(cell.style, {
        width: `${cellWidth}px`,
        height: '24px',
        borderRadius: '5px',
        background: 'rgba(255, 255, 255, 0.12)',
        transition: 'background 0.2s ease',
      } satisfies Partial<CSSStyleDeclaration>);
      this.buzzWrap.appendChild(cell);
      this.buzzCells.push(cell);
    }
    // Keep the combo timer bar's width in lock-step with the buzz
    // pill so the two read as a single stacked block. Width is the
    // sum of cells + inter-cell gaps (5 px) + the pill's left/right
    // padding (10 px each side, 20 total). Doing this mathematically
    // avoids a getBoundingClientRect() round-trip during construction
    // (the wrap isn't in the DOM yet on the first call).
    //
    // Guard: the first rebuildBuzzCells() call fires during HUD
    // construction BEFORE comboBarWrap is created. We sync the
    // width again right after that wrap is built, so missing it on
    // the very first call is fine.
    if (this.comboBarWrap) {
      const cellsW = cellWidth * n;
      const gapsW = Math.max(0, n - 1) * 5;
      const paddingW = 20;
      this.comboBarWrap.style.width = `${cellsW + gapsW + paddingW}px`;
    }
  }

  /**
   * Reconfigure the buzz meter for a new max-level. Idempotent —
   * no-op if the requested count matches what's already on screen.
   */
  setBuzzMaxLevel(n: number) {
    if (!Number.isFinite(n)) return;
    const intN = Math.max(2, Math.min(20, Math.floor(n)));
    if (intN === this.buzzMaxLevel && this.buzzCells.length === intN) return;
    this.buzzMaxLevel = intN;
    this.rebuildBuzzCells(intN);
  }

  setCombo(combo: number, multiplier: number) {
    // Hide until there's an active multiplier worth surfacing.
    // With admin-tunable thresholds the old `combo < 2` magic
    // number stopped being correct — e.g. an admin who sets
    // tier-2 threshold = 1 wants the chip on the first bottle.
    // Multiplier > 1.0 is the semantic ground truth.
    if (multiplier <= 1.0 + 1e-6) {
      this.comboEl.style.opacity = '0';
      this.comboEl.style.transform = 'translateX(-50%) scale(0.85)';
      // Combo timer bar is only meaningful when a multiplier is
      // active — hide it whenever the multiplier drops to ×1.
      this.comboBarWrap.style.opacity = '0';
      this.comboBarFill.style.transform = 'scaleX(0)';
      return;
    }
    // Big multiplier — show one decimal place only if non-integer
    // (×2 not ×2.0; ×1.5 not ×1.5).
    const multText = Number.isInteger(multiplier)
      ? multiplier.toString()
      : multiplier.toFixed(1);
    this.comboMultEl.textContent = `×${multText}`;
    // Caption underneath — natural English, unambiguous. "IN A ROW"
    // beats "COMBO" because the latter is jargon and "×4 ·4" was
    // confusing precisely because the second number had no label.
    this.comboCountEl.textContent =
      combo === 1 ? '1 IN A ROW' : `${combo} IN A ROW`;
    this.comboEl.style.opacity = '1';
    this.comboEl.style.transform = 'translateX(-50%) scale(1)';
    // Auto-fade if no new combo bump arrives soon. The timer is
    // reset every call.
    if (this.comboFadeTimer !== null) window.clearTimeout(this.comboFadeTimer);
    this.comboFadeTimer = window.setTimeout(() => {
      // Soft visual hint that the combo window is closing.
      this.comboEl.style.transform = 'translateX(-50%) scale(0.85)';
    }, 1600);
  }

  setVignette(intensity: number) {
    const clamped = Math.max(0, Math.min(1, intensity));
    this.vignetteEl.style.opacity = clamped.toFixed(2);
  }

  /**
   * Buzz blur amount in CSS pixels. Backed by `backdrop-filter`
   * on a transparent overlay so it works reliably on iOS WKWebView
   * (where `filter: blur()` on the WebGL canvas is dropped).
   */
  setBlur(px: number) {
    const clamped = Math.max(0, Math.min(10, px));
    const v = clamped > 0.01 ? `blur(${clamped.toFixed(2)}px)` : 'blur(0px)';
    this.blurOverlayEl.style.backdropFilter = v;
    this.blurOverlayEl.style.setProperty('-webkit-backdrop-filter', v);
  }

  /**
   * Briefly show "Champagne +50" (or similar) above the player.
   * Auto-fades. Multiple rapid pickups overwrite the text without
   * stacking — keeps the screen clean.
   */
  /**
   * Spawn a transient pickup-flash notification. Each call creates
   * a fresh DOM element that animates in (pop + scale), drifts
   * downward, fades out, and removes itself. Multiple flashes can
   * coexist — collecting two bottles in quick succession shows
   * both notifications, with the older one already drifting down
   * while the new one appears at centre.
   *
   * Bonus pickups (combo multiplier > 1) get a larger, flashier
   * variant of the animation — more aggressive scale-in, brighter
   * glow, and a longer drift.
   */
  flashPickup(
    spec: PickupSpec,
    displayScore: number,
    multiplier = 1.0,
    combo = 0,
  ) {
    const isBonus = multiplier > 1.0 + 1e-6;
    const isWater = spec.kind === 'water';
    const el = document.createElement('div');
    if (isWater) {
      el.textContent = 'Water -1 buzz';
    } else if (isBonus) {
      // Multiplier badge inline so the bonus reads as "what +
      // why", not just a bigger number.
      const multText = Number.isInteger(multiplier)
        ? multiplier.toString()
        : multiplier.toFixed(1);
      el.textContent = `${spec.label} +${displayScore} (×${multText})`;
    } else {
      el.textContent = `${spec.label} +${displayScore}`;
    }
    const color = isWater
      ? '#9cd6ff'
      : `#${spec.color.toString(16).padStart(6, '0')}`;
    // Font size scales progressively with the combo count so the
    // emphasis grows the longer the player chains pickups. Starts
    // just above the regular 22 px baseline at the first bonus tier
    // and tops out around 36 px at combo 28+. Avoids the old hard
    // jump from 22 → 34 px the moment a multiplier kicks in (felt
    // jarring even at ×2).
    let fontSize: string;
    if (isBonus) {
      const lifted = Math.max(0, combo);
      const px = Math.min(36, 22 + lifted * 0.5);
      fontSize = `${px.toFixed(1)}px`;
    } else {
      fontSize = '22px';
    }
    // Glow scales the same way — the brightest, double-stack glow is
    // reserved for high-combo bonuses, mid-combo bonuses get a single
    // softer glow, regular pickups stay subdued.
    const glow = isBonus
      ? combo >= 15
        ? `0 0 24px ${color}, 0 0 48px ${color}, 0 2px 14px rgba(0, 0, 0, 0.85)`
        : `0 0 16px ${color}, 0 2px 12px rgba(0, 0, 0, 0.78)`
      : '0 2px 12px rgba(0, 0, 0, 0.7)';
    const duration = isBonus ? '1500ms' : '1100ms';
    // The "bonus" animation has a larger scale punch — only use it for
    // higher-combo bonuses so the early ones don't feel oversized.
    const useBigAnim = isBonus && combo >= 10;
    const animation = useBigAnim
      ? `tapeRunnerFlashBonus ${duration} cubic-bezier(0.22, 0.8, 0.36, 1) forwards`
      : `tapeRunnerFlash ${duration} cubic-bezier(0.22, 0.8, 0.36, 1) forwards`;
    Object.assign(el.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      transform: 'translate(-50%, -50%) scale(0.6)',
      fontSize,
      fontWeight: '800',
      letterSpacing: '0.5px',
      color,
      textShadow: glow,
      // Keep on one line — 1000-point text was wrapping into two
      // rows on narrow screens even though there was room.
      whiteSpace: 'nowrap',
      opacity: '0',
      willChange: 'transform, opacity',
      animation,
    } satisfies Partial<CSSStyleDeclaration>);
    el.addEventListener('animationend', () => el.remove(), { once: true });
    this.flashContainer.appendChild(el);
  }

  /**
   * Drive the combo timer bar above the buzz meter.
   * `progress` is 0..1 where 1 = combo just started (full bar) and
   * 0 = combo window expired. Bar hides itself when progress ≤ 0,
   * shows itself when progress > 0.
   */
  setComboProgress(progress: number) {
    const clamped = Math.max(0, Math.min(1, progress));
    if (clamped <= 0) {
      this.comboBarWrap.style.opacity = '0';
      this.comboBarFill.style.transform = 'scaleX(0)';
      return;
    }
    this.comboBarWrap.style.opacity = '1';
    this.comboBarFill.style.transform = `scaleX(${clamped})`;
  }

  dispose() {
    if (this.comboFadeTimer !== null) window.clearTimeout(this.comboFadeTimer);
    this.root.remove();
    this.vignetteEl.remove();
    this.blurOverlayEl.remove();
    this.inputHintEl.remove();
  }

  /** Show or hide the top-left mute button. Hide when the admin
   *  has SFX entirely disabled — no point letting users toggle a
   *  feature that's off at the source. */
  setMuteVisible(visible: boolean): void {
    this.muteBtn.style.display = visible ? 'flex' : 'none';
  }

  /** Update the speaker icon to reflect the current mute state.
   *  Called when AudioManager.onMuteChanged fires (which happens
   *  on user toggle OR admin enabling/disabling). */
  setMuteIcon(muted: boolean): void {
    this.muteBtn.innerHTML = this._speakerSvg(muted);
  }

  /** Inline SVG for the speaker / speaker-slash icon. Stroke +
   *  fill use `currentColor` so the icon picks up the HUD text
   *  colour. 22 × 22 viewBox fits cleanly inside the 40 px circle
   *  with room to breathe. */
  private _speakerSvg(muted: boolean): string {
    if (muted) {
      // Speaker with a slash through it — muted state.
      return `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.85"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" stroke="none"/><line x1="22" y1="9" x2="16" y2="15"/><line x1="16" y1="9" x2="22" y2="15"/></svg>`;
    }
    // Speaker with two sound waves — unmuted.
    return `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" stroke="none"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>`;
  }
}

// ── Helpers ────────────────────────────────────────────────────────

function formatInt(n: number): string {
  return Math.max(0, Math.floor(n)).toLocaleString('en-US');
}

/**
 * Buzz-meter cell colour, computed by sampling a 5-anchor gradient
 * (pale green → yellow → orange → red-orange → hard red) at the
 * cell's relative position within the total cell count. With this
 * approach a 3-cell meter shows green / orange / red; a 10-cell
 * meter shows a smooth gradient with each step ~12% along the ramp.
 */
function colorForCell(i: number, total: number): string {
  const anchors: { r: number; g: number; b: number }[] = [
    { r: 0x8f, g: 0xe8, b: 0x8a }, // pale green
    { r: 0xe8, g: 0xe1, b: 0x6d }, // yellow
    { r: 0xf0, g: 0xa9, b: 0x57 }, // orange
    { r: 0xec, g: 0x6f, b: 0x5e }, // red-orange
    { r: 0xe8, g: 0x44, b: 0x3c }, // hard red
  ];
  const denom = total <= 1 ? 1 : total - 1;
  const t = Math.max(0, Math.min(1, i / denom));
  const pos = t * (anchors.length - 1);
  const lower = Math.floor(pos);
  const upper = Math.min(anchors.length - 1, lower + 1);
  const frac = pos - lower;
  const a = anchors[lower];
  const b = anchors[upper];
  const r = Math.round(a.r + (b.r - a.r) * frac);
  const g = Math.round(a.g + (b.g - a.g) * frac);
  const bl = Math.round(a.b + (b.b - a.b) * frac);
  return `rgb(${r}, ${g}, ${bl})`;
}
