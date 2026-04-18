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
            // Only the /r/* share-link path is deep-linked. Other
            // routes (landing, getTheApp, admin) stay in the
            // browser so members can still see the web pages when
            // they want to. `NOT ` prefix excludes paths.
            "/r/*",
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
