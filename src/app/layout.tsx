// Root layout for the Equilibrium app
import type { Metadata } from "next";
import "./globals.css";
import BlockReloadShortcuts from "@/components/BlockReloadShortcuts";

export const metadata: Metadata = {
  title: "Equilibrium",
  description: "Premium Project Manager",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body>
        <BlockReloadShortcuts />
        {children}
      </body>
    </html>
  );
}
