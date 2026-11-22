import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";

import { AppHeader } from "@/components/app-header";
import { Providers } from "@/components/providers";
import { ServiceWorker } from "@/components/service-worker";

import "./globals.css";

// "latin" covers the accented characters of en-US, pt-BR and es-ES.
const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "PromoLedger",
  description: "Offline-first order capture and reconciliation for fundraising campaigns.",
  appleWebApp: { capable: true, title: "PromoLedger", statusBarStyle: "default" },
};

export const viewport: Viewport = { themeColor: "#4f46e5" };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // `lang` is updated client-side to the resolved locale (see Providers).
    <html lang="en-US" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">
        <ServiceWorker>
          <Providers>
            <AppHeader />
            <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6">{children}</main>
          </Providers>
        </ServiceWorker>
      </body>
    </html>
  );
}
