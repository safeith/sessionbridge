/**
 * Kiro session format
 * Location: ~/.kiro/sessions/cli/<uuid>.json  (metadata)
 *           ~/.kiro/sessions/cli/<uuid>.jsonl (messages)
 * Messages: {version:"v1", kind:"Prompt"|"AssistantMessage", data:{message_id, content:[{kind:"text",data:"..."}]}}
 */

import { readdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import type { CanonicalContent, CanonicalMessage, CanonicalSession, SessionSummary } from "../types";

const SESSIONS_DIR = `${process.env.HOME}/.kiro/sessions/cli`;

function readJSONL(filePath: string): any[] {
  return readFileSync(filePath, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

function kiroContentToText(content: any[]): string {
  return content
    .map((c) => (c.kind === "text" ? c.data : ""))
    .join("")
    .trim();
}

export function list(): SessionSummary[] {
  if (!existsSync(SESSIONS_DIR)) return [];
  const results: SessionSummary[] = [];
  const seen = new Set<string>();

  for (const file of readdirSync(SESSIONS_DIR)) {
    if (!file.endsWith(".json") || file.endsWith(".jsonl")) continue;
    const sessionId = file.replace(".json", "");
    if (seen.has(sessionId)) continue;
    seen.add(sessionId);

    try {
      const meta = JSON.parse(readFileSync(join(SESSIONS_DIR, file), "utf8"));
      const jsonlPath = join(SESSIONS_DIR, `${sessionId}.jsonl`);
      let messageCount = 0;
      if (existsSync(jsonlPath)) {
        messageCount = readJSONL(jsonlPath).filter((l) => l.kind === "Prompt" || l.kind === "AssistantMessage").length;
      }
      results.push({
        id: meta.session_id ?? sessionId,
        title: meta.title ?? sessionId,
        cwd: meta.cwd ?? "",
        createdAt: meta.created_at ?? "",
        updatedAt: meta.updated_at ?? meta.created_at ?? "",
        messageCount,
      });
    } catch {}
  }

  return results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function read(sessionId: string): CanonicalSession {
  if (!existsSync(SESSIONS_DIR)) throw new Error("Kiro sessions dir not found");

  // Find by session_id (may differ from filename uuid)
  let metaFile: string | null = null;
  let metaPath: string | null = null;

  for (const file of readdirSync(SESSIONS_DIR)) {
    if (!file.endsWith(".json") || file.endsWith(".jsonl")) continue;
    const fp = join(SESSIONS_DIR, file);
    try {
      const meta = JSON.parse(readFileSync(fp, "utf8"));
      if (meta.session_id === sessionId || file.replace(".json", "") === sessionId) {
        metaFile = file.replace(".json", "");
        metaPath = fp;
        break;
      }
    } catch {}
  }

  if (!metaPath || !metaFile) throw new Error(`Kiro session not found: ${sessionId}`);

  const meta = JSON.parse(readFileSync(metaPath, "utf8"));
  const jsonlPath = join(SESSIONS_DIR, `${metaFile}.jsonl`);

  if (!existsSync(jsonlPath)) {
    return { id: meta.session_id, title: meta.title ?? meta.session_id, cwd: meta.cwd ?? "", createdAt: meta.created_at ?? "", messages: [] };
  }

  const lines = readJSONL(jsonlPath);
  const messages: CanonicalMessage[] = [];
  let prevId: string | null = null;

  for (const line of lines) {
    if (line.kind !== "Prompt" && line.kind !== "AssistantMessage") continue;
    const role: "user" | "assistant" = line.kind === "Prompt" ? "user" : "assistant";
    const text = kiroContentToText(line.data?.content ?? []);
    const id = line.data?.message_id ?? crypto.randomUUID();
    const ts = line.data?.meta?.timestamp ? new Date(line.data.meta.timestamp * 1000).toISOString() : undefined;

    messages.push({ id, parentId: prevId ?? undefined, role, content: [{ type: "text", text }], timestamp: ts });
    prevId = id;
  }

  return { id: meta.session_id, title: meta.title ?? meta.session_id, cwd: meta.cwd ?? "", createdAt: meta.created_at ?? "", updatedAt: meta.updated_at, messages };
}

export function remove(sessionId: string): void {
  if (!existsSync(SESSIONS_DIR)) return;
  for (const file of readdirSync(SESSIONS_DIR)) {
    if (!file.endsWith(".json") || file.endsWith(".jsonl")) continue;
    const fp = join(SESSIONS_DIR, file);
    try {
      const meta = JSON.parse(readFileSync(fp, "utf8"));
      if (meta.session_id === sessionId || file.replace(".json", "") === sessionId) {
        const base = file.replace(".json", "");
        const jsonPath = join(SESSIONS_DIR, `${base}.json`);
        const jsonlPath = join(SESSIONS_DIR, `${base}.jsonl`);
        if (existsSync(jsonPath)) unlinkSync(jsonPath);
        if (existsSync(jsonlPath)) unlinkSync(jsonlPath);
        return;
      }
    } catch {}
  }
}

function contentToKiro(content: CanonicalContent[]): Array<{ kind: string; data: string }> {
  return content.map((c) => {
    if (c.type === "text") return { kind: "text", data: c.text };
    if (c.type === "tool_use")
      return { kind: "text", data: `[tool: ${c.name}]\n${JSON.stringify(c.input, null, 2)}` };
    if (c.type === "tool_result")
      return { kind: "text", data: `[tool result${c.is_error ? " (error)" : ""}]\n${c.content}` };
    return { kind: "text", data: "" };
  });
}

export function write(session: CanonicalSession, targetCwd?: string): string {
  if (!existsSync(SESSIONS_DIR)) {
    throw new Error(`Kiro sessions dir not found: ${SESSIONS_DIR}`);
  }

  const id = crypto.randomUUID();
  const cwd = targetCwd ?? session.cwd;
  const now = new Date().toISOString();
  const lastMsgTs = session.messages.at(-1)?.timestamp;
  const updatedAt = session.updatedAt ?? lastMsgTs ?? session.createdAt ?? now;

  const meta = {
    session_id: id,
    cwd,
    created_at: session.createdAt ?? now,
    updated_at: updatedAt,
    title: session.title,
    session_created_reason: "subagent",
    session_state: { version: "v1", conversation_metadata: { user_turn_metadatas: [] } },
  };

  writeFileSync(join(SESSIONS_DIR, `${id}.json`), JSON.stringify(meta, null, 2));

  const lines: any[] = [];
  for (const msg of session.messages) {
    const kind = msg.role === "user" ? "Prompt" : "AssistantMessage";
    const entry: any = {
      version: "v1",
      kind,
      data: {
        message_id: msg.id ?? crypto.randomUUID(),
        content: contentToKiro(msg.content),
      },
    };
    if (msg.role === "user" && msg.timestamp) {
      entry.data.meta = { timestamp: Math.floor(new Date(msg.timestamp).getTime() / 1000) };
    }
    lines.push(entry);
  }

  writeFileSync(join(SESSIONS_DIR, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return id;
}
