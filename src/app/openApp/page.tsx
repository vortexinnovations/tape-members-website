import type { Metadata } from "next";
import OpenAppFallback from "../components/OpenAppFallback";

/**
 * Fallback for `tapemembers.com/openApp` — the generic "open the
 * app" Universal Link wired into the email "View in App" CTA + the
 * WhatsApp `application_approved` template `{{link}}` slot.
 *
 * When the recipient has the Tape app installed iOS / Android open
 * it directly via Universal Link / App Link — this page never
 * renders. Only visitors WITHOUT the app land here, and they get
 * the standard "Get the app" CTA.
 *
 * Replaces the legacy `https://link.tapemembers.com/a5pg1m` —
 * a Linklyhq static App-Store redirect that just dumped users on
 * the store page even when they had the app installed.
 */
export const metadata: Metadata = {
  title: "Open the Tape Members app",
  description:
    "Download Tape Members to join the guestlist, book your night, and watch reels.",
  openGraph: {
    title: "Open the Tape Members app",
    description:
      "Download Tape Members to join the guestlist, book your night, and watch reels.",
    siteName: "Tape Members",
    type: "website",
  },
};

export default function OpenAppPage() {
  return (
    <OpenAppFallback
      headline="Open the app"
      subhead="Tape Members lives on your phone. Grab the app to join the guestlist, book your night, and watch reels."
    />
  );
}
