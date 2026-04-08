export interface Artifact {
  source: string;
  sourceName: string;
  type: ArtifactType;
  content: string;
  modified: string;
}

export type ArtifactType =
  | "claude_memory"
  | "claude_session"
  | "claude_plan"
  | "claude_skill"
  | "claude_project_doc"
  | "claude_todo"
  | "codex_memory"
  | "codex_rollout"
  | "cursor_rules"
  | "gemini_context"
  | "git_commits"
  | "modified_doc";

export interface Learning {
  learning: string;
  category: LearningCategory;
  tags: string[];
  edited?: boolean;
}

export type LearningCategory =
  | "technical"
  | "process"
  | "communication"
  | "tool"
  | "insight";

export interface Manifest {
  version: string;
  date: string;
  createdAt: string;
  extractionMethod: string;
  artifactsScanned: number;
  itemsCount: number;
  checksumAlgo: "sha256";
  files: Record<string, { sha256: string }>;
}

export interface RedactionPattern {
  pattern: string;
  replacement: string;
}

export interface HarvestOptions {
  auto: boolean;
  dryRun: boolean;
  output: string;
  model: string;
  hours: number;
}

export interface IngestOptions {
  days?: number;
  file?: string;
}
