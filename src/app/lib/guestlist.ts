// QR guest-list self-add — client/server helpers (May 30, 2026).
//
// Talks to two europe-west2 Cloud Functions:
//   getGuestlistSession  — resolve a QR token → display info + form config
//   submitGuestlistJoin  — Turnstile-gated booking creation
//
// Mirrors the lib/reel.ts pattern: env-overridable base URLs, return
// null on failure so pages render a graceful fallback rather than
// crashing.

const GET_SESSION_URL =
  process.env.NEXT_PUBLIC_GET_GUESTLIST_SESSION_URL ||
  "https://europe-west2-tape-members.cloudfunctions.net/getGuestlistSession";

export const SUBMIT_GUESTLIST_URL =
  process.env.NEXT_PUBLIC_SUBMIT_GUESTLIST_URL ||
  "https://europe-west2-tape-members.cloudfunctions.net/submitGuestlistJoin";

// Public Turnstile site key (safe to ship in client JS). Override via
// env per environment if ever needed.
export const TURNSTILE_SITE_KEY =
  process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ||
  "0x4AAAAAAC7JTrVNzw5PrnMn";

export type GuestlistSession = {
  valid: boolean;
  active: boolean;
  expired: boolean;
  featureEnabled: boolean;
  capReached: boolean;
  eventName: string;
  eventDateDisplay: string;
  locationAddress: string;
  bookerName: string;
  emailMandatory: boolean;
  phoneShown: boolean;
  phoneMandatory: boolean;
  maxGuests: number;
  formTitle: string;
  formSubtitle: string;
  joinButtonLabel: string;
  successTitle: string;
  successMessage: string;
  doorInstruction: string;
  appAdvertEnabled: boolean;
  appAdvertText: string;
};

export type GuestlistSubmitResult = {
  success: boolean;
  mainBookingId: string;
  doorQrData: string;
  partySize: number;
};

/** Resolve a session token → display info. null on any failure. */
export async function fetchGuestlistSession(
  token: string,
): Promise<GuestlistSession | null> {
  try {
    const url = `${GET_SESSION_URL}/${encodeURIComponent(token)}`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    const data: unknown = await res.json();
    const d = data as Partial<GuestlistSession>;
    if (!d || d.valid !== true) return null;
    return {
      valid: true,
      active: d.active ?? true,
      expired: d.expired ?? false,
      featureEnabled: d.featureEnabled ?? true,
      capReached: d.capReached ?? false,
      eventName: d.eventName || "",
      eventDateDisplay: d.eventDateDisplay || "",
      locationAddress: d.locationAddress || "",
      bookerName: d.bookerName || "",
      emailMandatory: d.emailMandatory ?? true,
      phoneShown: d.phoneShown ?? true,
      phoneMandatory: d.phoneMandatory ?? false,
      maxGuests: d.maxGuests ?? 10,
      formTitle: d.formTitle || "Join the guest list",
      formSubtitle: d.formSubtitle || "Add yourself and your guests.",
      joinButtonLabel: d.joinButtonLabel || "Join Guest List",
      successTitle: d.successTitle || "You're on the list!",
      successMessage:
        d.successMessage ||
        "Screenshot the QR code below and show it at the door.",
      doorInstruction: d.doorInstruction || "Show this QR code at the door.",
      appAdvertEnabled: d.appAdvertEnabled ?? true,
      appAdvertText:
        d.appAdvertText ||
        "We've also got an app — earn Tape Coins on every visit and unlock rewards & discounts.",
    };
  } catch (err) {
    console.error("fetchGuestlistSession failed:", err);
    return null;
  }
}
