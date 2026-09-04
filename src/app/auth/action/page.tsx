import type { Metadata } from "next";
import { Suspense } from "react";

import ActionHandler from "./ActionHandler";
import { LoadingCard, Shell } from "./ui";

/**
 * Custom Firebase email-action handler (Sep 4, 2026).
 *
 * Every account email Firebase Authentication sends for this project
 * — verify your email, reset your password, confirm an email change,
 * undo an email change — carries a link to ONE URL, configured under
 * Firebase Console → Authentication → Templates → "Customize action
 * URL". This page is that URL. The link arrives as
 *
 *   /auth/action?mode=<mode>&oobCode=<code>&apiKey=…&lang=en
 *
 * and the four modes are handled by `ActionHandler` on the client:
 * the one-time code is redeemed against Firebase Auth from the
 * visitor's browser, after App Check attestation, exactly as Google's
 * own hosted page does minus the attestation.
 *
 * Why it exists: Google's hosted handler sends no App Check token, so
 * the day Auth enforcement is switched on it stops working for every
 * member. See `src/app/lib/firebaseWeb.ts` and
 * `docs/PENDING_TIGHTENING_RUNBOOK.md` (Gate C) in the app repo.
 *
 * Deliberately `force-dynamic` + `noindex`: the URL is per-visit and
 * single-use, must never be prerendered, cached or crawled.
 */
export const metadata: Metadata = {
  title: "Account · Tape Members",
  description: "Confirm an account action for Tape Members.",
  robots: { index: false, follow: false, nocache: true },
};

export const dynamic = "force-dynamic";

export default function AuthActionPage() {
  return (
    <Shell>
      {/* useSearchParams() inside ActionHandler needs a Suspense
          boundary in the App Router; the fallback is the same card the
          handler shows while it verifies the code, so there is no
          visual jump between the two. */}
      <Suspense
        fallback={
          <LoadingCard title="One moment" message="Checking your link…" />
        }
      >
        <ActionHandler />
      </Suspense>
    </Shell>
  );
}
