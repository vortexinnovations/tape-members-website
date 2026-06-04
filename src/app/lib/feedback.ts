// QR table-feedback — client/server helpers (June 4, 2026).
//
// Talks to two europe-west2 Cloud Functions:
//   getFeedbackQrSession — resolve a QR token → session info + the live
//                          (admin-editable) question set + copy
//   submitFeedbackQr     — Turnstile-gated response submission
//
// Mirrors lib/guestlist.ts: env-overridable base URLs, return null on
// failure so the page renders a graceful fallback rather than crashing.

const GET_FEEDBACK_SESSION_URL =
  process.env.NEXT_PUBLIC_GET_FEEDBACK_QR_SESSION_URL ||
  "https://europe-west2-tape-members.cloudfunctions.net/getFeedbackQrSession";

export const SUBMIT_FEEDBACK_URL =
  process.env.NEXT_PUBLIC_SUBMIT_FEEDBACK_QR_URL ||
  "https://europe-west2-tape-members.cloudfunctions.net/submitFeedbackQr";

// Public Turnstile site key (safe to ship in client JS) — domain-bound
// to tapemembers.com, the same key the guest-list form uses.
export const TURNSTILE_SITE_KEY =
  process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || "0x4AAAAAAC7JTrVNzw5PrnMn";

export type FeedbackQuestionType =
  | "rating"
  | "scale"
  | "singleChoice"
  | "multiChoice"
  | "shortText"
  | "longText"
  | "yesNo";

export type FeedbackQuestion = {
  id: string;
  type: FeedbackQuestionType;
  label: string;
  hint: string;
  required: boolean;
  maxRating?: number;
  scaleMin?: number;
  scaleMax?: number;
  scaleMinLabel?: string;
  scaleMaxLabel?: string;
  options?: string[];
};

export type FeedbackSession = {
  valid: boolean;
  active: boolean;
  expired: boolean;
  featureEnabled: boolean;
  capReached: boolean;
  eventName: string;
  eventDateDisplay: string;
  clientName: string;
  tableNumber: string;
  title: string;
  intro: string;
  submitLabel: string;
  thankYouTitle: string;
  thankYouBody: string;
  emailCaptureEnabled: boolean;
  emailLabel: string;
  marketingConsentText: string;
  questions: FeedbackQuestion[];
};

const VALID_TYPES: FeedbackQuestionType[] = [
  "rating",
  "scale",
  "singleChoice",
  "multiChoice",
  "shortText",
  "longText",
  "yesNo",
];

function coerceQuestions(raw: unknown): FeedbackQuestion[] {
  if (!Array.isArray(raw)) return [];
  const out: FeedbackQuestion[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const q = item as Record<string, unknown>;
    const type = VALID_TYPES.includes(q.type as FeedbackQuestionType)
      ? (q.type as FeedbackQuestionType)
      : "shortText";
    out.push({
      id: String(q.id ?? ""),
      type,
      label: String(q.label ?? ""),
      hint: String(q.hint ?? ""),
      required: q.required === true,
      maxRating: typeof q.maxRating === "number" ? q.maxRating : undefined,
      scaleMin: typeof q.scaleMin === "number" ? q.scaleMin : undefined,
      scaleMax: typeof q.scaleMax === "number" ? q.scaleMax : undefined,
      scaleMinLabel:
        typeof q.scaleMinLabel === "string" ? q.scaleMinLabel : undefined,
      scaleMaxLabel:
        typeof q.scaleMaxLabel === "string" ? q.scaleMaxLabel : undefined,
      options: Array.isArray(q.options)
        ? q.options.map((o) => String(o)).filter((o) => o.length > 0)
        : undefined,
    });
  }
  return out.filter((q) => q.id.length > 0 && q.label.length > 0);
}

/** Resolve a session token → session info + questions. null on failure. */
export async function fetchFeedbackSession(
  token: string,
): Promise<FeedbackSession | null> {
  try {
    const url = `${GET_FEEDBACK_SESSION_URL}/${encodeURIComponent(token)}`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    const data: unknown = await res.json();
    const d = data as Partial<FeedbackSession> & Record<string, unknown>;
    if (!d || d.valid !== true) return null;
    return {
      valid: true,
      active: d.active ?? true,
      expired: d.expired ?? false,
      featureEnabled: d.featureEnabled ?? true,
      capReached: d.capReached ?? false,
      eventName: typeof d.eventName === "string" ? d.eventName : "",
      eventDateDisplay:
        typeof d.eventDateDisplay === "string" ? d.eventDateDisplay : "",
      clientName: typeof d.clientName === "string" ? d.clientName : "",
      tableNumber: typeof d.tableNumber === "string" ? d.tableNumber : "",
      title: typeof d.title === "string" ? d.title : "How was your evening?",
      intro: typeof d.intro === "string" ? d.intro : "",
      submitLabel:
        typeof d.submitLabel === "string" ? d.submitLabel : "Submit feedback",
      thankYouTitle:
        typeof d.thankYouTitle === "string" ? d.thankYouTitle : "Thank you",
      thankYouBody: typeof d.thankYouBody === "string" ? d.thankYouBody : "",
      emailCaptureEnabled: d.emailCaptureEnabled ?? true,
      emailLabel:
        typeof d.emailLabel === "string" ? d.emailLabel : "Email (optional)",
      marketingConsentText:
        typeof d.marketingConsentText === "string"
          ? d.marketingConsentText
          : "",
      questions: coerceQuestions(d.questions),
    };
  } catch (err) {
    console.error("fetchFeedbackSession failed:", err);
    return null;
  }
}
