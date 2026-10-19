import {
  User,
  AuthResponseData,
  TokenBalance,
  Conversation,
  Message,
  SendMessageResultData,
} from "../types.js";

export class NexamindApiError extends Error {
  public readonly statusCode: number;
  public readonly isAuthError: boolean;
  public readonly isTokenExhaustedError: boolean;
  public readonly isConnectionError: boolean;

  constructor(
    message: string,
    statusCode: number = 500,
    isConnectionError: boolean = false
  ) {
    super(message);
    this.name = "NexamindApiError";
    this.statusCode = statusCode;
    this.isAuthError = statusCode === 401;
    this.isTokenExhaustedError = statusCode === 402;
    this.isConnectionError = isConnectionError;
  }
}

export const CLIENT_REQUEST_TIMEOUT_MS = 40_000;

export class NexamindClient {
  private baseUrl: string;

  constructor(baseUrl: string = "http://localhost:5000") {
    this.baseUrl = this.normalizeUrl(baseUrl);
  }

  public setBaseUrl(url: string): void {
    this.baseUrl = this.normalizeUrl(url);
  }

  public getBaseUrl(): string {
    return this.baseUrl;
  }

  private normalizeUrl(url: string): string {
    const trimmed = (url || "http://localhost:5000").trim();
    return trimmed.replace(/\/+$/, "");
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {},
    token?: string
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint.startsWith("/") ? endpoint : `/${endpoint}`}`;
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...(options.headers as Record<string, string> || {}),
    };

    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    if (options.body && typeof options.body === "string" && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }

    const controller = new AbortController();
    let timeoutId: NodeJS.Timeout | undefined;
    if (!options.signal) {
      timeoutId = setTimeout(() => {
        controller.abort(new Error("Request timed out"));
      }, CLIENT_REQUEST_TIMEOUT_MS);
    } else {
      options.signal.addEventListener("abort", () => controller.abort(options.signal?.reason), { once: true });
    }

    let response: Response;
    try {
      response = await fetch(url, {
        ...options,
        headers,
        signal: options.signal || controller.signal,
      });
    } catch (networkError: any) {
      const isRefused =
        networkError?.cause?.code === "ECONNREFUSED" ||
        networkError?.message?.includes("fetch failed") ||
        networkError?.message?.includes("ECONNREFUSED");

      const isTimeout =
        networkError?.name === "TimeoutError" ||
        networkError?.name === "AbortError" ||
        networkError?.message?.includes("timed out") ||
        (controller.signal.aborted && controller.signal.reason?.message?.includes("timed out"));

      let message: string;
      if (isTimeout) {
        message = `Request to Lumina backend timed out after ${Math.round(CLIENT_REQUEST_TIMEOUT_MS / 1000)}s. Please check backend health at ${this.baseUrl}.`;
      } else if (isRefused) {
        message = `Cannot connect to Lumina backend at ${this.baseUrl}. Please verify the server is running.`;
      } else {
        message = `Network request failed: ${networkError?.message || "Unknown network error"}`;
      }

      throw new NexamindApiError(message, isTimeout ? 408 : 0, true);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }

    let json: any = null;
    const text = await response.text();
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = { message: text };
      }
    }

    if (!response.ok) {
      let errorMsg = json?.message;
      if (json?.errors?.fieldErrors && typeof json.errors.fieldErrors === "object") {
        const fieldMsgs = Object.values(json.errors.fieldErrors).flat().filter(Boolean);
        if (fieldMsgs.length > 0) {
          errorMsg = `${json.message ? json.message + ": " : ""}${fieldMsgs.join(", ")}`;
        }
      } else if (!errorMsg && json?.errors) {
        errorMsg = typeof json.errors === "string" ? json.errors : JSON.stringify(json.errors);
      }
      if (!errorMsg) {
        errorMsg = `HTTP ${response.status} ${response.statusText}`;
      }
      throw new NexamindApiError(errorMsg, response.status);
    }

    return json as T;
  }

  public async healthCheck(): Promise<boolean> {
    try {
      const res = await this.request<{ success: boolean }>("/api/health");
      return Boolean(res?.success);
    } catch {
      return false;
    }
  }

  public async login(email: string, password: string): Promise<AuthResponseData> {
    const res = await this.request<{ success: boolean; data: AuthResponseData }>(
      "/api/auth/login",
      {
        method: "POST",
        body: JSON.stringify({ email: email.trim().toLowerCase(), password }),
      }
    );

    if (!res.data?.token || !res.data?.user) {
      throw new NexamindApiError("Malformed authentication response from server", 500);
    }

    return res.data;
  }

  public async getMe(token: string): Promise<User> {
    const res = await this.request<{ success: boolean; data: { user: User } }>(
      "/api/auth/me",
      { method: "GET" },
      token
    );

    if (!res.data?.user) {
      throw new NexamindApiError("Malformed user profile response from server", 500);
    }

    return res.data.user;
  }

  public async getConversations(token: string): Promise<Conversation[]> {
    const res = await this.request<{
      success: boolean;
      data: { conversations: Conversation[] };
    }>("/api/chat/conversations", { method: "GET" }, token);

    return res.data?.conversations || [];
  }

  public async createConversation(
    token: string,
    title?: string
  ): Promise<Conversation> {
    const res = await this.request<{
      success: boolean;
      data: { conversation: Conversation };
    }>(
      "/api/chat/conversations",
      {
        method: "POST",
        body: JSON.stringify(title ? { title: title.trim() } : {}),
      },
      token
    );

    if (!res.data?.conversation) {
      throw new NexamindApiError("Failed to parse created conversation", 500);
    }

    return res.data.conversation;
  }

  public async getMessages(
    token: string,
    conversationId: string
  ): Promise<Message[]> {
    const res = await this.request<{
      success: boolean;
      data: { messages: Message[] };
    }>(`/api/chat/conversations/${conversationId}/messages`, { method: "GET" }, token);

    return res.data?.messages || [];
  }

  public parseSSEChunk(
    chunk: string,
    buffer: { current: string } = { current: "" }
  ): Array<{ event: string; data: string }> {
    buffer.current += chunk;
    const events: Array<{ event: string; data: string }> = [];
    const regex = /(?:\r?\n){2}/;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(buffer.current)) !== null) {
      const rawFrame = buffer.current.slice(0, match.index);
      buffer.current = buffer.current.slice(match.index + match[0].length);

      if (!rawFrame.trim()) continue;

      let eventName = "message";
      const dataLines: string[] = [];

      for (const line of rawFrame.split(/\r?\n/)) {
        if (line.startsWith("event:")) {
          eventName = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trimStart());
        }
      }

      if (dataLines.length > 0) {
        events.push({
          event: eventName,
          data: dataLines.join("\n"),
        });
      }
    }

    return events;
  }

  public async sendMessage(
    token: string,
    conversationId: string,
    content: string,
    idempotencyKey?: string,
    signal?: AbortSignal
  ): Promise<SendMessageResultData> {
    const headers: Record<string, string> = {};
    if (idempotencyKey) {
      headers["Idempotency-Key"] = idempotencyKey;
    }

    const res = await this.request<{
      success: boolean;
      data: SendMessageResultData;
    }>(
      `/api/chat/conversations/${conversationId}/messages`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ content: content.trim() }),
        signal,
      },
      token
    );

    if (!res.data?.assistantMessage) {
      throw new NexamindApiError("Server did not return assistant response", 500);
    }

    return res.data;
  }

  public async sendMessageStream(
    token: string,
    conversationId: string,
    content: string,
    callbacks?: {
      onMetadata?: (meta: any) => void;
      onDelta?: (delta: string) => void;
      onDone?: (done: any) => void;
      onError?: (err: any) => void;
    },
    idempotencyKey?: string,
    signal?: AbortSignal,
    timeoutMs: number = CLIENT_REQUEST_TIMEOUT_MS
  ): Promise<SendMessageResultData> {
    const url = `${this.baseUrl}/api/chat/conversations/${conversationId}/messages`;
    const headers: Record<string, string> = {
      Accept: "text/event-stream",
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    };
    if (idempotencyKey) {
      headers["Idempotency-Key"] = idempotencyKey;
    }

    // Set up bounded client timeout
    const timeoutController = new AbortController();
    let isTimedOut = false;
    let abortListener: (() => void) | undefined;

    const timer = setTimeout(() => {
      isTimedOut = true;
      timeoutController.abort();
    }, timeoutMs);

    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        const abortErr = new Error("Generation stopped by user.");
        abortErr.name = "AbortError";
        throw abortErr;
      }
      abortListener = () => {
        timeoutController.abort();
      };
      signal.addEventListener("abort", abortListener, { once: true });
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ content: content.trim() }),
        signal: timeoutController.signal,
      });
    } catch (networkError: any) {
      clearTimeout(timer);
      if (signal && abortListener) {
        signal.removeEventListener("abort", abortListener);
      }

      if (isTimedOut) {
        throw new NexamindApiError(
          `Request timed out after ${Math.round(timeoutMs / 1000)} seconds. The AI provider took too long to respond. Please try again.`,
          408
        );
      }
      if (networkError.name === "AbortError" || signal?.aborted) {
        const abortErr = new Error("Generation stopped by user.");
        abortErr.name = "AbortError";
        throw abortErr;
      }
      const message = `Network request failed: ${networkError?.message || "Unknown error"}`;
      throw new NexamindApiError(message, 0, true);
    }

    if (!response.ok) {
      clearTimeout(timer);
      if (signal && abortListener) {
        signal.removeEventListener("abort", abortListener);
      }

      let errorMsg = `HTTP ${response.status} ${response.statusText}`;
      try {
        const errJson = (await response.json()) as any;
        errorMsg = errJson?.message || errorMsg;
      } catch {}
      throw new NexamindApiError(errorMsg, response.status);
    }

    const contentType = response.headers.get("content-type") || "";

    // If server responded with JSON instead of SSE
    if (!contentType.includes("text/event-stream")) {
      clearTimeout(timer);
      if (signal && abortListener) {
        signal.removeEventListener("abort", abortListener);
      }

      const json = (await response.json()) as any;
      if (!json?.data?.assistantMessage) {
        throw new NexamindApiError("Server did not return assistant response", 500);
      }
      callbacks?.onDone?.(json.data);
      return json.data as SendMessageResultData;
    }

    if (!response.body) {
      clearTimeout(timer);
      if (signal && abortListener) {
        signal.removeEventListener("abort", abortListener);
      }
      throw new NexamindApiError("Response body is empty", 500);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    const buffer = { current: "" };

    let completedResult: SendMessageResultData | undefined;
    let accumulatedDelta = "";

    try {
      while (true) {
        if (signal?.aborted) {
          await reader.cancel();
          const abortErr = new Error("Generation stopped by user.");
          abortErr.name = "AbortError";
          throw abortErr;
        }

        if (isTimedOut) {
          await reader.cancel();
          throw new NexamindApiError(
            `Request timed out after ${Math.round(timeoutMs / 1000)} seconds. The AI provider took too long to respond. Please try again.`,
            408
          );
        }

        const { done, value } = await reader.read();
        if (done) break;

        const chunkText = decoder.decode(value, { stream: true });
        const events = this.parseSSEChunk(chunkText, buffer);

        for (const evt of events) {
          if (evt.event === "error") {
            let errorMsg = "Streaming generation error";
            let statusCode = 500;
            try {
              const data = JSON.parse(evt.data);
              errorMsg = data.message || errorMsg;
              statusCode = data.statusCode || statusCode;
              callbacks?.onError?.(data);
            } catch {
              callbacks?.onError?.({ message: evt.data, statusCode: 500 });
              errorMsg = evt.data || errorMsg;
            }
            throw new NexamindApiError(errorMsg, statusCode);
          }

          try {
            const data = JSON.parse(evt.data);
            if (evt.event === "delta") {
              const deltaText = data.content ?? data.delta ?? "";
              accumulatedDelta += deltaText;
              callbacks?.onDelta?.(deltaText);
            } else if (evt.event === "metadata") {
              callbacks?.onMetadata?.(data);
            } else if (evt.event === "done") {
              completedResult = {
                userMessage: data.userMessage,
                assistantMessage: data.assistantMessage,
              };
              callbacks?.onDone?.(data);
            }
          } catch (parseErr: any) {
            if (parseErr instanceof NexamindApiError) throw parseErr;
            // Ignore corrupted chunk frame gracefully without stalling stream
          }
        }
      }
    } catch (streamErr: any) {
      if (isTimedOut) {
        throw new NexamindApiError(
          `Request timed out after ${Math.round(timeoutMs / 1000)} seconds. The AI provider took too long to respond. Please try again.`,
          408
        );
      }
      if (signal?.aborted || streamErr?.name === "AbortError") {
        const abortErr = new Error("Generation stopped by user.");
        abortErr.name = "AbortError";
        throw abortErr;
      }
      throw streamErr;
    } finally {
      clearTimeout(timer);
      if (signal && abortListener) {
        signal.removeEventListener("abort", abortListener);
      }
      try {
        reader.releaseLock();
      } catch {}
    }

    // Check for premature connection closure without data
    if (!completedResult) {
      if (accumulatedDelta.trim().length === 0) {
        throw new NexamindApiError("Server closed connection before response was completed", 500);
      }

      completedResult = {
        userMessage: {
          id: `u-${Date.now()}`,
          conversationId,
          role: "user",
          content,
          status: "completed",
          createdAt: new Date().toISOString(),
        },
        assistantMessage: {
          id: `a-${Date.now()}`,
          conversationId,
          role: "assistant",
          content: accumulatedDelta,
          status: "completed",
          createdAt: new Date().toISOString(),
        },
      };
    }

    return completedResult;
  }


  public async getTokenBalance(token: string): Promise<TokenBalance> {
    const res = await this.request<{
      success: boolean;
      data: TokenBalance;
    }>("/api/tokens/balance", { method: "GET" }, token);

    if (!res.data) {
      throw new NexamindApiError("Failed to fetch token balance", 500);
    }

    return res.data;
  }
}
