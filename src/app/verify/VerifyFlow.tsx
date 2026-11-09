"use client";

import { useSearchParams } from "next/navigation";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import type { Auth, User } from "firebase/auth";
import type { Firestore } from "firebase/firestore";
import { QRCodeSVG } from "qrcode.react";

import AppInstallButton from "../components/AppInstallButton";
import {
  Body,
  Card,
  Em,
  LoadingCard,
  PrimaryButton,
  StatusIcon,
  Title,
} from "../auth/action/ui";
import { TURNSTILE_SITE_KEY } from "../lib/guestlist";
import {
  QV_ACTIONS,
  QV_CONFIG,
  authErrorText,
  errorText,
  fill,
  isInAppBrowser,
  isOpenNow,
  resolvePublicConfig,
  stageFrom,
  type PublicConfig,
  type QvUserDoc,
} from "../lib/quickVerify";
import SumsubCheck from "./SumsubCheck";
import { Choice, ErrorLine, Note, SectionLabel, TextField, TextLink } from "./ui";

/**
 * Quick Verify: account + address + ID check at the door, no app.
 * Plan: docs/QUICK_VERIFY_PLAN.md in the app repo.
 *
 * How it talks to the backend (backend/functions/quickVerify.js):
 *   - Firebase Auth makes / signs in the account (email + password), so
 *     the same login works in the app afterwards.
 *   - Every step is a `quickVerifyActions/{id}` doc the guest creates;
 *     the backend writes `status` + `result` / `error` back onto it and
 *     this page is listening.
 *   - Where the guest IS comes from their own `users/{uid}` doc, which
 *     the backend and the Sumsub webhook write: `quickVerify.stage`,
 *     `idverified`, `duplicate`, `sumsubPassportRequired`. So a reload,
 *     or coming back to the link later, lands on the right screen.
 *
 * The Firebase SDK is imported dynamically (as /auth/action does) so the
 * rest of the site never carries it.
 *
 * Query string: `?s=door` records where the guest came from;
 * `?test=1` shows the form while the page is closed (the backend still
 * refuses anyone who is not on the tester list). `?stop=1` is the link
 * in the follow-up emails: it signs the guest in if needed and stops
 * them. `?preview=<screen>`
 * draws any screen with made-up data for design review, in `next dev`
 * only (the same idea as /auth/action): closed, signin, start, email,
 * address, id, passport, verified, existing, underage.
 */

type Fb = {
  auth: Auth;
  db: Firestore;
  a: typeof import("firebase/auth");
  f: typeof import("firebase/firestore");
};

type ActionResult =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; error: string };

type Sumsub = { token: string; url: string; check: string };

// `window.turnstile` is declared once for the site, in the guestlist form.

const ACTION_TIMEOUT_MS = 45000;
const RESEND_WAIT_MS = 30000;

function sumsubFrom(result: Record<string, unknown>): Sumsub | null {
  if (result.stage !== "id") return null;
  return {
    token: String(result.sumsubToken || ""),
    url: String(result.sumsubUrl || ""),
    check: String(result.check || "any"),
  };
}

type Preview = {
  signedIn: boolean;
  open: boolean;
  doc: QvUserDoc | null;
  sumsub: Sumsub | null;
};
const PV_SUMSUB: Sumsub = { token: "", url: "https://example.com", check: "any" };
const PREVIEWS: Record<string, Preview> = {
  closed: { signedIn: false, open: false, doc: null, sumsub: null },
  signin: { signedIn: false, open: true, doc: null, sumsub: null },
  start: { signedIn: true, open: true, doc: null, sumsub: null },
  email: {
    signedIn: true,
    open: true,
    doc: { quickVerify: { stage: "email" } },
    sumsub: null,
  },
  address: {
    signedIn: true,
    open: true,
    doc: { quickVerify: { stage: "address" } },
    sumsub: null,
  },
  id: {
    signedIn: true,
    open: true,
    doc: { quickVerify: { stage: "id" } },
    sumsub: PV_SUMSUB,
  },
  // The ID step with Sumsub's frame mounted (it will show its own
  // "token invalid" message): for checking the frame's width.
  idframe: {
    signedIn: true,
    open: true,
    doc: { quickVerify: { stage: "id" } },
    sumsub: { ...PV_SUMSUB, token: "preview-token" },
  },
  passport: {
    signedIn: true,
    open: true,
    doc: { quickVerify: { stage: "id" }, sumsubPassportRequired: true },
    sumsub: PV_SUMSUB,
  },
  verified: {
    signedIn: true,
    open: true,
    doc: { idverified: true, first_name: "Anna Maria", last_name: "Smith-Jones" },
    sumsub: null,
  },
  existing: {
    signedIn: true,
    open: true,
    doc: { duplicate: true, duplicateOfEmailMasked: "b\u2022\u2022\u2022\u2022\u2022@gmail.com" },
    sumsub: null,
  },
  underage: {
    signedIn: true,
    open: true,
    doc: { quickVerify: { stage: "under_age" } },
    sumsub: null,
  },
};
const PREVIEW_USER = { uid: "preview", email: "guest@example.com" } as User;

export default function VerifyFlow() {
  const params = useSearchParams();
  const source = (params.get("s") || "link").slice(0, 24);
  const testMode = params.get("test") === "1";
  const stopMode = params.get("stop") === "1";
  // Dead code in a production build (NODE_ENV is inlined).
  const preview =
    process.env.NODE_ENV !== "production"
      ? (PREVIEWS[params.get("preview") || ""] ?? null)
      : null;

  const [fb, setFb] = useState<Fb | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [cfg, setCfg] = useState<PublicConfig | null>(null);
  const [open, setOpen] = useState(false);
  const [inApp, setInApp] = useState(false);
  // undefined = not known yet; null = signed out.
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [userDoc, setUserDoc] = useState<{
    uid: string;
    data: QvUserDoc | null;
  } | null>(null);
  const [sumsub, setSumsub] = useState<Sumsub | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [signInWhileClosed, setSignInWhileClosed] = useState(false);

  // ── load Firebase, the public settings and the session ─────────────
  useEffect(() => {
    let cancelled = false;
    let stopAuth = () => {};
    (async () => {
      try {
        const [web, dbMod, a, f] = await Promise.all([
          import("../lib/firebaseWeb"),
          import("../lib/firebaseDb"),
          import("firebase/auth"),
          import("firebase/firestore"),
        ]);
        if (cancelled) return;
        const auth = web.firebaseAuth();
        const db = dbMod.firebaseDb();
        setFb({ auth, db, a, f });
        setInApp(isInAppBrowser(navigator.userAgent));
        f.getDoc(f.doc(db, QV_CONFIG, "public"))
          .then((s) => resolvePublicConfig(s.exists() ? s.data() : null))
          .catch(() => resolvePublicConfig(null))
          .then((c) => {
            if (cancelled) return;
            setCfg(c);
            setOpen(preview ? preview.open : isOpenNow(c, Date.now()));
          });
        if (preview) {
          setUser(preview.signedIn ? PREVIEW_USER : null);
          setUserDoc({ uid: PREVIEW_USER.uid, data: preview.doc });
          setSumsub(preview.sumsub);
          return;
        }
        stopAuth = a.onAuthStateChanged(auth, (u) => {
          if (!cancelled) setUser(u);
        });
      } catch (e) {
        console.error("[verify] could not load:", e);
        if (!cancelled) setLoadFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      stopAuth();
    };
  }, [preview]);

  // ── the guest's own user doc ───────────────────────────────────────
  useEffect(() => {
    if (!fb || !user || preview) return;
    const uid = user.uid;
    return fb.f.onSnapshot(
      fb.f.doc(fb.db, "users", uid),
      (s) =>
        setUserDoc({ uid, data: s.exists() ? (s.data() as QvUserDoc) : null }),
      () => setUserDoc({ uid, data: null }),
    );
  }, [fb, user, preview]);

  // ── the bot check (Turnstile, the same widget as the guestlist page) ─
  // Its element comes and goes with the screens, so the widget is drawn
  // when the element mounts (a callback ref) or when the script arrives,
  // whichever is later.
  const widgetEl = useRef<HTMLDivElement | null>(null);
  const widgetId = useRef<string | null>(null);
  const tsToken = useRef("");
  const renderWidget = useCallback(() => {
    const el = widgetEl.current;
    if (!el || !window.turnstile || widgetId.current) return;
    widgetId.current = window.turnstile.render(el, {
      sitekey: TURNSTILE_SITE_KEY,
      theme: "dark",
      appearance: "interaction-only",
      callback: (t: string) => {
        tsToken.current = t;
      },
      "error-callback": () => {
        tsToken.current = "";
      },
      "expired-callback": () => {
        tsToken.current = "";
      },
    });
  }, []);
  const botRef = useCallback(
    (el: HTMLDivElement | null) => {
      if (!el && widgetId.current) {
        try {
          window.turnstile?.remove(widgetId.current);
        } catch {
          /* already gone */
        }
        widgetId.current = null;
        tsToken.current = "";
      }
      widgetEl.current = el;
      if (el) renderWidget();
    },
    [renderWidget],
  );
  useEffect(() => {
    const SCRIPT_ID = "cf-turnstile-script";
    if (window.turnstile) {
      renderWidget();
      return;
    }
    if (!document.getElementById(SCRIPT_ID)) {
      const s = document.createElement("script");
      s.id = SCRIPT_ID;
      s.src =
        "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      s.async = true;
      s.defer = true;
      s.onload = renderWidget;
      document.head.appendChild(s);
      return;
    }
    const iv = setInterval(() => {
      if (window.turnstile) {
        clearInterval(iv);
        renderWidget();
      }
    }, 200);
    const stop = setTimeout(() => clearInterval(iv), 10000);
    return () => {
      clearInterval(iv);
      clearTimeout(stop);
    };
  }, [renderWidget]);

  /** The current token, waiting a few seconds for a slow one. Single use. */
  const takeBotToken = useCallback(async (): Promise<string> => {
    for (let i = 0; i < 20 && !tsToken.current; i++) {
      await new Promise((r) => setTimeout(r, 250));
    }
    const t = tsToken.current;
    tsToken.current = "";
    try {
      window.turnstile?.reset(widgetId.current ?? undefined);
    } catch {
      /* nothing to reset */
    }
    return t;
  }, []);

  // ── one request to the backend ─────────────────────────────────────
  const runAction = useCallback(
    async (
      action: string,
      payload: Record<string, unknown> = {},
    ): Promise<ActionResult> => {
      const me = fb?.auth.currentUser;
      if (!fb || !me) return { ok: false, error: "internal" };
      try {
        const ref = await fb.f.addDoc(fb.f.collection(fb.db, QV_ACTIONS), {
          uid: me.uid,
          action,
          status: "pending",
          createdAt: fb.f.serverTimestamp(),
          ...payload,
        });
        return await new Promise<ActionResult>((resolve) => {
          let done = false;
          let stop = () => {};
          const finish = (r: ActionResult) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            stop();
            resolve(r);
          };
          const timer = setTimeout(
            () => finish({ ok: false, error: "timeout" }),
            ACTION_TIMEOUT_MS,
          );
          stop = fb.f.onSnapshot(
            ref,
            (s) => {
              const d = s.data();
              if (!d || d.status === "pending") return;
              if (d.status === "success") {
                finish({
                  ok: true,
                  result: (d.result as Record<string, unknown>) || {},
                });
              } else {
                finish({ ok: false, error: String(d.error || "internal") });
              }
            },
            () => finish({ ok: false, error: "internal" }),
          );
        });
      } catch (e) {
        console.error(`[verify] ${action} failed:`, e);
        return { ok: false, error: "internal" };
      }
    },
    [fb],
  );

  /** Runs a step with the spinner and the error line. */
  const step = useCallback(
    async (
      action: string,
      payload?: Record<string, unknown>,
    ): Promise<ActionResult> => {
      setBusy(true);
      setError("");
      setNotice("");
      const r = await runAction(action, payload);
      if (r.ok) {
        const s = sumsubFrom(r.result);
        if (s) setSumsub(s);
      } else {
        setError(errorText(r.error));
      }
      setBusy(false);
      return r;
    },
    [runAction],
  );

  /** `token`: one already taken (the account form takes it BEFORE it
   *  signs in, because signing in swaps the screen the widget is on). */
  const start = useCallback(
    async (token?: string) => {
      const turnstileToken = token ?? (await takeBotToken());
      return step("start", { source, turnstileToken });
    },
    [step, takeBotToken, source],
  );

  const knownDoc = user && userDoc && userDoc.uid === user.uid ? userDoc : null;
  const stage = knownDoc ? stageFrom(knownDoc.data) : null;

  // Back on the ID step with no token (a reload, or a later visit).
  const askedForToken = useRef(false);
  useEffect(() => {
    // Not while a step is in flight: the address step's own answer
    // carries the token, and the user doc can change a moment before it.
    if (preview) return;
    if (stage !== "id" || sumsub || busy || askedForToken.current) return;
    askedForToken.current = true;
    void step("new_token");
  }, [stage, sumsub, busy, step, preview]);

  // The link in a follow-up email: stop them, once, as soon as we know
  // who this is.
  const stopAsked = useRef(false);
  const [stopState, setStopState] = useState<"waiting" | "done" | "failed">(
    "waiting",
  );
  useEffect(() => {
    if (!stopMode || preview || !user || !knownDoc || stopAsked.current) return;
    stopAsked.current = true;
    void runAction("stop_followups").then((r) =>
      setStopState(r.ok ? "done" : "failed"),
    );
  }, [stopMode, preview, user, knownDoc, runAction]);

  const signOut = useCallback(async () => {
    if (!fb) return;
    askedForToken.current = false;
    setSumsub(null);
    setError("");
    setNotice("");
    await fb.a.signOut(fb.auth);
  }, [fb]);

  // ── screens ────────────────────────────────────────────────────────
  if (loadFailed) {
    return (
      <Card>
        <StatusIcon kind="error" />
        <Title>Couldn&apos;t load</Title>
        <Body>Check your connection and reload this page.</Body>
      </Card>
    );
  }
  if (!fb || !cfg || user === undefined || (user && !knownDoc)) {
    return <LoadingCard title="One moment" message="Getting things ready…" />;
  }
  const t = cfg.text;
  const botWidget = <div ref={botRef} className="flex justify-center pt-1" />;
  const signOutLink = <TextLink onClick={signOut}>{t.signOut}</TextLink>;

  if (!user) {
    const canCreate = !stopMode && (open || testMode);
    if (!canCreate && !signInWhileClosed && !stopMode) {
      return (
        <Card>
          <Title>{t.closedTitle}</Title>
          <Body>{t.closedBody}</Body>
          <div className="mt-6 flex justify-center">
            <AppInstallButton />
          </div>
          <TextLink onClick={() => setSignInWhileClosed(true)}>
            {t.closedSignIn}
          </TextLink>
        </Card>
      );
    }
    return (
      <Card>
        <AccountForm
          fb={fb}
          text={t}
          canCreate={canCreate}
          takeBotToken={takeBotToken}
          onSignedIn={async (needsStart, token) => {
            // A returning guest's own doc says where they are; only a
            // new account (or one that has never used this page) asks.
            if (needsStart && !stopMode) await start(token);
          }}
        />
        {stopMode ? <Note>{t.stopSignIn}</Note> : null}
        {botWidget}
        <ErrorLine>{error}</ErrorLine>
      </Card>
    );
  }

  if (stopMode) {
    const done =
      stopState === "done" || knownDoc?.data?.quickVerify?.followUpStopped === true;
    return (
      <>
        <Card>
          <StatusIcon
            kind={done ? "success" : stopState === "failed" ? "error" : "spinner"}
          />
          <Title>{done ? t.stopTitle : "One moment"}</Title>
          <Body>
            {done
              ? t.stopBody
              : stopState === "failed"
                ? "We couldn't find any emails to stop for this account."
                : "Stopping the emails…"}
          </Body>
        </Card>
        {signOutLink}
      </>
    );
  }

  const u = knownDoc?.data ?? null;
  const email = user.email || "";

  if (stage === "verified") {
    const name = `${u?.first_name || ""} ${u?.last_name || ""}`.trim();
    return (
      <>
        <Card>
          <StatusIcon kind="success" />
          <Title>{t.verifiedTitle}</Title>
          {name ? (
            <p className="mt-2 text-center text-lg font-medium text-white">
              {name}
            </p>
          ) : null}
          <Body>{t.verifiedBody}</Body>
          <div className="mt-5 flex justify-center">
            <div className="rounded-2xl bg-white p-4">
              <QRCodeSVG
                value={`membership/${user.uid}`}
                size={220}
                level="M"
                bgColor="#ffffff"
                fgColor="#000000"
              />
            </div>
          </div>
        </Card>
        <div className="mt-5">
          <Card>
            <Title>{t.appTitle}</Title>
            <Body>{t.appBody}</Body>
            <div className="mt-5 flex justify-center">
              <AppInstallButton />
            </div>
          </Card>
        </div>
        {signOutLink}
      </>
    );
  }

  if (stage === "existing_member") {
    const masked = u?.duplicateOfEmailMasked || "";
    return (
      <>
        <Card>
          <StatusIcon kind="mail" />
          <Title>{t.existingTitle}</Title>
          <Body>
            {masked
              ? fill(t.existingBody, { email: masked })
              : t.existingBodyNoEmail}
          </Body>
          <div className="mt-6 flex justify-center">
            <AppInstallButton />
          </div>
        </Card>
        {signOutLink}
      </>
    );
  }

  if (stage === "under_age" || stage === "deleted") {
    return (
      <>
        <Card>
          <StatusIcon kind="error" />
          <Title>{t.underAgeTitle}</Title>
          <Body>
            {stage === "under_age"
              ? t.underAgeBody
              : errorText("account_deleted")}
          </Body>
        </Card>
        {signOutLink}
      </>
    );
  }

  if (stage === "start" && busy) {
    return <LoadingCard title="One moment" message="Setting things up…" />;
  }
  if (stage === "start") {
    return (
      <>
        <Card>
          <Title>{t.continueTitle}</Title>
          <Body>{t.continueBody}</Body>
          {botWidget}
          <ErrorLine>{error}</ErrorLine>
          <PrimaryButton busy={busy} onClick={() => void start()}>
            {t.continueButton}
          </PrimaryButton>
          {error ? (
            <div className="mt-6 flex justify-center">
              <AppInstallButton />
            </div>
          ) : null}
        </Card>
        {signOutLink}
      </>
    );
  }

  if (stage === "email") {
    return (
      <>
        <Card>
          <CodeForm
            text={t}
            email={email}
            busy={busy}
            onSubmit={(code) => step("verify_email", { code })}
            onResend={async () => {
              const r = await step("resend_code");
              if (r.ok) setNotice(t.codeResent);
            }}
          />
          {notice ? <Note>{notice}</Note> : null}
          <ErrorLine>{error}</ErrorLine>
        </Card>
        {signOutLink}
      </>
    );
  }

  if (stage === "address") {
    return (
      <>
        <Card>
          <AddressForm
            text={t}
            consentEnabled={cfg.consentEnabled}
            busy={busy}
            onSubmit={(payload) => step("save_address", payload)}
          />
          <ErrorLine>{error}</ErrorLine>
        </Card>
        {signOutLink}
      </>
    );
  }

  // stage === "id"
  const idSaysUnder21 = u?.sumsubPassportRequired === true;
  const onPassport = sumsub?.check === "passport";
  if (idSaysUnder21 && sumsub && !onPassport) {
    return (
      <>
        <Card>
          <StatusIcon kind="lock" />
          <Title>{t.passportTitle}</Title>
          <Body>{t.passportBody}</Body>
          <ErrorLine>{error}</ErrorLine>
          <PrimaryButton busy={busy} onClick={() => void step("new_token")}>
            {t.passportButton}
          </PrimaryButton>
        </Card>
        {signOutLink}
      </>
    );
  }
  // No card on this screen: Sumsub's own frame needs the room. Its
  // container runs the full width of the phone (-mx-5 undoes the page's
  // side padding); the words above and the links below keep theirs.
  return (
    <>
      <div>
        <Title>{t.idTitle}</Title>
        <Body>{onPassport ? t.idBodyPassport : t.idBodyAny}</Body>
        {inApp ? <Note>{t.inAppBrowser}</Note> : null}
        <ErrorLine>{error}</ErrorLine>
        {sumsub ? (
          <SumsubCheck
            key={`${sumsub.check}:${sumsub.token}`}
            token={sumsub.token}
            fallbackUrl={sumsub.url}
            fallbackButton={t.idFallbackButton}
            fallbackBody={t.idFallbackBody}
            onNewToken={async () => {
              const r = await runAction("new_token");
              return r.ok ? String(r.result.sumsubToken || "") : "";
            }}
          />
        ) : busy ? (
          <Note>Loading the ID check…</Note>
        ) : (
          <PrimaryButton onClick={() => void step("new_token")}>
            {t.continueButton}
          </PrimaryButton>
        )}
        {sumsub && !idSaysUnder21 ? (
          <TextLink
            disabled={busy}
            onClick={() => void step("new_token", { under21: !onPassport })}
          >
            {onPassport ? t.changeToOver21 : t.changeToUnder21}
          </TextLink>
        ) : null}
      </div>
      {signOutLink}
    </>
  );
}

/* ── email + password ──────────────────────────────────────────────── */

function AccountForm({
  fb,
  text: t,
  canCreate,
  takeBotToken,
  onSignedIn,
}: {
  fb: Fb;
  text: PublicConfig["text"];
  /** Closed = sign in only (someone finishing, or fetching their QR). */
  canCreate: boolean;
  takeBotToken: () => Promise<string>;
  onSignedIn: (needsStart: boolean, botToken: string) => Promise<void>;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [existing, setExisting] = useState(!canCreate);

  const codeOf = (e: unknown) =>
    e && typeof e === "object" && "code" in e ? String(e.code) : "";

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    const mail = email.trim();
    setError("");
    setNotice("");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) {
      setError(authErrorText("auth/invalid-email"));
      return;
    }
    if (password.length < 8 && !existing) {
      setError(authErrorText("auth/weak-password"));
      return;
    }
    setBusy(true);
    try {
      // Before signing in: signing in replaces this screen, and the bot
      // check's widget with it.
      const botToken = await takeBotToken();
      let isNew = false;
      if (canCreate && !existing) {
        try {
          await fb.a.createUserWithEmailAndPassword(fb.auth, mail, password);
          isNew = true;
        } catch (e) {
          if (codeOf(e) !== "auth/email-already-in-use") throw e;
          // Their account already exists: the same password signs them in.
          try {
            await fb.a.signInWithEmailAndPassword(fb.auth, mail, password);
          } catch {
            setExisting(true);
            setError(t.existingAccount);
            return;
          }
        }
      } else {
        try {
          await fb.a.signInWithEmailAndPassword(fb.auth, mail, password);
        } catch (e) {
          const c = codeOf(e);
          setError(
            c === "auth/wrong-password" ||
              c === "auth/invalid-credential" ||
              c === "auth/user-not-found"
              ? "That email and password don't match."
              : authErrorText(c),
          );
          return;
        }
      }
      // An account that has never used this page also needs to start.
      let needsStart = isNew;
      if (!isNew && fb.auth.currentUser) {
        try {
          const s = await fb.f.getDoc(
            fb.f.doc(fb.db, "users", fb.auth.currentUser.uid),
          );
          needsStart = stageFrom(s.exists() ? (s.data() as QvUserDoc) : null) === "start";
        } catch {
          needsStart = false;
        }
      }
      await onSignedIn(needsStart, botToken);
    } catch (e) {
      setError(authErrorText(codeOf(e)));
    } finally {
      setBusy(false);
    }
  }

  async function forgot() {
    const mail = email.trim();
    setError("");
    if (!mail) {
      setError(authErrorText("auth/invalid-email"));
      return;
    }
    try {
      await fb.a.sendPasswordResetEmail(fb.auth, mail);
      setNotice(t.resetSent);
    } catch (e) {
      setError(authErrorText(codeOf(e)));
    }
  }

  return (
    <form onSubmit={submit} noValidate>
      <Title>{t.startTitle}</Title>
      <Body>{t.startBody}</Body>
      <TextField
        id="qv-email"
        label={t.emailLabel}
        type="email"
        value={email}
        onChange={(v) => {
          setEmail(v);
          if (canCreate) setExisting(false);
        }}
        autoComplete="email"
        inputMode="email"
        autoCapitalize="none"
        enterKeyHint="next"
      />
      <TextField
        id="qv-password"
        label={t.passwordLabel}
        type="password"
        value={password}
        onChange={setPassword}
        autoComplete={existing ? "current-password" : "new-password"}
        autoCapitalize="none"
        enterKeyHint="go"
      />
      {!existing ? <Note>{t.passwordHint}</Note> : null}
      {notice ? <Note>{notice}</Note> : null}
      <ErrorLine>{error}</ErrorLine>
      <PrimaryButton type="submit" busy={busy}>
        {t.startButton}
      </PrimaryButton>
      {existing ? (
        <TextLink onClick={() => void forgot()}>{t.forgotPassword}</TextLink>
      ) : null}
    </form>
  );
}

/* ── the 6-digit code ──────────────────────────────────────────────── */

function CodeForm({
  text: t,
  email,
  busy,
  onSubmit,
  onResend,
}: {
  text: PublicConfig["text"];
  email: string;
  busy: boolean;
  onSubmit: (code: string) => Promise<ActionResult>;
  onResend: () => Promise<void>;
}) {
  const [code, setCode] = useState("");
  const [canResendAt, setCanResendAt] = useState(0);
  const [now, setNow] = useState(0);
  const sent = useRef("");

  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, []);

  const send = async (value: string) => {
    if (value.length !== 6 || busy || sent.current === value) return;
    sent.current = value;
    const r = await onSubmit(value);
    if (!r.ok) {
      setCode("");
      sent.current = "";
    }
  };

  const parts = fill(t.codeBody, { email: "\u0000" }).split("\u0000");
  const wait = Math.max(0, Math.ceil((canResendAt - now) / 1000));
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void send(code);
      }}
      noValidate
    >
      <StatusIcon kind="mail" />
      <Title>{t.codeTitle}</Title>
      <Body>
        {parts[0]}
        {parts.length > 1 ? <Em>{email}</Em> : null}
        {parts[1] ?? ""}
      </Body>
      <input
        aria-label={t.codeTitle}
        value={code}
        onChange={(e) => {
          const v = e.target.value.replace(/\D/g, "").slice(0, 6);
          setCode(v);
          if (v.length < 6) sent.current = "";
          void send(v);
        }}
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]*"
        maxLength={6}
        autoFocus
        className="mt-5 w-full rounded-xl border border-white/25 bg-white/5 px-4 py-4 text-center font-mono text-2xl tracking-[0.5em] text-white outline-none transition focus:border-white/60 focus:bg-white/10"
      />
      <PrimaryButton type="submit" busy={busy} disabled={code.length !== 6}>
        {t.codeButton}
      </PrimaryButton>
      <TextLink
        disabled={busy || wait > 0}
        onClick={() => {
          setCanResendAt(Date.now() + RESEND_WAIT_MS);
          setNow(Date.now());
          void onResend();
        }}
      >
        {wait > 0 ? `${t.resendCode} (${wait}s)` : t.resendCode}
      </TextLink>
    </form>
  );
}

/* ── address + age choice ──────────────────────────────────────────── */

function AddressForm({
  text: t,
  consentEnabled,
  busy,
  onSubmit,
}: {
  text: PublicConfig["text"];
  consentEnabled: boolean;
  busy: boolean;
  onSubmit: (payload: Record<string, unknown>) => Promise<ActionResult>;
}) {
  const [line1, setLine1] = useState("");
  const [line2, setLine2] = useState("");
  const [town, setTown] = useState("");
  const [postcode, setPostcode] = useState("");
  const [country, setCountry] = useState("United Kingdom");
  const [age, setAge] = useState<"under" | "over" | null>(null);
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState("");

  function submit(ev: FormEvent) {
    ev.preventDefault();
    setError("");
    if (
      line1.trim().length < 2 ||
      !town.trim() ||
      postcode.trim().length < 2 ||
      country.trim().length < 2
    ) {
      setError(errorText("bad_address"));
      return;
    }
    if (!age) {
      setError(errorText("age_choice"));
      return;
    }
    void onSubmit({
      address: {
        line1: line1.trim(),
        line2: line2.trim(),
        town: town.trim(),
        postcode: postcode.trim(),
        country: country.trim(),
      },
      under21: age === "under",
      consent: consentEnabled ? consent : false,
    });
  }

  return (
    <form onSubmit={submit} noValidate>
      <Title>{t.addressTitle}</Title>
      <Body>{t.addressBody}</Body>
      <TextField
        id="qv-line1"
        label={t.line1Label}
        value={line1}
        onChange={setLine1}
        autoComplete="address-line1"
        autoCapitalize="words"
        maxLength={120}
        enterKeyHint="next"
        autoFocus
      />
      <TextField
        id="qv-line2"
        label={t.line2Label}
        value={line2}
        onChange={setLine2}
        autoComplete="address-line2"
        autoCapitalize="words"
        maxLength={120}
        enterKeyHint="next"
      />
      <div className="grid grid-cols-2 gap-3">
        <TextField
          id="qv-town"
          label={t.townLabel}
          value={town}
          onChange={setTown}
          autoComplete="address-level2"
          autoCapitalize="words"
          maxLength={80}
          enterKeyHint="next"
        />
        <TextField
          id="qv-postcode"
          label={t.postcodeLabel}
          value={postcode}
          onChange={setPostcode}
          autoComplete="postal-code"
          autoCapitalize="characters"
          maxLength={12}
          enterKeyHint="next"
        />
      </div>
      <TextField
        id="qv-country"
        label={t.countryLabel}
        value={country}
        onChange={setCountry}
        autoComplete="country-name"
        autoCapitalize="words"
        maxLength={60}
        enterKeyHint="done"
      />

      <SectionLabel>{t.ageTitle}</SectionLabel>
      <Choice
        label={t.ageTitle}
        value={age}
        onChange={setAge}
        options={[
          { value: "under", label: t.under21 },
          { value: "over", label: t.over21 },
        ]}
      />
      <Note>{t.ageBody}</Note>

      {consentEnabled ? (
        <label className="mt-5 flex cursor-pointer items-start gap-3 text-sm text-white/75">
          <input
            type="checkbox"
            checked={consent}
            onChange={(e) => setConsent(e.target.checked)}
            className="mt-0.5 h-5 w-5 shrink-0 accent-[#cb775a]"
          />
          <span>{t.consentLabel}</span>
        </label>
      ) : null}

      <ErrorLine>{error}</ErrorLine>
      <PrimaryButton type="submit" busy={busy}>
        {t.addressButton}
      </PrimaryButton>
    </form>
  );
}
