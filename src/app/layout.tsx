import type { Metadata } from "next";
import { Inter } from "next/font/google";
import Image from "next/image";
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "OAC Management System",
  description: "Enterprise management system for OAC congregations",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={inter.className}>
        {/* App Header with NAC Logo */}
        <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
          <div className="mx-auto flex h-14 max-w-5xl items-center gap-3 px-4">
            <Image
              src="/nac-logo.png"
              alt="NAC Logo"
              width={36}
              height={36}
              className="rounded"
            />
            <span className="text-sm font-semibold tracking-tight text-primary">
              OAC Management System
            </span>
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
