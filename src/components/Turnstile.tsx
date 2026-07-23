"use client";

import { useEffect, useRef } from "react";

interface TurnstileProps {
  onVerify: (token: string) => void;
  onError?: () => void;
}

declare global {
  interface Window {
    turnstile?: {
      render: (container: HTMLElement, options: Record<string, unknown>) => string;
      reset: (widgetId: string) => void;
      remove: (widgetId: string) => void;
    };
    onTurnstileLoad?: () => void;
  }
}

export function Turnstile({ onVerify, onError }: TurnstileProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);

  useEffect(() => {
    const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
    if (!siteKey) return; // Skip if not configured

    function renderWidget() {
      if (!containerRef.current || !window.turnstile) return;
      if (widgetIdRef.current) return; // Already rendered

      widgetIdRef.current = window.turnstile.render(containerRef.current, {
        sitekey: siteKey,
        callback: (token: string) => onVerify(token),
        "error-callback": () => onError?.(),
        theme: "auto",
        size: "flexible",
      });
    }

    // If turnstile is already loaded
    if (window.turnstile) {
      renderWidget();
      return;
    }

    // Load the script
    window.onTurnstileLoad = renderWidget;
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onTurnstileLoad";
    script.async = true;
    script.defer = true;
    document.head.appendChild(script);

    return () => {
      if (widgetIdRef.current && window.turnstile) {
        window.turnstile.remove(widgetIdRef.current);
        widgetIdRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Don't render anything if no site key configured
  if (!process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY) return null;

  return <div ref={containerRef} className="mt-2" />;
}
