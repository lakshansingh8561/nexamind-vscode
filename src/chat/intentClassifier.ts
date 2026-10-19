/**
 * Intent-Aware Context Selection Utility
 * Determines whether a user message requires workspace/editor context (coding request)
 * or should be treated as ordinary conversation (no automatic context).
 */

export interface IntentContextOptions {
  hasActiveEditor?: boolean;
  hasSelection?: boolean;
  activeFileName?: string;
}

// Common general knowledge and conceptual topics that should not trigger workspace context
const GENERAL_KNOWLEDGE_TERMS = new Set([
  "api",
  "apis",
  "rest",
  "restful",
  "http",
  "https",
  "html",
  "css",
  "dns",
  "tcp",
  "udp",
  "ip",
  "json",
  "xml",
  "yaml",
  "jwt",
  "oauth",
  "sql",
  "nosql",
  "git",
  "docker",
  "kubernetes",
  "k8s",
  "ci/cd",
  "linux",
  "unix",
  "bash",
  "regex",
  "ssh",
  "ssl",
  "tls",
  "cors",
  "csrf",
  "xss",
  "dom",
  "graphql",
  "grpc",
  "websocket",
  "websockets",
  "microservices",
  "monolith",
  "recursion",
  "polymorphism",
  "encapsulation",
  "inheritance",
  "abstraction",
  "algorithm",
  "algorithms",
  "data structure",
  "data structures",
  "clean architecture",
  "design pattern",
  "design patterns",
  "solid principles",
  "event loop",
]);

// Actionable coding verbs and actions that indicate a direct coding task
const CODING_ACTION_PATTERNS = [
  /\b(?:explain|analyze|review|inspect|walk through|break down)\s+(?:this|the|my|our|selected)\s+(?:function|method|class|code|file|snippet|implementation|type|interface|component|hook|endpoint|query|script)\b/i,
  /\bwhat\s+does\s+(?:this|the|my)\s+(?:function|method|class|code|file|snippet|component|script)\s+do\b/i,
  /\bfix\s+(?:this|the|my|a)?\s*(?:bug|issue|error|failure|exception|crash|problem|typo|warning|lint|code)\b/i,
  /\b(?:refactor|optimize|cleanup|clean up|simplify|modernize|rewrite|rework)\s+(?:this|the|my|our)?\s*(?:function|method|class|code|file|component|logic|implementation)?\b/i,
  /\badd\s+(?:validation|tests?|unit tests?|types?|typing|error handling|logging|auth|caching|comments|docstrings?)\s+(?:to\s+(?:this|the|my|our)\s+(?:code|function|file|endpoint|input|form))?\b/i,
  /\b(?:write|generate|create)\s+(?:unit tests?|tests?|documentation|types?|interface)\s+for\s+(?:this|the|my)\b/i,
  /\b(?:how do i (?:fix|run|test|debug|refactor|optimize))\s+(?:this|the|my)\b/i,
];

// Demonstrative code context phrases
const CODE_DEMONSTRATIVE_PATTERNS = [
  /\b(?:this|these|the|my|our|current|active|selected)\s+(?:function|method|class|code|file|module|component|script|snippet|block|endpoint|route|interface|type|implementation|test|variable|error|bug|issue|failure|stack trace)\b/i,
  /\b(?:selected\s+code|in\s+this\s+file|in\s+the\s+editor|at\s+line\s+\d+|lines?\s+\d+(?:\s*-\s*\d+)?)\b/i,
  /\b(?:here|above|below)\s+(?:in\s+(?:the|this)\s+file|is\s+my\s+code)\b/i,
];

// File extension pattern for detecting explicit workspace file mentions
const FILE_EXTENSION_PATTERN = /\b[a-zA-Z0-9_\-./\\]+\.(?:ts|js|tsx|jsx|py|json|html|css|scss|md|rs|go|java|c|cpp|h|hpp|sql|ya?ml|sh|env)\b/i;

/**
 * Normalizes message text for intent analysis.
 */
function cleanMessage(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s/.-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Checks if the message is a pure greeting or polite conversational remark.
 */
function isGreetingOrPleasantry(cleaned: string): boolean {
  const pureGreetings = [
    "hi",
    "hello",
    "hey",
    "greetings",
    "howdy",
    "yo",
    "sup",
    "thanks",
    "thank you",
    "thx",
    "good morning",
    "good afternoon",
    "good evening",
    "good night",
    "bye",
    "goodbye",
    "see you",
    "see ya",
    "how are you",
    "who are you",
    "what are you",
    "what can you do",
    "help",
    "ok",
    "okay",
    "cool",
    "great",
    "awesome",
    "nice",
    "got it",
    "understood",
  ];

  if (pureGreetings.includes(cleaned)) {
    return true;
  }

  // Matches greeting with name or bot mention: e.g. "hi lumina", "hello there", "hey assistant"
  const greetingPattern = /^(?:hi|hello|hey|greetings|howdy|good\s+(?:morning|afternoon|evening))\s+(?:there|lumina|nexamind|bot|ai|assistant|friend)?$/i;
  return greetingPattern.test(cleaned);
}

/**
 * Checks if the query is a general knowledge / educational question unrelated to current workspace code.
 */
function isGeneralKnowledgeQuestion(cleaned: string, original: string): boolean {
  // If there's an explicit file mention, it's not a general knowledge question
  if (FILE_EXTENSION_PATTERN.test(original)) {
    return false;
  }

  // If there's a demonstrative ("this function", "this file", "my code", "this"), not general
  for (const pattern of CODE_DEMONSTRATIVE_PATTERNS) {
    if (pattern.test(original)) {
      return false;
    }
  }

  // Questions like: "what is an api", "what is http", "explain http in simple words"
  const generalPatterns = [
    /^(?:what is|what are|what does)\s+(?:an?|the concept of)?\s*([a-z0-9_/ -]+?)(?:\s+(?:stand for|mean|do|work|in simple (?:words|terms)|briefly))?$/i,
    /^(?:explain|describe|tell me about|how does)\s+(?:an?|the concept of)?\s*([a-z0-9_/ -]+?)(?:\s+(?:in simple (?:words|terms)|work|briefly))?$/i,
    /^(?:define|difference between)\s+([a-z0-9_/ -]+)$/i,
  ];

  for (const regex of generalPatterns) {
    const match = cleaned.match(regex);
    if (match) {
      const topic = (match[1] || "").trim().toLowerCase();
      // If the topic is in our general knowledge set or does not reference local code
      if (
        GENERAL_KNOWLEDGE_TERMS.has(topic) ||
        topic.includes("api") ||
        topic.includes("http") ||
        topic.includes("rest") ||
        topic.includes("docker") ||
        topic.includes("database") ||
        topic.includes("git")
      ) {
        return true;
      }
      // If topic is simple noun phrase and not a local code reference
      if (topic.length > 0 && !topic.includes("this") && !topic.includes("file") && !topic.includes("function")) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Evaluates whether a user message intends to inspect, discuss, or modify
 * the active workspace code context.
 *
 * @param message The user prompt text.
 * @param options Available editor and workspace state.
 * @returns true if automatic context should be attached; false otherwise.
 */
export function shouldIncludeAutomaticContext(
  message: string,
  options?: IntentContextOptions
): boolean {
  const trimmed = message.trim();
  if (!trimmed) {
    return false;
  }

  const cleaned = cleanMessage(trimmed);

  // 1. Obvious ordinary conversation / greetings -> NO automatic context
  if (isGreetingOrPleasantry(cleaned)) {
    return false;
  }

  // 2. Explicit file references in user message -> ALWAYS include context
  if (FILE_EXTENSION_PATTERN.test(trimmed)) {
    return true;
  }

  // 3. Clear coding action patterns (e.g. "Explain this function", "Fix this bug", "Refactor this function")
  for (const pattern of CODING_ACTION_PATTERNS) {
    if (pattern.test(trimmed)) {
      return true;
    }
  }

  // 4. Code demonstratives (e.g. "this file", "selected code", "lines 10-20")
  for (const pattern of CODE_DEMONSTRATIVE_PATTERNS) {
    if (pattern.test(trimmed)) {
      return true;
    }
  }

  // 5. Active editor selection: User explicitly highlighted code in their editor
  if (options?.hasSelection) {
    // If user has highlighted code and asks a question or gives an instruction
    const isQuestionOrAction =
      /^(?:explain|what|why|how|fix|check|review|improve|refactor|can you|does this|is this)\b/i.test(trimmed) ||
      trimmed.includes("?");
    if (isQuestionOrAction) {
      return true;
    }
  }

  // 6. General knowledge / conceptual questions -> NO automatic context
  if (isGeneralKnowledgeQuestion(cleaned, trimmed)) {
    return false;
  }

  // 7. Generic short error phrases (e.g. "Why is this failing?", "Why is it failing?")
  if (/\b(?:why is this failing|why is it failing|why is this broken|what is wrong with this)\b/i.test(trimmed)) {
    // If an active editor is open, treat as coding context
    return Boolean(options?.hasActiveEditor);
  }

  // 8. General code keywords if active editor is open
  const codingKeywords = [
    /\b(?:syntax error|type error|referenceerror|typeerror|null pointer|undefined is not|uncaught exception)\b/i,
    /\b(?:compile error|build error|stack trace|segfault)\b/i,
    /\b(?:unit test|test suite|test case|assertion)\b/i,
  ];

  for (const kw of codingKeywords) {
    if (kw.test(trimmed)) {
      return Boolean(options?.hasActiveEditor);
    }
  }

  // 9. When uncertain, default to skipping automatic context for ordinary conversation
  return false;
}
