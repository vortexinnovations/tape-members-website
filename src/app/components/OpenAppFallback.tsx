import Image from "next/image";
import AppInstallButton from "./AppInstallButton";

/**
 * Shared fallback for the `/openX` Universal Link family. Rendered
 * when a visitor follows a `tapemembers.com/openApp|openChat|
 * openReservation/...` link WITHOUT the Tape app installed —
 * iOS Universal Links / Android App Links bypass this page entirely
 * when the app is present and hand the URL straight to the
 * matching Flutter route.
 *
 * The headline + subhead vary per route (e.g. "Open the support
 * chat" for /openChat, "View your reservation" for
 * /openReservation/:ref) so the install ask is contextual instead
 * of generic. Visual frame matches the existing /getTheApp and
 * reel fallback so all three feel like one site.
 *
 * Lives at one location so when we extend the family (e.g. /openReel,
 * /openOrder) we only touch this one component for copy / layout
 * changes.
 */
export default function OpenAppFallback({
  headline,
  subhead,
}: {
  /** Hero line, ~30 chars. Always capitalised — UPPERCASE styling
   *  is applied by the className. */
  headline: string;
  /** Secondary paragraph under the headline, plain sentence case. */
  subhead: string;
}) {
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
          {headline}
        </h1>
        <p className="max-w-md text-base font-light italic text-white/85 sm:text-lg">
          {subhead}
        </p>
        <AppInstallButton />
      </div>
    </main>
  );
}
