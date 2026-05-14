// Audio manager for Tape Runner SFX. Rewritten May 14, 2026 from
// pooled HTMLAudioElement to Web Audio API.
//
// Why: HTMLAudioElement playback on iOS WKWebView is effectively
// single-channel — when a new <audio> starts, the previously playing
// one is preempted. The clone-on-play and pool approaches both ran
// into this and silenced rapid drink-sound triggers after the first
// bottle. Web Audio's AudioBufferSourceNode is designed for this
// case: every trigger gets its own short-lived source and they
// overlap freely on every platform we ship to.
//
// Architecture:
//   - One shared AudioContext, created lazily on first use. iOS
//     suspends it until a user gesture; we resume() from inside
//     every play() — cheap no-op once it's running.
//   - One decoded AudioBuffer per key, cached in `buffers`.
//   - load(key, url) fetches + decodes asynchronously. Concurrent
//     calls for the same URL dedupe via the `loading` map.
//   - play(key) creates a fresh BufferSource + per-clip GainNode
//     per trigger. Source self-disposes through `onended`.
//   - Routing: source → per-clip gain (per-key volume) → master
//     gain (mute + master volume) → destination.
//
// Loop strategy:
//   - Same decoded buffer cache, namespaced with `loop:` prefix.
//   - loadLoop async; if playLoop() was called before the decode
//     finished, the buffer's resolution kicks it off.
//   - playLoop creates a BufferSource with `loop = true` and keeps
//     a reference for stopLoop / live volume updates.
//   - pauseLoops / resumeLoops use ctx.suspend / ctx.resume — the
//     whole graph pauses at once, preserving loop positions (the
//     lifecycle-pause semantics we want).
//
// Mute:
//   - masterGain.gain = 0 when muted, = _masterVolume otherwise.
//   - One-shots currently in flight will finish silently — no way
//     to round them up without keeping refs we'd otherwise leak.
//   - Loops continue playing under the muted master; unmuting
//     restores the gain immediately, no restart.

const LS_KEY_MUTED = 'tape_runner_audio_muted';

export class AudioManager {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  /** Decoded AudioBuffers. One-shots use plain keys (e.g. 'jump');
   *  loops are prefixed `loop:` so they can share the same map
   *  without colliding with same-named one-shots. */
  private buffers = new Map<string, AudioBuffer>();
  /** URL each cache slot was last loaded from. Re-init with the
   *  same URL is a cheap no-op. */
  private loadedUrls = new Map<string, string>();
  /** Concurrent decode dedupe — two near-simultaneous load(key,
   *  url) calls for the same key share one fetch. */
  private loading = new Map<string, Promise<void>>();

  /** Live loop nodes — start/stop semantics. */
  private loopSources = new Map<string, AudioBufferSourceNode>();
  private loopGains = new Map<string, GainNode>();
  /** Caller intent — keeps a loop "wanting" even if the buffer
   *  hasn't decoded yet or the context is suspended. */
  private loopWantPlaying = new Set<string>();

  /** Per-key 0..1 volume multiplier (default 1.0). Applied as the
   *  per-clip gain on every trigger. */
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

  /** Whether the HUD mute button should be visible. False when the
   *  admin's master switch is off. */
  get visible(): boolean {
    return this._enabledByAdmin;
  }

  /** Whether sound is currently silenced (either user or admin). */
  get muted(): boolean {
    return this._mutedByUser || !this._enabledByAdmin;
  }

  /** Whether the user (not admin) has the mute button engaged. */
  get mutedByUser(): boolean {
    return this._mutedByUser;
  }

  setMutedByUser(muted: boolean): void {
    if (this._mutedByUser === muted) return;
    this._mutedByUser = muted;
    try {
      localStorage.setItem(LS_KEY_MUTED, muted ? 'true' : 'false');
    } catch {
      // ignore
    }
    this._applyMute();
    this.onMuteChanged?.(this.muted);
  }

  toggleMute(): void {
    this.setMutedByUser(!this._mutedByUser);
  }

  setEnabledByAdmin(enabled: boolean): void {
    if (this._enabledByAdmin === enabled) return;
    this._enabledByAdmin = enabled;
    this._applyMute();
    this.onMuteChanged?.(this.muted);
  }

  setMasterVolume(volume: number): void {
    this._masterVolume = Math.max(0, Math.min(1, volume));
    this._applyMute();
  }

  /**
   * Per-key 0..1 multiplier. Final volume = `_masterVolume *
   * keyVolume`. Clamped to [0, 1]. Updates the live loop's per-
   * clip gain immediately so admin slider drags audition in real
   * time.
   */
  setKeyVolume(key: string, volume: number): void {
    if (!Number.isFinite(volume)) return;
    const clamped = Math.max(0, Math.min(1, volume));
    this.keyVolumes.set(key, clamped);
    const gain = this.loopGains.get(key);
    if (gain) {
      try {
        gain.gain.value = clamped;
      } catch {
        // ignore
      }
    }
  }

  // ── Private helpers ─────────────────────────────────────────

  /** Lazy-create the AudioContext + master gain. Returns null if
   *  Web Audio isn't available (very old browsers; the player gets
   *  silent gameplay, which is a graceful degradation). */
  private _ctx(): AudioContext | null {
    if (this.ctx) return this.ctx;
    try {
      const w = window as unknown as {
        AudioContext?: typeof AudioContext;
        webkitAudioContext?: typeof AudioContext;
      };
      const C = w.AudioContext || w.webkitAudioContext;
      if (!C) return null;
      this.ctx = new C();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value =
        this.muted ? 0 : this._masterVolume;
      this.masterGain.connect(this.ctx.destination);
    } catch {
      return null;
    }
    return this.ctx;
  }

  /** Kick the context awake if suspended. iOS Safari suspends
   *  until a user gesture; calling resume() inside a gesture
   *  handler is enough to unlock it for the rest of the session. */
  private _resumeIfSuspended(): void {
    const ctx = this.ctx;
    if (ctx && ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
  }

  /** Master gain agrees with mute state. Setting via .value gives
   *  an instant cut; if we wanted a click-free fade we'd use
   *  setTargetAtTime here, but mute is fine cutting hard. */
  private _applyMute(): void {
    const g = this.masterGain;
    if (!g) return;
    try {
      g.gain.value = this.muted ? 0 : this._masterVolume;
    } catch {
      // ignore
    }
  }

  /** Fetch + decode an audio URL into the buffer cache. Returns
   *  the buffer (or null on failure). Safe to call concurrently —
   *  duplicate calls for the same key share one fetch. */
  private async _decode(
    cacheKey: string,
    url: string,
  ): Promise<AudioBuffer | null> {
    const ctx = this._ctx();
    if (!ctx) return null;
    if (this.loadedUrls.get(cacheKey) === url) {
      return this.buffers.get(cacheKey) ?? null;
    }
    const existing = this.loading.get(cacheKey);
    if (existing) {
      await existing;
      return this.buffers.get(cacheKey) ?? null;
    }
    const p = (async () => {
      try {
        const res = await fetch(url);
        const ab = await res.arrayBuffer();
        const buf = await ctx.decodeAudioData(ab);
        this.buffers.set(cacheKey, buf);
        this.loadedUrls.set(cacheKey, url);
      } catch (err) {
        console.warn('[audio] decode failed', cacheKey, url, err);
        this.loadedUrls.delete(cacheKey);
        this.buffers.delete(cacheKey);
      }
    })();
    this.loading.set(cacheKey, p);
    try {
      await p;
    } finally {
      this.loading.delete(cacheKey);
    }
    return this.buffers.get(cacheKey) ?? null;
  }

  // ── One-shot SFX ────────────────────────────────────────────

  /**
   * Preload (or replace) a one-shot SFX. The fetch + decode
   * happens in the background; play() before decode completes is
   * a silent no-op. Subsequent plays use the cached AudioBuffer
   * directly — no re-fetch, instant start.
   *
   * Empty URL forgets the key. Same URL = no-op.
   */
  load(key: string, url: string): void {
    if (!url) {
      this.buffers.delete(key);
      this.loadedUrls.delete(key);
      return;
    }
    void this._decode(key, url);
  }

  /**
   * Play a one-shot SFX. Spawns a new BufferSource per trigger,
   * so rapid-fire pickups overlap freely with no pool exhaustion
   * and no single-channel preemption on iOS WKWebView.
   */
  play(key: string): void {
    if (this.muted) return;
    const ctx = this._ctx();
    if (!ctx || !this.masterGain) return;
    const buf = this.buffers.get(key);
    if (!buf) return;
    this._resumeIfSuspended();
    try {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const gain = ctx.createGain();
      gain.gain.value = this.keyVolumes.get(key) ?? 1.0;
      src.connect(gain).connect(this.masterGain);
      src.onended = () => {
        try {
          src.disconnect();
          gain.disconnect();
        } catch {
          // ignore
        }
      };
      src.start(0);
    } catch {
      // ignore
    }
  }

  // ── Loops ───────────────────────────────────────────────────

  /**
   * Preload (or replace) a looping SFX. Decodes async; if
   * playLoop() fires before the decode finishes, the loop starts
   * the moment the buffer is ready.
   */
  loadLoop(key: string, url: string): void {
    const cacheKey = `loop:${key}`;
    if (!url) {
      this.stopLoop(key);
      this.buffers.delete(cacheKey);
      this.loadedUrls.delete(cacheKey);
      return;
    }
    void this._decode(cacheKey, url).then(() => {
      if (
        this.loopWantPlaying.has(key) &&
        !this.loopSources.has(key) &&
        !this.muted
      ) {
        this._startLoopFromBuffer(key);
      }
    });
  }

  /**
   * Start (or restart) a loop. Records intent so the loop
   * survives mute / lifecycle pause and resumes automatically
   * when the right state returns.
   */
  playLoop(key: string): void {
    this.loopWantPlaying.add(key);
    if (this.muted) return;
    if (this.loopSources.has(key)) return;
    this._startLoopFromBuffer(key);
  }

  private _startLoopFromBuffer(key: string): void {
    const ctx = this._ctx();
    if (!ctx || !this.masterGain) return;
    const buf = this.buffers.get(`loop:${key}`);
    if (!buf) return; // not yet decoded — loadLoop's .then() will retry
    this._resumeIfSuspended();
    try {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const gain = ctx.createGain();
      gain.gain.value = this.keyVolumes.get(key) ?? 1.0;
      src.connect(gain).connect(this.masterGain);
      this.loopSources.set(key, src);
      this.loopGains.set(key, gain);
      src.start(0);
    } catch {
      // ignore
    }
  }

  /** Stop a loop and forget the caller's intent. */
  stopLoop(key: string): void {
    this.loopWantPlaying.delete(key);
    const src = this.loopSources.get(key);
    if (src) {
      try {
        src.stop(0);
        src.disconnect();
      } catch {
        // ignore
      }
      this.loopSources.delete(key);
    }
    const gain = this.loopGains.get(key);
    if (gain) {
      try {
        gain.disconnect();
      } catch {
        // ignore
      }
      this.loopGains.delete(key);
    }
  }

  /**
   * Pause everything in the graph. Used by the bridge's pause()
   * entry (Flutter backgrounded the app). Suspending the context
   * preserves loop positions exactly — resume picks up where we
   * left off.
   */
  pauseLoops(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (ctx.state === 'running') {
      ctx.suspend().catch(() => {});
    }
  }

  resumeLoops(): void {
    if (this.muted) return;
    this._resumeIfSuspended();
  }

  /** Stop all loops; one-shots in flight finish themselves. */
  stopAll(): void {
    for (const key of Array.from(this.loopSources.keys())) {
      this.stopLoop(key);
    }
  }

  dispose(): void {
    this.stopAll();
    this.buffers.clear();
    this.loadedUrls.clear();
    this.keyVolumes.clear();
    this.loading.clear();
    // Don't close the AudioContext — browsers cap how many can
    // exist per page lifetime, and dispose() is followed by either
    // a route pop or full page teardown. Leaving the context open
    // is harmless.
  }
}
