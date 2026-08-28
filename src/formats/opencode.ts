/**
 * OpenCode session format
 * Location: ~/.local/share/opencode/opencode.db (SQLite)
 * Tables: session, message, part
 * User content: parts with type="text"
 * Assistant content: parts with type="text"|"reasoning"|"tool"
 */

import { Database } from "bun:sqlite";
import { readdirSync, existsSync } from "fs";
import type { CanonicalContent, CanonicalMessage, CanonicalSession, SessionSummary } from "../types";

const SHARE_DIR = `${process.env.HOME}/.local/share/opencode`;
const WRITE_DB = `${SHARE_DIR}/opencode.db`;

function allDbPaths(): string[] {
  if (!existsSync(SHARE_DIR)) return [];
  return readdirSync(SHARE_DIR)
    .filter((f) => f.endsWith(".db") && !f.endsWith("-shm") && !f.endsWith("-wal"))
    .map((f) => `${SHARE_DIR}/${f}`);
}

function findDbForSession(sessionId: string): string | null {
  for (const dbPath of allDbPaths()) {
    try {
      const db = new Database(dbPath, { readonly: true });
      const row = db.query("SELECT id FROM session WHERE id = ?").get(sessionId);
      db.close();
      if (row) return dbPath;
    } catch {}
  }
  return null;
}

export function list(): SessionSummary[] {
  const seen = new Set<string>();
  const results: SessionSummary[] = [];

  for (const dbPath of allDbPaths()) {
    try {
      const db = new Database(dbPath, { readonly: true });
      const rows = db.query("SELECT id, title, directory, time_created, time_updated FROM session ORDER BY time_created DESC").all() as any[];
      const counts = db.query("SELECT session_id, COUNT(*) as c FROM message GROUP BY session_id").all() as any[];
      const countMap = new Map(counts.map((r: any) => [r.session_id, r.c]));
      db.close();
      for (const r of rows) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        results.push({
          id: r.id,
          title: r.title,
          cwd: r.directory,
          createdAt: new Date(r.time_created).toISOString(),
          updatedAt: new Date(r.time_updated ?? r.time_created).toISOString(),
          messageCount: countMap.get(r.id) ?? 0,
        });
      }
    } catch {}
  }

  return results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function read(sessionId: string): CanonicalSession {
  const dbPath = findDbForSession(sessionId);
  if (!dbPath) throw new Error(`OpenCode session not found: ${sessionId}`);
  const db = new Database(dbPath, { readonly: true });
  try {
    const session = db.query("SELECT id, title, directory, time_created FROM session WHERE id = ?").get(sessionId) as any;
    if (!session) throw new Error(`OpenCode session not found: ${sessionId}`);

    const messages = db
      .query("SELECT id, data, time_created FROM message WHERE session_id = ? ORDER BY time_created")
      .all(sessionId) as any[];

    const parts = db
      .query("SELECT message_id, data FROM part WHERE session_id = ? ORDER BY time_created")
      .all(sessionId) as any[];

    // Group parts by message_id
    const partsByMsg = new Map<string, any[]>();
    for (const p of parts) {
      const data = JSON.parse(p.data);
      if (!partsByMsg.has(p.message_id)) partsByMsg.set(p.message_id, []);
      partsByMsg.get(p.message_id)!.push(data);
    }

    const canonical: CanonicalMessage[] = [];
    for (const msg of messages) {
      const data = JSON.parse(msg.data);
      const role = data.role as "user" | "assistant";
      if (!role || !["user", "assistant"].includes(role)) continue;

      const msgParts = partsByMsg.get(msg.id) ?? [];
      const content: CanonicalContent[] = [];

      for (const part of msgParts) {
        if (part.type === "text" && part.text) {
          content.push({ type: "text", text: part.text });
        } else if (part.type === "reasoning" && part.text) {
          // Skip reasoning parts — they're internal model thoughts
        } else if (part.type === "tool") {
          const state = part.state ?? {};
          content.push({
            type: "tool_use",
            id: part.callID ?? crypto.randomUUID(),
            name: part.tool ?? "unknown",
            input: state.input,
          });
          if (state.output !== undefined) {
            content.push({
              type: "tool_result",
              tool_use_id: part.callID ?? "",
              content: typeof state.output === "string" ? state.output : JSON.stringify(state.output),
              is_error: state.status === "error",
            });
          }
        }
      }

      canonical.push({
        id: msg.id,
        parentId: data.parentID,
        role,
        content,
        timestamp: new Date(data.time?.created ?? msg.time_created).toISOString(),
      });
    }

    return {
      id: session.id,
      title: session.title,
      cwd: session.directory,
      createdAt: new Date(session.time_created).toISOString(),
      updatedAt: new Date(session.time_updated ?? session.time_created).toISOString(),
      messages: canonical,
    };
  } finally {
    db.close();
  }
}

export function remove(sessionId: string): void {
  const dbPath = findDbForSession(sessionId);
  if (!dbPath) return;
  const db = new Database(dbPath);
  try {
    db.run("DELETE FROM part WHERE session_id = ?", [sessionId]);
    db.run("DELETE FROM message WHERE session_id = ?", [sessionId]);
    db.run("DELETE FROM session WHERE id = ?", [sessionId]);
  } finally {
    db.close();
  }
}

export function write(session: CanonicalSession, targetCwd?: string): string {
  const db = new Database(WRITE_DB);
  try {
    const cwd = targetCwd ?? session.cwd;
    const title = session.title || session.id;
    const now = Date.now();
    const createdMs = session.createdAt ? new Date(session.createdAt).getTime() : now;
    const updatedMs = session.updatedAt ? new Date(session.updatedAt).getTime() : createdMs;

    // Find or create a project for this cwd
    let projectId = (db.query("SELECT id FROM project WHERE worktree = ?").get(cwd) as any)?.id;
    if (!projectId) {
      projectId = crypto.randomUUID();
      db.run(
        "INSERT INTO project (id, worktree, time_created, time_updated, sandboxes, name) VALUES (?, ?, ?, ?, ?, ?)",
        [projectId, cwd, createdMs, updatedMs, "[]", title.slice(0, 40)]
      );
    }

    const sessionId = "ses_" + crypto.randomUUID().replace(/-/g, "").slice(0, 20);
    db.run(
      `INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [sessionId, projectId, title.slice(0, 30).replace(/\s+/g, "-").toLowerCase(), cwd, title, "1.0.0", createdMs, updatedMs]
    );

    for (const msg of session.messages) {
      const msgId = "msg_" + crypto.randomUUID().replace(/-/g, "").slice(0, 20);
      const ts = msg.timestamp ? new Date(msg.timestamp).getTime() : now;
      db.run(
        "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
        [msgId, sessionId, ts, ts, JSON.stringify({ role: msg.role, time: { created: ts } })]
      );

      for (const block of msg.content) {
        const partId = "prt_" + crypto.randomUUID().replace(/-/g, "").slice(0, 20);
        let partData: any;

        if (block.type === "text") {
          partData = { type: "text", text: block.text };
        } else if (block.type === "tool_use") {
          partData = { type: "tool", callID: block.id, tool: block.name, state: { status: "completed", input: block.input } };
        } else if (block.type === "tool_result") {
          // Find matching tool part and update its output
          partData = { type: "tool", callID: block.tool_use_id, tool: "result", state: { status: block.is_error ? "error" : "completed", output: block.content } };
        } else {
          continue;
        }

        db.run(
          "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
          [partId, msgId, sessionId, ts, ts, JSON.stringify(partData)]
        );
      }
    }

    return sessionId;
  } finally {
    db.close();
  }
}
