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
};

export default nextConfig;
