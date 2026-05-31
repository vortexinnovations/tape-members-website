import type { Metadata } from "next";
import OpenAppFallback from "../../components/OpenAppFallback";

/**
 * Fallback for `tapemembers.com/openDrinkOrder/<orderId>` —
 * the drink-order Universal Link wired into the WhatsApp
 * `tape_drinks_ready` / `tape_drinks_accepted` /
 * `tape_drinks_cancelled` template `{{link}}` slots AND the
 * email "View order" CTA.
 *
 * Audience: members the bar is messaging about an order in
 * flight. They have the app (Universal Link opens it directly —
 * this page never renders for them). The rare case this IS
 * rendered: the member uninstalled the app between placing the
 * order and the bartender messaging them, or they tapped the
 * link on a different device.
 *
 * Mirrors the openReservation fallback — we intentionally
 * don't fetch the order server-side. The orderId is preserved
 * in the URL so it survives install + first-launch, but we
 * don't deferred-link post-install today.
 */
type Params = { orderId: string };

export const metadata: Metadata = {
  title: "View your drinks order",
  description:
    "Open the Tape Members app to view your drinks order, see your QR code, and pick up at the bar.",
  openGraph: {
    title: "View your drinks order",
    description:
      "Open the Tape Members app to view your drinks order, see your QR code, and pick up at the bar.",
    siteName: "Tape Members",
    type: "website",
  },
};

export default async function OpenDrinkOrderPage({
  params,
}: {
  params: Promise<Params>;
}) {
  await params;
  return (
    <OpenAppFallback
      headline="View your drinks order"
      subhead="Open the Tape Members app to see your order status, show your QR code at the bar, and track pickup."
    />
  );
}
