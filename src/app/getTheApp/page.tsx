import Image from "next/image";
import type { Metadata } from "next";
import AppInstallButton from "../components/AppInstallButton";

/**
 * Install CTA page. Two audiences:
 *   1. Members the Flutter web shell redirected here because they
 *      tried to access a member-only route (login-as-non-admin,
 *      signup, home, etc.). Flutter redirects ?redirect=... query
 *      param intent but we don't need it — we just show the
 *      install buttons.
 *   2. Anyone who types /getTheApp directly (rare but possible).
 *
 * Preserves any reel + referrer context via querystring so Branch
 * attribution still lands if the user is mid-install-flow from a
 * reel share link.
 */
export const metadata: Metadata = {
  title: "Get the Tape Members app",
  description: "Download Tape Members to join the guestlist and watch reels.",
  openGraph: {
    title: "Get the Tape Members app",
    description:
      "Download Tape Members to join the guestlist and watch reels.",
    siteName: "Tape Members",
    type: "website",
  },
};

export default async function GetTheAppPage({
  searchParams,
}: {
  searchParams: Promise<{ reel?: string; ref?: string }>;
}) {
  const { reel, ref } = await searchParams;

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-black text-white">
      <Image
        src="/bg.jpg"
        alt="Tape London"
        fill
        className="object-cover"
        priority
        quality={85}
      />
      <div className="absolute inset-0 bg-black/55" />

      <div className="relative z-10 flex flex-col items-center gap-7 px-6 text-center">
        <h1 className="font-tape text-4xl font-extrabold tracking-[0.15em] text-white uppercase sm:text-5xl md:text-6xl">
          Get the app
        </h1>
        <p className="max-w-md text-base font-light italic text-white/85 sm:text-lg">
          Tape Members lives on your phone. Grab the app to join the
          guestlist, watch reels, and book your night.
        </p>
        <AppInstallButton reelId={reel} referrer={ref} />
      </div>
    </main>
  );
}
