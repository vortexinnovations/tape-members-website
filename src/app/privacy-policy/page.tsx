import type { Metadata } from "next";
import Link from "next/link";

/**
 * Public privacy policy.
 *
 * Required by Google Play (Data Safety section) and Apple App Store
 * — both demand a publicly reachable URL that comprehensively
 * describes data collection, use, sharing, retention, and the
 * user's rights. Previously 404'd, which got the listing rejected
 * with the "Invalid Privacy policy" review action.
 *
 * Written specifically against what the Tape Members app actually
 * does (auth + bookings + reels + ID verification + payments).
 * Editable in this file directly — the in-app privacy screen still
 * loads its body from Firestore (PolicyStrings.privacyPolicy) so
 * the two surfaces can drift; if you change one, mirror the other.
 */
export const metadata: Metadata = {
  title: "Privacy Policy — Tape Members",
  description:
    "How Tape Members collects, uses, and protects your personal information.",
  openGraph: {
    title: "Privacy Policy — Tape Members",
    description:
      "How Tape Members collects, uses, and protects your personal information.",
    siteName: "Tape Members",
    type: "website",
  },
  robots: {
    // Indexable so Google's policy crawler can find it. The
    // delete-account utility is noindex; this one isn't.
    index: true,
    follow: true,
  },
};

const LAST_UPDATED = "21 April 2026";

export default function PrivacyPolicyPage() {
  return (
    <main className="min-h-screen bg-black px-5 py-10 text-white sm:py-14">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
        <header className="flex flex-col gap-3">
          <h1 className="font-tape text-3xl font-extrabold tracking-[0.12em] text-white uppercase sm:text-4xl">
            Privacy Policy
          </h1>
          <p className="text-sm text-white/60">Last updated: {LAST_UPDATED}</p>
          <p className="text-white/80 text-sm sm:text-base leading-relaxed">
            This Privacy Policy explains how Tape Members (&ldquo;we&rdquo;,
            &ldquo;us&rdquo;, &ldquo;our&rdquo;) collects, uses, shares, and
            protects information about you when you use the Tape Members
            mobile app and website (together, the &ldquo;Service&rdquo;).
          </p>
        </header>

        <Section title="1. Who we are">
          <p>
            Tape Members is the membership and booking app for Tape London.
            For privacy questions, data-access requests, or complaints,
            contact us at{" "}
            <a
              href="mailto:members@tapemembers.com"
              className="underline underline-offset-2"
            >
              members@tapemembers.com
            </a>
            .
          </p>
        </Section>

        <Section title="2. Information we collect">
          <p>
            We collect the following categories of information when you use
            the Service:
          </p>
          <SubHeading>Account &amp; profile information</SubHeading>
          <List>
            <li>First and last name</li>
            <li>Email address and phone number</li>
            <li>Date of birth and gender</li>
            <li>Profile photo</li>
            <li>Instagram handle (optional)</li>
            <li>Occupation and interests (optional, for membership review)</li>
            <li>
              Residential address (only when required for ID verification)
            </li>
          </List>

          <SubHeading>Identity verification</SubHeading>
          <p>
            To meet door-policy and licensing requirements, we may ask you
            to complete identity verification through our processor Sumsub.
            This involves submitting a government-issued photo ID and a
            selfie. Sumsub returns a verification result and limited
            extracted fields (such as name, date of birth, and ID expiry
            date) which we store against your account. Source images are
            held by Sumsub under their own retention policy.
          </p>

          <SubHeading>Booking, guestlist, and check-in data</SubHeading>
          <List>
            <li>Events you book or request guestlist access to</li>
            <li>
              Group composition (number of guests, names of additional
              guests where you provide them)
            </li>
            <li>Check-in and check-out timestamps</li>
            <li>Door-staff notes related to your visit</li>
            <li>Tape Coins balance and point history</li>
          </List>

          <SubHeading>Payment information</SubHeading>
          <p>
            Payments are processed by Stripe. We do not store full card
            numbers, security codes, or banking credentials on our servers.
            We retain transaction metadata such as amount, currency,
            timestamp, last-four digits of the card, and Stripe&rsquo;s
            internal reference IDs for record-keeping, refund processing,
            and fraud prevention.
          </p>

          <SubHeading>Content you upload</SubHeading>
          <List>
            <li>Reels and other media you post within the app</li>
            <li>Profile pictures and any updates you make to them</li>
            <li>Feedback, ratings, and free-text submissions</li>
          </List>

          <SubHeading>Device and usage information</SubHeading>
          <List>
            <li>Device type, operating system version, and app version</li>
            <li>Push-notification tokens (FCM) for sending you alerts</li>
            <li>
              IP address (collected automatically by our servers and CDN
              providers)
            </li>
            <li>
              In-app activity logs (e.g. pages viewed, swipes on reels) used
              for diagnostics and product improvement
            </li>
            <li>Approximate location, derived from IP address only</li>
          </List>

          <SubHeading>Communications</SubHeading>
          <p>
            We retain transactional messages we send you (booking
            confirmations, password resets, refund notifications) and any
            replies you send to us through email or in-app support chat.
          </p>
        </Section>

        <Section title="3. How we use your information">
          <List>
            <li>To create and operate your Tape Members account</li>
            <li>
              To process bookings, guestlist requests, and door check-ins
            </li>
            <li>To process payments and refunds</li>
            <li>
              To verify your identity and ensure you meet age and admission
              requirements
            </li>
            <li>
              To send you transactional notifications about your account,
              bookings, and refunds
            </li>
            <li>To respond to support requests</li>
            <li>To prevent fraud and enforce our Terms of Service</li>
            <li>
              To improve the Service through diagnostics and aggregate
              analytics
            </li>
            <li>To comply with legal and regulatory obligations</li>
          </List>
        </Section>

        <Section title="4. How we share your information">
          <p>
            We do not sell your personal information. We share information
            only with the following categories of recipients, and only to
            the extent needed to operate the Service:
          </p>
          <List>
            <li>
              <strong>Service providers (sub-processors)</strong> who run
              parts of our infrastructure on our behalf:
              <ul className="mt-2 ml-5 list-disc space-y-1">
                <li>
                  <strong>Google Firebase</strong> — authentication,
                  database (Firestore), file storage, push notifications
                  (FCM), and serverless functions
                </li>
                <li>
                  <strong>Stripe</strong> — payment processing and refunds
                </li>
                <li>
                  <strong>Sumsub</strong> — identity verification (KYC)
                </li>
                <li>
                  <strong>Twilio</strong> — SMS notifications and one-time
                  codes
                </li>
                <li>
                  <strong>Resend</strong> — transactional email delivery
                </li>
                <li>
                  <strong>Algolia</strong> — search indexing (limited
                  account fields)
                </li>
                <li>
                  <strong>Branch</strong> — deep-link routing and install
                  attribution
                </li>
                <li>
                  <strong>Apple Wallet</strong> — generating digital
                  membership passes (only when you choose to add the pass)
                </li>
                <li>
                  <strong>Vercel</strong> — hosting for our public website
                </li>
              </ul>
            </li>
            <li>
              <strong>Tape London staff</strong> with access to admin tools
              for the purposes of running events, processing bookings, and
              providing member support
            </li>
            <li>
              <strong>Authorities</strong> where we are required to do so by
              law, court order, or to investigate fraud or safety incidents
            </li>
            <li>
              <strong>A buyer or successor entity</strong> in the event of a
              merger, acquisition, or sale of assets, subject to the same
              protections
            </li>
          </List>
        </Section>

        <Section title="5. Data retention">
          <p>
            We retain account information for as long as your account is
            active. After you request deletion (see Section 7), we delete
            your profile, bookings, content, and related personal data
            within 30 days, except for:
          </p>
          <List>
            <li>
              Records we are legally required to retain (such as payment
              receipts and refund records, typically held for at least 6
              years to satisfy financial record-keeping obligations);
            </li>
            <li>
              Anonymised or aggregated data that no longer identifies you;
            </li>
            <li>
              Records relevant to active disputes, investigations, or
              safety incidents, until those matters are resolved.
            </li>
          </List>
        </Section>

        <Section title="6. Security">
          <p>
            We use technical and organisational safeguards to protect your
            information, including encryption in transit (HTTPS), encrypted
            storage at rest with our cloud providers, role-based access
            control for staff, and regular review of admin access. No
            internet-based service is perfectly secure; if we become aware
            of a breach affecting your personal data, we will notify you in
            accordance with applicable law.
          </p>
        </Section>

        <Section title="7. Your rights">
          <p>
            Depending on where you live, you may have rights to:
          </p>
          <List>
            <li>Access the personal data we hold about you</li>
            <li>
              Correct inaccurate or incomplete data (you can update most
              profile fields directly within the app)
            </li>
            <li>
              Request deletion of your account and associated data — submit
              a request at{" "}
              <Link
                href="/delete-account"
                className="underline underline-offset-2"
              >
                tapemembers.com/delete-account
              </Link>
            </li>
            <li>Object to or restrict certain processing</li>
            <li>Receive a copy of your data in a portable format</li>
            <li>Withdraw consent where processing is based on consent</li>
            <li>
              Lodge a complaint with your data protection authority — for
              UK residents this is the Information Commissioner&rsquo;s
              Office (ICO),{" "}
              <a
                href="https://ico.org.uk"
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2"
              >
                ico.org.uk
              </a>
            </li>
          </List>
          <p>
            To exercise any of these rights, email{" "}
            <a
              href="mailto:members@tapemembers.com"
              className="underline underline-offset-2"
            >
              members@tapemembers.com
            </a>
            . We may need to verify your identity before responding.
          </p>
        </Section>

        <Section title="8. International transfers">
          <p>
            Some of our service providers operate servers outside the United
            Kingdom and the European Economic Area. Where we transfer your
            data internationally, we rely on lawful transfer mechanisms
            (such as the UK International Data Transfer Agreement, the EU
            Standard Contractual Clauses, or the recipient&rsquo;s adequacy
            status) to ensure your data remains protected.
          </p>
        </Section>

        <Section title="9. Children">
          <p>
            The Service is intended for users aged 18 and over. We do not
            knowingly collect personal information from anyone under 18. If
            you believe a minor has created an account, please contact us
            and we will take steps to delete it.
          </p>
        </Section>

        <Section title="10. Cookies and similar technologies">
          <p>
            Our website uses a small number of strictly-necessary cookies
            and similar technologies to keep you signed in and to remember
            session preferences. We do not use third-party advertising
            cookies or cross-site tracking on the website. The mobile app
            does not use browser cookies but stores limited preference data
            on your device using the operating system&rsquo;s standard
            secure storage.
          </p>
        </Section>

        <Section title="11. Changes to this policy">
          <p>
            We may update this Privacy Policy from time to time. When we
            make material changes, we will update the &ldquo;Last
            updated&rdquo; date at the top of this page and, where
            appropriate, notify you in the app or by email.
          </p>
        </Section>

        <Section title="12. Contact us">
          <p>
            For privacy questions, complaints, or to exercise any of the
            rights described above, contact us at{" "}
            <a
              href="mailto:members@tapemembers.com"
              className="underline underline-offset-2"
            >
              members@tapemembers.com
            </a>
            .
          </p>
        </Section>
      </div>
    </main>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3 text-white/85 text-sm leading-relaxed sm:text-base">
      <h2 className="font-semibold text-white tracking-wide text-lg sm:text-xl">
        {title}
      </h2>
      {children}
    </section>
  );
}

function SubHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mt-3 text-xs font-semibold uppercase tracking-wide text-white/70">
      {children}
    </h3>
  );
}

function List({ children }: { children: React.ReactNode }) {
  return (
    <ul className="list-disc space-y-1.5 pl-5 text-white/85">{children}</ul>
  );
}
