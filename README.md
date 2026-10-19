# Lumina AI — VS Code Extension

Official VS Code extension for Lumina AI assistant. Chat with Lumina AI directly within VS Code while utilizing your existing backend, token ledger, conversational history, and workspace-aware coding capabilities.

## Features

- **Activity Bar Native Chat**: Seamlessly integrated into VS Code's sidebar.
- **Workspace-Aware Coding**: Attach the active editor file or select specific workspace files to include real code context in requests.
- **Explicit User Approval for Code Edits**: When Lumina proposes modifications to workspace files:
  - An interactive **Proposed Edit Card** appears in the chat.
  - Review side-by-side changes using VS Code's native **Diff Editor** (`🔍 View Diff`).
  - Changes are applied and saved to disk only upon explicit user confirmation (`✔ Approve & Apply`).
- **Path Traversal & Security Protection**: Rejects absolute paths, directory traversal (`..`), sensitive files (`.env`, credentials, private keys), ignored directories (`node_modules`, `.git`, build output), and binary files.
- **Context Budget Protection**: Safely budgets and truncates oversized file context to strictly observe the backend's 10,000 character payload limit without dropping requests.
- **Secure Authentication**: Uses VS Code `SecretStorage` for storing your JWT token—never plaintext files, settings, or workspace state.
- **Real-Time Token Accounting**: Displays your available token balance and updates automatically on message generation.
- **Idempotent Messaging**: Automatic client-side idempotency keys prevent duplicate token holds or duplicate messages on connection hiccups.
- **Configurable Backend**: Easily configure the backend URL (`http://localhost:5000` by default or remote production endpoint).

## Commands

- `Lumina: Open Chat` (`nexamind.openChat`): Open the Lumina chat panel.
- `Lumina: New Chat` (`nexamind.newChat`): Start a new conversation.
- `Lumina: Analyze Active File` (`nexamind.analyzeActiveFile`): Attach the active file or selection to context and open chat.
- `Lumina: Add Workspace Files to Context` (`nexamind.addFilesToContext`): Pick workspace files to attach to chat context.
- `Lumina: Login` (`nexamind.login`): Log in using your Lumina credentials.
- `Lumina: Logout` (`nexamind.logout`): Clear stored credentials and sign out.
- `Lumina: Set Backend URL` (`nexamind.setBackendUrl`): Configure the backend API host.

## Extension Settings

- `nexamind.backendUrl`: Base URL for the backend API (default: `http://localhost:5000`).

## Architecture

This extension directly consumes the standard backend endpoints:
- `POST /api/auth/login`: Authenticate and retrieve JWT token.
- `GET /api/auth/me`: Validate session and fetch user profile.
- `GET /api/tokens/balance`: Monitor user wallet token balance.
- `GET /api/chat/conversations`: Fetch conversation list.
- `POST /api/chat/conversations`: Create a new conversation.
- `GET /api/chat/conversations/:id/messages`: Retrieve conversation history.
- `POST /api/chat/conversations/:id/messages`: Send chat message (standard JSON contract with idempotency key).

No third-party AI SDKs or separate API keys are bundled with the extension. All requests flow through your authenticated backend.
