import * as vscode from "vscode";
import { NexamindClient } from "./api/nexamindClient.js";
import { AuthManager } from "./auth/authManager.js";
import { ChatViewProvider } from "./chat/chatViewProvider.js";
import { WorkspaceManager } from "./workspace/workspaceManager.js";
import { DiffContentProvider } from "./workspace/diffProvider.js";
import { EditManager } from "./workspace/editManager.js";

export function activate(context: vscode.ExtensionContext): void {
  // 1. Read initial configuration
  const config = vscode.workspace.getConfiguration("nexamind");
  const initialBackendUrl = config.get<string>("backendUrl") || "http://localhost:5000";

  // 2. Instantiate core services
  const client = new NexamindClient(initialBackendUrl);
  const authManager = new AuthManager(context, client);
  const workspaceManager = new WorkspaceManager();
  const diffProvider = new DiffContentProvider();
  const editManager = new EditManager(workspaceManager, diffProvider);

  // 3. Register Virtual Diff Content Provider
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      DiffContentProvider.scheme,
      diffProvider
    )
  );

  // 4. Instantiate and Register Webview View Provider
  const chatViewProvider = new ChatViewProvider(
    context.extensionUri,
    client,
    authManager,
    workspaceManager,
    diffProvider,
    editManager
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ChatViewProvider.viewType,
      chatViewProvider,
      {
        webviewOptions: {
          retainContextWhenHidden: true,
        },
      }
    )
  );

  // 5. Register Core and Workspace Commands
  context.subscriptions.push(
    vscode.commands.registerCommand("nexamind.openChat", async () => {
      await vscode.commands.executeCommand("nexamind.chatView.focus");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("nexamind.newChat", async () => {
      await chatViewProvider.createNewChat();
      await vscode.commands.executeCommand("nexamind.chatView.focus");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("nexamind.analyzeActiveFile", async () => {
      await chatViewProvider.attachActiveFile();
      await vscode.commands.executeCommand("nexamind.chatView.focus");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("nexamind.addFilesToContext", async () => {
      await chatViewProvider.attachWorkspaceFiles();
      await vscode.commands.executeCommand("nexamind.chatView.focus");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("nexamind.login", async () => {
      const email = await vscode.window.showInputBox({
        title: "Lumina Login",
        prompt: "Enter your Lumina account email",
        placeHolder: "user@example.com",
        ignoreFocusOut: true,
      });

      if (!email) return;

      const password = await vscode.window.showInputBox({
        title: "Lumina Login",
        prompt: "Enter your password",
        password: true,
        ignoreFocusOut: true,
      });

      if (!password) return;

      try {
        const user = await authManager.login(email, password);
        vscode.window.showInformationMessage(`Successfully logged in to Lumina as ${user.name}`);
        await vscode.commands.executeCommand("nexamind.chatView.focus");
      } catch (err: any) {
        vscode.window.showErrorMessage(`Login failed: ${err?.message || err}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("nexamind.logout", async () => {
      await authManager.logout();
      vscode.window.showInformationMessage("Logged out from Lumina.");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("nexamind.setBackendUrl", async () => {
      const currentUrl = client.getBaseUrl();
      const input = await vscode.window.showInputBox({
        title: "Lumina Backend URL",
        prompt: "Configure the base URL of your Lumina backend",
        value: currentUrl,
        ignoreFocusOut: true,
        validateInput: (value) => {
          if (!value || !value.trim()) {
            return "URL cannot be empty";
          }
          if (!value.startsWith("http://") && !value.startsWith("https://")) {
            return "URL must start with http:// or https://";
          }
          return null;
        },
      });

      if (input && input !== currentUrl) {
        await vscode.workspace
          .getConfiguration("nexamind")
          .update("backendUrl", input.trim(), vscode.ConfigurationTarget.Global);
        chatViewProvider.updateBackendUrl(input.trim());
        vscode.window.showInformationMessage(`Lumina backend URL updated to ${input.trim()}`);
      }
    })
  );

  // 6. Watch for settings updates
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("nexamind.backendUrl")) {
        const newUrl =
          vscode.workspace.getConfiguration("nexamind").get<string>("backendUrl") ||
          "http://localhost:5000";
        chatViewProvider.updateBackendUrl(newUrl);
      }
    })
  );

  // 7. Validate existing session in background
  authManager.validateSession().catch(() => {});
}

export function deactivate(): void {
  // Clean up if needed
}
