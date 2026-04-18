/**
 * Device detection + store-redirect URL construction for the
 * tapemembers.com install flow.
 *
 * Two concerns live here:
 *   1. Telling iOS from Android from desktop based on the UA string.
 *      Naive but good enough — the only consequence of
 *      mis-detection is showing the wrong badge briefly.
 *   2. Constructing the URL the install buttons point at. This is
 *      a Branch long-form URL so reel-share attribution survives
 *      the install hop — Branch captures the click, fingerprints
 *      the device, redirects to the correct store, and matches
 *      the install on first app-open.
 */

export type Platform = "ios" | "android" | "desktop" | "unknown";

export function detectPlatform(userAgent: string): Platform {
  const ua = userAgent.toLowerCase();
  // iPadOS 13+ reports as Mac but also advertises touch support —
  // we care about "this is a phone-sized device" not "strictly iOS".
  // Good enough heuristic for install-badge selection.
  if (/iphone|ipad|ipod/i.test(ua)) return "ios";
  if (/android/i.test(ua)) return "android";
  if (/(macintosh|windows|linux|x11|cros)/i.test(ua)) return "desktop";
  return "unknown";
}

// Direct App Store / Play Store URLs — used as `$ios_url` / `$android_url`
// on the Branch long-form link so the final redirect target is
// correct even if Branch is slow to respond.
const APP_STORE_URL =
  "https://apps.apple.com/gb/app/tape-members/id1665221388";
const PLAY_STORE_URL =
  "https://play.google.com/store/apps/details?id=branded.io.editorx.vortexinnovationsl";

// Branch key — same one used by the Flutter app's generate_referral_url
// custom action. Live key, OK to expose in client bundles (it's the
// public API key, not the secret). Confirmed by inspection of
// lib/custom_code/actions/generate_referral_url.dart in the Flutter
// repo.
const BRANCH_KEY = "key_live_lyrdAo1GQ1fDhbRLYoEllbgmDyf2NLSf";

/**
 * Build a Branch long-form URL that:
 *   - Opens the Tape app directly if installed (Universal Link
 *     handled by Branch's associated domain registration)
 *   - Falls back to the correct platform store otherwise
 *   - Carries `reelRef` + `referrer` as Branch link metadata so
 *     the app's `getFirstReferringParams()` call after install
 *     can attribute the new user to the sharer
 *
 * The same URL works for iOS + Android — Branch's server handles
 * device detection and redirects to the right store. The per-
 * platform direct-store URL params below are fallbacks in case
 * Branch is unreachable.
 *
 * Long-form URLs don't need a server round-trip to create — Branch
 * accepts arbitrary metadata as querystring params and handles the
 * short-link-style behaviour. See
 * https://help.branch.io/developers-hub/docs/creating-a-deep-link#long-links
 */
export function buildStoreRedirectUrl(
  // Kept for call-site readability but Branch handles the actual
  // redirect decision server-side. The channel/feature tags below
  // are what split analytics per button type.
  _targetHint: "ios" | "android",
  opts: { reelId?: string; referrer?: string } = {},
): string {
  const params = new URLSearchParams();
  params.set("~channel", "web-install");
  params.set("~feature", "reel_share");
  if (opts.reelId) params.set("reelRef", opts.reelId);
  if (opts.referrer) params.set("referrer", opts.referrer);
  params.set("$ios_url", APP_STORE_URL);
  params.set("$android_url", PLAY_STORE_URL);
  params.set("$desktop_url", "https://tapemembers.com/getTheApp");
  return `https://tapemembers.app.link/a/${BRANCH_KEY}?${params.toString()}`;
}
