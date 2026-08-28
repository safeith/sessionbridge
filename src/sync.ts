import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { dirname } from "path";
import * as claude from "./formats/claude";
import * as kiro from "./formats/kiro";
import * as opencode from "./formats/opencode";
import * as pi from "./formats/pi";
import type { Tool, SessionSummary, SyncGroup, SyncManifest } from "./types";

const MANIFEST_PATH = `${process.env.HOME}/.config/sessionbridge/sync-manifest.json`;
const TOOL_LIST: Tool[] = ["claude", "kiro", "opencode", "pi"];
const TOOLS = { claude, kiro, opencode, pi } as const;

// --- manifest I/O ---

export function loadManifest(): SyncManifest {
  if (!existsSync(MANIFEST_PATH)) return { version: 1, groups: [] };
  try {
    return JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  } catch {
    return { version: 1, groups: [] };
  }
}

export function saveManifest(manifest: SyncManifest): void {
  mkdirSync(dirname(MANIFEST_PATH), { recursive: true });
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
}

// --- matching helpers ---

// Returns absolute ms difference between two ISO strings, or Infinity if either is missing
function tsDiff(a?: string, b?: string): number {
  if (!a || !b) return Infinity;
  return Math.abs(new Date(a).getTime() - new Date(b).getTime());
}

// Find an existing group for a session — first by exact (cwd, createdAt),
// then by fuzzy createdAt within 5 minutes, then by exact (cwd, title).
function findMatchingGroup(groups: SyncGroup[], s: SessionSummary): SyncGroup | null {
  // Exact match on cwd + createdAt
  const exact = groups.find((g) => g.cwd === s.cwd && tsDiff(g.createdAt, s.createdAt) === 0);
  if (exact) return exact;

  // Fuzzy match: same cwd, createdAt within 5 minutes, exactly one candidate
  const fuzzy = groups.filter((g) => g.cwd === s.cwd && tsDiff(g.createdAt, s.createdAt) < 5 * 60 * 1000);
  if (fuzzy.length === 1) return fuzzy[0];

  // Title match: same cwd + exact title (last resort)
  return groups.find((g) => g.cwd === s.cwd && g.title === s.title) ?? null;
}

function findAnyCreatedAt(g: SyncGroup): string {
  return g.createdAt ?? "";
}

// --- sync core ---

export interface SyncOptions {
  dryRun?: boolean;
  fromTools?: Tool[];
  toTools?: Tool[];
  verbose?: boolean;
  createOnly?: boolean; // skip updates, only create missing copies
}

export interface SyncStats {
  scanned: Record<Tool, number>;
  newGroups: number;
  linked: number;
  created: number;
  updated: number;
  skipped: number;
  errors: string[];
}

export async function runSync(opts: SyncOptions = {}): Promise<SyncStats> {
  const { dryRun = false, fromTools = TOOL_LIST, toTools = TOOL_LIST, verbose = false, createOnly = false } = opts;

  const stats: SyncStats = { scanned: { claude: 0, kiro: 0, opencode: 0, pi: 0 }, newGroups: 0, linked: 0, created: 0, updated: 0, skipped: 0, errors: [] };

  // Step 1: scan all tools
  const allSessions: Partial<Record<Tool, SessionSummary[]>> = {};
  for (const tool of TOOL_LIST) {
    try {
      allSessions[tool] = TOOLS[tool].list();
      stats.scanned[tool] = allSessions[tool]!.length;
    } catch (e: any) {
      stats.errors.push(`scan ${tool}: ${e.message}`);
      allSessions[tool] = [];
    }
  }

  // Step 2: load manifest and build lookup index
  const manifest = loadManifest();

  // Index existing groups: tool → id → group
  const knownIds = new Map<string, SyncGroup>(); // key: "tool:id"
  for (const g of manifest.groups) {
    for (const [tool, copy] of Object.entries(g.copies) as [Tool, { id: string; updatedAt: string }][]) {
      knownIds.set(`${tool}:${copy.id}`, g);
    }
  }

  // Step 3: discover new sessions not yet in manifest
  for (const tool of TOOL_LIST) {
    for (const s of allSessions[tool] ?? []) {
      const key = `${tool}:${s.id}`;
      if (knownIds.has(key)) continue; // already tracked

      const match = findMatchingGroup(manifest.groups, s);
      const updatedAt = s.updatedAt ?? s.createdAt;

      if (match) {
        // Link to existing group
        match.copies[tool] = { id: s.id, updatedAt };
        knownIds.set(key, match);
        stats.linked++;
        if (verbose) console.log(`  linked ${tool}:${s.id.slice(0, 8)} → group ${match.id.slice(0, 8)}`);
      } else {
        // New group
        const group: SyncGroup = {
          id: crypto.randomUUID(),
          title: s.title,
          cwd: s.cwd,
          createdAt: s.createdAt,
          copies: { [tool]: { id: s.id, updatedAt } },
          lastSyncAt: "",
        };
        manifest.groups.push(group);
        knownIds.set(key, group as SyncGroup);
        stats.newGroups++;
      }
    }
  }

  // Step 4: prune stale copy references (session was deleted outside migrate)
  for (const g of manifest.groups) {
    for (const tool of TOOL_LIST) {
      const copy = g.copies[tool];
      if (!copy) continue;
      const stillExists = (allSessions[tool] ?? []).some((s) => s.id === copy.id);
      if (!stillExists) {
        delete g.copies[tool];
        knownIds.delete(`${tool}:${copy.id}`);
      }
    }
  }

  // Step 5: for each group, determine what needs syncing
  const targetTools = toTools.filter((t) => t !== undefined);

  for (const g of manifest.groups) {
    const copies = Object.entries(g.copies) as [Tool, { id: string; updatedAt: string }][];
    if (copies.length === 0) continue;

    // Find the master: newest copy among fromTools; fall back to any copy
    const candidates = copies.filter(([t]) => fromTools.includes(t));
    if (candidates.length === 0) continue;

    const [masterTool, masterCopy] = candidates.reduce((best, cur) =>
      cur[1].updatedAt > best[1].updatedAt ? cur : best
    );

    // Determine which target tools need work
    const targets = targetTools.filter((t) => t !== masterTool);
    if (targets.length === 0) {
      stats.skipped++;
      continue;
    }

    // Always check for missing copies first (retry failed previous writes)
    const needsCreate = targets.filter((t) => !g.copies[t]);
    // Only check for updates if master changed since last sync
    const masterUpdated = !g.lastSyncAt || masterCopy.updatedAt > g.lastSyncAt;
    const needsUpdate = createOnly || !masterUpdated
      ? []
      : targets.filter((t) => g.copies[t] && g.copies[t]!.updatedAt < masterCopy.updatedAt);

    if (needsCreate.length === 0 && needsUpdate.length === 0) {
      stats.skipped++;
      continue;
    }

    if (dryRun) {
      if (needsCreate.length > 0) console.log(`  [dry-run] would create ${g.title.slice(0, 50)} in ${needsCreate.join(", ")}`);
      if (needsUpdate.length > 0) console.log(`  [dry-run] would update ${g.title.slice(0, 50)} in ${needsUpdate.join(", ")}`);
      stats.created += needsCreate.length;
      stats.updated += needsUpdate.length;
      continue;
    }

    // Read the master session
    let session;
    try {
      session = TOOLS[masterTool].read(masterCopy.id);
    } catch (e: any) {
      stats.errors.push(`read ${masterTool}:${masterCopy.id.slice(0, 8)}: ${e.message}`);
      continue;
    }

    // Create missing copies
    for (const t of needsCreate) {
      try {
        const newId = TOOLS[t].write(session);
        g.copies[t] = { id: newId, updatedAt: masterCopy.updatedAt };
        knownIds.set(`${t}:${newId}`, g);
        stats.created++;
        if (verbose) console.log(`  created ${t}:${newId.slice(0, 8)} from ${masterTool}:${masterCopy.id.slice(0, 8)}`);
      } catch (e: any) {
        stats.errors.push(`write ${t} (${g.title.slice(0, 30)}): ${e.message}`);
      }
    }

    // Update stale copies
    for (const t of needsUpdate) {
      const oldCopy = g.copies[t]!;
      try {
        TOOLS[t].remove(oldCopy.id);
        const newId = TOOLS[t].write(session);
        g.copies[t] = { id: newId, updatedAt: masterCopy.updatedAt };
        knownIds.delete(`${t}:${oldCopy.id}`);
        knownIds.set(`${t}:${newId}`, g);
        stats.updated++;
        if (verbose) console.log(`  updated ${t}:${oldCopy.id.slice(0, 8)} → ${newId.slice(0, 8)}`);
      } catch (e: any) {
        stats.errors.push(`update ${t}:${oldCopy.id.slice(0, 8)}: ${e.message}`);
      }
    }

    g.lastSyncAt = new Date().toISOString();
  }

  // Remove empty groups
  manifest.groups = manifest.groups.filter((g) => Object.keys(g.copies).length > 0);

  if (!dryRun) saveManifest(manifest);

  return stats;
}
