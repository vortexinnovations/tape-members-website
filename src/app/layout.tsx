import type { Metadata } from "next";
import { Poppins } from "next/font/google";
import localFont from "next/font/local";
import "./globals.css";

// Poppins for body copy — matches what the previous landing used.
const poppins = Poppins({
  variable: "--font-poppins",
  subsets: ["latin"],
  weight: ["300", "400", "600", "700"],
});

// Tape-branded display font ("Embossing Tape 1 / 2 / 3" BRK). Treated
// as a single family so CSS can just use var(--font-tape) as a
// display face on headlines. The three TTFs are different weights of
// the same label-maker aesthetic — we map them to weight 400/600/800
// so Tailwind's font-weight utilities reach them naturally.
const tape = localFont({
  variable: "--font-tape",
  display: "swap",
  src: [
    { path: "./fonts/embossing-tape-1.ttf", weight: "400", style: "normal" },
    { path: "./fonts/embossing-tape-2.ttf", weight: "600", style: "normal" },
    { path: "./fonts/embossing-tape-3.ttf", weight: "800", style: "normal" },
  ],
});

export const metadata: Metadata = {
  title: "TAPE MEMBERS",
  description: "To join the guestlist please download our members app",
  openGraph: {
    title: "TAPE MEMBERS",
    description: "To join the guestlist please download our members app",
    url: "https://www.tapemembers.com",
    siteName: "TAPE MEMBERS",
    type: "website",
  },
  // Apple Smart Banner — iOS Safari auto-renders a "Open in App"
  // banner at the top of the page when this is present + the user
  // has the app installed. Free deep-link fallback on top of
  // Universal Links.
  appleWebApp: {
    title: "Tape Members",
    statusBarStyle: "black-translucent",
  },
  other: {
    "apple-itunes-app": "app-id=1665221388",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${poppins.variable} ${tape.variable}`}
    >
      <body className="font-[family-name:var(--font-poppins)] bg-black text-white">
        {children}
      </body>
    </html>
  );
}
