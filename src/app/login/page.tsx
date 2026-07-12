import type { Metadata } from "next";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { OtpLoginForm } from "@/features/auth/OtpLoginForm";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Sign in - JW Cashbook",
};

export default function LoginPage({
  searchParams,
}: {
  searchParams: { error?: string };
}) {
  return (
    <main className="min-h-screen flex items-center justify-center bg-muted/40 px-4 py-12">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">JW Cashbook</h1>
          <p className="text-sm text-muted-foreground">
            Sign in with your registered email address
          </p>
        </div>

        {searchParams.error && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3">
            <p className="text-sm text-destructive">{searchParams.error}</p>
          </div>
        )}

        <Card>
          <CardHeader className="space-y-1">
            <CardTitle className="text-lg">Sign in</CardTitle>
            <CardDescription>
              We will send a one-time PIN to your email.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <OtpLoginForm />
          </CardContent>
        </Card>

        <p className="text-center text-xs text-muted-foreground">
          Access is restricted to registered congregation members.
        </p>
      </div>
    </main>
  );
}
