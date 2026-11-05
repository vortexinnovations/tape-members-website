import type { Metadata } from "next";
import Link from "next/link";

/**
 * Public terms of service.
 *
 * Required by Google Play's trader declaration (App content → Trader
 * status asks for a Terms of Service URL) and useful on the App Store
 * listing too. Same regulatory shape as `/privacy-policy` and
 * `/support`.
 *
 * ONE SOURCE OF TRUTH: the body is the same text the app shows on its
 * Terms of Service screen — `policyStrings.termsOfService` in
 * Firestore, which admins edit on /policyContentAdmin. It is read
 * here server-side through the Firestore REST API (the collection's
 * read rule is public, so the web API key is enough) and cached for
 * an hour, so an edit in the app's admin reaches this page without a
 * deploy. Rule 29 of the terms promises "the most recent version
 * always available on the website", and this is what makes that true.
 *
 * If Firestore cannot be reached the page falls back to the copy
 * frozen in FALLBACK_TERMS below (taken Nov 5, 2026) rather than
 * rendering empty — a terms URL that sometimes 500s is worse than one
 * that is occasionally an hour stale.
 *
 * (Nov 5, 2026 — created for the Play Console trader-status
 * declaration; see CLAUDE.md "Nov 5, 2026" in the app repo.)
 */
export const metadata: Metadata = {
  title: "Terms of Service — Tape Members",
  description:
    "The terms and house rules that apply to members of Tape London and users of the Tape Members app.",
  openGraph: {
    title: "Terms of Service — Tape Members",
    description:
      "The terms and house rules that apply to members of Tape London and users of the Tape Members app.",
    siteName: "Tape Members",
    type: "website",
  },
  robots: {
    index: true,
    follow: true,
  },
};

// Re-read from Firestore at most once an hour.
export const revalidate = 3600;

const FIRESTORE_URL =
  "https://firestore.googleapis.com/v1/projects/tape-members/databases/(default)/documents/policyStrings" +
  "?pageSize=1&mask.fieldPaths=termsOfService" +
  "&key=AIzaSyCQPDePe95L5ZLG3yoHJZPOg5Pamfzh5eo";

async function loadTerms(): Promise<{ text: string; live: boolean }> {
  try {
    const res = await fetch(FIRESTORE_URL, { next: { revalidate } });
    if (res.ok) {
      const json = (await res.json()) as {
        documents?: { fields?: { termsOfService?: { stringValue?: string } } }[];
      };
      const text = json.documents?.[0]?.fields?.termsOfService?.stringValue;
      if (text && text.trim().length > 0) return { text, live: true };
    }
  } catch {
    // fall through to the frozen copy
  }
  return { text: FALLBACK_TERMS, live: false };
}

/** "1. Text" paragraphs → numbered items; anything else → a paragraph. */
function parseTerms(text: string): { n: string | null; body: string }[] {
  return text
    .split(/\r?\n\s*\r?\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => {
      const m = p.match(/^(\d+)\.\s+([\s\S]*)$/);
      return m ? { n: m[1], body: m[2] } : { n: null, body: p };
    });
}

export default async function TermsPage() {
  const { text } = await loadTerms();
  const items = parseTerms(text);

  return (
    <main className="min-h-screen bg-black px-5 py-10 text-white sm:py-14">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
        <header className="flex flex-col gap-3">
          <h1 className="font-tape text-3xl font-extrabold tracking-[0.12em] text-white uppercase sm:text-4xl">
            Terms of Service
          </h1>
          <p className="text-white/80 text-sm sm:text-base leading-relaxed">
            These terms apply to members of Tape London and to anyone using
            the Tape Members mobile app and website (together, the
            &ldquo;Service&rdquo;). The Service is provided by Vortex
            Innovations Limited (company number 14435337, registered office
            3rd Floor, 45 Albemarle Street, London, England, W1S 4JL) on
            behalf of Tape London. By creating an account, making a booking
            or entering the venue you agree to the terms below.
          </p>
          <p className="text-white/80 text-sm sm:text-base leading-relaxed">
            How we handle your personal information is set out separately
            in our{" "}
            <Link
              href="/privacy-policy"
              className="underline underline-offset-2"
            >
              Privacy Policy
            </Link>
            . For help with the app, see{" "}
            <Link href="/support" className="underline underline-offset-2">
              Support
            </Link>
            .
          </p>
        </header>

        <section className="flex flex-col gap-3 text-white/85 text-sm leading-relaxed sm:text-base">
          <h2 className="font-semibold text-white tracking-wide text-lg sm:text-xl">
            Membership terms and house rules
          </h2>
          <ol className="flex flex-col gap-3">
            {items.map((it, i) => (
              <li key={i} className="flex gap-3">
                {it.n !== null && (
                  <span className="w-7 shrink-0 text-right tabular-nums text-white/50">
                    {it.n}.
                  </span>
                )}
                <span className="flex-1">{it.body}</span>
              </li>
            ))}
          </ol>
        </section>

        <section className="flex flex-col gap-3 text-white/85 text-sm leading-relaxed sm:text-base">
          <h2 className="font-semibold text-white tracking-wide text-lg sm:text-xl">
            Contact
          </h2>
          <p>
            Questions about these terms:{" "}
            <a
              href="mailto:members@tapemembers.com"
              className="underline underline-offset-2"
            >
              members@tapemembers.com
            </a>
            , or the support chat inside the Tape Members app.
          </p>
        </section>
      </div>
    </main>
  );
}

// The app's terms as they stood on Nov 5, 2026 — used only when the
// live read fails. Edit the live text on /policyContentAdmin, not here.
const FALLBACK_TERMS = `1. All guests must be 18 years old or older to enter.

2. There may be an entry fee. Please refer to the 'Entry Charge Policy' when making a booking for more information regarding specific nights and events.

3. A secure database of guest information, including photo and bio-data, will be maintained with strict confidentiality.

4. A guest may choose to discontinue their involvement at any time, but all outstanding financial obligations must be settled prior to doing so.

5. Tape London reserves the right to withhold communication regarding internal decisions or processes.

6. Children are strictly not allowed.

7. Guests must not be solicited or harassed while at the venue.

8. Mobile phones must be used respectfully within the venue.

9. There is a strict no press policy. Guests are prohibited from disclosing the identity of others within the venue in public spaces.

10. The dress code is elegant and stylish. Sportswear, visible underwear, casual day wear, shorts, or flat open-toe shoes are not permitted. The door team reserves the right to refuse entry if these guidelines are not followed.

11. Tape London's door team reserves the right to deny entry to guests who are deemed to be dressed inappropriately.

12. No illegal substances, dangerous objects, or weapons are permitted on the premises.

13. All bills must be fully settled before leaving the venue.

14. Outside food is not allowed inside the venue.

15. Tape London may close the venue for maintenance, redecoration, or private events from time to time.

16. Any accidents or injuries must be reported immediately.

17. Animals are not permitted in the venue.

18. CCTV is in operation throughout the venue for safety reasons.

19. Smoking is prohibited inside the venue.

20. A disciplinary procedure is in place for any guest whose behavior is deemed damaging to Tape London's reputation, which could result in suspension or removal of access.

21. Access may be revoked or suspended without prior notice if a guest violates venue rules or policies.

22. Previous suspensions or bans remain valid even if an individual is granted access at a later time.

23. Each guest may hold one Tape London account only, registered in their own legal identity. Creating duplicate or additional accounts — including via different names, phone numbers, email addresses, or identification documents — is strictly prohibited, as is sharing account credentials or attempting to circumvent any restriction or suspension by registering a new account. Any account found to be in breach of this policy may be suspended or terminated, along with all other accounts associated with the same individual.

24. Tape London operates as a non-political, social, and recreational venue.

25. Guests have no ownership rights over Tape London's assets, trademarks, or promotional materials.

26. Any personal items brought into the venue are at the guest's own risk.

27. In the event of disputes or questions of interpretation regarding these guidelines, the matter will be resolved in accordance with English law.

28. Due to capacity limits, Tape London may not be able to accommodate guests at certain times.

29. Tape London reserves the right to amend these guidelines, with the most recent version always available on the website.

30. Guests may have their photographs taken during events or while on the premises, and these images may be used within our mobile application or on our social media channels.

31. For any questions regarding these guidelines or general inquiries, please contact us at tapelondon.com.

32. Refund & Sales Policy — All entry fees, ticket purchases, table bookings, and related payments are final, non-refundable, and non-transferable, unless otherwise expressly stated in writing by Tape London. No refunds will be issued for denied entry due to dress code, capacity restrictions, late arrival, or failure to comply with venue policies.`;
