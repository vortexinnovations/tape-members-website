"use client";

import Image from "next/image";
import { useMemo } from "react";
import { buildStoreRedirectUrl, detectPlatform, type Platform } from "../lib/install";

/**
 * Single device-aware install button used on the landing page, the
 * getTheApp page, and the reel share fallback.
 *
 * Behaviour:
 *   - iOS  → one tall "Download on the App Store" badge
 *   - Android → one tall "Get it on Google Play" badge
 *   - Desktop / unknown → both badges side-by-side (nobody installs
 *     a nightclub app on their laptop, so the copy nudges them to
 *     grab a phone instead)
 *
 * The button target is always a Branch link so install attribution
 * works when paired with a reel share (see `buildStoreRedirectUrl`).
 *
 * Client component because device detection is inherently per-visit —
 * we could SSR it by reading the User-Agent header but that requires
 * an extra round-trip through middleware for a trivial win. The
 * button's layout is light enough that hydration flash is invisible.
 */
export default function AppInstallButton({
  reelId,
  referrer,
}: {
  reelId?: string;
  referrer?: string;
}) {
  // useMemo so navigator.userAgent is read once per mount instead of
  // on every render (React strict mode / re-render storms don't
  // trigger layout thrash).
  const platform: Platform = useMemo(() => {
    if (typeof navigator === "undefined") return "unknown";
    return detectPlatform(navigator.userAgent);
  }, []);

  const iosHref = buildStoreRedirectUrl("ios", { reelId, referrer });
  const androidHref = buildStoreRedirectUrl("android", { reelId, referrer });

  if (platform === "ios") {
    return <StoreBadge kind="ios" href={iosHref} />;
  }
  if (platform === "android") {
    return <StoreBadge kind="android" href={androidHref} />;
  }
  // Desktop / unknown → show both, let the user pick.
  return (
    <div className="flex flex-col items-center gap-4 sm:flex-row sm:gap-6">
      <StoreBadge kind="ios" href={iosHref} />
      <StoreBadge kind="android" href={androidHref} />
    </div>
  );
}

function StoreBadge({ kind, href }: { kind: "ios" | "android"; href: string }) {
  const src = kind === "ios" ? "/app-store-badge.png" : "/google-play-badge.png";
  const alt =
    kind === "ios" ? "Download on the App Store" : "Get it on Google Play";
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="transition-opacity hover:opacity-80 active:opacity-70"
    >
      <Image
        src={src}
        alt={alt}
        width={200}
        height={60}
        className="h-[60px] w-auto"
        priority
      />
    </a>
  );
}
