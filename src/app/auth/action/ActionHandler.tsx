"use client";

import { useSearchParams } from "next/navigation";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";

import AppInstallButton from "../../components/AppInstallButton";
import {
  Body,
  Card,
  Em,
  LoadingCard,
  PasswordField,
  PrimaryButton,
  Requirement,
  StatusIcon,
  Title,
} from "./ui";

/**
 * The four email actions Firebase Auth can send a member, redeemed
 * from the browser exactly as Google's hosted handler does — but from
 * OUR page, with App Check attested first (see lib/firebaseWeb.ts).
 *
 *   resetPassword         member asked for a reset from the app's login
 *                         page → verify the code, collect a new password,
 *                         confirm. Firebase revokes every existing session
 *                         on success, so the copy says "signed out
 *                         everywhere".
 *   verifyEmail           signup verification → apply the code; the app's
 *                         verify-email screen is polling `reload()` and
 *                         moves on by itself.
 *   verifyAndChangeEmail  the profile email-change flow
 *                         (`verifyBeforeUpdateEmail`) → apply; the app has
 *                         already signed the member out (Critical Rule
 *                         #14), so the copy says sign in with the NEW email.
 *   recoverEmail          the "this wasn't me" link in the notice sent to
 *                         the OLD address → restore it, then offer a
 *                         password reset because the account may be
 *                         compromised.
 *
 * Correctness notes that shaped the code:
 *   • Action codes are single-use. React strict mode mounts effects
 *     twice in development, and a second `applyActionCode` would fail
 *     with invalid-action-code AFTER the first succeeded — so the
 *     redemption promise is cached per code at module level and the
 *     second mount simply awaits the first.
 *   • Nothing is rendered from the query string except the mode
 *     branch; the code itself never appears in the DOM.
 *   • The Firebase SDK is imported dynamically so the rest of the site
 *     never carries it, and so a failed import is a rendered error
 *     rather than a white page.
 *   • `?preview=` renders any screen state WITHOUT a code, for design
 *     review. It is honoured only in `next dev`; `next build` inlines
 *     NODE_ENV=production and the branch is dead code.
 */

type Mode =
  | "resetPassword"
  | "verifyEmail"
  | "verifyAndChangeEmail"
  | "recoverEmail";

const MODES: ReadonlySet<string> = new Set([
  "resetPassword",
  "verifyEmail",
  "verifyAndChangeEmail",
  "recoverEmail",
]);

type ErrorView = {
  kind: "error";
  title: string;
  message: string;
  code?: string;
  retry?: boolean;
};

type View =
  | { kind: "loading"; title: string; message: string }
  | { kind: "invalid" }
  | ErrorView
  | { kind: "reset"; email: string }
  | {
      kind: "done";
      mode: Mode;
      email?: string;
      resetSent?: boolean;
      resetError?: string;
    };

/** Shape of the policy we render as a checklist. Firebase's default
 *  (no custom policy configured) is a 6-character minimum and nothing
 *  else; if a policy is ever added in the console the list grows by
 *  itself. */
type PolicyView = {
  minLength: number;
  maxLength?: number;
  lowercase: boolean;
  uppercase: boolean;
  numeric: boolean;
  symbol: boolean;
};

type Sdk = typeof import("firebase/auth");
type Lib = typeof import("../../lib/firebaseWeb");

let sdkPromise: Promise<{ sdk: Sdk; lib: Lib }> | null = null;
function loadFirebase() {
  if (!sdkPromise) {
    sdkPromise = Promise.all([
      import("firebase/auth"),
      import("../../lib/firebaseWeb"),
    ]).then(([sdk, lib]) => ({ sdk, lib }));
  }
  return sdkPromise;
}

/** One redemption per code per page load (strict-mode guard). */
const redemptions = new Map<string, Promise<View>>();

/* ── Error copy ────────────────────────────────────────────────── */

function errorCode(e: unknown): string | undefined {
  if (e && typeof e === "object" && "code" in e) {
    const c = (e as { code?: unknown }).code;
    return typeof c === "string" ? c : undefined;
  }
  return undefined;
}

function describeError(code: string | undefined, mode: Mode | null): ErrorView {
  const what =
    mode === "resetPassword"
      ? "password reset"
      : mode === "recoverEmail"
        ? "email recovery"
        : "verification";
  switch (code) {
    case "auth/expired-action-code":
      return {
        kind: "error",
        title: "This link has expired",
        message: `For your security, ${what} links only work for a short time. Request a new one from the app and try again.`,
        code,
      };
    case "auth/invalid-action-code":
      return {
        kind: "error",
        title: "This link has already been used",
        message: `Links work once. If you've already completed this ${what}, you're all set — otherwise request a fresh link from the app.`,
        code,
      };
    case "auth/user-disabled":
      return {
        kind: "error",
        title: "This account is disabled",
        message:
          "If you think that's a mistake, message us from the support chat in the app.",
        code,
      };
    case "auth/user-not-found":
      return {
        kind: "error",
        title: "We couldn't find this account",
        message:
          "The account this link belongs to no longer exists. Request a new link from the app if you still need it.",
        code,
      };
    case "auth/too-many-requests":
      return {
        kind: "error",
        title: "Too many attempts",
        message: "Please wait a few minutes and try again.",
        code,
        retry: true,
      };
    case "auth/network-request-failed":
      return {
        kind: "error",
        title: "We couldn't reach Tape",
        message: "Check your connection and try again.",
        code,
        retry: true,
      };
    case "auth/firebase-app-check-token-is-invalid":
    case "auth/missing-app-check-token":
    case "auth/app-check-token-invalid":
      return {
        kind: "error",
        title: "We couldn't verify this browser",
        message:
          "Try again, or open the link in Safari or Chrome rather than an in-app browser.",
        code,
        retry: true,
      };
    default:
      return {
        kind: "error",
        title: "Something went wrong",
        message:
          "We couldn't complete this action. Try the link again, or request a new one from the app.",
        code,
        retry: true,
      };
  }
}

/* ── Redemption ────────────────────────────────────────────────── */

async function redeem(mode: Mode, code: string): Promise<View> {
  const { sdk, lib } = await loadFirebase();
  const auth = lib.firebaseAuth();
  switch (mode) {
    case "resetPassword": {
      // Only VERIFIES here; the code is consumed by confirmPasswordReset
      // once the member submits a password.
      const email = await sdk.verifyPasswordResetCode(auth, code);
      return { kind: "reset", email };
    }
    case "verifyEmail": {
      const info = await sdk.checkActionCode(auth, code);
      await sdk.applyActionCode(auth, code);
      return { kind: "done", mode, email: info.data.email ?? undefined };
    }
    case "verifyAndChangeEmail": {
      const info = await sdk.checkActionCode(auth, code);
      await sdk.applyActionCode(auth, code);
      // `data.email` is the NEW address being confirmed.
      return { kind: "done", mode, email: info.data.email ?? undefined };
    }
    case "recoverEmail": {
      const info = await sdk.checkActionCode(auth, code);
      await sdk.applyActionCode(auth, code);
      // `data.email` is the address being RESTORED.
      return { kind: "done", mode, email: info.data.email ?? undefined };
    }
  }
}

/* ── Component ─────────────────────────────────────────────────── */

export default function ActionHandler() {
  const params = useSearchParams();
  const rawMode = params.get("mode") ?? "";
  const code = params.get("oobCode") ?? "";
  const mode: Mode | null = MODES.has(rawMode) ? (rawMode as Mode) : null;
  const preview =
    process.env.NODE_ENV === "development" ? params.get("preview") : null;

  // The initial screen is decided at first render, not in an effect:
  // a missing/unsupported mode or code is "invalid" immediately, and
  // every other case starts on the loading card the redemption then
  // replaces.
  const [view, setView] = useState<View>(() => {
    if (preview) return previewView(preview);
    if (!mode || !code) return { kind: "invalid" };
    return loadingFor(mode);
  });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (preview || !mode || !code) return;
    let cancelled = false;
    // Cache key includes the attempt so a manual "Try again" really
    // retries; a strict-mode remount (same attempt) reuses the promise.
    const key = `${mode}:${code}:${attempt}`;
    let p = redemptions.get(key);
    if (!p) {
      p = redeem(mode, code).catch((e) => describeError(errorCode(e), mode));
      redemptions.set(key, p);
    }
    p.then((v) => {
      if (!cancelled) setView(v);
    });
    return () => {
      cancelled = true;
    };
  }, [mode, code, attempt, preview]);

  // Back to the loading card, then bump the attempt so the effect runs
  // the redemption again under a fresh cache key.
  const retry = useCallback(() => {
    setView(loadingFor(mode));
    setAttempt((n) => n + 1);
  }, [mode]);

  switch (view.kind) {
    case "loading":
      return <LoadingCard title={view.title} message={view.message} />;
    case "invalid":
      return <InvalidCard />;
    case "error":
      return <ErrorCard view={view} onRetry={view.retry ? retry : undefined} />;
    case "reset":
      return (
        <ResetForm
          email={view.email}
          code={code}
          onDone={() => setView({ kind: "done", mode: "resetPassword", email: view.email })}
          onFatal={(v) => setView(v)}
        />
      );
    case "done":
      return <DoneCard view={view} onChange={setView} />;
  }
}

function loadingFor(mode: Mode | null): View {
  switch (mode) {
    case "resetPassword":
      return { kind: "loading", title: "One moment", message: "Checking your reset link…" };
    case "recoverEmail":
      return { kind: "loading", title: "One moment", message: "Restoring your email…" };
    case "verifyAndChangeEmail":
      return { kind: "loading", title: "One moment", message: "Confirming your new email…" };
    default:
      return { kind: "loading", title: "One moment", message: "Verifying your email…" };
  }
}

/* ── Screens ───────────────────────────────────────────────────── */

function InvalidCard() {
  return (
    <Card>
      <StatusIcon kind="error" />
      <Title>This link isn&apos;t valid</Title>
      <Body>
        It looks incomplete — usually because it was copied by hand or
        opened from a preview. Open the link straight from the email, or
        request a new one from the app.
      </Body>
      <OpenApp />
    </Card>
  );
}

function ErrorCard({ view, onRetry }: { view: Extract<View, { kind: "error" }>; onRetry?: () => void }) {
  return (
    <Card>
      <div role="alert">
        <StatusIcon kind="error" />
        <Title>{view.title}</Title>
        <Body>{view.message}</Body>
      </div>
      {onRetry ? <PrimaryButton onClick={onRetry}>Try again</PrimaryButton> : null}
      <OpenApp secondary={!!onRetry} />
      {view.code ? (
        <p className="mt-5 text-center text-[11px] text-white/30">
          Reference: {view.code}
        </p>
      ) : null}
    </Card>
  );
}

function DoneCard({
  view,
  onChange,
}: {
  view: Extract<View, { kind: "done" }>;
  onChange: (v: View) => void;
}) {
  const [sending, setSending] = useState(false);

  const sendReset = async () => {
    if (!view.email || sending) return;
    setSending(true);
    try {
      const { sdk, lib } = await loadFirebase();
      await sdk.sendPasswordResetEmail(lib.firebaseAuth(), view.email);
      onChange({ ...view, resetSent: true, resetError: undefined });
    } catch (e) {
      onChange({
        ...view,
        resetError: describeError(errorCode(e), "resetPassword").message,
      });
    } finally {
      setSending(false);
    }
  };

  switch (view.mode) {
    case "resetPassword":
      return (
        <Card>
          <div role="status" aria-live="polite">
            <StatusIcon kind="success" />
            <Title>Password updated</Title>
            <Body>
              You&apos;ve been signed out on every device. Open the app and sign
              in{view.email ? <> as <Em>{view.email}</Em></> : null} with your
              new password.
            </Body>
          </div>
          <OpenApp />
        </Card>
      );
    case "verifyEmail":
      return (
        <Card>
          <div role="status" aria-live="polite">
            <StatusIcon kind="success" />
            <Title>Email verified</Title>
            <Body>
              Thanks — {view.email ? <Em>{view.email}</Em> : "your email"} is
              confirmed. Head back to the app to carry on; it will pick this up
              by itself.
            </Body>
          </div>
          <OpenApp />
        </Card>
      );
    case "verifyAndChangeEmail":
      return (
        <Card>
          <div role="status" aria-live="polite">
            <StatusIcon kind="success" />
            <Title>Email updated</Title>
            <Body>
              Your sign-in email is now{" "}
              {view.email ? <Em>{view.email}</Em> : "your new address"}. For
              your security you&apos;ve been signed out — open the app and sign
              in with the new email.
            </Body>
          </div>
          <OpenApp />
        </Card>
      );
    case "recoverEmail":
      return (
        <Card>
          <div role="status" aria-live="polite">
            <StatusIcon kind="success" />
            <Title>Email restored</Title>
            <Body>
              Your sign-in email is back to{" "}
              {view.email ? <Em>{view.email}</Em> : "your original address"}.
              If you didn&apos;t ask to change it, someone may know your
              password — reset it now to be safe.
            </Body>
          </div>
          {view.resetSent ? (
            <p
              role="status"
              className="mt-6 rounded-xl border border-[#cb775a]/40 bg-[#cb775a]/10 px-4 py-3 text-center text-sm text-white/85"
            >
              Reset link sent to <Em>{view.email}</Em>. Check your inbox.
            </p>
          ) : (
            <>
              <PrimaryButton onClick={sendReset} busy={sending} disabled={!view.email}>
                Send me a password reset link
              </PrimaryButton>
              {view.resetError ? (
                <p role="alert" className="mt-3 text-center text-sm font-medium text-red-400">
                  {view.resetError}
                </p>
              ) : null}
            </>
          )}
          <OpenApp secondary />
        </Card>
      );
  }
}

/** The "back to the app" affordance. AppInstallButton opens the app via
 *  its Universal Link when installed and falls back to the store —
 *  which is exactly right after a reset or verification. A plain
 *  same-domain link would NOT open the app (iOS ignores Universal Links
 *  to the domain you are already on). */
function OpenApp({ secondary }: { secondary?: boolean }) {
  return (
    <div className={`${secondary ? "mt-5" : "mt-6"} flex flex-col items-center gap-3`}>
      {secondary ? (
        <p className="text-xs font-light text-white/50">Back to the app:</p>
      ) : null}
      <AppInstallButton />
    </div>
  );
}

/* ── Password reset form ───────────────────────────────────────── */

function ResetForm({
  email,
  code,
  onDone,
  onFatal,
}: {
  email: string;
  code: string;
  onDone: () => void;
  onFatal: (v: View) => void;
}) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [policy, setPolicy] = useState<PolicyView | null>(null);
  const [met, setMet] = useState<Partial<Record<keyof PolicyView, boolean>>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitted = useRef(false);

  // Fetch the project's password policy once so the checklist reflects
  // whatever the console says — today that is Firebase's default
  // (6+ characters). validatePassword caches the policy afterwards, so
  // per-keystroke calls below are local.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { sdk, lib } = await loadFirebase();
        const s = await sdk.validatePassword(lib.firebaseAuth(), "");
        const o = s.passwordPolicy.customStrengthOptions;
        if (cancelled) return;
        setPolicy({
          minLength: o.minPasswordLength ?? 6,
          maxLength: o.maxPasswordLength,
          lowercase: !!o.containsLowercaseLetter,
          uppercase: !!o.containsUppercaseLetter,
          numeric: !!o.containsNumericCharacter,
          symbol: !!o.containsNonAlphanumericCharacter,
        });
      } catch {
        // Policy fetch failed (offline?) — fall back to the default so
        // the form still works; the server re-validates on submit.
        if (!cancelled)
          setPolicy({ minLength: 6, lowercase: false, uppercase: false, numeric: false, symbol: false });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Live checklist.
  useEffect(() => {
    if (!policy) return;
    let cancelled = false;
    (async () => {
      const { sdk, lib } = await loadFirebase();
      const s = await sdk.validatePassword(lib.firebaseAuth(), password);
      if (cancelled) return;
      setMet({
        minLength: s.meetsMinPasswordLength !== false,
        maxLength: s.meetsMaxPasswordLength !== false,
        lowercase: s.containsLowercaseLetter !== false,
        uppercase: s.containsUppercaseLetter !== false,
        numeric: s.containsNumericCharacter !== false,
        symbol: s.containsNonAlphanumericCharacter !== false,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [password, policy]);

  const requirements = policy
    ? ([
        [`At least ${policy.minLength} characters`, met.minLength, true],
        ["A lowercase letter", met.lowercase, policy.lowercase],
        ["An uppercase letter", met.uppercase, policy.uppercase],
        ["A number", met.numeric, policy.numeric],
        ["A symbol", met.symbol, policy.symbol],
        // Firebase's default max is 4096 — pure noise on a checklist.
        // Only surface a maximum when the console sets a real one.
        [
          `No more than ${policy.maxLength ?? 0} characters`,
          met.maxLength,
          !!policy.maxLength && policy.maxLength < 256,
        ],
      ] as const).filter(([, , shown]) => shown)
    : [];

  const policyOk =
    !!policy &&
    password.length > 0 &&
    requirements.every(([, ok]) => ok === true);
  const matches = confirm.length > 0 && confirm === password;
  const canSubmit = policyOk && matches && !submitting;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit || submitted.current) return;
    setError(null);
    setSubmitting(true);
    try {
      const { sdk, lib } = await loadFirebase();
      await sdk.confirmPasswordReset(lib.firebaseAuth(), code, password);
      submitted.current = true;
      onDone();
    } catch (err) {
      const c = errorCode(err);
      if (c === "auth/weak-password") {
        setError("That password doesn't meet the requirements. Try a longer one.");
      } else if (c === "auth/password-does-not-meet-requirements") {
        setError("That password doesn't meet the requirements above.");
      } else {
        // Anything else means the code itself is no longer usable —
        // hand off to the full-card error so the member gets the
        // right next step (request a new link).
        onFatal(describeError(c, "resetPassword"));
        return;
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card>
      <StatusIcon kind="lock" />
      <Title>Choose a new password</Title>
      <Body>
        for <Em>{email}</Em>
      </Body>

      <form onSubmit={submit} noValidate className="mt-6 space-y-4">
        {/* Lets password managers associate the new password with the
            right account without rendering a visible email field. */}
        <input
          type="email"
          name="username"
          autoComplete="username"
          value={email}
          readOnly
          hidden
          aria-hidden
          tabIndex={-1}
        />
        <PasswordField
          id="new-password"
          label="New password"
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
          show={show}
          onToggleShow={() => setShow((s) => !s)}
          describedBy="password-requirements"
          autoFocus
        />
        <ul id="password-requirements" className="space-y-1.5 px-1" aria-label="Password requirements">
          {policy ? (
            requirements.map(([label, ok]) => (
              <Requirement key={label} met={ok === true}>
                {label}
              </Requirement>
            ))
          ) : (
            <li className="text-sm text-white/45">Loading requirements…</li>
          )}
        </ul>
        <PasswordField
          id="confirm-password"
          label="Confirm new password"
          value={confirm}
          onChange={setConfirm}
          autoComplete="new-password"
          show={show}
          onToggleShow={() => setShow((s) => !s)}
          invalid={confirm.length > 0 && !matches}
          describedBy={confirm.length > 0 && !matches ? "confirm-hint" : undefined}
        />
        {confirm.length > 0 && !matches ? (
          <p id="confirm-hint" className="-mt-2 px-1 text-sm text-red-400">
            Passwords don&apos;t match yet.
          </p>
        ) : null}

        {error ? (
          <p role="alert" className="text-sm font-medium text-red-400">
            {error}
          </p>
        ) : null}

        <PrimaryButton type="submit" disabled={!canSubmit} busy={submitting}>
          Update password
        </PrimaryButton>
      </form>
      <p className="mt-4 text-center text-xs font-light leading-relaxed text-white/45">
        Updating your password signs you out everywhere else.
      </p>
    </Card>
  );
}

/* ── Design-review previews (development only) ─────────────────── */

function previewView(name: string): View {
  switch (name) {
    case "loading":
      return loadingFor("resetPassword");
    case "invalid":
      return { kind: "invalid" };
    case "expired":
      return describeError("auth/expired-action-code", "resetPassword");
    case "used":
      return describeError("auth/invalid-action-code", "verifyEmail");
    case "network":
      return describeError("auth/network-request-failed", "verifyEmail");
    case "reset":
      return { kind: "reset", email: "member@example.com" };
    case "done-reset":
      return { kind: "done", mode: "resetPassword", email: "member@example.com" };
    case "done-verify":
      return { kind: "done", mode: "verifyEmail", email: "member@example.com" };
    case "done-change":
      return { kind: "done", mode: "verifyAndChangeEmail", email: "new@example.com" };
    case "done-recover":
      return { kind: "done", mode: "recoverEmail", email: "original@example.com" };
    default:
      return { kind: "invalid" };
  }
}
