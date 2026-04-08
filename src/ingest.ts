import {
  existsSync, mkdirSync, readFileSync, writeFileSync,
  readdirSync, renameSync, copyFileSync, statSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import AdmZip from "adm-zip";
import type { Learning, Manifest, IngestOptions } from "./types.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const BRIDGE_HOME = process.env.MEMORY_BRIDGE_HOME ?? join(homedir(), ".memory-bridge");
const INBOX_DIR = join(BRIDGE_HOME, "inbox");
const MEMORY_DIR = join(BRIDGE_HOME, "memory");
const DAILY_DIR = join(MEMORY_DIR, "daily");
const ARCHIVE_DIR = join(BRIDGE_HOME, "archive");
const POLL_INTERVAL_MS = 10_000;

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

function ensureDirs() {
  for (const d of [INBOX_DIR, MEMORY_DIR, DAILY_DIR, ARCHIVE_DIR, join(MEMORY_DIR, "skills")]) {
    mkdirSync(d, { recursive: true });
  }

  const memoryFile = join(MEMORY_DIR, "MEMORY.md");
  if (!existsSync(memoryFile)) {
    writeFileSync(
      memoryFile,
      `# Long-Term Professional Memory

## Technical patterns

## Process insights

## Tools and techniques

## Communication

## Mental models

---
*Maintained by mem-bridge. Last consolidated: never*
`,
    );
    console.log(`  Created ${memoryFile}`);
  }

  if (!existsSync(join(MEMORY_DIR, ".git"))) {
    execSync("git init", { cwd: MEMORY_DIR, stdio: "pipe" });
    execSync("git add .", { cwd: MEMORY_DIR, stdio: "pipe" });
    execSync('git commit -m "Initialize memory store"', { cwd: MEMORY_DIR, stdio: "pipe" });
    console.log(`  Initialized git repo in ${MEMORY_DIR}`);
  }
}

function gitCommit(message: string) {
  try {
    execSync("git add .", { cwd: MEMORY_DIR, stdio: "pipe" });
    execSync(`git commit -m "${message}"`, { cwd: MEMORY_DIR, stdio: "pipe" });
  } catch {
    // Nothing to commit
  }
}

// ---------------------------------------------------------------------------
// Zip validation
// ---------------------------------------------------------------------------

function validateZip(zipPath: string): Manifest | null {
  try {
    const zip = new AdmZip(zipPath);
    const entries = zip.getEntries().map((e) => e.entryName);

    const required = ["manifest.json", "learnings.md", "learnings.json"];
    for (const r of required) {
      if (!entries.includes(r)) {
        console.log(`  Invalid zip: missing ${r}`);
        return null;
      }
    }

    const manifest: Manifest = JSON.parse(
      zip.readAsText("manifest.json"),
    );

    // Verify checksums
    for (const [filename, meta] of Object.entries(manifest.files ?? {})) {
      const actual = createHash("sha256")
        .update(zip.readFile(filename)!)
        .digest("hex");
      if (meta.sha256 && actual !== meta.sha256) {
        console.log(`  Checksum mismatch: ${filename}`);
        return null;
      }
    }

    return manifest;
  } catch (e) {
    console.log(`  Invalid zip: ${e}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Integration
// ---------------------------------------------------------------------------

function integrate(zipPath: string): number {
  const zip = new AdmZip(zipPath);
  const manifest: Manifest = JSON.parse(zip.readAsText("manifest.json"));
  const items: Learning[] = JSON.parse(zip.readAsText("learnings.json"));

  const date = manifest.date ?? new Date().toISOString().slice(0, 10);
  const method = manifest.extractionMethod ?? "unknown";
  const now = new Date().toTimeString().slice(0, 5);

  const dailyFile = join(DAILY_DIR, `${date}.md`);
  const header = existsSync(dailyFile) ? "" : `# Memory log: ${date}\n`;

  const lines = [
    header,
    `\n## Ingested at ${now} (${items.length} items via ${method})\n`,
  ];

  for (const item of items) {
    lines.push(`- **[${item.category}]** ${item.learning}`);
    if (item.tags?.length) {
      lines.push(`  *Tags: ${item.tags.join(", ")}*`);
    }
  }

  const existing = existsSync(dailyFile) ? readFileSync(dailyFile, "utf-8") : "";
  writeFileSync(dailyFile, existing + lines.join("\n") + "\n");

  gitCommit(`Ingest: ${date} (${items.length} items)`);
  return items.length;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export function ingestOnce(): void {
  ensureDirs();

  const files = readdirSync(INBOX_DIR)
    .filter((f) => f.startsWith("memory-bridge-") && f.endsWith(".zip"))
    .sort();

  if (files.length === 0) {
    console.log(`  Inbox empty. Drop files into: ${INBOX_DIR}`);
    return;
  }

  for (const file of files) {
    const zipPath = join(INBOX_DIR, file);
    console.log(`\n  Found: ${file}`);

    const manifest = validateZip(zipPath);
    if (!manifest) {
      console.log(`  Skipping invalid file.`);
      continue;
    }

    console.log(`  Date: ${manifest.date} | Items: ${manifest.itemsCount} | Method: ${manifest.extractionMethod}`);

    const count = integrate(zipPath);
    console.log(`  Integrated ${count} items.`);

    // Archive
    const archivePath = join(ARCHIVE_DIR, file);
    renameSync(zipPath, archivePath);
    console.log(`  Archived to ${archivePath}`);
  }
}

export function ingestFile(filepath: string): void {
  ensureDirs();
  if (!existsSync(filepath)) {
    console.error(`  File not found: ${filepath}`);
    process.exit(1);
  }
  const dest = join(INBOX_DIR, require("node:path").basename(filepath));
  copyFileSync(filepath, dest);
  ingestOnce();
}

export function ingestWatch(): void {
  ensureDirs();
  console.log(`  Watching: ${INBOX_DIR}`);
  console.log(`  Drop memory-bridge-*.zip files here.`);
  console.log(`  Press Ctrl+C to stop.\n`);

  const seen = new Set<string>();

  const poll = () => {
    try {
      const files = readdirSync(INBOX_DIR)
        .filter((f) => f.startsWith("memory-bridge-") && f.endsWith(".zip"));

      for (const file of files) {
        if (seen.has(file)) continue;
        seen.add(file);

        // Brief delay for file copy to finish
        setTimeout(() => {
          const zipPath = join(INBOX_DIR, file);
          if (!existsSync(zipPath)) return;

          console.log(`\n  New file: ${file}`);
          const manifest = validateZip(zipPath);
          if (manifest) {
            const count = integrate(zipPath);
            renameSync(zipPath, join(ARCHIVE_DIR, file));
            console.log(`  Ingested ${count} items. Archived.`);
          } else {
            console.log(`  Invalid file, ignoring.`);
          }
        }, 2000);
      }
    } catch {
      // Read error, retry next poll
    }
  };

  const interval = setInterval(poll, POLL_INTERVAL_MS);
  poll(); // Initial check

  process.on("SIGINT", () => {
    clearInterval(interval);
    console.log("\n  Stopped.");
    process.exit(0);
  });
}

export async function consolidate(days: number): Promise<void> {
  ensureDirs();

  const memoryFile = join(MEMORY_DIR, "MEMORY.md");
  const current = existsSync(memoryFile) ? readFileSync(memoryFile, "utf-8") : "";

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  const notes: string[] = [];
  if (existsSync(DAILY_DIR)) {
    for (const f of readdirSync(DAILY_DIR).filter((n) => n.endsWith(".md")).sort()) {
      try {
        const fileDate = new Date(f.replace(".md", ""));
        if (fileDate >= cutoff) {
          notes.push(readFileSync(join(DAILY_DIR, f), "utf-8"));
        }
      } catch {
        continue;
      }
    }
  }

  if (notes.length === 0) {
    console.log("  No recent daily notes to consolidate.");
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY ?? "";
  if (!apiKey) {
    console.log("  Set ANTHROPIC_API_KEY to use Claude for consolidation.");
    console.log("  Or edit MEMORY.md manually.");
    return;
  }

  const systemPrompt = `You are a knowledge consolidation assistant. Take daily learning notes and integrate them into a long-term memory document.

Read the existing MEMORY.md and recent daily notes. Produce an updated MEMORY.md that:
- Integrates new learnings into appropriate sections
- Merges duplicates and strengthens repeated patterns
- Promotes confirmed observations to principles
- Prunes stale or superseded entries
- Stays under 200 lines
- Updates the "Last consolidated" timestamp to today

Output the COMPLETE new MEMORY.md content. No code fences.`;

  const userMsg = `CURRENT MEMORY.md:\n---\n${current}\n---\n\nRECENT DAILY NOTES (${days} days):\n---\n${notes.join("\n---\n")}\n---\n\nProduce the updated MEMORY.md:`;

  console.log("  Running consolidation via Claude...");

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 8192,
        system: systemPrompt,
        messages: [{ role: "user", content: userMsg }],
      }),
    });

    const data = (await resp.json()) as any;
    let newText = "";
    for (const block of data.content ?? []) {
      if (block.type === "text") newText += block.text;
    }
    newText = newText.replace(/^```(?:markdown|md)?\s*\n?/, "").replace(/\n?```\s*$/, "").trim();

    const oldLines = current.split("\n").length;
    const newLines = newText.split("\n").length;

    const draftPath = join(MEMORY_DIR, "MEMORY.md.draft");
    writeFileSync(draftPath, newText);

    console.log(`  Memory: ${oldLines} → ${newLines} lines`);
    console.log(`  Draft written to: ${draftPath}`);
    console.log(`  Review it, then apply with:`);
    console.log(`    mv "${draftPath}" "${memoryFile}"`);
    console.log(`    cd "${MEMORY_DIR}" && git add . && git commit -m "Consolidate"`);
  } catch (e) {
    console.error(`  Consolidation error: ${e}`);
  }
}

export function showStatus(): void {
  ensureDirs();

  const dailyCount = existsSync(DAILY_DIR)
    ? readdirSync(DAILY_DIR).filter((f) => f.endsWith(".md")).length
    : 0;

  const memoryFile = join(MEMORY_DIR, "MEMORY.md");
  const memoryLines = existsSync(memoryFile)
    ? readFileSync(memoryFile, "utf-8").split("\n").length
    : 0;

  const archiveCount = existsSync(ARCHIVE_DIR)
    ? readdirSync(ARCHIVE_DIR).filter((f) => f.endsWith(".zip")).length
    : 0;

  const inboxCount = existsSync(INBOX_DIR)
    ? readdirSync(INBOX_DIR).filter((f) => f.endsWith(".zip")).length
    : 0;

  let totalItems = 0;
  if (existsSync(DAILY_DIR)) {
    for (const f of readdirSync(DAILY_DIR).filter((n) => n.endsWith(".md"))) {
      totalItems += (readFileSync(join(DAILY_DIR, f), "utf-8").match(/- \*\*\[/g) ?? []).length;
    }
  }

  console.log(`\n  Memory Bridge — Status`);
  console.log(`  ${"=".repeat(30)}`);
  console.log(`  Home:        ${BRIDGE_HOME}`);
  console.log(`  Inbox:       ${inboxCount} pending`);
  console.log(`  Daily notes: ${dailyCount} files`);
  console.log(`  Total items: ${totalItems}`);
  console.log(`  MEMORY.md:   ${memoryLines} lines`);
  console.log(`  Archived:    ${archiveCount} zips`);

  try {
    const log = execSync("git log --oneline -5", {
      cwd: MEMORY_DIR, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
    });
    if (log.trim()) {
      console.log(`\n  Recent commits:`);
      for (const line of log.trim().split("\n")) {
        console.log(`    ${line}`);
      }
    }
  } catch {
    // No git
  }
  console.log();
}
