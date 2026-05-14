// Audio manager for Tape Runner SFX (May 14, 2026).
//
// Tiny wrapper around HTMLAudioElement pools. Admin supplies URLs
// via games/runner.assetUrls (sfx_jump, sfx_pickup, sfx_water,
// sfx_combo, sfx_gameover keys); the game loads them on init and
// fires them on the matching gameplay events.
//
// Pooling: each key gets 4 cloned HTMLAudioElement instances. Rapid
// re-triggers (e.g. two pickups within 100ms) round-robin through
// the pool so a new play() doesn't cut off the previous one.
//
// State:
//   - `mutedByUser` — toggled by the HUD mute button. Persisted to
//     localStorage so the player's preference survives across runs.
//   - `enabledByAdmin` — from games/runner.sfxEnabled. When false,
//     the mute button is hidden and play() is a no-op regardless of
//     mutedByUser.
//   - `masterVolume` — from games/runner.sfxVolume (0..1).
//
// Autoplay: browsers block audio playback until the page receives a
// user gesture. The runner's natural first gesture is the swipe-to-
// start, which is enough to unlock the AudioContext for subsequent
// SFX. If a play() fails because of autoplay restrictions, we
// silently swallow the rejected promise (no harm done; the next
// trigger after a user gesture will work).

const LS_KEY_MUTED = 'tape_runner_audio_muted';
const POOL_SIZE = 4;

export class AudioManager {
  /** key (e.g. 'jump') → pool of HTMLAudioElement instances. */
  private pools = new Map<string, HTMLAudioElement[]>();
  /** Index into each pool, advanced round-robin on play(). */
  private cursors = new Map<string, number>();
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
    for (const audio of this.loops.values()) {
      try {
        audio.volume = this._masterVolume;
      } catch {
        // ignore — element may be in a transitional state
      }
    }
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
        audio.volume = this._masterVolume;
        audio.play().catch(() => {
          // autoplay rejection — next user gesture will succeed
        });
      } catch {
        // ignore
      }
    }
  }

  /**
   * Preload (or replace) a SFX key. If the same URL is already
   * loaded under this key, no-op. If a different URL is loaded,
   * the old pool is discarded (browser GC reclaims it).
   *
   * Empty string URL means "admin hasn't configured this SFX";
   * we drop any existing pool so subsequent play()s are silent.
   */
  load(key: string, url: string): void {
    if (!url) {
      this.pools.delete(key);
      this.cursors.delete(key);
      this.loadedUrls.delete(key);
      return;
    }
    if (this.loadedUrls.get(key) === url) return;
    const pool: HTMLAudioElement[] = [];
    for (let i = 0; i < POOL_SIZE; i++) {
      const audio = new Audio(url);
      audio.preload = 'auto';
      // Don't crossfade — these are short SFX. Browser default
      // playback already lets us simply call play() to start.
      pool.push(audio);
    }
    this.pools.set(key, pool);
    this.cursors.set(key, 0);
    this.loadedUrls.set(key, url);
  }

  /**
   * Play a SFX. No-op if muted, no pool loaded for the key, or the
   * browser's autoplay policy rejects the call. Cycles through the
   * pool so back-to-back triggers don't truncate the previous play.
   */
  play(key: string): void {
    if (this.muted) return;
    const pool = this.pools.get(key);
    if (!pool || pool.length === 0) return;
    const cursor = this.cursors.get(key) ?? 0;
    const audio = pool[cursor];
    this.cursors.set(key, (cursor + 1) % pool.length);
    try {
      audio.currentTime = 0;
      audio.volume = this._masterVolume;
      // play() returns a Promise that rejects under autoplay
      // restrictions. We swallow — the SFX is non-critical and the
      // next play() after a user gesture will succeed.
      audio.play().catch(() => {
        // ignore
      });
    } catch {
      // Some browsers throw synchronously on currentTime= during
      // a pending play — ignore.
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
        audio.volume = this._masterVolume;
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
      audio.volume = this._masterVolume;
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
        audio.volume = this._masterVolume;
        audio.play().catch(() => {});
      } catch {
        // ignore
      }
    }
  }

  /** Stop all sounds (used on dispose / page hide). */
  stopAll(): void {
    for (const pool of this.pools.values()) {
      for (const audio of pool) {
        try {
          audio.pause();
          audio.currentTime = 0;
        } catch {
          // ignore
        }
      }
    }
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
    this.pools.clear();
    this.cursors.clear();
    this.loops.clear();
    this.loadedUrls.clear();
  }
}
