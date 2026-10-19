export interface User {
  id: string;
  name: string;
  email: string;
  role: "user" | "admin";
  plan: "free" | "pro" | "plus";
  isActive?: boolean;
}

export interface AuthResponseData {
  token: string;
  user: User;
}

export interface TokenBalance {
  balance: number;
  reservedTokens: number;
  totalAllocated: number;
  totalUsed: number;
  lastAllocatedPlan: string;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  status?: "pending" | "generating" | "completed" | "failed";
  errorMessage?: string;
  createdAt: string;
  updatedAt?: string;
  contextFiles?: string[];
}

export interface SendMessageResultData {
  userMessage: Message;
  assistantMessage: Message;
}

export interface AttachedFileContext {
  relativePath: string;
  content: string;
  size: number;
  lineCount?: number;
  languageId?: string;
  selection?: {
    startLine: number;
    endLine: number;
    selectedText?: string;
  };
  truncated?: boolean;
}

export interface ProposedEdit {
  id: string;
  filePath: string;
  description: string;
  action: "modify" | "create";
  replacement: string;
  status: "pending" | "applied" | "rejected";
  originalContent?: string;
  originalMtime?: number;
  error?: string;
}

// Webview Communication Contracts
export type WebviewToExtensionMessage =
  | { type: "login"; email: string; password: string }
  | { type: "logout" }
  | { type: "checkAuth" }
  | { type: "loadConversations" }
  | { type: "selectConversation"; conversationId: string }
  | { type: "createConversation"; title?: string }
  | { type: "sendMessage"; conversationId: string; content: string; attachedFiles?: AttachedFileContext[] }
  | { type: "cancelGeneration" }
  | { type: "refreshTokenBalance" }
  | { type: "setBackendUrl"; url: string }
  | { type: "openSettings" }
  | { type: "attachActiveFile"; relativePath?: string }
  | { type: "attachWorkspaceFiles" }
  | { type: "removeAttachedFile"; relativePath: string }
  | { type: "clearAttachedFiles" }
  | { type: "openDiff"; editId: string }
  | { type: "applyEdit"; editId: string }
  | { type: "rejectEdit"; editId: string };

export type ExtensionToWebviewMessage =
  | { type: "authState"; authenticated: boolean; user?: User; tokenBalance?: TokenBalance }
  | { type: "authError"; message: string }
  | { type: "conversationsList"; conversations: Conversation[]; selectedConversationId?: string }
  | { type: "conversationMessages"; conversationId: string; messages: Message[] }
  | { type: "messageSending"; conversationId: string; tempUserMessage: Message }
  | { type: "messageDelta"; conversationId: string; delta: string }
  | { type: "messageSuccess"; conversationId: string; userMessage: Message; assistantMessage: Message; tokenBalance?: TokenBalance; proposedEdits?: ProposedEdit[] }
  | { type: "messageError"; conversationId: string; error: string; statusCode?: number }
  | { type: "tokenBalanceUpdate"; tokenBalance: TokenBalance }
  | { type: "configUpdate"; backendUrl: string }
  | { type: "attachedFilesUpdate"; files: AttachedFileContext[] }
  | { type: "proposedEditsUpdate"; edits: ProposedEdit[] }
  | { type: "editStatusUpdate"; editId: string; status: "pending" | "applied" | "rejected"; message?: string }
  | { type: "activeFileNotice"; fileName: string; hasSelection: boolean; languageId?: string };


