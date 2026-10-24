import type { Translator } from "@/lib/i18n";

/**
 * Two collapsible help panels shown at the top of every page: how to enter
 * things, and what the page actually does with them.
 *
 * Built on native `<details>`/`<summary>`, which gives click-to-open and
 * click-again-to-close with no JavaScript at all. That matters here — every
 * page in this app is a server component, so a `"use client"` accordion would
 * ship a bundle to fifteen routes to reproduce behaviour the browser already
 * has. It is also keyboard-operable and announced correctly by screen readers
 * for free, which a div-and-onClick version is not.
 *
 * Both panels are closed by default: a merchant who already knows the screen
 * should not have to scroll past instructions every time.
 *
 * Content lives in the dictionaries under `help.<pageKey>.*`, so both
 * languages stay in key parity like every other string in the app.
 */
export function PageHelp({ t, pageKey }: { t: Translator; pageKey: string }) {
  const panels = [
    { key: "howTo", title: t("help.howToTitle"), body: t(`help.${pageKey}.howTo`) },
    { key: "howItWorks", title: t("help.howItWorksTitle"), body: t(`help.${pageKey}.howItWorks`) },
  ];

  return (
    <div className="flex flex-col gap-2 print:hidden sm:flex-row">
      {panels.map((panel) => (
        <details
          key={panel.key}
          className="group flex-1 rounded-xl border border-line bg-panel open:shadow-sm"
        >
          <summary
            className="flex cursor-pointer list-none items-center justify-between gap-2 rounded-xl px-4
              py-3 text-sm font-medium hover:bg-subtle"
          >
            <span>{panel.title}</span>
            {/* Rotates on open. `rtl:-scale-x-100` flips the chevron's
                direction so it points inward in Arabic as well. */}
            <svg
              aria-hidden="true"
              viewBox="0 0 20 20"
              className="size-4 shrink-0 transition-transform group-open:rotate-180"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M6 8l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </summary>
          <p className="border-t border-line px-4 py-3 text-sm leading-relaxed text-muted">
            {panel.body}
          </p>
        </details>
      ))}
    </div>
  );
}
