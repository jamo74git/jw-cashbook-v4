"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Step = "phone" | "otp";

export function OtpLoginForm() {
  const router = useRouter();
  const supabase = createClient();

  const [step, setStep] = useState<Step>("phone");
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSendOtp(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const { error } = await supabase.auth.signInWithOtp({
      phone: phone.trim(),
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
      phone: phone.trim(),
      token: otp.trim(),
      type: "sms",
    });

    setLoading(false);

    if (error) {
      setError(error.message);
      return;
    }

    router.push("/treasurer");
    router.refresh();
  }

  if (step === "phone") {
    return (
      <form onSubmit={handleSendOtp} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="phone">Phone number</Label>
          <Input
            id="phone"
            type="tel"
            placeholder="+27821234567"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            required
            autoComplete="tel"
            aria-describedby={error ? "phone-error" : undefined}
          />
          <p className="text-xs text-muted-foreground">
            International format, e.g. +27 82 123 4567
          </p>
        </div>

        {error && (
          <p id="phone-error" role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        <Button type="submit" className="w-full" disabled={loading || phone.trim().length < 8}>
          {loading ? "Sending..." : "Send one-time PIN"}
        </Button>
      </form>
    );
  }

  return (
    <form onSubmit={handleVerifyOtp} className="space-y-4">
      <p className="text-sm text-muted-foreground">
        A 6-digit PIN was sent to{" "}
        <span className="font-medium text-foreground">{phone}</span>.
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
        onClick={() => { setStep("phone"); setOtp(""); setError(null); }}
      >
        Use a different number
      </Button>
    </form>
  );
}
