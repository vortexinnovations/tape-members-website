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
  private comboEl: HTMLDivElement;
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
  private flashEl: HTMLDivElement;
  private flashTimer: number | null = null;
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
    // bottom of the screen just below the combo chip. The cells
    // are generated dynamically by `rebuildBuzzCells` so the count
    // tracks the admin-configured maxTipsyLevel.
    this.buzzWrap = document.createElement('div');
    Object.assign(this.buzzWrap.style, {
      position: 'absolute',
      left: '50%',
      // Below the combo chip (which sits at 100px above safe-area).
      // Buzz pill is ~32px tall, combo chip ~38px — gives ~10px gap.
      bottom: 'calc(env(safe-area-inset-bottom, 0px) + 50px)',
      transform: 'translateX(-50%)',
      display: 'flex',
      gap: '4px',
      padding: '6px 8px',
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

    // Score column (centre)
    const scoreCol = document.createElement('div');
    Object.assign(scoreCol.style, {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: '2px',
    });
    this.scoreEl = document.createElement('div');
    Object.assign(this.scoreEl.style, {
      fontSize: '32px',
      fontWeight: '800',
      letterSpacing: '0.5px',
      fontVariantNumeric: 'tabular-nums',
      lineHeight: '1',
      textShadow: '0 2px 8px rgba(0, 0, 0, 0.6)',
    } satisfies Partial<CSSStyleDeclaration>);
    this.scoreEl.textContent = '0';
    scoreCol.appendChild(this.scoreEl);
    this.distEl = document.createElement('div');
    Object.assign(this.distEl.style, {
      fontSize: '11px',
      fontWeight: '600',
      letterSpacing: '1.5px',
      textTransform: 'uppercase',
      opacity: '0.55',
      fontVariantNumeric: 'tabular-nums',
    } satisfies Partial<CSSStyleDeclaration>);
    this.distEl.textContent = '0m · 0 m/s';
    scoreCol.appendChild(this.distEl);
    topRow.appendChild(scoreCol);

    // (No spacer / no right-side element in the top row anymore —
    // the buzz meter and combo chip both live at the bottom now,
    // so the top row is purely the centred score column.)

    // Combo chip — absolutely positioned below the character so
    // it's right in the player's field of view during gameplay,
    // not tucked away in the corner. Hidden until combo >= 2.
    this.comboEl = document.createElement('div');
    Object.assign(this.comboEl.style, {
      position: 'absolute',
      left: '50%',
      // Sit above the system safe-area inset on phones. `calc` keeps
      // it ~110 px above the bottom edge regardless of device.
      bottom: 'calc(env(safe-area-inset-bottom, 0px) + 100px)',
      transform: 'translateX(-50%) scale(0.85)',
      transformOrigin: 'center center',
      fontSize: '30px',
      fontWeight: '900',
      letterSpacing: '0.5px',
      fontVariantNumeric: 'tabular-nums',
      color: '#ffd45a',
      textShadow:
        '0 0 18px rgba(255, 212, 90, 0.65), 0 2px 8px rgba(0, 0, 0, 0.85)',
      opacity: '0',
      transition: 'opacity 0.2s ease, transform 0.25s ease',
      whiteSpace: 'nowrap',
      zIndex: '4',
    } satisfies Partial<CSSStyleDeclaration>);
    this.comboEl.textContent = '';
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

    // ── Brief flash for pickup names (e.g. "Champagne +50") ──────
    this.flashEl = document.createElement('div');
    Object.assign(this.flashEl.style, {
      position: 'absolute',
      left: '50%',
      top: '54%',
      transform: 'translate(-50%, -50%)',
      fontSize: '22px',
      fontWeight: '800',
      letterSpacing: '0.5px',
      textShadow: '0 2px 12px rgba(0, 0, 0, 0.7)',
      opacity: '0',
      transition: 'opacity 0.18s ease, transform 0.6s ease',
    } satisfies Partial<CSSStyleDeclaration>);
    this.root.appendChild(this.flashEl);

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

    parent.appendChild(this.inputHintEl);
  }

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
    // 8px so cells are still tappable-ish at extreme counts.
    const cellWidth = Math.max(8, Math.min(14, Math.round(70 / n)));
    for (let i = 0; i < n; i++) {
      const cell = document.createElement('div');
      Object.assign(cell.style, {
        width: `${cellWidth}px`,
        height: '20px',
        borderRadius: '4px',
        background: 'rgba(255, 255, 255, 0.12)',
        transition: 'background 0.2s ease',
      } satisfies Partial<CSSStyleDeclaration>);
      this.buzzWrap.appendChild(cell);
      this.buzzCells.push(cell);
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
    if (combo < 2) {
      this.comboEl.style.opacity = '0';
      this.comboEl.style.transform = 'translateX(-50%) scale(0.85)';
      return;
    }
    this.comboEl.textContent = `×${multiplier.toFixed(multiplier < 2 ? 1 : 0)} ·${combo}`;
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
  flashPickup(spec: PickupSpec, displayScore: number) {
    if (spec.kind === 'water') {
      this.flashEl.textContent = `Water -1 buzz`;
      this.flashEl.style.color = '#9cd6ff';
    } else {
      this.flashEl.textContent = `${spec.label} +${displayScore}`;
      this.flashEl.style.color = `#${spec.color.toString(16).padStart(6, '0')}`;
    }
    this.flashEl.style.opacity = '1';
    this.flashEl.style.transform = 'translate(-50%, -70%)';
    if (this.flashTimer !== null) window.clearTimeout(this.flashTimer);
    this.flashTimer = window.setTimeout(() => {
      this.flashEl.style.opacity = '0';
      this.flashEl.style.transform = 'translate(-50%, -50%)';
    }, 650);
  }

  dispose() {
    if (this.flashTimer !== null) window.clearTimeout(this.flashTimer);
    if (this.comboFadeTimer !== null) window.clearTimeout(this.comboFadeTimer);
    this.root.remove();
    this.vignetteEl.remove();
    this.blurOverlayEl.remove();
    this.inputHintEl.remove();
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
