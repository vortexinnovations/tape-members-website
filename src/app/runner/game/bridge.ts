// JS ↔ Dart bridge contract for Tape Runner.
//
// The Flutter app loads this page in a WebView and registers a
// JavascriptChannel called `GameToFlutter`. Messages we send via
// `postToFlutter()` arrive on the Dart side as a JSON string.
//
// Conversely, Flutter calls `window.tapeRunner.init(...)` and
// `window.tapeRunner.pause()` / `.resume()` to push data + lifecycle
// events into the game. We expose those globals from page.tsx.
//
// When this page is loaded in a regular browser tab (e.g. for
// development on localhost) the GameToFlutter channel is absent —
// `postToFlutter` falls back to console.log so the page is still
// usable standalone.

export type PlayerGender = 'male' | 'female' | 'other' | '';

/** Pushed from Flutter into JS once the WebView mounts. */
export type InitPayload = {
  /** Firestore users/{uid}. Echoed back on gameOver for audit. */
  userId?: string;
  playerGender?: PlayerGender;
  /** Caps tipsy effects when true (accessibility). */
  reduceMotion?: boolean;
  /** Live admin tunables from games/runner. */
  settings?: {
    startSpeed?: number;
    maxSpeed?: number;
    speedRamp?: number;
    maxTipsyLevel?: number;
    tipsyDecaySeconds?: number;
  };
};

/** Sent from JS to Flutter the moment the game finishes loading. */
export type ReadyMessage = {
  type: 'ready';
  /** Bump this on incompatible bridge changes. */
  version: 1;
};

/** Sent from JS to Flutter when a run ends. */
export type GameOverMessage = {
  type: 'gameOver';
  distance: number;
  duration: number;
  hits: number;
  water: number;
  coins: number;
  reason: 'blackout' | 'speakerHit' | 'manual';
};

/** Sent from JS to Flutter for debug logging via the bridge. */
export type LogMessage = {
  type: 'log';
  level: 'info' | 'warn' | 'error';
  message: string;
};

export type GameToFlutterMessage =
  | ReadyMessage
  | GameOverMessage
  | LogMessage;

/**
 * Type of the JavascriptChannel Flutter registers under the
 * name `GameToFlutter`. The channel object exposes
 * `postMessage(string)` and that's it.
 */
type FlutterChannel = { postMessage(message: string): void };

declare global {
  interface Window {
    GameToFlutter?: FlutterChannel;
    /** Exposed by page.tsx for Flutter to call into the game. */
    tapeRunner?: {
      init(payload: InitPayload): void;
      pause(): void;
      resume(): void;
      /** Force-end the current run (used for testing during the spike). */
      forceGameOver(): void;
    };
  }
}

export function postToFlutter(message: GameToFlutterMessage): void {
  const channel = window.GameToFlutter;
  if (channel?.postMessage) {
    try {
      channel.postMessage(JSON.stringify(message));
    } catch (e) {
      console.error('[bridge] postMessage failed', e);
    }
  } else {
    // Standalone browser mode — just log so the page is testable
    // without the Flutter wrapper.
    // eslint-disable-next-line no-console
    console.log('[GameToFlutter→]', message);
  }
}
