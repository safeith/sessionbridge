#!/usr/bin/env bun
import * as claude from "./formats/claude";
import * as kiro from "./formats/kiro";
import * as opencode from "./formats/opencode";
import * as pi from "./formats/pi";
import { runSync, loadManifest } from "./sync";
import type { CanonicalSession, Tool } from "./types";

const TOOLS = { claude, kiro, opencode, pi } as const;

function usage() {
  console.log(`
SessionBridge — convert and sync AI agent sessions between tools

Commands:
  sb list <tool>                        List sessions
  sb info <tool> <session-id>           Show session details
  sb convert <from> <session-id> <to>   Convert session
  sb convert <from> <session-id> <to> --cwd <path>   Convert with different cwd
  sb sync                               Sync sessions across all tools
  sb sync --dry-run                     Preview sync without making changes
  sb sync --from <tool>                 Only propagate updates from a specific tool
  sb sync --to <tool>                   Only create/update copies in a specific tool
  sb sync --verbose                     Show each action taken
  sb sync --create-only                 Only create missing copies, never overwrite existing
  sb sync-status                        Show manifest stats

Tools: claude, kiro, opencode, pi

Examples:
  sb list opencode
  sb info claude 3f8a2b1c-4d5e-6f7a-8b9c-0d1e2f3a4b5c
  sb convert opencode ses_xJ7mK2pQnR4vL9wA8bC3dE5fG pi
  sb convert claude 3f8a2b1c-4d5e-6f7a-8b9c-0d1e2f3a4b5c kiro
  sb sync --dry-run
  sb sync --from kiro --to pi
`);
}

function resolveTool(name: string): keyof typeof TOOLS {
  const t = name.toLowerCase().trim();
  if (t in TOOLS) return t as keyof typeof TOOLS;
  if (t === "cc" || t === "claudecode") return "claude";
  if (t === "oc") return "opencode";
  throw new Error(`Unknown tool: ${name}. Valid tools: ${Object.keys(TOOLS).join(", ")}`);
}

function fmtDate(iso: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

function printTable(rows: any[], cols: string[]) {
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)));
  const header = cols.map((c, i) => c.padEnd(widths[i])).join("  ");
  const sep = widths.map((w) => "─".repeat(w)).join("──");
  console.log(header);
  console.log(sep);
  for (const row of rows) {
    console.log(cols.map((c, i) => String(row[c] ?? "").padEnd(widths[i])).join("  "));
  }
}

async function cmdList(tool: string) {
  const t = resolveTool(tool);
  const sessions = TOOLS[t].list();
  if (sessions.length === 0) {
    console.log(`No sessions found for ${t}`);
    return;
  }
  const rows = sessions.map((s) => ({
    id: s.id.slice(0, 36),
    msgs: String(s.messageCount ?? "?"),
    date: fmtDate(s.createdAt),
    cwd: s.cwd.replace(process.env.HOME ?? "", "~").slice(0, 40),
    title: s.title.slice(0, 60),
  }));
  console.log(`\n${t} sessions (${sessions.length} total)\n`);
  printTable(rows, ["id", "msgs", "date", "cwd", "title"]);
}

async function cmdInfo(tool: string, sessionId: string) {
  const t = resolveTool(tool);
  const session = TOOLS[t].read(sessionId);
  console.log(`\nSession: ${session.id}`);
  console.log(`Tool:    ${t}`);
  console.log(`Title:   ${session.title}`);
  console.log(`CWD:     ${session.cwd}`);
  console.log(`Created: ${fmtDate(session.createdAt)}`);
  console.log(`Messages: ${session.messages.length}`);
  console.log("");
  for (const msg of session.messages) {
    const icon = msg.role === "user" ? ">" : "<";
    const textBlocks = msg.content.filter((c) => c.type === "text");
    const toolBlocks = msg.content.filter((c) => c.type !== "text");
    const preview = (textBlocks[0] as any)?.text?.slice(0, 100).replace(/\n/g, " ") ?? "";
    const toolNote = toolBlocks.length > 0 ? ` [+${toolBlocks.length} tool blocks]` : "";
    console.log(`  ${icon} [${msg.role}] ${preview}${toolNote}`);
  }
}

async function cmdSync(args: string[]) {
  const dryRun = args.includes("--dry-run");
  const verbose = args.includes("--verbose");
  const createOnly = args.includes("--create-only");

  const fromIdx = args.indexOf("--from");
  const toIdx = args.indexOf("--to");
  const fromTools = fromIdx !== -1 ? [resolveTool(args[fromIdx + 1])] : undefined;
  const toTools = toIdx !== -1 ? [resolveTool(args[toIdx + 1])] : undefined;

  const modeNote = dryRun ? " (dry-run)" : createOnly ? " (create-only)" : "";
  console.log(`\nScanning sessions${modeNote}...`);

  const stats = await runSync({ dryRun, fromTools, toTools, verbose, createOnly });

  console.log(`  claude:   ${String(stats.scanned.claude).padStart(4)} sessions`);
  console.log(`  kiro:     ${String(stats.scanned.kiro).padStart(4)} sessions`);
  console.log(`  opencode: ${String(stats.scanned.opencode).padStart(4)} sessions`);
  console.log(`  pi:       ${String(stats.scanned.pi).padStart(4)} sessions`);
  console.log("");
  console.log(`New groups discovered: ${stats.newGroups}`);
  console.log(`Linked to existing:    ${stats.linked}`);
  console.log("");
  console.log(`Created: ${stats.created} new copies`);
  console.log(`Updated: ${stats.updated} stale copies`);
  console.log(`Skipped: ${stats.skipped} (up to date)`);

  if (stats.errors.length > 0) {
    console.log(`\nErrors (${stats.errors.length}):`);
    for (const e of stats.errors.slice(0, 10)) console.log(`  ! ${e}`);
    if (stats.errors.length > 10) console.log(`  ... and ${stats.errors.length - 10} more`);
  }

  if (!dryRun) console.log(`\nManifest saved.`);
}

async function cmdSyncStatus() {
  const manifest = loadManifest();
  const toolCounts: Record<string, number> = {};
  let withAllTools = 0;
  let singleTool = 0;

  for (const g of manifest.groups) {
    const tools = Object.keys(g.copies);
    for (const t of tools) toolCounts[t] = (toolCounts[t] ?? 0) + 1;
    if (tools.length === 4) withAllTools++;
    if (tools.length === 1) singleTool++;
  }

  console.log(`\nSync manifest: ~/.config/sessionbridge/sync-manifest.json`);
  console.log(`Total groups: ${manifest.groups.length}`);
  console.log(`  In all 4 tools:  ${withAllTools}`);
  console.log(`  In 1 tool only:  ${singleTool}`);
  console.log(`  In 2-3 tools:    ${manifest.groups.length - withAllTools - singleTool}`);
  console.log(`\nCopies per tool:`);
  for (const [t, c] of Object.entries(toolCounts).sort()) {
    console.log(`  ${t.padEnd(10)} ${c}`);
  }
}

async function cmdConvert(from: string, sessionId: string, to: string, targetCwd?: string) {
  const fromTool = resolveTool(from);
  const toTool = resolveTool(to);

  if (fromTool === toTool) {
    console.error("Source and target tools are the same");
    process.exit(1);
  }

  console.log(`Reading ${fromTool} session ${sessionId}...`);
  const session = TOOLS[fromTool].read(sessionId);
  console.log(`  Title: ${session.title}`);
  console.log(`  Messages: ${session.messages.length}`);

  console.log(`\nWriting to ${toTool}...`);
  const newId = TOOLS[toTool].write(session, targetCwd);
  console.log(`  Done! New session ID: ${newId}`);
  console.log(`\nRun 'sb info ${toTool} ${newId}' to verify.`);

}

const args = process.argv.slice(2);
const [cmd, ...rest] = args;

if (!cmd || cmd === "--help" || cmd === "-h") {
  usage();
  process.exit(0);
}

try {
  switch (cmd) {
    case "list": {
      if (!rest[0]) { console.error("Usage: sb list <tool>"); process.exit(1); }
      await cmdList(rest[0]);
      break;
    }
    case "info": {
      if (!rest[0] || !rest[1]) { console.error("Usage: sb info <tool> <session-id>"); process.exit(1); }
      await cmdInfo(rest[0], rest[1]);
      break;
    }
    case "convert": {
      if (!rest[0] || !rest[1] || !rest[2]) {
        console.error("Usage: sb convert <from> <session-id> <to> [--cwd <path>]");
        process.exit(1);
      }
      const cwdIdx = rest.indexOf("--cwd");
      const targetCwd = cwdIdx !== -1 ? rest[cwdIdx + 1] : undefined;
      await cmdConvert(rest[0], rest[1], rest[2], targetCwd);
      break;
    }
    case "sync": {
      await cmdSync(rest);
      break;
    }
    case "sync-status": {
      await cmdSyncStatus();
      break;
    }
    default:
      console.error(`Unknown command: ${cmd}`);
      usage();
      process.exit(1);
  }
} catch (err: any) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
