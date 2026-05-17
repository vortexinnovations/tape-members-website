import type { Metadata } from "next";
import OpenAppFallback from "../../components/OpenAppFallback";

/**
 * Fallback for `tapemembers.com/openReservation/<bookingRef>` —
 * the table-booking Universal Link wired into the WhatsApp
 * `event_reminder_same_day` and `guestlist_confirmed` template
 * `{{link}}` slots.
 *
 * Audience: members the team is reminding about a specific
 * reservation. They have the app (Universal Link opens it directly
 * — this page never renders for them). The rare case this page IS
 * rendered: the member uninstalled the app between the reservation
 * being booked and the reminder firing.
 *
 * We intentionally DON'T fetch the booking server-side to render
 * "Reservation for Friday at 11pm" copy — it would require a
 * Firestore round-trip on every render of a page that's only seen
 * by uninstalled users, and would surface booking details on a
 * public URL anyone could enumerate. Keep it generic. The
 * `[bookingRef]` segment is preserved in the URL so it survives
 * the install + first-launch, but currently we don't deferred-link
 * post-install — see the note in CLAUDE.md / docs/AUDIT_LOG.md
 * about Branch SDK MAU exposure if we ever want to add that.
 */
type Params = { bookingRef: string };

export const metadata: Metadata = {
  title: "View your reservation",
  description:
    "Open the Tape Members app to view your reservation details.",
  openGraph: {
    title: "View your reservation",
    description:
      "Open the Tape Members app to view your reservation details.",
    siteName: "Tape Members",
    type: "website",
  },
};

export default async function OpenReservationPage({
  params,
}: {
  params: Promise<Params>;
}) {
  // We resolve params so Next.js doesn't warn about unawaited
  // dynamic params, but we deliberately don't surface the bookingRef
  // in the UI — see comment above.
  await params;
  return (
    <OpenAppFallback
      headline="View your reservation"
      subhead="Open the Tape Members app to see your reservation details, confirm attendance, and message the team."
    />
  );
}
