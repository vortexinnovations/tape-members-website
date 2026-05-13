// Client-side helper for fetching the live Tape Runner admin
// tunables from the `getRunnerSettings` Cloud Function.
//
// The web fetches these on game start so that changing any value
// in /runnerAdmin → Tuning takes effect on the player's next run
// without needing to ship a new Flutter build. The Flutter side
// still forwards its own (whitelisted) subset of settings via the
// bridge for back-compat with older app versions — game.init()
// merges both sources, last-write-wins per field. In practice both
// sources are reading the same `games/runner` Firestore doc, so
// the merged result is identical.
//
// Loaded from page.tsx during component mount, in parallel with
// game construction. The game runs with its built-in defaults
// until the fetch resolves, then init() applies the resolved
// values atop the defaults. Network failure = silent fallback to
// defaults (no error shown to the player).

import type { InitPayload } from './bridge';

/**
 * Override via NEXT_PUBLIC_RUNNER_SETTINGS_URL for local Cloud Fn
 * emulator testing, or to point at a Firebase preview project.
 */
const GET_RUNNER_SETTINGS_URL =
  process.env.NEXT_PUBLIC_RUNNER_SETTINGS_URL ||
  'https://europe-west2-tape-members.cloudfunctions.net/getRunnerSettings';

/**
 * The returned shape matches `InitPayload.settings` exactly — every
 * field optional, every field validated again on the game side.
 * We re-use that type so adding a new admin tunable means touching
 * `bridge.ts` only (and the admin form) — this fetch helper picks
 * it up automatically.
 */
export type RunnerSettings = NonNullable<InitPayload['settings']>;

/**
 * Fetch the live admin settings. Always resolves — never throws.
 * Failure modes (CORS error, network down, function 500) all
 * return {} so the game silently falls back to built-in defaults.
 */
export async function fetchRunnerSettings(): Promise<RunnerSettings> {
  try {
    const res = await fetch(GET_RUNNER_SETTINGS_URL, {
      method: 'GET',
      // No credentials needed — the endpoint is intentionally public.
      // Standard cache control is fine; the Cloud Function sets a
      // 60 s Cache-Control header so browsers + intermediaries
      // dedupe rapid back-to-back loads.
      cache: 'default',
    });
    if (!res.ok) {
      // eslint-disable-next-line no-console
      console.warn(
        `[runner] settings fetch returned ${res.status}; falling back to defaults`,
      );
      return {};
    }
    const data: unknown = await res.json();
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
    // The Cloud Function already filters out non-primitives, but
    // we're crossing a trust boundary — type-narrow the unknown
    // body into our typed view. Any field shaped wrong is dropped
    // on the game side by its individual `typeof v === 'number'`
    // gates anyway.
    return data as RunnerSettings;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[runner] settings fetch threw:', err);
    return {};
  }
}
