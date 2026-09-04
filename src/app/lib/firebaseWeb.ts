/**
 * Firebase Web SDK bootstrap for the few pages on tapemembers.com that
 * talk to Firebase directly (today: the email action handler at
 * /auth/action). Everything else on the site goes through Cloud
 * Functions and never loads the SDK, so this module is imported
 * DYNAMICALLY from a client component only — it must never be pulled
 * into a server bundle or the shared layout.
 *
 * Why App Check is initialised here (Sep 4, 2026)
 * ─────────────────────────────────────────────
 * Firebase's hosted email-action page (`<project>.firebaseapp.com/
 * __/auth/action`) carries no App Check integration at all — its
 * `action.js` sets no `X-Firebase-AppCheck` header. The operations it
 * calls (`resetPassword`, `setAccountInfo`) ARE on App Check's
 * protected list for Authentication, so the day Auth enforcement is
 * switched on, every password-reset and email-verification link would
 * die. This page is the replacement: same calls, made from a page that
 * attests with reCAPTCHA Enterprise first. Activation failure degrades
 * to "no token" (identical to today's hosted page), never to a broken
 * page — the Auth call then succeeds or fails on its own merits.
 *
 * Every value below is PUBLIC by design: the web API key, app id and
 * reCAPTCHA site key are already shipped inside the Flutter web bundle
 * at admin.tapemembers.com. They are not credentials; they are
 * meaningless without the domain allowlists configured against them.
 * The reCAPTCHA Enterprise key must list `tapemembers.com` and
 * `www.tapemembers.com` as allowed domains for attestation to succeed
 * from this site (Google Cloud → reCAPTCHA → key → Domains).
 */

import { getApp, getApps, initializeApp, type FirebaseApp } from "firebase/app";
import {
  initializeAppCheck,
  ReCaptchaEnterpriseProvider,
  type AppCheck,
} from "firebase/app-check";
import { getAuth, type Auth } from "firebase/auth";

/** Same web app registration the Flutter web build uses. */
export const FIREBASE_WEB_CONFIG = {
  apiKey: "AIzaSyCQPDePe95L5ZLG3yoHJZPOg5Pamfzh5eo",
  authDomain: "tape-members.firebaseapp.com",
  projectId: "tape-members",
  storageBucket: "tape-members.appspot.com",
  messagingSenderId: "411799731878",
  appId: "1:411799731878:web:1ee294a7202c4aa7ef3e67",
} as const;

/** reCAPTCHA Enterprise site key `tape-members-web-appcheck` (public). */
export const RECAPTCHA_ENTERPRISE_SITE_KEY =
  "6Lf53owtAAAAAB9XoOPQmsoEClbVORgkUnsl_vsC";

let appCheckInstance: AppCheck | null = null;
let appCheckAttempted = false;

/** Idempotent: React strict mode and client navigations may call this
 *  more than once; Firebase throws on a second `initializeApp` with
 *  the same name, so reuse the default app when it exists. */
export function firebaseApp(): FirebaseApp {
  return getApps().length ? getApp() : initializeApp(FIREBASE_WEB_CONFIG);
}

/**
 * Activates App Check once per page load. Returns whether a provider
 * is now attached — callers only use that for diagnostics; the Auth
 * calls proceed either way.
 *
 * `isTokenAutoRefreshEnabled: true` keeps a fresh token for the
 * duration of a slow password-reset form; without it a token minted at
 * page load could expire while the user is still typing.
 */
export function activateAppCheck(): boolean {
  if (appCheckInstance) return true;
  if (appCheckAttempted) return false;
  appCheckAttempted = true;
  if (typeof window === "undefined") return false;
  try {
    appCheckInstance = initializeAppCheck(firebaseApp(), {
      provider: new ReCaptchaEnterpriseProvider(RECAPTCHA_ENTERPRISE_SITE_KEY),
      isTokenAutoRefreshEnabled: true,
    });
    return true;
  } catch (e) {
    // Never fatal. Matches the Flutter app's `_activateAppCheck`: an
    // attestation problem must degrade to "no token", not "no page".
    console.warn("[auth/action] App Check activation failed:", e);
    return false;
  }
}

/** Auth bound to the default app. App Check must be activated BEFORE
 *  the first Auth call so the token is attached to it. */
export function firebaseAuth(): Auth {
  activateAppCheck();
  return getAuth(firebaseApp());
}
