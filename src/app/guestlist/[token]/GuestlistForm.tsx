"use client";

import { useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";

import AppInstallButton from "../../components/AppInstallButton";
import {
  SUBMIT_GUESTLIST_URL,
  TURNSTILE_SITE_KEY,
  type GuestlistSession,
  type GuestlistSubmitResult,
} from "../../lib/guestlist";

declare global {
  interface Window {
    turnstile?: {
      render: (el: HTMLElement, opts: Record<string, unknown>) => string;
      reset: (id?: string) => void;
      remove: (id?: string) => void;
    };
  }
}

const inputBase =
  "w-full rounded-lg border border-white/25 bg-white/5 px-4 py-3 text-white placeholder-white/40 outline-none transition focus:border-white/60 focus:bg-white/10";

/** Title-case a name: first letter of each word uppercase, the rest
 *  lowercase. Handles spaces, hyphens, apostrophes and accented
 *  letters — e.g. "josé o'brien-smith" -> "José O'Brien-Smith". */
function titleCaseName(s: string): string {
  return s
    .toLowerCase()
    .replace(/(?:^|[\s'-])\p{L}/gu, (m) => m.toUpperCase());
}

export default function GuestlistForm({
  token,
  session,
  prefillEmail,
}: {
  token: string;
  session: GuestlistSession;
  prefillEmail: string;
}) {
  const [fullName, setFullName] = useState("");
  const [guests, setGuests] = useState<string[]>([]);
  const [email, setEmail] = useState(prefillEmail);
  const [phone, setPhone] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<GuestlistSubmitResult | null>(null);

  // ── Turnstile (manual explicit render — no npm dep) ──
  const widgetRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  const [tsToken, setTsToken] = useState("");

  useEffect(() => {
    let cancelled = false;
    const SCRIPT_ID = "cf-turnstile-script";
    const render = () => {
      if (cancelled || !window.turnstile || !widgetRef.current) return;
      if (widgetIdRef.current) return; // already rendered
      widgetIdRef.current = window.turnstile.render(widgetRef.current, {
        sitekey: TURNSTILE_SITE_KEY,
        theme: "dark",
        // Stealth: run silently in the background and only render a
        // visible challenge if Cloudflare decides interaction is
        // genuinely required (bot-suspicious). For the vast majority of
        // real guests the widget stays invisible and the token arrives
        // automatically via `callback`. Matches the managed-widget
        // behaviour on the other Tape sites.
        appearance: "interaction-only",
        callback: (t: string) => setTsToken(t),
        "error-callback": () => setTsToken(""),
        "expired-callback": () => setTsToken(""),
      });
    };
    if (window.turnstile) {
      render();
    } else if (!document.getElementById(SCRIPT_ID)) {
      const s = document.createElement("script");
      s.id = SCRIPT_ID;
      s.src =
        "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      s.async = true;
      s.defer = true;
      s.onload = render;
      document.head.appendChild(s);
    } else {
      const iv = setInterval(() => {
        if (window.turnstile) {
          clearInterval(iv);
          render();
        }
      }, 200);
      setTimeout(() => clearInterval(iv), 10000);
    }
    return () => {
      cancelled = true;
    };
  }, []);

  const resetTurnstile = () => {
    try {
      window.turnstile?.reset(widgetIdRef.current ?? undefined);
    } catch {
      /* no-op */
    }
    setTsToken("");
  };

  const canAddGuest = guests.length < session.maxGuests;

  async function onSubmit(ev: React.FormEvent) {
    ev.preventDefault();
    setError("");
    if (!fullName.trim()) {
      setError("Please enter your name.");
      return;
    }
    if (session.emailMandatory && !email.trim()) {
      setError("Please enter your email address.");
      return;
    }
    if (session.phoneShown && session.phoneMandatory && !phone.trim()) {
      setError("Please enter your phone number.");
      return;
    }
    if (!tsToken) {
      // Stealth Turnstile usually resolves silently in <1s; if the user
      // submits before it lands (or a challenge is showing), nudge them
      // to retry rather than point at a widget that may be invisible.
      setError("Just a moment — verifying you're human. Please try again.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(SUBMIT_GUESTLIST_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          fullName: titleCaseName(fullName.trim()),
          guestNames: guests
            .map((g) => titleCaseName(g.trim()))
            .filter(Boolean),
          email: email.trim(),
          phone: phone.trim(),
          turnstileToken: tsToken,
          addSource: prefillEmail ? "qr_invite" : "qr_self",
        }),
      });
      const data = (await res.json().catch(() => ({}))) as Partial<
        GuestlistSubmitResult & { error: string }
      >;
      if (!res.ok || !data.success) {
        setError(data.error || "Something went wrong. Please try again.");
        resetTurnstile();
        return;
      }
      setResult({
        success: true,
        mainBookingId: data.mainBookingId || "",
        doorQrData: data.doorQrData || "",
        partySize: data.partySize || 1,
      });
    } catch {
      setError("Network error. Please try again.");
      resetTurnstile();
    } finally {
      setSubmitting(false);
    }
  }

  // ── Success ──
  if (result) {
    const names = [
      titleCaseName(fullName.trim()),
      ...guests.map((g) => titleCaseName(g.trim())).filter(Boolean),
    ].filter(Boolean);
    const hasEventDetails =
      !!session.eventName ||
      !!session.eventDateDisplay ||
      !!session.locationAddress;
    return (
      <div className="rounded-3xl border border-white/10 bg-black/55 p-8 text-center backdrop-blur-md shadow-[0_20px_60px_rgba(0,0,0,0.55)]">
        <h1 className="font-tape text-xl uppercase tracking-[0.15em] text-white">
          {session.successTitle}
        </h1>
        <p className="mt-3 text-sm font-light leading-relaxed text-white/75">
          {session.successMessage}
        </p>

        {/* Event details — same block as the form top. */}
        {hasEventDetails && (
          <div className="mt-5 space-y-1 rounded-xl border border-white/10 bg-white/5 p-4 text-left text-sm">
            {session.eventName ? (
              <div className="font-semibold text-white">
                {session.eventName}
              </div>
            ) : null}
            {session.eventDateDisplay ? (
              <div className="text-white/70">{session.eventDateDisplay}</div>
            ) : null}
            {session.locationAddress ? (
              <div className="text-white/60">{session.locationAddress}</div>
            ) : null}
          </div>
        )}

        <div className="mt-6 flex justify-center">
          <div className="rounded-2xl bg-white p-4 shadow-lg">
            <QRCodeSVG value={result.doorQrData} size={200} level="M" />
          </div>
        </div>
        <p className="mt-4 text-xs font-medium uppercase tracking-wide text-[#cb775a]">
          {session.doorInstruction}
        </p>

        {/* Directions — Google Maps universal directions URL (opens the
            Maps app on mobile if installed, the web otherwise). */}
        {session.locationAddress ? (
          <div className="mt-5">
            <a
              href={`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(
                session.locationAddress,
              )}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-lg bg-[#cb775a] px-6 py-3 text-sm font-semibold text-black transition hover:opacity-90 active:opacity-80"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
                <circle cx="12" cy="10" r="3" />
              </svg>
              Get directions
            </a>
          </div>
        ) : null}

        {/* Names on the list — numbered, in submission order. Fixed
            right-aligned number column so every name starts at the
            same x and the list reads as a tidy column. */}
        {names.length > 0 && (
          <div className="mt-4">
            <p className="text-[11px] uppercase tracking-wide text-white/40">
              On the list
            </p>
            <ol className="mt-1.5 inline-block space-y-1 text-left">
              {names.map((n, i) => (
                <li key={i} className="flex items-baseline gap-2.5">
                  <span className="w-7 shrink-0 text-right text-sm font-light tabular-nums text-white/40">
                    {i + 1})
                  </span>
                  <span className="text-sm font-light text-white/90">{n}</span>
                </li>
              ))}
            </ol>
          </div>
        )}

        {/* Make another booking — back to a fresh form (same link). */}
        <div className="mt-6">
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-lg border border-[#cb775a] px-5 py-2.5 text-sm font-semibold text-[#cb775a] transition hover:bg-[#cb775a]/10 active:opacity-80"
          >
            + Make another booking
          </button>
        </div>

        {session.appAdvertEnabled && (
          <div className="mt-8 border-t border-white/10 pt-6">
            <p className="mb-4 text-sm font-light text-white/70">
              {session.appAdvertText}
            </p>
            <div className="flex justify-center">
              <AppInstallButton />
            </div>
          </div>
        )}
      </div>
    );
  }

  // ── Form ──
  return (
    <div className="rounded-3xl border border-white/10 bg-black/55 p-7 backdrop-blur-md shadow-[0_20px_60px_rgba(0,0,0,0.55)]">
      <h1 className="font-tape text-xl uppercase tracking-[0.15em] text-white">
        {session.formTitle}
      </h1>
      <p className="mt-2 text-sm font-light leading-relaxed text-white/70">
        {session.formSubtitle}
      </p>

      {/* Event context */}
      <div className="mt-5 space-y-1 rounded-xl border border-white/10 bg-white/5 p-4 text-sm">
        {session.eventName ? (
          <div className="font-semibold text-white">{session.eventName}</div>
        ) : null}
        {session.eventDateDisplay ? (
          <div className="text-white/70">{session.eventDateDisplay}</div>
        ) : null}
        {session.locationAddress ? (
          <div className="text-white/60">{session.locationAddress}</div>
        ) : null}
      </div>

      <form onSubmit={onSubmit} className="mt-6 space-y-4">
        <div>
          <label className="mb-1.5 block text-xs uppercase tracking-wide text-white/60">
            Your full name
          </label>
          <input
            className={inputBase}
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            onBlur={() => setFullName((v) => titleCaseName(v.trim()))}
            placeholder="First and last name"
            maxLength={80}
            autoComplete="name"
            autoCapitalize="words"
            autoCorrect="off"
            spellCheck={false}
          />
        </div>

        {/* Guests */}
        <div>
          <label className="mb-1.5 block text-xs uppercase tracking-wide text-white/60">
            Your guests (optional)
          </label>
          <div className="space-y-2">
            {guests.map((g, i) => (
              <div key={i} className="flex gap-2">
                <input
                  className={inputBase}
                  value={g}
                  onChange={(e) => {
                    const next = [...guests];
                    next[i] = e.target.value;
                    setGuests(next);
                  }}
                  onBlur={() => {
                    const next = [...guests];
                    next[i] = titleCaseName(next[i].trim());
                    setGuests(next);
                  }}
                  placeholder={`Guest ${i + 1} full name`}
                  maxLength={80}
                  autoCapitalize="words"
                  autoCorrect="off"
                  spellCheck={false}
                />
                <button
                  type="button"
                  onClick={() =>
                    setGuests(guests.filter((_, idx) => idx !== i))
                  }
                  className="shrink-0 rounded-lg border border-white/20 px-3 text-white/60 transition hover:text-white"
                  aria-label="Remove guest"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
          {canAddGuest ? (
            <button
              type="button"
              onClick={() => setGuests([...guests, ""])}
              className="mt-2 text-sm font-medium text-[#cb775a] transition hover:opacity-80"
            >
              + Add a guest
            </button>
          ) : (
            <p className="mt-2 text-xs text-white/40">
              Up to {session.maxGuests} guests.
            </p>
          )}
        </div>

        <div>
          <label className="mb-1.5 block text-xs uppercase tracking-wide text-white/60">
            Email{session.emailMandatory ? "" : " (optional)"}
          </label>
          <input
            className={inputBase}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            maxLength={254}
            autoComplete="email"
            inputMode="email"
          />
        </div>

        {session.phoneShown && (
          <div>
            <label className="mb-1.5 block text-xs uppercase tracking-wide text-white/60">
              Phone{session.phoneMandatory ? "" : " (optional)"}
            </label>
            <input
              className={inputBase}
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="Mobile number"
              maxLength={30}
              autoComplete="tel"
              inputMode="tel"
            />
          </div>
        )}

        {/* Turnstile widget */}
        <div ref={widgetRef} className="flex justify-center pt-1" />

        {error ? (
          <p className="text-sm font-medium text-red-400">{error}</p>
        ) : null}

        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded-lg bg-[#cb775a] px-4 py-3.5 font-semibold text-black transition hover:opacity-90 active:opacity-80 disabled:opacity-50"
        >
          {submitting ? "Joining…" : session.joinButtonLabel}
        </button>
      </form>

      {session.appAdvertEnabled ? (
        <p className="mt-5 text-center text-xs font-light leading-relaxed text-white/45">
          {session.appAdvertText}
        </p>
      ) : null}
    </div>
  );
}
