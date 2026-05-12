// Tape Runner route layout.
//
// Locks the viewport so iOS Safari doesn't pinch-zoom the game,
// disables the Apple "Smart App Banner" (the root layout's banner
// would cover the game's top edge), and hints search engines not
// to index this URL (it's an Easter-egg game endpoint, not
// content people are meant to find).
//
// `'use client'` cannot export metadata — page.tsx is the client
// component, so the metadata lives here in the server layout.

import type { Metadata, Viewport } from 'next';

export const metadata: Metadata = {
  title: 'Tape Runner',
  description: 'Nightclub runner — an Easter egg in the Tape Members app.',
  robots: { index: false, follow: false },
  // Override the root layout's Smart App Banner — the strip would
  // occlude the top of the game canvas on iOS Safari.
  other: { 'apple-itunes-app': '' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  // Pure black so the address bar / status bar blends with the
  // game's dark background when scroll hides them.
  themeColor: '#070707',
};

export default function RunnerLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
