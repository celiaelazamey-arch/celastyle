import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "CelaStyle — Command Center",
  description:
    "A multi-panel command-center workspace built on the CelaStyle design system.",
};

export const viewport: Viewport = {
  themeColor: "#0b0f13",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    // `data-theme` is the single switch between the dark and light token maps
    // in @celastyle/tokens. Dark is the default for a command center.
    <html lang="en" data-theme="dark">
      <body>{children}</body>
    </html>
  );
}
