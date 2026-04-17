import * as vscode from 'vscode';
import * as path from 'path';
import { Annotation, AnnotationStore } from './shared/types';

/**
 * Manages annotation storage as sidecar JSON files.
 * For a file `papers/attention.pdf`, annotations are stored in
 * `papers/attention.pdf.paperlink.json`.
 */
export class AnnotationService {
  private cache = new Map<string, AnnotationStore>();

  /** Get the sidecar file URI for a given PDF */
  private getSidecarUri(pdfUri: vscode.Uri): vscode.Uri {
    return vscode.Uri.file(pdfUri.fsPath + '.paperlink.json');
  }

  /** Load annotations for a PDF file */
  async getAnnotationsForPdf(pdfUri: vscode.Uri): Promise<Annotation[]> {
    const key = pdfUri.toString();

    // Check cache
    if (this.cache.has(key)) {
      return this.cache.get(key)!.annotations;
    }

    const sidecarUri = this.getSidecarUri(pdfUri);
    try {
      const data = await vscode.workspace.fs.readFile(sidecarUri);
      const store: AnnotationStore = JSON.parse(Buffer.from(data).toString('utf-8'));
      this.cache.set(key, store);
      return store.annotations;
    } catch {
      // No sidecar file yet — return empty
      return [];
    }
  }

  /** Add an annotation for a PDF */
  async addAnnotation(pdfUri: vscode.Uri, annotation: Annotation): Promise<void> {
    const key = pdfUri.toString();
    let store = this.cache.get(key);

    if (!store) {
      store = {
        version: 1,
        pdfFile: path.basename(pdfUri.fsPath),
        annotations: [],
      };
    }

    // Check for duplicate (same anchor)
    const existing = store.annotations.find(
      (a) =>
        a.anchor.page === annotation.anchor.page &&
        a.anchor.textItemIndex === annotation.anchor.textItemIndex &&
        a.anchor.charOffset === annotation.anchor.charOffset
    );
    if (existing) {
      // Update existing
      Object.assign(existing, annotation);
    } else {
      store.annotations.push(annotation);
    }

    this.cache.set(key, store);
    await this.save(pdfUri, store);
  }

  /** Remove an annotation */
  async removeAnnotation(pdfUri: vscode.Uri, annotationId: string): Promise<void> {
    const key = pdfUri.toString();
    const store = this.cache.get(key);
    if (!store) return;

    store.annotations = store.annotations.filter((a) => a.id !== annotationId);
    this.cache.set(key, store);
    await this.save(pdfUri, store);
  }

  /** Find all annotations that link to a specific markdown file */
  async findAnnotationsForMarkdown(
    markdownRelativePath: string
  ): Promise<{ pdfUri: vscode.Uri; annotation: Annotation }[]> {
    const results: { pdfUri: vscode.Uri; annotation: Annotation }[] = [];

    // Search all .paperlink.json files in the workspace
    const files = await vscode.workspace.findFiles('**/*.paperlink.json', '**/node_modules/**');

    for (const file of files) {
      try {
        const data = await vscode.workspace.fs.readFile(file);
        const store: AnnotationStore = JSON.parse(Buffer.from(data).toString('utf-8'));
        const pdfPath = file.fsPath.replace('.paperlink.json', '');
        const pdfUri = vscode.Uri.file(pdfPath);

        for (const annotation of store.annotations) {
          if (annotation.markdownFile === markdownRelativePath) {
            results.push({ pdfUri, annotation });
          }
        }
      } catch {
        // Skip corrupted files
      }
    }

    return results;
  }

  /** Invalidate cache for a PDF */
  invalidate(pdfUri: vscode.Uri): void {
    this.cache.delete(pdfUri.toString());
  }

  private async save(pdfUri: vscode.Uri, store: AnnotationStore): Promise<void> {
    const sidecarUri = this.getSidecarUri(pdfUri);
    const json = JSON.stringify(store, null, 2);
    await vscode.workspace.fs.writeFile(sidecarUri, Buffer.from(json, 'utf-8'));
  }
}
