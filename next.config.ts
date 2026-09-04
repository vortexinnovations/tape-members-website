import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow remote images that we use for reel share pages:
  //   - Firebase Storage host holds the Tape logo + user-submitted
  //     profile photos referenced by `ContentFeedRecord.profilePic`
  //     (the `creatorPhotoUrl` field from getPublicReel).
  //   - Without this, next/image silently blocks the <img> load and
  //     the share page falls back to a grey circle, making every
  //     anonymous reel look broken.
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "firebasestorage.googleapis.com",
        pathname: "/**",
      },
    ],
  },

  // Sep 4, 2026 — Firebase Auth email links. When a custom email
  // domain is APPLIED, Firebase's default action links move from
  // `<project>.firebaseapp.com/__/auth/action` to
  // `tapemembers.com/__/auth/action` — a path only Firebase Hosting
  // would serve, and this site is on Vercel. Our handler lives at
  // /auth/action (the "Customize action URL" target); this redirect
  // makes the reserved-path shape land there too, query string
  // intact, so a link is never a 404 whichever shape Firebase mints.
  // Temporary (307) on purpose: nothing should cache it.
  async redirects() {
    return [
      {
        source: "/__/auth/action",
        destination: "/auth/action",
        permanent: false,
      },
    ];
  },
};

export default nextConfig;
