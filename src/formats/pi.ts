/**
 * Pi agent session format
 * Location: ~/.pi/agent/sessions/<escaped-cwd>/<timestamp>_<uuid>.jsonl
 * Escaping: '--' + path.replace(/^\//, '').replace(/\//g, '-') + '--'
 * Records: session header, session_info, then {type:"message", message:{role, content:[{type:"text",text}]}, id, parentId, timestamp}
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "fs";
import { join } from "path";
import type { CanonicalContent, CanonicalMessage, CanonicalSession, SessionSummary } from "../types";

const SESSIONS_DIR = `${process.env.HOME}/.pi/agent/sessions`;

function escapeCwd(p: string): string {
  return "--" + p.replace(/^\//, "").replace(/\//g, "-") + "--";
}

function readLines(filePath: string): any[] {
  return readFileSync(filePath, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

function contentToCanonical(content: any[]): CanonicalContent[] {
  return content.map((c) => {
    if (c.type === "text") return { type: "text" as const, text: c.text };
    if (c.type === "tool_use") return { type: "tool_use" as const, id: c.id, name: c.name, input: c.input };
    if (c.type === "tool_result")
      return {
        type: "tool_result" as const,
        tool_use_id: c.tool_use_id,
        content: Array.isArray(c.content) ? c.content.map((x: any) => x.text ?? "").join("") : String(c.content ?? ""),
      };
    return { type: "text" as const, text: JSON.stringify(c) };
  });
}

export function list(): SessionSummary[] {
  if (!existsSync(SESSIONS_DIR)) return [];
  const results: SessionSummary[] = [];

  for (const dir of readdirSync(SESSIONS_DIR)) {
    const dirPath = join(SESSIONS_DIR, dir);
    try {
      for (const file of readdirSync(dirPath)) {
        if (!file.endsWith(".jsonl")) continue;
        const uuidMatch = file.match(/_([0-9a-f-]{36})\.jsonl$/);
        const sessionId = uuidMatch?.[1] ?? file.replace(".jsonl", "");
        const lines = readLines(join(dirPath, file));
        const header = lines.find((l) => l.type === "session");
        const info = lines.find((l) => l.type === "session_info");
        const msgs = lines.filter((l) => l.type === "message");
        const lastMsg = msgs.at(-1);
        results.push({
          id: header?.id ?? sessionId,
          title: info?.name ?? sessionId,
          cwd: header?.cwd ?? "",
          createdAt: header?.timestamp ?? "",
          updatedAt: lastMsg?.timestamp ?? header?.timestamp ?? "",
          messageCount: msgs.length,
        });
      }
    } catch {}
  }

  return results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function read(sessionId: string): CanonicalSession {
  if (!existsSync(SESSIONS_DIR)) throw new Error("Pi sessions dir not found");

  let filePath: string | null = null;

  outer: for (const dir of readdirSync(SESSIONS_DIR)) {
    const dirPath = join(SESSIONS_DIR, dir);
    try {
      for (const file of readdirSync(dirPath)) {
        if (!file.endsWith(".jsonl")) continue;
        const uuidMatch = file.match(/_([0-9a-f-]{36})\.jsonl$/);
        const id = uuidMatch?.[1] ?? "";
        if (id === sessionId || file.replace(".jsonl", "") === sessionId) {
          filePath = join(dirPath, file);
          break outer;
        }
        // Also check the session header id
        const fp = join(dirPath, file);
        const firstLine = readFileSync(fp, "utf8").split("\n")[0];
        try {
          const header = JSON.parse(firstLine);
          if (header.id === sessionId) {
            filePath = fp;
            break outer;
          }
        } catch {}
      }
    } catch {}
  }

  if (!filePath) throw new Error(`Pi session not found: ${sessionId}`);

  const lines = readLines(filePath);
  const header = lines.find((l) => l.type === "session");
  const info = lines.find((l) => l.type === "session_info");

  const messages: CanonicalMessage[] = [];
  for (const line of lines) {
    if (line.type !== "message") continue;
    const msg = line.message;
    if (!msg || !msg.role) continue;
    const content = Array.isArray(msg.content) ? contentToCanonical(msg.content) : [{ type: "text" as const, text: String(msg.content ?? "") }];
    messages.push({
      id: line.id ?? crypto.randomUUID(),
      parentId: line.parentId ?? undefined,
      role: msg.role,
      content,
      timestamp: line.timestamp,
    });
  }

  return {
    id: header?.id ?? sessionId,
    title: info?.name ?? sessionId,
    cwd: header?.cwd ?? "",
    createdAt: header?.timestamp ?? new Date().toISOString(),
    messages,
  };
}

export function remove(sessionId: string): void {
  if (!existsSync(SESSIONS_DIR)) return;
  outer: for (const dir of readdirSync(SESSIONS_DIR)) {
    const dirPath = join(SESSIONS_DIR, dir);
    try {
      for (const file of readdirSync(dirPath)) {
        if (!file.endsWith(".jsonl")) continue;
        const uuidMatch = file.match(/_([0-9a-f-]{36})\.jsonl$/);
        const id = uuidMatch?.[1] ?? "";
        if (id === sessionId) {
          unlinkSync(join(dirPath, file));
          break outer;
        }
        const fp = join(dirPath, file);
        const firstLine = readFileSync(fp, "utf8").split("\n")[0];
        try {
          const header = JSON.parse(firstLine);
          if (header.id === sessionId) {
            unlinkSync(fp);
            break outer;
          }
        } catch {}
      }
    } catch {}
  }
}

function contentToPi(content: CanonicalContent[]): Array<{ type: string; text: string }> {
  return content.map((c) => {
    if (c.type === "text") return { type: "text", text: c.text };
    if (c.type === "tool_use")
      return { type: "text", text: `[tool: ${c.name}]\n${JSON.stringify(c.input, null, 2)}` };
    if (c.type === "tool_result")
      return { type: "text", text: `[tool result${c.is_error ? " (error)" : ""}]\n${c.content}` };
    return { type: "text", text: "" };
  });
}

// Pi uses 8-char lowercase hex IDs for records (not UUIDs, not OpenCode-style IDs)
function shortHex(): string {
  return Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
}

export function write(session: CanonicalSession, targetCwd?: string): string {
  const cwd = targetCwd ?? session.cwd;
  const title = session.title || session.id;
  const escapedDir = escapeCwd(cwd);
  const dir = join(SESSIONS_DIR, escapedDir);
  mkdirSync(dir, { recursive: true });

  // Session ID must be a UUID (not the source tool's ID format)
  const sessionUUID = crypto.randomUUID();
  const now = session.createdAt ?? new Date().toISOString();
  // Filename: <ISO timestamp with colons/dots replaced>_<uuid>.jsonl
  const tsForFile = now.replace(/:/g, "-").replace(/\./g, "-");
  const fileName = `${tsForFile}_${sessionUUID}.jsonl`;

  // Build records with a proper linked list: each record's parentId = previous record's id
  const sessionInfoId = shortHex();
  const customMsgId = shortHex();

  const records: any[] = [
    { type: "session", version: 3, id: sessionUUID, timestamp: now, cwd, parentSession: null },
    { type: "session_info", name: title, id: sessionInfoId, parentId: null, timestamp: now },
    {
      type: "custom_message",
      customType: "sessionbridge-import",
      content: `Imported from migrate tool at ${new Date().toISOString()}`,
      display: true,
      details: { source: "migrate" },
      id: customMsgId,
      parentId: sessionInfoId,
      timestamp: now,
    },
  ];

  const zeroUsage = {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };

  let prevId: string = customMsgId;
  for (const msg of session.messages) {
    const id = shortHex();
    const ts = msg.timestamp ?? now;
    records.push({
      type: "message",
      message: {
        role: msg.role,
        content: contentToPi(msg.content),
        ...(msg.timestamp ? { timestamp: new Date(msg.timestamp).getTime() } : {}),
        // Pi requires usage/stopReason on assistant messages to render token totals
        ...(msg.role === "assistant" ? { usage: zeroUsage, stopReason: "stop" } : {}),
      },
      id,
      parentId: prevId,
      timestamp: ts,
    });
    prevId = id;
  }

  writeFileSync(join(dir, fileName), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return sessionUUID;
}
