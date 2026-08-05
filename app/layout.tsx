import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;
  const socialImage = new URL("/og.png", origin).toString();

  return {
    metadataBase: new URL(origin),
    title: {
      default: "BidAI Pro — GSA Vehicle Intelligence",
      template: "%s · BidAI Pro",
    },
    description:
      "Professional GSA vehicle auction intelligence with independent valuations, historical comps, closing-price forecasts, and risk-adjusted bid ceilings.",
    applicationName: "BidAI Pro",
    category: "automotive",
    openGraph: {
      type: "website",
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
}

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
