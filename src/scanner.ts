import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import type { Artifact, ArtifactType } from "./types.js";

const HOME = homedir();
const MAX_FILE_SIZE = 500_000;
const MAX_CONTENT_PER_FILE = 50_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isRecentFile(filepath: string, maxAgeHours: number): boolean {
  try {
    const stat = statSync(filepath);
    const cutoff = Date.now() - maxAgeHours * 3600_000;
    return stat.mtimeMs > cutoff;
  } catch {
    return false;
  }
}

function safeReadText(filepath: string, maxBytes = MAX_CONTENT_PER_FILE): string {
  try {
    const stat = statSync(filepath);
    if (stat.size > MAX_FILE_SIZE) return "";
    const content = readFileSync(filepath, "utf-8");
    if (content.includes("\x00")) return ""; // binary
    return content.slice(0, maxBytes);
  } catch {
    return "";
  }
}

function* walkDir(
  dir: string,
  opts: { maxDepth?: number; pattern?: RegExp } = {},
): Generator<string> {
  const maxDepth = opts.maxDepth ?? 5;
  const pattern = opts.pattern ?? /./;

  function* walk(current: string, depth: number): Generator<string> {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
        yield* walk(full, depth + 1);
      } else if (entry.isFile() && pattern.test(entry.name)) {
        yield full;
      }
    }
  }
  if (existsSync(dir)) yield* walk(dir, 0);
}

function findGitRepos(): string[] {
  const repos: string[] = [];
  const bases = ["projects", "work", "src", "code", "repos", "dev"].map(
    (d) => join(HOME, d),
  );
  for (const base of bases) {
    if (!existsSync(base)) continue;
    try {
      for (const entry of readdirSync(base, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          const gitDir = join(base, entry.name, ".git");
          if (existsSync(gitDir)) repos.push(join(base, entry.name));
        }
      }
    } catch {
      continue;
    }
  }
  return repos;
}

// ---------------------------------------------------------------------------
// Claude Code artifacts
// ---------------------------------------------------------------------------

/**
 * Scan the full ~/.claude directory tree for anything relevant:
 *   - projects/<hash>/memory/*.md          (auto-memory, auto-dream output)
 *   - projects/<hash>/sessions/*.jsonl     (session transcripts)
 *   - projects/<hash>/plans/*              (generated plans)
 *   - projects/<hash>/skills/*             (generated skills)
 *   - projects/<hash>/cache/*              (cached context)
 *   - todos/*                              (todo items)
 *   - settings.json                        (global settings with memory)
 *
 * Also scan project-level files:
 *   - CLAUDE.md                            (project instructions)
 *   - .claude/settings.json                (project settings)
 *   - .claude/plans/*                      (project plans)
 *   - .claude/skills/*                     (project skills)
 */
function scanClaudeGlobal(maxAgeHours: number): Artifact[] {
  const artifacts: Artifact[] = [];
  const claudeDir = join(HOME, ".claude");

  if (!existsSync(claudeDir)) return artifacts;

  // --- Project-level memory, plans, skills, sessions ---
  const projectsDir = join(claudeDir, "projects");
  if (existsSync(projectsDir)) {
    try {
      for (const projectEntry of readdirSync(projectsDir, { withFileTypes: true })) {
        if (!projectEntry.isDirectory()) continue;
        const projectPath = join(projectsDir, projectEntry.name);

        // Memory files (auto-memory, auto-dream consolidated)
        const memoryDir = join(projectPath, "memory");
        if (existsSync(memoryDir)) {
          for (const f of walkDir(memoryDir, { pattern: /\.md$/i })) {
            if (isRecentFile(f, maxAgeHours)) {
              artifacts.push({
                source: f,
                sourceName: "claude_memory",
                type: "claude_memory",
                content: safeReadText(f),
                modified: new Date(statSync(f).mtimeMs).toISOString(),
              });
            }
          }
        }

        // Session transcripts (JSONL)
        const sessionsDir = join(projectPath, "sessions");
        if (existsSync(sessionsDir)) {
          for (const f of walkDir(sessionsDir, { pattern: /\.jsonl$/i })) {
            if (isRecentFile(f, maxAgeHours)) {
              artifacts.push({
                source: f,
                sourceName: "claude_session",
                type: "claude_session",
                content: extractSessionContent(f),
                modified: new Date(statSync(f).mtimeMs).toISOString(),
              });
            }
          }
        }

        // Plans
        const plansDir = join(projectPath, "plans");
        if (existsSync(plansDir)) {
          for (const f of walkDir(plansDir, { pattern: /\.(md|json|txt)$/i })) {
            if (isRecentFile(f, maxAgeHours)) {
              artifacts.push({
                source: f,
                sourceName: "claude_plan",
                type: "claude_plan",
                content: safeReadText(f),
                modified: new Date(statSync(f).mtimeMs).toISOString(),
              });
            }
          }
        }

        // Skills
        const skillsDir = join(projectPath, "skills");
        if (existsSync(skillsDir)) {
          for (const f of walkDir(skillsDir, { pattern: /\.(md|json|txt)$/i })) {
            if (isRecentFile(f, maxAgeHours)) {
              artifacts.push({
                source: f,
                sourceName: "claude_skill",
                type: "claude_skill",
                content: safeReadText(f),
                modified: new Date(statSync(f).mtimeMs).toISOString(),
              });
            }
          }
        }

        // Catch-all: any other .md/.json in the project hash dir
        // (covers cache, changelogs, any new artifact types Anthropic adds)
        for (const f of walkDir(projectPath, {
          pattern: /\.(md|txt)$/i,
          maxDepth: 2,
        })) {
          const already = artifacts.some((a) => a.source === f);
          if (!already && isRecentFile(f, maxAgeHours)) {
            artifacts.push({
              source: f,
              sourceName: "claude_memory",
              type: "claude_memory",
              content: safeReadText(f),
              modified: new Date(statSync(f).mtimeMs).toISOString(),
            });
          }
        }
      }
    } catch {
      // Permission or read error, skip
    }
  }

  // --- Global todos ---
  const todosDir = join(claudeDir, "todos");
  if (existsSync(todosDir)) {
    for (const f of walkDir(todosDir, { pattern: /\.(md|json|txt)$/i })) {
      if (isRecentFile(f, maxAgeHours)) {
        artifacts.push({
          source: f,
          sourceName: "claude_todo",
          type: "claude_todo",
          content: safeReadText(f),
          modified: new Date(statSync(f).mtimeMs).toISOString(),
        });
      }
    }
  }

  // --- Global settings (may contain memory entries) ---
  const globalSettings = join(claudeDir, "settings.json");
  if (existsSync(globalSettings) && isRecentFile(globalSettings, maxAgeHours)) {
    artifacts.push({
      source: globalSettings,
      sourceName: "claude_memory",
      type: "claude_memory",
      content: safeReadText(globalSettings),
      modified: new Date(statSync(globalSettings).mtimeMs).toISOString(),
    });
  }

  return artifacts;
}

/** Scan project-level CLAUDE.md and .claude/ dirs in active git repos */
function scanClaudeProjectLevel(maxAgeHours: number): Artifact[] {
  const artifacts: Artifact[] = [];

  for (const repo of findGitRepos()) {
    // CLAUDE.md at project root
    const claudeMd = join(repo, "CLAUDE.md");
    if (existsSync(claudeMd) && isRecentFile(claudeMd, maxAgeHours)) {
      artifacts.push({
        source: claudeMd,
        sourceName: "claude_project_doc",
        type: "claude_project_doc",
        content: safeReadText(claudeMd),
        modified: new Date(statSync(claudeMd).mtimeMs).toISOString(),
      });
    }

    // .claude/ directory in project
    const projectClaudeDir = join(repo, ".claude");
    if (existsSync(projectClaudeDir)) {
      for (const sub of ["plans", "skills", "memory"]) {
        const subDir = join(projectClaudeDir, sub);
        if (!existsSync(subDir)) continue;
        for (const f of walkDir(subDir, { pattern: /\.(md|json|txt)$/i })) {
          if (isRecentFile(f, maxAgeHours)) {
            const type: ArtifactType =
              sub === "plans" ? "claude_plan" :
              sub === "skills" ? "claude_skill" : "claude_memory";
            artifacts.push({
              source: f,
              sourceName: `claude_${sub}`,
              type,
              content: safeReadText(f),
              modified: new Date(statSync(f).mtimeMs).toISOString(),
            });
          }
        }
      }
    }
  }

  return artifacts;
}

/** Extract human/assistant text from a Claude Code JSONL session file */
function extractSessionContent(filepath: string): string {
  try {
    const lines = safeReadText(filepath, 200_000).split("\n").filter(Boolean);
    const messages: string[] = [];

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        const role = entry.role ?? "";
        if (role !== "user" && role !== "assistant") continue;

        if (typeof entry.content === "string" && entry.content.length > 10) {
          messages.push(`[${role}] ${entry.content.slice(0, 500)}`);
        } else if (Array.isArray(entry.content)) {
          for (const block of entry.content) {
            if (block?.type === "text" && block.text?.length > 10) {
              messages.push(`[${role}] ${block.text.slice(0, 500)}`);
            }
          }
        }
      } catch {
        continue;
      }
    }

    // Representative sample: first 20 + last 10
    const sampled = [
      ...messages.slice(0, 20),
      ...(messages.length > 30 ? messages.slice(-10) : []),
    ];
    return sampled.join("\n").slice(0, 30_000);
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Codex CLI artifacts
// ---------------------------------------------------------------------------

function scanCodex(maxAgeHours: number): Artifact[] {
  const artifacts: Artifact[] = [];
  const codexDir = join(HOME, ".codex");

  if (!existsSync(codexDir)) return artifacts;

  // MEMORY.md, rollout summaries, skills
  for (const f of walkDir(codexDir, { pattern: /\.(md|txt)$/i, maxDepth: 4 })) {
    if (isRecentFile(f, maxAgeHours)) {
      const name = basename(f).toLowerCase();
      const type: ArtifactType = name.includes("memory")
        ? "codex_memory"
        : "codex_rollout";
      artifacts.push({
        source: f,
        sourceName: type,
        type,
        content: safeReadText(f),
        modified: new Date(statSync(f).mtimeMs).toISOString(),
      });
    }
  }

  // AGENTS.md at project roots
  for (const repo of findGitRepos()) {
    const agentsMd = join(repo, "AGENTS.md");
    if (existsSync(agentsMd) && isRecentFile(agentsMd, maxAgeHours)) {
      artifacts.push({
        source: agentsMd,
        sourceName: "codex_memory",
        type: "codex_memory",
        content: safeReadText(agentsMd),
        modified: new Date(statSync(agentsMd).mtimeMs).toISOString(),
      });
    }
  }

  return artifacts;
}

// ---------------------------------------------------------------------------
// Cursor artifacts
// ---------------------------------------------------------------------------

function scanCursor(maxAgeHours: number): Artifact[] {
  const artifacts: Artifact[] = [];

  for (const repo of findGitRepos()) {
    // .cursorrules
    const rules = join(repo, ".cursorrules");
    if (existsSync(rules) && isRecentFile(rules, maxAgeHours)) {
      artifacts.push({
        source: rules,
        sourceName: "cursor_rules",
        type: "cursor_rules",
        content: safeReadText(rules),
        modified: new Date(statSync(rules).mtimeMs).toISOString(),
      });
    }

    // .cursor/ directory
    const cursorDir = join(repo, ".cursor");
    if (existsSync(cursorDir)) {
      for (const f of walkDir(cursorDir, { pattern: /\.(md|json|txt)$/i, maxDepth: 2 })) {
        if (isRecentFile(f, maxAgeHours)) {
          artifacts.push({
            source: f,
            sourceName: "cursor_rules",
            type: "cursor_rules",
            content: safeReadText(f),
            modified: new Date(statSync(f).mtimeMs).toISOString(),
          });
        }
      }
    }
  }

  return artifacts;
}

// ---------------------------------------------------------------------------
// Gemini CLI artifacts
// ---------------------------------------------------------------------------

function scanGemini(maxAgeHours: number): Artifact[] {
  const artifacts: Artifact[] = [];

  // ~/.gemini/
  const geminiDir = join(HOME, ".gemini");
  if (existsSync(geminiDir)) {
    for (const f of walkDir(geminiDir, { pattern: /\.(md|txt)$/i, maxDepth: 3 })) {
      if (isRecentFile(f, maxAgeHours)) {
        artifacts.push({
          source: f,
          sourceName: "gemini_context",
          type: "gemini_context",
          content: safeReadText(f),
          modified: new Date(statSync(f).mtimeMs).toISOString(),
        });
      }
    }
  }

  // GEMINI.md at project roots
  for (const repo of findGitRepos()) {
    const geminiMd = join(repo, "GEMINI.md");
    if (existsSync(geminiMd) && isRecentFile(geminiMd, maxAgeHours)) {
      artifacts.push({
        source: geminiMd,
        sourceName: "gemini_context",
        type: "gemini_context",
        content: safeReadText(geminiMd),
        modified: new Date(statSync(geminiMd).mtimeMs).toISOString(),
      });
    }
  }

  return artifacts;
}

// ---------------------------------------------------------------------------
// Git commits
// ---------------------------------------------------------------------------

function scanGitCommits(): Artifact[] {
  const artifacts: Artifact[] = [];

  for (const repo of findGitRepos()) {
    try {
      const result = execSync(
        `git log --since=midnight --format="%H|%s|%b" --no-merges`,
        { cwd: repo, timeout: 5000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
      );
      if (!result.trim()) continue;

      const commits = result
        .trim()
        .split("\n")
        .map((line) => {
          const [, subject, body] = line.split("|", 3);
          return `- ${subject?.trim() ?? ""}${body?.trim() ? ` — ${body.trim()}` : ""}`;
        });

      if (commits.length > 0) {
        artifacts.push({
          source: `git:${basename(repo)}`,
          sourceName: "git_commits",
          type: "git_commits",
          content: `Commits in ${basename(repo)} today:\n${commits.join("\n")}`,
          modified: new Date().toISOString(),
        });
      }
    } catch {
      continue;
    }
  }

  return artifacts;
}

// ---------------------------------------------------------------------------
// Modified documents
// ---------------------------------------------------------------------------

function scanModifiedDocs(maxAgeHours: number): Artifact[] {
  const artifacts: Artifact[] = [];
  const bases = ["Documents", "Desktop", "projects", "work", "src", "notes"].map(
    (d) => join(HOME, d),
  );

  for (const base of bases) {
    for (const f of walkDir(base, { pattern: /\.(md|txt)$/i, maxDepth: 3 })) {
      if (isRecentFile(f, maxAgeHours)) {
        artifacts.push({
          source: f,
          sourceName: "modified_doc",
          type: "modified_doc",
          content: safeReadText(f),
          modified: new Date(statSync(f).mtimeMs).toISOString(),
        });
      }
    }
  }

  return artifacts;
}

// ---------------------------------------------------------------------------
// Main scanner
// ---------------------------------------------------------------------------

export function scanAll(maxAgeHours: number): Artifact[] {
  const all: Artifact[] = [];
  const seen = new Set<string>();

  function add(artifacts: Artifact[]) {
    for (const a of artifacts) {
      if (!a.content.trim()) continue;
      if (seen.has(a.source)) continue;
      seen.add(a.source);
      all.push(a);
    }
  }

  add(scanClaudeGlobal(maxAgeHours));
  add(scanClaudeProjectLevel(maxAgeHours));
  add(scanCodex(maxAgeHours));
  add(scanCursor(maxAgeHours));
  add(scanGemini(maxAgeHours));
  add(scanGitCommits());
  add(scanModifiedDocs(maxAgeHours));

  return all;
}

/** Group artifacts by source name for summary display */
export function summarizeArtifacts(
  artifacts: Artifact[],
): Record<string, number> {
  const summary: Record<string, number> = {};
  for (const a of artifacts) {
    summary[a.sourceName] = (summary[a.sourceName] ?? 0) + 1;
  }
  return summary;
}

const SOURCE_LABELS: Record<string, string> = {
  claude_memory: "Claude Code memory / auto-dream",
  claude_session: "Claude Code session transcripts",
  claude_plan: "Claude Code generated plans",
  claude_skill: "Claude Code generated skills",
  claude_project_doc: "CLAUDE.md project docs",
  claude_todo: "Claude Code todos",
  codex_memory: "Codex CLI memory / AGENTS.md",
  codex_rollout: "Codex CLI rollouts",
  cursor_rules: "Cursor rules / context",
  gemini_context: "Gemini CLI context / GEMINI.md",
  git_commits: "Git commits (today)",
  modified_doc: "Modified markdown docs",
};

export function labelForSource(sourceName: string): string {
  return SOURCE_LABELS[sourceName] ?? sourceName;
}
