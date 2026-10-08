import { Button } from "@/components/ui/button";

interface OnlineRequiredProps {
  /**
   * Route back to the password form ("use password" / "go online"). This screen
   * never calls an auth primitive itself, so it cannot dead-end; the only way
   * forward is to reconnect and sign in online, which the password form drives.
   */
  onUsePassword: () => void;
}

/**
 * Fail-closed "online-required" screen.
 *
 * Shown when the app is offline and no Cached_Credential exists for the relevant
 * user (missing pointer, missing credential, or a credential that belongs only to
 * a different user). It deliberately renders NO PIN input and calls NO auth
 * primitive — it exists purely to explain that the user must connect to the
 * internet and sign in online to set up offline access, and to offer a route back
 * to the password form. See design: Error / Fail-closed Handling; Mode State
 * Machine (online-required). Requirements 2.2, 2.6.
 */
export function OnlineRequired({ onUsePassword }: OnlineRequiredProps) {
  return (
    <div className="space-y-3" aria-labelledby="online-required-heading">
      <h2 id="online-required-heading" className="text-sm font-semibold">
        Offline access not set up
      </h2>
      <p role="alert" className="text-sm text-muted-foreground">
        Connect to the internet and sign in online to set up offline access. Once
        you have signed in online at least once and set an offline PIN, you can
        unlock capture without a connection.
      </p>
      <Button
        type="button"
        className="w-full"
        onClick={onUsePassword}
        aria-label="Go online and sign in with your password"
      >
        Sign in online
      </Button>
    </div>
  );
}
