#!/usr/bin/env node

import { Command } from "commander";
import { homedir } from "node:os";
import { join } from "node:path";
import { harvest } from "./harvest.js";
import {
  ingestOnce,
  ingestFile,
  ingestWatch,
  consolidate,
  showStatus,
} from "./ingest.js";

const program = new Command();

program
  .name("mem-bridge")
  .description(
    "Extract personal professional knowledge from your workday.\n" +
    "Sanitizes on company hardware. Ingests on personal hardware.",
  )
  .version("0.1.0");

// ---------------------------------------------------------------------------
// harvest (company machine)
// ---------------------------------------------------------------------------

program
  .command("harvest")
  .description("Scan today's artifacts, extract learnings, produce a .zip")
  .option("--auto", "Skip interactive review", false)
  .option("--dry-run", "Show what would be scanned", false)
  .option("-o, --output <dir>", "Output directory", join(homedir(), "Desktop"))
  .option("--model <name>", "Ollama model name", "llama3.1:8b")
  .option("--hours <n>", "Look back N hours", "24")
  .action(async (opts) => {
    await harvest({
      auto: opts.auto,
      dryRun: opts.dryRun,
      output: opts.output,
      model: opts.model,
      hours: parseInt(opts.hours, 10),
    });
  });

// ---------------------------------------------------------------------------
// ingest (personal machine)
// ---------------------------------------------------------------------------

const ingestCmd = program
  .command("ingest")
  .description("Ingest harvested .zip files into your personal memory");

ingestCmd
  .command("once")
  .description("Process all .zip files in inbox and exit")
  .action(() => ingestOnce());

ingestCmd
  .command("watch")
  .description("Watch inbox folder for new .zip files (daemon)")
  .action(() => ingestWatch());

ingestCmd
  .command("file <path>")
  .description("Ingest a specific .zip file")
  .action((path: string) => ingestFile(path));

ingestCmd
  .command("status")
  .description("Show memory store statistics")
  .action(() => showStatus());

ingestCmd
  .command("consolidate")
  .description("Consolidate daily notes into MEMORY.md via Claude")
  .option("--days <n>", "Days to look back", "7")
  .action(async (opts) => {
    await consolidate(parseInt(opts.days, 10));
  });

// ---------------------------------------------------------------------------

program.parse();
