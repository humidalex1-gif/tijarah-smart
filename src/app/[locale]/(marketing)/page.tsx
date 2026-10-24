import { Suspense, type ReactNode } from "react";
import Link from "next/link";
import Image from "next/image";
import { IBM_Plex_Sans_Arabic } from "next/font/google";
import { isLocale, DEFAULT_LOCALE, getTranslator, type Translator, type Locale } from "@/lib/i18n";
import { formatNumber } from "@/lib/format";
import { appHomePath } from "@/lib/nav";
import { auth } from "@/lib/auth";
import { LanguageSwitcher } from "@/components/shell/LanguageSwitcher";
import { ThemeToggle } from "@/components/shell/ThemeToggle";
import { Reveal, DrawRule, CountUp, ScrollProgress, Parallax, Tilt, SplitBar } from "./Motion";
import { TijarahLogo, TijarahMark } from "./Logo";
import "./landing.css";

/**
 * The public front door, carrying the Tijarah Smart identity the owner
 * supplied on 2026-08-05: deep navy, and the logo's blue → teal → green
 * gradient. All of it scoped in `landing.css` under `.tj-landing`, so the
 * app behind the login keeps its own system untouched.
 *
 * The integration logos are the real ones, fetched from their owners' own
 * servers (Salla's CDN, fast-hub.co) and self-hosted under
 * `public/integrations/`. No product photos by the owner's instruction, no
 * invented traction, no testimonial, no metric.
 *
 * The worked example stays — it is the product's argument — but now performs
 * inside a card: the figures count up, and the difference resolves into its
 * two causes with the gradient landing on the loss. Motion rules are the same
 * as before (Motion.tsx): server renders the finished state, nothing hides
 * without JavaScript, and `prefers-reduced-motion` stops everything.
 */

/**
 * The type scale below is measured from zoho.com/inventory, at the owner's
 * request (2026-08-05), not guessed: hero 44px on a 54px line, section heads
 * 26–38px, body 15–16px, small 12–14px — and **600 as the dominant weight**,
 * used there more than twice as often as 700. That last one does most of the
 * work: the page read heavy because its headings were bold at 54px, not
 * because of the typeface.
 *
 * So the face returns to IBM Plex Sans Arabic, the same one the app uses. Cairo
 * is wide and geometric, which at display size is what made the Arabic look
 * inflated; Plex is a humanist workhorse in the register Zoho's own Puvi sits
 * in, and one family across the marketing page and the product behind the
 * login is a better argument than two.
 */
const display = IBM_Plex_Sans_Arabic({
  subsets: ["arabic", "latin"],
  weight: ["400", "500", "600", "700"],
});

const FEATURE_KEYS = ["f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8"] as const;
const STEP_KEYS = ["s1", "s2", "s3"] as const;

const SHELL = "mx-auto w-full max-w-[80rem] px-6 sm:px-10";

/** Line icons for the feature cards, one per feature key. Stroke follows text. */
const FEATURE_ICONS: Record<(typeof FEATURE_KEYS)[number], ReactNode> = {
  // Reconciliation: two columns compared.
  f1: <><path d="M7 4v16M17 4v16" /><path d="m4 7 3-3 3 3M14 17l3 3 3-3" /></>,
  // Owed to you: a claim ledger.
  f2: <><path d="M6 3h12v18l-3-2-3 2-3-2-3 2Z" /><path d="M9 8h6M9 12h6" /></>,
  // Real profit: the waterfall down to the true figure.
  f3: <><path d="M4 20V4" /><path d="M8 8h4v4h4v4h4" /></>,
  // Sync: the loop.
  f4: <><path d="M20 12a8 8 0 1 1-2.34-5.66" /><path d="M20 3v4h-4" /></>,
  // Bundles: the box assembled at pick time.
  f5: <><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9Z" /><path d="M12 12 4 7.5M12 12l8-4.5M12 12v9" /></>,
  // Landed cost: the shipment arriving.
  f6: <><path d="M3 17h13l5-5-5-5H3Z" /><path d="M7 17v4M12 17v4" /></>,
  // Advertising: the spend that never touches unit cost.
  f7: <><path d="m4 11 12-6v14L4 13v6" /><path d="M16 9a3 3 0 0 1 0 6" /></>,
  // Full trail: every movement accounted for.
  f8: <><path d="M12 3 5 6v6c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6Z" /><path d="m9 12 2 2 4-4" /></>,
};

function FeatureIcon({ children }: { children: ReactNode }) {
  return (
    <span className="tj-icon inline-flex h-11 w-11 items-center justify-center rounded-xl">
      <svg
        viewBox="0 0 24 24"
        className="h-6 w-6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {children}
      </svg>
    </span>
  );
}

/** One line of the worked example, counting itself up inside the hero card. */
function LedgerRow({
  label, value, unit, locale, delay, strong = false,
}: {
  label: string; value: number; unit: string; locale: Locale; delay: number; strong?: boolean;
}) {
  return (
    <div className="tj-line flex items-baseline justify-between gap-6 border-b py-3">
      <dt className={`text-sm ${strong ? "tj-ink font-medium" : "tj-muted"}`}>{label}</dt>
      <dd className="flex shrink-0 items-baseline gap-1.5">
        <CountUp
          value={value}
          locale={locale}
          delay={delay}
          durationMs={700}
          className={`text-lg tabular-nums ${strong ? "tj-ink font-semibold" : "tj-muted font-medium"}`}
        />
        <span className="tj-muted text-[0.6875rem]">{unit}</span>
      </dd>
    </div>
  );
}

/** One term of the decomposition. The gradient is reserved for the loss. */
function Term({
  label, value, unit, locale, delay, accent = false,
}: {
  label: string; value: number; unit: string; locale: Locale; delay: number; accent?: boolean;
}) {
  return (
    <Reveal className="min-w-0" delay={delay}>
      <div
        className="flex items-baseline gap-2"
        style={{ fontSize: "clamp(2.25rem, 4.4vw, 3.25rem)", lineHeight: 1 }}
      >
        <CountUp
          value={value}
          locale={locale}
          delay={delay + 120}
          className={`font-semibold tabular-nums ${accent ? "tj-text-grad" : "tj-ink"}`}
        />
        <span className="tj-muted text-[0.6875rem] font-normal tracking-normal">{unit}</span>
      </div>
      <DrawRule className="mt-4 max-w-24" delay={delay + 260} />
      <p className="tj-muted pt-3 text-sm">{label}</p>
    </Reveal>
  );
}

function Operator({ glyph, delay }: { glyph: string; delay: number }) {
  return (
    <Reveal className="tj-muted hidden shrink-0 self-start opacity-50 sm:block" delay={delay}>
      <span aria-hidden style={{ fontSize: "clamp(1.25rem, 2.2vw, 1.75rem)", lineHeight: 1 }}>
        {glyph}
      </span>
    </Reveal>
  );
}

export default async function LandingPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale: rawLocale } = await params;
  const locale: Locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;
  const t: Translator = await getTranslator(locale);

  // Read, never required: this page is public. Knowing whether the owner is
  // already signed in changes one label.
  const session = await auth();
  const cta = session?.user ? t("landing.openApp") : t("landing.signIn");

  const n = (value: number) => formatNumber(value, locale);
  const unit = t("landing.exUnit");

  return (
    <div className={`tj-landing ${display.className} min-h-screen`}>
      {/* Reading progress. Writes a CSS variable rather than React state, so
          scrolling this long page never re-renders the tree under it. */}
      <ScrollProgress />

      <header className="tj-line sticky top-0 z-20 border-b backdrop-blur" style={{ background: "color-mix(in srgb, var(--tj-bg) 82%, transparent)" }}>
        <div className={`${SHELL} flex items-center justify-between gap-4 py-3.5`}>
          <TijarahLogo />
          <div className="flex items-center gap-2 sm:gap-3">
            {/* useSearchParams inside; the boundary keeps it from pulling the
                whole page into client rendering. */}
            <Suspense fallback={null}>
              <LanguageSwitcher locale={locale} />
            </Suspense>
            <ThemeToggle label={t("app.themeToggle")} />
            <Link
              href={appHomePath(locale)}
              className="tj-btn-grad rounded-xl px-5 py-2.5 text-sm font-semibold"
            >
              {cta}
            </Link>
          </div>
        </div>
      </header>

      <main>
        {/* Hero: statement left, the reconciliation performing itself right. */}
        <section className="relative overflow-hidden">
          {/* Brand auras, drifting slowly. Pointer-events off; pure ground. */}
          <Parallax speed={0.1} className="pointer-events-none absolute inset-0">
            <div
              className="tj-blob absolute -top-32 h-[28rem] w-[28rem] rounded-full opacity-30"
              style={{ insetInlineStart: "-8rem", background: "radial-gradient(circle, #2E9BD4 0%, transparent 65%)", filter: "blur(70px)" }}
            />
            <div
              className="tj-blob tj-blob-b absolute -bottom-40 h-[30rem] w-[30rem] rounded-full opacity-30"
              style={{ insetInlineEnd: "-10rem", background: "radial-gradient(circle, #2FBF63 0%, #00A99D 45%, transparent 70%)", filter: "blur(80px)" }}
            />
          </Parallax>

          <div className={`${SHELL} relative grid items-center gap-14 pb-20 pt-16 sm:pt-24 lg:grid-cols-[minmax(0,1fr)_minmax(0,30rem)]`}>
            <div>
              <p className="lift tj-chip-bg tj-line inline-flex items-center gap-2 rounded-full border px-4 py-1.5 text-[0.8125rem] font-medium">
                <TijarahMark className="tj-ink h-4 w-4" />
                {t("landing.heroKicker")}
              </p>
              {/* 44px is Zoho's own hero size, and semibold is their dominant
                  weight. The line is looser than their 1.23 because Arabic is
                  cursive and carries diacritics — 1.23 crushed the tashkeel in
                  "مُخمَّناً" against the line above it. */}
              {/* Ink, not the gradient. Measured: the brand's stops read
                  2.27–2.94:1 as text on this ground, under the 3:1 floor for
                  large type, while ink is 14.76:1. The gradient gets the rule
                  below instead, where it is decoration and carries no words. */}
              <h1
                className="lift tj-ink mt-6 max-w-[24ch] font-semibold"
                style={{ fontSize: "clamp(1.75rem, 3.4vw, 2.75rem)", lineHeight: 1.4, animationDelay: "90ms" }}
              >
                {t("landing.heroTitle")}
              </h1>
              <div
                aria-hidden
                className="tj-sweep lift mt-5 h-[3px] w-24 rounded-full"
                style={{ background: "var(--tj-grad)", animationDelay: "140ms" }}
              />
              <p
                className="lift tj-muted mt-5 max-w-xl text-base leading-[1.8]"
                style={{ animationDelay: "180ms" }}
              >
                {t("landing.heroBody")}
              </p>

              <div className="lift mt-9 flex flex-wrap items-center gap-3" style={{ animationDelay: "270ms" }}>
                <Link
                  href={appHomePath(locale)}
                  className="tj-btn-grad rounded-xl px-7 py-3.5 text-[0.9375rem] font-semibold"
                >
                  {cta}
                </Link>
                <a
                  href="#example"
                  className="tj-btn-ghost rounded-xl px-7 py-3.5 text-[0.9375rem] font-semibold"
                >
                  {t("landing.heroCtaSecondary")}
                </a>
              </div>
            </div>

            {/* The product, shown working: the worked example as a live card. */}
            <Reveal className="tj-float">
              <div id="example" className="tj-card scroll-mt-28 rounded-3xl p-7">
                <p className="tj-muted text-[0.8125rem] font-medium">{t("landing.exampleLabel")}</p>
                <dl className="mt-4">
                  <LedgerRow label={t("landing.exShelf")} value={40} unit={unit} locale={locale} delay={0} />
                  <LedgerRow label={t("landing.exClaims")} value={10} unit={unit} locale={locale} delay={80} />
                  <LedgerRow label={t("landing.exExpected")} value={50} unit={unit} locale={locale} delay={160} strong />
                  <LedgerRow label={t("landing.exAsserted")} value={37} unit={unit} locale={locale} delay={240} strong />
                </dl>

                <div className="mt-7 flex flex-wrap items-start gap-x-5 gap-y-8">
                  <Term label={t("landing.exGap")} value={13} unit={unit} locale={locale} delay={350} />
                  <Operator glyph="=" delay={700} />
                  <Term label={t("landing.exStillClaimed")} value={10} unit={unit} locale={locale} delay={800} />
                  <Operator glyph="+" delay={1150} />
                  <Term label={t("landing.exUnexplained")} value={3} unit={unit} locale={locale} delay={1250} accent />
                </div>

                {/* The page's whole argument, drawn. The 13-unit gap is not
                    13 units of loss: the bar arrives whole and parts along the
                    boundary between what is still owed and what is gone. */}
                <SplitBar
                  className="mt-7"
                  parts={[
                    { value: 10, label: t("landing.exStillClaimed"), tone: "claim" },
                    { value: 3, label: t("landing.exUnexplained"), tone: "loss" },
                  ]}
                />
                <div className="tj-muted mt-3 flex items-center justify-between text-[0.75rem]">
                  <span>{t("landing.exStillClaimed")}</span>
                  <span>{t("landing.exUnexplained")}</span>
                </div>

                <p className="tj-line tj-muted mt-7 border-t pt-5 text-sm leading-[1.75]">
                  {t("landing.exFootnote")}
                </p>
              </div>
            </Reveal>
          </div>
        </section>

        {/* Where the numbers come from: the real integrations, real logos. */}
        <section className="tj-line border-y" style={{ background: "var(--tj-panel)" }}>
          <div className={`${SHELL} py-16 sm:py-20`}>
            <Reveal>
              <h2 className="text-[1.375rem] font-semibold sm:text-[1.625rem]">{t("landing.sourcesTitle")}</h2>
              <DrawRule className="mt-4 max-w-16" />
            </Reveal>

            <div className="mt-10 grid gap-6 sm:grid-cols-3">
              <Reveal className="tj-card rounded-2xl p-6" delay={0}>
                <span className="tj-logo-chip inline-flex h-14 items-center justify-center rounded-xl px-5">
                  {/* unoptimized: an 11 KB brand PNG gains nothing from the
                      optimizer, and skipping it removes a sharp dependency
                      from the production server. */}
                  <Image src="/integrations/salla.png" alt={t("landing.sourceStore")} width={95} height={40} className="h-9 w-auto" unoptimized />
                </span>
                <h3 className="mt-5 text-base font-semibold">{t("landing.sourceStore")}</h3>
                <p className="tj-muted mt-2 text-[0.9375rem] leading-[1.8]">{t("landing.sourceStoreBody")}</p>
              </Reveal>

              <Reveal className="tj-card rounded-2xl p-6" delay={90}>
                <span className="tj-logo-chip inline-flex h-14 items-center justify-center rounded-xl px-5">
                  <Image src="/integrations/fasthub.png" alt={t("landing.sourceWarehouse")} width={70} height={40} className="h-10 w-auto" unoptimized />
                </span>
                <h3 className="mt-5 text-base font-semibold">{t("landing.sourceWarehouse")}</h3>
                <p className="tj-muted mt-2 text-[0.9375rem] leading-[1.8]">{t("landing.sourceWarehouseBody")}</p>
              </Reveal>

              <Reveal className="tj-card rounded-2xl p-6" delay={180}>
                {/* Fixed navy, not the ink token: this chip stays white in
                    dark mode, where light ink would vanish on it. */}
                <span className="tj-logo-chip inline-flex h-14 w-14 items-center justify-center rounded-xl">
                  <TijarahMark className="h-8 w-8 text-[#182B4D]" />
                </span>
                <h3 className="mt-5 text-base font-semibold">{t("landing.sourceBooks")}</h3>
                <p className="tj-muted mt-2 text-[0.9375rem] leading-[1.8]">{t("landing.sourceBooksBody")}</p>
              </Reveal>
            </div>
          </div>
        </section>

        {/* Features, as cards with drawn icons. */}
        <section className={`${SHELL} py-20 sm:py-24`}>
          <Reveal>
            <h2 className="text-[1.375rem] font-semibold sm:text-[1.625rem]">{t("landing.featuresTitle")}</h2>
            <DrawRule className="mt-4 max-w-16" />
          </Reveal>

          <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {FEATURE_KEYS.map((key, index) => (
              <Reveal key={key} delay={(index % 4) * 80}>
                {/* Tilt is inside the reveal, never around it: one transform
                    per element, or the arrival slide and the lean overwrite
                    each other and the card jumps. */}
                <Tilt className="h-full">
                  <article className="tj-card h-full rounded-2xl p-6">
                    <FeatureIcon>{FEATURE_ICONS[key]}</FeatureIcon>
                    <h3 className="mt-5 text-base font-semibold">{t(`landing.${key}Title`)}</h3>
                    <p className="tj-muted mt-2 text-[0.9375rem] leading-[1.8]">{t(`landing.${key}Body`)}</p>
                  </article>
                </Tilt>
              </Reveal>
            ))}
          </div>
        </section>

        {/* How it works: three gradient numerals. */}
        <section className="tj-line border-y" style={{ background: "var(--tj-panel)" }}>
          <div className={`${SHELL} py-20 sm:py-24`}>
            <Reveal>
              <h2 className="text-[1.375rem] font-semibold sm:text-[1.625rem]">{t("landing.howTitle")}</h2>
              <DrawRule className="mt-4 max-w-16" />
            </Reveal>

            <div className="mt-12 grid gap-x-14 gap-y-12 sm:grid-cols-3">
              {STEP_KEYS.map((key, index) => (
                <Reveal key={key} as="article" delay={index * 110}>
                  <div
                    className="tj-text-grad font-semibold tabular-nums"
                    style={{ fontSize: "clamp(2rem, 3.4vw, 2.75rem)", lineHeight: 1 }}
                  >
                    {n(index + 1)}
                  </div>
                  {/* Draws downward as the step arrives, so three separate
                      cards read as one sequence. Decorative: the numeral above
                      already carries the order for a screen reader. */}
                  <div aria-hidden className="mt-4 h-10 w-px overflow-hidden">
                    <div className="tj-spine is-in h-full w-px" style={{ background: "var(--tj-grad)", transitionDelay: `${index * 160}ms` }} />
                  </div>
                  <h3 className="mt-1 text-[1.0625rem] font-semibold">{t(`landing.${key}Title`)}</h3>
                  <p className="tj-muted mt-2 text-[0.9375rem] leading-[1.8]">{t(`landing.${key}Body`)}</p>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        {/* Closing: the one full-gradient surface on the page. */}
        <section className={`${SHELL} py-20 sm:py-24`}>
          <Reveal>
            <div
              className="tj-shimmer relative overflow-hidden flex flex-col items-start gap-8 rounded-3xl p-10 text-white sm:flex-row sm:items-center sm:justify-between sm:p-14"
              style={{ background: "linear-gradient(120deg, #182B4D, #16617E 45%, #00A99D 80%, #2FBF63)" }}
            >
              <div>
                <h2 className="font-semibold" style={{ fontSize: "clamp(1.375rem, 2.4vw, 1.875rem)", lineHeight: 1.45 }}>
                  {t("landing.closingTitle")}
                </h2>
                <p className="mt-3 max-w-xl text-[0.9375rem] leading-[1.8] text-white/75">{t("landing.closingBody")}</p>
              </div>
              <Link
                href={appHomePath(locale)}
                className="inline-flex shrink-0 rounded-xl bg-white px-8 py-4 text-[0.9375rem] font-semibold text-[#16233F] transition-transform hover:-translate-y-0.5"
              >
                {cta}
              </Link>
            </div>
          </Reveal>
        </section>
      </main>

      <footer className="tj-line border-t">
        <div className={`${SHELL} flex flex-col items-start justify-between gap-4 py-10 sm:flex-row sm:items-center`}>
          <TijarahLogo markClass="h-7 w-7" />
          <p className="tj-muted text-xs">{t("landing.footerNote")}</p>
        </div>
      </footer>
    </div>
  );
}
