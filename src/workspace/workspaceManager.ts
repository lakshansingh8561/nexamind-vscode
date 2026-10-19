import * as vscode from "vscode";
import * as path from "node:path";
import { AttachedFileContext } from "../types.js";

export const EXCLUDED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "dist-test",
  "dist-tsc",
  "build",
  "out",
  ".next",
  ".vscode",
  ".idea",
  "coverage",
  ".cache",
]);

export const SENSITIVE_FILE_PATTERNS = [
  /^\.env(\..+)?$/i,
  /id_rsa/i,
  /id_ed25519/i,
  /\.pem$/i,
  /\.key$/i,
  /\.pfx$/i,
  /\.p12$/i,
  /credentials/i,
  /secret/i,
  /\.token$/i,
  /\.keystore$/i,
];

export const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".pdf",
  ".zip",
  ".tar",
  ".gz",
  ".vsix",
  ".exe",
  ".dll",
  ".bin",
  ".so",
  ".dylib",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
]);

export const MAX_FILE_BYTES = 50 * 1024; // 50 KB
export const MAX_CONTEXT_CHARS_PER_FILE = 5000;
export const MAX_TOTAL_CONTEXT_CHARS = 7500;

export class WorkspaceManager {
  private lastActiveEditor?: vscode.TextEditor;

  /**
   * Returns the primary workspace folder URI or undefined if no folder is open.
   */
  public getWorkspaceRoot(): vscode.WorkspaceFolder | undefined {
    const folders = vscode.workspace.workspaceFolders;
    return folders && folders.length > 0 ? folders[0] : undefined;
  }

  /**
   * Detects programming language identifier from file extension when document object is unavailable.
   */
  public detectLanguageFromExt(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    switch (ext) {
      case ".ts":
        return "typescript";
      case ".tsx":
        return "typescriptreact";
      case ".js":
      case ".mjs":
      case ".cjs":
        return "javascript";
      case ".jsx":
        return "javascriptreact";
      case ".py":
        return "python";
      case ".json":
        return "json";
      case ".html":
      case ".htm":
        return "html";
      case ".css":
        return "css";
      case ".scss":
        return "scss";
      case ".md":
        return "markdown";
      case ".rs":
        return "rust";
      case ".go":
        return "go";
      case ".java":
        return "java";
      case ".c":
        return "c";
      case ".cpp":
      case ".h":
      case ".hpp":
        return "cpp";
      case ".sh":
      case ".bash":
        return "shellscript";
      case ".yml":
      case ".yaml":
        return "yaml";
      case ".sql":
        return "sql";
      default:
        return "plaintext";
    }
  }

  /**
   * Checks if a path is excluded (sensitive, ignored directory, or binary).
   */
  public isExcluded(filePath: string): { excluded: boolean; reason?: string } {
    const normalized = filePath.replace(/\\/g, "/").trim();
    const parts = normalized.split("/");
    const basename = parts[parts.length - 1];

    // 1. Directory exclusion check
    for (const part of parts.slice(0, -1)) {
      if (EXCLUDED_DIRS.has(part)) {
        return { excluded: true, reason: `Directory '${part}' is excluded.` };
      }
    }

    // 2. Sensitive file pattern check
    for (const pattern of SENSITIVE_FILE_PATTERNS) {
      if (pattern.test(basename)) {
        return { excluded: true, reason: `File '${basename}' matches sensitive/credential pattern.` };
      }
    }

    // 3. Binary file check
    const ext = path.extname(basename).toLowerCase();
    if (BINARY_EXTENSIONS.has(ext)) {
      return { excluded: true, reason: `Binary files with extension '${ext}' are excluded.` };
    }

    return { excluded: false };
  }

  /**
   * Validates and safely resolves a relative workspace path to an absolute Uri.
   * Prevents path traversal and supports both workspace folder and single-file modes.
   */
  public resolveWorkspacePath(relativePath: string): vscode.Uri {
    const trimmed = relativePath.trim();
    if (!trimmed) {
      throw new Error("File path cannot be empty.");
    }

    const root = this.getWorkspaceRoot();

    // Single-file or standalone mode: resolve relative to open document or accept valid absolute paths
    if (!root) {
      if (path.isAbsolute(trimmed) || /^[a-zA-Z]:[/\\]/.test(trimmed)) {
        return vscode.Uri.file(trimmed);
      }
      const activeDoc = this.getEffectiveActiveDocument();
      if (activeDoc) {
        const baseDir = path.dirname(activeDoc.uri.fsPath);
        return vscode.Uri.file(path.join(baseDir, trimmed));
      }
      throw new Error("No active workspace folder or open document in VS Code.");
    }

    // Workspace mode: Reject absolute paths outside root
    if (path.isAbsolute(trimmed) || /^[a-zA-Z]:[/\\]/.test(trimmed)) {
      const rootPath = root.uri.fsPath.replace(/\\/g, "/").toLowerCase();
      const targetPath = path.resolve(trimmed).replace(/\\/g, "/").toLowerCase();

      if (!targetPath.startsWith(rootPath)) {
        throw new Error(`Target path '${trimmed}' is outside active workspace folder.`);
      }

      return vscode.Uri.file(trimmed);
    }

    // Normalize and check for directory traversal
    const normalized = path.normalize(trimmed).replace(/^(\.\.[/\\])+/, "");
    if (trimmed.startsWith("..") || normalized.startsWith("..")) {
      throw new Error(`Path traversal rejected: '${relativePath}' escapes the workspace.`);
    }

    const resolvedFsPath = path.join(root.uri.fsPath, normalized);
    const resolvedUri = vscode.Uri.file(resolvedFsPath);

    // Verify final resolved path remains strictly within workspace root
    const rootFsNormalized = root.uri.fsPath.replace(/\\/g, "/").toLowerCase();
    const finalFsNormalized = resolvedUri.fsPath.replace(/\\/g, "/").toLowerCase();

    if (!finalFsNormalized.startsWith(rootFsNormalized)) {
      throw new Error(`Resolved path '${relativePath}' is outside active workspace folder.`);
    }

    return resolvedUri;
  }

  /**
   * Reads a workspace file, prioritizing in-memory unsaved editor buffers over disk
   * and enforcing size and exclusion boundaries.
   */
  public async readWorkspaceFile(relativePath: string): Promise<AttachedFileContext> {
    const exclusionCheck = this.isExcluded(relativePath);
    if (exclusionCheck.excluded) {
      throw new Error(`Cannot read '${relativePath}': ${exclusionCheck.reason}`);
    }

    const uri = this.resolveWorkspacePath(relativePath);
    const normTargetFsPath = uri.fsPath.replace(/\\/g, "/").toLowerCase();

    // Check if file is open in memory to capture live unsaved edits
    const openDoc = vscode.workspace.textDocuments?.find(
      (d) => d.uri.fsPath.replace(/\\/g, "/").toLowerCase() === normTargetFsPath && !d.isClosed
    );

    let content: string;
    let fileSize: number;
    let languageId: string | undefined;

    if (openDoc) {
      content = openDoc.getText();
      fileSize = Buffer.byteLength(content, "utf8");
      languageId = openDoc.languageId;
    } else {
      let stat: vscode.FileStat;
      try {
        stat = await vscode.workspace.fs.stat(uri);
      } catch {
        throw new Error(`File not found in workspace: '${relativePath}'`);
      }

      if (stat.type === vscode.FileType.Directory) {
        throw new Error(`Cannot read directory '${relativePath}' as a file.`);
      }

      if (stat.size > MAX_FILE_BYTES) {
        throw new Error(
          `File '${relativePath}' (${Math.round(stat.size / 1024)} KB) exceeds maximum allowed size of ${Math.round(
            MAX_FILE_BYTES / 1024
          )} KB.`
        );
      }

      const fileBytes = await vscode.workspace.fs.readFile(uri);
      const decoder = new TextDecoder("utf-8");
      content = decoder.decode(fileBytes);
      fileSize = stat.size;
      languageId = this.detectLanguageFromExt(relativePath);
    }

    if (fileSize > MAX_FILE_BYTES) {
      throw new Error(
        `File '${relativePath}' (${Math.round(fileSize / 1024)} KB) exceeds maximum allowed size of ${Math.round(
          MAX_FILE_BYTES / 1024
        )} KB.`
      );
    }

    let truncated = false;
    if (content.length > MAX_CONTEXT_CHARS_PER_FILE) {
      content = content.slice(0, MAX_CONTEXT_CHARS_PER_FILE) + "\n\n// [Truncated: File content exceeded context budget]";
      truncated = true;
    }

    const lineCount = content.split("\n").length;

    return {
      relativePath: this.getRelativePath(uri),
      content,
      size: fileSize,
      lineCount,
      languageId,
      truncated,
    };
  }

  /**
   * Caches the most recently focused text editor so context is not lost when webview gains focus.
   */
  public setLastActiveEditor(editor?: vscode.TextEditor): void {
    if (editor && editor.document && editor.document.uri.scheme === "file") {
      this.lastActiveEditor = editor;
    }
  }

  /**
   * Resolves the active text editor even if the webview or sidebar currently holds focus.
   */
  public getEffectiveActiveEditor(): vscode.TextEditor | undefined {
    // 1. Directly focused text editor
    if (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri.scheme === "file") {
      this.lastActiveEditor = vscode.window.activeTextEditor;
      return vscode.window.activeTextEditor;
    }

    // 2. Previously cached active editor (if not closed)
    if (this.lastActiveEditor && !this.lastActiveEditor.document.isClosed) {
      return this.lastActiveEditor;
    }

    // 3. First visible text editor in the editor pane
    const visible = vscode.window.visibleTextEditors?.find(
      (e) => e.document.uri.scheme === "file" && !e.document.isClosed
    );
    if (visible) {
      this.lastActiveEditor = visible;
      return visible;
    }

    // 4. Any open text document in workspace
    const openDoc = vscode.workspace.textDocuments?.find(
      (d) => d.uri.scheme === "file" && !d.isClosed
    );
    if (openDoc) {
      const matchEditor = vscode.window.visibleTextEditors?.find((e) => e.document === openDoc);
      if (matchEditor) {
        this.lastActiveEditor = matchEditor;
        return matchEditor;
      }
    }

    return undefined;
  }

  /**
   * Resolves the active document even when no TextEditor wrapper is actively attached.
   */
  public getEffectiveActiveDocument(): vscode.TextDocument | undefined {
    const editor = this.getEffectiveActiveEditor();
    if (editor && editor.document && editor.document.uri.scheme === "file" && !editor.document.isClosed) {
      return editor.document;
    }

    const openDoc = vscode.workspace.textDocuments?.find(
      (d) => d.uri.scheme === "file" && !d.isClosed
    );
    return openDoc;
  }

  /**
   * Reads context from the currently active text editor if open.
   * Automatically captures live in-memory changes, selection with surrounding context, and language ID.
   */
  public async getActiveEditorContext(explicitRelativePath?: string): Promise<AttachedFileContext | undefined> {
    // If an explicit relative path was provided (e.g. from button click), read it directly
    if (explicitRelativePath && explicitRelativePath.trim()) {
      try {
        return await this.readWorkspaceFile(explicitRelativePath.trim());
      } catch {
        // Fall back to editor discovery
      }
    }

    const editor = this.getEffectiveActiveEditor();
    const doc = editor?.document || this.getEffectiveActiveDocument();
    if (!doc) return undefined;

    const uri = doc.uri;
    if (uri.scheme !== "file") return undefined;

    const relativePath = this.getRelativePath(uri);
    const exclusionCheck = this.isExcluded(relativePath);
    if (exclusionCheck.excluded) {
      return undefined;
    }

    const selection = editor?.selection;
    let selectionData: { startLine: number; endLine: number; selectedText?: string } | undefined;

    if (selection && !selection.isEmpty) {
      const selectedText = doc.getText(selection);
      selectionData = {
        startLine: selection.start.line + 1,
        endLine: selection.end.line + 1,
        selectedText,
      };
    }

    // Always capture the full document text to retain surrounding context (imports, types, functions)
    let content = doc.getText();
    let truncated = false;
    if (content.length > MAX_CONTEXT_CHARS_PER_FILE) {
      content = content.slice(0, MAX_CONTEXT_CHARS_PER_FILE) + "\n\n// [Truncated: Content exceeded context budget]";
      truncated = true;
    }

    return {
      relativePath,
      content,
      size: Buffer.byteLength(content, "utf8"),
      lineCount: doc.lineCount,
      languageId: doc.languageId || this.detectLanguageFromExt(relativePath),
      selection: selectionData,
      truncated,
    };
  }

  /**
   * Automatically finds additional relevant workspace files:
   * 1. Visible open editors in split panes.
   * 2. Files explicitly referenced by name in user query (e.g. "look at config.ts").
   */
  public async getRelevantWorkspaceFiles(
    arg1?: string | string[],
    arg2?: string | string[]
  ): Promise<AttachedFileContext[]> {
    const additionalFiles: AttachedFileContext[] = [];
    const seenPaths = new Set<string>();

    let userQuery: string | undefined;
    let excludedPaths: string[] = [];

    if (Array.isArray(arg1)) {
      excludedPaths = arg1;
      if (typeof arg2 === "string") userQuery = arg2;
    } else if (Array.isArray(arg2)) {
      if (typeof arg1 === "string") userQuery = arg1;
      excludedPaths = arg2;
    } else {
      if (typeof arg1 === "string" && arg1.trim()) {
        if (arg1.includes(".") || arg1.includes("/") || arg1.includes("\\")) {
          excludedPaths = [arg1];
          userQuery = typeof arg2 === "string" ? arg2 : undefined;
        } else {
          userQuery = arg1;
          if (typeof arg2 === "string" && arg2.trim()) {
            excludedPaths = [arg2];
          }
        }
      }
    }

    for (const p of excludedPaths) {
      if (p) seenPaths.add(p.toLowerCase());
    }

    // 1. Check other visible editors in split panes
    const visibleEditors = vscode.window.visibleTextEditors || [];
    for (const editor of visibleEditors) {
      if (additionalFiles.length >= 2) break; // Limit secondary files to preserve character budget
      if (editor.document.uri.scheme !== "file" || editor.document.isClosed) continue;

      const relPath = this.getRelativePath(editor.document.uri);
      const normRel = relPath.toLowerCase();

      if (seenPaths.has(normRel)) continue;
      if (this.isExcluded(relPath).excluded) continue;

      try {
        const fileCtx = await this.readWorkspaceFile(relPath);
        additionalFiles.push(fileCtx);
        seenPaths.add(normRel);
      } catch {}
    }

    // 2. Scan user query for mentioned workspace filenames (e.g. "check app.js", "in server.ts")
    if (userQuery && additionalFiles.length < 3) {
      const fileMentionRegex = /\b([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]{1,8})\b/g;
      let match: RegExpExecArray | null;

      while ((match = fileMentionRegex.exec(userQuery)) !== null) {
        if (additionalFiles.length >= 3) break;
        const candidate = match[1].trim().replace(/^[./\\]+/, "");
        const normCandidate = candidate.toLowerCase();

        if (seenPaths.has(normCandidate)) continue;
        if (this.isExcluded(candidate).excluded) continue;

        try {
          const fileCtx = await this.readWorkspaceFile(candidate);
          additionalFiles.push(fileCtx);
          seenPaths.add(normCandidate);
        } catch {
          // File not present in workspace
        }
      }
    }

    return additionalFiles;
  }

  /**
   * Converts an absolute Uri into a clean relative path matching the workspace root.
   */
  public getRelativePath(uri: vscode.Uri): string {
    const root = this.getWorkspaceRoot();
    if (!root) return path.basename(uri.fsPath);

    return path.relative(root.uri.fsPath, uri.fsPath).replace(/\\/g, "/");
  }

  /**
   * Formats attached workspace files and user message into an augmented prompt
   * that stays strictly within the backend's 10,000 character maximum length limit.
   */
  public formatPromptWithContext(files: AttachedFileContext[], userPrompt: string): string {
    if (!files || files.length === 0) {
      return userPrompt.trim();
    }

    let contextSection = "[WORKSPACE CONTEXT]\n";
    let remainingBudget = MAX_TOTAL_CONTEXT_CHARS;

    for (const file of files) {
      const lang = file.languageId || this.detectLanguageFromExt(file.relativePath);
      const fileHeader = `File: \`${file.relativePath}\`: (Language: ${lang}, Lines: 1-${file.lineCount || 1})\n`;

      let selectionBlock = "";
      if (file.selection && file.selection.selectedText) {
        selectionBlock =
          `[Active Selection (lines ${file.selection.startLine}-${file.selection.endLine})]:\n` +
          "```" +
          lang +
          "\n" +
          file.selection.selectedText.trim() +
          "\n```\n\n" +
          "[Full Code Context]:\n";
      }

      const codeBlockStart = "```" + lang + "\n";
      const codeBlockEnd = "\n```\n\n";
      const overhead = fileHeader.length + selectionBlock.length + codeBlockStart.length + codeBlockEnd.length;

      if (remainingBudget <= overhead + 50) {
        contextSection += `File: \`${file.relativePath}\` (Omitted: context budget reached)\n\n`;
        continue;
      }

      const availableChars = remainingBudget - overhead;
      const fileContent =
        file.content.length > availableChars
          ? file.content.slice(0, availableChars) + "\n// [Truncated]"
          : file.content;

      contextSection += `${fileHeader}${selectionBlock}${codeBlockStart}${fileContent}${codeBlockEnd}`;
      remainingBudget -= fileHeader.length + selectionBlock.length + codeBlockStart.length + fileContent.length + codeBlockEnd.length;
    }

    contextSection += "[/WORKSPACE CONTEXT]\n\n";

    const instructions =
      "Instructions: You are acting as an expert VS Code coding assistant with direct access to the user's workspace files and active editor.\n" +
      "- Use the supplied file contents, active selection, and line numbers to answer questions, explain functions, debug bugs, or refactor code.\n" +
      "- If you propose code modifications, you MUST provide a structured edit block matching this exact JSON format so the extension can show a native VS Code diff:\n" +
      "```nexamind-edit\n" +
      "{\n" +
      '  "filePath": "relative/path/to/file.ext",\n' +
      '  "description": "Short explanation of proposed changes",\n' +
      '  "action": "modify",\n' +
      '  "replacement": "Full updated code content for the file"\n' +
      "}\n" +
      "```\n" +
      "- If no code changes are requested, answer directly.\n\n";

    const combined = `${contextSection}${instructions}User Query:\n${userPrompt.trim()}`;

    // Hard ceiling guarantee (backend limit is 10,000 chars)
    if (combined.length > 9500) {
      return combined.slice(0, 9450) + "\n\n[Warning: Prompt was trimmed to stay within backend limit]";
    }

    return combined;
  }
}
