import Image from "next/image";

const APP_LINK = "https://tapemembers.app.link/6APDL58VB9UO";

export default function Home() {
  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden">
      {/* Background image */}
      <Image
        src="/bg.jpg"
        alt="Tape London"
        fill
        className="object-cover"
        priority
        quality={85}
      />

      {/* Dark overlay for readability */}
      <div className="absolute inset-0 bg-black/40" />

      {/* Content */}
      <div className="relative z-10 flex flex-col items-center gap-6 px-6 text-center">
        <h1 className="text-4xl font-bold tracking-[0.15em] text-white uppercase sm:text-5xl md:text-7xl">
          All Roads Lead to Tape
        </h1>

        <p className="text-base font-light italic text-white/90 sm:text-lg md:text-xl">
          To join the guestlist please download our members app
        </p>

        <div className="mt-4 flex flex-col items-center gap-4 sm:flex-row sm:gap-8">
          <a
            href={APP_LINK}
            target="_blank"
            rel="noopener noreferrer"
            className="transition-opacity hover:opacity-80"
          >
            <Image
              src="/google-play-badge.png"
              alt="Get it on Google Play"
              width={180}
              height={53}
              className="h-[53px] w-auto"
            />
          </a>
          <a
            href={APP_LINK}
            target="_blank"
            rel="noopener noreferrer"
            className="transition-opacity hover:opacity-80"
          >
            <Image
              src="/app-store-badge.png"
              alt="Download on the App Store"
              width={180}
              height={53}
              className="h-[53px] w-auto"
            />
          </a>
        </div>
      </div>
    </main>
  );
}
