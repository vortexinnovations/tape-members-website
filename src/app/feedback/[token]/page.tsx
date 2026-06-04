import type { Metadata } from "next";

import AppInstallButton from "../../components/AppInstallButton";
import { fetchFeedbackSession } from "../../lib/feedback";
import FeedbackForm from "./FeedbackForm";

type Params = { token: string };

/**
 * Public client-feedback page (June 4, 2026). A waiter's QR lands the
 * client here on their OWN phone. They answer the admin-configured
 * question set and (optionally) leave an email to get the app. The
 * submission is written by the Turnstile-gated submitFeedbackQr Cloud
 * Function — the waiter never sees the content.
 *
 * Invalid / closed / expired / full → a graceful card with a "get the
 * app" CTA rather than a 404.
 */
export default async function FeedbackPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { token } = await params;
  const session = await fetchFeedbackSession(token);

  if (!session) {
    return (
      <FeedbackShell>
        <Fallback
          title="Link not found"
          message="This feedback link is no longer valid. Ask your host for a fresh one."
        />
      </FeedbackShell>
    );
  }
  if (!session.featureEnabled) {
    return (
      <FeedbackShell>
        <Fallback
          title="Feedback closed"
          message="Feedback is currently closed. Thank you for visiting Tape."
        />
      </FeedbackShell>
    );
  }
  if (!session.active || session.expired) {
    return (
      <FeedbackShell>
        <Fallback
          title="Link expired"
          message="This feedback link has expired. Thank you for visiting Tape."
        />
      </FeedbackShell>
    );
  }
  if (session.capReached) {
    return (
      <FeedbackShell>
        <Fallback
          title="All done"
          message="This feedback link has already been used. Thank you!"
        />
      </FeedbackShell>
    );
  }

  return (
    <FeedbackShell>
      <FeedbackForm token={token} session={session} />
    </FeedbackShell>
  );
}

/** Brand shell — dark background + centred card column. */
function FeedbackShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="relative min-h-screen overflow-hidden bg-black text-white">
      <div className="relative z-10 flex min-h-screen flex-col items-center px-5 py-12">
        <div className="w-full max-w-md">{children}</div>
      </div>
    </main>
  );
}

function Fallback({ title, message }: { title: string; message: string }) {
  return (
    <div className="rounded-3xl border border-white/10 bg-black/55 p-8 text-center backdrop-blur-md shadow-[0_20px_60px_rgba(0,0,0,0.55)]">
      <h1 className="font-tape text-lg uppercase tracking-[0.15em] text-white">
        {title}
      </h1>
      <p className="mt-3 text-sm font-light leading-relaxed text-white/70">
        {message}
      </p>
      <div className="mt-7 flex flex-col items-center gap-3">
        <p className="text-xs font-light text-white/50">
          While you&apos;re here — get the Tape Members app:
        </p>
        <AppInstallButton />
      </div>
    </div>
  );
}

export const metadata: Metadata = {
  title: "Your feedback · Tape Members",
  description: "Tell us how your evening at Tape London was.",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";
