import type { Metadata } from "next";
import OpenAppFallback from "../components/OpenAppFallback";

/**
 * Fallback for `tapemembers.com/openChat` — the support-chat
 * Universal Link wired into the free-form WhatsApp auto-reply nudge
 * sent by the `twilioReceived` Cloud Function.
 *
 * Audience: existing Tape members who just messaged our WhatsApp
 * Business number from a phone tied to their account. They almost
 * always already have the app (Universal Link opens it directly —
 * this page never renders for them). The rare case this page IS
 * rendered: the member uninstalled the app since their last visit
 * but still has our number saved. Friendly "Get the app to reply"
 * messaging makes sense for that audience.
 *
 * Replaces the legacy `https://link.tapemembers.com/a5pg1m`
 * Linklyhq static App-Store redirect.
 */
export const metadata: Metadata = {
  title: "Open the Tape Members support chat",
  description:
    "Open the Tape Members app to continue the conversation with our support team.",
  openGraph: {
    title: "Open the Tape Members support chat",
    description:
      "Open the Tape Members app to continue the conversation with our support team.",
    siteName: "Tape Members",
    type: "website",
  },
};

export default function OpenChatPage() {
  return (
    <OpenAppFallback
      headline="Open support chat"
      subhead="Our team replies in the Tape Members app. Get the app to continue the conversation."
    />
  );
}
