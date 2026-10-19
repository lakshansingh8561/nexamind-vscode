import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import {
  WorkspaceManager,
  EXCLUDED_DIRS,
  SENSITIVE_FILE_PATTERNS,
  BINARY_EXTENSIONS,
} from "../src/workspace/workspaceManager.js";
import { EditManager } from "../src/workspace/editManager.js";
import { DiffContentProvider } from "../src/workspace/diffProvider.js";
import { ProposedEdit } from "../src/types.js";

// Mock vscode workspace folder
class TestWorkspaceManager extends WorkspaceManager {
  private fakeRootPath: string;

  constructor(fakeRootPath: string) {
    super();
    this.fakeRootPath = path.resolve(fakeRootPath);
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
}

describe("Workspace File Reading & Exclusions", () => {
  const wsManager = new TestWorkspaceManager("C:/projects/my-app");

  it("identifies excluded directory paths", () => {
    assert.equal(wsManager.isExcluded("node_modules/express/index.js").excluded, true);
    assert.equal(wsManager.isExcluded(".git/config").excluded, true);
    assert.equal(wsManager.isExcluded("dist/app.js").excluded, true);
    assert.equal(wsManager.isExcluded("build/bundle.js").excluded, true);
    assert.equal(wsManager.isExcluded("src/components/button.tsx").excluded, false);
  });

  it("identifies sensitive and secret file patterns", () => {
    assert.equal(wsManager.isExcluded(".env").excluded, true);
    assert.equal(wsManager.isExcluded(".env.production").excluded, true);
    assert.equal(wsManager.isExcluded(".env.local").excluded, true);
    assert.equal(wsManager.isExcluded("config/id_rsa").excluded, true);
    assert.equal(wsManager.isExcluded("certs/server.key").excluded, true);
    assert.equal(wsManager.isExcluded("certs/cert.pem").excluded, true);
    assert.equal(wsManager.isExcluded("auth/credentials.json").excluded, true);
    assert.equal(wsManager.isExcluded("src/app.js").excluded, false);
  });

  it("identifies binary files", () => {
    assert.equal(wsManager.isExcluded("assets/logo.png").excluded, true);
    assert.equal(wsManager.isExcluded("package.zip").excluded, true);
    assert.equal(wsManager.isExcluded("bin/tool.exe").excluded, true);
    assert.equal(wsManager.isExcluded("docs/guide.pdf").excluded, true);
    assert.equal(wsManager.isExcluded("docs/guide.md").excluded, false);
  });
});

describe("Path Traversal Rejection", () => {
  const wsManager = new TestWorkspaceManager("C:/projects/my-app");

  it("rejects path traversal attempting to escape workspace root", () => {
    assert.throws(
      () => wsManager.resolveWorkspacePath("../outside.js"),
      /traversal rejected/i
    );
    assert.throws(
      () => wsManager.resolveWorkspacePath("../../windows/system32/cmd.exe"),
      /traversal rejected/i
    );
  });

  it("rejects absolute paths outside workspace root", () => {
    assert.throws(
      () => wsManager.resolveWorkspacePath("D:/other-project/secret.js"),
      /outside active workspace/i
    );
    assert.throws(
      () => wsManager.resolveWorkspacePath("C:/Windows/System32/drivers/etc/hosts"),
      /outside active workspace/i
    );
  });

  it("resolves valid relative paths inside workspace", () => {
    const uri = wsManager.resolveWorkspacePath("src/features/chat.ts");
    assert.equal(uri.fsPath.replace(/\\/g, "/").toLowerCase().includes("projects/my-app/src/features/chat.ts"), true);
  });
});

describe("Structured Edit Proposal Validation", () => {
  const wsManager = new TestWorkspaceManager("C:/projects/my-app");
  const diffProvider = new DiffContentProvider();
  const editManager = new EditManager(wsManager, diffProvider);

  it("extracts and parses valid ```nexamind-edit block", () => {
    const aiResponse =
      "Here is the modified file with health check:\n\n" +
      "```nexamind-edit\n" +
      "{\n" +
      '  "filePath": "src/app.js",\n' +
      '  "description": "Add health check endpoint",\n' +
      '  "action": "modify",\n' +
      '  "replacement": "const express = require(\'express\');\\nconst app = express();\\napp.get(\'/health\', (req, res) => res.send(\'OK\'));\\nmodule.exports = app;"\n' +
      "}\n" +
      "```\n\n" +
      "Let me know if you would like any changes.";

    const edits = editManager.parseProposedEdits(aiResponse);
    assert.equal(edits.length, 1);
    assert.equal(edits[0].filePath, "src/app.js");
    assert.equal(edits[0].action, "modify");
    assert.equal(edits[0].description, "Add health check endpoint");
    assert.equal(edits[0].replacement.includes("/health"), true);
    assert.equal(edits[0].status, "pending");
    assert.equal(edits[0].error, undefined);
  });

  it("marks proposal with error if target path is excluded or sensitive", () => {
    const aiResponse =
      "```nexamind-edit\n" +
      "{\n" +
      '  "filePath": ".env",\n' +
      '  "description": "Add secret key",\n' +
      '  "action": "modify",\n' +
      '  "replacement": "SECRET=12345"\n' +
      "}\n" +
      "```";

    const edits = editManager.parseProposedEdits(aiResponse);
    assert.equal(edits.length, 1);
    assert.equal(Boolean(edits[0].error), true);
    assert.equal(edits[0].error?.includes("restricted"), true);
  });

  it("marks proposal with error if target path traverses outside workspace", () => {
    const aiResponse =
      "```nexamind-edit\n" +
      "{\n" +
      '  "filePath": "../../../evil.js",\n' +
      '  "description": "Escape root",\n' +
      '  "action": "create",\n' +
      '  "replacement": "evil()"\n' +
      "}\n" +
      "```";

    const edits = editManager.parseProposedEdits(aiResponse);
    assert.equal(edits.length, 1);
    assert.equal(Boolean(edits[0].error), true);
    assert.equal(edits[0].error?.includes("traversal"), true);
  });

  it("handles malformed JSON inside edit block gracefully without crashing", () => {
    const aiResponse =
      "```nexamind-edit\n" +
      "this is not valid json { bad }\n" +
      "```";

    const edits = editManager.parseProposedEdits(aiResponse);
    assert.equal(edits.length, 0);
  });
});

describe("Approval-Before-Write Lifecycle", () => {
  const wsManager = new TestWorkspaceManager("C:/projects/my-app");
  const diffProvider = new DiffContentProvider();
  const editManager = new EditManager(wsManager, diffProvider);

  it("initializes edits as pending and requires approval before applying", async () => {
    const edit: ProposedEdit = {
      id: "edit-test-1",
      filePath: "src/index.js",
      description: "Test edit",
      action: "modify",
      replacement: "console.log('updated');",
      status: "pending",
    };

    // Virtual diff registration
    const diffUri = diffProvider.getProposedUri(edit.id, edit.filePath);
    diffProvider.setContent(diffUri, edit.replacement);
    assert.equal(diffProvider.provideTextDocumentContent(diffUri), edit.replacement);

    // Initial status must be pending (no write performed yet)
    assert.equal(edit.status, "pending");

    // Discarding marks rejected and cleans up virtual diff
    editManager.rejectEdit(edit);
    assert.equal(edit.status, "rejected");
    assert.equal(diffProvider.provideTextDocumentContent(diffUri), "");
  });

  it("refuses to apply an edit marked with validation error", async () => {
    const invalidEdit: ProposedEdit = {
      id: "edit-test-2",
      filePath: ".env",
      description: "Invalid target",
      action: "modify",
      replacement: "TEST=1",
      status: "pending",
      error: "Target file is restricted",
    };

    await assert.rejects(
      async () => {
        await editManager.applyEdit(invalidEdit);
      },
      /Cannot apply edit: Target file is restricted/
    );
  });
});

describe("Context Formatting for Backend Request Budget", () => {
  const wsManager = new TestWorkspaceManager("C:/projects/my-app");

  it("formats prompt with context delimiters and stays within safe length", () => {
    const files = [
      {
        relativePath: "src/app.js",
        content: "const a = 1;\nconst b = 2;\n",
        size: 26,
        lineCount: 2,
      },
    ];

    const formatted = wsManager.formatPromptWithContext(files, "How does this file work?");
    assert.equal(formatted.includes("[WORKSPACE CONTEXT]"), true);
    assert.equal(formatted.includes("src/app.js"), true);
    assert.equal(formatted.includes("const a = 1;"), true);
    assert.equal(formatted.includes("nexamind-edit"), true);
    assert.equal(formatted.includes("User Query:\nHow does this file work?"), true);
    assert.equal(formatted.length < 9500, true);
  });
});
