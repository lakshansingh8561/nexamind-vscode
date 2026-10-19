import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as vm from "node:vm";
import { NexamindClient, NexamindApiError } from "../src/api/nexamindClient.js";
import { AuthManager } from "../src/auth/authManager.js";
import { ChatViewProvider } from "../src/chat/chatViewProvider.js";

describe("Login Flow & Webview Script Integrity", () => {
  it("renders webview HTML with proper login elements, CSP, and form structure", () => {
    // Create a dummy ChatViewProvider instance with mock dependencies
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

    // Validate CSP
    assert.match(html, /<meta http-equiv="Content-Security-Policy"/);
    assert.match(html, /script-src 'nonce-[A-Za-z0-9]+'/);

    // Validate Login Elements
    assert.match(html, /id="loginView"/);
    assert.match(html, /id="loginForm"/);
    assert.match(html, /id="loginEmail"/);
    assert.match(html, /id="loginPassword"/);
    assert.match(html, /id="submitLoginBtn"/);
    assert.match(html, /id="loginAlert"/);
    assert.match(html, /id="backendUrlText"/);

    // Validate Lumina branding in UI
    assert.match(html, /<title>Lumina Chat<\/title>/);
    assert.match(html, /<span>Lumina AI<\/span>/);
    assert.match(html, /<div class="login-title">Sign in to Lumina<\/div>/);
    assert.match(html, /<div class="login-subtitle">Connect your Lumina AI account to chat in VS Code<\/div>/);
    assert.match(html, /Ask Lumina anything about your code/);
    assert.match(html, /<span>Lumina is thinking\.\.\.<\/span>/);
    assert.match(html, /placeholder="Ask Lumina a question\.\.\. \(Enter to send, Shift\+Enter for newline\)"/);

    // Validate that the script inside HTML compiles cleanly with zero syntax errors
    const scriptMatch = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/);
    assert.ok(scriptMatch, "Webview script tag must be present");
    const scriptCode = scriptMatch[1];

    // vm.Script compiles JavaScript in V8; will throw SyntaxError if any syntax or escaping is broken
    assert.doesNotThrow(() => {
      new vm.Script(scriptCode);
    }, "The webview script must be syntactically valid and parse cleanly in V8");
  });

  it("AuthManager stores token in SecretStorage and fires onAuthStateChanged on login", async () => {
    let storedKey = "";
    let storedVal = "";
    const mockSecrets = {
      get: async (key: string) => (key === storedKey ? storedVal : undefined),
      store: async (key: string, value: string) => {
        storedKey = key;
        storedVal = value;
      },
      delete: async (key: string) => {
        if (storedKey === key) {
          storedKey = "";
          storedVal = "";
        }
      },
    };

    const client = new NexamindClient("http://mock-backend:5000");

    // Mock fetch for /api/auth/login and /api/tokens/balance
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url: any, init: any) => {
      const urlStr = String(url);
      if (urlStr.endsWith("/api/auth/login")) {
        const body = JSON.parse(init.body);
        assert.equal(body.email, "test@example.com");
        return new Response(
          JSON.stringify({
            success: true,
            message: "Login successful",
            data: {
              token: "mock-jwt-token-xyz",
              user: {
                id: "user-123",
                name: "Test User",
                email: "test@example.com",
                plan: "Pro",
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (urlStr.endsWith("/api/tokens/balance")) {
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              balance: 1000,
              used: 250,
              planMonthlyLimit: 50000,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      throw new Error("Unhandled endpoint: " + urlStr);
    };

    try {
      const authManager = new AuthManager({ secrets: mockSecrets } as any, client);

      let authEventFired = false;
      authManager.onAuthStateChanged((evt) => {
        if (evt.authenticated && evt.user?.email === "test@example.com") {
          authEventFired = true;
        }
      });

      const user = await authManager.login("test@example.com", "Password123!");
      assert.equal(user.name, "Test User");
      assert.equal(storedKey, "nexamind.jwt_token");
      assert.equal(storedVal, "mock-jwt-token-xyz");
      assert.equal(authEventFired, true);

      // Verify token retrieval
      const retrievedToken = await authManager.getToken();
      assert.equal(retrievedToken, "mock-jwt-token-xyz");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("NexamindClient handles login failure and connection error with descriptive messages", async () => {
    const client = new NexamindClient("http://mock-backend:5000");

    const originalFetch = globalThis.fetch;

    // Test 1: 401 invalid credentials
    globalThis.fetch = async () => {
      return new Response(
        JSON.stringify({
          success: false,
          message: "Invalid email or password",
        }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    };

    try {
      await client.login("wrong@example.com", "wrongpass");
      assert.fail("Should have thrown error");
    } catch (err: any) {
      assert.equal(err instanceof NexamindApiError, true);
      assert.equal(err.statusCode, 401);
      assert.equal(err.isAuthError, true);
      assert.equal(err.message, "Invalid email or password");
    }

    // Test 2: Network refused connection
    globalThis.fetch = async () => {
      const netErr: any = new Error("fetch failed");
      netErr.cause = { code: "ECONNREFUSED" };
      throw netErr;
    };

    try {
      await client.login("wrong@example.com", "wrongpass");
      assert.fail("Should have thrown network error");
    } catch (err: any) {
      assert.equal(err instanceof NexamindApiError, true);
      assert.equal(err.isConnectionError, true);
      assert.match(err.message, /Cannot connect to Lumina backend/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
