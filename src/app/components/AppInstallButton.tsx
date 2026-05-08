"use client";

import Image from "next/image";
import { useMemo } from "react";
import { QRCodeSVG } from "qrcode.react";
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
 *   - Desktop → primary affordance is a QR CODE encoding the
 *               Branch URL with `~channel=qr_desktop` so scans
 *               show up as a separate funnel in Branch analytics.
 *               Scanning on a phone triggers Universal Link /
 *               App Link routing on THAT device — the only
 *               surface where install attribution is meaningful.
 *               App Store / Play Store badges are still rendered
 *               below as direct links (no Branch hop) for users
 *               who can't scan or want to copy the link to a
 *               phone. (May 8, 2026 — desktop UX fix.)
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
  // Desktop / unknown → QR code for phone-scan + direct store
  // badges as fallback.
  return <DesktopInstallBlock reelId={reelId} referrer={referrer} />;
}

function DesktopInstallBlock({
  reelId,
  referrer,
}: {
  reelId?: string;
  referrer?: string;
}) {
  // QR encodes the SHORT redirect URL `tapemembers.com/i` (~25
  // chars) instead of the full Branch long URL (~330 chars)
  // because long-URL QR codes get visually dense — small modules
  // + the centre logo cutout make scanning unreliable on phone
  // cameras. The /i endpoint 302s to the same Branch URL the
  // mobile badges use, preserving the install-attribution chain.
  // (May 8, 2026 — fix for "the QR code has so much detail" UX
  // report.)
  //
  // Attribution rides along on `?ref` / `?u`:
  //   - ref → reelId (when on a reel-share fallback page)
  //   - u   → referrer (when a sharer is attached)
  // Without those params the QR is just `https://tapemembers.com/i`
  // — minimum-density QR (~12 modules per side at error level M).
  const qrHref = useMemo(() => {
    // Construct relative to the deployed origin so dev/preview
    // builds work without hardcoding the production domain.
    const origin =
        typeof window !== "undefined" ? window.location.origin :
            "https://tapemembers.com";
    const params = new URLSearchParams();
    if (reelId) params.set("ref", reelId);
    if (referrer) params.set("u", referrer);
    const qs = params.toString();
    return qs ? `${origin}/i?${qs}` : `${origin}/i`;
  }, [reelId, referrer]);
  return (
    <div className="flex flex-col items-center gap-5">
      {/* QR code — primary desktop affordance. */}
      <div className="rounded-2xl bg-white p-4 shadow-lg">
        <QRCodeSVG
          value={qrHref}
          size={180}
          // Embed the Tape mark in the centre so the code looks
          // intentional, not bot-like. ECC level M (~15% damage
          // tolerance) — the short URL is small enough that we
          // don't need level H's heavier redundancy, which lets
          // the modules grow larger and keeps the scan reliable.
          imageSettings={{
            src: "/icon.png",
            height: 36,
            width: 36,
            excavate: true,
          }}
          level="M"
        />
      </div>
      <p className="text-sm font-light text-white/80 sm:text-base">
        Scan with your phone&apos;s camera to install
      </p>
      {/* Direct store badges as a secondary affordance — for users
          who can't scan (no second device handy) or want to copy
          the store URL to a phone manually. Smaller + dimmer than
          the QR so the primary path stays visually dominant. */}
      <div className="mt-2 flex flex-col items-center gap-3 opacity-80 sm:flex-row sm:gap-4">
        <StoreBadge kind="ios" href={desktopStoreUrl("ios")} small />
        <StoreBadge
          kind="android"
          href={desktopStoreUrl("android")}
          small
        />
      </div>
    </div>
  );
}

function StoreBadge({
  kind,
  href,
  small = false,
}: {
  kind: "ios" | "android";
  href: string;
  /// Smaller variant for the desktop fallback row — primary
  /// affordance there is the QR code, badges are secondary.
  small?: boolean;
}) {
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
        width={small ? 140 : 200}
        height={small ? 42 : 60}
        className={small ? "h-[42px] w-auto" : "h-[60px] w-auto"}
        priority
      />
    </a>
  );
}
