import type { Metadata } from "next";
import { Suspense } from "react";

import { LoadingCard } from "../auth/action/ui";
import VerifyFlow from "./VerifyFlow";
import { VerifyShell } from "./ui";

/**
 * Quick Verify (Nov 9, 2026): a guest at the door makes a Tape account,
 * gives their address, verifies their ID with Sumsub and gets the QR the
 * door scans, with no app. Plan and every decision:
 * docs/QUICK_VERIFY_PLAN.md in the app repo.
 *
 * A fixed link. Whether it is open is a setting (a switch plus nights
 * and hours) read from Firestore; closed, the page sends people to the
 * app. The backend decides everything again on each step.
 *
 * `noindex`: this is a door tool, not a page to find by search.
 */
export const metadata: Metadata = {
  title: "Quick ID check · Tape Members",
  description: "Make your Tape account and verify your ID at the door.",
  robots: { index: false, follow: false, nocache: true },
};

export const dynamic = "force-dynamic";

export default function VerifyPage() {
  return (
    <VerifyShell>
      {/* useSearchParams() inside VerifyFlow needs a Suspense boundary. */}
      <Suspense
        fallback={
          <LoadingCard title="One moment" message="Getting things ready…" />
        }
      >
        <VerifyFlow />
      </Suspense>
    </VerifyShell>
  );
}
