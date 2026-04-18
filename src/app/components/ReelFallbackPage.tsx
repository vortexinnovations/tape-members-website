import Image from "next/image";
import AppInstallButton from "./AppInstallButton";

/**
 * Rendered when tapemembers.com/r/:id resolves to a reel that's
 * been deleted / taken down / marked `visible: false`.
 *
 * Tone: friendly acknowledgement + same install CTA — someone who
 * tapped a Tape link is still a strong install candidate even if
 * the specific reel is gone, so we don't waste the intent.
 */
export default function ReelFallbackPage({
  reelId,
  referrer,
}: {
  reelId: string;
  referrer?: string;
}) {
  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-black text-white">
      <Image
        src="/bg.jpg"
        alt=""
        fill
        className="object-cover opacity-45"
        priority
      />
      <div className="absolute inset-0 bg-black/50" />

      <div className="relative z-10 flex flex-col items-center gap-6 px-6 text-center">
        <h1 className="font-tape text-3xl font-extrabold tracking-[0.15em] text-white uppercase sm:text-4xl">
          Reel not available
        </h1>
        <p className="max-w-md text-base font-light text-white/80">
          This reel is no longer available. Get the Tape Members app
          to see what&rsquo;s new.
        </p>
        <AppInstallButton reelId={reelId} referrer={referrer} />
      </div>
    </main>
  );
}
