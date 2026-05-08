// /i — short-URL redirect to the proper Branch install link.
// (May 8, 2026.)
//
// Used by the desktop QR code on /getTheApp. The Branch long-URL
// format with all the `$ios_url` / `$android_url` / `$desktop_url`
// fallback params encoded in querystring is ~330 chars long —
// dense enough as a QR code that scanning it on a phone camera
// becomes flaky. This endpoint takes a short URL like
// `https://tapemembers.com/i` (~25 chars) and 302s to the full
// Branch URL on the server, so the QR code stays scan-friendly
// while the install + attribution chain on the destination
// device is unchanged.
//
// Optional reel-share / referrer attribution carries through via
// `?ref=<reelId>&u=<referrer>` — kept short so URLs stay compact:
//
//     /i                     → install with no attribution
//     /i?ref=abc             → install attributed to reel `abc`
//     /i?ref=abc&u=user_xyz  → reel + referrer attribution
//
// On a successful scan from a phone:
//   1. Phone camera opens https://tapemembers.com/i?ref=…&u=…
//   2. This route 302s → Branch long URL with full params
//   3. Branch reads the device UA, opens the app via Universal
//      Link / App Link if installed, otherwise routes to the
//      App Store / Play Store with install-attribution
//      fingerprinting
//   4. After install + first launch, the Flutter app's
//      `getFirstReferringParams()` returns the original
//      `reelRef` / `referrer` so the new user is attributed to
//      the sharer — same as if they'd clicked the badge directly

import { NextResponse } from "next/server";

import { buildStoreRedirectUrl } from "../lib/install";

export const runtime = "nodejs";
// Cache the redirect aggressively — the destination Branch URL
// only changes when we deploy. CDN can serve subsequent QR scans
// without hitting the Lambda.
export const dynamic = "force-static";
export const revalidate = false;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const reelId = url.searchParams.get("ref") ?? undefined;
  const referrer = url.searchParams.get("u") ?? undefined;
  // Channel param so we can split QR-scan analytics from
  // in-flow share clicks. Defaults to qr_desktop because that's
  // the only producer right now; future producers can pass
  // `?c=foo` to override.
  const channel =
      url.searchParams.get("c") ?? "qr_desktop";

  const target = buildStoreRedirectUrl("ios", {
    reelId,
    referrer,
    channel,
    feature: "install_qr",
  });

  // 302 instead of 301 so we can change the Branch URL shape in
  // the future without browsers pinning to the old destination.
  // CDN cache TTL is controlled by the Cache-Control header
  // below, not the status code.
  return NextResponse.redirect(target, {
    status: 302,
    headers: {
      // Cache for 5 minutes at the edge, allow stale-while-
      // revalidate for an hour. Short enough that a deploy
      // propagates quickly, long enough that a burst of QR
      // scans (e.g. someone displaying the QR on a screen)
      // doesn't hammer the Lambda.
      "Cache-Control":
          "public, max-age=0, s-maxage=300, stale-while-revalidate=3600",
    },
  });
}
