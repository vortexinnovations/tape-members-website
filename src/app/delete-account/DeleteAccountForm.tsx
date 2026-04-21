"use client";

import { useState } from "react";

/**
 * Account-deletion request form. Posts to `/api/delete-account`,
 * which forwards to a private Telegram group chat. UX goals:
 *
 *   - Works on a plain phone without any app installed (most users
 *     hitting this page came via a Play Store / App Store link).
 *   - Honest about what happens after submission — we don't pretend
 *     the deletion is instant; it's queued for manual admin review.
 *   - Graceful error messaging with a fallback email path.
 *
 * Fields are intentionally minimal: email OR phone to identify the
 * account, an optional reason/notes for context, and a required
 * tick-box acknowledgement.
 */
export default function DeleteAccountForm() {
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState<
    { kind: "idle" } | { kind: "ok" } | { kind: "error"; message: string }
  >({ kind: "idle" });

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setStatus({ kind: "idle" });

    try {
      const resp = await fetch("/api/delete-account", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email.trim(),
          fullName: fullName.trim(),
          phone: phone.trim(),
          reason: reason.trim(),
          notes: notes.trim(),
          acknowledged,
        }),
      });

      const data = (await resp.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };

      if (!resp.ok || !data.ok) {
        setStatus({
          kind: "error",
          message:
            data.error ??
            "Something went wrong. Please try again or email members@tapemembers.com.",
        });
      } else {
        setStatus({ kind: "ok" });
      }
    } catch {
      setStatus({
        kind: "error",
        message:
          "Couldn't reach the server. Check your connection and try again.",
      });
    } finally {
      setSubmitting(false);
    }
  }

  if (status.kind === "ok") {
    return (
      <div className="flex flex-col items-center gap-4 text-center">
        <div className="text-5xl">✓</div>
        <h2 className="font-tape text-2xl font-bold tracking-[0.1em] uppercase">
          Request received
        </h2>
        <p className="max-w-md text-white/80">
          Thank you. A member of our team will process your deletion request
          within 30 days and email you at{" "}
          <span className="font-semibold text-white">
            {email || "the address on file"}
          </span>{" "}
          once complete. If you need to reach us in the meantime, email{" "}
          <a
            href="mailto:members@tapemembers.com"
            className="underline underline-offset-2"
          >
            members@tapemembers.com
          </a>
          .
        </p>
      </div>
    );
  }

  const inputBase =
    "w-full rounded-lg border border-white/25 bg-white/5 px-4 py-3 text-white placeholder-white/40 outline-none transition focus:border-white/60 focus:bg-white/10";

  return (
    <form onSubmit={handleSubmit} className="flex w-full flex-col gap-4">
      <div>
        <label className="mb-1.5 block text-xs font-semibold tracking-wide text-white/70 uppercase">
          Email <span className="text-white/40">(on your account)</span>
        </label>
        <input
          type="email"
          inputMode="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className={inputBase}
          placeholder="you@example.com"
        />
      </div>

      <div>
        <label className="mb-1.5 block text-xs font-semibold tracking-wide text-white/70 uppercase">
          Full name <span className="text-white/40">(optional)</span>
        </label>
        <input
          type="text"
          autoComplete="name"
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          className={inputBase}
          placeholder="Jane Doe"
        />
      </div>

      <div>
        <label className="mb-1.5 block text-xs font-semibold tracking-wide text-white/70 uppercase">
          Phone number <span className="text-white/40">(optional)</span>
        </label>
        <input
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          className={inputBase}
          placeholder="+44 7…"
        />
      </div>

      <div>
        <label className="mb-1.5 block text-xs font-semibold tracking-wide text-white/70 uppercase">
          Reason <span className="text-white/40">(optional)</span>
        </label>
        <input
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className={inputBase}
          placeholder="e.g. No longer attending"
        />
      </div>

      <div>
        <label className="mb-1.5 block text-xs font-semibold tracking-wide text-white/70 uppercase">
          Additional notes <span className="text-white/40">(optional)</span>
        </label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          className={`${inputBase} resize-y`}
          placeholder="Anything else we should know?"
        />
      </div>

      <label className="mt-2 flex cursor-pointer items-start gap-3 rounded-lg border border-white/15 bg-white/5 px-4 py-3 text-sm text-white/85 transition hover:bg-white/10">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(e) => setAcknowledged(e.target.checked)}
          className="mt-0.5 h-4 w-4 shrink-0 accent-white"
        />
        <span>
          I understand that my Tape Members account, profile, booking
          history, and related data will be permanently deleted. Legal and
          financial records (e.g. payment receipts) may be retained for the
          period required by law.
        </span>
      </label>

      {status.kind === "error" ? (
        <p className="rounded-lg border border-red-400/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {status.message}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={submitting}
        className="mt-2 rounded-lg bg-white px-5 py-3 font-semibold text-black uppercase tracking-[0.12em] transition disabled:cursor-not-allowed disabled:opacity-60 hover:bg-white/90"
      >
        {submitting ? "Submitting…" : "Request account deletion"}
      </button>

      <p className="text-center text-xs text-white/50">
        Prefer email? Write to{" "}
        <a
          href="mailto:members@tapemembers.com"
          className="underline underline-offset-2"
        >
          members@tapemembers.com
        </a>
        .
      </p>
    </form>
  );
}
