"use client";

import { AppHeader } from "@/components/AppHeader";

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col bg-muted/30">
      <AppHeader />
      {/* License expiry banner (demo) */}
      <div className="bg-amber-50 border-b border-amber-200 px-4 py-1.5 text-center">
        <p className="text-xs text-amber-800">
          <span className="font-medium">License:</span> Gauteng District — expires in 3 days.
          <a href="#" className="ml-2 underline text-amber-900 hover:text-amber-700">Contact support to renew</a>
        </p>
      </div>
      <main className="flex-1">{children}</main>
    </div>
  );
}
