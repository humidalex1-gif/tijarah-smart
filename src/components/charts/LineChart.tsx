"use client";

import { useState, type PointerEvent as ReactPointerEvent } from "react";
import { dirFor, type Locale } from "@/lib/i18n";
import { formatDayKey, formatMoneyCompact } from "@/lib/format";

export interface LineChartSeries {
  label: string;
  /** A validated categorical color (see the `dataviz` skill) — assigned by the caller. */
  color: string;
  /** `x` is a `"YYYY-MM-DD"` UTC day-key (see `reporting.ts`'s `dayKey`); it
   * is rendered with `formatDayKey`, which pins `timeZone: "UTC"` so the tick
   * and tooltip labels always name the day the value was aggregated for,
   * regardless of the viewer's runtime zone. */
  points: { x: string; y: number }[];
}

const MARGIN = { top: 12, right: 16, bottom: 28, left: 60 };
const GRID_STEPS = 4;
const WIDTH = 760;

/**
 * Rounds a raw step (e.g. a data range divided by the target tick count) up
 * to a "nice" step of the form `{1,2,5} x 10^n` — the standard nice-ticks
 * heuristic (as in d3-array's `tickStep`). Without this, gridline/tick
 * labels are raw min/max interpolations like "−SAR 16.4" instead of round
 * numbers.
 */
export function niceStep(rawStep: number): number {
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const residual = rawStep / magnitude;
  const niceResidual = residual > 5 ? 10 : residual > 2 ? 5 : residual > 1 ? 2 : 1;
  return niceResidual * magnitude;
}

/**
 * Computes a nice y-axis domain and evenly-spaced tick values covering
 * `[minY, maxY]`, rounded outward to `niceStep` multiples. `targetSteps` is
 * a target, not a guarantee: the actual tick count depends on how the data
 * range rounds to a nice step, so it can come out above or below
 * `targetSteps + 1`.
 */
export function niceTicks(
  minY: number,
  maxY: number,
  targetSteps: number,
): { min: number; max: number; values: number[] } {
  // A flat/degenerate range (e.g. every value is 0) has no meaningful step
  // to round to — pad it symmetrically before computing one, rather than
  // dividing by a zero range.
  const paddedMax = maxY > minY ? maxY : minY + Math.max(Math.abs(minY), 1);
  const step = niceStep((paddedMax - minY) / targetSteps);
  const min = Math.floor(minY / step) * step;
  const max = Math.ceil(paddedMax / step) * step;
  const count = Math.round((max - min) / step);
  const values = Array.from({ length: count + 1 }, (_, i) => min + i * step);
  return { min, max, values };
}

/**
 * Dependency-free SVG line chart: gridlines + axis ticks, a legend (always
 * shown for 2+ series per the dataviz skill's identity rule), and a hover
 * crosshair/tooltip so every value is reachable without guessing a pixel.
 *
 * `locale` drives both date formatting and direction: in RTL the x-axis is
 * mirrored so time still reads in the script's natural reading order.
 *
 * Y-values format as money via `currency` rather than an injected `formatY`
 * callback: this is a Client Component (it needs pointer events for the
 * hover layer), and a Server Component caller cannot pass a plain closure
 * as a prop across that boundary — only `"use server"` actions and plain
 * data survive serialization into the RSC payload. `currency`/`locale` are
 * plain strings, so formatting happens with `formatMoneyCompact` in here.
 */
export function LineChart({
  series,
  height = 240,
  currency,
  locale,
}: {
  series: LineChartSeries[];
  height?: number;
  currency: string;
  locale: Locale;
}) {
  const formatY = (value: number) => formatMoneyCompact(value, locale, currency);
  const rtl = dirFor(locale) === "rtl";
  const innerWidth = WIDTH - MARGIN.left - MARGIN.right;
  const innerHeight = height - MARGIN.top - MARGIN.bottom;

  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const xKeys = series[0]?.points.map((p) => p.x) ?? [];
  const n = xKeys.length;
  if (n === 0) return null;

  // The hover layer below indexes every series by the same `hoverIndex`
  // (0..n-1, derived from series[0]). `LineChartSeries` doesn't statically
  // guarantee every series has the same point count, so a shorter series
  // would read past its own end — fail loudly here instead of rendering a
  // silently wrong/crashing tooltip deep inside a `.map`.
  for (const s of series) {
    if (s.points.length !== n) {
      throw new Error(
        `LineChart: series "${s.label}" has ${s.points.length} points, `
        + `but series[0] ("${series[0].label}") has ${n}. All series must `
        + `share the same x-keys/point count.`,
      );
    }
  }

  const allY = series.flatMap((s) => s.points.map((p) => p.y));
  const maxY = Math.max(0, ...allY);
  const minY = Math.min(0, ...allY);
  const { min: niceMin, max: niceMax, values: gridValues } = niceTicks(minY, maxY, GRID_STEPS);
  const yRange = niceMax - niceMin;

  function xFor(index: number): number {
    if (n <= 1) return MARGIN.left + innerWidth / 2;
    const t = index / (n - 1);
    return rtl ? MARGIN.left + innerWidth * (1 - t) : MARGIN.left + innerWidth * t;
  }
  function yFor(value: number): number {
    return MARGIN.top + innerHeight - ((value - niceMin) / yRange) * innerHeight;
  }

  function handleMove(e: ReactPointerEvent<SVGRectElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const relX = (e.clientX - rect.left) / rect.width;
    const t = rtl ? 1 - relX : relX;
    setHoverIndex(Math.min(n - 1, Math.max(0, Math.round(t * (n - 1)))));
  }

  const tickIndices = [...new Set([0, Math.floor((n - 1) / 2), n - 1])];

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${WIDTH} ${height}`} className="w-full">
        {gridValues.map((value) => (
          <g key={value}>
            <line
              x1={MARGIN.left}
              x2={WIDTH - MARGIN.right}
              y1={yFor(value)}
              y2={yFor(value)}
              stroke="var(--color-line)"
              strokeWidth={1}
            />
            <text
              x={MARGIN.left - 8}
              y={yFor(value)}
              dy="0.32em"
              textAnchor="end"
              className="fill-muted text-[10px] tabular-nums"
            >
              {formatY(value)}
            </text>
          </g>
        ))}

        {tickIndices.map((i) => (
          <text
            key={i}
            x={xFor(i)}
            y={height - 8}
            textAnchor="middle"
            className="fill-muted text-[10px]"
          >
            {formatDayKey(xKeys[i], locale)}
          </text>
        ))}

        {series.map((s) => (
          <path
            key={s.label}
            d={s.points.map((p, i) => `${i === 0 ? "M" : "L"} ${xFor(i)} ${yFor(p.y)}`).join(" ")}
            fill="none"
            stroke={s.color}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}

        {series.map((s) => {
          const last = s.points[s.points.length - 1];
          return last ? (
            <circle
              key={s.label}
              cx={xFor(s.points.length - 1)}
              cy={yFor(last.y)}
              r={4}
              fill={s.color}
              stroke="var(--color-panel)"
              strokeWidth={2}
            />
          ) : null;
        })}

        {hoverIndex !== null ? (
          <>
            <line
              x1={xFor(hoverIndex)}
              x2={xFor(hoverIndex)}
              y1={MARGIN.top}
              y2={height - MARGIN.bottom}
              stroke="var(--color-muted)"
              strokeWidth={1}
              strokeDasharray="2 3"
            />
            {series.map((s) => (
              <circle
                key={s.label}
                cx={xFor(hoverIndex)}
                cy={yFor(s.points[hoverIndex].y)}
                r={4}
                fill={s.color}
                stroke="var(--color-panel)"
                strokeWidth={2}
              />
            ))}
          </>
        ) : null}

        <rect
          x={MARGIN.left}
          y={MARGIN.top}
          width={innerWidth}
          height={innerHeight}
          fill="transparent"
          onPointerMove={handleMove}
          onPointerLeave={() => setHoverIndex(null)}
        />
      </svg>

      <div className="mt-2 flex flex-wrap gap-4">
        {series.map((s) => (
          <div key={s.label} className="flex items-center gap-1.5 text-xs text-muted">
            <span
              className="inline-block h-0.5 w-4 rounded-full"
              style={{ backgroundColor: s.color }}
            />
            {s.label}
          </div>
        ))}
      </div>

      {hoverIndex !== null ? (
        <div
          className="pointer-events-none absolute top-0 z-10 min-w-36 -translate-x-1/2 rounded-lg border border-line bg-panel px-3 py-2 text-xs shadow-md"
          style={{ left: `${(xFor(hoverIndex) / WIDTH) * 100}%` }}
        >
          <div className="mb-1 font-medium text-navy">
            {formatDayKey(xKeys[hoverIndex], locale)}
          </div>
          {series.map((s) => (
            <div key={s.label} className="flex items-center gap-2 py-0.5">
              <span
                className="inline-block h-0.5 w-3 shrink-0 rounded-full"
                style={{ backgroundColor: s.color }}
              />
              <span className="text-muted">{s.label}</span>
              <span className="ms-auto font-medium tabular-nums">
                {formatY(s.points[hoverIndex].y)}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
