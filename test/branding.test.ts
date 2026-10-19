import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { NexamindClient } from "../src/api/nexamindClient.js";
import { AuthManager } from "../src/auth/authManager.js";
import { ChatViewProvider } from "../src/chat/chatViewProvider.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe("Lumina Visible Branding and Identity Preservation", () => {
  const pkgPath = path.resolve(__dirname, "../package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));

  it("package.json visible branding is Lumina while technical identifier is preserved", () => {
    // Technical identity preserved
    assert.equal(pkg.name, "nexamind-vscode", "Package technical name must remain nexamind-vscode");

    // Visible branding updated to Lumina
    assert.equal(pkg.displayName, "Lumina AI", "Extension displayName must be Lumina AI");
    assert.match(pkg.description, /Lumina/, "Description must refer to Lumina");

    // Activity bar and view titles
    assert.equal(
      pkg.contributes.viewsContainers.activitybar[0].title,
      "Lumina",
      "Activity bar container title must be Lumina"
    );
    assert.equal(
      pkg.contributes.views["nexamind-sidebar"][0].name,
      "Lumina Chat",
      "Chat view title must be Lumina Chat"
    );

    // Commands have Lumina visible titles while IDs are preserved
    const commands = pkg.contributes.commands;
    assert.ok(commands.length >= 7, "All commands must be present");

    for (const cmd of commands) {
      assert.ok(
        cmd.command.startsWith("nexamind."),
        `Command ID ${cmd.command} must preserve nexamind prefix for backward compatibility`
      );
      assert.equal(
        cmd.category,
        "Lumina",
        `Command ${cmd.command} category must be Lumina`
      );
      assert.ok(
        cmd.title.startsWith("Lumina:"),
        `Command ${cmd.command} visible title must start with 'Lumina:' (got: ${cmd.title})`
      );
    }

    // Configuration section
    assert.equal(
      pkg.contributes.configuration.title,
      "Lumina",
      "Configuration section title must be Lumina"
    );
    assert.ok(
      pkg.contributes.configuration.properties["nexamind.backendUrl"],
      "nexamind.backendUrl configuration property key must be preserved"
    );
  });

  it("chat webview renders Lumina branding across all visible UI states", () => {
    const mockUri = { fsPath: "/mock/ext", scheme: "file" } as any;
    const client = new NexamindClient("http://localhost:5000");
    const mockSecrets = {
      get: async () => undefined,
      store: async () => {},
      delete: async () => {},
    };
    const mockContext = { secrets: mockSecrets } as any;
    const authManager = new AuthManager(mockContext, client);
    const mockWorkspaceManager = {
      setLastActiveEditor: () => {},
      getEffectiveActiveEditor: () => undefined,
      getWorkspaceRoot: () => undefined,
    } as any;
    const mockDiffProvider = {} as any;
    const mockEditManager = {} as any;

    const provider = new ChatViewProvider(
      mockUri,
      client,
      authManager,
      mockWorkspaceManager,
      mockDiffProvider,
      mockEditManager
    );

    const html = provider.getHtmlForWebview({ cspSource: "vscode-webview-resource:" });

    // Verify title and header branding
    assert.match(html, /<title>Lumina Chat<\/title>/);
    assert.match(html, /<span>Lumina AI<\/span>/);

    // Verify sign in branding
    assert.match(html, /<div class="login-title">Sign in to Lumina<\/div>/);
    assert.match(html, /<div class="login-subtitle">Connect your Lumina AI account to chat in VS Code<\/div>/);

    // Verify empty state and input placeholder
    assert.match(html, /Ask Lumina anything about your code/);
    assert.match(html, /<span>Lumina is thinking\.\.\.<\/span>/);
    assert.match(html, /placeholder="Ask Lumina a question\.\.\./);

    // Ensure no legacy user-facing assistant branding remains in rendered UI
    assert.doesNotMatch(html, /NexaMind AI/);
    assert.doesNotMatch(html, /NexaMind Chat/);
    assert.doesNotMatch(html, /Sign in to NexaMind/);
    assert.doesNotMatch(html, /Ask NexaMind/);
  });
});
