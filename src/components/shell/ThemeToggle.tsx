"use client";

/**
 * Morning / night switch.
 *
 * Deliberately holds NO React state. The active theme lives in one place —
 * the `data-theme` attribute on <html> — and CSS decides which icon shows from
 * it. Mirroring that into component state would mean reading it in an effect,
 * which cannot run before the first paint, so the button would render the
 * wrong icon for a frame on every navigation.
 *
 * The stored choice is applied before first paint by `THEME_INIT_SCRIPT`.
 * With nothing stored, no attribute is set and both the CSS and this button
 * follow the operating system — writing an explicit value on load would
 * silently override a merchant whose machine is already set to dark.
 */
export function ThemeToggle({ label }: { label: string }) {
  function toggle() {
    const root = document.documentElement;
    const stored = root.dataset.theme;
    const isDark = stored
      ? stored === "dark"
      : window.matchMedia("(prefers-color-scheme: dark)").matches;

    const next = isDark ? "light" : "dark";
    root.dataset.theme = next;
    try {
      window.localStorage.setItem("theme", next);
    } catch {
      // Private browsing or a blocked store. The theme still applies for this
      // page load; only the memory of it is lost, which is not worth failing.
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={label}
      title={label}
      className="inline-flex size-9 items-center justify-center rounded-lg border border-line
        text-muted transition-colors hover:bg-subtle hover:text-ink print:hidden"
    >
      {/* Both are rendered; globals.css shows exactly one, based on the same
          data-theme attribute the colour tokens read. Each icon shows what the
          press will GIVE you, not what is currently active. */}
      <svg
        className="theme-icon-moon size-4"
        viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor"
        strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      >
        <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
      </svg>
      <svg
        className="theme-icon-sun size-4"
        viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor"
        strokeWidth="2" strokeLinecap="round"
      >
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" />
      </svg>
    </button>
  );
}

/**
 * Runs before the browser paints, so the stored theme is on <html> from the
 * first frame and there is no flash of the wrong one.
 *
 * Deliberately tiny and dependency-free: it is inlined into the document head,
 * so every byte sits on the critical path. It sets nothing when no choice is
 * stored, leaving the CSS media query to follow the operating system.
 */
export const THEME_INIT_SCRIPT = `try{var t=localStorage.getItem('theme');if(t==='light'||t==='dark'){document.documentElement.dataset.theme=t}}catch(e){}`;
