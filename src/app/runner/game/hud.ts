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
  private buzzCells: HTMLDivElement[] = [];
  private vignetteEl: HTMLDivElement;
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

    // Inject the keyframes for the danger-zone buzz pulse once.
    // Idempotent — multiple HUDs in quick succession (e.g. play
    // again → new HUD) won't duplicate.
    if (!document.getElementById('tape-runner-hud-keyframes')) {
      const style = document.createElement('style');
      style.id = 'tape-runner-hud-keyframes';
      style.textContent = `
        @keyframes tapeRunnerBuzzPulse {
          0%, 100% { transform: scale(1.0); filter: brightness(1.0); }
          50% { transform: scale(1.12); filter: brightness(1.4); }
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

    // ── Top row — buzz meter (left) / score (centre) / combo (right) ──
    const topRow = document.createElement('div');
    Object.assign(topRow.style, {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'flex-start',
      gap: '12px',
    });
    this.root.appendChild(topRow);

    // Buzz meter — 5 vertical segments stacked into a horizontal pill.
    const buzzWrap = document.createElement('div');
    Object.assign(buzzWrap.style, {
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
    buzzWrap.style.setProperty('-webkit-backdrop-filter', 'blur(8px)');
    for (let i = 0; i < 5; i++) {
      const cell = document.createElement('div');
      Object.assign(cell.style, {
        width: '14px',
        height: '20px',
        borderRadius: '4px',
        background: 'rgba(255, 255, 255, 0.12)',
        transition: 'background 0.2s ease',
      } satisfies Partial<CSSStyleDeclaration>);
      buzzWrap.appendChild(cell);
      this.buzzCells.push(cell);
    }
    topRow.appendChild(buzzWrap);

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

    // Combo (right) — hidden until combo >= 2.
    this.comboEl = document.createElement('div');
    Object.assign(this.comboEl.style, {
      fontSize: '20px',
      fontWeight: '800',
      letterSpacing: '0.5px',
      fontVariantNumeric: 'tabular-nums',
      color: '#ffd45a',
      textShadow: '0 0 12px rgba(255, 212, 90, 0.6)',
      opacity: '0',
      transition: 'opacity 0.2s ease, transform 0.2s ease',
      transform: 'scale(0.85)',
      minWidth: '56px',
      textAlign: 'right',
    } satisfies Partial<CSSStyleDeclaration>);
    this.comboEl.textContent = '';
    topRow.appendChild(this.comboEl);

    // ── Full-screen vignette ─────────────────────────────────────
    // Radial gradient mounted at the bottom of the stack so the
    // top-row HUD remains crisp. Opacity is driven by buzz level.
    this.vignetteEl = document.createElement('div');
    Object.assign(this.vignetteEl.style, {
      position: 'absolute',
      inset: '0',
      pointerEvents: 'none',
      background:
        'radial-gradient(ellipse at center, transparent 35%, rgba(60, 0, 30, 0.65) 80%, rgba(0, 0, 0, 0.95) 100%)',
      opacity: '0',
      transition: 'opacity 0.4s ease',
      mixBlendMode: 'multiply',
    } satisfies Partial<CSSStyleDeclaration>);
    // Insert vignette BEHIND the HUD root, but in the same parent.
    // We use z-index so vignette sits between the canvas (z=0) and
    // the HUD root (z=2).
    this.vignetteEl.style.zIndex = '1';
    this.root.style.zIndex = '2';
    parent.appendChild(this.vignetteEl);

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
    // Fill cells 0..(level-1). At max-buzz (L5 = all 5 cells filled)
    // the whole meter pulses red — that's the "one more bottle and
    // you blackout" state. At L4 just the last cell glows softly.
    const atMax = level >= 5;
    for (let i = 0; i < this.buzzCells.length; i++) {
      const cell = this.buzzCells[i];
      if (i < level) {
        cell.style.background = colorForCell(i, level);
        if (atMax) {
          // Pulse the whole bar at danger zone.
          cell.style.boxShadow = '0 0 10px rgba(255, 60, 60, 0.95)';
          cell.style.animation =
            'tapeRunnerBuzzPulse 0.55s ease-in-out infinite';
        } else if (level >= 4 && i === level - 1) {
          // Last cell glows softly at L4 — "you're close."
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

  setCombo(combo: number, multiplier: number) {
    if (combo < 2) {
      this.comboEl.style.opacity = '0';
      this.comboEl.style.transform = 'scale(0.85)';
      return;
    }
    this.comboEl.textContent = `×${multiplier.toFixed(multiplier < 2 ? 1 : 0)} ·${combo}`;
    this.comboEl.style.opacity = '1';
    this.comboEl.style.transform = 'scale(1)';
    // Auto-fade if no new combo bump arrives soon. The timer is
    // reset every call.
    if (this.comboFadeTimer !== null) window.clearTimeout(this.comboFadeTimer);
    this.comboFadeTimer = window.setTimeout(() => {
      // Soft visual hint that the combo window is closing.
      this.comboEl.style.transform = 'scale(0.85)';
    }, 1600);
  }

  setVignette(intensity: number) {
    const clamped = Math.max(0, Math.min(1, intensity));
    this.vignetteEl.style.opacity = clamped.toFixed(2);
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
  }
}

// ── Helpers ────────────────────────────────────────────────────────

function formatInt(n: number): string {
  return Math.max(0, Math.floor(n)).toLocaleString('en-US');
}

/**
 * Buzz-meter cell colour, given the cell index (0..4) and the
 * current buzz level (1..5). Green → yellow → orange → red as
 * the meter fills. The last filled cell at level 4+ glows
 * (handled in setBuzz via boxShadow).
 */
function colorForCell(i: number, _level: number): string {
  // Each cell has its own colour regardless of level; cell 0 is
  // green (buzzed = fine), cell 4 is red (about to blackout).
  switch (i) {
    case 0:
      return '#8fe88a'; // pale green
    case 1:
      return '#e8e16d'; // yellow
    case 2:
      return '#f0a957'; // orange
    case 3:
      return '#ec6f5e'; // red-orange
    case 4:
    default:
      return '#e8443c'; // hard red
  }
}
