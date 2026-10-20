/**
 * Happy's standard styles, which a page loads first with
 * `<link rel="stylesheet" href="/api/v1/style.css">`.
 *
 * They lay a page on whatever surface shows it, inline in a conversation or beside it: a
 * transparent root, inset by `--happy-page-inset`, which a client showing the page inline sets to
 * nothing so the page lines up with the reply around it; the chat's typeface and sizes; and colors
 * that follow the page's `color-scheme` through `light-dark()`, which a client sets to its own
 * scheme. Every rule sits inside `:where()`, so it has zero specificity and anything the page
 * writes itself wins. The styles of the standard components (`/api/v1/components.js`) live here
 * too, so a page that restyles one does so in its own stylesheet.
 */
export const ARTIFACT_STYLE_SHEET = String.raw`/* Happy standard styles, served by Happy Agent. */
:where(:root) {
    color-scheme: light dark;
    --happy-text: light-dark(#18171a, #f4f3f6);
    --happy-muted: light-dark(#5c5862, #b9b4c0);
    --happy-faint: light-dark(#8f8a96, #807b87);
    --happy-border: light-dark(#e4e2e8, #343238);
    --happy-surface: light-dark(#f4f3f6, #232226);
    --happy-accent: light-dark(#1683a3, #3cb9d8);
    --happy-added: light-dark(#1a7f37, #4ac26b);
    --happy-removed: light-dark(#cf222e, #f47067);
    --happy-diff-added: light-dark(#34d058, #3fb950);
    --happy-diff-removed: light-dark(#d73a49, #f85149);
    --happy-chart-1: light-dark(#2f7fd6, #5aa2f0);
    --happy-chart-2: light-dark(#e07b28, #f29a4e);
    --happy-chart-3: light-dark(#2e9e6a, #4cc38a);
    --happy-chart-4: light-dark(#8a5cd6, #a989ef);
    --happy-chart-5: light-dark(#d4467a, #ec6f9c);
    --happy-chart-6: light-dark(#7d8794, #9aa3ae);
    --happy-font: "Figtree", system-ui, -apple-system, "Segoe UI", sans-serif;
    --happy-mono: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    background: transparent;
    color: var(--happy-text);
    font: 16px/24px var(--happy-font);
    -webkit-text-size-adjust: 100%;
    text-size-adjust: 100%;
}

:where(*, *::before, *::after) {
    box-sizing: border-box;
}

:where(body) {
    margin: 0;
    padding: var(--happy-page-inset, 24px);
    background: transparent;
}

:where(h1, h2, h3, h4) {
    margin: 24px 0 8px;
    font-weight: 600;
    letter-spacing: -0.01em;
}
:where(h1) { font-size: 24px; line-height: 32px; }
:where(h2) { font-size: 20px; line-height: 28px; }
:where(h3) { font-size: 17px; line-height: 24px; }
:where(h4) { font-size: 16px; line-height: 24px; }

:where(p, ul, ol, dl, table, pre, blockquote, figure, happy-diff, happy-code, happy-files, happy-chart, happy-diagram) {
    margin: 0 0 16px;
}
:where(ul, ol) { padding-left: 24px; }
:where(li + li) { margin-top: 4px; }
:where(small) { font-size: 13px; line-height: 20px; color: var(--happy-muted); }
:where(strong, b) { font-weight: 600; }

:where(a) {
    color: var(--happy-accent);
    text-decoration: none;
}
:where(a:hover) { text-decoration: underline; }

:where(code, kbd, samp, pre) {
    font-family: var(--happy-mono);
    font-size: 13px;
}
:where(:not(pre) > code) {
    padding: 1px 4px;
    border-radius: 4px;
    background: var(--happy-surface);
}
:where(pre) {
    padding: 12px 16px;
    border-radius: 8px;
    background: var(--happy-surface);
    line-height: 20px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
}

:where(blockquote) {
    padding: 0 0 0 16px;
    border-left: 2px solid var(--happy-border);
    color: var(--happy-muted);
}

:where(hr) {
    height: 1px;
    margin: 24px 0;
    border: 0;
    background: var(--happy-border);
}

:where(table) {
    width: 100%;
    border-collapse: collapse;
    font-size: 14px;
    line-height: 20px;
}
:where(th) {
    color: var(--happy-muted);
    font-weight: 500;
    text-align: left;
}
:where(th, td) {
    padding: 6px 12px 6px 0;
    border-bottom: 1px solid var(--happy-border);
    vertical-align: top;
}
:where(td:last-child, th:last-child) { padding-right: 0; }

:where(img, svg, video, canvas) {
    max-width: 100%;
}
:where(img, video) { height: auto; }

:where(button, input, select, textarea) {
    font: inherit;
    color: inherit;
}

/* The standard components. */

:where(happy-diff, happy-code, happy-files, happy-chart, happy-diagram) {
    display: block;
    min-width: 0;
}

:where(.happy-error) {
    color: var(--happy-removed);
    font-size: 13px;
    line-height: 20px;
}

/* Diffs and code are drawn by the renderer the page's host provides, Pierre Diffs in Happy
   Desktop, inside its own shadow root, so they take their type, material, and colours from custom
   properties set on its host, as the desktop sets them. The host itself is named because the
   renderer declares its theme's own colours there, which only a declaration on the element beats.
   The renderer mixes one colour per side into the background for every addition and deletion
   surface it draws, so those two are the whole of the diff's palette. A diff lies on the page's
   own surface; code sits on the sunk surface of a code block. */
:where(happy-diff, happy-code) diffs-container {
    --diffs-font-family: var(--happy-mono);
    --diffs-header-font-family: var(--happy-font);
    --diffs-font-size: 12px;
    --diffs-line-height: 20px;
    --diffs-gap-block: 4px;
    --diffs-gap-inline: 10px;
    --diffs-light-bg: transparent;
    --diffs-dark-bg: transparent;
    --diffs-light: var(--happy-text);
    --diffs-dark: var(--happy-text);
    --diffs-addition-color: var(--happy-diff-added);
    --diffs-deletion-color: var(--happy-diff-removed);
}
:where(happy-code) diffs-container {
    --diffs-light-bg: var(--happy-surface);
    --diffs-dark-bg: var(--happy-surface);
    --diffs-font-size: 12.5px;
    --diffs-gap-block: 8px;
    --diffs-gap-inline: 16px;
}
:where(happy-code .happy-code-target) {
    overflow: hidden;
    border-radius: 8px;
}

:where(.happy-diff-file + .happy-diff-file) {
    margin-top: 16px;
}
:where(.happy-code-header) {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 0 6px;
}
:where(.happy-code-plain .happy-code-header) {
    padding: 0 16px 6px;
}
:where(.happy-diff-note) {
    color: var(--happy-muted);
    font-size: 13px;
}

/* Where the host has no renderer: plain numbered lines, the additions and deletions tinted with the
   diff colours, and code on the same sunk surface. */
:where(.happy-code-plain) {
    padding: 8px 0;
    border-radius: 8px;
    background: var(--happy-surface);
}
:where(.happy-lines) {
    width: 100%;
    margin: 0;
    border-collapse: collapse;
    font-family: var(--happy-mono);
    font-size: 12px;
    line-height: 20px;
}
:where(.happy-code-plain .happy-lines) {
    font-size: 12.5px;
}
:where(.happy-lines td) {
    padding: 0;
    border: 0;
}
:where(.happy-line-number) {
    width: 1%;
    padding: 0 0 0 10px;
    color: var(--happy-faint);
    text-align: right;
    white-space: nowrap;
    user-select: none;
    font-variant-numeric: tabular-nums;
}
:where(.happy-line-code) {
    padding: 0 10px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
}
:where(.happy-code-plain .happy-line-code) {
    padding: 0 16px;
}
:where(.happy-lines-nowrap .happy-line-code) {
    white-space: pre;
    overflow-wrap: normal;
}
:where(.happy-lines-nowrap) {
    display: block;
    overflow-x: auto;
}
:where(.happy-line-add .happy-line-code, .happy-line-add .happy-line-number) {
    background: color-mix(in srgb, var(--happy-diff-added) 15%, transparent);
}
:where(.happy-line-del .happy-line-code, .happy-line-del .happy-line-number) {
    background: color-mix(in srgb, var(--happy-diff-removed) 15%, transparent);
}
:where(.happy-line-sign) {
    display: inline-block;
    width: 2ch;
    color: var(--happy-faint);
    user-select: none;
}
:where(.happy-line-add .happy-line-sign) { color: var(--happy-added); }
:where(.happy-line-del .happy-line-sign) { color: var(--happy-removed); }
:where(.happy-line-gap) {
    padding: 4px 10px;
    color: var(--happy-faint);
    font-family: var(--happy-font);
    font-size: 12px;
}

/* A file's name in a header. Its folder is the part that gives way, losing its head to an
   ellipsis, while the name keeps its width. */
:where(.happy-file-title) {
    display: flex;
    flex: 0 1 auto;
    align-items: center;
    min-width: 0;
    color: var(--happy-text);
    font-family: var(--happy-font);
    font-size: 12px;
    line-height: 20px;
}
:where(.happy-file-title-previous, .happy-file-title-folder) {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    color: var(--happy-muted);
    white-space: nowrap;
    text-overflow: ellipsis;
    direction: rtl;
}
:where(.happy-file-title-arrow) {
    flex: none;
    margin: 0 4px;
    color: var(--happy-muted);
}
:where(.happy-file-title-name) {
    flex: none;
    white-space: nowrap;
}
:where(.happy-file-title .happy-status) {
    margin-inline-start: 8px;
}

:where(.happy-path) {
    min-width: 0;
    overflow-wrap: anywhere;
    font-family: var(--happy-mono);
    font-size: 13px;
}
:where(.happy-status) {
    flex: none;
    font-size: 12px;
    color: var(--happy-muted);
}
:where(.happy-status-added) { color: var(--happy-added); }
:where(.happy-status-deleted) { color: var(--happy-removed); }
:where(.happy-counts) {
    flex: none;
    margin-left: auto;
    font-family: var(--happy-mono);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
}
:where(.happy-added) { color: var(--happy-added); }
:where(.happy-removed) { color: var(--happy-removed); }

:where(.happy-files-tree) {
    margin: 0;
    padding: 0;
    list-style: none;
    font-size: 13px;
    line-height: 24px;
}
:where(.happy-files-tree ul) {
    margin: 0;
    padding: 0 0 0 16px;
    list-style: none;
}
:where(.happy-files-tree li) { margin: 0; }
:where(.happy-files-row) {
    display: flex;
    align-items: baseline;
    gap: 8px;
}
:where(.happy-files-folder > .happy-files-row .happy-path) { color: var(--happy-muted); }
:where(.happy-files-link) { cursor: pointer; }
:where(.happy-files-link:hover .happy-path) { color: var(--happy-accent); }
:where(.happy-files-row .happy-status) { width: 1.5ch; text-align: center; }
:where(.happy-files-row .happy-counts) { margin-left: auto; }

:where(.happy-chart-legend) {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 16px;
    margin: 0 0 8px;
    color: var(--happy-muted);
    font-size: 13px;
    line-height: 20px;
}
:where(.happy-chart-key) {
    display: flex;
    align-items: center;
    gap: 6px;
}
:where(.happy-chart-swatch) {
    width: 8px;
    height: 8px;
    border-radius: 2px;
}
:where(happy-chart svg) {
    display: block;
    overflow: visible;
}
:where(happy-chart text) {
    fill: var(--happy-muted);
    font: 12px var(--happy-font);
    font-variant-numeric: tabular-nums;
}
:where(.happy-chart-grid) {
    stroke: var(--happy-border);
    stroke-width: 1;
}
:where(.happy-chart-bars) {
    display: flex;
    flex-direction: column;
    gap: 8px;
    font-size: 13px;
    line-height: 20px;
}
:where(.happy-chart-bar-row) {
    display: flex;
    align-items: center;
    gap: 12px;
}
:where(.happy-chart-bar-label) {
    flex: 0 0 30%;
    min-width: 0;
    overflow-wrap: anywhere;
    color: var(--happy-muted);
    text-align: right;
}
:where(.happy-chart-bar-tracks) {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
}
:where(.happy-chart-bar-track) {
    display: flex;
    align-items: center;
    gap: 8px;
}
:where(.happy-chart-bar-fill) {
    height: 12px;
    min-width: 2px;
    border-radius: 2px;
}
:where(.happy-chart-bar-value) {
    flex: none;
    color: var(--happy-muted);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
}

:where(.happy-diagram-figure) {
    display: flex;
    justify-content: center;
}
:where(.happy-diagram-figure svg) {
    max-width: 100%;
    height: auto;
}

/* The page's own edges are the inset's: the first and last things drawn take no margin there, and
   neither do the scripts and styles a page keeps at either end of its body. Last, so these win over
   every margin above at the same zero specificity. */
:where(
    body > :nth-child(1 of :not(script, style, link, template)),
    body > :nth-child(1 of :not(script, style, link, template)) > :first-child
) {
    margin-top: 0;
}
:where(
    body > :nth-last-child(1 of :not(script, style, link, template)),
    body > :nth-last-child(1 of :not(script, style, link, template)) > :last-child
) {
    margin-bottom: 0;
}
`;
