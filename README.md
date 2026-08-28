# SessionBridge

> [!WARNING]
> This project is generated with AI assistance. It modifies files in your home directory (session histories for Claude Code, Kiro, OpenCode, and Pi). Use it at your own risk. Always back up your sessions before running sync or convert commands. The authors take no responsibility for data loss or unintended modifications.

Convert and sync AI agent sessions between **Claude Code**, **Kiro**, **OpenCode**, and **Pi**.

Use any AI tool interchangeably — your conversation history follows you.

## Requirements

- [Bun](https://bun.sh) ≥ 1.0

## Installation

```bash
git clone https://github.com/safeith/sessionbridge
cd sessionbridge
bun install

# Add to PATH
ln -s "$PWD/src/index.ts" ~/.local/bin/sb
chmod +x ~/.local/bin/sb
```

## Commands

### List sessions

```bash
sb list <tool>
```

```bash
sb list opencode
sb list claude
sb list kiro
sb list pi
```

### Inspect a session

```bash
sb info <tool> <session-id>
```

### Convert a session

```bash
sb convert <from> <session-id> <to>
sb convert <from> <session-id> <to> --cwd <path>
```

```bash
sb convert opencode ses_xJ7mK2pQnR4vL9wA8bC3dE5fG kiro
sb convert claude 3f8a2b1c-4d5e-6f7a-8b9c-0d1e2f3a4b5c pi
sb convert kiro <session-id> opencode --cwd ~/Workspace/myproject
```

### Sync across all tools

```bash
sb sync                  # sync all tools (create + update)
sb sync --create-only    # only create missing copies, never overwrite existing
sb sync --dry-run        # preview without making changes
sb sync --from kiro      # only propagate updates from kiro
sb sync --to pi          # only create/update copies in pi
sb sync --verbose        # show each individual file operation
```

### Sync status

```bash
sb sync-status
```

## Supported tools

| Name | Alias |
|------|-------|
| `claude` | `cc`, `claudecode` |
| `kiro` | — |
| `opencode` | `oc` |
| `pi` | — |

## How sync works

Sessions are grouped across tools using a manifest at `~/.config/sessionbridge/sync-manifest.json`. Each group tracks one copy per tool with its `updatedAt` timestamp.

**Matching:** on the first sync, sessions are matched across tools by `(cwd, createdAt)` — exact match first, then within 5 minutes, then by title. Sessions that can't be matched automatically become new groups.

**Master selection:** the copy with the newest `updatedAt` among the source tools wins. That version is read and written to all other tools.

**Update detection:** after the first sync, `lastSyncAt` is recorded per group. On subsequent runs, only groups where the master's `updatedAt > lastSyncAt` are re-synced. Missing copies from a failed previous write are always retried.

**`--create-only`:** safe mode — never touches existing sessions, only fills in missing copies. Recommended on first run if you already have sessions in multiple tools.

### Typical workflow

```bash
# First time (safe — won't overwrite anything)
sb sync --create-only

# After that, run whenever you switch tools
sb sync

# Check what would change before applying
sb sync --dry-run
```

## Session storage locations

| Tool | Location |
|------|----------|
| Claude Code | `~/.claude/projects/<escaped-cwd>/<uuid>.jsonl` |
| Kiro | `~/.kiro/sessions/cli/<uuid>.json` + `.jsonl` |
| OpenCode | `~/.local/share/opencode/opencode.db` (SQLite) |
| Pi | `~/.pi/agent/sessions/<escaped-cwd>/<ts>_<uuid>.jsonl` |

## Notes

- **Tool calls** (bash, file edits, etc.) are preserved natively in Claude Code and OpenCode. When converting to Kiro or Pi — which don't have a structured tool-call format — they are flattened to readable text blocks.
- **Timestamps** (`createdAt`, `updatedAt`) are preserved across all conversions.
- **Kiro** requires `session_created_reason: "subagent"` for sessions to appear in the resume picker. SessionBridge sets this automatically.

## License

MIT
