import * as vscode from 'vscode';
import { execFileSync } from 'child_process';
import * as path from 'path';
import { log } from './logger';

/**
 * Resolves the git repository root for a workspace folder.
 * Falls back to the workspace folder itself when the folder is not a git repo.
 *
 * Results are cached per-folder for the lifetime of the extension.
 */
const cache = new Map<string, string>();

export function getGitRoot(folder?: vscode.Uri): string | undefined {
  const target = folder ?? pickUsableWorkspaceFolder();
  if (!target) return undefined;

  const key = target.fsPath;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  let root = target.fsPath;
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: target.fsPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (out) root = out;
    log.info(`gitRoot: target=${target.fsPath} → root=${root}`);
  } catch {
    log.info(`gitRoot: git rev-parse failed at ${target.fsPath}; using folder as-is`);
  }

  cache.set(key, root);
  return root;
}

/** Clear the git-root cache. Call when workspace folders change. */
export function invalidateGitRootCache(): void {
  cache.clear();
}

/**
 * Pick the first plausible workspace folder URI. VS Code occasionally returns
 * the app-bundle path as `workspaceFolders[0]` before the window is fully
 * settled; skip any folder that sits inside the VS Code installation itself.
 */
function pickUsableWorkspaceFolder(): vscode.Uri | undefined {
  const folders = vscode.workspace.workspaceFolders ?? [];
  for (const f of folders) {
    if (isUsableFolder(f.uri.fsPath)) return f.uri;
  }
  return folders[0]?.uri;
}

function isUsableFolder(fsPath: string): boolean {
  const lower = fsPath.toLowerCase();
  // Reject VS Code / Electron internal paths.
  if (lower.includes('visual studio code.app/contents/resources/app')) return false;
  if (lower.includes('electron.app/contents/resources/app')) return false;
  if (lower.includes('/codebuddy cn.app/contents/resources/app')) return false;
  if (lower.endsWith(`${path.sep}contents${path.sep}resources${path.sep}app`)) return false;
  return true;
}

