// Browser-only leaderboard — client helpers (Aug 9, 2026).
//
// When tapemembers.com/runner is opened in a plain browser tab
// (no Flutter WebView → no GameToFlutter channel), runs land on a
// SEPARATE web leaderboard instead of the app one. Players are
// identified by a first-party cookie UUID ("wid") minted here; the
// backend stamps a country flag from the request IP.
//
// Talks to two europe-west2 Cloud Functions:
//   submitRunnerWebScore    — Turnstile-gated score submission
//   getRunnerWebLeaderboard — top-50 weekly + all-time boards
//
// NONE of this ever runs inside the Flutter app: the overlay that
// calls these helpers renders only when the WebView bridge channel
// is absent, and the backend collections involved are disjoint
// from the app's runnerScoreSubmissions / runnerLeaderboard* set.

export const SUBMIT_RUNNER_WEB_SCORE_URL =
  process.env.NEXT_PUBLIC_SUBMIT_RUNNER_WEB_SCORE_URL ||
  'https://europe-west2-tape-members.cloudfunctions.net/submitRunnerWebScore';

export const GET_RUNNER_WEB_LEADERBOARD_URL =
  process.env.NEXT_PUBLIC_GET_RUNNER_WEB_LEADERBOARD_URL ||
  'https://europe-west2-tape-members.cloudfunctions.net/getRunnerWebLeaderboard';

// Public Turnstile site key — domain-bound to tapemembers.com, the
// same key the guest-list + feedback forms use. Safe in client JS.
export const TURNSTILE_SITE_KEY =
  process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || '0x4AAAAAAC7JTrVNzw5PrnMn';

const WID_COOKIE = 'tape_runner_wid';
const ALIAS_KEY = 'tape_runner_alias';

/**
 * Stable per-browser player id. Cookie-first (400-day max-age —
 * Chrome's hard cap) with a localStorage mirror so a blocked or
 * evicted cookie doesn't reset the player's identity. Clearing
 * site data DOES mint a fresh id — inherent to cookie identity,
 * and fine for a casual public board.
 */
export function getWid(): string {
  if (typeof document === 'undefined') return '';
  const fromCookie = readCookie(WID_COOKIE);
  const fromStorage = safeStorageGet(WID_COOKIE);
  let wid = fromCookie || fromStorage || '';
  if (!/^[a-zA-Z0-9_-]{8,64}$/.test(wid)) wid = mintWid();
  // Re-write both stores every visit — refreshes the cookie's
  // 400-day clock and heals whichever store was missing.
  writeCookie(WID_COOKIE, wid);
  safeStorageSet(WID_COOKIE, wid);
  return wid;
}

function mintWid(): string {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID().replace(/-/g, '');
    }
  } catch {
    /* fall through */
  }
  let s = '';
  for (let i = 0; i < 32; i++) {
    s += Math.floor(Math.random() * 16).toString(16);
  }
  return s;
}

function readCookie(name: string): string {
  const m = document.cookie.match(
    new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'),
  );
  return m ? decodeURIComponent(m[1]) : '';
}

function writeCookie(name: string, value: string) {
  try {
    const maxAge = 400 * 24 * 60 * 60; // Chrome caps cookies at 400 days
    document.cookie =
      `${name}=${encodeURIComponent(value)}; Max-Age=${maxAge}; ` +
      'Path=/; SameSite=Lax; Secure';
  } catch {
    /* no-op — storage mirror still works */
  }
}

function safeStorageGet(key: string): string {
  try {
    return window.localStorage.getItem(key) || '';
  } catch {
    return '';
  }
}

function safeStorageSet(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* no-op */
  }
}

// Players can't choose their own name — the backend derives a
// stable random-looking alias from the wid (e.g. "Midnight Fox
// 1234") and returns it on every submit. We cache it locally only
// so the UI can say "playing as …" before the first fetch.
export function getSavedAlias(): string {
  return safeStorageGet(ALIAS_KEY);
}

export function saveAlias(alias: string) {
  if (alias) safeStorageSet(ALIAS_KEY, alias.slice(0, 40));
}

/** ISO-3166 alpha-2 → flag emoji. Unknown/empty → globe. */
export function flagEmoji(countryCode: string): string {
  const cc = (countryCode || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return '\u{1F30D}';
  const base = 0x1f1e6; // REGIONAL INDICATOR SYMBOL LETTER A
  return (
    String.fromCodePoint(base + cc.charCodeAt(0) - 65) +
    String.fromCodePoint(base + cc.charCodeAt(1) - 65)
  );
}

export type WebLeaderboardEntry = {
  wid: string;
  nickname: string;
  countryCode: string;
  score: number;
  distance: number;
};

export type WebLeaderboardYou = {
  weekly: { score: number; rank: number } | null;
  allTime: { score: number; rank: number } | null;
};

export type WebLeaderboardData = {
  weekKey: string;
  weekly: WebLeaderboardEntry[];
  allTime: WebLeaderboardEntry[];
  you: WebLeaderboardYou | null;
};

/** Always resolves — null on any failure (graceful empty state). */
export async function fetchWebLeaderboard(
  wid: string,
): Promise<WebLeaderboardData | null> {
  try {
    const url =
      GET_RUNNER_WEB_LEADERBOARD_URL +
      (wid ? `?wid=${encodeURIComponent(wid)}` : '');
    const res = await fetch(url, { method: 'GET' });
    if (!res.ok) return null;
    const d = (await res.json()) as Partial<WebLeaderboardData>;
    const rows = (raw: unknown): WebLeaderboardEntry[] =>
      Array.isArray(raw)
        ? raw.map((r) => ({
            wid: String((r as Record<string, unknown>).wid || ''),
            nickname: String(
              (r as Record<string, unknown>).nickname || 'Guest',
            ),
            countryCode: String(
              (r as Record<string, unknown>).countryCode || '',
            ),
            score: Number((r as Record<string, unknown>).score) || 0,
            distance: Number((r as Record<string, unknown>).distance) || 0,
          }))
        : [];
    return {
      weekKey: String(d.weekKey || ''),
      weekly: rows(d.weekly),
      allTime: rows(d.allTime),
      you: (d.you as WebLeaderboardYou) || null,
    };
  } catch {
    return null;
  }
}

export type SubmitWebScorePayload = {
  wid: string;
  turnstileToken: string;
  score: number;
  distance: number;
  duration: number;
  bottlesCollected: number;
  watersUsed: number;
  peakCombo: number;
  reason: string;
};

export type SubmitWebScoreResult = {
  ok: boolean;
  error?: string;
  nickname?: string;
  countryCode?: string;
  newWeeklyBest?: boolean;
  newAllTimeBest?: boolean;
  weeklyBest?: number;
  allTimeBest?: number;
  weeklyRank?: number;
  allTimeRank?: number;
};

export async function submitWebScore(
  payload: SubmitWebScorePayload,
): Promise<SubmitWebScoreResult> {
  try {
    const res = await fetch(SUBMIT_RUNNER_WEB_SCORE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const d = (await res.json().catch(() => ({}))) as SubmitWebScoreResult & {
      error?: string;
    };
    if (!res.ok) {
      return { ok: false, error: d.error || `submit failed (${res.status})` };
    }
    return { ...d, ok: true };
  } catch {
    return { ok: false, error: 'Network error — please try again.' };
  }
}
