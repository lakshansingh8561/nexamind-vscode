import * as vscode from "vscode";
import * as fs from "node:fs";
import { ProposedEdit } from "../types.js";
import { WorkspaceManager } from "./workspaceManager.js";
import { DiffContentProvider } from "./diffProvider.js";

export class EditManager {
  private activeEdits = new Map<string, ProposedEdit>();

  constructor(
    private readonly workspaceManager: WorkspaceManager,
    private readonly diffProvider: DiffContentProvider
  ) {}

  /**
   * Extracts and parses ```nexamind-edit ... ``` code blocks from assistant message content.
   */
  public parseProposedEdits(content: string): ProposedEdit[] {
    const edits: ProposedEdit[] = [];
    if (!content) return edits;

    const regex = /```(?:nexamind-edit|json:nexamind-edit)\s*\n([\s\S]*?)\n```/gi;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(content)) !== null) {
      const rawJson = match[1].trim();
      try {
        const parsed = JSON.parse(rawJson);
        const candidates = Array.isArray(parsed) ? parsed : [parsed];

        for (const item of candidates) {
          if (item && typeof item === "object" && typeof item.filePath === "string") {
            const edit: ProposedEdit = {
              id: `edit-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
              filePath: item.filePath.trim().replace(/\\/g, "/"),
              description: typeof item.description === "string" ? item.description : "Proposed file edit",
              action: item.action === "create" ? "create" : "modify",
              replacement: typeof item.replacement === "string" ? item.replacement : "",
              status: "pending",
            };

            this.validateProposedEdit(edit);

            try {
              const targetUri = this.workspaceManager.resolveWorkspacePath(edit.filePath);
              const normFs = targetUri.fsPath.replace(/\\/g, "/").toLowerCase();
              const openDoc = vscode.workspace.textDocuments?.find(
                (d) => d.uri?.fsPath?.replace(/\\/g, "/").toLowerCase() === normFs && !d.isClosed
              );
              if (openDoc) {
                edit.originalContent = openDoc.getText();
              } else if (fs.existsSync(targetUri.fsPath)) {
                edit.originalContent = fs.readFileSync(targetUri.fsPath, "utf8");
              }
            } catch {}

            edits.push(edit);
            this.activeEdits.set(edit.id, edit);
          }
        }
      } catch (err: any) {
        console.warn("[EditManager] Failed to parse proposal block:", err?.message || err);
      }
    }

    return edits;
  }

  /**
   * Validates a proposed edit against workspace boundaries and exclusion rules.
   */
  public validateProposedEdit(edit: ProposedEdit): void {
    if (!edit.filePath) {
      edit.error = "Edit has no target file path.";
      return;
    }

    const exclusion = this.workspaceManager.isExcluded(edit.filePath);
    if (exclusion.excluded) {
      edit.error = `Target file is restricted: ${exclusion.reason}`;
      return;
    }

    try {
      this.workspaceManager.resolveWorkspacePath(edit.filePath);
    } catch (err: any) {
      edit.error = err?.message || "Invalid target path.";
    }
  }

  public getEdit(editId: string): ProposedEdit | undefined {
    return this.activeEdits.get(editId);
  }

  /**
   * Opens VS Code's native diff editor comparing the current file with proposed changes.
   */
  public async openDiff(edit: ProposedEdit): Promise<void> {
    if (edit.error) {
      throw new Error(`Cannot review diff: ${edit.error}`);
    }

    const targetUri = this.workspaceManager.resolveWorkspacePath(edit.filePath);
    const proposedUri = this.diffProvider.getProposedUri(edit.id, edit.filePath);

    // Provide the virtual document content
    this.diffProvider.setContent(proposedUri, edit.replacement);

    // If file doesn't exist yet, create an empty virtual doc for the left side
    let leftUri = targetUri;
    try {
      await vscode.workspace.fs.stat(targetUri);
    } catch {
      // File doesn't exist yet (create action)
      const emptyUri = this.diffProvider.getProposedUri(`${edit.id}-empty`, "empty");
      this.diffProvider.setContent(emptyUri, "");
      leftUri = emptyUri;
    }

    await vscode.commands.executeCommand(
      "vscode.diff",
      leftUri,
      proposedUri,
      `Lumina Proposal: ${edit.filePath}`
    );
  }

  /**
   * Applies the proposed edit to the workspace file and saves it upon user approval.
   * Strictly enforces stale file detection and workspace boundary validation.
   */
  public async applyEdit(edit: ProposedEdit): Promise<void> {
    if (edit.status === "applied") {
      throw new Error("This proposed edit has already been applied.");
    }

    if (edit.error) {
      throw new Error(`Cannot apply edit: ${edit.error}`);
    }

    const targetUri = this.workspaceManager.resolveWorkspacePath(edit.filePath);

    // Stale proposal detection: check if file changed since proposal was generated
    if (edit.originalContent !== undefined) {
      let currentContent: string;
      try {
        const fileContext = await this.workspaceManager.readWorkspaceFile(edit.filePath);
        currentContent = fileContext.content;
      } catch {
        currentContent = "";
      }

      if (currentContent !== edit.originalContent) {
        throw new Error(
          `File '${edit.filePath}' has been modified since Lumina proposed this edit. Review diff and re-generate before applying.`
        );
      }
    }

    const workspaceEdit = new vscode.WorkspaceEdit();

    let fileExists = false;
    try {
      const stat = await vscode.workspace.fs.stat(targetUri);
      fileExists = stat.type === vscode.FileType.File;
    } catch {
      fileExists = false;
    }

    if (fileExists) {
      const doc = await vscode.workspace.openTextDocument(targetUri);
      const fullRange = new vscode.Range(
        doc.positionAt(0),
        doc.positionAt(doc.getText().length)
      );
      workspaceEdit.replace(targetUri, fullRange, edit.replacement);
    } else {
      workspaceEdit.createFile(targetUri, { overwrite: true, ignoreIfExists: false });
      workspaceEdit.insert(targetUri, new vscode.Position(0, 0), edit.replacement);
    }

    const applied = await vscode.workspace.applyEdit(workspaceEdit);
    if (!applied) {
      throw new Error(`Failed to apply changes to '${edit.filePath}' via VS Code WorkspaceEdit.`);
    }

    // Save changes to disk immediately following explicit approval
    const doc = await vscode.workspace.openTextDocument(targetUri);
    await doc.save();

    edit.status = "applied";
    this.diffProvider.removeContent(this.diffProvider.getProposedUri(edit.id, edit.filePath));
  }

  public rejectEdit(edit: ProposedEdit): void {
    edit.status = "rejected";
    this.diffProvider.removeContent(this.diffProvider.getProposedUri(edit.id, edit.filePath));
  }
}
