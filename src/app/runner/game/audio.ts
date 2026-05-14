// Audio manager for Tape Runner SFX. Web Audio API based, with
// iOS-safe lifecycle (May 14, 2026).
//
// iOS WKWebView gotchas this manager works around:
//
//   1. Creating an AudioContext OUTSIDE a user gesture produces a
//      context that can never be resumed. Solution: don't create
//      the context until unlock() runs from inside a pointerdown
//      handler.
//
//   2. ctx.resume() only succeeds when called synchronously inside
//      a "real" gesture event (pointerdown / pointerup / touchend
//      / click — NOT pointermove). The swipe→audio chain in
//      game.ts fires from pointermove, so we expose unlock() and
//      wire it from pointerdown explicitly.
//
//   3. Even after resume(), iOS sometimes doesn't open the audio
//      output until at least one source has played. The canonical
//      workaround is to start a 1-sample silent source during
//      unlock — a "wake-up call" for the audio pipeline.
//
//   4. <audio> elements on iOS are single-channel (a new one
//      preempts the previously playing one). AudioBufferSourceNode
//      is NOT — sources mix together at the destination. This is
//      why we use Web Audio at all.
//
// One-shot strategy:
//   - load(key, url) fetches the ArrayBuffer immediately (no
//     AudioContext needed) and stashes it. Decoding is deferred
//     until unlock() because decodeAudioData can fail silently on
//     a never-resumed context.
//   - On unlock() the AudioContext is created (inside the gesture),
//     resumed, the silent-buffer trick fires, and all pending
//     ArrayBuffers decode into AudioBuffers.
//   - play(key) creates a fresh BufferSource + per-clip GainNode
//     per trigger so rapid-fire pickups overlap freely.
//
// Loops:
//   - Same buffer cache, `loop:<key>` namespace.
//   - playLoop creates a source with loop = true and keeps a
//     reference for stopLoop / live volume.
//   - pauseLoops / resumeLoops use ctx.suspend / ctx.resume —
//     positions are preserved across pauses.
//
// Mute:
//   - masterGain.gain → 0 when muted, → _masterVolume otherwise.
//   - One-shots in flight finish silently.

const LS_KEY_MUTED = 'tape_runner_audio_muted';

export class AudioManager {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;

  /** Decoded AudioBuffers. One-shots use plain keys; loops use
   *  `loop:<key>` so they share the map without colliding. */
  private buffers = new Map<string, AudioBuffer>();

  /** URL each cache slot was last loaded from. */
  private loadedUrls = new Map<string, string>();

  /** Pre-fetched ArrayBuffers awaiting decode. iOS requires the
   *  AudioContext to exist + be resumable (inside a user gesture)
   *  before decodeAudioData reliably works, so we hold the raw
   *  bytes here until unlock() opens the door. Keyed by cache key. */
  private pendingBuffers = new Map<string, ArrayBuffer>();

  /** Concurrent fetch dedupe — same URL only ever fetched once. */
  private fetching = new Map<string, Promise<void>>();

  /** Live loop nodes — start/stop semantics. */
  private loopSources = new Map<string, AudioBufferSourceNode>();
  private loopGains = new Map<string, GainNode>();

  /** Caller intent — keeps a loop "wanting" even if the buffer
   *  isn't decoded yet or the context is suspended. */
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
      // localStorage can throw in private-mode Safari.
    }
  }

  get visible(): boolean {
    return this._enabledByAdmin;
  }

  get muted(): boolean {
    return this._mutedByUser || !this._enabledByAdmin;
  }

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

  /** Per-key 0..1 multiplier. Updates live loops immediately. */
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

  // ── iOS unlock ──────────────────────────────────────────────

  /**
   * Public unlock hook — MUST be called from a guaranteed user-
   * gesture event (pointerdown / touchend / click). Creates the
   * AudioContext if needed, resumes it, plays a silent priming
   * buffer to fully open the audio pipeline, and decodes any
   * pre-fetched ArrayBuffers that were waiting for the context.
   *
   * Idempotent. After the first successful call, subsequent
   * calls are cheap no-ops (ctx already running, no pending
   * decodes).
   */
  unlock(): void {
    const ctx = this._ensureCtx();
    if (!ctx) return;
    // 1) Resume if suspended. On iOS this only takes effect if
    //    called inside a real gesture event's call stack.
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
    // 2) Silent-buffer trick. Even with resume(), iOS sometimes
    //    won't open the output until a source has actually played.
    //    A 1-sample silent buffer is the canonical wake-up call.
    try {
      const buf = ctx.createBuffer(1, 1, 22050);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.start(0);
    } catch {
      // ignore
    }
    // 3) Drain any pending decodes — pre-fetched bytes that we
    //    held back until the context existed.
    this._drainPendingDecodes();
  }

  // ── Private helpers ─────────────────────────────────────────

  /** Create the AudioContext if missing. Should only be called
   *  from unlock() (which itself runs inside a user gesture).
   *  Creating the context OUTSIDE a gesture on iOS produces a
   *  context that can never be resumed. */
  private _ensureCtx(): AudioContext | null {
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

  /** Master gain reflects mute state. */
  private _applyMute(): void {
    const g = this.masterGain;
    if (!g) return;
    try {
      g.gain.value = this.muted ? 0 : this._masterVolume;
    } catch {
      // ignore
    }
  }

  /** Decode every pre-fetched ArrayBuffer and clear the queue. */
  private _drainPendingDecodes(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    for (const [cacheKey, ab] of this.pendingBuffers) {
      // decodeAudioData CONSUMES the ArrayBuffer in the modern
      // spec — pass a copy via slice(0) so we can keep the
      // original around for a possible retry.
      ctx
        .decodeAudioData(ab.slice(0))
        .then((buf) => {
          this.buffers.set(cacheKey, buf);
          // If a loop wanted to start before the buffer was ready,
          // start it now (cacheKey is "loop:<key>" for loops).
          if (cacheKey.startsWith('loop:')) {
            const k = cacheKey.slice('loop:'.length);
            if (
              this.loopWantPlaying.has(k) &&
              !this.loopSources.has(k) &&
              !this.muted
            ) {
              this._startLoopFromBuffer(k);
            }
          }
        })
        .catch((err) => {
          console.warn('[audio] decode failed', cacheKey, err);
        });
    }
    this.pendingBuffers.clear();
  }

  /** Fetch the ArrayBuffer for a URL and stash it in
   *  pendingBuffers OR decode immediately if the context exists. */
  private _fetchAndQueue(cacheKey: string, url: string): void {
    if (this.loadedUrls.get(cacheKey) === url) return;
    this.loadedUrls.set(cacheKey, url);
    const inflight = this.fetching.get(cacheKey);
    if (inflight) return; // dedupe
    const p = (async () => {
      try {
        const res = await fetch(url);
        const ab = await res.arrayBuffer();
        if (this.ctx) {
          // Context is alive — decode straight away.
          try {
            const buf = await this.ctx.decodeAudioData(ab);
            this.buffers.set(cacheKey, buf);
            if (cacheKey.startsWith('loop:')) {
              const k = cacheKey.slice('loop:'.length);
              if (
                this.loopWantPlaying.has(k) &&
                !this.loopSources.has(k) &&
                !this.muted
              ) {
                this._startLoopFromBuffer(k);
              }
            }
          } catch (err) {
            console.warn('[audio] decode failed', cacheKey, err);
          }
        } else {
          // No context yet — stash for unlock() to drain.
          this.pendingBuffers.set(cacheKey, ab);
        }
      } catch (err) {
        console.warn('[audio] fetch failed', cacheKey, url, err);
        this.loadedUrls.delete(cacheKey);
      } finally {
        this.fetching.delete(cacheKey);
      }
    })();
    this.fetching.set(cacheKey, p);
  }

  // ── One-shot SFX ────────────────────────────────────────────

  /**
   * Preload (or replace) a one-shot SFX. Triggers a background
   * fetch immediately; if the AudioContext doesn't exist yet (no
   * user gesture has happened), the ArrayBuffer is stashed and
   * decoded the moment unlock() runs.
   */
  load(key: string, url: string): void {
    if (!url) {
      this.buffers.delete(key);
      this.loadedUrls.delete(key);
      this.pendingBuffers.delete(key);
      return;
    }
    this._fetchAndQueue(key, url);
  }

  /**
   * Play a one-shot SFX. Spawns a new BufferSource per trigger
   * so rapid-fire pickups overlap freely. Silent no-op if muted,
   * no buffer decoded yet, or context never created.
   */
  play(key: string): void {
    if (this.muted) return;
    const ctx = this.ctx;
    if (!ctx || !this.masterGain) return;
    const buf = this.buffers.get(key);
    if (!buf) return;
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
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
   * Preload a looping SFX. Same fetch/decode dance as load() — if
   * playLoop() fires before the buffer is ready, the decode's
   * resolution kicks it off automatically.
   */
  loadLoop(key: string, url: string): void {
    const cacheKey = `loop:${key}`;
    if (!url) {
      this.stopLoop(key);
      this.buffers.delete(cacheKey);
      this.loadedUrls.delete(cacheKey);
      this.pendingBuffers.delete(cacheKey);
      return;
    }
    this._fetchAndQueue(cacheKey, url);
  }

  /** Start (or restart) a loop. Records intent so the loop
   *  survives mute / lifecycle pause and starts the moment its
   *  buffer becomes ready. */
  playLoop(key: string): void {
    this.loopWantPlaying.add(key);
    if (this.muted) return;
    if (this.loopSources.has(key)) return;
    this._startLoopFromBuffer(key);
  }

  private _startLoopFromBuffer(key: string): void {
    const ctx = this.ctx;
    if (!ctx || !this.masterGain) return;
    const buf = this.buffers.get(`loop:${key}`);
    if (!buf) return; // not yet decoded
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
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

  /** Pause everything in the graph; loop positions preserved. */
  pauseLoops(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (ctx.state === 'running') {
      ctx.suspend().catch(() => {});
    }
  }

  resumeLoops(): void {
    if (this.muted) return;
    const ctx = this.ctx;
    if (!ctx) return;
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
  }

  /** Stop all loops; one-shots clean themselves up. */
  stopAll(): void {
    for (const key of Array.from(this.loopSources.keys())) {
      this.stopLoop(key);
    }
  }

  dispose(): void {
    this.stopAll();
    this.buffers.clear();
    this.loadedUrls.clear();
    this.pendingBuffers.clear();
    this.keyVolumes.clear();
    this.fetching.clear();
    // Don't close the AudioContext — browsers cap how many can
    // exist per page lifetime, and disposal is followed by route
    // pop / page teardown anyway.
  }
}
