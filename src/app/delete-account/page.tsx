import type { Metadata } from "next";
import DeleteAccountForm from "./DeleteAccountForm";

/**
 * Public account-deletion request page.
 *
 * Google Play's Data Safety rules require a reachable, HTTP-200 URL
 * where any user can ask for their account (and associated data) to
 * be deleted — even without needing to install or open the app.
 * This page fills that slot.
 *
 * Form submissions flow to `/api/delete-account` which forwards the
 * request to a private Telegram group chat for manual admin action.
 * No Firestore writes happen from this page; it's an intake form.
 */
export const metadata: Metadata = {
  title: "Delete your Tape Members account",
  description:
    "Request deletion of your Tape Members account and associated data.",
  openGraph: {
    title: "Delete your Tape Members account",
    description:
      "Request deletion of your Tape Members account and associated data.",
    siteName: "Tape Members",
    type: "website",
  },
  robots: {
    // Keep this out of search results — it's a utility page linked
    // from the Play Console and in-app settings, not something we
    // want surfaced organically.
    index: false,
    follow: false,
  },
};

export default function DeleteAccountPage() {
  return (
    <main className="min-h-screen bg-black px-5 py-10 text-white sm:py-14">
      <div className="mx-auto flex w-full max-w-xl flex-col gap-8">
        <header className="flex flex-col gap-3 text-center">
          <h1 className="font-tape text-3xl font-extrabold tracking-[0.12em] text-white uppercase sm:text-4xl">
            Delete your account
          </h1>
          <p className="text-white/75 text-sm sm:text-base">
            Submit this form to request deletion of your Tape Members
            account. We&rsquo;ll process your request within 30 days and
            email you once it&rsquo;s complete.
          </p>
        </header>

        <section className="rounded-xl border border-white/15 bg-white/5 p-5 text-sm text-white/80 sm:p-6">
          <h2 className="mb-2 font-semibold tracking-wide text-white uppercase text-xs">
            What gets deleted
          </h2>
          <ul className="list-disc space-y-1.5 pl-5">
            <li>Your profile (name, email, phone, photo, IG handle).</li>
            <li>Booking history, guestlist records, and check-in logs.</li>
            <li>Uploaded content (reels, profile pictures).</li>
            <li>Tape Coins balance and point history.</li>
            <li>Push-notification tokens and device records.</li>
          </ul>
          <h2 className="mt-5 mb-2 font-semibold tracking-wide text-white uppercase text-xs">
            What we may retain
          </h2>
          <p>
            Payment receipts, refund records, and any data we&rsquo;re
            legally required to keep (e.g. for anti-fraud / financial
            record-keeping) will be retained for the period required by
            law. These records are anonymised where possible.
          </p>
        </section>

        <DeleteAccountForm />
      </div>
    </main>
  );
}
