/**
 * Script injected into VS Code's markdown preview.
 * Intercepts clicks on @pdf[[...]] links and tells the extension host to open the PDF.
 */

(function () {
  document.addEventListener('click', (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    const link = target.closest('a.paperlink-pdf-link') as HTMLAnchorElement | null;
    if (!link) return;

    e.preventDefault();
    e.stopPropagation();

    const pdfPath = link.dataset.pdfPath;
    const anchor = link.dataset.pdfAnchor;
    if (!pdfPath || !anchor) return;

    // Use VS Code's command URI scheme to trigger our command
    // The markdown preview can post messages to the extension via this pattern
    const href = `command:paperlink.openPdfAtAnchor?${encodeURIComponent(
      JSON.stringify({ pdfPath, anchor })
    )}`;
    window.open(href);
  });
})();
