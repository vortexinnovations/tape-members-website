import type { Metadata } from "next";
import Image from "next/image";
import { notFound } from "next/navigation";

import AppInstallButton from "../../components/AppInstallButton";
import ReelFallbackPage from "../../components/ReelFallbackPage";
import { fetchPublicReel } from "../../lib/reel";

type Params = { id: string };

/**
 * Reel share page. The URL shared in chat apps lands here if the
 * visitor doesn't have the Tape app installed (Universal Links
 * bypass this page entirely when the app is present).
 *
 * Visual:
 *   - The reel plays muted/looping full-screen in the background
 *     with a heavy CSS blur so the brand card on top is legible
 *   - Foreground: creator's profile pic + name + caption
 *   - Single device-aware install button (Branch-powered so reel-
 *     share attribution survives the install)
 *
 * If the reel is missing / hidden the page renders a "no longer
 * available" state with the same install CTA — no 404 dead-end.
 */
export default async function ReelSharePage({
  params,
  searchParams,
}: {
  params: Promise<Params>;
  searchParams: Promise<{ ref?: string }>;
}) {
  const { id } = await params;
  const { ref } = await searchParams;
  const reel = await fetchPublicReel(id);

  if (!reel) {
    // Render a graceful "unavailable" state instead of a 404. We
    // still want the install CTA to work — the user clicked a
    // Tape link after all, they're a strong candidate to install.
    return <ReelFallbackPage reelId={id} referrer={ref} />;
  }

  // Anonymous / unnamed submissions get a nicer frame than
  // "ANONYMOUS shared a reel". We swap in the Tape London logo as
  // the avatar and reword the identity line to "A moment from
  // Tape London" — reads as a curated club moment instead of an
  // impersonal anonymous upload. Keeps named reels exactly as they
  // are.
  const isAnonymous =
    !reel.creatorName || reel.creatorName.trim().toLowerCase() === "anonymous";
  const displayName = isAnonymous ? "A Moment from Tape London" : reel.creatorName;
  const avatarUrl = isAnonymous || !reel.creatorPhotoUrl ? TAPE_LOGO_URL : reel.creatorPhotoUrl;

  return (
    <main className="relative min-h-screen overflow-hidden bg-black text-white">
      {/* Blurred background video — mounts as the only full-screen
          element. The card on top reads against it. */}
      {reel.videoUrl ? (
        <video
          className="reel-background-video"
          src={reel.videoUrl}
          autoPlay
          muted
          loop
          playsInline
          poster={reel.firstFrame}
        />
      ) : reel.firstFrame ? (
        // Fallback: if videoUrl is missing we still render the first-
        // frame as a blurred backdrop.
        <div className="fixed inset-0">
          <Image
            src={reel.firstFrame}
            alt=""
            fill
            className="object-cover"
            style={{ filter: "blur(28px) saturate(1.1)", transform: "scale(1.15)" }}
            priority
          />
        </div>
      ) : null}

      {/* Dark wash so copy reads over any video content */}
      <div className="fixed inset-0 bg-black/45" />

      {/* Foreground card */}
      <div className="relative z-10 flex min-h-screen flex-col items-center justify-center px-6 py-20">
        <div className="w-full max-w-md rounded-3xl border border-white/10 bg-black/55 p-8 backdrop-blur-md shadow-[0_20px_60px_rgba(0,0,0,0.55)]">
          {/* Creator identity */}
          <div className="mb-5 flex items-center gap-3">
            <Image
              src={avatarUrl}
              alt={displayName}
              width={48}
              height={48}
              className="h-12 w-12 rounded-full object-cover ring-1 ring-white/20"
              unoptimized={isAnonymous}
            />
            <div className="flex flex-col">
              <span className="font-tape text-sm tracking-[0.15em] uppercase text-white">
                {displayName}
              </span>
              {!isAnonymous && (
                <span className="text-xs font-light text-white/60">
                  shared a reel
                </span>
              )}
            </div>
          </div>

          {/* Caption — the hook. Limit to four lines so a very long
              caption doesn't blow the card height. */}
          {reel.caption ? (
            <p className="mb-6 line-clamp-4 text-base leading-relaxed text-white/90">
              {reel.caption}
            </p>
          ) : null}

          {/* Pitch + install CTA */}
          <div className="flex flex-col items-center gap-4">
            <p className="text-center text-sm font-light text-white/70">
              Get Tape Members to watch the full reel
              <br />
              and hundreds more.
            </p>
            <AppInstallButton reelId={id} referrer={ref} />
          </div>
        </div>
      </div>
    </main>
  );
}

// Tape London logo served from Firebase Storage — same asset the
// Flutter app uses as its fallback creator avatar. Kept here as a
// top-level const so both the page body and the OG metadata can
// reference it without duplicating the URL.
const TAPE_LOGO_URL =
  "https://firebasestorage.googleapis.com/v0/b/tape-members.appspot.com/o/appui%2Ftape%20london%20logo.png?alt=media&token=0dcad8c4-610f-4fb3-9675-131fef579cac";

/**
 * Server-rendered OG tags — the reason this page is Next.js and
 * not Flutter web. Scrapers (iMessage / WhatsApp / Telegram /
 * Twitter / Slack / ...) fetch the URL server-side and read the
 * `<meta og:*>` tags out of the initial HTML response. If the reel
 * exists we fill them from its data so shared links render a rich
 * preview card with the thumbnail, caption, and inline video where
 * supported (Telegram + Twitter).
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { id } = await params;
  const reel = await fetchPublicReel(id);

  // If the reel is gone, still return a valid preview card — don't
  // return notFound() from metadata, it'll crash the whole route
  // unnecessarily (the page component handles the missing case
  // gracefully above).
  if (!reel) {
    return {
      title: "Tape Members",
      description: "This reel is no longer available. Get the app to watch more.",
      openGraph: {
        title: "Tape Members",
        description: "This reel is no longer available. Get the app to watch more.",
        siteName: "Tape Members",
        type: "website",
      },
    };
  }

  const title = reel.caption || "Watch on Tape Members";
  const isAnonymous =
    !reel.creatorName || reel.creatorName.trim().toLowerCase() === "anonymous";
  const description = isAnonymous
    ? "A moment from Tape London"
    : `by ${reel.creatorName} · Tape Members`;

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      siteName: "Tape Members",
      type: "video.other",
      url: `https://tapemembers.com/r/${id}`,
      images: reel.firstFrame
        ? [{ url: reel.firstFrame, width: 1080, height: 1920 }]
        : undefined,
      videos: reel.videoUrl
        ? [
            {
              url: reel.videoUrl,
              type: "video/mp4",
              width: 1080,
              height: 1920,
            },
          ]
        : undefined,
    },
    twitter: {
      card: "player",
      title,
      description,
      images: reel.firstFrame ? [reel.firstFrame] : undefined,
      ...(reel.videoUrl
        ? {
            players: [
              {
                playerUrl: `https://tapemembers.com/r/${id}`,
                streamUrl: reel.videoUrl,
                width: 1080,
                height: 1920,
              },
            ],
          }
        : {}),
    },
  };
}

// Tell Next.js we're using dynamic route handlers with searchParams
// so it doesn't try to statically prerender these at build time
// (there's a different reel per id, and the fetch is live).
export const dynamic = "force-dynamic";

// Keep a dummy reference to notFound so TS doesn't complain about
// the import being present for future use (e.g. if we want to
// route certain error states to a hard 404 later).
void notFound;
