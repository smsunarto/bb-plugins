/**
 * The GitButler desktop app icon: a black bow tie on a mint rounded square.
 * Traced from the app's `icon.icns`. The colours are GitButler's brand, not
 * bb theme tokens, so they stay fixed in every theme like any app icon.
 */
export function GitButlerMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <rect width="24" height="24" rx="5.5" fill="#a9f0ec" />
      <path d="M5.3 4.85v14.3L12 12zM18.7 4.85v14.3L12 12z" fill="#000" />
    </svg>
  );
}
