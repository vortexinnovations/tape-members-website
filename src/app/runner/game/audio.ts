// Audio manager for Tape Runner SFX (May 14, 2026).
//
// Admin supplies URLs via the games/runner doc (sfxJumpUrl,
// sfxPickupUrl, sfxWaterUrl, sfxComboUrl, sfxGameOverUrl,
// sfxLaneChangeUrl, sfxRunningUrl); the game loads them on init and
// fires them on the matching gameplay events.
//
// One-shot strategy: clone-on-play. `load(key, url)` creates a
// single Audio element that primes the browser's HTTP cache;
// `play(key)` then spawns a fresh Audio(url) per trigger. Rapid
// re-triggers (e.g. five drink sounds within a second) overlap
// cleanly because each one runs on its own element — no fixed pool
// to exhaust, no `currentTime = 0` racing a pending play()
// Promise. Each clone listens for its own `ended` event and nulls
// out its src so the browser can reclaim the audio buffer; the
// cached HTTP response stays warm for the next play().
//
// Loops (e.g. running footsteps) use a different path — one
// dedicated <audio loop=true> per key, with start/stop semantics
// (see loadLoop / playLoop / stopLoop below). The clone-on-play
// trick doesn't fit loops because we need to stop them on mute /
// game-over / pause.
//
// State:
//   - `mutedByUser` — toggled by the HUD mute button. Persisted to
//     localStorage so the player's preference survives across runs.
//   - `enabledByAdmin` — from games/runner.sfxEnabled. When false,
//     the mute button is hidden and play() is a no-op regardless of
//     mutedByUser.
//   - `masterVolume` — from games/runner.sfxVolume (0..1).
//   - `keyVolumes` — per-key 0..1 multiplier on top of master.
//
// Autoplay: browsers block audio playback until the page receives a
// user gesture. The runner's natural first gesture is the swipe-to-
// start, which is enough to unlock the AudioContext for subsequent
// SFX. If a play() fails because of autoplay restrictions, we
// silently swallow the rejected promise (no harm done; the next
// trigger after a user gesture will work).

const LS_KEY_MUTED = 'tape_runner_audio_muted';

export class AudioManager {
  /** Cache-priming Audio element per one-shot key. We do NOT play
   *  these — they exist only to keep a reference alive so the
   *  initial HTTP fetch isn't GC'd before play() clones get to
   *  reuse the cached response. */
  private primers = new Map<string, HTMLAudioElement>();
  /** URL each key is loaded from, so we can skip re-loading on
   *  init() calls that pass the same URLs. One-shots and loops
   *  use namespaced keys ('jump' vs 'loop:running') so a key reused
   *  between the two types doesn't collide. */
  private loadedUrls = new Map<string, string>();

  /** Loop instances — separate from `pools` because looping needs
   *  exactly ONE dedicated `<audio>` per key. round-robin doesn't
   *  apply (there's nothing to interrupt), and the lifecycle is
   *  start/stop rather than one-shot fire-and-forget. */
  private loops = new Map<string, HTMLAudioElement>();
  /** Loops the caller has requested be playing. Survives transient
   *  pauses (browser autoplay rejection, lifecycle pauseLoops()) so
   *  resumeLoops() / unmute can resurrect them automatically. */
  private loopWantPlaying = new Set<string>();

  /** Per-key 0..1 volume multiplier applied on top of `_masterVolume`.
   *  Default for any key not present is 1.0 (no attenuation). Lets
   *  admin balance individual SFX without touching the master. */
  private keyVolumes = new Map<string, number>();

  private _mutedByUser = false;
  private _enabledByAdmin = true;
  private _masterVolume = 1.0;

  /** Callback fired when mute state changes (HUD updates icon). */
  onMuteChanged?: (muted: boolean) => void;

  constructor() {
    try {
      this._mutedByUser =
        localStorage.getItem(LS_KEY_MUTED) === 'true';
    } catch {
      // localStorage can throw in private-mode Safari — default to
      // unmuted and don't try to persist.
    }
  }

  /** Whether the HUD mute button should be visible. False when
   *  the admin's master switch is off. */
  get visible(): boolean {
    return this._enabledByAdmin;
  }

  /** Whether sound is currently silenced (either user or admin). */
  get muted(): boolean {
    return this._mutedByUser || !this._enabledByAdmin;
  }

  /** Whether the user (not admin) has the mute button engaged.
   *  HUD button drives this — admin overrides via visible/enabled. */
  get mutedByUser(): boolean {
    return this._mutedByUser;
  }

  setMutedByUser(muted: boolean): void {
    if (this._mutedByUser === muted) return;
    this._mutedByUser = muted;
    try {
      localStorage.setItem(LS_KEY_MUTED, muted ? 'true' : 'false');
    } catch {
      // ignore localStorage write failures
    }
    this._syncLoopsToMute();
    this.onMuteChanged?.(this.muted);
  }

  toggleMute(): void {
    this.setMutedByUser(!this._mutedByUser);
  }

  setEnabledByAdmin(enabled: boolean): void {
    if (this._enabledByAdmin === enabled) return;
    this._enabledByAdmin = enabled;
    this._syncLoopsToMute();
    this.onMuteChanged?.(this.muted);
  }

  setMasterVolume(volume: number): void {
    this._masterVolume = Math.max(0, Math.min(1, volume));
    // Live loops need the new volume immediately — one-shots pick
    // it up on their next play() call.
    for (const [key, audio] of this.loops) {
      try {
        audio.volume = this._effectiveVolume(key);
      } catch {
        // ignore — element may be in a transitional state
      }
    }
  }

  /**
   * Per-key 0..1 multiplier. Final volume on each play / loop start
   * is `_masterVolume * keyVolume`. Clamped to [0, 1] before storing.
   * Updates live-playing loops immediately so admin volume slider
   * dragging gets instant feedback.
   */
  setKeyVolume(key: string, volume: number): void {
    if (!Number.isFinite(volume)) return;
    const clamped = Math.max(0, Math.min(1, volume));
    this.keyVolumes.set(key, clamped);
    const loop = this.loops.get(key);
    if (loop) {
      try {
        loop.volume = this._effectiveVolume(key);
      } catch {
        // ignore
      }
    }
  }

  /** Internal: master × per-key (default 1.0 if no per-key set). */
  private _effectiveVolume(key: string): number {
    const k = this.keyVolumes.get(key);
    return this._masterVolume * (k ?? 1.0);
  }

  /** Internal: bring loops into agreement with the current mute
   *  state. Mute → pause every loop (intent preserved in
   *  `loopWantPlaying`). Unmute → resume each loop the caller had
   *  requested via playLoop(). */
  private _syncLoopsToMute(): void {
    if (this.muted) {
      for (const audio of this.loops.values()) {
        try {
          audio.pause();
        } catch {
          // ignore
        }
      }
      return;
    }
    for (const [key, audio] of this.loops) {
      if (!this.loopWantPlaying.has(key)) continue;
      try {
        audio.volume = this._effectiveVolume(key);
        audio.play().catch(() => {
          // autoplay rejection — next user gesture will succeed
        });
      } catch {
        // ignore
      }
    }
  }

  /**
   * Preload (or replace) a one-shot SFX key. Same URL = no-op.
   * Different URL = drop the old primer (browser GC reclaims it).
   * Empty URL = forget the key so subsequent play()s are silent.
   *
   * The primer is a single hidden Audio element that triggers the
   * HTTP fetch + decode. We don't play it directly — play() spawns
   * its own fresh element per trigger and the browser's HTTP cache
   * serves the audio data instantly.
   */
  load(key: string, url: string): void {
    if (!url) {
      this.primers.delete(key);
      this.loadedUrls.delete(key);
      return;
    }
    if (this.loadedUrls.get(key) === url) return;
    const audio = new Audio(url);
    audio.preload = 'auto';
    // .load() forces the fetch to begin in some browsers (e.g.
    // Chrome won't pre-fetch otherwise).
    try {
      audio.load();
    } catch {
      // ignore
    }
    this.primers.set(key, audio);
    this.loadedUrls.set(key, url);
  }

  /**
   * Play a one-shot SFX. No-op if muted, no URL loaded for the
   * key, or the browser's autoplay policy rejects the call.
   *
   * Spawns a fresh Audio element per trigger so back-to-back fires
   * (e.g. five rapid bottle pickups) overlap cleanly — no pool to
   * exhaust, no `currentTime = 0` racing a pending play() Promise.
   * The element self-disposes via an `ended` listener that drops
   * its src reference; the browser keeps the underlying audio data
   * cached for the next play().
   */
  play(key: string): void {
    if (this.muted) return;
    const url = this.loadedUrls.get(key);
    if (!url) return;
    try {
      const audio = new Audio(url);
      audio.volume = this._effectiveVolume(key);
      // Self-cleanup once playback finishes. We also clear on
      // `error` so a failed fetch doesn't hang a dead element
      // alive. { once: true } detaches the listener after firing
      // so the GC can collect the closure.
      const cleanup = () => {
        try {
          audio.src = '';
        } catch {
          // ignore
        }
      };
      audio.addEventListener('ended', cleanup, { once: true });
      audio.addEventListener('error', cleanup, { once: true });
      // play() returns a Promise that rejects under autoplay
      // restrictions or if the fetch fails — swallow either way.
      audio.play().catch(() => {
        // ignore
      });
    } catch {
      // ignore
    }
  }

  /**
   * Preload (or replace) a looping SFX (e.g. running footsteps).
   * Unlike one-shots, each key gets exactly ONE `<audio>` element
   * marked `loop = true`. Calling with an empty URL stops + drops
   * the loop. Re-calling with the same URL is a no-op.
   *
   * If `playLoop(key)` was called BEFORE the URL was loaded, this
   * starts the loop immediately on the new element (and respects
   * current mute state).
   */
  loadLoop(key: string, url: string): void {
    const cacheKey = `loop:${key}`;
    if (!url) {
      this.stopLoop(key);
      this.loops.delete(key);
      this.loadedUrls.delete(cacheKey);
      return;
    }
    if (this.loadedUrls.get(cacheKey) === url) return;
    const existing = this.loops.get(key);
    if (existing) {
      try {
        existing.pause();
        existing.src = '';
      } catch {
        // ignore
      }
    }
    const audio = new Audio(url);
    audio.preload = 'auto';
    audio.loop = true;
    this.loops.set(key, audio);
    this.loadedUrls.set(cacheKey, url);
    // If the game asked for this loop before its URL landed, kick
    // it off now (subject to mute).
    if (this.loopWantPlaying.has(key) && !this.muted) {
      try {
        audio.volume = this._effectiveVolume(key);
        audio.play().catch(() => {});
      } catch {
        // ignore
      }
    }
  }

  /**
   * Start (or restart) a loop. Records the caller's intent so the
   * loop survives mute / lifecycle pause and auto-resumes on
   * unmute. No-op if no URL is loaded for the key — but the intent
   * is still recorded, so a later `loadLoop()` will start it.
   */
  playLoop(key: string): void {
    this.loopWantPlaying.add(key);
    if (this.muted) return;
    const audio = this.loops.get(key);
    if (!audio) return;
    try {
      audio.volume = this._effectiveVolume(key);
      audio.play().catch(() => {
        // autoplay rejection — next user gesture will succeed
      });
    } catch {
      // ignore
    }
  }

  /** Stop a loop and forget the caller's intent. The audio
   *  element stays loaded for cheap re-start later. */
  stopLoop(key: string): void {
    this.loopWantPlaying.delete(key);
    const audio = this.loops.get(key);
    if (!audio) return;
    try {
      audio.pause();
      audio.currentTime = 0;
    } catch {
      // ignore
    }
  }

  /**
   * Pause every loop without clearing intent. Used by the bridge's
   * pause() entry — the player is backgrounding the app or the
   * Flutter wrapper is mid-transition; we want silence but want
   * resumeLoops() to bring the same loops back.
   */
  pauseLoops(): void {
    for (const audio of this.loops.values()) {
      try {
        audio.pause();
      } catch {
        // ignore
      }
    }
  }

  /**
   * Resume any loops that had been started before pauseLoops().
   * Skipped if currently muted (mute already enforces silence;
   * unmuting will catch this set via _syncLoopsToMute).
   */
  resumeLoops(): void {
    if (this.muted) return;
    for (const [key, audio] of this.loops) {
      if (!this.loopWantPlaying.has(key)) continue;
      try {
        audio.volume = this._effectiveVolume(key);
        audio.play().catch(() => {});
      } catch {
        // ignore
      }
    }
  }

  /**
   * Stop all loops (used on dispose / page hide). One-shots
   * spawned via play() self-dispose on their own — we don't keep
   * references and can't (easily) round them up. They'll finish
   * naturally within a couple of seconds.
   */
  stopAll(): void {
    for (const audio of this.loops.values()) {
      try {
        audio.pause();
        audio.currentTime = 0;
      } catch {
        // ignore
      }
    }
    this.loopWantPlaying.clear();
  }

  dispose(): void {
    this.stopAll();
    // Drop primer elements so the browser can GC them. The HTTP
    // cache is unaffected.
    for (const audio of this.primers.values()) {
      try {
        audio.src = '';
      } catch {
        // ignore
      }
    }
    this.primers.clear();
    this.loops.clear();
    this.keyVolumes.clear();
    this.loadedUrls.clear();
  }
}
