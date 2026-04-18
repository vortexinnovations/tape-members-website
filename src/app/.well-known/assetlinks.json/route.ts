import { NextResponse } from "next/server";

/**
 * Digital Asset Links file for Android App Links.
 *
 * Android fetches this once on app install to verify that
 * tapemembers.com is allowed to deep-link into the Tape Members
 * app. After verification, taps on tapemembers.com/r/:id go
 * straight to the app with no disambiguation dialog.
 *
 * Format reference:
 *   https://developer.android.com/training/app-links/verify-site-associations
 *
 * The SHA-256 fingerprint below is the signing certificate the
 * Play Store release build is signed with. If the keystore
 * changes, this file must be updated or Android stops honouring
 * the App Link verification (the link falls back to opening in
 * the browser instead of the app).
 */
export async function GET() {
  const assetLinks = [
    {
      relation: [
        "delegate_permission/common.handle_all_urls",
      ],
      target: {
        namespace: "android_app",
        package_name: "branded.io.editorx.vortexinnovationsl",
        sha256_cert_fingerprints: [
          // Production Play Store signing key for
          // branded.io.editorx.vortexinnovationsl.
          "AD:6E:69:06:8E:C2:87:D1:27:E0:C6:C2:CF:24:31:8F:F2:01:4F:99:C5:C3:29:77:6D:C0:A4:F9:5F:EB:3E:C2",
        ],
      },
    },
  ];

  return new NextResponse(JSON.stringify(assetLinks, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
