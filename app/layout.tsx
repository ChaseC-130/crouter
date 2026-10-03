import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "crouter — Your projects, one conversation",
  description:
    "A local-first command center for your agent CLIs. Small state, fresh orchestration, resumable workers.",
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
