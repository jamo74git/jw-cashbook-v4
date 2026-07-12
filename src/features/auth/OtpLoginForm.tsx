"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Step = "email" | "otp";

export function OtpLoginForm() {
  const router = useRouter();
  const supabase = createClient();

  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSendOtp(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
    });

    setLoading(false);

    if (error) {
      setError(error.message);
      return;
    }

    setStep("otp");
  }

  async function handleVerifyOtp(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const { error } = await supabase.auth.verifyOtp({
      email: email.trim(),
      token: otp.trim(),
      type: "email",
    });

    setLoading(false);

    if (error) {
      setError(error.message);
      return;
    }

    router.push("/treasurer");
    router.refresh();
  }

  if (step === "email") {
    return (
      <form onSubmit={handleSendOtp} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="email">Email address</Label>
          <Input
            id="email"
            type="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
            aria-describedby={error ? "email-error" : undefined}
          />
          <p className="text-xs text-muted-foreground">
            Enter the email address registered to your profile.
          </p>
        </div>

        {error && (
          <p id="email-error" role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        <Button type="submit" className="w-full" disabled={loading || email.trim().length < 5}>
          {loading ? "Sending..." : "Send one-time PIN"}
        </Button>
      </form>
    );
  }

  return (
    <form onSubmit={handleVerifyOtp} className="space-y-4">
      <p className="text-sm text-muted-foreground">
        A 6-digit code was sent to{" "}
        <span className="font-medium text-foreground">{email}</span>.
      </p>

      <div className="space-y-2">
        <Label htmlFor="otp">One-time PIN</Label>
        <Input
          id="otp"
          type="text"
          inputMode="numeric"
          pattern="[0-9]{6}"
          maxLength={6}
          placeholder="123456"
          value={otp}
          onChange={(e) => setOtp(e.target.value)}
          required
          autoComplete="one-time-code"
          aria-describedby={error ? "otp-error" : undefined}
        />
      </div>

      {error && (
        <p id="otp-error" role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <Button type="submit" className="w-full" disabled={loading || otp.length !== 6}>
        {loading ? "Verifying..." : "Verify PIN"}
      </Button>

      <Button
        type="button"
        variant="ghost"
        className="w-full"
        onClick={() => { setStep("email"); setOtp(""); setError(null); }}
      >
        Use a different email
      </Button>
    </form>
  );
}
