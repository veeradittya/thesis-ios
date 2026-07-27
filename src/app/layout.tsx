import type { Metadata, Viewport } from "next";
import { Inter, Geist_Mono, EB_Garamond } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/Providers";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" });
// Elegant serif for the Monaco-style logo wordmark.
const ebGaramond = EB_Garamond({ subsets: ["latin"], variable: "--font-serif" });

export const metadata: Metadata = {
  title: "Thesis",
  description: "The WHOOP for your portfolio — we watch the world and tell you when your thesis breaks.",
  // Behave as a standalone app when wrapped in a native iOS shell / added to the home screen.
  applicationName: "Thesis",
  appleWebApp: { capable: true, title: "Thesis", statusBarStyle: "black-translucent" },
};

// viewport-fit=cover exposes the notch/home-indicator insets as env(safe-area-inset-*),
// which the mobile nav + page padding rely on inside the native shell.
export const viewport: Viewport = {
  themeColor: "#000000",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`dark ${inter.variable} ${geistMono.variable} ${ebGaramond.variable} h-full`}>
      <body className="min-h-full antialiased font-sans">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
