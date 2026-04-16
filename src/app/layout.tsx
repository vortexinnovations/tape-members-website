import type { Metadata } from "next";
import { Poppins } from "next/font/google";
import "./globals.css";

const poppins = Poppins({
  variable: "--font-poppins",
  subsets: ["latin"],
  weight: ["300", "400", "600", "700"],
});

export const metadata: Metadata = {
  title: "TAPE MEMBERS",
  description:
    "To join the guestlist please download our members app",
  openGraph: {
    title: "TAPE MEMBERS",
    description:
      "To join the guestlist please download our members app",
    url: "https://www.tapemembers.com",
    siteName: "TAPE MEMBERS",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${poppins.variable}`}>
      <body className="font-[family-name:var(--font-poppins)]">
        {children}
      </body>
    </html>
  );
}
