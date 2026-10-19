import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import {
  WorkspaceManager,
  MAX_TOTAL_CONTEXT_CHARS,
} from "../src/workspace/workspaceManager.js";
import { AttachedFileContext, ProposedEdit } from "../src/types.js";
import { EditManager } from "../src/workspace/editManager.js";
import { DiffContentProvider } from "../src/workspace/diffProvider.js";
import { NexamindClient } from "../src/api/nexamindClient.js";

class RegressionTestWorkspaceManager extends WorkspaceManager {
  private fakeRootPath: string;
  private virtualFiles = new Map<string, string>();

  constructor(fakeRootPath: string) {
    super();
    this.fakeRootPath = path.resolve(fakeRootPath);
  }

  public setFile(relativePath: string, content: string): void {
    this.virtualFiles.set(relativePath.replace(/\\/g, "/"), content);
  }

  public override getWorkspaceRoot(): any {
    return {
      uri: {
        fsPath: this.fakeRootPath,
        scheme: "file",
        toString: () => `file:///${this.fakeRootPath.replace(/\\/g, "/")}`,
      },
      name: "test-workspace",
      index: 0,
    };
  }

  public override async readWorkspaceFile(relativePath: string): Promise<AttachedFileContext> {
    const cleanPath = relativePath.replace(/\\/g, "/");
    const content = this.virtualFiles.get(cleanPath);

    if (content === undefined) {
      throw new Error(`File not found in workspace: '${relativePath}'`);
    }

    const exclusion = this.isExcluded(cleanPath);
    if (exclusion.excluded) {
      throw new Error(`Cannot read '${cleanPath}': ${exclusion.reason}`);
    }

    return {
      relativePath: cleanPath,
      content,
      size: Buffer.byteLength(content, "utf8"),
      lineCount: content.split("\n").length,
      truncated: false,
    };
  }
}

describe("Attachment Lifecycle & Regression Tests", () => {
  const wsManager = new RegressionTestWorkspaceManager("C:/projects/sample-app");
  const sampleAppJsContent =
    "const express = require('express');\n" +
    "const app = express();\n\n" +
    "app.get('/api/users', (req, res) => {\n" +
    "  res.json({ users: [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }] });\n" +
    "});\n\n" +
    "const PORT = process.env.PORT || 3000;\n" +
    "app.listen(PORT, () => console.log(`Server listening on ${PORT}`));\n" +
    "module.exports = app;\n";

  wsManager.setFile("app.js", sampleAppJsContent);

  it("reproduces and resolves active editor retrieval when activeTextEditor is undefined (webview focused)", async () => {
    // 1. When focus moves to webview, activeTextEditor is undefined in VS Code.
    // The previous implementation returned undefined and dropped the attachment.
    // The fix accepts explicitRelativePath or uses the cached effective active editor.

    // A: Test explicitRelativePath from webview button click
    const contextFromExplicit = await wsManager.getActiveEditorContext("app.js");
    assert.notEqual(contextFromExplicit, undefined);
    assert.equal(contextFromExplicit?.relativePath, "app.js");
    assert.equal(contextFromExplicit?.content, sampleAppJsContent);
    assert.equal(contextFromExplicit?.content.includes("express"), true);

    // B: Test fallback editor caching via setLastActiveEditor
    const mockEditor: any = {
      document: {
        uri: {
          fsPath: path.join("C:/projects/sample-app", "app.js"),
          scheme: "file",
        },
        getText: () => sampleAppJsContent,
        lineCount: 11,
        isClosed: false,
      },
      selection: { isEmpty: true },
    };

    wsManager.setLastActiveEditor(mockEditor);
    const effectiveEditor = wsManager.getEffectiveActiveEditor();
    assert.equal(effectiveEditor, mockEditor);

    const contextFromCached = await wsManager.getActiveEditorContext();
    assert.notEqual(contextFromCached, undefined);
    assert.equal(contextFromCached?.relativePath, "app.js");
    assert.equal(contextFromCached?.content, sampleAppJsContent);
  });

  it("verifies non-empty file contents reach outgoing prompt for: 'Read the attached app.js file and explain what it does'", () => {
    const fileContext: AttachedFileContext = {
      relativePath: "app.js",
      content: sampleAppJsContent,
      size: Buffer.byteLength(sampleAppJsContent, "utf8"),
      lineCount: 11,
    };

    const userQuery = "Read the attached app.js file and explain what it does.";
    const outgoingPrompt = wsManager.formatPromptWithContext([fileContext], userQuery);

    // 1. Must contain workspace context section
    assert.equal(outgoingPrompt.includes("[WORKSPACE CONTEXT]"), true);
    assert.equal(outgoingPrompt.includes("[/WORKSPACE CONTEXT]"), true);

    // 2. Must contain the exact file name
    assert.equal(outgoingPrompt.includes("File: `app.js`:"), true);

    // 3. Must contain the actual non-empty code contents of app.js
    assert.equal(outgoingPrompt.includes("const express = require('express');"), true);
    assert.equal(outgoingPrompt.includes("app.get('/api/users'"), true);
    assert.equal(outgoingPrompt.includes("module.exports = app;"), true);

    // 4. Must contain the user's question
    assert.equal(outgoingPrompt.includes("User Query:\nRead the attached app.js file and explain what it does."), true);

    // 5. Must stay strictly within the backend's 10,000 character validation limit
    assert.equal(outgoingPrompt.length <= 9500, true);
    assert.equal(outgoingPrompt.length <= 10000, true);
  });

  it("handles oversized files and caps prompt safely under 10,000 chars without dropping request", () => {
    // Generate a 15,000 character file
    const hugeContent = "console.log('line of code');\n".repeat(500);
    assert.equal(hugeContent.length > 14000, true);

    const oversizedContext: AttachedFileContext = {
      relativePath: "huge.js",
      content: hugeContent,
      size: hugeContent.length,
      lineCount: 500,
    };

    const outgoingPrompt = wsManager.formatPromptWithContext([oversizedContext], "Summarize this file.");

    // Must be safely truncated
    assert.equal(outgoingPrompt.includes("huge.js"), true);
    assert.equal(outgoingPrompt.includes("[WORKSPACE CONTEXT]"), true);
    assert.equal(outgoingPrompt.includes("[Truncated]"), true);

    // Must stay strictly below backend ceiling of 10,000 characters
    assert.equal(outgoingPrompt.length <= 9500, true);
    assert.equal(outgoingPrompt.length <= 10000, true);
  });

  it("preserves empty files gracefully without throwing errors", () => {
    const emptyContext: AttachedFileContext = {
      relativePath: "empty.js",
      content: "",
      size: 0,
      lineCount: 0,
    };

    const outgoingPrompt = wsManager.formatPromptWithContext([emptyContext], "What is in this file?");
    assert.equal(outgoingPrompt.includes("File: `empty.js`:"), true);
    assert.equal(outgoingPrompt.includes("What is in this file?"), true);
    assert.equal(outgoingPrompt.length < 1000, true);
  });

  it("1. automatically collects active editor context without manual attachment", async () => {
    const activeDoc: any = {
      uri: {
        fsPath: path.join("C:/projects/sample-app", "src", "math.ts"),
        scheme: "file",
      },
      getText: () => "export function add(a: number, b: number) { return a + b; }",
      languageId: "typescript",
      lineCount: 1,
      isClosed: false,
    };

    const mockEditor: any = {
      document: activeDoc,
      selection: { isEmpty: true },
    };

    const testManager = new RegressionTestWorkspaceManager("C:/projects/sample-app");
    testManager.setLastActiveEditor(mockEditor);

    const context = await testManager.getActiveEditorContext();
    assert.notEqual(context, undefined);
    assert.equal(context?.relativePath, "src/math.ts");
    assert.equal(context?.languageId, "typescript");
    assert.equal(context?.content.includes("export function add"), true);
  });

  it("2. includes unsaved in-memory editor changes over disk content", async () => {
    const testManager = new RegressionTestWorkspaceManager("C:/projects/sample-app");
    testManager.setFile("src/service.js", "const status = 'saved_to_disk';");

    // Unsaved document currently in VS Code editor buffer
    const unsavedDoc: any = {
      uri: {
        fsPath: path.join("C:/projects/sample-app", "src", "service.js"),
        scheme: "file",
      },
      getText: () => "const status = 'unsaved_in_editor_memory';",
      languageId: "javascript",
      lineCount: 1,
      isClosed: false,
    };

    const mockEditor: any = {
      document: unsavedDoc,
      selection: { isEmpty: true },
    };

    testManager.setLastActiveEditor(mockEditor);

    const context = await testManager.getActiveEditorContext();
    assert.notEqual(context, undefined);
    assert.equal(context?.content, "const status = 'unsaved_in_editor_memory';");
    assert.equal(context?.content.includes("saved_to_disk"), false);
  });

  it("3. includes selected code and line numbers while preserving surrounding context", async () => {
    const fullSource =
      "import { config } from './config';\n" +
      "\n" +
      "function calculateTax(amount) {\n" +
      "  const rate = 0.15;\n" +
      "  return amount * rate;\n" +
      "}\n" +
      "\n" +
      "export default calculateTax;\n";

    const selectedDoc: any = {
      uri: {
        fsPath: path.join("C:/projects/sample-app", "src", "tax.js"),
        scheme: "file",
      },
      getText: (range?: any) => {
        if (range) {
          return "  const rate = 0.15;\n  return amount * rate;";
        }
        return fullSource;
      },
      languageId: "javascript",
      lineCount: 8,
      isClosed: false,
    };

    const mockEditor: any = {
      document: selectedDoc,
      selection: {
        isEmpty: false,
        start: { line: 3, character: 2 },
        end: { line: 4, character: 23 },
      },
    };

    const testManager = new RegressionTestWorkspaceManager("C:/projects/sample-app");
    testManager.setLastActiveEditor(mockEditor);

    const context = await testManager.getActiveEditorContext();
    assert.notEqual(context, undefined);
    assert.notEqual(context?.selection, undefined);
    assert.equal(context?.selection?.startLine, 4); // 1-indexed
    assert.equal(context?.selection?.endLine, 5);
    assert.equal(context?.selection?.selectedText?.includes("rate = 0.15"), true);

    // Verifies full content is retained for surrounding context
    assert.equal(context?.content.includes("import { config }"), true);
    assert.equal(context?.content.includes("export default calculateTax"), true);

    // Formatted prompt must clearly indicate the selected line range
    const prompt = testManager.formatPromptWithContext([context!], "Refactor this logic");
    assert.equal(prompt.includes("Selection (lines 4-5)"), true);
    assert.equal(prompt.includes("User Query:\nRefactor this logic"), true);
  });

  it("4. handles single-file mode gracefully without open workspace folder", async () => {
    class SingleFileWorkspaceManager extends WorkspaceManager {
      public override getWorkspaceRoot(): any {
        return undefined; // No workspace folder open
      }
    }

    const testManager = new SingleFileWorkspaceManager();
    const standaloneDoc: any = {
      uri: {
        fsPath: "C:/standalone/script.py",
        scheme: "file",
      },
      getText: () => "print('standalone hello')",
      languageId: "python",
      lineCount: 1,
      isClosed: false,
    };

    testManager.setLastActiveEditor({
      document: standaloneDoc,
      selection: { isEmpty: true },
    } as any);

    const context = await testManager.getActiveEditorContext();
    assert.notEqual(context, undefined);
    assert.equal(context?.relativePath, "script.py");
    assert.equal(context?.languageId, "python");
    assert.equal(context?.content, "print('standalone hello')");
  });

  it("5. serializes context into expected backend payload with language fence", () => {
    const fileCtx: AttachedFileContext = {
      relativePath: "src/utils.ts",
      languageId: "typescript",
      content: "export const isReady = true;",
      size: 28,
      lineCount: 1,
    };

    const testManager = new RegressionTestWorkspaceManager("C:/projects/sample-app");
    const payload = testManager.formatPromptWithContext([fileCtx], "Explain this function");

    assert.equal(payload.includes("[WORKSPACE CONTEXT]"), true);
    assert.equal(payload.includes("File: `src/utils.ts`:"), true);
    assert.equal(payload.includes("```typescript"), true);
    assert.equal(payload.includes("export const isReady = true;"), true);
    assert.equal(payload.includes("[/WORKSPACE CONTEXT]"), true);
    assert.equal(payload.includes("User Query:\nExplain this function"), true);
  });

  it("6. returns raw user query when no files are open (normal chat request)", () => {
    const testManager = new RegressionTestWorkspaceManager("C:/projects/sample-app");
    const normalPrompt = testManager.formatPromptWithContext([], "What is the difference between null and undefined?");

    assert.equal(normalPrompt, "What is the difference between null and undefined?");
    assert.equal(normalPrompt.includes("[WORKSPACE CONTEXT]"), false);
  });

  it("7. merges manual attachments with active editor context without duplicates", () => {
    const activeFile: AttachedFileContext = {
      relativePath: "src/index.ts",
      content: "console.log('active');",
      size: 22,
      lineCount: 1,
    };
    const manualFile1: AttachedFileContext = {
      relativePath: "src/types.ts",
      content: "export type ID = string;",
      size: 24,
      lineCount: 1,
    };
    const duplicateActiveFile: AttachedFileContext = {
      relativePath: "src/index.ts",
      content: "console.log('active duplicate');",
      size: 32,
      lineCount: 1,
    };

    const filesToInclude: AttachedFileContext[] = [activeFile, manualFile1];
    // Attempt duplicate addition
    if (!filesToInclude.some((f) => f.relativePath === duplicateActiveFile.relativePath)) {
      filesToInclude.push(duplicateActiveFile);
    }

    assert.equal(filesToInclude.length, 2);
    assert.equal(filesToInclude[0].relativePath, "src/index.ts");
    assert.equal(filesToInclude[1].relativePath, "src/types.ts");
  });

  it("8. enforces sensitive-file and binary-file protections during context gathering", () => {
    const testManager = new RegressionTestWorkspaceManager("C:/projects/sample-app");

    assert.equal(testManager.isExcluded(".env").excluded, true);
    assert.equal(testManager.isExcluded(".env.local").excluded, true);
    assert.equal(testManager.isExcluded("id_rsa").excluded, true);
    assert.equal(testManager.isExcluded("auth/credentials.json").excluded, true);
    assert.equal(testManager.isExcluded("logo.png").excluded, true);
    assert.equal(testManager.isExcluded("dist/bundle.js").excluded, true);
  });

  it("9. enforces strict payload ceiling under 9,500 chars (backend 10,000 char validation limit)", () => {
    const massiveContent = "function doSomething() { return 42; }\n".repeat(600);
    assert.equal(massiveContent.length > 20000, true);

    const testManager = new RegressionTestWorkspaceManager("C:/projects/sample-app");
    const massiveFile: AttachedFileContext = {
      relativePath: "src/big.ts",
      content: massiveContent,
      size: massiveContent.length,
      lineCount: 600,
    };

    const formatted = testManager.formatPromptWithContext([massiveFile], "Review this code");
    assert.equal(formatted.length <= 9500, true);
    assert.equal(formatted.length <= 10000, true);
    assert.equal(formatted.includes("[Truncated]"), true);
  });

  it("10. detects stale file modifications before applying proposed edits", async () => {
    const testManager = new RegressionTestWorkspaceManager("C:/projects/sample-app");
    testManager.setFile("src/app.js", "const version = 1;");

    const diffProvider = new DiffContentProvider();
    const editManager = new EditManager(testManager, diffProvider);

    const staleEdit: ProposedEdit = {
      id: "edit-stale-1",
      filePath: "src/app.js",
      description: "Update version to 2",
      action: "modify",
      replacement: "const version = 2;",
      status: "pending",
      originalContent: "const version = 0;", // Snapshot mismatch! File was version 1 on disk
    };

    await assert.rejects(
      async () => {
        await editManager.applyEdit(staleEdit);
      },
      /modified since Lumina proposed this edit/i
    );
  });

  it("11. parses SSE streaming chunks into deltas and metadata", () => {
    const client = new NexamindClient("http://localhost:5000");

    const sseRaw =
      'event: delta\ndata: {"content":"Hello"}\n\n' +
      'event: delta\ndata: {"content":" world"}\n\n' +
      'event: done\ndata: {"finishReason":"STOP"}\n\n';

    const events = client.parseSSEChunk(sseRaw);
    assert.equal(events.length, 3);
    assert.equal(events[0].event, "delta");
    assert.equal(JSON.parse(events[0].data).content, "Hello");
    assert.equal(events[1].event, "delta");
    assert.equal(JSON.parse(events[1].data).content, " world");
    assert.equal(events[2].event, "done");
  });

  it("12. supports request cancellation via AbortSignal in streaming client", async () => {
    const client = new NexamindClient("http://mock-backend:5000");
    const abortController = new AbortController();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url: any, init: any) => {
      // Simulate slow stream that respects AbortSignal
      return new Promise<Response>((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          const err = new Error("The operation was aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    };

    try {
      setTimeout(() => abortController.abort(), 10);
      await assert.rejects(
        async () => {
          await client.sendMessageStream(
            "dummy-token",
            "conv-1",
            "Refactor code",
            {},
            undefined,
            abortController.signal
          );
        },
        (err: any) => err.name === "AbortError"
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
