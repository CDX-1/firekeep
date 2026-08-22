import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "firekeep",
  description: "Minecraft captures turned into photorealistic worlds",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
