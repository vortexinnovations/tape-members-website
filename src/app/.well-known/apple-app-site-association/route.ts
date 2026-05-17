import { NextResponse } from "next/server";

/**
 * Apple App Site Association file for iOS Universal Links.
 *
 * iOS fetches this file once on app install to verify that
 * tapemembers.com is allowed to deep-link into the Tape Members
 * app. After verification, any tap on a tapemembers.com link
 * opens the app directly — no Safari hop, no "Open in app?"
 * prompt.
 *
 * Critical requirements:
 *   - Served at the exact path /.well-known/apple-app-site-association
 *   - Content-Type must be application/json (or text/plain — NOT
 *     application/pkcs7-mime like older AASA variants)
 *   - No file extension on the path
 *   - HTTPS only
 *
 * The appID format is TEAM_ID.BUNDLE_ID. Bundle ID for iOS is the
 * one configured in Xcode → Signing & Capabilities. If you change
 * either side, iOS caches aggressively — users have to reinstall
 * or wait up to 24h for re-validation.
 */
export async function GET() {
  const aasa = {
    applinks: {
      apps: [],
      details: [
        {
          // Combine Apple Team ID + bundle ID. Update the bundle
          // ID here if it changes in the app's Xcode project.
          appID: "SQL7J6AUPH.branded.io.editorx.vortexinnovationsl",
          paths: [
            // Reel share links — open in the app when installed.
            "/r/*",
            // Drink bar QR landing — every printed bar QR encodes
            // https://tapemembers.com/db/<barId>. Universal Link
            // hands the URL to the app's /db/:barId route which
            // writes a `drinkBarSessionClaims/{}` doc; web fallback
            // (this site) renders an install CTA when the app
            // isn't installed.
            "/db/*",
            // Generic "open the app" Universal Links (May 17, 2026).
            // Covers /openApp, /openChat, and /openReservation/<id>.
            // Used by the email "View in App" CTA + the WhatsApp
            // auto-reply nudge + 3 WhatsApp template `{{link}}`
            // slots. Replaces the legacy `link.tapemembers.com/a5pg1m`
            // Linklyhq App-Store redirect — these open the app
            // DIRECTLY when installed (no third-party hop). Without
            // the app, the matching Next.js page (this site)
            // renders a "Get the app" install CTA.
            "/open*",
            // Other routes (landing, getTheApp, admin, privacy-
            // policy, delete-account) stay in the browser so
            // members can see the web pages when they want to.
            // `NOT ` prefix excludes paths.
          ],
        },
      ],
    },
    // Web Credentials — enables iCloud Keychain password sharing
    // between the web app and the native app for the same domain.
    // Only useful if the native app uses Apple's ASWebAuthenticationSession
    // or similar; harmless otherwise. Kept in for future.
    webcredentials: {
      apps: ["SQL7J6AUPH.branded.io.editorx.vortexinnovationsl"],
    },
  };

  return new NextResponse(JSON.stringify(aasa, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      // Apple caches AASA for up to 24h automatically; setting the
      // header explicitly helps when testing via `curl` or Safari
      // dev tools.
      "Cache-Control": "public, max-age=3600",
    },
  });
}
