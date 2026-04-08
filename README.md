# mem-bridge

Extract personal professional knowledge from your workday — privately, portably, automatically.

## Install

```bash
npm install -g mem-bridge
```

## Two Commands, Two Machines

```
COMPANY MACHINE                         YOUR MACHINE
───────────────                         ────────────
                                        
  Claude sessions ─┐                    inbox/
  Claude memory    ─┤                     memory-bridge-2026-04-08.zip
  Claude plans     ─┤                        │
  Claude skills    ─┤                        ▼
  Codex rollouts   ─┼→ mem-bridge harvest  mem-bridge ingest once
  Cursor rules     ─┤      │                 │
  Gemini context   ─┤      ▼                 ▼
  Git commits      ─┤  Redact patterns    daily/2026-04-08.md
  Modified docs    ─┘  Extract via LLM       │
                       Review (optional)     ▼
                           │             MEMORY.md
                           ▼
                   ~/Desktop/memory-bridge-2026-04-08.zip
                           │
                     ── air gap ──
                    (AirDrop, USB,
                     personal sync)
```

Sanitization happens on the company machine. Proprietary data never crosses the gap.

## Daily Workflow

### End of day (company machine)

```bash
mem-bridge harvest           # Interactive: review each learning
mem-bridge harvest --auto    # Trust the sanitization, skip review
mem-bridge harvest --dry-run # See what would be scanned
```

The harvester scans:

| Source | What it finds |
|--------|--------------|
| `~/.claude/projects/*/memory/` | Auto-memory, auto-dream consolidated knowledge |
| `~/.claude/projects/*/sessions/` | Session transcripts (JSONL) |
| `~/.claude/projects/*/plans/` | Generated execution plans |
| `~/.claude/projects/*/skills/` | Generated skills |
| `~/.claude/todos/` | Todo items |
| `~/.claude/settings.json` | Global settings with memory entries |
| `CLAUDE.md` in git repos | Project-level instructions |
| `.claude/plans/`, `.claude/skills/` in repos | Project-level plans and skills |
| `~/.codex/` | Codex memory, rollouts, skills |
| `AGENTS.md` in git repos | Codex project instructions |
| `.cursorrules`, `.cursor/` | Cursor context files |
| `~/.gemini/`, `GEMINI.md` | Gemini CLI context |
| Git repos | Today's commit messages |
| `~/Documents`, `~/projects`, etc. | Markdown files modified today |

Output: `~/Desktop/memory-bridge-2026-04-08.zip` (2-4 KB, fully sanitized)

### Transfer (30 seconds)

Move the .zip to your personal machine. AirDrop, USB, personal email, Signal — whatever you prefer. The file is already clean.

### Ingestion (personal machine, automatic)

```bash
# Watch mode (run once, keeps watching)
mem-bridge ingest watch

# Or process inbox manually
mem-bridge ingest once

# Or ingest a specific file
mem-bridge ingest file ~/Downloads/memory-bridge-2026-04-08.zip
```

Drop .zip files into `~/.memory-bridge/inbox/`. The watcher picks them up automatically.

### Weekly consolidation

```bash
mem-bridge ingest consolidate           # Last 7 days
mem-bridge ingest consolidate --days 14 # Last 14 days
```

Uses your Anthropic API key to consolidate daily notes into `MEMORY.md`.

### Check status

```bash
mem-bridge ingest status
```

## Sanitization Pipeline

Every piece of knowledge passes through three stages:

1. **Pattern redaction** — Regex strips emails, internal URLs, API keys, Slack tokens, ticket IDs, UUIDs, IP addresses, file paths, dollar amounts. Add company-specific patterns via `company_patterns.yaml`.

2. **LLM generalization** — Tries Anthropic API (if `ANTHROPIC_API_KEY` is set), then Ollama (if running), then heuristic fallback. The LLM converts specifics to general patterns: "Fixed the auth service rate limiter" → "Learned to debug rate limiting in auth middleware."

3. **Human review** — Each extracted learning shown for approval. Skip with `--auto` once you trust the pipeline.

## Company Patterns

Copy `company_patterns.example.yaml` to `company_patterns.yaml` in your working directory:

```yaml
- pattern: "\\bAcmeCorp\\b"
  replacement: "[COMPANY]"
- pattern: "\\bProject\\s+Phoenix\\b"
  replacement: "[PROJECT]"
```

These run before the LLM sees anything. Update when you change jobs.

## Memory Structure

```
~/.memory-bridge/
├── inbox/                         # Drop .zip files here
├── archive/                       # Processed .zip files
└── memory/                        # Git-versioned memory store
    ├── .git/
    ├── MEMORY.md                  # Long-term consolidated knowledge
    ├── daily/
    │   ├── 2026-04-01.md
    │   ├── 2026-04-02.md
    │   └── ...
    └── skills/                    # (Future) technique library
```

All markdown. All git-versioned. Portable to any future tool.

## Environment Variables

| Variable | Used where | Purpose |
|----------|-----------|---------|
| `ANTHROPIC_API_KEY` | Both machines | LLM extraction and consolidation |
| `MEMORY_BRIDGE_HOME` | Personal machine | Override `~/.memory-bridge` path |

## Requirements

- Node.js 20+
- Git (for memory versioning)
- Optional: Ollama (if no Anthropic API key on company machine)

## License

MIT
