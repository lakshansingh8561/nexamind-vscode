import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { NexamindClient, NexamindApiError } from "../src/api/nexamindClient.js";

describe("NexamindClient", () => {
  it("normalizes base URL and trims trailing slashes", () => {
    const client = new NexamindClient("http://localhost:5000/ ");
    assert.equal(client.getBaseUrl(), "http://localhost:5000");

    client.setBaseUrl("https://api.example.com///");
    assert.equal(client.getBaseUrl(), "https://api.example.com");

    client.setBaseUrl("");
    assert.equal(client.getBaseUrl(), "http://localhost:5000");
  });

  it("handles successful health check", async () => {
    const client = new NexamindClient("http://mock-backend:5000");

    // Mock globalThis.fetch
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url: any) => {
      assert.equal(url, "http://mock-backend:5000/api/health");
      return new Response(JSON.stringify({ success: true, message: "AI Agent API is running" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    try {
      const isHealthy = await client.healthCheck();
      assert.equal(isHealthy, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("handles failed health check gracefully", async () => {
    const client = new NexamindClient("http://mock-backend:5000");

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("fetch failed");
    };

    try {
      const isHealthy = await client.healthCheck();
      assert.equal(isHealthy, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("sends login request with normalized email and returns token/user", async () => {
    const client = new NexamindClient("http://mock-backend:5000");

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url: any, init: any) => {
      assert.equal(url, "http://mock-backend:5000/api/auth/login");
      assert.equal(init.method, "POST");
      const body = JSON.parse(init.body);
      assert.equal(body.email, "dev@nexamind.ai");
      assert.equal(body.password, "SecretPass123");

      return new Response(
        JSON.stringify({
          success: true,
          message: "Login successful",
          data: {
            token: "jwt-test-token-xyz",
            user: {
              id: "user-123",
              name: "Test Dev",
              email: "dev@nexamind.ai",
              role: "user",
              plan: "pro",
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    try {
      const data = await client.login("  Dev@NexaMind.AI  ", "SecretPass123");
      assert.equal(data.token, "jwt-test-token-xyz");
      assert.equal(data.user.name, "Test Dev");
      assert.equal(data.user.plan, "pro");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("throws NexamindApiError on 401 Unauthorized", async () => {
    const client = new NexamindClient("http://mock-backend:5000");

    const originalFetch = globalThis.fetch;
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
      await assert.rejects(
        async () => {
          await client.login("wrong@user.com", "badpassword");
        },
        (err: any) => {
          assert.equal(err instanceof NexamindApiError, true);
          assert.equal(err.statusCode, 401);
          assert.equal(err.isAuthError, true);
          assert.equal(err.message, "Invalid email or password");
          return true;
        }
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("throws NexamindApiError with isTokenExhaustedError on 402", async () => {
    const client = new NexamindClient("http://mock-backend:5000");

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      return new Response(
        JSON.stringify({
          success: false,
          message: "Token balance exhausted",
        }),
        { status: 402, headers: { "Content-Type": "application/json" } }
      );
    };

    try {
      await assert.rejects(
        async () => {
          await client.sendMessage("token", "conv-1", "Hello");
        },
        (err: any) => {
          assert.equal(err instanceof NexamindApiError, true);
          assert.equal(err.statusCode, 402);
          assert.equal(err.isTokenExhaustedError, true);
          assert.equal(err.message, "Token balance exhausted");
          return true;
        }
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("sends message with Bearer token and Idempotency-Key", async () => {
    const client = new NexamindClient("http://mock-backend:5000");

    const originalFetch = globalThis.fetch;
    let capturedHeaders: any = null;
    let capturedBody: any = null;

    globalThis.fetch = async (url: any, init: any) => {
      assert.equal(url, "http://mock-backend:5000/api/chat/conversations/conv-abc-123/messages");
      assert.equal(init.method, "POST");
      capturedHeaders = init.headers;
      capturedBody = JSON.parse(init.body);

      return new Response(
        JSON.stringify({
          success: true,
          message: "Message processed successfully",
          data: {
            userMessage: {
              id: "msg-user-1",
              conversationId: "conv-abc-123",
              role: "user",
              content: "Explain TypeScript generics",
              status: "completed",
              createdAt: "2026-10-16T00:00:00.000Z",
            },
            assistantMessage: {
              id: "msg-ai-1",
              conversationId: "conv-abc-123",
              role: "assistant",
              content: "Generics allow you to write reusable, type-safe components.",
              status: "completed",
              createdAt: "2026-10-16T00:00:01.000Z",
            },
          },
        }),
        { status: 201, headers: { "Content-Type": "application/json" } }
      );
    };

    try {
      const res = await client.sendMessage(
        "auth-token-123",
        "conv-abc-123",
        "Explain TypeScript generics",
        "idemp-key-xyz"
      );

      assert.equal(capturedHeaders["Authorization"], "Bearer auth-token-123");
      assert.equal(capturedHeaders["Idempotency-Key"], "idemp-key-xyz");
      assert.equal(capturedBody.content, "Explain TypeScript generics");
      assert.equal(res.assistantMessage.role, "assistant");
      assert.equal(res.assistantMessage.content.includes("Generics"), true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("fetches token balance with Bearer token", async () => {
    const client = new NexamindClient("http://mock-backend:5000");

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url: any, init: any) => {
      assert.equal(url, "http://mock-backend:5000/api/tokens/balance");
      assert.equal(init.headers["Authorization"], "Bearer auth-token-123");

      return new Response(
        JSON.stringify({
          success: true,
          message: "Token balance retrieved successfully",
          data: {
            balance: 8500,
            reservedTokens: 0,
            totalAllocated: 10000,
            totalUsed: 1500,
            lastAllocatedPlan: "free",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    try {
      const balance = await client.getTokenBalance("auth-token-123");
      assert.equal(balance.balance, 8500);
      assert.equal(balance.totalUsed, 1500);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
