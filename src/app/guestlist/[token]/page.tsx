import type { Metadata } from "next";
import { headers } from "next/headers";

import AppInstallButton from "../../components/AppInstallButton";
import { fetchGuestlistSession } from "../../lib/guestlist";
import GuestlistForm from "./GuestlistForm";
import { STRINGS, pickLang, type GuestlistStrings } from "./translations";

type Params = { token: string };

/**
 * Public guest-list self-add page. A promoter's QR (or an emailed
 * invite link) lands here. The visitor enters their name + guests +
 * email and is added to the guest list as Un-confirmed bookings via
 * the submitGuestlistJoin Cloud Function. On success they get a QR to
 * show at the door (+ an emailed copy in a later phase).
 *
 * If the token is invalid / closed / expired / full we render a
 * graceful card with a "get the app" CTA rather than a 404.
 *
 * July 22, 2026 — multi-language: the browser's Accept-Language
 * header picks the initial language server-side (EN/EL/IT/FR/ES/DE/
 * PT — Mykonos visitor mix); the form has a pill switcher whose
 * choice persists in localStorage. Fallback (dead-link) cards are
 * server-rendered so they use the header-detected language only.
 */
export default async function GuestlistPage({
  params,
  searchParams,
}: {
  params: Promise<Params>;
  searchParams: Promise<{ e?: string }>;
}) {
  const { token } = await params;
  const { e } = await searchParams;
  const hdrs = await headers();
  const lang = pickLang(hdrs.get("accept-language"));
  const t = STRINGS[lang];
  const session = await fetchGuestlistSession(token);

  if (!session) {
    return (
      <GuestlistShell>
        <Fallback t={t} title={t.fbNotFoundTitle} message={t.fbNotFoundMsg} />
      </GuestlistShell>
    );
  }
  if (!session.featureEnabled) {
    return (
      <GuestlistShell>
        <Fallback
          t={t}
          title={t.fbSignupsClosedTitle}
          message={t.fbSignupsClosedMsg}
        />
      </GuestlistShell>
    );
  }
  if (!session.active || session.expired) {
    return (
      <GuestlistShell>
        <Fallback
          t={t}
          title={t.fbListClosedTitle}
          message={t.fbListClosedMsg}
        />
      </GuestlistShell>
    );
  }
  if (session.capReached) {
    return (
      <GuestlistShell>
        <Fallback t={t} title={t.fbFullTitle} message={t.fbFullMsg} />
      </GuestlistShell>
    );
  }

  return (
    <GuestlistShell>
      <GuestlistForm
        token={token}
        session={session}
        prefillEmail={(e || "").trim()}
        initialLang={lang}
      />
    </GuestlistShell>
  );
}

/** Brand shell — dark background + centred card column. */
function GuestlistShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="relative min-h-screen overflow-hidden bg-black text-white">
      <div className="relative z-10 flex min-h-screen flex-col items-center px-5 py-12">
        <div className="w-full max-w-md">{children}</div>
      </div>
    </main>
  );
}

function Fallback({
  t,
  title,
  message,
}: {
  t: GuestlistStrings;
  title: string;
  message: string;
}) {
  return (
    <div className="rounded-3xl border border-white/10 bg-black/55 p-8 text-center backdrop-blur-md shadow-[0_20px_60px_rgba(0,0,0,0.55)]">
      <h1 className="font-tape text-lg uppercase tracking-[0.15em] text-white">
        {title}
      </h1>
      <p className="mt-3 text-sm font-light leading-relaxed text-white/70">
        {message}
      </p>
      <div className="mt-7 flex flex-col items-center gap-3">
        <p className="text-xs font-light text-white/50">{t.fbAppNudge}</p>
        <AppInstallButton />
      </div>
    </div>
  );
}

export const metadata: Metadata = {
  title: "Join the guest list · Tape Members",
  description: "Add yourself and your guests to the Tape London guest list.",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";
