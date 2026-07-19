"use client";

import { AppHeader } from "@/components/AppHeader";

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col bg-muted/30">
      <AppHeader />
      <main className="flex-1">{children}</main>
    </div>
  );
}
