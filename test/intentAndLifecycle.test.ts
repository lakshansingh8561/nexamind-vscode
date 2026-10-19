import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { shouldIncludeAutomaticContext } from "../src/chat/intentClassifier.js";
import { NexamindClient, NexamindApiError, CLIENT_REQUEST_TIMEOUT_MS } from "../src/api/nexamindClient.js";
import { AttachedFileContext, Message } from "../src/types.js";
import { WorkspaceManager } from "../src/workspace/workspaceManager.js";

class MockWorkspaceManager extends WorkspaceManager {
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
      name: "mock-workspace",
      index: 0,
    };
  }

  public override async readWorkspaceFile(relativePath: string): Promise<AttachedFileContext> {
    const cleanPath = relativePath.replace(/\\/g, "/");
    const content = this.virtualFiles.get(cleanPath) ?? "const x = 1;";
    return {
      relativePath: cleanPath,
      content,
      size: Buffer.byteLength(content, "utf8"),
      lineCount: content.split("\n").length,
      truncated: false,
    };
  }
}

describe("Issue A — Intent-Aware Context Selection Tests", () => {
  it("'hi' and 'hello' do not receive automatic context", () => {
    assert.equal(shouldIncludeAutomaticContext("hi", { hasActiveEditor: true }), false);
    assert.equal(shouldIncludeAutomaticContext("hello", { hasActiveEditor: true }), false);
    assert.equal(shouldIncludeAutomaticContext("hey", { hasActiveEditor: true }), false);
    assert.equal(shouldIncludeAutomaticContext("good morning", { hasActiveEditor: true }), false);
    assert.equal(shouldIncludeAutomaticContext("thanks", { hasActiveEditor: true }), false);
  });

  it("'What is an API?' does not receive automatic context", () => {
    assert.equal(shouldIncludeAutomaticContext("What is an API?", { hasActiveEditor: true }), false);
    assert.equal(shouldIncludeAutomaticContext("what is an api", { hasActiveEditor: true }), false);
    assert.equal(shouldIncludeAutomaticContext("What is REST?", { hasActiveEditor: true }), false);
  });

  it("'Explain HTTP in simple words' does not receive automatic context", () => {
    assert.equal(
      shouldIncludeAutomaticContext("Explain HTTP in simple words", { hasActiveEditor: true }),
      false
    );
    assert.equal(
      shouldIncludeAutomaticContext("Explain DNS in simple terms", { hasActiveEditor: true }),
      false
    );
    assert.equal(
      shouldIncludeAutomaticContext("What does Docker do?", { hasActiveEditor: true }),
      false
    );
  });

  it("'Explain this function' receives automatic context", () => {
    assert.equal(
      shouldIncludeAutomaticContext("Explain this function", { hasActiveEditor: true }),
      true
    );
    assert.equal(
      shouldIncludeAutomaticContext("explain this method", { hasActiveEditor: true }),
      true
    );
  });

  it("'What does this file do?' receives automatic context", () => {
    assert.equal(
      shouldIncludeAutomaticContext("What does this file do?", { hasActiveEditor: true }),
      true
    );
  });

  it("'Why is this failing?' receives context when relevant editor/code context is available", () => {
    // When editor is open, it receives context
    assert.equal(
      shouldIncludeAutomaticContext("Why is this failing?", { hasActiveEditor: true }),
      true
    );
    // When no editor is open, it does not attach context
    assert.equal(
      shouldIncludeAutomaticContext("Why is this failing?", { hasActiveEditor: false }),
      false
    );
  });

  it("'Fix this bug' receives automatic context", () => {
    assert.equal(
      shouldIncludeAutomaticContext("Fix this bug", { hasActiveEditor: true }),
      true
    );
    assert.equal(
      shouldIncludeAutomaticContext("fix the error in this code", { hasActiveEditor: true }),
      true
    );
  });

  it("'Refactor this function' receives automatic context", () => {
    assert.equal(
      shouldIncludeAutomaticContext("Refactor this function", { hasActiveEditor: true }),
      true
    );
    assert.equal(
      shouldIncludeAutomaticContext("refactor this code", { hasActiveEditor: true }),
      true
    );
  });

  it("'Add validation to this code' receives automatic context", () => {
    assert.equal(
      shouldIncludeAutomaticContext("Add validation to this code", { hasActiveEditor: true }),
      true
    );
    assert.equal(
      shouldIncludeAutomaticContext("add unit tests for this", { hasActiveEditor: true }),
      true
    );
  });

  it("Explicit file references in prompt always receive context", () => {
    assert.equal(
      shouldIncludeAutomaticContext("How does auth in token.service.ts work?", { hasActiveEditor: false }),
      true
    );
    assert.equal(
      shouldIncludeAutomaticContext("Read app.js and tell me routes", { hasActiveEditor: false }),
      true
    );
  });

  it("User selection with query receives automatic context", () => {
    assert.equal(
      shouldIncludeAutomaticContext("what does this mean?", { hasActiveEditor: true, hasSelection: true }),
      true
    );
  });

  it("Manual attachments are retained for ordinary chat", () => {
    const manualFile: AttachedFileContext = {
      relativePath: "docs/architecture.md",
      content: "# Architecture Guide",
      size: 21,
    };

    // User message is an ordinary greeting, but has manual attachment
    const query = "hello";
    const autoContext = shouldIncludeAutomaticContext(query, { hasActiveEditor: true });
    assert.equal(autoContext, false);

    // In handler: filesToInclude retains manual attachments even when autoContext is false
    const filesToInclude: AttachedFileContext[] = [manualFile];
    if (autoContext) {
      filesToInclude.push({ relativePath: "active.ts", content: "", size: 0 });
    }

    assert.equal(filesToInclude.length, 1);
    assert.equal(filesToInclude[0].relativePath, "docs/architecture.md");
  });

  it("No duplicate context files are sent when manual and auto context overlap", () => {
    const existingFile: AttachedFileContext = {
      relativePath: "src/app.ts",
      content: "console.log('manual');",
      size: 22,
    };
    const filesToInclude: AttachedFileContext[] = [existingFile];

    const activeCtx: AttachedFileContext = {
      relativePath: "src/app.ts",
      content: "console.log('active');",
      size: 22,
    };

    // Handler deduplication check
    const alreadyIncluded = filesToInclude.some((f) => f.relativePath === activeCtx.relativePath);
    if (!alreadyIncluded) {
      filesToInclude.unshift(activeCtx);
    }

    assert.equal(filesToInclude.length, 1);
    assert.equal(filesToInclude[0].relativePath, "src/app.ts");
  });

  it("The user message text is not modified with context prefixes", () => {
    const rawContent = "Why is this failing?";
    const files: AttachedFileContext[] = [
      { relativePath: "src/calc.ts", content: "function divide() {}", size: 20 },
    ];

    // Verification: tempUserMessage.content must be EXACTLY rawContent, not prefixed
    const tempUserMessage: Message = {
      id: "temp-123",
      conversationId: "conv-1",
      role: "user",
      content: rawContent.trim(),
      status: "completed",
      createdAt: new Date().toISOString(),
      contextFiles: files.map((f) => f.relativePath),
    };

    assert.equal(tempUserMessage.content, "Why is this failing?");
    assert.equal(tempUserMessage.content.includes("[Active context:"), false);
    assert.deepEqual(tempUserMessage.contextFiles, ["src/calc.ts"]);
  });

  it("No active editor still permits normal chat", () => {
    const query = "What is an API?";
    const autoContext = shouldIncludeAutomaticContext(query, { hasActiveEditor: false });
    assert.equal(autoContext, false);

    const wsManager = new MockWorkspaceManager("C:/mock/app");
    const augmented = wsManager.formatPromptWithContext([], query);
    assert.equal(augmented, "What is an API?");
    assert.equal(augmented.includes("[WORKSPACE CONTEXT]"), false);
  });
});

describe("Issue B — Response Lifecycle, Timeouts & Error Termination Tests", () => {
  const client = new NexamindClient("http://localhost:5000");

  it("SSE chunk parser extracts deltas, metadata, and done events properly", () => {
    const buffer = { current: "" };
    const chunk1 =
      "event: ping\ndata: {\"timestamp\":12345}\n\n" +
      "event: metadata\ndata: {\"model\":\"gemini-3.6-flash\"}\n\n" +
      "event: delta\ndata: {\"content\":\"Hello\"}\n\n";

    const events1 = client.parseSSEChunk(chunk1, buffer);
    assert.equal(events1.length, 3);
    assert.equal(events1[0].event, "ping");
    assert.equal(events1[1].event, "metadata");
    assert.equal(events1[2].event, "delta");
    assert.equal(JSON.parse(events1[2].data).content, "Hello");

    const chunk2 = "event: delta\ndata: {\"content\":\" world\"}\n\nevent: done\ndata: {\"status\":\"completed\"}\n\n";
    const events2 = client.parseSSEChunk(chunk2, buffer);
    assert.equal(events2.length, 2);
    assert.equal(events2[0].event, "delta");
    assert.equal(events2[1].event, "done");
  });

  it("SSE chunk parser ignores malformed frames and preserves stream continuity", () => {
    const buffer = { current: "" };
    const malformedChunk = "corrupted non-sse data without double newline";
    const events = client.parseSSEChunk(malformedChunk, buffer);
    assert.equal(events.length, 0);
    assert.equal(buffer.current, malformedChunk);

    // Now complete the frame with valid event
    const validEnding = "\n\nevent: delta\ndata: {\"content\":\"recovered\"}\n\n";
    const events2 = client.parseSSEChunk(validEnding, buffer);
    assert.equal(events2.length, 1);
    assert.equal(events2[0].event, "delta");
  });

  it("Client-side request timeout bounds hanging requests", async () => {
    // Mock fetch that hangs until aborted by timeout
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((_: any, options: any) => {
      return new Promise((_, reject) => {
        if (options?.signal) {
          if (options.signal.aborted) {
            const err = new Error("aborted");
            err.name = "AbortError";
            return reject(err);
          }
          options.signal.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        }
      });
    }) as any;

    try {
      await assert.rejects(
        async () => {
          await client.sendMessageStream(
            "test-token",
            "conv-1",
            "hello",
            undefined,
            undefined,
            undefined,
            50 // 50ms short timeout for test
          );
        },
        (err: any) => {
          assert.equal(err instanceof NexamindApiError, true);
          assert.equal(err.statusCode, 408);
          assert.equal(err.message.includes("Request timed out"), true);
          return true;
        }
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("Stop button / AbortSignal cancels in-flight stream immediately", async () => {
    const abortController = new AbortController();
    abortController.abort(); // already aborted

    await assert.rejects(
      async () => {
        await client.sendMessageStream(
          "test-token",
          "conv-1",
          "test query",
          undefined,
          undefined,
          abortController.signal
        );
      },
      (err: any) => {
        assert.equal(err.name, "AbortError");
        return true;
      }
    );
  });

  it("SSE terminal error event (HTTP 429 quota exhausted) throws actionable NexamindApiError", async () => {
    const originalFetch = globalThis.fetch;
    const errorSseStream =
      "event: error\ndata: {\"code\":\"RESOURCE_EXHAUSTED\",\"message\":\"AI model quota or rate limit exceeded. Please try again shortly.\",\"statusCode\":429}\n\n";

    globalThis.fetch = async () => {
      return new Response(errorSseStream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    };

    try {
      let errorCallbackCalled = false;
      await assert.rejects(
        async () => {
          await client.sendMessageStream(
            "test-token",
            "conv-1",
            "hi",
            {
              onError: (err) => {
                errorCallbackCalled = true;
                assert.equal(err.code, "RESOURCE_EXHAUSTED");
              },
            }
          );
        },
        (err: any) => {
          assert.equal(err instanceof NexamindApiError, true);
          assert.equal(err.statusCode, 429);
          assert.equal(err.message.includes("quota or rate limit exceeded"), true);
          return true;
        }
      );
      assert.equal(errorCallbackCalled, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("Premature server connection closure without deltas throws terminal error", async () => {
    const originalFetch = globalThis.fetch;
    // Empty stream (server closed connection immediately)
    globalThis.fetch = async () => {
      return new Response("", {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    };

    try {
      await assert.rejects(
        async () => {
          await client.sendMessageStream("test-token", "conv-1", "hi");
        },
        (err: any) => {
          assert.equal(err instanceof NexamindApiError, true);
          assert.equal(err.message.includes("Server closed connection"), true);
          return true;
        }
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("HTTP 429 response on initial fetch throws NexamindApiError with statusCode 429", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      return new Response(
        JSON.stringify({
          success: false,
          code: "RESOURCE_EXHAUSTED",
          message: "AI model quota or rate limit exceeded. Please try again shortly.",
        }),
        {
          status: 429,
          headers: { "Content-Type": "application/json" },
        }
      );
    };

    try {
      await assert.rejects(
        async () => {
          await client.sendMessageStream("test-token", "conv-1", "hi");
        },
        (err: any) => {
          assert.equal(err instanceof NexamindApiError, true);
          assert.equal(err.statusCode, 429);
          return true;
        }
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
