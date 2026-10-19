import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { NexamindClient, NexamindApiError } from "../src/api/nexamindClient.js";

describe("Live Backend Integration Test", () => {
  const client = new NexamindClient("http://localhost:5000");

  it("successfully connects to live backend health endpoint", async () => {
    const isHealthy = await client.healthCheck();
    assert.equal(isHealthy, true, "Backend should be reachable and healthy");
  });

  it("handles live authentication failure correctly (401 Unauthorized)", async () => {
    try {
      await client.login("nonexistent_user_xyz@nexamind.ai", "invalid_password_123");
      assert.fail("Should have thrown 401 error");
    } catch (err: any) {
      assert.equal(err instanceof NexamindApiError, true);
      assert.equal(err.statusCode, 401);
      assert.equal(err.isAuthError, true);
      assert.equal(err.message, "Invalid email or password");
    }
  });

  it("rejects unauthorized chat endpoint access (401)", async () => {
    try {
      await client.getConversations("invalid-token-abc");
      assert.fail("Should have rejected invalid token");
    } catch (err: any) {
      assert.equal(err instanceof NexamindApiError, true);
      assert.equal(err.statusCode, 401);
      assert.equal(err.isAuthError, true);
    }
  });
});
