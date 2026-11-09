"use client";

import { useEffect, useRef, useState } from "react";

import { SecondaryButton } from "../auth/action/ui";

/**
 * Sumsub's ID check, embedded in the page (their WebSDK), so the guest
 * never leaves it. The script comes from Sumsub's own host, as their
 * docs give it; there is no npm package to keep in step.
 *
 * The RESULT is not read from here. Sumsub tells our backend
 * (sumsubverify), the backend writes the guest's user doc, and the page
 * is listening to that doc. This component only shows the check.
 *
 * If the script or the token is missing, the hosted Sumsub page (the one
 * the app uses) is offered in a new tab instead.
 */

type SnsBuilder = {
  withConf: (conf: Record<string, unknown>) => SnsBuilder;
  withOptions: (options: Record<string, unknown>) => SnsBuilder;
  on: (event: string, handler: (payload: unknown) => void) => SnsBuilder;
  build: () => { launch: (selector: string) => void; destroy?: () => void };
};

declare global {
  interface Window {
    snsWebSdk?: {
      init: (token: string, refresh: () => Promise<string>) => SnsBuilder;
    };
  }
}

const SCRIPT_ID = "sumsub-websdk-script";
const SCRIPT_SRC = "https://static.sumsub.com/idensic/static/sns-websdk-builder.js";
const CONTAINER_ID = "qv-sumsub";

function loadScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.snsWebSdk) return resolve();
    const existing = document.getElementById(SCRIPT_ID);
    if (existing) {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error("script")));
      return;
    }
    const s = document.createElement("script");
    s.id = SCRIPT_ID;
    s.src = SCRIPT_SRC;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      s.remove();
      reject(new Error("script"));
    };
    document.head.appendChild(s);
  });
}

export default function SumsubCheck({
  token,
  fallbackUrl,
  onNewToken,
  fallbackButton,
  fallbackBody,
}: {
  /** A WebSDK access token from the backend; empty = use the fallback. */
  token: string;
  /** The hosted Sumsub page for the same check. */
  fallbackUrl: string;
  /** Sumsub asks for this when the token runs out mid-check. */
  onNewToken: () => Promise<string>;
  fallbackButton: string;
  fallbackBody: string;
}) {
  const [failed, setFailed] = useState(false);
  // The newest callback without restarting the check when it changes.
  const refresh = useRef(onNewToken);
  useEffect(() => {
    refresh.current = onNewToken;
  }, [onNewToken]);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    let instance: { destroy?: () => void } | null = null;
    loadScript()
      .then(() => {
        if (cancelled || !window.snsWebSdk) return;
        const built = window.snsWebSdk
          .init(token, () => refresh.current())
          .withConf({ lang: "en", theme: "dark" })
          .withOptions({ addViewportTag: false, adaptIframeHeight: true })
          .on("idCheck.onError", (e) => {
            console.warn("[verify] Sumsub error:", e);
          })
          .build();
        built.launch(`#${CONTAINER_ID}`);
        instance = built;
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      try {
        instance?.destroy?.();
      } catch {
        /* nothing to tidy */
      }
    };
  }, [token]);

  if (!token || failed) {
    if (!fallbackUrl) return null;
    return (
      <div className="mt-5">
        <p className="text-center text-sm font-light text-white/70">
          {fallbackBody}
        </p>
        <SecondaryButton
          onClick={() => window.open(fallbackUrl, "_blank", "noopener")}
        >
          {fallbackButton}
        </SecondaryButton>
      </div>
    );
  }
  return (
    <div
      id={CONTAINER_ID}
      className="mt-5 min-h-[420px] overflow-hidden rounded-2xl bg-black/40"
    />
  );
}
