import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Learning, RedactionPattern } from "./types.js";

// ---------------------------------------------------------------------------
// Built-in redaction patterns
// ---------------------------------------------------------------------------

const BUILTIN_PATTERNS: RedactionPattern[] = [
  { pattern: "\\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Z|a-z]{2,}\\b", replacement: "[EMAIL]" },
  { pattern: "https?://(?:internal|intranet|corp|staging|dev|admin|ci|cd|jenkins|gitlab|jira|confluence|notion)\\.[^\\s]+", replacement: "[INTERNAL_URL]" },
  { pattern: "https?://[^\\s]*(?:\\.slack\\.com|\\.atlassian\\.net|\\.linear\\.app|\\.notion\\.so|\\.figma\\.com)[^\\s]*", replacement: "[WORK_URL]" },
  { pattern: "#[a-z0-9][a-z0-9_-]{1,79}", replacement: "[CHANNEL]" },
  { pattern: "arn:aws:[a-z0-9-]+:[a-z0-9-]*:\\d{12}:[^\\s]+", replacement: "[AWS_ARN]" },
  { pattern: "projects/[a-z][a-z0-9-]*/", replacement: "[GCP_PROJECT]/" },
  { pattern: "\\b(?:sk|pk|api|token|key|secret|bearer|password|passwd|pwd)[_-][A-Za-z0-9_-]{16,}\\b", replacement: "[REDACTED_KEY]" },
  { pattern: "\\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\\b", replacement: "[GITHUB_TOKEN]" },
  { pattern: "\\bxoxb-[A-Za-z0-9-]+\\b", replacement: "[SLACK_TOKEN]" },
  { pattern: "\\b(?:10|172\\.(?:1[6-9]|2\\d|3[01])|192\\.168)\\.\\d{1,3}\\.\\d{1,3}\\b", replacement: "[INTERNAL_IP]" },
  { pattern: "\\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\b", replacement: "[UUID]" },
  { pattern: "\\b[A-Z]{2,10}-\\d{1,6}\\b", replacement: "[TICKET]" },
  { pattern: "(?:/(?:home|Users)/[a-zA-Z0-9_.]+/[^\\s]+)", replacement: "[PATH]" },
  { pattern: "\\$[\\d,]+(?:\\.\\d{2})?(?:\\s*(?:M|K|B|million|thousand|billion))?", replacement: "[AMOUNT]" },
  { pattern: "\\b\\d{1,3}(?:,\\d{3}){2,}\\b", replacement: "[NUMBER]" },
];

// ---------------------------------------------------------------------------
// Load custom company patterns
// ---------------------------------------------------------------------------

export function loadPatterns(customFile?: string): RedactionPattern[] {
  const patterns = [...BUILTIN_PATTERNS];

  // Try company_patterns.yaml next to the script, or at custom path
  const candidates = [
    customFile,
    join(process.cwd(), "company_patterns.yaml"),
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      // Dynamic import would be cleaner but we need sync here
      const yaml = require("js-yaml");
      const content = readFileSync(candidate, "utf-8");
      const custom = yaml.load(content) as RedactionPattern[] | null;
      if (Array.isArray(custom)) {
        for (const entry of custom) {
          patterns.push({
            pattern: entry.pattern,
            replacement: entry.replacement ?? "[REDACTED]",
          });
        }
      }
      break; // Use first found
    } catch {
      continue;
    }
  }

  return patterns;
}

// ---------------------------------------------------------------------------
// Stage 1: Pattern-based redaction
// ---------------------------------------------------------------------------

export function redactText(
  text: string,
  patterns: RedactionPattern[],
): { redacted: string; matchCount: number } {
  let result = text;
  let matchCount = 0;

  for (const { pattern, replacement } of patterns) {
    try {
      const re = new RegExp(pattern, "gi");
      const matches = result.match(re);
      if (matches) {
        matchCount += matches.length;
        result = result.replace(re, replacement);
      }
    } catch {
      // Invalid regex, skip
    }
  }

  return { redacted: result, matchCount };
}

// ---------------------------------------------------------------------------
// Stage 2: LLM extraction
// ---------------------------------------------------------------------------

const EXTRACTION_PROMPT = `You are a personal learning extraction assistant. Read through work artifacts from today and extract what the PERSON learned — their professional growth, not company information.

Extract PERSONAL PROFESSIONAL KNOWLEDGE: technical skills, problem-solving insights, communication lessons, process improvements, tool discoveries, mental model refinements.

STRICT RULES:
1. NEVER include company names, product names, project codenames, customer names, colleague names, or internal terminology.
2. Convert ALL specifics to general patterns:
   "Fixed the auth service's rate limiter" → "Learned to debug rate limiting in auth middleware"
3. Common public technologies (Python, React, PostgreSQL) are fine.
4. Strip ALL business metrics, user counts, revenue figures.
5. Focus on TRANSFERABLE knowledge — things useful at any company.
6. If something might be proprietary, OMIT it entirely.

Output a JSON array of objects, each with:
  - "learning": string (1-3 sentences, generalized)
  - "category": one of "technical", "process", "communication", "tool", "insight"
  - "tags": array of topic strings

Output ONLY valid JSON. No markdown fences, no commentary.`;

async function callAnthropic(text: string): Promise<Learning[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY ?? "";
  if (!apiKey) return [];

  const body = JSON.stringify({
    model: "claude-sonnet-4-20250514",
    max_tokens: 4096,
    messages: [
      {
        role: "user",
        content: `${EXTRACTION_PROMPT}\n\n---\nTODAY'S ARTIFACTS:\n---\n${text.slice(0, 60_000)}`,
      },
    ],
  });

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body,
    });
    const data = (await resp.json()) as any;
    let raw = "";
    for (const block of data.content ?? []) {
      if (block.type === "text") raw += block.text;
    }
    raw = raw.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
    const items = JSON.parse(raw);
    return Array.isArray(items) ? items : [];
  } catch (e) {
    console.error(`  Anthropic API error: ${e}`);
    return [];
  }
}

async function callOllama(
  text: string,
  model: string,
): Promise<Learning[]> {
  const body = JSON.stringify({
    model,
    messages: [
      { role: "system", content: EXTRACTION_PROMPT },
      { role: "user", content: `TODAY'S ARTIFACTS:\n---\n${text.slice(0, 30_000)}` },
    ],
    stream: false,
    options: { temperature: 0.3, num_predict: 4096 },
  });

  try {
    const resp = await fetch("http://localhost:11434/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(180_000),
    });
    const data = (await resp.json()) as any;
    let raw = data.message?.content ?? "";
    raw = raw.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
    const items = JSON.parse(raw);
    return Array.isArray(items) ? items : [];
  } catch (e) {
    console.error(`  Ollama error: ${e}`);
    return [];
  }
}

function extractHeuristic(text: string): Learning[] {
  const items: Learning[] = [];
  const triggers = [
    /(?:learned|discovered|realized|figured out|TIL|turns out|insight)[:\s]+(.+)/i,
    /(?:better approach|lesson|takeaway|next time)[:\s]+(.+)/i,
    /(?:mistake was|issue was|root cause|problem was)[:\s]+(.+)/i,
  ];

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length < 20 || trimmed.length > 500) continue;
    for (const trigger of triggers) {
      const match = trimmed.match(trigger);
      if (match) {
        items.push({
          learning: match[0].trim(),
          category: "insight",
          tags: [],
        });
        break;
      }
    }
  }
  return items;
}

export async function extractLearnings(
  text: string,
  model: string,
): Promise<{ items: Learning[]; method: string }> {
  // Try Anthropic first
  if (process.env.ANTHROPIC_API_KEY) {
    process.stdout.write("  Using Anthropic API for extraction...\n");
    const items = await callAnthropic(text);
    if (items.length > 0) return { items, method: "anthropic" };
  }

  // Try Ollama
  try {
    await fetch("http://localhost:11434/api/tags", {
      signal: AbortSignal.timeout(2000),
    });
    process.stdout.write("  Using Ollama for extraction...\n");
    const items = await callOllama(text, model);
    if (items.length > 0) return { items, method: "ollama" };
  } catch {
    // Ollama not running
  }

  // Heuristic fallback
  process.stdout.write("  No LLM available, using heuristic extraction...\n");
  const items = extractHeuristic(text);
  return { items, method: "heuristic" };
}
