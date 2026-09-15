// ─────────────────────────────────────────────────────────────────────────────
// CLIENT-SIDE IMAGE COMPRESSION (canvas, no dependencies) — ported from f6145ff1.
// Resizes to a max width and re-encodes as JPEG so 5-8MB phone photos become
// 200-400KB before storage in the cashbook-proofs bucket. Browser-only (uses
// document/Image/canvas); not unit-tested in Node.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compress an image file. Returns the original unchanged if it is not an image or
 * is already small (< 500KB). Otherwise resizes to `maxWidth` and encodes JPEG at
 * `quality`.
 */
export async function compressImage(
  file: File,
  maxWidth = 1920,
  quality = 0.8
): Promise<File> {
  if (!file.type.startsWith("image/") || file.size < 500_000) return file;

  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      let { width, height } = img;
      if (width > maxWidth) {
        height = (height * maxWidth) / width;
        width = maxWidth;
      }
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      ctx?.drawImage(img, 0, 0, width, height);
      canvas.toBlob(
        (blob) =>
          resolve(
            blob
              ? new File([blob], file.name.replace(/\.\w+$/, ".jpg"), { type: "image/jpeg" })
              : file
          ),
        "image/jpeg",
        quality
      );
    };
    img.onerror = () => resolve(file); // fallback: original
    img.src = URL.createObjectURL(file);
  });
}
