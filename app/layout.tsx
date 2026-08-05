import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const publicSiteUrl = "https://bidaipro.github.io/BidAIPro/";
const socialImage = "https://bidaipro.github.io/BidAIPro/og.png";

export const metadata: Metadata = {
  metadataBase: new URL(publicSiteUrl),
  title: {
    default: "BidAI Pro — GSA Vehicle Intelligence",
    template: "%s · BidAI Pro",
  },
  description:
    "Professional GSA vehicle auction intelligence with independent valuations, historical comps, closing-price forecasts, and risk-adjusted bid ceilings.",
  applicationName: "BidAI Pro",
  category: "automotive",
  alternates: { canonical: publicSiteUrl },
  openGraph: {
    type: "website",
    url: publicSiteUrl,
    siteName: "BidAI Pro",
    title: "BidAI Pro — GSA Vehicle Intelligence",
    description:
      "Find the strongest government vehicle opportunities before the clock runs out.",
    images: [{ url: socialImage, width: 1792, height: 896, alt: "BidAI Pro GSA Vehicle Intelligence" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "BidAI Pro — GSA Vehicle Intelligence",
    description:
      "Risk-adjusted GSA vehicle auction intelligence for smarter bids.",
    images: [socialImage],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
