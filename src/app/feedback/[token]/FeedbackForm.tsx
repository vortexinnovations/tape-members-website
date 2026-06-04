"use client";

import { useEffect, useRef, useState } from "react";

import AppInstallButton from "../../components/AppInstallButton";
import {
  SUBMIT_FEEDBACK_URL,
  TURNSTILE_SITE_KEY,
  type FeedbackQuestion,
  type FeedbackSession,
} from "../../lib/feedback";

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

const ACCENT = "#cb775a";

function hasValue(q: FeedbackQuestion, v: unknown): boolean {
  switch (q.type) {
    case "rating":
    case "scale":
      return typeof v === "number";
    case "multiChoice":
      return Array.isArray(v) && v.length > 0;
    case "yesNo":
      return typeof v === "boolean";
    default:
      return typeof v === "string" && v.trim().length > 0;
  }
}

export default function FeedbackForm({
  token,
  session,
}: {
  token: string;
  session: FeedbackSession;
}) {
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  // ── Turnstile (manual explicit render — no npm dep) ──
  const widgetRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  const [tsToken, setTsToken] = useState("");

  useEffect(() => {
    let cancelled = false;
    const SCRIPT_ID = "cf-turnstile-script";
    const render = () => {
      if (cancelled || !window.turnstile || !widgetRef.current) return;
      if (widgetIdRef.current) return;
      widgetIdRef.current = window.turnstile.render(widgetRef.current, {
        sitekey: TURNSTILE_SITE_KEY,
        theme: "dark",
        // Stealth — invisible for real guests, challenge only when
        // Cloudflare suspects a bot. Token arrives via `callback`.
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

  function setAnswer(id: string, value: unknown) {
    setAnswers((prev) => ({ ...prev, [id]: value }));
  }

  async function onSubmit(ev: React.FormEvent) {
    ev.preventDefault();
    setError("");

    for (const q of session.questions) {
      if (q.required && !hasValue(q, answers[q.id])) {
        setError(`Please answer: ${q.label}`);
        return;
      }
    }
    const answered = session.questions.filter((q) =>
      hasValue(q, answers[q.id]),
    );
    if (answered.length === 0 && !email.trim()) {
      setError("Please answer at least one question.");
      return;
    }
    if (!tsToken) {
      setError("Just a moment — verifying you're human. Please try again.");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(SUBMIT_FEEDBACK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          turnstileToken: tsToken,
          answers: answered.map((q) => ({ id: q.id, value: answers[q.id] })),
          email: email.trim(),
          marketingConsent:
            session.emailCaptureEnabled && email.trim().length > 0,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        error?: string;
      };
      if (!res.ok || !data.success) {
        setError(data.error || "Something went wrong. Please try again.");
        resetTurnstile();
        return;
      }
      setDone(true);
    } catch {
      setError("Network error. Please try again.");
      resetTurnstile();
    } finally {
      setSubmitting(false);
    }
  }

  // ── Success ──
  if (done) {
    return (
      <div className="rounded-3xl border border-white/10 bg-black/55 p-8 text-center backdrop-blur-md shadow-[0_20px_60px_rgba(0,0,0,0.55)]">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-[#cb775a]/15 text-3xl">
          <span style={{ color: ACCENT }}>✓</span>
        </div>
        <h1 className="font-tape text-xl uppercase tracking-[0.15em] text-white">
          {session.thankYouTitle}
        </h1>
        {session.thankYouBody ? (
          <p className="mt-3 text-sm font-light leading-relaxed text-white/75">
            {session.thankYouBody}
          </p>
        ) : null}
        <div className="mt-8 border-t border-white/10 pt-6">
          <p className="mb-4 text-sm font-light text-white/70">
            Get the Tape Members app — be first to hear about events and earn
            Tape Coins on every visit.
          </p>
          <div className="flex justify-center">
            <AppInstallButton />
          </div>
        </div>
      </div>
    );
  }

  const hasContext =
    !!session.eventName || !!session.eventDateDisplay || !!session.tableNumber;

  // ── Form ──
  return (
    <div className="rounded-3xl border border-white/10 bg-black/55 p-7 backdrop-blur-md shadow-[0_20px_60px_rgba(0,0,0,0.55)]">
      <h1 className="font-tape text-xl uppercase tracking-[0.15em] text-white">
        {session.title}
      </h1>
      {session.intro ? (
        <p className="mt-2 text-sm font-light leading-relaxed text-white/70">
          {session.intro}
        </p>
      ) : null}

      {hasContext && (
        <div className="mt-5 space-y-1 rounded-xl border border-white/10 bg-white/5 p-4 text-sm">
          {session.eventName ? (
            <div className="font-semibold text-white">{session.eventName}</div>
          ) : null}
          {session.eventDateDisplay ? (
            <div className="text-white/70">{session.eventDateDisplay}</div>
          ) : null}
          {session.tableNumber ? (
            <div className="text-white/60">Table {session.tableNumber}</div>
          ) : null}
        </div>
      )}

      <form onSubmit={onSubmit} className="mt-6 space-y-7">
        {session.questions.map((q) => (
          <div key={q.id}>
            <label className="mb-2 block text-sm font-medium text-white">
              {q.label}
              {q.required ? <span className="text-red-400"> *</span> : null}
            </label>
            {q.hint ? (
              <p className="-mt-1 mb-2 text-xs font-light text-white/45">
                {q.hint}
              </p>
            ) : null}
            {renderQuestion(q, answers[q.id], setAnswer)}
          </div>
        ))}

        {session.emailCaptureEnabled && (
          <div className="border-t border-white/10 pt-5">
            <label className="mb-1.5 block text-xs uppercase tracking-wide text-white/60">
              {session.emailLabel}
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
            {session.marketingConsentText ? (
              <p className="mt-2 text-xs font-light leading-relaxed text-white/45">
                {session.marketingConsentText}
              </p>
            ) : null}
          </div>
        )}

        {/* Turnstile widget */}
        <div ref={widgetRef} className="flex justify-center" />

        {error ? (
          <p className="text-sm font-medium text-red-400">{error}</p>
        ) : null}

        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded-lg bg-[#cb775a] px-4 py-3.5 font-semibold text-black transition hover:opacity-90 active:opacity-80 disabled:opacity-50"
        >
          {submitting ? "Sending…" : session.submitLabel}
        </button>
      </form>
    </div>
  );
}

// ── Per-type renderers ──────────────────────────────────────────────

function renderQuestion(
  q: FeedbackQuestion,
  value: unknown,
  setAnswer: (id: string, v: unknown) => void,
) {
  switch (q.type) {
    case "rating":
      return <RatingInput q={q} value={value} setAnswer={setAnswer} />;
    case "scale":
      return <ScaleInput q={q} value={value} setAnswer={setAnswer} />;
    case "singleChoice":
      return <SingleChoiceInput q={q} value={value} setAnswer={setAnswer} />;
    case "multiChoice":
      return <MultiChoiceInput q={q} value={value} setAnswer={setAnswer} />;
    case "yesNo":
      return <YesNoInput q={q} value={value} setAnswer={setAnswer} />;
    case "longText":
      return (
        <textarea
          className={inputBase}
          rows={3}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => setAnswer(q.id, e.target.value)}
          placeholder="Your answer"
          maxLength={4000}
        />
      );
    default: // shortText
      return (
        <input
          className={inputBase}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => setAnswer(q.id, e.target.value)}
          placeholder="Your answer"
          maxLength={500}
        />
      );
  }
}

type InputProps = {
  q: FeedbackQuestion;
  value: unknown;
  setAnswer: (id: string, v: unknown) => void;
};

function RatingInput({ q, value, setAnswer }: InputProps) {
  const max = Math.min(Math.max(q.maxRating ?? 5, 2), 10);
  const sel = typeof value === "number" ? value : 0;
  return (
    <div className="flex flex-wrap gap-1.5">
      {Array.from({ length: max }, (_, i) => i + 1).map((n) => (
        <button
          key={n}
          type="button"
          aria-label={`${n} star${n === 1 ? "" : "s"}`}
          onClick={() => setAnswer(q.id, n)}
          className="text-4xl leading-none transition active:scale-90"
          style={{ color: n <= sel ? "#FFB300" : "rgba(255,255,255,0.22)" }}
        >
          {n <= sel ? "★" : "☆"}
        </button>
      ))}
    </div>
  );
}

function ScaleInput({ q, value, setAnswer }: InputProps) {
  const lo = q.scaleMin ?? 0;
  const hi = q.scaleMax ?? 10;
  const sel = typeof value === "number" ? value : null;
  const nums: number[] = [];
  for (let n = lo; n <= hi && nums.length < 20; n++) nums.push(n);
  return (
    <div>
      <div className="flex flex-wrap gap-2">
        {nums.map((n) => (
          <Chip
            key={n}
            label={String(n)}
            selected={sel === n}
            onClick={() => setAnswer(q.id, n)}
          />
        ))}
      </div>
      {q.scaleMinLabel || q.scaleMaxLabel ? (
        <div className="mt-2 flex justify-between text-xs font-light text-white/40">
          <span>{q.scaleMinLabel ?? ""}</span>
          <span>{q.scaleMaxLabel ?? ""}</span>
        </div>
      ) : null}
    </div>
  );
}

function SingleChoiceInput({ q, value, setAnswer }: InputProps) {
  const sel = typeof value === "string" ? value : "";
  return (
    <div className="flex flex-wrap gap-2">
      {(q.options ?? []).map((opt) => (
        <Chip
          key={opt}
          label={opt}
          selected={sel === opt}
          onClick={() => setAnswer(q.id, sel === opt ? "" : opt)}
        />
      ))}
    </div>
  );
}

function MultiChoiceInput({ q, value, setAnswer }: InputProps) {
  const arr = (Array.isArray(value) ? value : []) as string[];
  function toggle(opt: string) {
    setAnswer(
      q.id,
      arr.includes(opt) ? arr.filter((o) => o !== opt) : [...arr, opt],
    );
  }
  return (
    <div className="flex flex-wrap gap-2">
      {(q.options ?? []).map((opt) => (
        <Chip
          key={opt}
          label={opt}
          selected={arr.includes(opt)}
          onClick={() => toggle(opt)}
        />
      ))}
    </div>
  );
}

function YesNoInput({ q, value, setAnswer }: InputProps) {
  return (
    <div className="flex gap-2">
      <Chip
        label="Yes"
        selected={value === true}
        onClick={() => setAnswer(q.id, value === true ? null : true)}
      />
      <Chip
        label="No"
        selected={value === false}
        onClick={() => setAnswer(q.id, value === false ? null : false)}
      />
    </div>
  );
}

function Chip({
  label,
  selected,
  onClick,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        selected
          ? "rounded-full border border-[#cb775a] bg-[#cb775a] px-4 py-2 text-sm font-semibold text-black transition active:opacity-80"
          : "rounded-full border border-white/25 bg-white/5 px-4 py-2 text-sm text-white/85 transition hover:border-white/50 active:opacity-80"
      }
    >
      {label}
    </button>
  );
}
