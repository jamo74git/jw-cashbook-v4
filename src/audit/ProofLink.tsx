// Proof indicator (Tranche 4 r2 - private reading, popup-safe, stale-safe). The bucket is
// private: we mint a SHORT-LIVED signed url on demand and open it in a new tab. `url` is
// the stored cashbook_attachment.file_url reference, resolved + signed here, never persisted.
//
// R09 reader corrections:
//  - transient state resets when `url` changes (a stale link never persists across refs);
//  - a superseded async signing result is discarded (ref/role changed mid-flight);
//  - a blocked popup shows an explicit "Open proof" control that RE-MINTS on click, so the
//    link can never outlive its ~120s signature; the current tab is never navigated away;
//  - a popup closed while awaiting signing falls back to the inline control;
//  - a neutral "unavailable" message is used where denial and absence cannot be distinguished.
// A successfully issued signature is NOT an image-load or review acknowledgement, and no new
// business gate requiring every proof to be opened is introduced.
import { useEffect, useRef, useState } from "react";
import { resolveProofKey } from "@/lib/storage/proofReference";
import { getProofSignedUrl, decideProofOpen } from "@/lib/storage/storagePort";

const CLIP =
  "M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13";

type LoadState = "idle" | "loading" | "denied" | "unavailable" | "popupBlocked";

export function ProofLink({ url, canView = true }: { url?: string | null; canView?: boolean }) {
  const [state, setState] = useState<LoadState>("idle");
  // Monotonic request id: increments on every open() and whenever the reference changes,
  // so a late async result from a superseded request is ignored.
  const reqRef = useRef(0);

  useEffect(() => {
    reqRef.current++;
    setState("idle");
  }, [url]);

  if (!canView) return null;

  const hasReference = resolveProofKey(url).kind === "key";
  if (!hasReference) {
    return (
      <svg className="w-4 h-4 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-label="Proof missing">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={CLIP} />
      </svg>
    );
  }

  async function open() {
    const myReq = ++reqRef.current;
    setState("loading");
    const win = window.open("about:blank", "_blank");
    const res = await getProofSignedUrl(url);
    if (myReq !== reqRef.current) {
      // A newer open() or a reference change superseded this request; discard it.
      if (win && !win.closed) win.close();
      return;
    }
    const popupAvailable = !!win && !win.closed;
    const action = decideProofOpen(res, popupAvailable);
    if (action.kind === "navigate") {
      if (win && !win.closed) {
        win.opener = null;
        win.location.href = action.url;
      }
      setState("idle");
      return;
    }
    if (action.kind === "inline") {
      if (win && !win.closed) win.close();
      setState("popupBlocked"); // re-mint on the inline control; do not keep the url
      return;
    }
    if (win && !win.closed) win.close();
    setState(action.status === "denied" ? "denied" : "unavailable");
  }

  const failed = state === "denied" || state === "unavailable";
  const title =
    state === "denied"
      ? "Access denied - you are not permitted to view this proof"
      : state === "unavailable"
        ? "Proof unavailable - tap to retry"
        : state === "popupBlocked"
          ? "Your browser blocked the popup - use Open proof"
          : "View proof";
  const color = failed ? "text-amber-600 hover:text-amber-700" : "text-green-600 hover:text-green-700";

  return (
    <span className="inline-flex items-center gap-1">
      <button
        type="button"
        onClick={() => void open()}
        disabled={state === "loading"}
        className={`inline-flex ${color} disabled:opacity-50`}
        title={title}
        aria-label={title}
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={CLIP} />
        </svg>
        {(failed || state === "popupBlocked") && <span className="sr-only">{title}</span>}
      </button>
      {state === "popupBlocked" && (
        // Explicit user-click control. It RE-MINTS a fresh signed url (new user gesture,
        // so the popup is allowed and the link can never be stale/expired). Never navigates
        // the current cashbook tab away.
        <button
          type="button"
          onClick={() => void open()}
          className="text-[10px] underline text-blue-700"
          title="Open the proof in a new tab (re-issues a fresh link)"
        >
          Open proof
        </button>
      )}
    </span>
  );
}
