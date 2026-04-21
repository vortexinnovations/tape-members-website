import { NextResponse } from "next/server";

/**
 * Account-deletion request endpoint.
 *
 * Required for Google Play compliance — the Data Safety section of
 * the Play Console demands a reachable URL where users can request
 * the deletion of their account and associated data. The Play Store
 * HTTP-pings the URL and marks the listing as "Further action
 * required" if it 404s (which is exactly how we ended up here).
 *
 * Flow:
 *   1. User fills the form at `/delete-account`.
 *   2. Browser POSTs JSON here.
 *   3. We validate + forward the request to a private Telegram
 *      group chat so an admin can action it manually (actual
 *      Firestore deletion is a separate path — this endpoint is
 *      intake only, no destructive ops).
 *
 * Telegram credentials live in env vars. In dev drop them into
 * `.env.local`; in prod set them on Vercel:
 *   - TELEGRAM_BOT_TOKEN
 *   - TELEGRAM_DELETE_ACCOUNT_CHAT_ID
 *
 * Both are server-only (no NEXT_PUBLIC_ prefix) so they never ship
 * to the client bundle.
 */

export const runtime = "nodejs";

type DeleteAccountPayload = {
  email?: string;
  fullName?: string;
  phone?: string;
  reason?: string;
  notes?: string;
  acknowledged?: boolean;
};

const TELEGRAM_API = "https://api.telegram.org/bot";

function escapeMarkdown(input: string): string {
  // Telegram MarkdownV2 escapes. We fall back to plain text in the
  // message below (parse_mode not set), so escaping isn't strictly
  // required — but we still strip control characters to keep the
  // payload well-formed if a user pastes weird input.
  return input.replace(/[\u0000-\u001f\u007f]/g, "").trim();
}

export async function POST(request: Request) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_DELETE_ACCOUNT_CHAT_ID;

  if (!botToken || !chatId) {
    // Mis-configured server. Don't expose which env var is missing
    // to the client; log for the operator and return a generic 500.
    console.error(
      "delete-account: missing TELEGRAM_BOT_TOKEN or TELEGRAM_DELETE_ACCOUNT_CHAT_ID",
    );
    return NextResponse.json(
      { ok: false, error: "Server is misconfigured. Please email members@tapemembers.com instead." },
      { status: 500 },
    );
  }

  let payload: DeleteAccountPayload;
  try {
    payload = (await request.json()) as DeleteAccountPayload;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid request body." },
      { status: 400 },
    );
  }

  const email = escapeMarkdown(payload.email ?? "");
  const fullName = escapeMarkdown(payload.fullName ?? "");
  const phone = escapeMarkdown(payload.phone ?? "");
  const reason = escapeMarkdown(payload.reason ?? "");
  const notes = escapeMarkdown(payload.notes ?? "");

  // Minimal validation: we need SOME way to identify the account,
  // and the user must have ticked the confirmation checkbox. We
  // don't strictly require email (a phone-only account exists on
  // the platform) — either is fine so long as at least one is
  // present.
  if (!payload.acknowledged) {
    return NextResponse.json(
      { ok: false, error: "Please tick the confirmation box before submitting." },
      { status: 400 },
    );
  }
  if (!email && !phone) {
    return NextResponse.json(
      { ok: false, error: "Please provide your email or phone number so we can identify your account." },
      { status: 400 },
    );
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json(
      { ok: false, error: "That email address doesn't look right." },
      { status: 400 },
    );
  }

  // Best-effort metadata for triage — helps the admin match the
  // request to a Firestore user doc.
  const userAgent = request.headers.get("user-agent") ?? "unknown";
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    "unknown";
  const submittedAt = new Date().toISOString();

  const lines: string[] = [
    "🗑️ Account Deletion Request",
    "",
    email ? `Email: ${email}` : null,
    fullName ? `Name: ${fullName}` : null,
    phone ? `Phone: ${phone}` : null,
    reason ? `Reason: ${reason}` : null,
    notes ? `Notes: ${notes}` : null,
    "",
    `Submitted: ${submittedAt}`,
    `IP: ${ip}`,
    `UA: ${userAgent.slice(0, 180)}`,
  ].filter((line): line is string => line !== null);
  const text = lines.join("\n");

  try {
    const telegramResp = await fetch(`${TELEGRAM_API}${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
      }),
    });

    if (!telegramResp.ok) {
      const detail = await telegramResp.text().catch(() => "");
      console.error(
        "delete-account: Telegram sendMessage failed",
        telegramResp.status,
        detail.slice(0, 200),
      );
      return NextResponse.json(
        {
          ok: false,
          error:
            "Couldn't forward your request right now. Please try again in a minute, or email members@tapemembers.com.",
        },
        { status: 502 },
      );
    }
  } catch (err) {
    console.error("delete-account: Telegram fetch threw", err);
    return NextResponse.json(
      {
        ok: false,
        error:
          "Couldn't forward your request right now. Please try again in a minute, or email members@tapemembers.com.",
      },
      { status: 502 },
    );
  }

  return NextResponse.json({ ok: true });
}
