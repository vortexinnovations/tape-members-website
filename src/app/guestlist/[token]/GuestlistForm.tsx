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
import {
  LANGS,
  STRINGS,
  localizeDateDisplay,
  pickLang,
  translateBackendError,
  type GuestlistStrings,
  type LangCode,
} from "./translations";

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

const LANG_STORAGE_KEY = "tape-guestlist-lang";

/** Title-case a name: first letter of each word uppercase, the rest
 *  lowercase. Handles spaces, hyphens, apostrophes and accented
 *  letters — e.g. "josé o'brien-smith" -> "José O'Brien-Smith". */
function titleCaseName(s: string): string {
  return s
    .toLowerCase()
    .replace(/(?:^|[\s'-])\p{L}/gu, (m) => m.toUpperCase());
}

/** Resolve the copy for the active language. English keeps preferring
 *  the admin-configured session strings (from /qrGuestlistAdmin);
 *  other languages use the static translations for everything, since
 *  custom English copy can't be machine-translated. */
function stringsFor(
  lang: LangCode,
  session: GuestlistSession,
): GuestlistStrings {
  const base = STRINGS[lang];
  if (lang !== "en") return base;
  return {
    ...base,
    formTitle: session.formTitle || base.formTitle,
    formSubtitle: session.formSubtitle || base.formSubtitle,
    joinButton: session.joinButtonLabel || base.joinButton,
    successTitle: session.successTitle || base.successTitle,
    successMessage: session.successMessage || base.successMessage,
    doorInstruction: session.doorInstruction || base.doorInstruction,
    appAdvert: session.appAdvertText || base.appAdvert,
  };
}

/** Compact language pill row (EN / ΕΛ / IT / FR / ES / DE). */
function LangSwitcher({
  lang,
  onChange,
}: {
  lang: LangCode;
  onChange: (l: LangCode) => void;
}) {
  return (
    <div className="mb-5 flex flex-wrap justify-end gap-1.5">
      {LANGS.map((l) => (
        <button
          key={l.code}
          type="button"
          title={l.name}
          aria-label={l.name}
          onClick={() => onChange(l.code)}
          className={
            "rounded-full px-2.5 py-1 text-[11px] font-semibold " +
            "tracking-wide transition " +
            (l.code === lang
              ? "bg-[#cb775a] text-black"
              : "border border-white/20 text-white/55 hover:text-white")
          }
        >
          {l.pill}
        </button>
      ))}
    </div>
  );
}

export default function GuestlistForm({
  token,
  session,
  prefillEmail,
  initialLang,
}: {
  token: string;
  session: GuestlistSession;
  prefillEmail: string;
  initialLang: LangCode;
}) {
  const [fullName, setFullName] = useState("");
  const [guests, setGuests] = useState<string[]>([]);
  const [email, setEmail] = useState(prefillEmail);
  const [phone, setPhone] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // Errors are stored as-received (client keys resolve at render so a
  // language switch re-translates a visible error immediately).
  const [error, setError] = useState("");
  const [result, setResult] = useState<GuestlistSubmitResult | null>(null);

  // ── Language ──
  // Server-detected Accept-Language seeds the initial value; a saved
  // explicit choice (localStorage) overrides it on mount.
  const [lang, setLang] = useState<LangCode>(initialLang);
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(LANG_STORAGE_KEY);
      if (saved && LANGS.some((l) => l.code === saved)) {
        setLang(saved as LangCode);
      }
    } catch {
      /* private mode — keep the server-detected language */
    }
  }, []);
  const changeLang = (l: LangCode) => {
    setLang(l);
    try {
      window.localStorage.setItem(LANG_STORAGE_KEY, l);
    } catch {
      /* no-op */
    }
  };
  const t = stringsFor(lang, session);
  const dateDisplay = localizeDateDisplay(session.eventDateDisplay, t);

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
      setError(t.errName);
      return;
    }
    if (session.emailMandatory && !email.trim()) {
      setError(t.errEmail);
      return;
    }
    if (session.phoneShown && session.phoneMandatory && !phone.trim()) {
      setError(t.errPhone);
      return;
    }
    if (!tsToken) {
      // Stealth Turnstile usually resolves silently in <1s; if the user
      // submits before it lands (or a challenge is showing), nudge them
      // to retry rather than point at a widget that may be invisible.
      setError(t.errHuman);
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
        // Backend errors arrive in English — map the known ones to the
        // active language, pass anything unrecognised through.
        setError(translateBackendError(data.error || "", t) || t.errGeneric);
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
      setError(t.errNetwork);
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
          {t.successTitle}
        </h1>
        <p className="mt-3 text-sm font-light leading-relaxed text-white/75">
          {t.successMessage}
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
              <div className="text-white/70">{dateDisplay}</div>
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
          {t.doorInstruction}
        </p>

        {/* Directions — Google Maps universal directions URL (opens the
            Maps app on mobile if installed, the web otherwise). */}
        {session.locationAddress ? (
          <div className="mt-5">
            <a
              href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
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
              {t.getDirections}
            </a>
          </div>
        ) : null}

        {/* Names on the list — numbered, in submission order. Fixed
            right-aligned number column so every name starts at the
            same x and the list reads as a tidy column. */}
        {names.length > 0 && (
          <div className="mt-4">
            <p className="text-[11px] uppercase tracking-wide text-white/40">
              {t.onTheList}
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
            {t.makeAnother}
          </button>
        </div>

        {session.appAdvertEnabled && (
          <div className="mt-8 border-t border-white/10 pt-6">
            <p className="mb-4 text-sm font-light text-white/70">
              {t.appAdvert}
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
      <LangSwitcher lang={lang} onChange={changeLang} />

      <h1 className="font-tape text-xl uppercase tracking-[0.15em] text-white">
        {t.formTitle}
      </h1>
      <p className="mt-2 text-sm font-light leading-relaxed text-white/70">
        {t.formSubtitle}
      </p>

      {/* Event context */}
      <div className="mt-5 space-y-1 rounded-xl border border-white/10 bg-white/5 p-4 text-sm">
        {session.eventName ? (
          <div className="font-semibold text-white">{session.eventName}</div>
        ) : null}
        {session.eventDateDisplay ? (
          <div className="text-white/70">{dateDisplay}</div>
        ) : null}
        {session.locationAddress ? (
          <div className="text-white/60">{session.locationAddress}</div>
        ) : null}
      </div>

      <form onSubmit={onSubmit} className="mt-6 space-y-4">
        <div>
          <label className="mb-1.5 block text-xs uppercase tracking-wide text-white/60">
            {t.fullNameLabel}
          </label>
          <input
            className={inputBase}
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            onBlur={() => setFullName((v) => titleCaseName(v.trim()))}
            placeholder={t.fullNamePlaceholder}
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
            {t.guestsLabel}
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
                  placeholder={t.guestPlaceholder(i + 1)}
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
                  aria-label={t.removeGuest}
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
              {t.addGuest}
            </button>
          ) : (
            <p className="mt-2 text-xs text-white/40">
              {t.upToGuests(session.maxGuests)}
            </p>
          )}
        </div>

        <div>
          <label className="mb-1.5 block text-xs uppercase tracking-wide text-white/60">
            {t.emailLabel}
            {session.emailMandatory ? "" : t.optionalSuffix}
          </label>
          <input
            className={inputBase}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={t.emailPlaceholder}
            maxLength={254}
            autoComplete="email"
            inputMode="email"
          />
        </div>

        {session.phoneShown && (
          <div>
            <label className="mb-1.5 block text-xs uppercase tracking-wide text-white/60">
              {t.phoneLabel}
              {session.phoneMandatory ? "" : t.optionalSuffix}
            </label>
            <input
              className={inputBase}
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder={t.phonePlaceholder}
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
          {submitting ? t.joining : t.joinButton}
        </button>
      </form>

      {session.appAdvertEnabled ? (
        <p className="mt-5 text-center text-xs font-light leading-relaxed text-white/45">
          {t.appAdvert}
        </p>
      ) : null}
    </div>
  );
}
