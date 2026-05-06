import type { Metadata } from "next";
import Image from "next/image";

import AppInstallButton from "../../components/AppInstallButton";
import { fetchPublicBar } from "../../lib/bar";

type Params = { barId: string };

/**
 * Drink bar QR-landing page. The URL printed on every bar QR
 * (`https://tapemembers.com/db/<barId>`) lands here when a member
 * scans the QR WITHOUT the Tape Members app installed — Universal
 * Links / App Links bypass this page entirely when the app is
 * present (handed straight to /db/:barId inside the Flutter app
 * which writes a `drinkBarSessionClaims/{}` doc).
 *
 * Visual:
 *   - Bar photo as a heavily-blurred fixed background
 *   - Foreground card: bar name + "Order drinks at this bar"
 *     pitch + device-aware install CTA
 *
 * If the bar is missing / hidden the page renders a "no longer
 * available" state — same install CTA so a curious scanner who
 * hits a stale QR still has a path to the app.
 */
export default async function BarLandingPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { barId } = await params;
  const bar = await fetchPublicBar(barId);

  // Bar not found / hidden — render a graceful fallback. Don't
  // 404 the route, the user just scanned a Tape QR and is a strong
  // install candidate.
  if (!bar) {
    return (
      <main className="relative min-h-screen overflow-hidden bg-black text-white">
        <div className="fixed inset-0 bg-gradient-to-b from-zinc-900 to-black" />
        <div className="relative z-10 flex min-h-screen flex-col items-center justify-center px-6 py-20">
          <div className="w-full max-w-md rounded-3xl border border-white/10 bg-black/55 p-8 text-center backdrop-blur-md shadow-[0_20px_60px_rgba(0,0,0,0.55)]">
            <Image
              src={TAPE_LOGO_URL}
              alt="Tape London"
              width={64}
              height={64}
              className="mx-auto mb-5 h-16 w-16 rounded-full object-cover ring-1 ring-white/20"
              unoptimized
            />
            <h1 className="font-tape mb-3 text-lg tracking-[0.15em] uppercase text-white">
              Bar Unavailable
            </h1>
            <p className="mb-6 text-sm font-light text-white/70">
              This bar QR is no longer active. Get the Tape Members
              app to browse open bars and order drinks.
            </p>
            <div className="flex justify-center">
              <AppInstallButton />
            </div>
          </div>
        </div>
      </main>
    );
  }

  // Use the bar's photo as a blurred background when available;
  // otherwise fall back to a solid dark gradient. Either way the
  // copy reads against the dark wash on top.
  const hasPhoto = !!bar.photoUrl;
  const displayName = bar.name || "Tape London";

  return (
    <main className="relative min-h-screen overflow-hidden bg-black text-white">
      {/* Bar photo as blurred backdrop */}
      {hasPhoto ? (
        <div className="fixed inset-0">
          <Image
            src={bar.photoUrl}
            alt=""
            fill
            className="object-cover"
            style={{ filter: "blur(28px) saturate(1.1)", transform: "scale(1.15)" }}
            priority
            unoptimized
          />
        </div>
      ) : (
        <div className="fixed inset-0 bg-gradient-to-b from-zinc-900 to-black" />
      )}

      {/* Dark wash so copy reads over any backdrop */}
      <div className="fixed inset-0 bg-black/55" />

      {/* Foreground card */}
      <div className="relative z-10 flex min-h-screen flex-col items-center justify-center px-6 py-20">
        <div className="w-full max-w-md rounded-3xl border border-white/10 bg-black/55 p-8 text-center backdrop-blur-md shadow-[0_20px_60px_rgba(0,0,0,0.55)]">
          {/* Brand identity */}
          <Image
            src={TAPE_LOGO_URL}
            alt="Tape London"
            width={56}
            height={56}
            className="mx-auto mb-5 h-14 w-14 rounded-full object-cover ring-1 ring-white/20"
            unoptimized
          />

          {/* Bar name — the hook */}
          <h1 className="font-tape mb-2 text-xl tracking-[0.15em] uppercase text-white">
            {displayName}
          </h1>
          <p className="mb-6 text-xs font-light tracking-[0.2em] uppercase text-white/55">
            Order at the bar
          </p>

          {/* Bar description if present */}
          {bar.description ? (
            <p className="mb-6 line-clamp-3 text-sm leading-relaxed text-white/80">
              {bar.description}
            </p>
          ) : null}

          {/* Closed-state hint — surface visually but don't block
              install (a member might want the app for next time). */}
          {!bar.acceptingOrders ? (
            <div className="mb-6 rounded-xl border border-amber-300/30 bg-amber-300/10 px-4 py-3 text-xs font-light text-amber-100">
              This bar is currently paused for orders. The full
              menu is still browsable inside the app.
            </div>
          ) : null}

          {/* Pitch + install CTA */}
          <div className="flex flex-col items-center gap-4">
            <p className="text-center text-sm font-light text-white/70">
              Open the Tape Members app
              <br />
              to order drinks at this bar.
            </p>
            <AppInstallButton />
          </div>
        </div>
      </div>
    </main>
  );
}

// Tape London logo served from Firebase Storage — same asset used
// elsewhere on the site (reel page, etc).
const TAPE_LOGO_URL =
  "https://firebasestorage.googleapis.com/v0/b/tape-members.appspot.com/o/appui%2Ftape%20london%20logo.png?alt=media&token=0dcad8c4-610f-4fb3-9675-131fef579cac";

/**
 * Server-rendered OG tags so the URL renders a rich preview when
 * shared in chat apps (rare for a bar QR but free polish).
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { barId } = await params;
  const bar = await fetchPublicBar(barId);

  if (!bar) {
    return {
      title: "Tape Members",
      description: "This bar is no longer available. Get the app to browse open bars.",
      openGraph: {
        title: "Tape Members",
        description: "This bar is no longer available. Get the app to browse open bars.",
        siteName: "Tape Members",
        type: "website",
      },
    };
  }

  const title = bar.name
    ? `${bar.name} · Tape Members`
    : "Order at the bar · Tape Members";
  const description = bar.description ||
    "Open the Tape Members app to order drinks at this bar.";

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      siteName: "Tape Members",
      type: "website",
      url: `https://tapemembers.com/db/${barId}`,
      images: bar.photoUrl
        ? [{ url: bar.photoUrl, width: 1200, height: 630 }]
        : undefined,
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: bar.photoUrl ? [bar.photoUrl] : undefined,
    },
  };
}

// Force dynamic rendering — bar metadata is fetched live, no
// static prerender at build time.
export const dynamic = "force-dynamic";
