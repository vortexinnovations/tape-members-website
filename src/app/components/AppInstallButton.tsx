"use client";

import Image from "next/image";
import { useMemo } from "react";
import {
  buildStoreRedirectUrl,
  desktopStoreUrl,
  detectPlatform,
  type Platform,
} from "../lib/install";

/**
 * Single device-aware install button used on the landing page, the
 * getTheApp page, and the reel share fallback.
 *
 * Behaviour:
 *   - iOS     → one tall "Download on the App Store" badge whose
 *               href is the Branch URL — Universal Link tries to
 *               open the app first, falls back to the App Store
 *               with install attribution baked in.
 *   - Android → one tall "Get it on Google Play" badge whose href
 *               is the Branch URL — same fingerprint-based
 *               attribution flow.
 *   - Desktop → both badges side-by-side, but each links DIRECTLY
 *               to the App Store / Play Store web page. No Branch
 *               hop because there's no install-attribution win on
 *               desktop (the click won't lead to a same-device
 *               install) AND Branch's `$desktop_url` redirect
 *               just bounces back to /getTheApp creating a
 *               click-loop. Going direct opens the store
 *               immediately. (May 8, 2026 — fix for desktop
 *               "doesn't redirect" report.)
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

  if (platform === "ios") {
    return (
      <StoreBadge
        kind="ios"
        href={buildStoreRedirectUrl("ios", { reelId, referrer })}
      />
    );
  }
  if (platform === "android") {
    return (
      <StoreBadge
        kind="android"
        href={buildStoreRedirectUrl("android", { reelId, referrer })}
      />
    );
  }
  // Desktop / unknown → show both, link DIRECTLY to the stores.
  // Branch is bypassed here per the comment above the component.
  return (
    <div className="flex flex-col items-center gap-4 sm:flex-row sm:gap-6">
      <StoreBadge kind="ios" href={desktopStoreUrl("ios")} />
      <StoreBadge kind="android" href={desktopStoreUrl("android")} />
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
