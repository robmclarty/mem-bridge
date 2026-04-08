import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import AdmZip from "adm-zip";
import type { Artifact, HarvestOptions, Learning, Manifest } from "./types.js";
import { scanAll, summarizeArtifacts, labelForSource } from "./scanner.js";
import { loadPatterns, redactText, extractLearnings } from "./sanitizer.js";

// ---------------------------------------------------------------------------
// Interactive review
// ---------------------------------------------------------------------------

async function askUser(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

async function interactiveReview(items: Learning[]): Promise<Learning[]> {
  if (items.length === 0) {
    console.log("\n  No items to review.");
    return [];
  }

  const approved: Learning[] = [];
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  ${items.length} learnings extracted. Review each one:`);
  console.log(`${"=".repeat(60)}`);

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    console.log(`\n  [${i + 1}/${items.length}] (${item.category})`);
    console.log(`  ${item.learning}`);
    if (item.tags.length) console.log(`  Tags: ${item.tags.join(", ")}`);

    let decided = false;
    while (!decided) {
      const choice = await askUser("  (a)pprove / (e)dit / (s)kip / (q)uit? ");
      switch (choice) {
        case "a":
          approved.push(item);
          decided = true;
          break;
        case "e": {
          const revised = await askUser("  New text: ");
          if (revised) {
            item.learning = revised;
            item.edited = true;
          }
          approved.push(item);
          decided = true;
          break;
        }
        case "s":
          decided = true;
          break;
        case "q":
          return approved;
        default:
          console.log("  Use a/e/s/q");
      }
    }
  }

  return approved;
}

// ---------------------------------------------------------------------------
// Package output
// ---------------------------------------------------------------------------

function sha256(data: string): string {
  return createHash("sha256").update(data, "utf-8").digest("hex");
}

function packageZip(
  items: Learning[],
  method: string,
  artifactCount: number,
  outputDir: string,
): string {
  mkdirSync(outputDir, { recursive: true });

  const today = new Date().toISOString().slice(0, 10);
  const now = new Date().toISOString();

  // Build learnings markdown
  const byCategory: Record<string, Learning[]> = {};
  for (const item of items) {
    const cat = item.category ?? "general";
    (byCategory[cat] ??= []).push(item);
  }

  const mdLines = [
    `# Learnings: ${today}\n`,
    `*Extracted from ${artifactCount} artifacts via ${method}*\n`,
  ];
  for (const cat of ["technical", "process", "communication", "tool", "insight", "general"]) {
    const catItems = byCategory[cat];
    if (!catItems?.length) continue;
    mdLines.push(`\n## ${cat.charAt(0).toUpperCase() + cat.slice(1)}\n`);
    for (const item of catItems) {
      mdLines.push(`- ${item.learning}`);
      if (item.tags.length) mdLines.push(`  *Tags: ${item.tags.join(", ")}*`);
    }
  }
  const learningsMd = mdLines.join("\n") + "\n";
  const learningsJson = JSON.stringify(items, null, 2);

  const manifest: Manifest = {
    version: "1.0",
    date: today,
    createdAt: now,
    extractionMethod: method,
    artifactsScanned: artifactCount,
    itemsCount: items.length,
    checksumAlgo: "sha256",
    files: {
      "learnings.md": { sha256: sha256(learningsMd) },
      "learnings.json": { sha256: sha256(learningsJson) },
    },
  };

  const zip = new AdmZip();
  zip.addFile("manifest.json", Buffer.from(JSON.stringify(manifest, null, 2)));
  zip.addFile("learnings.md", Buffer.from(learningsMd));
  zip.addFile("learnings.json", Buffer.from(learningsJson));

  const zipName = `memory-bridge-${today}.zip`;
  const zipPath = join(outputDir, zipName);
  zip.writeZip(zipPath);

  return zipPath;
}

// ---------------------------------------------------------------------------
// Main harvest flow
// ---------------------------------------------------------------------------

export async function harvest(opts: HarvestOptions): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  console.log(`\n  Memory Bridge Harvester — ${today}`);
  console.log(`  ${"=".repeat(44)}`);

  // Scan
  console.log("\n  Scanning for today's artifacts...");
  const artifacts = scanAll(opts.hours);
  const summary = summarizeArtifacts(artifacts);

  for (const [source, count] of Object.entries(summary)) {
    console.log(`    ${labelForSource(source)}: ${count}`);
  }
  console.log(`\n  Total: ${artifacts.length} artifacts`);

  if (artifacts.length === 0) {
    console.log("\n  No artifacts found. Nothing to harvest.");
    return;
  }

  if (opts.dryRun) {
    console.log("\n  Dry run — listing sources:");
    for (const a of artifacts) {
      const src = a.source.length > 70 ? "..." + a.source.slice(-67) : a.source;
      console.log(`    [${a.type}] ${src}`);
    }
    return;
  }

  // Combine artifact text
  const combined = artifacts
    .map((a) => `--- Source: ${a.type} (${a.modified}) ---\n${a.content}`)
    .join("\n\n");

  // Stage 1: Redact
  console.log("\n  Stage 1: Redacting identifiers...");
  const patterns = loadPatterns();
  const { redacted, matchCount } = redactText(combined, patterns);
  console.log(`    ${matchCount} pattern matches redacted`);

  // Stage 2: Extract
  console.log("\n  Stage 2: Extracting personal learnings...");
  let { items, method } = await extractLearnings(redacted, opts.model);
  console.log(`    ${items.length} learnings extracted via ${method}`);

  if (items.length === 0) {
    console.log("\n  No learnings extracted. Quiet day?");
    return;
  }

  // Stage 3: Review
  if (!opts.auto) {
    items = await interactiveReview(items);
    if (items.length === 0) {
      console.log("\n  No items approved.");
      return;
    }
  }

  // Package
  console.log(`\n  Packaging ${items.length} learnings...`);
  const zipPath = packageZip(items, method, artifacts.length, opts.output);
  const { size } = require("node:fs").statSync(zipPath);
  console.log(`\n  Output: ${zipPath}`);
  console.log(`  Size:   ${size.toLocaleString()} bytes`);
  console.log(`\n  Transfer this file to your personal machine.`);
  console.log(`  Drop into ~/.memory-bridge/inbox/ to auto-ingest.\n`);
}
