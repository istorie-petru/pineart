/**
 * Shortest-column masonry — architecture §1.
 *
 * CSS `columns` was tried and rejected upstream: it fills each column
 * top-to-bottom before starting the next, which reads as stacked lists rather
 * than Pinterest's left-to-right balanced placement. This places each card into
 * whichever column is currently shortest.
 *
 * One deliberate improvement over the mockup's version: the mockup measured
 * `offsetHeight` after render, which means the layout is wrong until every image
 * has loaded and then reflows visibly. The API gives us each item's real width
 * and height, so the card's height is computed from its aspect ratio *before*
 * the image arrives. The grid is therefore correct on first paint and never
 * jumps — and it is what makes the dominant-colour placeholder useful rather
 * than decorative.
 */

/**
 * The gutter is read from the `--gutter` custom property rather than hardcoded,
 * because §8 promises that changing that one variable restyles the grid. A
 * constant here would have made that promise false — the CSS variable would
 * still exist and simply do nothing to the layout.
 */
function gutter(container: HTMLElement): number {
  const raw = getComputedStyle(container).getPropertyValue("--gutter").trim();
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : 14;
}

/**
 * Never fewer than two columns. §7 calls for 2 on mobile up to 5–7 on wide
 * desktop; with a 190px minimum card width, a 380px phone works out to exactly
 * one column, which reads as a single-file list rather than as a grid. The
 * minimum is what keeps the phone layout recognisably the same design as the
 * desktop one.
 */
const MIN_COLUMNS = 2;

export interface MasonryEntry {
  el: HTMLElement;
  /** Intrinsic aspect ratio (width / height) of the image this card shows. */
  aspect: number;
  /** Fixed pixel height added below the image, e.g. a caption row. */
  chrome?: number;
}

export function layout(container: HTMLElement, entries: MasonryEntry[], minColumnWidth = 190): void {
  const visible = entries.filter((e) => e.el.style.display !== "none");
  if (!visible.length) {
    container.style.height = "0px";
    return;
  }
  const containerWidth = container.clientWidth;
  if (!containerWidth) return;

  // Column count falls out of the available width; there is no breakpoint table,
  // which is why the grid is already correct at any viewport size.
  const gap = gutter(container);
  const columns = Math.max(
    MIN_COLUMNS,
    Math.floor((containerWidth + gap) / (minColumnWidth + gap)),
  );
  const columnWidth = (containerWidth - gap * (columns - 1)) / columns;
  const heights = new Array<number>(columns).fill(0);

  for (const entry of visible) {
    let column = 0;
    for (let i = 1; i < columns; i++) if (heights[i] < heights[column]) column = i;

    const cardHeight = columnWidth / (entry.aspect || 1) + (entry.chrome ?? 0);
    entry.el.style.width = `${columnWidth}px`;
    entry.el.style.left = `${column * (columnWidth + gap)}px`;
    entry.el.style.top = `${heights[column]}px`;
    heights[column] += cardHeight + gap;
  }

  container.style.height = `${Math.max(0, ...heights)}px`;
}

export function debounce<T extends (...args: never[]) => void>(fn: T, ms: number): T {
  let timer: number | undefined;
  return ((...args: never[]) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), ms);
  }) as T;
}

/**
 * Re-layout when the container's width changes for any reason — a window
 * resize, a tab switch that reveals a hidden grid, a drawer opening. A
 * ResizeObserver catches all of those; a window resize listener alone catches
 * only the first, which is why the mockup had to re-run layout manually on
 * every view switch.
 */
export function observe(container: HTMLElement, relayout: () => void): () => void {
  const observer = new ResizeObserver(debounce(relayout, 60));
  observer.observe(container);
  return () => observer.disconnect();
}
