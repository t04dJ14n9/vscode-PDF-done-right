/**
 * Wiki-Link Extension for CodeMirror 6 (VS Code webview port)
 *
 * Supports three link syntaxes:
 * - [[wikilinks]] / [[note#section]]  — internal note links (purple accent)
 * - @code[[path#L1-L2|"snippet"]]     — code references (blue)
 * - [[path.pdf#page=...&selection=...|snippet]] — PDF references (Obsidian/PDF++)
 * - @pdf[[path#anchor|"snippet"]]      — legacy PDF references
 *
 * On non-cursor lines, renders as styled inline widgets.
 * On cursor line, shows raw syntax for editing.
 * Cmd/Ctrl+click navigates via callbacks.
 * Autocomplete triggers on [[ for note names and headings.
 */
import {
    EditorView,
    ViewPlugin,
    Decoration,
    WidgetType,
} from '@codemirror/view';
import type {
    ViewUpdate,
    DecorationSet,
} from '@codemirror/view';
import type { CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { findPdfLinkMatches } from '../../src/shared/types';

// ─── Callback types ──────────────────────────────────────────────────────────

export type ResolveNoteCallback = (noteName: string) => string | null;
export type OpenNoteCallback = (filePath: string, section?: string) => void;
export type GetNoteNamesCallback = () => string[];
export type GetNoteHeadingsCallback = (noteName: string) => string[];
export type OpenCodeRefCallback = (path: string, startLine?: number, endLine?: number) => void;
export type OpenPdfRefCallback = (pdfPath: string, anchor: string) => void;
export type ResolveImageSrcCallback = (imagePath: string) => Promise<string | null> | string | null;
export type OpenImageCallback = (imagePath: string) => void;

export interface WikiLinkConfig {
    resolveNote?: ResolveNoteCallback;
    openNote?: OpenNoteCallback;
    getNoteNames?: GetNoteNamesCallback;
    getNoteHeadings?: GetNoteHeadingsCallback;
    onOpenCodeRef?: OpenCodeRefCallback;
    onOpenPdfRef?: OpenPdfRefCallback;
    resolveImageSrc?: ResolveImageSrcCallback;
    onOpenImage?: OpenImageCallback;
}

// ─── Regex patterns ──────────────────────────────────────────────────────────

const WIKI_LINK_REGEX = /\[\[([^\]#|]+)(?:#([^\]|]+))?\]\]/g;
const IMAGE_WIKI_LINK_REGEX = /!\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
const CODE_LINK_REGEX = /@code\[\[([^\]#|]+)(?:#L(\d+)(?:-L(\d+))?)?(?:\|"([^"]*)")?\]\]/g;

// ─── Widget classes ──────────────────────────────────────────────────────────

class WikiLinkWidget extends WidgetType {
    constructor(
        readonly noteName: string,
        readonly section: string | undefined,
        readonly resolved: boolean,
    ) {
        super();
    }

    override toDOM(): HTMLElement {
        const span = document.createElement('span');
        span.className = this.resolved
            ? 'cm-wiki-link cm-wiki-link-resolved'
            : 'cm-wiki-link cm-wiki-link-unresolved';
        const displayText = this.section
            ? `${this.noteName} \u203A ${this.section}`
            : this.noteName;
        span.textContent = displayText;
        span.dataset.noteName = this.noteName;
        if (this.section) {
            span.dataset.section = this.section;
        }
        return span;
    }

    override eq(other: WikiLinkWidget): boolean {
        return (
            this.noteName === other.noteName &&
            this.section === other.section &&
            this.resolved === other.resolved
        );
    }

    override ignoreEvent(): boolean {
        return false;
    }
}

class CodeLinkWidget extends WidgetType {
    constructor(
        readonly path: string,
        readonly startLine: string | undefined,
        readonly endLine: string | undefined,
        readonly snippet: string | undefined,
    ) {
        super();
    }

    override toDOM(): HTMLElement {
        const span = document.createElement('span');
        span.className = 'cm-code-link';

        const icon = document.createElement('span');
        icon.className = 'cm-code-link-icon';
        icon.textContent = '\u{1F4BB}'; // laptop emoji as code icon
        span.appendChild(icon);

        const text = document.createElement('span');
        let display = this.path;
        if (this.startLine) {
            display += this.endLine && this.endLine !== this.startLine
                ? `:${this.startLine}-${this.endLine}`
                : `:${this.startLine}`;
        }
        text.textContent = display;
        if (this.snippet) {
            text.textContent += ` \u201C${this.snippet}\u201D`;
        }
        span.appendChild(text);

        span.dataset.codePath = this.path;
        if (this.startLine) span.dataset.startLine = this.startLine;
        if (this.endLine) span.dataset.endLine = this.endLine;
        return span;
    }

    override eq(other: CodeLinkWidget): boolean {
        return (
            this.path === other.path &&
            this.startLine === other.startLine &&
            this.endLine === other.endLine &&
            this.snippet === other.snippet
        );
    }

    override ignoreEvent(): boolean {
        return false;
    }
}

/**
 * Extract page number from an anchor string like "page=1&idx=0&off=0&len=25".
 */
function parsePageFromAnchor(anchor: string): number | null {
    const m = anchor.match(/page=(\d+)/);
    return m ? parseInt(m[1]!, 10) : null;
}

/**
 * Extract a human-friendly title from a PDF path.
 * "papers/Dettmers et al. - 2023 - QLoRA.pdf" → "Dettmers et al. - 2023 - QLoRA"
 * "sample.pdf" → "sample"
 */
function pdfPathToTitle(pdfPath: string): string {
    // Get filename from path
    const parts = pdfPath.split('/');
    let name = parts[parts.length - 1] ?? pdfPath;
    // Remove .pdf extension
    name = name.replace(/\.pdf$/i, '');
    return name;
}

class PdfLinkWidget extends WidgetType {
    constructor(
        readonly pdfPath: string,
        readonly anchor: string,
        readonly snippet: string | undefined,
    ) {
        super();
    }

    override toDOM(): HTMLElement {
        const span = document.createElement('span');
        span.className = 'cm-pdf-link';

        // Build display text: "Title, p.N" or "Snippet..., p.N"
        const page = parsePageFromAnchor(this.anchor);
        const title = pdfPathToTitle(this.pdfPath);
        const pageSuffix = page !== null ? `, p.${page}` : '';

        if (this.snippet) {
            // Truncate long snippets
            const maxLen = 60;
            const truncated = this.snippet.length > maxLen
                ? this.snippet.substring(0, maxLen - 3) + '...'
                : this.snippet;
            span.textContent = `${title} \u201C${truncated}\u201D${pageSuffix}`;
        } else {
            span.textContent = `${title}${pageSuffix}`;
        }

        span.dataset.pdfPath = this.pdfPath;
        span.dataset.anchor = this.anchor;
        return span;
    }

    override eq(other: PdfLinkWidget): boolean {
        return (
            this.pdfPath === other.pdfPath &&
            this.anchor === other.anchor &&
            this.snippet === other.snippet
        );
    }

    override ignoreEvent(): boolean {
        return false;
    }
}

function isImagePath(linkPath: string): boolean {
    return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(linkPath.trim());
}

class ImageWikiWidget extends WidgetType {
    constructor(
        readonly imagePath: string,
        readonly caption: string | undefined,
        readonly resolveImageSrc: ResolveImageSrcCallback | undefined,
        readonly onOpenImage: OpenImageCallback | undefined,
        readonly previewBelow = false,
    ) {
        super();
    }

    override toDOM(): HTMLElement {
        const container = document.createElement('span');
        container.className = this.previewBelow ? 'cm-image-wiki cm-image-wiki-preview-below' : 'cm-image-wiki';
        container.dataset.imagePath = this.imagePath;
        container.title = 'Double-click to open image';
        container.addEventListener('dblclick', (event) => {
            event.preventDefault();
            event.stopPropagation();
            this.onOpenImage?.(this.imagePath);
        });

        if (this.previewBelow) {
            container.appendChild(document.createElement('br'));
        }

        const img = document.createElement('img');
        img.className = 'cm-image-wiki-img';
        img.alt = this.caption || this.imagePath;
        img.loading = 'lazy';
        container.appendChild(img);

        const renderFallback = () => {
            if (!container.querySelector('.cm-image-wiki-fallback')) {
                const fallback = document.createElement('span');
                fallback.className = 'cm-image-wiki-fallback';
                fallback.textContent = this.caption || this.imagePath;
                container.appendChild(fallback);
            }
        };

        const renderImage = (src: string) => {
            const fallback = container.querySelector('.cm-image-wiki-fallback');
            fallback?.remove();
            img.style.display = 'block';
            img.src = src;
        };

        if (this.resolveImageSrc) {
            const resolved = this.resolveImageSrc(this.imagePath);
            if (typeof resolved === 'string') {
                if (resolved) {
                    renderImage(resolved);
                } else {
                    renderFallback();
                }
            } else if (resolved) {
                resolved
                    .then(src => {
                        if (!src) {
                            renderFallback();
                            return;
                        }
                        renderImage(src);
                    })
                    .catch(() => {
                        renderFallback();
                    });
            } else {
                renderFallback();
            }
        } else {
            renderFallback();
        }

        img.onerror = () => {
            img.style.display = 'none';
            renderFallback();
        };

        return container;
    }

    override eq(other: ImageWikiWidget): boolean {
        return (
            this.imagePath === other.imagePath
            && this.caption === other.caption
            && this.previewBelow === other.previewBelow
        );
    }

    override ignoreEvent(): boolean {
        return false;
    }
}

// ─── Decoration builder ──────────────────────────────────────────────────────

/** Line decoration applied to lines containing PDF links regardless of cursor
 *  state, so that the raw text is displayed on a single (nowrap) line when the
 *  cursor enters — preventing a height jump between the compact widget and the
 *  longer raw markdown text.  Same pattern as hybridRendering.ts headings. */
const pdfLineDeco = Decoration.line({ class: 'cm-pdf-link-line' });

function buildDecorations(
    view: EditorView,
    config: WikiLinkConfig,
): DecorationSet {
    const doc = view.state.doc;

    const cursorLines = new Set<number>();
    for (const range of view.state.selection.ranges) {
        const startLine = doc.lineAt(range.from).number;
        const endLine = doc.lineAt(range.to).number;
        for (let l = startLine; l <= endLine; l++) {
            cursorLines.add(l);
        }
    }

    // Collect all decoration ranges so we can sort them before adding
    type RangeEntry = { from: number; to: number; deco: Decoration };
    const ranges: RangeEntry[] = [];
    let wikiCount = 0, codeCount = 0, pdfCount = 0, imageCount = 0;

    for (let i = 1; i <= doc.lines; i++) {
        const line = doc.line(i);
        const pdfMatches = findPdfLinkMatches(line.text);

        // Always apply line decoration to PDF-link lines (even when cursor is on them)
        // to prevent height jumps — the nowrap/ellipsis keeps raw text on one line.
        if (pdfMatches.length > 0) {
            ranges.push({ from: line.from, to: line.from, deco: pdfLineDeco });
        }

        const occupied: Array<{ from: number; to: number }> = [];

        // Obsidian-style embedded image links stay rendered even on the cursor
        // line, matching Obsidian live preview behavior for image embeds.
        let match: RegExpExecArray | null;
        IMAGE_WIKI_LINK_REGEX.lastIndex = 0;
        while ((match = IMAGE_WIKI_LINK_REGEX.exec(line.text)) !== null) {
            const from = line.from + match.index;
            const to = from + match[0].length;
            const imagePath = (match[1] ?? '').trim();
            const caption = match[2]?.trim();
            if (!isImagePath(imagePath)) continue;
            imageCount++;
            const cursorOnLine = cursorLines.has(i);
            if (!cursorOnLine) {
                occupied.push({ from, to });
            }
            ranges.push({
                from: cursorOnLine ? to : from,
                to: cursorOnLine ? to : to,
                deco: cursorOnLine ? Decoration.widget({
                    widget: new ImageWikiWidget(imagePath, caption, config.resolveImageSrc, config.onOpenImage, true),
                    side: 1,
                }) : Decoration.replace({
                    widget: new ImageWikiWidget(imagePath, caption, config.resolveImageSrc, config.onOpenImage),
                }),
            });
        }

        // Skip non-image widget replacements on cursor lines so text links stay
        // editable while the image preview remains open.
        if (cursorLines.has(i)) continue;

        // PDF links first — Obsidian-style PDF links are also plain [[...]]
        // and would otherwise be treated as wiki links.
        for (const pdfMatch of pdfMatches) {
            pdfCount++;
            const from = line.from + pdfMatch.index;
            const to = from + pdfMatch.fullMatch.length;
            occupied.push({ from, to });
            ranges.push({
                from,
                to,
                deco: Decoration.replace({
                    widget: new PdfLinkWidget(
                        pdfMatch.pdfPath,
                        pdfMatch.anchor,
                        pdfMatch.snippet || undefined,
                    ),
                }),
            });
        }

        // Wiki links
        WIKI_LINK_REGEX.lastIndex = 0;
        while ((match = WIKI_LINK_REGEX.exec(line.text)) !== null) {
            const from = line.from + match.index;
            const to = from + match[0].length;
            const noteName = (match[1] ?? '').trim();
            const section = match[2]?.trim();
            if (match.index > 0 && line.text[match.index - 1] === '!') continue;
            if (occupied.some(r => from < r.to && to > r.from)) continue;
            if (/\.pdf$/i.test(noteName)) continue;
            wikiCount++;
            const resolved = config.resolveNote
                ? config.resolveNote(noteName) !== null
                : true;
            ranges.push({
                from,
                to,
                deco: Decoration.replace({
                    widget: new WikiLinkWidget(noteName, section, resolved),
                }),
            });
        }

        // Code links
        CODE_LINK_REGEX.lastIndex = 0;
        while ((match = CODE_LINK_REGEX.exec(line.text)) !== null) {
            codeCount++;
            const from = line.from + match.index;
            const to = from + match[0].length;
            ranges.push({
                from,
                to,
                deco: Decoration.replace({
                    widget: new CodeLinkWidget(
                        match[1] ?? '',
                        match[2],
                        match[3],
                        match[4],
                    ),
                }),
            });
        }
    }

    // Use Decoration.set() which handles sorting for us (needed because
    // we mix line decorations (from=to) with widget replace decorations)
    try {
        const result = Decoration.set(
            ranges.map(r => r.deco.range(r.from, r.to)),
            true, // sort
        );
        console.log(`[wikiLink] Built decorations: ${wikiCount} wiki, ${codeCount} code, ${pdfCount} pdf, ${imageCount} image, ${ranges.length} total ranges, cursorLines=${[...cursorLines]}`);
        return result;
    } catch (e) {
        console.error('[wikiLink] Error building decorations:', e, 'ranges:', ranges.map(r => ({from: r.from, to: r.to})));
        return Decoration.none;
    }
}

// ─── Extension factory ──────────────────────────────────────────────────────

export function wikiLink(config: WikiLinkConfig = {}) {
    const decorationPlugin = ViewPlugin.fromClass(
        class {
            decorations: DecorationSet;

            constructor(view: EditorView) {
                this.decorations = buildDecorations(view, config);
            }

            update(update: ViewUpdate) {
                if (update.docChanged || update.selectionSet) {
                    this.decorations = buildDecorations(update.view, config);
                }
            }
        },
        {
            decorations: (v) => v.decorations,
        },
    );

    // Two-phase Cmd/Ctrl+click handling for CM6 replace-widgets:
    //
    // Problem: When a user clicks a widget, CM6 processes `mousedown` first,
    // moving the cursor to the clicked position. Since `buildDecorations()`
    // skips the cursor line, the widget is destroyed before `click` fires.
    // The click target becomes the raw text, and `closest('.cm-pdf-link')`
    // returns null — the navigation never happens.
    //
    // Solution: Use `mousedown` via `EditorView.domEventHandlers()` to
    // (a) capture the link data from the widget before CM6 destroys it, and
    // (b) return `true` to prevent CM6 from processing the event, keeping
    //     the widget alive so the follow-up `click` can navigate.
    //
    // We only do this for follow-link intent (Cmd/Ctrl+click). Plain clicks
    // are left to CM so word-selection, double-click-drag, and system lookup
    // gestures work normally (Obsidian-like behavior).

    /** Captured link data from a mousedown on a widget */
    let pendingClick: {
        kind: 'pdf'; pdfPath: string; anchor: string;
    } | {
        kind: 'code'; codePath: string; startLine?: number; endLine?: number;
    } | {
        kind: 'wiki'; noteName: string; section?: string;
    } | null = null;

    const mousedownGuard = EditorView.domEventHandlers({
        mousedown(event: MouseEvent) {
            const wantsFollow = event.metaKey || event.ctrlKey;
            if (!wantsFollow || event.button !== 0) {
                pendingClick = null;
                return false;
            }
            const target = event.target as HTMLElement;

            const pdfEl = target.closest<HTMLElement>('.cm-pdf-link');
            if (pdfEl?.dataset.pdfPath && pdfEl.dataset.anchor) {
                pendingClick = {
                    kind: 'pdf',
                    pdfPath: pdfEl.dataset.pdfPath,
                    anchor: pdfEl.dataset.anchor,
                };
                return true; // prevent CM6 from moving cursor
            }

            const codeEl = target.closest<HTMLElement>('.cm-code-link');
            if (codeEl?.dataset.codePath) {
                pendingClick = {
                    kind: 'code',
                    codePath: codeEl.dataset.codePath,
                    startLine: codeEl.dataset.startLine
                        ? parseInt(codeEl.dataset.startLine, 10)
                        : undefined,
                    endLine: codeEl.dataset.endLine
                        ? parseInt(codeEl.dataset.endLine, 10)
                        : undefined,
                };
                return true;
            }

            const wikiEl = target.closest<HTMLElement>('.cm-wiki-link');
            if (wikiEl?.dataset.noteName) {
                pendingClick = {
                    kind: 'wiki',
                    noteName: wikiEl.dataset.noteName,
                    section: wikiEl.dataset.section,
                };
                return true;
            }

            pendingClick = null;
            return false;
        },
    });

    // The click handler fires after mousedown. Because we returned `true`
    // from mousedown, the widget is still alive, but we use the captured
    // `pendingClick` data for robustness.
    const clickListener = ViewPlugin.fromClass(class {
        constructor(readonly view: EditorView) {
            this.view.dom.addEventListener('click', this.onClick);
            this.view.dom.addEventListener('dblclick', this.onDoubleClick);
        }
        destroy() {
            this.view.dom.removeEventListener('click', this.onClick);
            this.view.dom.removeEventListener('dblclick', this.onDoubleClick);
        }
        onDoubleClick = (event: MouseEvent) => {
            const target = event.target as HTMLElement;
            const imageEl = target.closest<HTMLElement>('.cm-image-wiki');
            const imagePath = imageEl?.dataset.imagePath;
            if (!imagePath || !config.onOpenImage) return;
            event.preventDefault();
            event.stopPropagation();
            config.onOpenImage(imagePath);
        };
        onClick = (event: MouseEvent) => {
            const wantsFollow = event.metaKey || event.ctrlKey;
            if (!wantsFollow) {
                pendingClick = null;
                return;
            }

            const data = pendingClick;
            pendingClick = null;

            if (!data) {
                // Fallback: try to find the widget from the click target
                // (covers cases where mousedown didn't fire through domEventHandlers)
                const target = event.target as HTMLElement;
                const pdfEl = target.closest<HTMLElement>('.cm-pdf-link');
                if (pdfEl?.dataset.pdfPath && pdfEl.dataset.anchor && config.onOpenPdfRef) {
                    event.preventDefault();
                    event.stopPropagation();
                    config.onOpenPdfRef(pdfEl.dataset.pdfPath, pdfEl.dataset.anchor);
                    return;
                }
                const codeEl = target.closest<HTMLElement>('.cm-code-link');
                if (codeEl?.dataset.codePath && config.onOpenCodeRef) {
                    event.preventDefault();
                    event.stopPropagation();
                    config.onOpenCodeRef(
                        codeEl.dataset.codePath,
                        codeEl.dataset.startLine ? parseInt(codeEl.dataset.startLine, 10) : undefined,
                        codeEl.dataset.endLine ? parseInt(codeEl.dataset.endLine, 10) : undefined,
                    );
                    return;
                }
                const wikiEl = target.closest<HTMLElement>('.cm-wiki-link');
                if (wikiEl?.dataset.noteName && config.openNote) {
                    event.preventDefault();
                    event.stopPropagation();
                    const filePath = config.resolveNote?.(wikiEl.dataset.noteName);
                    if (filePath) config.openNote(filePath, wikiEl.dataset.section);
                    return;
                }
                return;
            }

            event.preventDefault();
            event.stopPropagation();

            switch (data.kind) {
                case 'pdf':
                    config.onOpenPdfRef?.(data.pdfPath, data.anchor);
                    break;
                case 'code':
                    config.onOpenCodeRef?.(data.codePath, data.startLine, data.endLine);
                    break;
                case 'wiki': {
                    const filePath = config.resolveNote?.(data.noteName);
                    if (filePath && config.openNote) {
                        config.openNote(filePath, data.section);
                    }
                    break;
                }
            }
        };
    });

    const styles = EditorView.baseTheme({
        // Wiki links — purple accent (Obsidian-style)
        '.cm-wiki-link': {
            cursor: 'pointer',
            textUnderlineOffset: '2px',
            padding: '0 2px',
            borderRadius: '2px',
        },
        '.cm-wiki-link-resolved': {
            color: 'var(--vscode-textLink-foreground, #7f6df2)',
            textDecoration: 'underline',
            textDecorationColor: 'var(--vscode-textLink-foreground, #7f6df2)',
        },
        '.cm-wiki-link-unresolved': {
            color: 'var(--vscode-disabledForeground, #888)',
            textDecoration: 'underline',
            textDecorationStyle: 'dashed',
            textDecorationColor: 'var(--vscode-disabledForeground, #888)',
            opacity: '0.7',
        },
        // Code links — blue
        '.cm-code-link': {
            cursor: 'pointer',
            color: 'var(--vscode-textLink-foreground, #3794ff)',
            textDecoration: 'underline',
            textDecorationColor: 'var(--vscode-textLink-foreground, #3794ff)',
            padding: '0 2px',
            borderRadius: '2px',
            textUnderlineOffset: '2px',
        },
        '.cm-code-link-icon': {
            fontSize: '0.85em',
            marginRight: '2px',
            opacity: '0.8',
        },
        // PDF links — Obsidian-style blue link
        '.cm-pdf-link': {
            cursor: 'pointer',
            color: 'var(--vscode-textLink-foreground, #3794ff)',
            textDecoration: 'underline',
            textDecorationColor: 'var(--vscode-textLink-foreground, #3794ff)',
            padding: '0 2px',
            borderRadius: '2px',
            textUnderlineOffset: '2px',
        },
        '.cm-pdf-link:hover': {
            opacity: '0.8',
        },
        // Line decoration for @pdf lines: prevent height jump when cursor enters
        // by keeping raw text on one line with ellipsis truncation.
        '.cm-pdf-link-line': {
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
        },
        '.cm-image-wiki': {
            display: 'inline-block',
            maxWidth: '100%',
            marginTop: '4px',
            marginBottom: '4px',
            verticalAlign: 'top',
        },
        '.cm-image-wiki-preview-below': {
            display: 'inline',
            marginLeft: '0',
        },
        '.cm-image-wiki-img': {
            display: 'block',
            maxWidth: '100%',
            maxHeight: '360px',
            borderRadius: '6px',
            border: '1px solid var(--vscode-editorWidget-border, #3c3c3c)',
            backgroundColor: 'var(--vscode-textCodeBlock-background, rgba(255,255,255,0.03))',
        },
        '.cm-image-wiki-fallback': {
            display: 'inline-block',
            fontSize: '0.9em',
            color: 'var(--vscode-descriptionForeground, #999)',
            fontStyle: 'italic',
            padding: '2px 6px',
            borderRadius: '4px',
            backgroundColor: 'var(--vscode-editor-background, rgba(255,255,255,0.03))',
        },
    });

    return [decorationPlugin, mousedownGuard, clickListener, styles];
}

// ─── Autocomplete ────────────────────────────────────────────────────────────

/**
 * Autocomplete source for wiki-links.
 * Triggers on [[ and provides note name completions.
 * After a note name and #, provides heading completions.
 */
export function wikiLinkCompletion(config: WikiLinkConfig) {
    return (context: CompletionContext): CompletionResult | null => {
        const line = context.state.doc.lineAt(context.pos);
        const textBefore = line.text.slice(0, context.pos - line.from);

        const wikiMatch = textBefore.match(/\[\[([^\]#|]*)(?:#([^\]|]*))?$/);
        if (!wikiMatch) return null;

        const noteName = wikiMatch[1] ?? '';
        const sectionPart = wikiMatch[2];

        // Heading completions after #
        if (sectionPart !== undefined) {
            const headings = config.getNoteHeadings?.(noteName.trim()) || [];
            if (headings.length === 0) return null;

            const hashPos = textBefore.lastIndexOf('#');
            const from = line.from + hashPos + 1;

            return {
                from,
                options: headings.map((heading) => ({
                    label: heading,
                    type: 'text',
                    detail: 'Section',
                    apply: heading,
                })),
            };
        }

        // Note name completions
        const noteNames = config.getNoteNames?.() || [];
        if (noteNames.length === 0) return null;

        const bracketPos = textBefore.lastIndexOf('[[');
        const from = line.from + bracketPos + 2;

        return {
            from,
            options: noteNames.map((name) => ({
                label: name,
                type: 'class',
                detail: 'Note',
                apply: `${name}]]`,
            })),
        };
    };
}
