import * as vscode from "vscode";
import { NexamindClient, NexamindApiError } from "../api/nexamindClient.js";
import { AuthManager } from "../auth/authManager.js";
import {
  WebviewToExtensionMessage,
  ExtensionToWebviewMessage,
  Conversation,
  Message,
  AttachedFileContext,
  ProposedEdit,
} from "../types.js";
import { WorkspaceManager } from "../workspace/workspaceManager.js";
import { DiffContentProvider } from "../workspace/diffProvider.js";
import { EditManager } from "../workspace/editManager.js";
import { shouldIncludeAutomaticContext } from "./intentClassifier.js";

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "nexamind.chatView";

  private _view?: vscode.WebviewView;
  private currentConversationId?: string;
  private isSendingMessage: boolean = false;
  private attachedFiles: AttachedFileContext[] = [];
  private currentEdits: Map<string, ProposedEdit> = new Map();
  private activeAbortController?: AbortController;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly client: NexamindClient,
    private readonly authManager: AuthManager,
    private readonly workspaceManager: WorkspaceManager,
    private readonly diffProvider: DiffContentProvider,
    private readonly editManager: EditManager
  ) {
    // Listen for auth state changes from auth manager
    this.authManager.onAuthStateChanged((event) => {
      this.postMessage({
        type: "authState",
        authenticated: event.authenticated,
        user: event.user,
        tokenBalance: event.tokenBalance,
      });

      if (event.authenticated) {
        this.loadConversations();
      }
    });

    // Initialize active editor in workspace manager if one exists
    if (vscode.window.activeTextEditor) {
      this.workspaceManager.setLastActiveEditor(vscode.window.activeTextEditor);
    }

    // Notify webview when active editor changes and preserve active editor reference
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) {
        this.workspaceManager.setLastActiveEditor(editor);
      }
      this.notifyActiveEditorStatus();
    });

    vscode.window.onDidChangeVisibleTextEditors(() => {
      this.notifyActiveEditorStatus();
    });
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (data: WebviewToExtensionMessage) => {
      await this.handleWebviewMessage(data);
    });

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.syncState();
      }
    });

    // Initial sync
    this.syncState();
  }

  public async createNewChat(): Promise<void> {
    const token = await this.authManager.getToken();
    if (!token) {
      vscode.window.showWarningMessage("Please log in to Lumina before creating a chat.");
      return;
    }

    try {
      const conv = await this.client.createConversation(token, "New Chat");
      this.currentConversationId = conv.id;
      await this.loadConversations(conv.id);
      this.postMessage({
        type: "conversationMessages",
        conversationId: conv.id,
        messages: [],
      });
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to create chat: ${err?.message || err}`);
    }
  }

  public updateBackendUrl(url: string): void {
    this.client.setBaseUrl(url);
    this.postMessage({
      type: "configUpdate",
      backendUrl: this.client.getBaseUrl(),
    });
  }

  public async attachActiveFile(explicitRelativePath?: string): Promise<void> {
    const fileContext = await this.workspaceManager.getActiveEditorContext(explicitRelativePath);
    if (!fileContext) {
      vscode.window.showWarningMessage("No active workspace file is currently open in the editor.");
      return;
    }

    // Replace if already in list, or add
    const existingIdx = this.attachedFiles.findIndex((f) => f.relativePath === fileContext.relativePath);
    if (existingIdx >= 0) {
      this.attachedFiles[existingIdx] = fileContext;
    } else {
      this.attachedFiles.push(fileContext);
    }

    this.postMessage({
      type: "attachedFilesUpdate",
      files: this.attachedFiles,
    });

    const sizeDisplay = Math.round(fileContext.size / 1024) || 1;
    vscode.window.showInformationMessage(`Attached '${fileContext.relativePath}' (${sizeDisplay} KB) to Lumina context.`);

    if (this._view) {
      this._view.show?.(true);
    }
  }

  public async attachWorkspaceFiles(): Promise<void> {
    const root = this.workspaceManager.getWorkspaceRoot();
    if (!root) {
      vscode.window.showWarningMessage("No workspace folder is currently open.");
      return;
    }

    const selectedUris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: true,
      defaultUri: root.uri,
      openLabel: "Attach to Lumina",
      title: "Select Workspace Files to Include in Context",
    });

    if (!selectedUris || selectedUris.length === 0) return;

    let addedCount = 0;
    for (const uri of selectedUris) {
      try {
        const relativePath = this.workspaceManager.getRelativePath(uri);
        const fileContext = await this.workspaceManager.readWorkspaceFile(relativePath);

        const existingIdx = this.attachedFiles.findIndex((f) => f.relativePath === fileContext.relativePath);
        if (existingIdx >= 0) {
          this.attachedFiles[existingIdx] = fileContext;
        } else {
          this.attachedFiles.push(fileContext);
        }
        addedCount++;
      } catch (err: any) {
        vscode.window.showWarningMessage(`Could not attach '${uri.fsPath}': ${err.message}`);
      }
    }

    if (addedCount > 0) {
      this.postMessage({
        type: "attachedFilesUpdate",
        files: this.attachedFiles,
      });
      vscode.window.showInformationMessage(`Attached ${addedCount} file(s) to Lumina context.`);
    }
  }

  private postMessage(message: ExtensionToWebviewMessage): void {
    this._view?.webview.postMessage(message);
  }

  private notifyActiveEditorStatus(): void {
    const editor = this.workspaceManager.getEffectiveActiveEditor();
    if (editor && editor.document.uri.scheme === "file") {
      const fileName = vscode.workspace.asRelativePath(editor.document.uri, false);
      const hasSelection = !editor.selection.isEmpty;
      const languageId = editor.document.languageId;
      this.postMessage({
        type: "activeFileNotice",
        fileName,
        hasSelection,
        languageId,
      });
    }
  }

  private async syncState(): Promise<void> {
    const session = await this.authManager.validateSession();
    this.postMessage({
      type: "configUpdate",
      backendUrl: this.client.getBaseUrl(),
    });

    this.postMessage({
      type: "authState",
      authenticated: session.authenticated,
      user: session.user,
      tokenBalance: session.tokenBalance,
    });

    this.postMessage({
      type: "attachedFilesUpdate",
      files: this.attachedFiles,
    });

    this.notifyActiveEditorStatus();

    if (session.authenticated) {
      await this.loadConversations(this.currentConversationId);
    }
  }

  private async handleWebviewMessage(message: WebviewToExtensionMessage): Promise<void> {
    switch (message.type) {
      case "checkAuth": {
        await this.syncState();
        break;
      }

      case "login": {
        try {
          const user = await this.authManager.login(message.email, message.password);
          vscode.window.showInformationMessage(`Logged in to Lumina as ${user.name}`);
        } catch (err: any) {
          const errorMsg = err?.message || "Failed to log in";
          this.postMessage({ type: "authError", message: errorMsg });
        }
        break;
      }

      case "logout": {
        await this.authManager.logout();
        this.currentConversationId = undefined;
        vscode.window.showInformationMessage("Logged out from Lumina.");
        break;
      }

      case "loadConversations": {
        await this.loadConversations(this.currentConversationId);
        break;
      }

      case "selectConversation": {
        this.currentConversationId = message.conversationId;
        await this.loadConversationMessages(message.conversationId);
        break;
      }

      case "createConversation": {
        await this.createNewChat();
        break;
      }

      case "sendMessage": {
        await this.handleSendMessage(
          message.conversationId,
          message.content,
          message.attachedFiles
        );
        break;
      }

      case "cancelGeneration": {
        if (this.activeAbortController) {
          this.activeAbortController.abort();
          vscode.window.showInformationMessage("Lumina generation cancelled.");
        }
        break;
      }

      case "refreshTokenBalance": {
        const balance = await this.authManager.refreshTokenBalance();
        if (balance) {
          this.postMessage({ type: "tokenBalanceUpdate", tokenBalance: balance });
        }
        break;
      }

      case "setBackendUrl": {
        await vscode.workspace
          .getConfiguration("nexamind")
          .update("backendUrl", message.url, vscode.ConfigurationTarget.Global);
        this.updateBackendUrl(message.url);
        vscode.window.showInformationMessage(`Lumina backend URL set to ${message.url}`);
        break;
      }

      case "openSettings": {
        vscode.commands.executeCommand("workbench.action.openSettings", "nexamind");
        break;
      }

      case "attachActiveFile": {
        await this.attachActiveFile(message.relativePath);
        break;
      }

      case "attachWorkspaceFiles": {
        await this.attachWorkspaceFiles();
        break;
      }

      case "removeAttachedFile": {
        this.attachedFiles = this.attachedFiles.filter((f) => f.relativePath !== message.relativePath);
        this.postMessage({
          type: "attachedFilesUpdate",
          files: this.attachedFiles,
        });
        break;
      }

      case "clearAttachedFiles": {
        this.attachedFiles = [];
        this.postMessage({
          type: "attachedFilesUpdate",
          files: [],
        });
        break;
      }

      case "openDiff": {
        const edit = this.editManager.getEdit(message.editId) || this.currentEdits.get(message.editId);
        if (edit) {
          try {
            await this.editManager.openDiff(edit);
          } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to open diff: ${err?.message || err}`);
          }
        }
        break;
      }

      case "applyEdit": {
        await this.handleApplyEdit(message.editId);
        break;
      }

      case "rejectEdit": {
        const edit = this.editManager.getEdit(message.editId) || this.currentEdits.get(message.editId);
        if (edit) {
          this.editManager.rejectEdit(edit);
          this.postMessage({
            type: "editStatusUpdate",
            editId: edit.id,
            status: "rejected",
            message: "Proposal was discarded.",
          });
          vscode.window.showInformationMessage(`Proposal for '${edit.filePath}' discarded.`);
        }
        break;
      }
    }
  }

  private async handleApplyEdit(editId: string): Promise<void> {
    const edit = this.editManager.getEdit(editId) || this.currentEdits.get(editId);
    if (!edit) {
      vscode.window.showErrorMessage("Proposed edit not found or expired.");
      return;
    }

    // Explicit approval confirmation dialog before modifying disk files
    const choice = await vscode.window.showInformationMessage(
      `Apply and save proposed changes to '${edit.filePath}'?`,
      { modal: true, detail: edit.description },
      "Apply & Save Changes",
      "Cancel"
    );

    if (choice !== "Apply & Save Changes") {
      return;
    }

    try {
      await this.editManager.applyEdit(edit);
      this.postMessage({
        type: "editStatusUpdate",
        editId: edit.id,
        status: "applied",
        message: `Changes saved to ${edit.filePath}`,
      });
      vscode.window.showInformationMessage(`Successfully applied and saved changes to '${edit.filePath}'.`);
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to apply changes: ${err?.message || err}`);
    }
  }

  private async loadConversations(selectId?: string): Promise<void> {
    const token = await this.authManager.getToken();
    if (!token) return;

    try {
      const conversations = await this.client.getConversations(token);
      let targetId = selectId;

      if (!targetId && conversations.length > 0) {
        targetId = conversations[0].id;
      }

      this.currentConversationId = targetId;

      this.postMessage({
        type: "conversationsList",
        conversations,
        selectedConversationId: targetId,
      });

      if (targetId) {
        await this.loadConversationMessages(targetId);
      } else {
        this.postMessage({
          type: "conversationMessages",
          conversationId: "",
          messages: [],
        });
      }
    } catch (err: any) {
      if (err instanceof NexamindApiError && err.isAuthError) {
        await this.authManager.logout();
      } else {
        vscode.window.showErrorMessage(`Failed to load conversations: ${err.message}`);
      }
    }
  }

  private async loadConversationMessages(conversationId: string): Promise<void> {
    const token = await this.authManager.getToken();
    if (!token) return;

    try {
      const messages = await this.client.getMessages(token, conversationId);
      this.postMessage({
        type: "conversationMessages",
        conversationId,
        messages,
      });
    } catch (err: any) {
      if (err instanceof NexamindApiError && err.isAuthError) {
        await this.authManager.logout();
      } else {
        vscode.window.showErrorMessage(`Failed to load messages: ${err.message}`);
      }
    }
  }

  private async handleSendMessage(
    conversationId: string,
    content: string,
    attachedFilesFromWebview?: AttachedFileContext[]
  ): Promise<void> {
    if (this.isSendingMessage) return;

    const trimmedContent = content ? content.trim() : "";
    if (!trimmedContent) return;

    this.isSendingMessage = true;
    const abortController = new AbortController();
    this.activeAbortController = abortController;

    let targetConvId = conversationId;

    try {
      const token = await this.authManager.getToken();
      if (!token) {
        vscode.window.showWarningMessage("Please log in to Lumina before sending messages.");
        return;
      }

      // If no conversation currently exists, automatically create one first
      if (!targetConvId) {
        try {
          const titlePreview = trimmedContent.slice(0, 30);
          const newConv = await this.client.createConversation(token, titlePreview || "Chat");
          targetConvId = newConv.id;
          this.currentConversationId = newConv.id;
          await this.loadConversations(newConv.id);
        } catch (createErr: any) {
          vscode.window.showErrorMessage(`Failed to initialize conversation: ${createErr.message}`);
          this.postMessage({
            type: "messageError",
            conversationId: "",
            error: `Failed to initialize conversation: ${createErr.message}`,
          });
          return;
        }
      }

      // 1. Gather any manually attached files from provider state and webview
      const filesToInclude: AttachedFileContext[] = [...this.attachedFiles];
      if (attachedFilesFromWebview && Array.isArray(attachedFilesFromWebview)) {
        for (const webviewFile of attachedFilesFromWebview) {
          if (!filesToInclude.some((f) => f.relativePath === webviewFile.relativePath)) {
            filesToInclude.push(webviewFile);
          }
        }
      }

      // 2. Intent-Aware Context Selection:
      // Evaluate whether the message requires workspace/editor context (coding request)
      // or should be treated as ordinary conversation (no automatic context)
      const effectiveEditor = this.workspaceManager.getEffectiveActiveEditor();
      const hasSelection = Boolean(effectiveEditor?.selection && !effectiveEditor.selection.isEmpty);
      const activeFileName = effectiveEditor?.document?.uri?.fsPath
        ? this.workspaceManager.getRelativePath(effectiveEditor.document.uri)
        : undefined;

      const includeAutoContext = shouldIncludeAutomaticContext(trimmedContent, {
        hasActiveEditor: Boolean(effectiveEditor?.document),
        hasSelection,
        activeFileName,
      });

      if (includeAutoContext) {
        // AUTOMATIC ACTIVE FILE CONTEXT:
        const activeCtx = await this.workspaceManager.getActiveEditorContext();
        if (activeCtx) {
          const alreadyIncluded = filesToInclude.some((f) => f.relativePath === activeCtx.relativePath);
          if (!alreadyIncluded) {
            filesToInclude.unshift(activeCtx); // Priority 1: active editor
          }
        }

        // AUTOMATIC RELEVANT WORKSPACE CONTEXT:
        const relevantFiles = await this.workspaceManager.getRelevantWorkspaceFiles(
          trimmedContent,
          filesToInclude.map((f) => f.relativePath)
        );
        for (const relFile of relevantFiles) {
          if (!filesToInclude.some((f) => f.relativePath === relFile.relativePath)) {
            filesToInclude.push(relFile);
          }
        }
      }

      // 3. Format prompt with workspace context, ensuring safe context boundaries (< 9,500 chars)
      const augmentedContent = filesToInclude.length > 0
        ? this.workspaceManager.formatPromptWithContext(filesToInclude, trimmedContent)
        : trimmedContent;

      // 4. Build user message display: PURE USER QUERY WITHOUT [Active context: ...] PREPENDED
      // File indicators are tracked in contextFiles and rendered separately in the UI
      const contextFiles = filesToInclude.map((f) => f.relativePath);

      const tempUserMessage: Message = {
        id: `temp-${Date.now()}`,
        conversationId: targetConvId,
        role: "user",
        content: trimmedContent,
        status: "completed",
        createdAt: new Date().toISOString(),
        contextFiles: contextFiles.length > 0 ? contextFiles : undefined,
      };

      this.postMessage({
        type: "messageSending",
        conversationId: targetConvId,
        tempUserMessage,
      });

      const idempotencyKey = `ext-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

      // Execute via SSE streaming if possible, fallback to standard JSON ONLY on transport error
      let result;
      try {
        result = await this.client.sendMessageStream(
          token,
          targetConvId,
          augmentedContent,
          {
            onDelta: (delta: string) => {
              if (abortController.signal.aborted) return;
              this.postMessage({
                type: "messageDelta",
                conversationId: targetConvId,
                delta,
              });
            },
          },
          idempotencyKey,
          abortController.signal
        );
      } catch (streamErr: any) {
        if (abortController.signal.aborted || streamErr?.name === "AbortError") {
          throw streamErr;
        }

        // If error is an API error (quota 429, tokens 402, auth 401, bad request 400, timeout 408),
        // rethrow immediately. Do NOT blindly retry non-idempotent chat requests.
        if (streamErr instanceof NexamindApiError) {
          throw streamErr;
        }

        // Pure transport/network connection failure before stream established -> fallback to standard JSON
        result = await this.client.sendMessage(
          token,
          targetConvId,
          augmentedContent,
          idempotencyKey,
          abortController.signal
        );
      }

      // Parse structured edit proposals from assistant response
      const proposedEdits = this.editManager.parseProposedEdits(result.assistantMessage.content);
      for (const edit of proposedEdits) {
        this.currentEdits.set(edit.id, edit);
      }

      // Refresh token balance after message
      const updatedBalance = await this.authManager.refreshTokenBalance();

      this.postMessage({
        type: "messageSuccess",
        conversationId: targetConvId,
        userMessage: tempUserMessage,
        assistantMessage: result.assistantMessage,
        tokenBalance: updatedBalance || undefined,
        proposedEdits: proposedEdits.length > 0 ? proposedEdits : undefined,
      });

      // Clear manual attached files after sending
      this.attachedFiles = [];
      this.postMessage({
        type: "attachedFilesUpdate",
        files: [],
      });

      if (proposedEdits.length > 0) {
        vscode.window.showInformationMessage(
          `Lumina proposed changes for ${proposedEdits.map((e) => `'${e.filePath}'`).join(", ")}. Review diff before applying.`
        );
      }
    } catch (err: any) {
      if (err.name === "AbortError" || abortController.signal.aborted) {
        this.postMessage({
          type: "messageError",
          conversationId: targetConvId,
          error: "Generation stopped by user.",
        });
        return;
      }

      const errorMsg = err?.message || "Failed to send message";
      const statusCode = err instanceof NexamindApiError ? err.statusCode : undefined;

      this.postMessage({
        type: "messageError",
        conversationId: targetConvId,
        error: errorMsg,
        statusCode,
      });

      if (err instanceof NexamindApiError && err.isAuthError) {
        await this.authManager.logout();
      }
    } finally {
      this.isSendingMessage = false;
      this.activeAbortController = undefined;
    }
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    const nonce = getNonce();

    return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Lumina Chat</title>
  <style>
    :root {
      --chat-font: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif);
      --bg: var(--vscode-sideBar-background, var(--vscode-editor-background));
      --fg: var(--vscode-sideBar-foreground, var(--vscode-editor-foreground));
      --input-bg: var(--vscode-input-background, #2d2d2d);
      --input-fg: var(--vscode-input-foreground, #cccccc);
      --input-border: var(--vscode-input-border, #3c3c3c);
      --input-focus: var(--vscode-focusBorder, #007acc);
      --btn-bg: var(--vscode-button-background, #0e639c);
      --btn-fg: var(--vscode-button-foreground, #ffffff);
      --btn-hover: var(--vscode-button-hoverBackground, #1177bb);
      --btn-secondary-bg: var(--vscode-button-secondaryBackground, #3a3d41);
      --btn-secondary-fg: var(--vscode-button-secondaryForeground, #ffffff);
      --btn-secondary-hover: var(--vscode-button-secondaryHoverBackground, #45494e);
      --user-msg-bg: var(--vscode-chat-requestBubbleBackground, #2b3b4c);
      --ai-msg-bg: var(--vscode-editor-inactiveSelectionBackground, #1e1e2e);
      --border-color: var(--vscode-widget-border, rgba(128, 128, 128, 0.2));
      --badge-bg: var(--vscode-badge-background, #4d4d4d);
      --badge-fg: var(--vscode-badge-foreground, #ffffff);
      --error-fg: var(--vscode-errorForeground, #f48771);
      --success-fg: #89d185;
      --card-bg: var(--vscode-editorWidget-background, #252526);
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: var(--chat-font);
      background-color: var(--bg);
      color: var(--fg);
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
      font-size: 13px;
    }

    /* Header */
    .header {
      padding: 8px 12px;
      border-bottom: 1px solid var(--border-color);
      display: flex;
      flex-direction: column;
      gap: 6px;
      background: var(--bg);
      flex-shrink: 0;
    }

    .header-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 6px;
      font-weight: 600;
      font-size: 13px;
      letter-spacing: 0.3px;
    }

    .brand-icon {
      width: 14px;
      height: 14px;
      background: linear-gradient(135deg, #007acc, #9c27b0);
      border-radius: 3px;
      display: inline-block;
    }

    .token-badge {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      font-size: 11px;
      padding: 2px 7px;
      border-radius: 4px;
      background: rgba(234, 179, 8, 0.15);
      color: #eab308;
      border: 1px solid rgba(234, 179, 8, 0.3);
      cursor: pointer;
    }

    .header-actions {
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .icon-btn {
      background: none;
      border: none;
      color: var(--fg);
      cursor: pointer;
      padding: 3px 6px;
      border-radius: 3px;
      font-size: 12px;
      opacity: 0.8;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }

    .icon-btn:hover {
      opacity: 1;
      background: var(--btn-secondary-bg);
    }

    .conv-bar {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .conv-select {
      flex: 1;
      background: var(--input-bg);
      color: var(--input-fg);
      border: 1px solid var(--input-border);
      border-radius: 3px;
      padding: 3px 6px;
      font-size: 11px;
      outline: none;
    }

    .new-chat-btn {
      background: var(--btn-secondary-bg);
      color: var(--btn-secondary-fg);
      border: none;
      border-radius: 3px;
      padding: 3px 8px;
      font-size: 11px;
      cursor: pointer;
    }

    .new-chat-btn:hover {
      background: var(--btn-secondary-hover);
    }

    /* Views */
    .view-container {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .hidden {
      display: none !important;
    }

    /* Login View */
    .login-container {
      padding: 20px 16px;
      display: flex;
      flex-direction: column;
      gap: 14px;
      max-width: 320px;
      margin: auto 0;
    }

    .login-title {
      font-size: 15px;
      font-weight: 600;
      text-align: center;
    }

    .login-subtitle {
      font-size: 11px;
      opacity: 0.8;
      text-align: center;
      margin-top: -6px;
    }

    .form-group {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .form-label {
      font-size: 11px;
      font-weight: 500;
      opacity: 0.9;
    }

    .text-input {
      background: var(--input-bg);
      color: var(--input-fg);
      border: 1px solid var(--input-border);
      border-radius: 3px;
      padding: 6px 8px;
      font-size: 12px;
      outline: none;
    }

    .text-input:focus {
      border-color: var(--input-focus);
    }

    .btn {
      background: var(--btn-bg);
      color: var(--btn-fg);
      border: none;
      border-radius: 3px;
      padding: 6px 12px;
      font-size: 11.5px;
      font-weight: 500;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
    }

    .btn:hover {
      background: var(--btn-hover);
    }

    .btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
      pointer-events: none;
    }

    .text-input:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }

    .btn-secondary {
      background: var(--btn-secondary-bg);
      color: var(--btn-secondary-fg);
    }

    .btn-secondary:hover {
      background: var(--btn-secondary-hover);
    }

    .alert {
      padding: 6px 10px;
      border-radius: 3px;
      font-size: 11px;
      line-height: 1.4;
      word-break: break-word;
    }

    .alert-error {
      background: rgba(244, 135, 113, 0.15);
      color: var(--error-fg);
      border: 1px solid rgba(244, 135, 113, 0.3);
    }

    .backend-url-hint {
      font-size: 10px;
      opacity: 0.7;
      text-align: center;
      margin-top: 8px;
    }

    /* Messages */
    .messages-list {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .empty-chat {
      text-align: center;
      opacity: 0.6;
      margin: auto 0;
      font-size: 12px;
      padding: 20px;
      line-height: 1.6;
    }

    .message {
      display: flex;
      flex-direction: column;
      gap: 3px;
      max-width: 92%;
      word-break: break-word;
    }

    .message.user {
      align-self: flex-end;
    }

    .message.assistant {
      align-self: flex-start;
      max-width: 96%;
    }

    .message-meta {
      font-size: 10px;
      opacity: 0.6;
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .message.user .message-meta {
      justify-content: flex-end;
    }

    .context-indicator {
      font-size: 10.5px;
      opacity: 0.75;
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 4px;
      margin-bottom: 2px;
    }

    .message.user .context-indicator {
      justify-content: flex-end;
    }

    .context-tag {
      background: var(--badge-bg);
      color: var(--badge-fg);
      padding: 1px 5px;
      border-radius: 3px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 10px;
    }

    .message-bubble {
      padding: 8px 12px;
      border-radius: 8px;
      font-size: 12.5px;
      line-height: 1.5;
      white-space: pre-wrap;
    }

    .message.user .message-bubble {
      background: var(--user-msg-bg);
      color: var(--fg);
      border-bottom-right-radius: 2px;
      border: 1px solid var(--border-color);
    }

    .message.assistant .message-bubble {
      background: var(--ai-msg-bg);
      color: var(--fg);
      border-bottom-left-radius: 2px;
      border: 1px solid var(--border-color);
    }

    /* Proposal Card */
    .proposal-card {
      margin-top: 8px;
      padding: 10px 12px;
      background: var(--card-bg);
      border: 1px solid var(--border-color);
      border-left: 3px solid #007acc;
      border-radius: 4px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .proposal-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 11.5px;
      font-weight: 600;
    }

    .proposal-file {
      font-family: var(--vscode-editor-font-family, monospace);
      color: #79c0ff;
    }

    .proposal-badge {
      font-size: 10px;
      padding: 1px 6px;
      border-radius: 10px;
      background: rgba(0, 122, 204, 0.2);
      color: #79c0ff;
    }

    .proposal-badge.applied {
      background: rgba(137, 209, 133, 0.2);
      color: var(--success-fg);
    }

    .proposal-badge.rejected {
      background: rgba(244, 135, 113, 0.2);
      color: var(--error-fg);
    }

    .proposal-desc {
      font-size: 11.5px;
      opacity: 0.9;
    }

    .proposal-actions {
      display: flex;
      gap: 6px;
      margin-top: 4px;
      flex-wrap: wrap;
    }

    .generating-indicator {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      opacity: 0.8;
      padding: 6px 10px;
      background: var(--ai-msg-bg);
      border: 1px solid var(--border-color);
      border-radius: 6px;
      align-self: flex-start;
    }

    .dot-flashing {
      display: inline-block;
      width: 4px;
      height: 4px;
      border-radius: 50%;
      background-color: var(--fg);
      animation: dotPulse 1.2s infinite linear;
    }

    @keyframes dotPulse {
      0%, 100% { opacity: 0.2; transform: scale(0.8); }
      50% { opacity: 1; transform: scale(1.2); }
    }

    /* Context Attachment Bar */
    .context-bar {
      padding: 6px 12px;
      background: rgba(0, 0, 0, 0.15);
      border-top: 1px solid var(--border-color);
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .context-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
    }

    .chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      background: var(--btn-secondary-bg);
      color: var(--btn-secondary-fg);
      font-size: 10.5px;
      padding: 2px 6px;
      border-radius: 12px;
      max-width: 100%;
      font-family: var(--vscode-editor-font-family, monospace);
    }

    .chip-remove {
      cursor: pointer;
      opacity: 0.7;
      margin-left: 2px;
      font-weight: bold;
    }

    .chip-remove:hover {
      opacity: 1;
      color: var(--error-fg);
    }

    .context-actions-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
    }

    .attach-btn {
      background: none;
      border: 1px solid var(--border-color);
      color: var(--fg);
      border-radius: 3px;
      padding: 2px 7px;
      font-size: 11px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      opacity: 0.85;
    }

    .attach-btn:hover {
      opacity: 1;
      background: var(--btn-secondary-bg);
    }

    /* Input Footer */
    .input-footer {
      padding: 8px 12px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      background: var(--bg);
      flex-shrink: 0;
    }

    .input-box-row {
      display: flex;
      gap: 6px;
      align-items: flex-end;
    }

    .chat-textarea {
      flex: 1;
      min-height: 36px;
      max-height: 120px;
      resize: none;
      background: var(--input-bg);
      color: var(--input-fg);
      border: 1px solid var(--input-border);
      border-radius: 4px;
      padding: 6px 8px;
      font-size: 12px;
      font-family: inherit;
      outline: none;
      line-height: 1.4;
    }

    .chat-textarea:focus {
      border-color: var(--input-focus);
    }

    .send-btn {
      background: var(--btn-bg);
      color: var(--btn-fg);
      border: none;
      border-radius: 4px;
      width: 34px;
      height: 34px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }

    .send-btn:hover {
      background: var(--btn-hover);
    }

    .send-btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }

    .input-hints {
      font-size: 10px;
      opacity: 0.6;
      display: flex;
      justify-content: space-between;
    }
  </style>
</head>
<body>
  <!-- Header -->
  <div class="header">
    <div class="header-top">
      <div class="brand">
        <span class="brand-icon"></span>
        <span>Lumina AI</span>
      </div>
      <div class="header-actions">
        <span id="tokenBalanceBadge" class="token-badge hidden" title="Available Tokens (Click to refresh)">
          ⚡ <span id="tokenBalanceCount">0</span>
        </span>
        <button id="logoutBtn" class="icon-btn hidden" title="Log Out">⎋</button>
        <button id="settingsBtn" class="icon-btn" title="Settings">⚙</button>
      </div>
    </div>

    <!-- Conversation Selector (visible when authenticated) -->
    <div id="convBar" class="conv-bar hidden">
      <select id="convSelect" class="conv-select" title="Switch Conversation">
        <option value="">No conversations</option>
      </select>
      <button id="newChatBtn" class="new-chat-btn" title="Start New Chat">+ New</button>
    </div>
  </div>

  <!-- Unauthenticated View -->
  <div id="loginView" class="view-container">
    <form id="loginForm" class="login-container" onsubmit="return false;">
      <div class="login-title">Sign in to Lumina</div>
      <div class="login-subtitle">Connect your Lumina AI account to chat in VS Code</div>

      <div id="loginAlert" class="alert alert-error hidden" role="alert"></div>

      <div class="form-group">
        <label class="form-label" for="loginEmail">Email</label>
        <input type="email" id="loginEmail" class="text-input" placeholder="user@example.com" autocomplete="email" required>
      </div>

      <div class="form-group">
        <label class="form-label" for="loginPassword">Password</label>
        <input type="password" id="loginPassword" class="text-input" placeholder="••••••••" autocomplete="current-password" required>
      </div>

      <button type="submit" id="submitLoginBtn" class="btn">Sign In</button>

      <div class="backend-url-hint">
        Backend: <span id="backendUrlText">http://localhost:5000</span>
      </div>
    </form>
  </div>

  <!-- Authenticated Chat View -->
  <div id="chatView" class="view-container hidden">
    <!-- Messages Container -->
    <div id="messagesList" class="messages-list">
      <div id="emptyChatPlaceholder" class="empty-chat">
        Ask Lumina anything about your code, or attach workspace files below for context-aware assistance.
      </div>
    </div>

    <!-- Generating indicator -->
    <div id="generatingBox" class="generating-indicator hidden">
      <span class="dot-flashing"></span>
      <span>Lumina is thinking...</span>
      <button id="cancelGenBtn" class="btn btn-secondary" style="padding: 2px 7px; font-size: 10px; margin-left: 6px; cursor: pointer;">Stop</button>
    </div>

    <!-- Context Attachment Bar -->
    <div class="context-bar">
      <div id="chipsContainer" class="context-chips hidden"></div>
      <div class="context-actions-row">
        <div style="display: flex; gap: 6px;">
          <button id="attachActiveBtn" class="attach-btn" title="Attach Active Editor File">
            <span>📎</span> <span id="attachActiveLabel">Attach Active File</span>
          </button>
          <button id="attachWorkspaceBtn" class="attach-btn" title="Pick workspace files to attach">
            <span>➕</span> <span>Workspace File...</span>
          </button>
        </div>
        <span id="activeFileNotice" style="font-size: 10px; opacity: 0.6; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 140px;"></span>
      </div>
    </div>

    <!-- Input Footer -->
    <div class="input-footer">
      <div id="chatAlert" class="alert alert-error hidden"></div>
      <div class="input-box-row">
        <textarea
          id="chatInput"
          class="chat-textarea"
          placeholder="Ask Lumina a question... (Enter to send, Shift+Enter for newline)"
          rows="1"
        ></textarea>
        <button id="sendBtn" class="send-btn" title="Send message" disabled>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="22" y1="2" x2="11" y2="13"></line>
            <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
          </svg>
        </button>
      </div>
      <div class="input-hints">
        <span id="userInfoText"></span>
        <span>Enter to send</span>
      </div>
    </div>
  </div>

  <script nonce="${nonce}">
    (function () {
      // Global error listener to prevent silent webview script failures
      window.addEventListener("error", (err) => {
        console.error("Lumina webview uncaught error:", err);
      });

      try {
        const vscode = acquireVsCodeApi();

        // DOM Elements
        const loginView = document.getElementById("loginView");
        const loginForm = document.getElementById("loginForm");
        const chatView = document.getElementById("chatView");
        const loginEmail = document.getElementById("loginEmail");
        const loginPassword = document.getElementById("loginPassword");
        const submitLoginBtn = document.getElementById("submitLoginBtn");
        const loginAlert = document.getElementById("loginAlert");
        const backendUrlText = document.getElementById("backendUrlText");
        const logoutBtn = document.getElementById("logoutBtn");
        const settingsBtn = document.getElementById("settingsBtn");
        const tokenBalanceBadge = document.getElementById("tokenBalanceBadge");
        const tokenBalanceCount = document.getElementById("tokenBalanceCount");
        const convBar = document.getElementById("convBar");
        const convSelect = document.getElementById("convSelect");
        const newChatBtn = document.getElementById("newChatBtn");
        const messagesList = document.getElementById("messagesList");
        const emptyChatPlaceholder = document.getElementById("emptyChatPlaceholder");
        const generatingBox = document.getElementById("generatingBox");
        const cancelGenBtn = document.getElementById("cancelGenBtn");
        const chatAlert = document.getElementById("chatAlert");
        const chatInput = document.getElementById("chatInput");
        const sendBtn = document.getElementById("sendBtn");
        const userInfoText = document.getElementById("userInfoText");
        const attachActiveBtn = document.getElementById("attachActiveBtn");
        const attachActiveLabel = document.getElementById("attachActiveLabel");
        const attachWorkspaceBtn = document.getElementById("attachWorkspaceBtn");
        const chipsContainer = document.getElementById("chipsContainer");
        const activeFileNotice = document.getElementById("activeFileNotice");

        let currentConversationId = null;
        let isGenerating = false;
        let isAuthenticating = false;
        let attachedFilesList = [];
        let currentActiveFileName = "";
        let currentStreamingBubble = null;
        let currentStreamingDiv = null;

        // Path helpers avoiding template literal regex escape bugs
        function normalizePath(filePath) {
          if (!filePath) return "";
          var s = String(filePath);
          var driveMatch = s.match(/^[a-zA-Z]:/);
          if (driveMatch) {
            s = s.substring(driveMatch[0].length);
          }
          s = s.split(String.fromCharCode(92)).join("/");
          if (s.startsWith("/")) {
            s = s.substring(1);
          }
          return s;
        }

        function getShortFileName(filePath) {
          if (!filePath) return "";
          var normalized = normalizePath(filePath);
          var parts = normalized.split("/");
          return parts.pop() || normalized;
        }

        function showLoginError(text) {
          if (loginAlert) {
            loginAlert.textContent = text;
            loginAlert.classList.remove("hidden");
          }
        }

        function hideLoginError() {
          if (loginAlert) {
            loginAlert.textContent = "";
            loginAlert.classList.add("hidden");
          }
        }

        function setLoginLoading(loading) {
          isAuthenticating = loading;
          if (submitLoginBtn) {
            submitLoginBtn.disabled = loading;
            submitLoginBtn.textContent = loading ? "Signing In..." : "Sign In";
          }
          if (loginEmail) loginEmail.disabled = loading;
          if (loginPassword) loginPassword.disabled = loading;
        }

        function handleLoginSubmit(e) {
          if (e) {
            if (typeof e.preventDefault === "function") e.preventDefault();
            if (typeof e.stopPropagation === "function") e.stopPropagation();
          }
          if (isAuthenticating) {
            return;
          }

          const email = loginEmail ? loginEmail.value.trim() : "";
          const password = loginPassword ? loginPassword.value : "";

          if (!email || !password) {
            showLoginError("Please enter both email and password.");
            if (!email && loginEmail) {
              loginEmail.focus();
            } else if (!password && loginPassword) {
              loginPassword.focus();
            }
            return;
          }

          hideLoginError();
          setLoginLoading(true);

          vscode.postMessage({
            type: "login",
            email,
            password,
          });
        }

        // Handle messages from extension
        window.addEventListener("message", (event) => {
          const msg = event.data;
          switch (msg.type) {
            case "configUpdate":
              if (backendUrlText) backendUrlText.textContent = msg.backendUrl;
              break;

            case "authState":
              setLoginLoading(false);
              handleAuthState(msg.authenticated, msg.user, msg.tokenBalance);
              break;

            case "authError":
              setLoginLoading(false);
              showLoginError(msg.message || "Failed to log in. Please check your credentials and backend server.");
              if (loginPassword) {
                loginPassword.focus();
                loginPassword.select();
              }
              break;

            case "tokenBalanceUpdate":
              updateTokenBalance(msg.tokenBalance);
              break;

            case "conversationsList":
              renderConversationsList(msg.conversations, msg.selectedConversationId);
              break;

            case "conversationMessages":
              if (msg.conversationId === currentConversationId || !currentConversationId) {
                currentConversationId = msg.conversationId;
                renderMessages(msg.messages);
              }
              break;

            case "messageSending":
              if (msg.conversationId === currentConversationId) {
                appendMessage(msg.tempUserMessage);
                setGeneratingState(true);
              }
              break;

            case "messageDelta":
              if (msg.conversationId === currentConversationId) {
                handleStreamingDelta(msg.delta);
              }
              break;

            case "messageSuccess":
              setGeneratingState(false);
              if (msg.conversationId === currentConversationId) {
                if (currentStreamingDiv && currentStreamingDiv.parentNode === messagesList) {
                  messagesList.removeChild(currentStreamingDiv);
                }
                currentStreamingBubble = null;
                currentStreamingDiv = null;
                appendMessage(msg.assistantMessage, msg.proposedEdits);
                if (msg.tokenBalance) {
                  updateTokenBalance(msg.tokenBalance);
                }
              }
              break;

            case "messageError":
              setGeneratingState(false);
              if (currentStreamingDiv && !currentStreamingBubble?.textContent) {
                if (currentStreamingDiv.parentNode === messagesList) {
                  messagesList.removeChild(currentStreamingDiv);
                }
              }
              currentStreamingBubble = null;
              currentStreamingDiv = null;
              showChatError(msg.error);
              break;

            case "attachedFilesUpdate":
              renderAttachedFiles(msg.files);
              break;

            case "activeFileNotice":
              if (activeFileNotice) {
                currentActiveFileName = msg.fileName || "";
                const shortName = getShortFileName(currentActiveFileName);
                activeFileNotice.textContent = shortName ? shortName : "";
                if (attachActiveLabel) {
                  const isAttached = attachedFilesList.some((f) => f.relativePath === currentActiveFileName);
                  attachActiveLabel.textContent = isAttached
                    ? "✔ " + shortName + " Attached"
                    : shortName ? "Attach " + shortName : "Attach Active File";
                }
              }
              break;

            case "editStatusUpdate":
              handleEditStatusUpdate(msg.editId, msg.status, msg.message);
              break;
          }
        });

        function handleAuthState(authenticated, user, tokenBalance) {
          setLoginLoading(false);
          if (authenticated) {
            if (loginView) loginView.classList.add("hidden");
            if (chatView) chatView.classList.remove("hidden");
            if (convBar) convBar.classList.remove("hidden");
            if (logoutBtn) logoutBtn.classList.remove("hidden");
            if (tokenBalanceBadge) tokenBalanceBadge.classList.remove("hidden");

            if (userInfoText && user) {
              userInfoText.textContent = user.name + (user.plan ? " (" + user.plan + ")" : "");
            }
            if (tokenBalance) {
              updateTokenBalance(tokenBalance);
            }
            hideLoginError();
          } else {
            if (loginView) loginView.classList.remove("hidden");
            if (chatView) chatView.classList.add("hidden");
            if (convBar) convBar.classList.add("hidden");
            if (logoutBtn) logoutBtn.classList.add("hidden");
            if (tokenBalanceBadge) tokenBalanceBadge.classList.add("hidden");
            if (messagesList) {
              messagesList.innerHTML = "";
              if (emptyChatPlaceholder) {
                messagesList.appendChild(emptyChatPlaceholder);
              }
            }
          }
        }

        function updateTokenBalance(tokenBalance) {
          if (tokenBalanceCount && tokenBalance && typeof tokenBalance.balance === "number") {
            tokenBalanceCount.textContent = tokenBalance.balance.toLocaleString();
          }
        }

        function showChatError(text) {
          if (chatAlert) {
            chatAlert.textContent = text;
            chatAlert.classList.remove("hidden");
            setTimeout(() => {
              chatAlert.classList.add("hidden");
            }, 8000);
          }
        }

        function setGeneratingState(generating) {
          isGenerating = generating;
          if (sendBtn) sendBtn.disabled = generating || (chatInput ? chatInput.value.trim().length === 0 : true);
          if (chatInput) chatInput.disabled = generating;

          if (generating) {
            if (generatingBox) generatingBox.classList.remove("hidden");
          } else {
            if (generatingBox) generatingBox.classList.add("hidden");
            if (chatInput) chatInput.focus();
          }
          scrollToBottom();
        }

        function handleStreamingDelta(delta) {
          if (!messagesList) return;
          if (!currentStreamingBubble) {
            if (emptyChatPlaceholder && emptyChatPlaceholder.parentNode === messagesList) {
              messagesList.removeChild(emptyChatPlaceholder);
            }
            currentStreamingDiv = document.createElement("div");
            currentStreamingDiv.className = "message assistant streaming";
            const meta = document.createElement("div");
            meta.className = "message-meta";
            meta.textContent = "Lumina";
            currentStreamingBubble = document.createElement("div");
            currentStreamingBubble.className = "message-bubble";
            currentStreamingDiv.appendChild(meta);
            currentStreamingDiv.appendChild(currentStreamingBubble);
            messagesList.appendChild(currentStreamingDiv);
          }
          currentStreamingBubble.textContent += delta;
          scrollToBottom();
        }

        function renderAttachedFiles(files) {
          attachedFilesList = files || [];
          if (!chipsContainer) return;
          chipsContainer.innerHTML = "";

          if (attachActiveLabel && currentActiveFileName) {
            const shortName = getShortFileName(currentActiveFileName);
            const isAttached = attachedFilesList.some((f) => f.relativePath === currentActiveFileName);
            attachActiveLabel.textContent = isAttached
              ? "✔ " + shortName + " Attached"
              : "Attach " + shortName;
          }

          if (attachedFilesList.length === 0) {
            chipsContainer.classList.add("hidden");
            return;
          }

          chipsContainer.classList.remove("hidden");
          attachedFilesList.forEach((f) => {
            const chip = document.createElement("span");
            chip.className = "chip";
            const shortName = getShortFileName(f.relativePath);
            const sizeKb = Math.round(f.size / 1024) || 1;
            chip.textContent = "📄 " + shortName + " (" + sizeKb + "KB)";

            const removeBtn = document.createElement("span");
            removeBtn.className = "chip-remove";
            removeBtn.textContent = "×";
            removeBtn.title = "Remove";
            removeBtn.addEventListener("click", () => {
              vscode.postMessage({ type: "removeAttachedFile", relativePath: f.relativePath });
            });

            chip.appendChild(removeBtn);
            chipsContainer.appendChild(chip);
          });
        }

        function renderConversationsList(conversations, selectedId) {
          if (!convSelect) return;
          convSelect.innerHTML = "";
          currentConversationId = selectedId || null;

          if (!conversations || conversations.length === 0) {
            const opt = document.createElement("option");
            opt.value = "";
            opt.textContent = "No conversations";
            convSelect.appendChild(opt);
            return;
          }

          conversations.forEach((conv) => {
            const opt = document.createElement("option");
            opt.value = conv.id;
            opt.textContent = conv.title || "Chat";
            if (conv.id === selectedId) {
              opt.selected = true;
            }
            convSelect.appendChild(opt);
          });
        }

        function renderMessages(messages) {
          if (!messagesList) return;
          messagesList.innerHTML = "";
          if (!messages || messages.length === 0) {
            if (emptyChatPlaceholder) {
              messagesList.appendChild(emptyChatPlaceholder);
            }
            return;
          }

          messages.forEach((m) => appendMessage(m));
          scrollToBottom();
        }

        function appendMessage(msg, proposedEdits) {
          if (!messagesList) return;
          if (emptyChatPlaceholder && emptyChatPlaceholder.parentNode === messagesList) {
            messagesList.removeChild(emptyChatPlaceholder);
          }

          const msgDiv = document.createElement("div");
          msgDiv.className = "message " + (msg.role === "user" ? "user" : "assistant");

          const meta = document.createElement("div");
          meta.className = "message-meta";
          meta.textContent = msg.role === "user" ? "You" : "Lumina";

          let contentText = msg.content || (msg.errorMessage ? "[Error: " + msg.errorMessage + "]" : "");
          let contextFiles = msg.contextFiles ? [...msg.contextFiles] : [];

          // If user message has legacy [Active context: ...] prefix, extract it cleanly
          if (msg.role === "user" && contentText.startsWith("[Active context:")) {
            const endBracketIdx = contentText.indexOf("]" + String.fromCharCode(10, 10));
            if (endBracketIdx !== -1) {
              const rawTags = contentText.substring(16, endBracketIdx);
              const parsedTags = rawTags.split(",").map((t) => t.split(String.fromCharCode(96)).join("").replace(/[()]/g, "").trim()).filter(Boolean);
              if (parsedTags.length > 0 && contextFiles.length === 0) {
                contextFiles = parsedTags;
              }
              contentText = contentText.substring(endBracketIdx + 3).trim();
            }
          }

          // If message has [WORKSPACE CONTEXT] block from historical database records, extract cleanly
          if (msg.role === "user" && contentText.includes("[WORKSPACE CONTEXT]")) {
            const queryMarker = "User Query:" + String.fromCharCode(10);
            const queryIndex = contentText.indexOf(queryMarker);
            if (queryIndex !== -1) {
              const contextPart = contentText.substring(0, queryIndex);
              const lines = contextPart.split(String.fromCharCode(10));
              const foundFiles = [];
              for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed.startsWith("File:")) {
                  const btChar = String.fromCharCode(96);
                  const firstBt = trimmed.indexOf(btChar);
                  const lastBt = trimmed.lastIndexOf(btChar);
                  if (firstBt !== -1 && lastBt > firstBt) {
                    const extractedFile = trimmed.substring(firstBt + 1, lastBt).trim();
                    if (extractedFile) {
                      foundFiles.push(extractedFile);
                    }
                  }
                }
              }
              if (foundFiles.length > 0 && contextFiles.length === 0) {
                contextFiles = foundFiles;
              }
              contentText = contentText.substring(queryIndex + queryMarker.length).trim();
            }
          }

          // Render subtle separate context indicator if context files were actually used
          if (contextFiles.length > 0) {
            const ctxDiv = document.createElement("div");
            ctxDiv.className = "context-indicator";
            const label = document.createElement("span");
            label.textContent = "Using context: ";
            ctxDiv.appendChild(label);

            contextFiles.forEach((file) => {
              const cleanPath = normalizePath(file);
              const tag = document.createElement("span");
              tag.className = "context-tag";
              tag.textContent = cleanPath;
              ctxDiv.appendChild(tag);
            });
            msgDiv.appendChild(ctxDiv);
          }

          const bubble = document.createElement("div");
          bubble.className = "message-bubble";

          // Strip out raw edit block from the visible bubble if proposedEdits are rendered as cards
          if (proposedEdits && proposedEdits.length > 0) {
            const tripleBt = String.fromCharCode(96, 96, 96);
            const blockTags = [tripleBt + "nexamind-edit", tripleBt + "json:nexamind-edit"];
            for (const tag of blockTags) {
              let startIdx = contentText.indexOf(tag);
              while (startIdx !== -1) {
                const endIdx = contentText.indexOf(tripleBt, startIdx + tag.length);
                if (endIdx !== -1) {
                  contentText = (contentText.substring(0, startIdx) + contentText.substring(endIdx + 3)).trim();
                  startIdx = contentText.indexOf(tag);
                } else {
                  break;
                }
              }
            }
          }

          bubble.textContent = contentText;
          msgDiv.appendChild(meta);
          msgDiv.appendChild(bubble);

          // Render proposed edit cards if present
          if (proposedEdits && proposedEdits.length > 0) {
            proposedEdits.forEach((edit) => {
              const card = createProposalCard(edit);
              msgDiv.appendChild(card);
            });
          }

          messagesList.appendChild(msgDiv);
          scrollToBottom();
        }

        function createProposalCard(edit) {
          const card = document.createElement("div");
          card.className = "proposal-card";
          card.id = "card-" + edit.id;

          const header = document.createElement("div");
          header.className = "proposal-header";

          const fileSpan = document.createElement("span");
          fileSpan.className = "proposal-file";
          fileSpan.textContent = "📄 " + edit.filePath;

          const badge = document.createElement("span");
          badge.className = "proposal-badge " + edit.status;
          badge.id = "badge-" + edit.id;
          badge.textContent = edit.status === "applied" ? "Applied" : edit.status === "rejected" ? "Discarded" : "Proposed Change";

          header.appendChild(fileSpan);
          header.appendChild(badge);

          const desc = document.createElement("div");
          desc.className = "proposal-desc";
          desc.textContent = edit.description || "Proposed modifications";

          const actions = document.createElement("div");
          actions.className = "proposal-actions";
          actions.id = "actions-" + edit.id;

          if (edit.status === "pending") {
            const diffBtn = document.createElement("button");
            diffBtn.className = "btn btn-secondary";
            diffBtn.textContent = "🔍 View Diff";
            diffBtn.addEventListener("click", () => {
              vscode.postMessage({ type: "openDiff", editId: edit.id });
            });

            const applyBtn = document.createElement("button");
            applyBtn.className = "btn";
            applyBtn.textContent = "✔ Approve & Apply";
            applyBtn.addEventListener("click", () => {
              vscode.postMessage({ type: "applyEdit", editId: edit.id });
            });

            const rejectBtn = document.createElement("button");
            rejectBtn.className = "btn btn-secondary";
            rejectBtn.textContent = "✖ Discard";
            rejectBtn.addEventListener("click", () => {
              vscode.postMessage({ type: "rejectEdit", editId: edit.id });
            });

            actions.appendChild(diffBtn);
            actions.appendChild(applyBtn);
            actions.appendChild(rejectBtn);
          }

          card.appendChild(header);
          card.appendChild(desc);
          card.appendChild(actions);

          return card;
        }

        function handleEditStatusUpdate(editId, status, message) {
          const badge = document.getElementById("badge-" + editId);
          const actions = document.getElementById("actions-" + editId);

          if (badge) {
            badge.className = "proposal-badge " + status;
            badge.textContent = status === "applied" ? "✔ Applied & Saved" : "✖ Discarded";
          }

          if (actions) {
            actions.innerHTML = "";
            const statusText = document.createElement("span");
            statusText.style.fontSize = "11px";
            statusText.style.opacity = "0.8";
            statusText.textContent = message || (status === "applied" ? "Changes saved to workspace." : "Proposal discarded.");
            actions.appendChild(statusText);
          }
        }

        function scrollToBottom() {
          if (messagesList) {
            messagesList.scrollTop = messagesList.scrollHeight;
          }
        }

        // Attach Login and Form Event Listeners
        if (loginForm) {
          loginForm.addEventListener("submit", handleLoginSubmit);
        }

        if (submitLoginBtn) {
          submitLoginBtn.addEventListener("click", handleLoginSubmit);
        }

        if (loginPassword) {
          loginPassword.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              handleLoginSubmit(e);
            }
          });
        }

        if (loginEmail) {
          loginEmail.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (loginPassword && !loginPassword.value) {
                loginPassword.focus();
              } else {
                handleLoginSubmit(e);
              }
            }
          });
        }

        if (logoutBtn) {
          logoutBtn.addEventListener("click", () => {
            vscode.postMessage({ type: "logout" });
          });
        }

        if (settingsBtn) {
          settingsBtn.addEventListener("click", () => {
            vscode.postMessage({ type: "openSettings" });
          });
        }

        if (tokenBalanceBadge) {
          tokenBalanceBadge.addEventListener("click", () => {
            vscode.postMessage({ type: "refreshTokenBalance" });
          });
        }

        if (convSelect) {
          convSelect.addEventListener("change", (e) => {
            const convId = e.target.value;
            if (convId) {
              currentConversationId = convId;
              vscode.postMessage({ type: "selectConversation", conversationId: convId });
            }
          });
        }

        if (newChatBtn) {
          newChatBtn.addEventListener("click", () => {
            vscode.postMessage({ type: "createConversation" });
          });
        }

        if (attachActiveBtn) {
          attachActiveBtn.addEventListener("click", () => {
            vscode.postMessage({
              type: "attachActiveFile",
              relativePath: currentActiveFileName || undefined,
            });
          });
        }

        if (attachWorkspaceBtn) {
          attachWorkspaceBtn.addEventListener("click", () => {
            vscode.postMessage({ type: "attachWorkspaceFiles" });
          });
        }

        if (chatInput) {
          chatInput.addEventListener("input", () => {
            if (sendBtn) sendBtn.disabled = isGenerating || chatInput.value.trim().length === 0;
            chatInput.style.height = "auto";
            chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + "px";
          });

          chatInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              sendMessage();
            }
          });
        }

        if (sendBtn) {
          sendBtn.addEventListener("click", () => {
            sendMessage();
          });
        }

        if (cancelGenBtn) {
          cancelGenBtn.addEventListener("click", () => {
            vscode.postMessage({ type: "cancelGeneration" });
          });
        }

        function sendMessage() {
          if (!chatInput) return;
          const content = chatInput.value.trim();
          if (!content || isGenerating) return;

          chatInput.value = "";
          chatInput.style.height = "auto";
          if (sendBtn) sendBtn.disabled = true;

          vscode.postMessage({
            type: "sendMessage",
            conversationId: currentConversationId || "",
            content,
            attachedFiles: attachedFilesList,
          });
        }

        // Initial check
        vscode.postMessage({ type: "checkAuth" });
      } catch (initErr) {
        console.error("Lumina webview script initialization failed:", initErr);
      }
    })();
  </script>
</body>
</html>`;
  }

  public getHtmlForWebview(webview: { cspSource: string }): string {
    return this._getHtmlForWebview(webview as vscode.Webview);
  }
}

function getNonce(): string {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
