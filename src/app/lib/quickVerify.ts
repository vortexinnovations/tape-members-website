/**
 * Quick Verify (tapemembers.com/verify): the pure half. No Firebase, no
 * React. The plan and every decision live in the app repo:
 * docs/QUICK_VERIFY_PLAN.md.
 *
 * A guest at the door makes a Tape account, gives their address, scans
 * their ID with Sumsub and gets the QR the door scans, with no app.
 * The backend (backend/functions/quickVerify.js) is the authority for
 * everything: whether it is open, the email code, the address, the ID
 * result. This page only asks and shows.
 *
 * MIRRORS, change both or neither:
 *   - PUBLIC_DEFAULTS + openState()  <->  quickVerify.js
 *   - DEFAULT_TEXT keys              <->  the admin page's word editor
 *     (lib/pages/admin/quick_verify/, phase 3). The admin saves
 *     overrides under `text` in quickVerifyConfig/public.
 */

export const QV_ACTIONS = "quickVerifyActions";
export const QV_CONFIG = "quickVerifyConfig";

/** quickVerifyConfig/public, resolved over the defaults. */
export type PublicConfig = {
  enabled: boolean;
  /** ISO weekdays of the NIGHT (1 Mon .. 7 Sun). */
  days: number[];
  /** UK minutes after midnight; end <= start means the next morning. */
  startMinutes: number;
  endMinutes: number;
  requireEmailCode: boolean;
  consentEnabled: boolean;
  text: Record<TextKey, string>;
};

export const PUBLIC_DEFAULTS = {
  enabled: false,
  days: [2, 5, 6, 7],
  startMinutes: 21 * 60,
  endMinutes: 4 * 60,
  requireEmailCode: true,
  consentEnabled: true,
} as const;

/** Every word on the page. Placeholders: {email}. */
export const DEFAULT_TEXT = {
  startTitle: "Quick ID check",
  startBody:
    "Make your Tape account and verify your ID. It takes a couple of minutes.",
  emailLabel: "Email",
  passwordLabel: "Password",
  passwordHint: "At least 8 characters. You'll use this to sign in to the app.",
  startButton: "Continue",
  existingAccount:
    "You already have a Tape account with this email. Enter its password to carry on.",
  forgotPassword: "Forgot password?",
  resetSent: "We've emailed you a link to reset your password.",
  codeTitle: "Check your email",
  codeBody: "We sent a 6-digit code to {email}.",
  codeButton: "Confirm",
  resendCode: "Send a new code",
  codeResent: "New code sent.",
  addressTitle: "Your address",
  addressBody: "We need this for our licence.",
  line1Label: "Address line 1",
  line2Label: "Address line 2 (optional)",
  townLabel: "Town or city",
  postcodeLabel: "Postcode",
  countryLabel: "Country",
  ageTitle: "How old are you?",
  under21: "Under 21",
  over21: "21 or over",
  ageBody:
    "We use a different ID check for each. It does not affect whether you can verify.",
  consentLabel: "Email me about getting the Tape Members app",
  addressButton: "Continue to ID check",
  idTitle: "Verify your ID",
  idBodyAny: "Have your passport, driving licence or ID card ready.",
  idBodyPassport: "Have your passport ready. Under 21s verify with a passport.",
  changeToOver21: "I'm 21 or over",
  changeToUnder21: "I'm under 21",
  idFallbackButton: "Open the ID check",
  idFallbackBody: "The ID check opens in a new tab. Come back here when you're done.",
  inAppBrowser:
    "If the camera doesn't open, open this page in Safari or Chrome.",
  passportTitle: "We need your passport",
  passportBody:
    "Your ID shows you are under 21. Under 21s verify with a passport.",
  passportButton: "Scan my passport",
  verifiedTitle: "You're verified",
  verifiedBody: "Show this code at the door.",
  appTitle: "Get the app",
  appBody:
    "Sign in with the same email and password to finish your profile, book ahead and earn Tape Coins.",
  existingTitle: "You already have an account",
  existingBody:
    "Your ID matches a Tape account under {email}. Please sign in with that one.",
  existingBodyNoEmail:
    "Your ID matches an existing Tape account. Please sign in with that one, or speak to the door staff.",
  underAgeTitle: "Sorry",
  underAgeBody: "Your ID shows you are under the minimum age for Tape.",
  closedTitle: "Get the app",
  closedBody:
    "Quick ID check isn't available right now. Download the Tape Members app to join.",
  closedSignIn: "Already started? Sign in",
  continueTitle: "Carry on",
  continueBody: "Tap continue to pick up where you left off.",
  continueButton: "Continue",
  signOut: "Not you? Sign out",
} as const;

export type TextKey = keyof typeof DEFAULT_TEXT;

/** {tokens} filled; unknown tokens left as they are. */
export function fill(template: string, ctx: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) =>
    ctx[k] !== undefined ? ctx[k] : m,
  );
}

function intIn(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= lo && n <= hi ? n : dflt;
}

/** The stored doc over the defaults; anything unreadable falls back. */
export function resolvePublicConfig(raw: unknown): PublicConfig {
  const p = (raw && typeof raw === "object" ? raw : {}) as Record<
    string,
    unknown
  >;
  const text = { ...DEFAULT_TEXT } as Record<TextKey, string>;
  const stored = (p.text && typeof p.text === "object" ? p.text : {}) as Record<
    string,
    unknown
  >;
  for (const k of Object.keys(DEFAULT_TEXT) as TextKey[]) {
    const v = stored[k];
    if (typeof v === "string" && v.trim()) text[k] = v;
  }
  const days = Array.isArray(p.days)
    ? [
        ...new Set(
          p.days
            .map((d) => Math.round(Number(d)))
            .filter((d) => d >= 1 && d <= 7),
        ),
      ]
    : [...PUBLIC_DEFAULTS.days];
  return {
    enabled: typeof p.enabled === "boolean" ? p.enabled : PUBLIC_DEFAULTS.enabled,
    days,
    startMinutes: intIn(p.startMinutes, 0, 1439, PUBLIC_DEFAULTS.startMinutes),
    endMinutes: intIn(p.endMinutes, 0, 1439, PUBLIC_DEFAULTS.endMinutes),
    requireEmailCode:
      typeof p.requireEmailCode === "boolean"
        ? p.requireEmailCode
        : PUBLIC_DEFAULTS.requireEmailCode,
    consentEnabled:
      typeof p.consentEnabled === "boolean"
        ? p.consentEnabled
        : PUBLIC_DEFAULTS.consentEnabled,
    text,
  };
}

/** UK ISO weekday and minutes after midnight at an instant. */
export function ukParts(ms: number): { weekday: number; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((x) => x.type === t)?.value ?? "";
  return {
    weekday:
      ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(
        get("weekday"),
      ) + 1,
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

/**
 * Is it open right now? Only decides which screen to show first: the
 * backend decides again on every request. The night is the day the
 * window STARTED on, so 01:00 on Saturday in a 21:00 to 04:00 window is
 * Friday's night.
 */
export function isOpenNow(cfg: PublicConfig, nowMs: number): boolean {
  if (!cfg.enabled) return false;
  const now = ukParts(nowMs);
  const s = cfg.startMinutes;
  const e = cfg.endMinutes;
  let nightWeekday = 0;
  if (e <= s) {
    if (now.minutes >= s) nightWeekday = now.weekday;
    else if (now.minutes < e) nightWeekday = ukParts(nowMs - 86400000).weekday;
  } else if (now.minutes >= s && now.minutes < e) {
    nightWeekday = now.weekday;
  }
  return nightWeekday > 0 && cfg.days.includes(nightWeekday);
}

/** The parts of the guest's own user doc this page reads. */
export type QvUserDoc = {
  first_name?: string;
  last_name?: string;
  idverified?: boolean;
  duplicate?: boolean;
  duplicateOfEmailMasked?: string;
  user_deleted_account?: boolean;
  sumsubPassportRequired?: boolean;
  sumsubReviewAnswer?: string;
  sumsubRejectLabels?: string[];
  quickVerify?: {
    stage?: string;
    saidUnder21?: boolean;
    /** An admin said "not the same person": the stop no longer applies. */
    cleared?: boolean;
  };
};

export type Stage =
  | "start" // signed in, the backend has not been asked yet
  | "email"
  | "address"
  | "id"
  | "verified"
  | "existing_member"
  | "under_age"
  | "deleted";

/** Where a signed-in guest is, from their own user doc. */
export function stageFrom(u: QvUserDoc | null): Stage {
  if (!u) return "start";
  if (u.user_deleted_account === true) return "deleted";
  if (u.duplicate === true) return "existing_member";
  if (u.idverified === true) return "verified";
  const s = u.quickVerify?.stage;
  // Sumsub's own duplicate check: the same document is already on another
  // account. The backend sets the stage (and the masked email when it
  // found a live account); the Sumsub labels on the guest's own doc say
  // the same a moment sooner.
  if (
    s === "existing_member" ||
    (u.quickVerify?.cleared !== true &&
      u.sumsubReviewAnswer === "RED" &&
      Array.isArray(u.sumsubRejectLabels) &&
      u.sumsubRejectLabels.some((l) => String(l).toUpperCase() === "DUPLICATE"))
  ) {
    return "existing_member";
  }
  if (s === "under_age") return "under_age";
  if (s === "email" || s === "address" || s === "id") return s;
  // `verified` without the flag, or
  // no map at all: ask the backend where they are.
  return "start";
}

/** What the page says for each error the backend (or the page) reports. */
export function errorText(code: string): string {
  switch (code) {
    case "closed":
      return "Quick ID check has closed. Download the Tape Members app to carry on.";
    case "bot_check":
      return "We couldn't confirm you're a person. Wait a moment and try again.";
    case "busy":
      return "It's busy right now. Please try again in a minute.";
    case "too_many_codes":
      return "Too many codes sent. Please wait a while and try again.";
    case "email_failed":
      return "We couldn't send the email. Check the address and try again.";
    case "no_code":
    case "code_expired":
      return "That code has expired. Send a new one.";
    case "wrong_code":
      return "That code isn't right. Check it and try again.";
    case "too_many_attempts":
      return "Too many wrong codes. Send a new one.";
    case "email_not_verified":
      return "Please confirm your email first.";
    case "bad_address":
      return "Please fill in your address, town, postcode and country.";
    case "age_choice":
      return "Please choose Under 21 or 21 or over.";
    case "too_many_tries":
      return "Too many tries tonight. Please speak to the door staff.";
    case "id_unavailable":
      return "The ID check isn't loading. Please try again in a moment.";
    case "duplicate_account":
      return "This account can't be used here. Sign in with your main Tape account.";
    case "account_deleted":
      return "This account was deleted. Open the Tape Members app to restore it.";
    case "timeout":
      return "That took too long. Check your connection and try again.";
    default:
      return "Something went wrong. Please try again.";
  }
}

/** A Firebase Auth error, in words. */
export function authErrorText(code: string): string {
  switch (code) {
    case "auth/invalid-email":
      return "That email address doesn't look right.";
    case "auth/weak-password":
    case "auth/password-does-not-meet-requirements":
      return "Please choose a stronger password (at least 8 characters).";
    case "auth/too-many-requests":
      return "Too many tries. Please wait a few minutes and try again.";
    case "auth/network-request-failed":
      return "No connection. Check your signal and try again.";
    case "auth/user-disabled":
      return "This account is disabled. Please speak to the door staff.";
    default:
      return "We couldn't sign you in. Please try again.";
  }
}

/** Apps whose built-in browser often blocks the camera. */
export function isInAppBrowser(userAgent: string): boolean {
  return /FBAN|FBAV|Instagram|TikTok|Snapchat|Line\/|MicroMessenger/i.test(
    userAgent,
  );
}
