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
 * does (auth + bookings + reels + ID verification + payments +
 * in-app drink ordering). Editable in this file directly — the
 * in-app privacy screen still loads its body from Firestore
 * (PolicyStrings.privacyPolicy) so the two surfaces can drift; if
 * you change one, mirror the other.
 *
 * May 2, 2026 — full GDPR rewrite. Added missing sections:
 * international data transfers, per-category retention periods,
 * automated decision-making, photographs and imagery, right to
 * object. Identified Vortex Innovations Limited as the data
 * controller (was previously underspecified) with company number
 * and registered office.
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

const LAST_UPDATED = "2 May 2026";

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
            Vortex Innovations Limited (&ldquo;we&rdquo;, &ldquo;us&rdquo;,
            &ldquo;our&rdquo;) is committed to protecting the privacy of our
            users and customers. This Privacy Policy explains how we collect,
            use, store, and share your personal information when you use the
            Tape Members mobile app and website (together, the
            &ldquo;Service&rdquo;).
          </p>
          <p className="text-white/80 text-sm sm:text-base leading-relaxed">
            We comply with the UK General Data Protection Regulation (UK
            GDPR), the Data Protection Act 2018, the EU General Data
            Protection Regulation (GDPR) where applicable, and Apple&rsquo;s
            App Store Review Guidelines (including Guideline 5.1.1).
          </p>
        </header>

        <Section title="1. Data controller">
          <p>
            Vortex Innovations Limited is the data controller for personal
            information processed through the Tape Members App. Our
            registered office is at 3rd Floor, 45 Albemarle Street, London,
            England, W1S 4JL, and our company number is 14435337. We have
            not appointed a Data Protection Officer; data protection
            enquiries are handled by the team contactable at{" "}
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
          <SubHeading>A. Information you provide to us</SubHeading>
          <List>
            <li>
              <strong>Personal information:</strong> Full name, gender,
              WhatsApp number, Instagram username, email, nationality,
              birthdate, and occupation.
            </li>
            <li>
              <strong>Profile information:</strong> Profile photo and
              membership details.
            </li>
            <li>
              <strong>Transaction &amp; payment data:</strong> Payment
              history, billing details, and purchases made through the app
              (processed via Stripe; we do not store card details).
            </li>
            <li>
              <strong>Membership &amp; booking information:</strong> Details
              related to event bookings, guest lists, tickets, reservations,
              table bookings, and in-app drink orders.
            </li>
            <li>
              <strong>Support communications:</strong> Messages you send via
              the in-app support chat, and any AI-generated draft replies you
              choose to send to us in return.
            </li>
          </List>

          <SubHeading>B. Information we automatically collect</SubHeading>
          <List>
            <li>
              <strong>Usage data:</strong> Login times, in-app actions, and
              session duration.
            </li>
            <li>
              <strong>Device information:</strong> Device model, operating
              system, and app version.
            </li>
            <li>
              <strong>Approximate location from IP address:</strong> Used for
              security, fraud prevention, and diagnostics.
            </li>
            <li>
              <strong>Location data (optional):</strong> If enabled, we may
              collect your precise location for personalised services such as
              event recommendations.
            </li>
          </List>

          <SubHeading>C. Information from third parties</SubHeading>
          <List>
            <li>
              <strong>Payment processor (Stripe):</strong> Transaction
              confirmations and fraud prevention reports.
            </li>
            <li>
              <strong>Identity verification (Sumsub):</strong> See Section 3.
            </li>
            <li>
              <strong>Firebase Analytics:</strong> User engagement data to
              improve app performance and features.
            </li>
            <li>
              <strong>Branch (attribution):</strong> When you tap a referral
              or share link, we receive attribution data so we can credit
              the referrer.
            </li>
          </List>
        </Section>

        <Section title="3. Identity verification (Sumsub)">
          <p>
            We use a third-party service, Sumsub, to verify user identity
            when required (e.g. for high-value transactions or regulatory
            compliance). This may include the collection of government-issued
            ID documents, facial biometrics, and other identifying
            information.
          </p>
          <p>
            <strong>
              We do not store ID documents or biometric (face) data
              ourselves.
            </strong>{" "}
            This data is securely stored and processed by Sumsub in
            accordance with their own privacy and security protocols.
          </p>
          <SubHeading>
            Facial data disclosure (App Store Guideline 5.1.1 compliance)
          </SubHeading>
          <List>
            <li>We do not retain face data ourselves.</li>
            <li>
              Facial data is collected solely for the purpose of identity
              verification when required by law or for high-value transaction
              validation.
            </li>
            <li>
              Face data is stored exclusively by Sumsub for the minimum time
              necessary to complete the verification process and for
              compliance with legal and financial regulations. It is not
              stored indefinitely.
            </li>
            <li>
              Face data is shared only with Sumsub. We do not share facial
              data with any other third parties.
            </li>
            <li>
              Sumsub stores face data in accordance with their retention
              policies and privacy practices, which comply with applicable
              laws and require deletion after it is no longer needed for
              verification purposes. For more information, please refer to{" "}
              <a
                href="https://sumsub.com/privacy-notice-service/"
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2"
              >
                Sumsub&rsquo;s Privacy Policy
              </a>
              .
            </li>
            <li>
              Access to verification data on our side is strictly limited to
              trained staff members who require it for legitimate business
              purposes, on a need-to-know basis under controlled and
              restricted access permissions.
            </li>
          </List>
        </Section>

        <Section title="4. How we store your information">
          <p>
            All Tape Members App data is securely stored in Google Firebase,
            primarily in the europe-west2 (London) region. Firebase provides
            encrypted cloud storage, ensuring your personal data is protected
            from unauthorised access, loss, or misuse.
          </p>
          <List>
            <li>
              <strong>Authentication &amp; user data:</strong> Firebase
              Authentication and Firestore.
            </li>
            <li>
              <strong>Payment information:</strong> We do not store full
              payment card details; transactions are securely processed and
              tokenised via Stripe.
            </li>
            <li>
              <strong>Analytics &amp; performance data:</strong> Collected
              via Firebase Analytics to enhance user experience.
            </li>
          </List>
          <p>
            For more details on Firebase security, see{" "}
            <a
              href="https://firebase.google.com/support/privacy"
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2"
            >
              Firebase Privacy &amp; Security
            </a>
            .
          </p>
        </Section>

        <Section title="5. International data transfers">
          <p>
            While we store data primarily in the UK / EEA (europe-west2),
            some of our service providers are based outside the UK or EEA.
            Where personal data is transferred internationally, we rely on
            the following safeguards:
          </p>
          <List>
            <li>
              <strong>Google (Firebase):</strong> Standard Contractual
              Clauses (SCCs) and additional safeguards covered by
              Google&rsquo;s Data Processing Addendum.
            </li>
            <li>
              <strong>Stripe:</strong> Stripe Payments UK Ltd processes UK
              transactions. Where data is transferred to Stripe entities
              outside the UK / EEA, transfers are protected under SCCs and,
              where applicable, the EU-US Data Privacy Framework.
            </li>
            <li>
              <strong>Sumsub:</strong> Operates within the EEA / UK for
              European customers; SCCs in place for any onward transfer.
            </li>
            <li>
              <strong>
                Twilio (SMS), Resend (email), Algolia (search), Branch
                (attribution):
              </strong>{" "}
              SCCs and equivalent safeguards in place.
            </li>
          </List>
          <p>
            You may request a copy of these safeguards by emailing{" "}
            <a
              href="mailto:members@tapemembers.com"
              className="underline underline-offset-2"
            >
              members@tapemembers.com
            </a>
            .
          </p>
        </Section>

        <Section title="6. How we use your information">
          <List>
            <li>
              <strong>Manage membership &amp; app features:</strong>{" "}
              Authenticate users, process payments, and manage bookings.
            </li>
            <li>
              <strong>Improve user experience:</strong> Track app performance
              and fix technical issues.
            </li>
            <li>
              <strong>Process payments:</strong> Secure transactions via
              Stripe, including VAT compliance.
            </li>
            <li>
              <strong>Marketing &amp; notifications:</strong> Send event
              invites, membership updates, and exclusive offers (with your
              consent).
            </li>
            <li>
              <strong>Security &amp; fraud prevention:</strong> Detect
              suspicious activity, prevent unauthorised use, and prevent the
              creation of duplicate accounts.
            </li>
            <li>
              <strong>Legal compliance:</strong> Meet UK financial, tax, and
              GDPR regulations.
            </li>
          </List>
        </Section>

        <Section title="7. Legal basis for processing">
          <p>Under UK GDPR, we process your data based on:</p>
          <List>
            <li>
              <strong>Contractual necessity:</strong> To manage memberships,
              process bookings, and complete transactions.
            </li>
            <li>
              <strong>Legitimate interests:</strong> To provide secure
              services, improve app functionality, prevent fraud, detect
              duplicate accounts, and personalise user experiences.
            </li>
            <li>
              <strong>Consent:</strong> When you enable location sharing,
              receive notifications, opt into marketing, or share content via
              referral links.
            </li>
            <li>
              <strong>Legal obligation:</strong> When required for fraud
              prevention, tax reporting, anti-money-laundering compliance,
              or other regulatory obligations.
            </li>
          </List>
          <p>
            You can withdraw consent at any time via app settings or by
            emailing{" "}
            <a
              href="mailto:members@tapemembers.com"
              className="underline underline-offset-2"
            >
              members@tapemembers.com
            </a>
            .
          </p>
        </Section>

        <Section title="8. Payment information & processing">
          <SubHeading>How payments are processed</SubHeading>
          <p>
            All in-app transactions are securely processed via Stripe
            Payments UK Ltd. We collect and process:
          </p>
          <List>
            <li>Billing information (name, email, transaction details).</li>
            <li>
              Payment method details (card type, last 4 digits — stored by
              Stripe, not us).
            </li>
            <li>
              Purchase history (entry fees, token purchases, table booking
              deposits, in-app drink orders, VAT, and receipts).
            </li>
          </List>
          <p>
            We do not store or process full payment card details. Stripe
            encrypts all financial transactions and complies with PCI DSS
            security standards. For Stripe&rsquo;s full privacy policy, visit{" "}
            <a
              href="https://stripe.com/privacy"
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2"
            >
              stripe.com/privacy
            </a>
            .
          </p>

          <SubHeading>Refunds &amp; chargebacks</SubHeading>
          <p>
            Refunds, where applicable, will be processed in line with our
            Refund Policy. If you dispute a payment (chargeback), Stripe may
            collect additional data to verify the claim.
          </p>

          <SubHeading>How long we retain payment data</SubHeading>
          <p>
            We keep transaction records for a minimum of 6 years, as required
            by UK tax laws. After this period, data is securely deleted
            unless needed for ongoing legal compliance or active disputes.
          </p>
        </Section>

        <Section title="9. Data retention">
          <p>
            Different categories of data are retained for different periods:
          </p>
          <List>
            <li>
              <strong>Account and membership records:</strong> Retained while
              your account is active. After account deletion, anonymised
              summary records may be retained for up to 6 years for fraud
              prevention and regulatory purposes.
            </li>
            <li>
              <strong>Transaction records:</strong> 6 years (UK tax law).
            </li>
            <li>
              <strong>
                Booking history (event entries, table bookings, guest lists):
              </strong>{" "}
              Retained while your account is active and for up to 6 years
              thereafter for legal claims and analytics.
            </li>
            <li>
              <strong>Support chat logs:</strong> Retained for up to 24
              months for service quality and dispute resolution.
            </li>
            <li>
              <strong>Marketing consents:</strong> Until withdrawn, plus a
              record of the consent withdrawal itself for audit purposes.
            </li>
            <li>
              <strong>
                Identity verification data (held by Sumsub):
              </strong>{" "}
              Per Sumsub&rsquo;s retention policy, typically the minimum
              necessary for the regulatory purpose.
            </li>
            <li>
              <strong>
                Device, usage, and analytics data (Firebase Analytics):
              </strong>{" "}
              Aggregated and anonymised after 14 months by default.
            </li>
          </List>
          <p>
            When data is no longer required for any of the above purposes,
            it is securely deleted or irreversibly anonymised.
          </p>
        </Section>

        <Section title="10. Automated decision-making">
          <p>
            We use limited automated decision-making in the following
            contexts:
          </p>
          <List>
            <li>
              <strong>Identity verification (Sumsub):</strong> For high-value
              transactions or regulatory compliance, your identity may be
              verified through automated comparison of your submitted ID
              documents and biometrics. You have the right to request human
              review of any automated identity verification decision.
            </li>
            <li>
              <strong>Fraud detection (Stripe):</strong> Stripe uses
              automated systems to flag suspicious transactions for further
              review.
            </li>
            <li>
              <strong>Duplicate account detection:</strong> We use automated
              checks to identify potential duplicate or fraudulent accounts.
              If your account is flagged in error, you may request a human
              review.
            </li>
          </List>
          <p>
            To request human review of any automated decision affecting you,
            contact{" "}
            <a
              href="mailto:members@tapemembers.com"
              className="underline underline-offset-2"
            >
              members@tapemembers.com
            </a>
            .
          </p>
        </Section>

        <Section title="11. Children&rsquo;s data">
          <p>
            The Tape Members App and Tape London venue are strictly for users
            aged 18 and over. We do not knowingly collect personal
            information from anyone under 18. If you become aware that a
            minor has provided us with personal information, please contact
            us at{" "}
            <a
              href="mailto:members@tapemembers.com"
              className="underline underline-offset-2"
            >
              members@tapemembers.com
            </a>{" "}
            and we will take steps to delete the information.
          </p>
        </Section>

        <Section title="12. Photographs and imagery">
          <p>
            Photographs may be taken inside the Tape London venue during
            events. By attending an event, you acknowledge that your image
            may be captured and may be used by Tape London within the Tape
            Members App, on our social media channels, or for legitimate
            operational purposes (e.g. door identification, fraud
            prevention). If you do not wish to have your image used in
            marketing material, you may contact{" "}
            <a
              href="mailto:members@tapemembers.com"
              className="underline underline-offset-2"
            >
              members@tapemembers.com
            </a>{" "}
            to request removal from public-facing surfaces.
          </p>
        </Section>

        <Section title="13. How we share your information">
          <p>
            We do not sell or rent your personal data. We may share
            information with the following categories of recipient:
          </p>
          <List>
            <li>
              <strong>Payment Processor (Stripe):</strong> To securely
              process transactions and handle disputes.
            </li>
            <li>
              <strong>Identity Verification (Sumsub):</strong> For
              verification when required by law or for high-value
              transactions.
            </li>
            <li>
              <strong>Cloud Infrastructure (Google Firebase):</strong> For
              secure cloud storage, authentication, push notifications, and
              analytics.
            </li>
            <li>
              <strong>
                Communications Providers (Twilio, Resend):
              </strong>{" "}
              To deliver SMS and email notifications.
            </li>
            <li>
              <strong>Search Provider (Algolia):</strong> For in-app search
              functionality.
            </li>
            <li>
              <strong>Attribution (Branch):</strong> For referral and
              share-link tracking.
            </li>
            <li>
              <strong>Marketing &amp; analytics services:</strong> Facebook
              Ads, Google Ads, and Firebase Analytics for user-engagement
              tracking and advertising.
            </li>
            <li>
              <strong>Event Promoters:</strong> Where you have been invited
              to Tape London by a registered promoter, we may share
              confirmation of your attendance (entry and/or exit) at the
              venue with that promoter for the legitimate purpose of
              managing guest bookings, club operations, and promoter
              accountability.
            </li>
            <li>
              <strong>Regulatory &amp; legal authorities:</strong> If
              required for tax compliance, fraud prevention,
              anti-money-laundering, or legal disputes.
            </li>
          </List>
          <p>
            Your data is never shared with third parties for their
            independent marketing without your explicit consent. All shared
            data is limited to the minimum necessary and is protected by
            access controls and contractual safeguards.
          </p>
        </Section>

        <Section title="14. Cookies and similar technologies">
          <p>
            The Tape Members App uses limited tracking technologies for
            functionality and analytics:
          </p>
          <List>
            <li>
              <strong>Authentication tokens:</strong> Required to keep you
              logged in.
            </li>
            <li>
              <strong>Device identifiers:</strong> Used by Firebase
              Analytics and crash reporting.
            </li>
            <li>
              <strong>Push notification tokens:</strong> For sending you
              in-app notifications (with your consent).
            </li>
          </List>
          <p>
            We do not use third-party advertising cookies inside the App.
            The Tape London website may use cookies — see the website&rsquo;s
            separate cookie banner for details.
          </p>
        </Section>

        <Section title="15. Your rights under UK GDPR">
          <p>You have the following rights regarding your personal data:</p>
          <List>
            <li>
              <strong>Access:</strong> Request a copy of the personal data
              we hold about you.
            </li>
            <li>
              <strong>Rectification:</strong> Request corrections to
              inaccurate or incomplete data.
            </li>
            <li>
              <strong>
                Erasure (&ldquo;Right to be Forgotten&rdquo;):
              </strong>{" "}
              Request deletion of your data, subject to legal or regulatory
              retention requirements. You can submit a deletion request at{" "}
              <Link
                href="/delete-account"
                className="underline underline-offset-2"
              >
                tapemembers.com/delete-account
              </Link>
              .
            </li>
            <li>
              <strong>Restriction:</strong> Limit how we use your data while
              a query is being resolved.
            </li>
            <li>
              <strong>Data portability:</strong> Receive your data in a
              structured, machine-readable format.
            </li>
            <li>
              <strong>Object to processing:</strong> Object to processing
              based on legitimate interests, including direct marketing.
            </li>
            <li>
              <strong>Withdraw consent:</strong> Where processing is based
              on consent, you may withdraw it at any time.
            </li>
            <li>
              <strong>
                Not be subject to solely automated decisions:
              </strong>{" "}
              Request human review of significant automated decisions
              affecting you.
            </li>
          </List>
          <p>
            You can exercise these rights via the Tape Members App settings
            or by emailing{" "}
            <a
              href="mailto:members@tapemembers.com"
              className="underline underline-offset-2"
            >
              members@tapemembers.com
            </a>
            . We will respond within one month, as required by UK GDPR. If
            your request is complex or you have made multiple requests, we
            may extend this period by up to two further months and will
            explain why.
          </p>
        </Section>

        <Section title="16. How we protect your data">
          <p>
            We take security seriously and implement industry-standard
            protections, including:
          </p>
          <List>
            <li>
              <strong>Data encryption:</strong> Firebase encrypts data at
              rest and in transit.
            </li>
            <li>
              <strong>Secure access controls:</strong> Only authorised
              personnel can access personal data, on a need-to-know basis.
            </li>
            <li>
              <strong>Fraud prevention:</strong> Stripe&rsquo;s security
              measures and our internal duplicate-account detection help
              prevent unauthorised payments and account misuse.
            </li>
            <li>
              <strong>Regular security audits:</strong> We routinely monitor
              and improve our security practices.
            </li>
            <li>
              <strong>Data breach notification:</strong> In the unlikely
              event of a personal data breach likely to result in a risk to
              your rights and freedoms, we will notify the Information
              Commissioner&rsquo;s Office within 72 hours, and notify
              affected users without undue delay where required by law.
            </li>
          </List>
          <p>
            If you suspect unauthorised access to your account, contact{" "}
            <a
              href="mailto:members@tapemembers.com"
              className="underline underline-offset-2"
            >
              members@tapemembers.com
            </a>{" "}
            immediately.
          </p>
        </Section>

        <Section title="17. Changes to our privacy policy">
          <p>We may update this Privacy Policy from time to time.</p>
          <List>
            <li>
              Material changes will be communicated via email or the Tape
              Members App.
            </li>
            <li>Minor updates will be posted in the app settings.</li>
          </List>
          <p>
            The &ldquo;Last updated&rdquo; date at the top of this Policy
            reflects the most recent revision. Please check the Privacy
            Policy section in the app periodically for updates.
          </p>
        </Section>

        <Section title="18. How to make a complaint">
          <p>
            If you have a concern about how we handle your personal data,
            please contact us first at{" "}
            <a
              href="mailto:members@tapemembers.com"
              className="underline underline-offset-2"
            >
              members@tapemembers.com
            </a>{" "}
            — we&rsquo;ll do our best to resolve it.
          </p>
          <p>
            If you remain unsatisfied, you have the right to lodge a
            complaint with the UK Information Commissioner&rsquo;s Office
            (ICO):
          </p>
          <List>
            <li>Information Commissioner&rsquo;s Office</li>
            <li>Wycliffe House, Water Lane</li>
            <li>Wilmslow, Cheshire SK9 5AF</li>
            <li>Helpline: 0303 123 1113</li>
            <li>
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
        </Section>

        <Section title="19. Contact us">
          <p>
            For any questions about this Privacy Policy, data protection, or
            your rights:
          </p>
          <List>
            <li>
              Email:{" "}
              <a
                href="mailto:members@tapemembers.com"
                className="underline underline-offset-2"
              >
                members@tapemembers.com
              </a>
            </li>
            <li>WhatsApp: +44 7916 102611</li>
          </List>
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
