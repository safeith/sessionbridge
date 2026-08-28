/**
 * Claude Code session format
 * Location: ~/.claude/projects/<escaped-cwd>/<uuid>.jsonl
 * Escaping: path separators and dots → dashes
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "fs";
import { join } from "path";
import type { CanonicalContent, CanonicalMessage, CanonicalSession, SessionSummary } from "../types";

const PROJECTS_DIR = `${process.env.HOME}/.claude/projects`;

function escapeCwd(p: string): string {
  return p.replace(/[\/\.]/g, "-");
}

function readLines(filePath: string): any[] {
  return readFileSync(filePath, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

function contentToCanonical(content: any): CanonicalContent {
  if (typeof content === "string") return { type: "text", text: content };
  if (content.type === "tool_use") {
    return { type: "tool_use", id: content.id, name: content.name, input: content.input };
  }
  if (content.type === "tool_result") {
    const text = Array.isArray(content.content)
      ? content.content.map((x: any) => x.text ?? "").join("")
      : String(content.content ?? "");
    return { type: "tool_result", tool_use_id: content.tool_use_id, content: text, is_error: content.is_error };
  }
  return { type: "text", text: content.text ?? JSON.stringify(content) };
}

export function list(): SessionSummary[] {
  if (!existsSync(PROJECTS_DIR)) return [];
  const results: SessionSummary[] = [];

  for (const dir of readdirSync(PROJECTS_DIR)) {
    const dirPath = join(PROJECTS_DIR, dir);
    try {
      for (const file of readdirSync(dirPath)) {
        if (!file.endsWith(".jsonl")) continue;
        const sessionId = file.replace(".jsonl", "");
        const lines = readLines(join(dirPath, file));
        const cwd = lines.find((l) => l.type === "user" && l.cwd)?.cwd ?? "";
        const msgLines = lines.filter((l) => l.type === "user" || l.type === "assistant");
        const firstUser = msgLines.find((l) => l.type === "user");
        const firstText =
          firstUser?.message?.content?.find?.((c: any) => c?.type === "text")?.text ??
          (typeof firstUser?.message?.content === "string" ? firstUser.message.content : "") ??
          "";
        const timestamps = msgLines.map((l) => l.timestamp).filter(Boolean);
        results.push({
          id: sessionId,
          title: firstText.slice(0, 80) || sessionId,
          cwd,
          createdAt: timestamps[0] ?? "",
          updatedAt: timestamps.at(-1) ?? timestamps[0] ?? "",
          messageCount: msgLines.length,
        });
      }
    } catch {}
  }

  return results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function read(sessionId: string): CanonicalSession {
  if (!existsSync(PROJECTS_DIR)) throw new Error("Claude projects dir not found");

  let filePath: string | null = null;
  for (const dir of readdirSync(PROJECTS_DIR)) {
    const candidate = join(PROJECTS_DIR, dir, `${sessionId}.jsonl`);
    if (existsSync(candidate)) {
      filePath = candidate;
      break;
    }
  }

  if (!filePath) throw new Error(`Claude session not found: ${sessionId}`);

  const lines = readLines(filePath);
  const cwd = lines.find((l) => l.type === "user" && l.cwd)?.cwd ?? "";

  const messages: CanonicalMessage[] = [];
  for (const line of lines) {
    if (line.type !== "user" && line.type !== "assistant") continue;
    const msg = line.message;
    if (!msg) continue;
    const content = Array.isArray(msg.content)
      ? msg.content.map(contentToCanonical)
      : [{ type: "text" as const, text: String(msg.content ?? "") }];
    messages.push({
      id: line.uuid ?? crypto.randomUUID(),
      parentId: line.parentUuid ?? undefined,
      role: msg.role,
      content,
      timestamp: line.timestamp,
    });
  }

  const firstText =
    messages.find((m) => m.role === "user")?.content.find((c) => c.type === "text")?.text ?? "";
  const timestamps = messages.map((m) => m.timestamp).filter(Boolean) as string[];
  return {
    id: sessionId,
    title: (firstText as string).slice(0, 80) || sessionId,
    cwd,
    createdAt: timestamps[0] ?? new Date().toISOString(),
    updatedAt: timestamps.at(-1) ?? timestamps[0],
    messages,
  };
}

export function remove(sessionId: string): void {
  if (!existsSync(PROJECTS_DIR)) return;
  for (const dir of readdirSync(PROJECTS_DIR)) {
    const candidate = join(PROJECTS_DIR, dir, `${sessionId}.jsonl`);
    if (existsSync(candidate)) {
      unlinkSync(candidate);
      return;
    }
  }
}

export function write(session: CanonicalSession, targetCwd?: string): string {
  const id = crypto.randomUUID();
  const cwd = targetCwd ?? session.cwd;
  const dir = join(PROJECTS_DIR, escapeCwd(cwd));
  mkdirSync(dir, { recursive: true });

  const lines: any[] = [
    { type: "mode", mode: "normal", sessionId: id },
    { type: "permission-mode", permissionMode: "default", sessionId: id },
  ];

  let prevUuid: string | null = null;
  for (const msg of session.messages) {
    const uuid = msg.id ?? crypto.randomUUID();
    lines.push({
      type: msg.role,
      parentUuid: prevUuid,
      isSidechain: false,
      message: { role: msg.role, content: msg.content },
      uuid,
      timestamp: msg.timestamp ?? new Date().toISOString(),
      permissionMode: "default",
      cwd,
      sessionId: id,
      version: "1.0.0",
    });
    prevUuid = uuid;
  }

  const filePath = join(dir, `${id}.jsonl`);
  writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return id;
}
