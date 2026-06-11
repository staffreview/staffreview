import { RootProvider } from "fumadocs-ui/provider/next";
import "./global.css";
import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { appName, socialImage } from "@/lib/shared";

const inter = Inter({
  subsets: ["latin"],
});

const description =
  "A local, staff-engineer-grade code review for your working tree — before anyone else sees it. Let any AI coding agent leave a thorough, inline review on any diff.";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"),
  title: {
    default: `${appName} — local, AI-driven code review`,
    template: `%s · ${appName}`,
  },
  description,
  openGraph: {
    title: appName,
    description,
    images: [socialImage],
    siteName: appName,
  },
};

export default function Layout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={inter.className} suppressHydrationWarning>
      <body className="flex flex-col min-h-screen">
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}
