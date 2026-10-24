import type { CSSProperties } from "react";

/**
 * The Tijarah Smart mark, rebuilt as SVG from the logo the owner supplied on
 * 2026-08-05 (navy T over a rounded gradient ring, with a small bar chart in
 * the counter). An SVG rather than the PNG because it stays crisp at every
 * size, weighs nothing, and the navy can follow the surrounding text colour
 * in dark mode.
 *
 * Self-contained on purpose: the gradient is inline, not a `.tj-*` class, so
 * the lockup renders identically on the landing page, the login page, or
 * anywhere else — the landing's scoped tokens are not required.
 *
 * If the original file is ever wanted instead, drop it at `public/logo.png`
 * and swap it in — the wordmark below keeps the same composition either way.
 */

const GRADIENT = "linear-gradient(120deg, #2E9BD4, #00A99D 55%, #2FBF63)";

/** Gradient-filled text that needs no stylesheet. */
const GRAD_TEXT: CSSProperties = {
  background: GRADIENT,
  WebkitBackgroundClip: "text",
  backgroundClip: "text",
  color: "transparent",
};

export function TijarahMark({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 100 100"
      className={className}
      aria-hidden
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id="tj-mark-grad" x1="20" y1="8" x2="80" y2="96" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#2E9BD4" />
          <stop offset="0.55" stopColor="#00A99D" />
          <stop offset="1" stopColor="#2FBF63" />
        </linearGradient>
      </defs>

      {/* The gradient ring, open where the T's flag crosses it. */}
      <path
        d="M 30 14 C 16 20 8 32 8 50 C 8 76 26 92 50 92 C 74 92 92 76 92 50 C 92 38 88 29 81 22"
        stroke="url(#tj-mark-grad)"
        strokeWidth="13"
        strokeLinecap="round"
      />

      {/* The T: flat flag with a clipped left end, stem dropping through the
          ring with a rounded foot. Follows currentColor so the mark adapts
          to whatever it sits on. */}
      <path
        d="M 22 12 H 78 C 80 12 81 13 81 15 V 26 C 81 28 80 29 78 29 H 56 V 62 C 56 68 51 72 46 72 C 41 72 36 68 36 62 V 29 H 27 C 24 29 22 26 23 23 Z"
        fill="currentColor"
      />

      {/* The bar chart in the counter. */}
      <rect x="60" y="56" width="7" height="12" rx="1.5" fill="currentColor" />
      <rect x="70" y="48" width="7" height="20" rx="1.5" fill="currentColor" />
    </svg>
  );
}

/** Mark + wordmark, matching the supplied lockup: navy "Tijarah", gradient "Smart". */
export function TijarahLogo({
  markClass = "h-9 w-9",
  textClass = "text-xl",
}: {
  markClass?: string;
  textClass?: string;
}) {
  return (
    <span className="inline-flex items-center gap-2.5" dir="ltr">
      <TijarahMark className={markClass} />
      <span className={`${textClass} font-bold tracking-tight`}>
        Tijarah <span style={GRAD_TEXT}>Smart</span>
      </span>
    </span>
  );
}
