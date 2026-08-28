export type Tool = "claude" | "kiro" | "opencode" | "pi";

export interface SessionSummary {
  id: string;
  title: string;
  cwd: string;
  createdAt: string;
  updatedAt?: string;
  messageCount?: number;
}

export interface SyncCopy {
  id: string;
  updatedAt: string;
}

export interface SyncGroup {
  id: string;
  title: string;
  cwd: string;
  createdAt: string;
  copies: Partial<Record<Tool, SyncCopy>>;
  lastSyncAt: string;
}

export interface SyncManifest {
  version: 1;
  groups: SyncGroup[];
}

export interface CanonicalSession {
  id: string;
  title: string;
  cwd: string;
  createdAt: string;
  updatedAt?: string;
  messages: CanonicalMessage[];
}

export interface CanonicalMessage {
  id: string;
  parentId?: string;
  role: "user" | "assistant";
  content: CanonicalContent[];
  timestamp?: string;
}

export type CanonicalContent =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };
