// Proof indicator: green clickable paperclip that opens the cashbook-proofs file in a
// new tab when an attachment exists; red paperclip when the required proof is missing.
const CLIP =
  "M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13";

export function ProofLink({ url }: { url?: string | null }) {
  if (url) {
    return (
      <a href={url} target="_blank" rel="noopener noreferrer" className="text-green-600 hover:text-green-700" title="View proof">
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={CLIP} />
        </svg>
      </a>
    );
  }
  return (
    <svg className="w-4 h-4 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-label="Proof missing">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={CLIP} />
    </svg>
  );
}
