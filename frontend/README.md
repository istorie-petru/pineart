# Artboard — frontend

Vite + vanilla TypeScript. No SPA framework, no state library, no CSS preprocessor — the app is small enough that a framework would be more machinery than the problem needs, and the architecture document chose it that way on purpose.

```bash
npm install
npm run dev        # :5173, proxies /api to the backend on :8000
npm run build      # typecheck, then bundle to dist/
npm run smoke      # headless boot check against a running, seeded backend
```

## How it fits together

`main.ts` owns the nav, the hash router and uploads. Each entry in `src/views/` renders one top-level screen into `#app` and returns a teardown function; the router calls that teardown before rendering the next view, which is what stops D3 simulations, ResizeObservers and SortableJS instances from accumulating across navigations.

`store.ts` is a settings and tag cache with change notification — a data holder, not a framework. Views read from it and subscribe; nothing in it re-renders anything by itself.

## The parts worth knowing about

**Masonry** (`masonry.ts`) places each card into whichever column is currently shortest. CSS `columns` was rejected upstream because it fills each column top-to-bottom before starting the next, which reads as stacked lists rather than Pinterest's balanced placement.

The gutter is read from the `--gutter` custom property rather than hardcoded, because §8 promises that changing that one variable restyles the grid — a constant would have left the variable in place and quietly inert. Column count is floored at two: at a 190px minimum card width a 380px phone works out to exactly one column, which reads as a single-file list rather than as the same design at a smaller size.

The one deliberate improvement over the mockup: the mockup measured `offsetHeight` after render, so its layout was wrong until every image loaded and then visibly reflowed. The API returns each item's real width and height, so card heights are computed from the aspect ratio *before* the image arrives. The grid is correct on first paint and never jumps — and that is what makes the `dominant_color` placeholder useful rather than decorative. Column count falls out of `container width / min card width`, so there is no breakpoint table and the grid is already right at any viewport.

**Search bar as filter state** (`components/searchBar.ts`). Picking a tag, colour or orientation writes a `tag:` / `color:` / `orientation:` token into the input rather than into a parallel hidden filter object. What you see and what the backend receives are the same string, the filter is copy-pasteable, and the visible chips cannot disagree with the actual query.

Toggling rewrites the whole bar canonically — tokens first, free text last, no duplicates — rather than appending and string-replacing in place. `tag:a foo tag:b` and `foo tag:a tag:b` are the same filter but read differently, and removing a token by substring can eat part of a neighbouring one. Colours are written by name (`color:red`), because the bar is meant to be read and typed by a person and `color:#e63946` is neither.

**Drag-reorder** (`views/boardDetail.ts`). SortableJS needs elements in normal document flow to compute drop targets, but masonry positions cards absolutely. The grid switches to a plain flex layout for the duration of a drag (`.masonry.dragging`) and re-runs the masonry layout on drop.

**Crop** (`components/cropModal.ts`) uses Cropper.js specifically because `getData()` returns the selection in source-image pixel coordinates, which is exactly what `POST /api/items/{id}/crop` wants. The crop preview is the *display* derivative while the crop is applied to the original, so the coordinates are scaled by `item.width / image.naturalWidth` before sending — without that, every crop would come out silently reduced by the display/original ratio.

**Tag graph** (`components/tagGraph.ts`) is a real d3-force simulation. Dragging pins a node for the drag and releases it on drop so it springs back to equilibrium, hovering dims non-neighbours, and a low alpha nudged on a slow interval keeps a faint idle drift so the graph reads as alive rather than frozen. Clicking opens the inline editor and deliberately does not navigate; "View images" is the separate, explicit jump.

**Theme** is applied by an inline script in `index.html` from `localStorage` before first paint, then overwritten by the settings API once it loads. Waiting for the fetch would guarantee a flash of the wrong theme on every load.

**Infinite scroll** (`components/grid.ts`) auto-loads the next page when a sentinel 600px below the grid comes into view, and the explicit "Load more" button stays — Settings → Collection turns the auto-loading off for anyone who prefers the architecture document's original choice.

Three guards make it safe, and each one corresponds to a way it breaks without them: a `loading` flag, because the observer will happily fire a second request with the same cursor while the first is still out and append the same page twice; an `exhausted` flag, because once the sentinel is permanently on screen it would otherwise re-request the final page forever; and a generation counter, because a page that arrives after the search changed must be discarded rather than landing on top of the new results. Appends are also deduplicated by id.

**Selection mode.** Once one item is selected, a click anywhere on any card toggles it instead of opening it, and the grid gets a `.selecting` class that keeps every checkbox visible. Deselecting the last item returns clicks to opening. Hitting twenty 20px checkboxes was the alternative.

**Drag and drop.** Dropping images anywhere on the window uploads them. Both `dragover` and `drop` must `preventDefault`, or the browser navigates to the dropped image and discards the app. `dragenter`/`dragleave` fire for every child element the pointer crosses, so a depth counter tracks whether the pointer has genuinely left the window — without it the overlay flickers on every internal boundary.

**Tag input** (`components/tagInput.ts`) is one component used everywhere a tag is typed — the upload dialog, the item modal, bulk tagging, the search filter — so matching behaves identically in all of them. Suggestions come from `/api/tags/suggest` rather than filtering a cached list, because the ranking depends on the same slug normalization the backend uses for tag identity; reimplementing it in TypeScript would be two rule sets to keep in step. Responses are sequence-numbered, since an out-of-order reply would otherwise show suggestions for a query the user has already typed past.

**Upload dialog** (`components/uploadDialog.ts`) confirms an upload and lets you tag it and file it to a board first, for both the picker and drag-and-drop — the moment you are adding images is the moment you know what they are. Anything typed but not yet committed as a chip is still included, because losing a tag because Enter was never pressed is a nasty little surprise. Object URLs for the previews are revoked on close, and preview creation is guarded: previews are a convenience, so losing them must not stop the upload being confirmable.

**Keyboard shortcuts** consult `isTypingTarget` before doing anything. It checks both the event target *and* `document.activeElement`, because a shortcut bound on `document` can receive an event whose target is the document while focus sits in a field — and it would then steal a keystroke meant for the text. Without this, correcting a title with the arrow keys jumps to the next artwork and discards what you were writing.

**Pasting** into any text field strips leading and trailing whitespace. Copying a tag or title out of another app almost always brings a trailing newline with it, and that survives into the database as an invisible difference — a tag named `landscape ` that never matches `landscape`. Internal line breaks are preserved, so pasting a paragraph into a description still works, and `insertText` is used rather than assigning `value` so the browser's undo history survives.

**Versions** appear as a strip in the item modal: every file for the artwork, the displayed one marked, with "Show this" to switch and a button to add another. An artwork with a single file says so in one line instead of carrying a whole panel about version management.

**Auth handling** is centralised in `api.ts`: any 401 from a non-auth endpoint fires a handler that `main.ts` uses to swap in the login screen. Sessions can expire during any request, and having every call site check for that would be both repetitive and easy to forget one of.

## Things this build does not do

No service worker or offline caching — the PWA manifest makes the app installable, nothing more, which is the scope the architecture document set.

Non-image files chosen through the folder importer are filtered out client-side before upload rather than being sent for the server to reject.
