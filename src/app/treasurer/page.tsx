import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Treasurer Dashboard - JW Cashbook",
};

export default async function TreasurerPage() {
  const supabase = createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  return (
    <main className="min-h-screen bg-muted/40 px-4 py-12">
      <div className="mx-auto max-w-4xl space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Treasurer Dashboard</CardTitle>
            <CardDescription>
              Welcome to JW Cashbook v4. Capture and manage your
              congregation weekly cashbook entries below.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              Select a congregation, month, week, and service period (AM/PM) to
              begin capturing tithes, banking, and expenses.
            </p>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
