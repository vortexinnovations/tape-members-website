import Image from "next/image";
import AppInstallButton from "./components/AppInstallButton";

/**
 * Landing page at tapemembers.com/
 *
 * Intentionally minimal — one hero image, a Tape-font headline,
 * a one-line pitch, and a single device-aware install button that
 * deep-links into the app if installed. The install flow is
 * Branch-powered so any reel-share attribution survives the
 * install hop (see AppInstallButton).
 */
export default function Home() {
  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-black">
      {/* Background image */}
      <Image
        src="/bg.jpg"
        alt="Tape London"
        fill
        className="object-cover"
        priority
        quality={85}
      />

      {/* Dark overlay for headline readability */}
      <div className="absolute inset-0 bg-black/55" />

      {/* Content */}
      <div className="relative z-10 flex flex-col items-center gap-7 px-6 text-center">
        <h1 className="font-tape text-5xl font-extrabold tracking-[0.15em] text-white uppercase sm:text-6xl md:text-8xl">
          All Roads Lead
          <br />
          to Tape
        </h1>

        <p className="max-w-md text-base font-light italic text-white/85 sm:text-lg">
          To join the guestlist please download our members app
        </p>

        <div className="mt-2">
          <AppInstallButton />
        </div>
      </div>
    </main>
  );
}
