/**
 * The Corollary mark: ∴ as a theorem (circle), a lemma (square) and the corollary that follows
 * (the small vermilion dot, the same color as AI edits).
 */
export function Mark({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <circle cx="15" cy="9" r="7" fill="currentColor" />
      <rect x="1" y="18" width="11" height="11" rx="2" fill="currentColor" />
      <circle cx="26" cy="26" r="4" fill="#ff5b3a" />
    </svg>
  );
}
