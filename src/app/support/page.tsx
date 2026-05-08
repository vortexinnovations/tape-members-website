import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";

/**
 * Public customer support page.
 *
 * Required by Google Pay Business Console (the "Customer support
 * URL" field on the merchant profile) — they need a publicly
 * reachable page that explains how customers reach us when they
 * have questions. Same regulatory shape as `/delete-account` and
 * `/privacy-policy`.
 *
 * Primary affordance: in-app support chat (per CLAUDE.md Rule
 * #21 — every user-facing "contact us" surface routes to
 * `/supportChat` inside the app, never to WhatsApp / external
 * messaging). Secondary: email. No phone listed because we
 * don't run a customer-support phone line; the only phone we'd
 * publish would be the venue's reception number, which isn't
 * staffed for member-app support and would create a bad
 * experience for callers.
 *
 * (May 8, 2026 — created for the Google Pay Business Console
 * registration. Vortex Innovations Limited needs an "approved"
 * Google Pay merchant entity for Android Google Pay to stop
 * 405-erroring on production payments. The integration setup
 * requires a Customer Support URL field; this page satisfies
 * that requirement + is a useful surface in its own right.)
 */
export const metadata: Metadata = {
  title: "Support — Tape Members",
  description:
    "Get help with the Tape Members app — open the in-app support chat or email us.",
  openGraph: {
    title: "Support — Tape Members",
    description:
      "Get help with the Tape Members app — open the in-app support chat or email us.",
    siteName: "Tape Members",
    type: "website",
  },
  robots: {
    // Indexable so Google's crawler can find it (the merchant
    // verification flow checks the URL is reachable + indexable).
    index: true,
    follow: true,
  },
};

export default function SupportPage() {
  return (
    <main className="relative min-h-screen overflow-hidden bg-black text-white">
      {/* Same background pattern as the homepage so the support
          page reads as a natural part of the marketing site, not
          a tacked-on sub-page. */}
      <Image
        src="/bg.jpg"
        alt="Tape London"
        fill
        className="object-cover"
        priority
        quality={85}
      />
      <div className="absolute inset-0 bg-black/65" />

      <div className="relative z-10 mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-10 px-5 py-12 sm:py-16">
        {/* Hero. */}
        <header className="flex flex-col gap-3 text-center">
          <h1 className="font-tape text-4xl font-extrabold tracking-[0.15em] text-white uppercase sm:text-5xl md:text-6xl">
            Get help
          </h1>
          <p className="mx-auto max-w-md text-sm font-light italic text-white/85 sm:text-base">
            Members support is built into the app — fastest path is to
            message us right where you&apos;re already signed in.
          </p>
        </header>

        {/* Primary: in-app chat. */}
        <Card>
          <CardHeading badge="Fastest">In-app support chat</CardHeading>
          <ol className="ml-5 list-decimal space-y-2 text-sm leading-relaxed text-white/85 sm:text-base">
            <li>
              Open the <strong>Tape Members</strong> app on your phone.
            </li>
            <li>
              Tap the <strong>chat icon</strong> in the top-right of the
              home screen.
            </li>
            <li>
              Send your message. We reply within minutes while the
              venue is open, or by the next morning otherwise.
            </li>
          </ol>
          <p className="mt-4 text-xs text-white/55">
            Need to install the app first?{" "}
            <Link
              href="/getTheApp"
              className="underline underline-offset-2 hover:text-white"
            >
              Get the app
            </Link>
            .
          </p>
        </Card>

        {/* Email. */}
        <Card>
          <CardHeading>Email us</CardHeading>
          <p className="text-sm leading-relaxed text-white/85 sm:text-base">
            For questions you&apos;d rather not send from inside the
            app, drop us an email:
          </p>
          <p className="mt-3">
            <a
              href="mailto:members@tapemembers.com"
              className="text-base font-semibold text-white underline underline-offset-4 hover:text-white/80 sm:text-lg"
            >
              members@tapemembers.com
            </a>
          </p>
          <p className="mt-3 text-xs text-white/55">
            Replies usually arrive within one business day.
          </p>
        </Card>

        {/* Common requests. */}
        <Card>
          <CardHeading>Common requests</CardHeading>
          <ul className="space-y-3 text-sm leading-relaxed text-white/85 sm:text-base">
            <li>
              <strong>Bookings &amp; deposits</strong> — open the booking
              from the app&apos;s home screen and tap the chat icon at
              the top of the booking page. Your message lands directly
              with the reservations team for that booking.
            </li>
            <li>
              <strong>Refunds &amp; payment issues</strong> — start in
              the in-app chat with your payment receipt ID handy. You
              can find every receipt under Profile &rarr; Payment
              History.
            </li>
            <li>
              <strong>Account access &amp; ID verification</strong> —
              message us in the app or email{" "}
              <a
                href="mailto:members@tapemembers.com"
                className="underline underline-offset-2 hover:text-white"
              >
                members@tapemembers.com
              </a>{" "}
              from the address linked to your account.
            </li>
            <li>
              <strong>Delete your account</strong> — visit{" "}
              <Link
                href="/delete-account"
                className="underline underline-offset-2 hover:text-white"
              >
                /delete-account
              </Link>{" "}
              for the secure deletion request form.
            </li>
            <li>
              <strong>Privacy &amp; data</strong> — see our{" "}
              <Link
                href="/privacy-policy"
                className="underline underline-offset-2 hover:text-white"
              >
                Privacy Policy
              </Link>{" "}
              for full details on what we collect, how it&apos;s used,
              and your rights under UK GDPR.
            </li>
          </ul>
        </Card>

        {/* Footer / legal. */}
        <footer className="mt-4 text-center text-xs text-white/50">
          <p>
            Tape Members is operated by Vortex Innovations Limited
            (company no. 14435337), 3rd Floor, 45 Albemarle Street,
            London, England, W1S 4JL.
          </p>
          <p className="mt-2">
            <Link
              href="/privacy-policy"
              className="underline underline-offset-2 hover:text-white"
            >
              Privacy Policy
            </Link>
            <span className="mx-2 text-white/30">·</span>
            <Link
              href="/delete-account"
              className="underline underline-offset-2 hover:text-white"
            >
              Delete account
            </Link>
            <span className="mx-2 text-white/30">·</span>
            <Link
              href="/getTheApp"
              className="underline underline-offset-2 hover:text-white"
            >
              Get the app
            </Link>
          </p>
        </footer>
      </div>
    </main>
  );
}

/**
 * Glassy card — black-translucent on top of the bg image, with a
 * subtle white hairline border + rounded corners. Same visual
 * weight as the install block on /getTheApp so the support page
 * sits in the same brand vocabulary.
 */
function Card({ children }: { children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-white/12 bg-white/5 p-6 backdrop-blur-md sm:p-7">
      {children}
    </section>
  );
}

/**
 * Card heading with optional small "Fastest" / "Email"-style
 * badge in the corner. Keeps the in-app-chat card visually
 * marked as the primary path without a heavy CTA button (this
 * is a static info page, not an action page — the action is in
 * the app itself).
 */
function CardHeading({
  children,
  badge,
}: {
  children: React.ReactNode;
  badge?: string;
}) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <h2 className="text-lg font-semibold text-white sm:text-xl">
        {children}
      </h2>
      {badge ? (
        <span className="rounded-full bg-white/10 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-white/85">
          {badge}
        </span>
      ) : null}
    </div>
  );
}
