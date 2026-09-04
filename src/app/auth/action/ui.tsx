import type { ReactNode } from "react";

/**
 * Presentational pieces for /auth/action. No state, no Firebase — the
 * handler decides WHAT to show, these decide how it looks. Kept
 * separate so every screen state (loading, form, success, each error)
 * shares one visual frame and one set of touch targets.
 *
 * Mobile is the primary surface: these links are opened from a mail
 * app on a phone. Hence 16px inputs (iOS zooms anything smaller),
 * 48px-minimum buttons, safe-area padding at the bottom, and a single
 * column that never scrolls horizontally.
 */

/* ── Frame ─────────────────────────────────────────────────────── */

export function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="relative min-h-screen overflow-hidden bg-black text-white">
      {/* Soft copper glow — same brand accent as the app's accent3,
          kept faint so the card and text carry the contrast. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[42vh] bg-[radial-gradient(60%_60%_at_50%_0%,rgba(203,119,90,0.28),transparent_70%)]"
      />
      <div className="relative z-10 flex min-h-screen flex-col items-center px-5 pt-10 pb-[max(2.5rem,env(safe-area-inset-bottom))]">
        <Wordmark />
        <div className="mt-8 w-full max-w-md">{children}</div>
        <Footer />
      </div>
    </main>
  );
}

function Wordmark() {
  return (
    <div className="font-tape select-none text-sm font-extrabold uppercase tracking-[0.3em] text-white/80">
      Tape Members
    </div>
  );
}

function Footer() {
  return (
    <p className="mt-8 max-w-xs text-center text-xs font-light leading-relaxed text-white/40">
      Need a hand? Message us from the support chat inside the app.
    </p>
  );
}

export function Card({ children }: { children: ReactNode }) {
  return (
    <section className="rounded-3xl border border-white/10 bg-black/55 p-7 shadow-[0_20px_60px_rgba(0,0,0,0.55)] backdrop-blur-md sm:p-8">
      {children}
    </section>
  );
}

/* ── Icons ─────────────────────────────────────────────────────── */

export type IconKind = "success" | "error" | "mail" | "lock" | "spinner";

/** 56px badge with an inline SVG — no icon font, no image request. */
export function StatusIcon({ kind }: { kind: IconKind }) {
  const tone =
    kind === "error"
      ? "border-red-400/40 bg-red-400/10 text-red-300"
      : "border-[#cb775a]/40 bg-[#cb775a]/12 text-[#cb775a]";
  return (
    <div
      aria-hidden
      className={`mx-auto flex h-14 w-14 items-center justify-center rounded-full border ${tone}`}
    >
      {kind === "spinner" ? (
        <svg
          className="h-6 w-6 animate-spin motion-reduce:animate-none"
          viewBox="0 0 24 24"
          fill="none"
        >
          <circle
            cx="12"
            cy="12"
            r="9"
            stroke="currentColor"
            strokeOpacity="0.25"
            strokeWidth="2.5"
          />
          <path
            d="M21 12a9 9 0 0 0-9-9"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
          />
        </svg>
      ) : kind === "success" ? (
        <svg className="h-7 w-7" viewBox="0 0 24 24" fill="none">
          <path
            d="M5 12.5l4.5 4.5L19 7.5"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : kind === "error" ? (
        <svg className="h-7 w-7" viewBox="0 0 24 24" fill="none">
          <path
            d="M12 8v5m0 3.5h.01M10.3 3.9L2.6 17.2A2 2 0 0 0 4.3 20h15.4a2 2 0 0 0 1.7-2.8L13.7 3.9a2 2 0 0 0-3.4 0z"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : kind === "mail" ? (
        <svg className="h-7 w-7" viewBox="0 0 24 24" fill="none">
          <rect
            x="3"
            y="5.5"
            width="18"
            height="13"
            rx="2.5"
            stroke="currentColor"
            strokeWidth="2"
          />
          <path
            d="M4 7.5l8 5.5 8-5.5"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : (
        <svg className="h-7 w-7" viewBox="0 0 24 24" fill="none">
          <rect
            x="5"
            y="10.5"
            width="14"
            height="10"
            rx="2.5"
            stroke="currentColor"
            strokeWidth="2"
          />
          <path
            d="M8 10.5V8a4 4 0 0 1 8 0v2.5"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
          <circle cx="12" cy="15.5" r="1.3" fill="currentColor" />
        </svg>
      )}
    </div>
  );
}

/* ── Text ──────────────────────────────────────────────────────── */

export function Title({ children }: { children: ReactNode }) {
  return (
    <h1 className="font-tape mt-5 text-center text-xl font-extrabold uppercase leading-snug tracking-[0.12em] text-white sm:text-2xl">
      {children}
    </h1>
  );
}

export function Body({ children }: { children: ReactNode }) {
  return (
    <p className="mt-3 text-center text-[15px] font-light leading-relaxed text-white/75">
      {children}
    </p>
  );
}

/** Inline emphasis for an email address inside body copy. */
export function Em({ children }: { children: ReactNode }) {
  return (
    <span className="font-medium text-white [overflow-wrap:anywhere]">
      {children}
    </span>
  );
}

/* ── Controls ──────────────────────────────────────────────────── */

export function PrimaryButton({
  children,
  onClick,
  type = "button",
  disabled,
  busy,
}: {
  children: ReactNode;
  onClick?: () => void;
  type?: "button" | "submit";
  disabled?: boolean;
  busy?: boolean;
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className="mt-6 inline-flex min-h-12 w-full items-center justify-center rounded-xl bg-[#cb775a] px-4 py-3 text-base font-semibold text-black transition hover:opacity-90 active:opacity-80 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {busy ? (
        <span className="inline-flex items-center gap-2">
          <svg
            className="h-4 w-4 animate-spin motion-reduce:animate-none"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden
          >
            <circle
              cx="12"
              cy="12"
              r="9"
              stroke="currentColor"
              strokeOpacity="0.3"
              strokeWidth="3"
            />
            <path
              d="M21 12a9 9 0 0 0-9-9"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
            />
          </svg>
          Working…
        </span>
      ) : (
        children
      )}
    </button>
  );
}

export function SecondaryButton({
  children,
  onClick,
  disabled,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="mt-3 inline-flex min-h-12 w-full items-center justify-center rounded-xl border border-white/20 bg-white/5 px-4 py-3 text-base font-medium text-white transition hover:bg-white/10 active:bg-white/15 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {children}
    </button>
  );
}

/** Field wrapper: label above, hint/error below, matches the guestlist
 *  form's input language. 16px text so iOS Safari doesn't zoom on
 *  focus. */
export function PasswordField({
  id,
  label,
  value,
  onChange,
  autoComplete,
  show,
  onToggleShow,
  invalid,
  describedBy,
  autoFocus,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete: "new-password";
  show: boolean;
  onToggleShow: () => void;
  invalid?: boolean;
  describedBy?: string;
  autoFocus?: boolean;
}) {
  return (
    <div>
      <label
        htmlFor={id}
        className="mb-1.5 block text-xs uppercase tracking-wide text-white/60"
      >
        {label}
      </label>
      <div className="relative">
        <input
          id={id}
          type={show ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="done"
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          autoFocus={autoFocus}
          className={`w-full rounded-xl border bg-white/5 py-3.5 pl-4 pr-14 text-base text-white placeholder-white/40 outline-none transition focus:bg-white/10 ${
            invalid
              ? "border-red-400/60 focus:border-red-400"
              : "border-white/25 focus:border-white/60"
          }`}
        />
        <button
          type="button"
          onClick={onToggleShow}
          aria-label={show ? "Hide password" : "Show password"}
          aria-pressed={show}
          className="absolute inset-y-0 right-0 flex w-14 items-center justify-center text-white/60 transition hover:text-white"
        >
          {show ? (
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path
                d="M3 3l18 18M10.6 10.7A2 2 0 0 0 13.3 13.4M6.5 6.7C4.3 8.1 2.9 10 2 12c1.8 3.9 5.5 6.5 10 6.5 1.8 0 3.4-.4 4.9-1.1M9.5 5.8C10.3 5.6 11.1 5.5 12 5.5c4.5 0 8.2 2.6 10 6.5-.5 1.1-1.2 2.1-2 3"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          ) : (
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path
                d="M2 12c1.8-3.9 5.5-6.5 10-6.5s8.2 2.6 10 6.5c-1.8 3.9-5.5 6.5-10 6.5S3.8 15.9 2 12z"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinejoin="round"
              />
              <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.8" />
            </svg>
          )}
        </button>
      </div>
    </div>
  );
}

/** One line of the password requirements checklist. */
export function Requirement({ met, children }: { met: boolean; children: ReactNode }) {
  return (
    <li
      className={`flex items-center gap-2 text-sm transition-colors ${
        met ? "text-white/85" : "text-white/45"
      }`}
    >
      <span
        aria-hidden
        className={`flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-full border text-[10px] ${
          met
            ? "border-[#cb775a] bg-[#cb775a] text-black"
            : "border-white/25"
        }`}
      >
        {met ? "✓" : ""}
      </span>
      <span>
        {children}
        <span className="sr-only">{met ? " — met" : " — not yet met"}</span>
      </span>
    </li>
  );
}

/* ── Composite cards ───────────────────────────────────────────── */

export function LoadingCard({ title, message }: { title: string; message: string }) {
  return (
    <Card>
      <div role="status" aria-live="polite">
        <StatusIcon kind="spinner" />
        <Title>{title}</Title>
        <Body>{message}</Body>
      </div>
    </Card>
  );
}
