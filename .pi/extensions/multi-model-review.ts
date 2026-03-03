/**
 * /parallel-review — Multi-model parallel code review
 *
 * Same evaluation/ranking system as original:
 *   - All agents review the full diff independently (no specialization)
 *   - Each agent outputs structured JSON with findings
 *   - Findings are consolidated by word-overlap similarity
 *   - Results ranked by consensus score (more agents = higher rank)
 *
 * Interactive repo/PR picker:
 *   /parallel-review                        → full picker
 *   /parallel-review my-repo                → skip to review-type picker
 *   /parallel-review 42 / #42 / PROJ-123    → ask repo first, then resolve
 *   /parallel-review https://github.com/…   → skip repo picker entirely
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@mariozechner/pi-ai";
import { type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";

// ─── Constants ────────────────────────────────────────────────────────────────

const SPAWN_STAGGER_MS = 300;    // fixed delay between spawns (not cumulative)
const AGENT_TIMEOUT_MS = 120_000; // 2-minute hard timeout per agent
const LOCK_RETRY_ATTEMPTS = 2;
const LOCK_RETRY_DELAY_MS = 3000;
const MAX_DIFF_CHARS = 40_000;   // truncate huge diffs to avoid context issues

const SEVERITY_WEIGHT: Record<string, number> = { critical: 3, warning: 2, suggestion: 1 };

// ─── Model preferences ────────────────────────────────────────────────────────

const CLAUDE_PREFERRED = [
  "claude-opus-4-6",
  "claude-sonnet-4-5-20250929",
  "claude-haiku-4-5-20251001",
];

const EXTRA_PROVIDER_PREFERRED = new Map<string, string>([
  ["openai", "gpt-5.1-codex"],
  ["openai-codex", "gpt-5.3-codex"],
  ["google", "gemini-2.5-pro"],
  ["google-gemini-cli", "gemini-2.5-pro"],
  ["google-antigravity", "gemini-3-pro-high"],
  ["google-vertex", "gemini-3-pro-preview"],
  ["azure-openai-responses", "gpt-5.2"],
  ["github-copilot", "gpt-4o"],
  ["openrouter", "openai/gpt-5.1-codex"],
  ["xai", "grok-4-fast-non-reasoning"],
  ["groq", "openai/gpt-oss-120b"],
  ["mistral", "devstral-medium-latest"],
  ["deepseek", "deepseek-chat"],
  ["cerebras", "zai-glm-4.6"],
  ["huggingface", "moonshotai/Kimi-K2.5"],
]);

// ─── Reviewer system prompt (generic for any stack) ───────────────────────────

const REVIEWER_SYSTEM_PROMPT = `You are a senior code reviewer.
You will receive a git diff in the user message. Analyze it and respond IMMEDIATELY with JSON — do NOT use any tools or read any files.

Focus areas:
- **Bugs**: Logic errors, nil/null safety, race conditions, edge cases, type safety
- **Security**: Injection vulnerabilities, XSS, CSRF, authentication/authorization, sensitive data exposure
- **Performance**: Database queries (N+1, missing indexes), expensive operations, memory leaks
- **Style**: Naming, readability, DRY/SOLID principles, code organization
- **Best practices**: Error handling, test coverage gaps, framework conventions, API design

You MUST output ONLY valid JSON with this exact schema (no markdown fences, no extra text):
{
  "findings": [
    {
      "file": "path/to/file",
      "line": 42,
      "severity": "critical" | "warning" | "suggestion",
      "category": "bug" | "security" | "performance" | "style" | "best-practice",
      "title": "Brief issue title",
      "description": "Detailed explanation",
      "suggestion": "Optional: suggested fix"
    }
  ],
  "summary": "2-3 sentence overall assessment",
  "score": 7
}

Rules:
- Analyze ONLY the diff provided. Do NOT call any tools. Do NOT read any files.
- Respond with raw JSON immediately after reading the diff.
- Be specific with file paths and line numbers from the diff.
- Score 1-10 (10 = perfect).
- Only report real issues, not minor nitpicks.`;

// ─── Types ────────────────────────────────────────────────────────────────────

interface ReviewFinding {
  file: string;
  line: number;
  severity: "critical" | "warning" | "suggestion";
  category: string;
  title: string;
  description: string;
  suggestion?: string;
}

interface ReviewAgentOutput {
  findings: ReviewFinding[];
  summary: string;
  score: number;
}

interface ReviewAgentResult {
  model: string;
  displayName: string;
  output: ReviewAgentOutput | null;
  error?: string;
  exitCode: number;
}

interface ConsolidatedFinding {
  file: string;
  line: number;
  severity: "critical" | "warning" | "suggestion";
  category: string;
  title: string;
  description: string;
  suggestion?: string;
  agents: string[];
  consensusScore: number;
}

interface ModelSelection {
  provider: string;
  modelId: string;
  displayName: string;
}

interface PrReference {
  owner: string;
  repo: string;
  number: number;
}

interface PrInfo {
  diff: string;
  changedFiles: string[];
  branch: string;
  baseBranch: string;
  commitCount: number;
  repoSlug: string;
}

interface ReviewTarget {
  diff: string;
  changedFiles: string[];
  branch: string;
  baseBranch: string;
  commitCount: number;
  repoCwd: string;
  label: string;
}

// ─── Repo discovery (generic) ─────────────────────────────────────────────────

function getReposPath(cwd: string): string {
  const configPath = path.join(cwd, ".pi", "local.json");
  if (fs.existsSync(configPath)) {
    try {
      const c = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      if (c.reposPath) return c.reposPath;
    } catch {}
  }
  return cwd;
}

function listAvailableRepos(cwd: string): string[] {
  const reposPath = getReposPath(cwd);
  
  // Try to read from project.yml first
  const projectYmlPath = path.join(cwd, "project.yml");
  if (fs.existsSync(projectYmlPath)) {
    try {
      const yaml = fs.readFileSync(projectYmlPath, "utf-8");
      const repoMatches = yaml.matchAll(/^\s*-\s*name:\s*(.+)$/gm);
      const reposFromYml = Array.from(repoMatches, m => m[1].trim()).filter(Boolean);
      if (reposFromYml.length > 0) {
        // Verify they exist
        const existing = reposFromYml.filter(name => 
          fs.existsSync(path.join(reposPath, name, ".git"))
        );
        if (existing.length > 0) return existing;
      }
    } catch {}
  }
  
  // Fallback: scan reposPath for directories with .git
  try {
    return fs.readdirSync(reposPath, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory() && fs.existsSync(path.join(reposPath, dirent.name, ".git")))
      .map(dirent => dirent.name)
      .sort();
  } catch {
    return [];
  }
}

// ─── PR resolution ────────────────────────────────────────────────────────────

function parsePrReference(input: string): PrReference | null {
  const urlMatch = input.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (urlMatch) return { owner: urlMatch[1], repo: urlMatch[2], number: parseInt(urlMatch[3], 10) };
  const shortMatch = input.match(/^([^/]+)\/([^#]+)#(\d+)$/);
  if (shortMatch) return { owner: shortMatch[1], repo: shortMatch[2], number: parseInt(shortMatch[3], 10) };
  return null;
}

function parseBareNumber(input: string): number | null {
  const match = input.trim().match(/^#?(\d+)$/);
  return match ? parseInt(match[1], 10) : null;
}

async function getRepoSlug(pi: ExtensionAPI, repoCwd: string): Promise<string | null> {
  const { stdout, code } = await pi.exec("git", ["-C", repoCwd, "remote", "get-url", "origin"]);
  if (code !== 0) return null;
  const match = stdout.trim().match(/github\.com[:/]([^/]+\/[^/.]+)/);
  return match ? match[1].replace(/\.git$/, "") : null;
}

async function fetchPrInfo(pi: ExtensionAPI, pr: PrReference): Promise<PrInfo | { error: string }> {
  const repoSlug = `${pr.owner}/${pr.repo}`;
  const { stdout: diff, code: diffCode, stderr: diffErr } = await pi.exec("gh", [
    "pr", "diff", String(pr.number), "--repo", repoSlug,
  ]);
  if (diffCode !== 0) return { error: `Failed to fetch PR diff: ${diffErr.trim() || `exit code ${diffCode}`}` };
  if (!diff.trim()) return { error: "PR has no changes (empty diff)." };

  const { stdout: prJson, code: prCode } = await pi.exec("gh", [
    "pr", "view", String(pr.number), "--repo", repoSlug,
    "--json", "headRefName,baseRefName,changedFiles,commits",
  ]);
  const filesFromDiff = () => [...new Set(Array.from(diff.matchAll(/^diff --git a\/(.+?) b\//gm), (m) => m[1]))];

  if (prCode !== 0) {
    return { diff, changedFiles: filesFromDiff(), branch: `PR #${pr.number}`, baseBranch: "unknown", commitCount: 0, repoSlug };
  }
  try {
    const meta = JSON.parse(prJson);
    return {
      diff,
      changedFiles: (meta.changedFiles || []).map((f: any) => f.path || f),
      branch: meta.headRefName || `PR #${pr.number}`,
      baseBranch: meta.baseRefName || "unknown",
      commitCount: (meta.commits || []).length,
      repoSlug,
    };
  } catch {
    return { diff, changedFiles: filesFromDiff(), branch: `PR #${pr.number}`, baseBranch: "unknown", commitCount: 0, repoSlug };
  }
}

async function fetchPrInfoFromRepo(pi: ExtensionAPI, repoCwd: string, prNumber: number): Promise<PrInfo | { error: string }> {
  const slug = await getRepoSlug(pi, repoCwd);
  if (!slug) return { error: "Could not determine GitHub repository from git remote." };
  const [owner, repo] = slug.split("/");
  return fetchPrInfo(pi, { owner, repo, number: prNumber });
}

async function searchPrsInRepo(
  pi: ExtensionAPI,
  repoCwd: string,
  query: string,
): Promise<Array<{ number: number; title: string; headRefName: string; state: string }>> {
  const slug = await getRepoSlug(pi, repoCwd);
  if (!slug) return [];
  const { stdout, code } = await pi.exec("gh", [
    "pr", "list", "--repo", slug, "--search", query, "--state", "all",
    "--json", "number,title,headRefName,state", "--limit", "10",
  ]);
  if (code !== 0) return [];
  try { return JSON.parse(stdout); } catch { return []; }
}

async function resolveFlexiblePrInput(
  pi: ExtensionAPI,
  ui: ExtensionContext["ui"],
  input: string,
  repoCwd: string,
): Promise<PrInfo | { error: string } | null> {
  const trimmed = input.trim();

  const prRef = parsePrReference(trimmed);
  if (prRef) {
    ui.notify(`Fetching PR #${prRef.number} from ${prRef.owner}/${prRef.repo}...`, "info");
    return fetchPrInfo(pi, prRef);
  }

  const bareNum = parseBareNumber(trimmed);
  if (bareNum !== null) {
    ui.notify(`Fetching PR #${bareNum}...`, "info");
    return fetchPrInfoFromRepo(pi, repoCwd, bareNum);
  }

  ui.notify(`Searching PRs matching "${trimmed}"...`, "info");
  const prs = await searchPrsInRepo(pi, repoCwd, trimmed);
  if (prs.length === 0) return { error: `No PRs found matching "${trimmed}".` };
  if (prs.length === 1) {
    ui.notify(`Found PR #${prs[0].number}: ${prs[0].title}`, "info");
    return fetchPrInfoFromRepo(pi, repoCwd, prs[0].number);
  }
  const choices = [...prs.map((p) => `#${p.number}: ${p.title} [${p.state}]`), "Cancel"];
  const choice = await ui.select(`Multiple PRs found for "${trimmed}":`, choices);
  if (!choice || choice === "Cancel") return null;
  const selectedNum = parseInt(choice.match(/#(\d+)/)?.[1] || "0", 10);
  if (!selectedNum) return { error: "Could not parse selection." };
  return fetchPrInfoFromRepo(pi, repoCwd, selectedNum);
}

async function detectBaseBranch(pi: ExtensionAPI, repoCwd: string): Promise<string> {
  const { code: mc } = await pi.exec("git", ["-C", repoCwd, "rev-parse", "--verify", "master"]);
  if (mc === 0) return "master";
  const { code: mainc } = await pi.exec("git", ["-C", repoCwd, "rev-parse", "--verify", "main"]);
  if (mainc === 0) return "main";
  return "master";
}

// ─── Interactive target resolution ───────────────────────────────────────────

async function resolveReviewTarget(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  args: string,
): Promise<ReviewTarget | null> {
  const trimmedArgs = args.trim();

  // Full URL or owner/repo#number → skip pickers
  const prFromArgs = trimmedArgs ? parsePrReference(trimmedArgs) : null;
  if (prFromArgs) {
    ctx.ui.notify(`Fetching PR #${prFromArgs.number} from ${prFromArgs.owner}/${prFromArgs.repo}...`, "info");
    const info = await fetchPrInfo(pi, prFromArgs);
    if ("error" in info) { ctx.ui.notify(info.error, "error"); return null; }
    const reposPath = getReposPath(ctx.cwd);
    const localDir = path.join(reposPath, prFromArgs.repo);
    const repoCwd = fs.existsSync(path.join(localDir, ".git")) ? localDir : ctx.cwd;
    return { ...info, repoCwd, label: `PR #${prFromArgs.number} (${prFromArgs.repo})` };
  }

  // Repo picker
  const availableRepos = listAvailableRepos(ctx.cwd);
  if (availableRepos.length === 0) {
    ctx.ui.notify("No repos found. Check your .pi/local.json reposPath or project.yml.", "error");
    return null;
  }

  let selectedRepo: string | null = null;
  if (trimmedArgs && availableRepos.includes(trimmedArgs)) {
    selectedRepo = trimmedArgs;
  } else {
    const choice = await ctx.ui.select("Which repo?", [...availableRepos, "Cancel"]);
    if (!choice || choice === "Cancel") { ctx.ui.notify("Cancelled.", "info"); return null; }
    selectedRepo = choice;
  }

  const reposPath = getReposPath(ctx.cwd);
  const repoCwd = path.join(reposPath, selectedRepo);

  // Args had a flexible value (not a repo name) → resolve it
  if (trimmedArgs && trimmedArgs !== selectedRepo) {
    const info = await resolveFlexiblePrInput(pi, ctx.ui, trimmedArgs, repoCwd);
    if (!info) { ctx.ui.notify("Cancelled.", "info"); return null; }
    if ("error" in info) { ctx.ui.notify(info.error, "error"); return null; }
    return { ...info, repoCwd, label: `${info.branch} → ${info.baseBranch} (${selectedRepo})` };
  }

  // Review type picker
  const { stdout: branchRaw, code: branchCode } = await pi.exec("git", ["-C", repoCwd, "rev-parse", "--abbrev-ref", "HEAD"]);
  const currentBranch = branchCode === 0 ? branchRaw.trim() : null;

  const options: string[] = [];
  if (currentBranch && !["master", "main", "HEAD"].includes(currentBranch)) {
    options.push(`Review current branch (${currentBranch})`);
  }
  options.push("Review a PR (number, URL, Jira ticket, or branch name)");
  options.push("Cancel");

  const reviewChoice = await ctx.ui.select(`What to review in ${selectedRepo}?`, options);
  if (!reviewChoice || reviewChoice === "Cancel") { ctx.ui.notify("Cancelled.", "info"); return null; }

  if (reviewChoice.startsWith("Review a PR")) {
    const userInput = await ctx.ui.input(
      "PR number, URL, Jira ticket, or branch name:",
      "e.g. 42, #42, PROJ-123, https://github.com/owner/repo/pull/123",
    );
    if (!userInput) { ctx.ui.notify("Cancelled.", "info"); return null; }
    const info = await resolveFlexiblePrInput(pi, ctx.ui, userInput, repoCwd);
    if (!info) { ctx.ui.notify("Cancelled.", "info"); return null; }
    if ("error" in info) { ctx.ui.notify(info.error, "error"); return null; }
    return { ...info, repoCwd, label: `${info.branch} → ${info.baseBranch} (${selectedRepo})` };
  }

  // Current branch vs base
  const baseBranch = await detectBaseBranch(pi, repoCwd);
  const { code: baseCheck } = await pi.exec("git", ["-C", repoCwd, "rev-parse", "--verify", baseBranch]);
  if (baseCheck !== 0) { ctx.ui.notify(`Base branch '${baseBranch}' not found.`, "error"); return null; }

  const [filesResult, diffResult, logResult] = await Promise.all([
    pi.exec("git", ["-C", repoCwd, "diff", "--name-only", `${baseBranch}...HEAD`]),
    pi.exec("git", ["-C", repoCwd, "diff", `${baseBranch}...HEAD`]),
    pi.exec("git", ["-C", repoCwd, "log", "--oneline", `${baseBranch}...HEAD`]),
  ]);

  const changedFiles = filesResult.stdout.trim().split("\n").filter(Boolean);
  if (changedFiles.length === 0) {
    ctx.ui.notify(`No changes between '${currentBranch}' and '${baseBranch}'.`, "warning");
    return null;
  }

  return {
    diff: diffResult.stdout,
    changedFiles,
    branch: currentBranch!,
    baseBranch,
    commitCount: logResult.stdout.trim().split("\n").filter(Boolean).length,
    repoSlug: "",
    repoCwd,
    label: `${currentBranch} → ${baseBranch} (${selectedRepo})`,
  };
}

// ─── Model selection ──────────────────────────────────────────────────────────

function getReviewModels(ctx: ExtensionContext, maxModels?: number): ModelSelection[] {
  const available = ctx.modelRegistry.getAvailable();
  const models: ModelSelection[] = [];

  // Up to 3 Claude models for variety of perspectives
  const claudeModels = available.filter((m) => m.provider === "anthropic");
  for (const preferredId of CLAUDE_PREFERRED) {
    const found = claudeModels.find((m) => m.id === preferredId);
    if (found) {
      models.push({ provider: found.provider, modelId: found.id, displayName: found.name || found.id });
    }
    if (models.length >= 3) break;
  }
  if (models.length === 0) {
    for (const m of claudeModels.slice(0, 2)) {
      models.push({ provider: m.provider, modelId: m.id, displayName: m.name || m.id });
    }
  }

  // 1 agent per extra configured provider
  for (const [provider, defaultModelId] of EXTRA_PROVIDER_PREFERRED) {
    if (maxModels && models.length >= maxModels) break;
    const providerModels = available.filter((m) => m.provider === provider);
    if (providerModels.length > 0) {
      const best = providerModels.find((m) => m.id === defaultModelId) ?? providerModels[0];
      models.push({ provider: best.provider, modelId: best.id, displayName: best.name || best.id });
    }
  }

  return maxModels ? models.slice(0, maxModels) : models;
}

// ─── AbortSignal helpers ──────────────────────────────────────────────────────

/** Combines multiple AbortSignals — aborts when ANY of them aborts. */
function anySignal(signals: AbortSignal[]): AbortSignal {
  // Use native AbortSignal.any if available (Node 20+)
  if (typeof (AbortSignal as any).any === "function") {
    return (AbortSignal as any).any(signals);
  }
  const controller = new AbortController();
  for (const sig of signals) {
    if (sig.aborted) { controller.abort(sig.reason); return controller.signal; }
    sig.addEventListener("abort", () => controller.abort(sig.reason), { once: true });
  }
  return controller.signal;
}

// ─── Temp file helpers ────────────────────────────────────────────────────────

function writeTempFile(prefix: string, name: string, content: string): { dir: string; filePath: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const filePath = path.join(tmpDir, name.replace(/[^\w.-]+/g, "_"));
  fs.writeFileSync(filePath, content, { encoding: "utf-8", mode: 0o600 });
  return { dir: tmpDir, filePath };
}

function cleanupTempFile(dir: string, filePath: string): void {
  try { fs.unlinkSync(filePath); } catch {}
  try { fs.rmdirSync(dir); } catch {}
}

// ─── Agent execution (subprocess, same as review-me) ─────────────────────────

function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") return part.text;
      }
    }
  }
  return "";
}

async function runReviewAgent(
  cwd: string,
  provider: string,
  modelId: string,
  diff: string,
  changedFiles: string[],
  systemPromptPath: string,
  signal?: AbortSignal,
): Promise<{ messages: Message[]; exitCode: number; stderr: string }> {
  const truncated = diff.length > MAX_DIFF_CHARS
    ? diff.slice(0, MAX_DIFF_CHARS) + `\n\n[... diff truncated at ${MAX_DIFF_CHARS} chars — ${diff.length - MAX_DIFF_CHARS} chars omitted ...]`
    : diff;

  const userPrompt = `Review this code diff (${changedFiles.length} files changed: ${changedFiles.join(", ")}).\n\nOutput your findings as JSON only — no explanation, no markdown fences.\n\n\`\`\`diff\n${truncated}\n\`\`\``;

  const args = [
    "--mode", "json",
    "-p", "--no-session",
    "--provider", provider,
    "--model", modelId,
    "--append-system-prompt", systemPromptPath,
    userPrompt,
  ];

  return new Promise((resolve) => {
    const proc = spawn("pi", args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let buffer = "";
    const messages: Message[] = [];
    let stderr = "";

    const processLine = (line: string) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line);
        if (event.type === "message_end" && event.message) messages.push(event.message as Message);
        if (event.type === "tool_result_end" && event.message) messages.push(event.message as Message);
      } catch {}
    };

    proc.stdout.on("data", (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) processLine(line);
    });

    proc.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });

    proc.on("close", (code: number | null) => {
      if (buffer.trim()) processLine(buffer);
      resolve({ messages, exitCode: code ?? 1, stderr });
    });

    proc.on("error", () => resolve({ messages, exitCode: 1, stderr: stderr || "Failed to spawn pi process" }));

    if (signal) {
      const kill = () => {
        proc.kill("SIGTERM");
        setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, 5000);
      };
      if (signal.aborted) kill();
      else signal.addEventListener("abort", kill, { once: true });
    }
  });
}

// ─── JSON parsing ─────────────────────────────────────────────────────────────

function parseReviewOutput(text: string): ReviewAgentOutput | null {
  const trimmed = text.trim();
  const candidates: string[] = [];

  // Strategy 1: markdown code fences
  const fenceRegex = /```(?:json)?\s*([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fenceRegex.exec(trimmed)) !== null) candidates.push(m[1].trim());

  // Strategy 2: outermost { } containing "findings"
  const idx = trimmed.indexOf('"findings"');
  if (idx >= 0) {
    const start = trimmed.lastIndexOf("{", idx);
    if (start >= 0) {
      let depth = 0;
      for (let i = start; i < trimmed.length; i++) {
        if (trimmed[i] === "{") depth++;
        else if (trimmed[i] === "}") depth--;
        if (depth === 0) { candidates.push(trimmed.slice(start, i + 1)); break; }
      }
    }
  }

  // Strategy 3: first { to last }
  const jsonStart = trimmed.indexOf("{");
  const jsonEnd = trimmed.lastIndexOf("}");
  if (jsonStart >= 0 && jsonEnd > jsonStart) candidates.push(trimmed.slice(jsonStart, jsonEnd + 1));

  candidates.push(trimmed);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (!parsed.findings || !Array.isArray(parsed.findings)) continue;
      const findings: ReviewFinding[] = parsed.findings
        .filter((f: any) => f.file && f.title)
        .map((f: any) => ({
          file: String(f.file),
          line: Number(f.line) || 0,
          severity: (["critical", "warning", "suggestion"].includes(f.severity) ? f.severity : "suggestion") as ReviewFinding["severity"],
          category: String(f.category || "other"),
          title: String(f.title),
          description: String(f.description || ""),
          suggestion: f.suggestion ? String(f.suggestion) : undefined,
        }));
      return {
        findings,
        summary: String(parsed.summary || ""),
        score: Math.min(10, Math.max(1, Number(parsed.score) || 5)),
      };
    } catch { continue; }
  }
  return null;
}

// ─── Consolidation ────────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "can", "shall", "to", "of", "in", "for",
  "on", "with", "at", "by", "from", "as", "into", "through", "during",
  "before", "after", "above", "below", "between", "under", "again",
  "further", "then", "once", "here", "there", "when", "where", "why",
  "how", "all", "each", "every", "both", "few", "more", "most",
  "other", "some", "such", "no", "nor", "not", "only", "own", "same",
  "so", "than", "too", "very", "just", "because", "but", "and", "or",
  "if", "while", "that", "this", "these", "those", "it", "its",
  "also", "which", "about", "using", "used", "use", "like",
]);

function extractSignificantWords(text: string): Set<string> {
  return new Set(
    text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w)),
  );
}

function findingSimilarity(a: ReviewFinding, b: ReviewFinding): number {
  if (a.file !== b.file) return 0;
  if (Math.abs(a.line - b.line) > 15) return 0;
  const aWords = extractSignificantWords(`${a.title} ${a.description}`);
  const bWords = extractSignificantWords(`${b.title} ${b.description}`);
  if (aWords.size === 0 || bWords.size === 0) return 0;
  let overlap = 0;
  for (const w of aWords) { if (bWords.has(w)) overlap++; }
  return overlap / Math.min(aWords.size, bWords.size);
}

const SIMILARITY_THRESHOLD = 0.3;

function consolidateFindings(results: ReviewAgentResult[]): ConsolidatedFinding[] {
  const all: Array<{ finding: ReviewFinding; agent: string }> = [];
  for (const r of results) {
    if (!r.output) continue;
    for (const f of r.output.findings) all.push({ finding: f, agent: r.displayName });
  }

  const groups: ConsolidatedFinding[] = [];
  for (const { finding, agent } of all) {
    let bestGroup: ConsolidatedFinding | null = null;
    let bestScore = 0;
    for (const g of groups) {
      const sim = findingSimilarity(finding, g as ReviewFinding);
      if (sim > bestScore) { bestScore = sim; bestGroup = g; }
    }
    if (bestGroup && bestScore >= SIMILARITY_THRESHOLD) {
      if (!bestGroup.agents.includes(agent)) bestGroup.agents.push(agent);
      if (SEVERITY_WEIGHT[finding.severity] > SEVERITY_WEIGHT[bestGroup.severity]) bestGroup.severity = finding.severity;
      if (finding.description.length > bestGroup.description.length) {
        bestGroup.description = finding.description;
        bestGroup.title = finding.title;
      }
      if (finding.suggestion && (!bestGroup.suggestion || finding.suggestion.length > bestGroup.suggestion.length)) {
        bestGroup.suggestion = finding.suggestion;
      }
      bestGroup.consensusScore = bestGroup.agents.length * SEVERITY_WEIGHT[bestGroup.severity];
    } else {
      groups.push({
        ...finding,
        agents: [agent],
        consensusScore: SEVERITY_WEIGHT[finding.severity],
      });
    }
  }

  return groups.sort((a, b) =>
    b.consensusScore !== a.consensusScore
      ? b.consensusScore - a.consensusScore
      : SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity],
  );
}

// ─── Report formatting ────────────────────────────────────────────────────────

function formatFinding(f: ConsolidatedFinding, totalAgents: number): string {
  let text = `**[${f.agents.length}/${totalAgents} agents]** \`${f.file}:${f.line}\` — **${f.title}**\n`;
  text += `  ${f.description}\n`;
  if (f.suggestion) text += `  > 💡 ${f.suggestion}\n`;
  return text + "\n";
}

function formatReport(
  results: ReviewAgentResult[],
  findings: ConsolidatedFinding[],
  label: string,
  filesChanged: number,
  commitCount: number,
): string {
  const successful = results.filter((r) => r.output);
  const failed = results.filter((r) => !r.output);
  const modelCount = new Set(successful.map((r) => r.model)).size;
  const totalAgents = results.length;

  const critical = findings.filter((f) => f.severity === "critical");
  const warnings = findings.filter((f) => f.severity === "warning");
  const suggestions = findings.filter((f) => f.severity === "suggestion");

  let report = `## Parallel Review — ${label}\n\n`;
  report += `**Agents:** ${successful.map((r) => r.displayName).join(", ")}\n`;
  report += `**Models:** ${modelCount} | **Files changed:** ${filesChanged} | **Commits:** ${commitCount}\n\n`;

  if (failed.length > 0) {
    report += `> ⚠️ ${failed.length} agent(s) failed: ${failed.map((r) => `${r.displayName} (${r.error || "unknown"})`).join(", ")}\n\n`;
  }

  if (findings.length === 0) {
    report += "✅ **No issues found.** All agents report clean code.\n\n";
  }

  if (critical.length > 0) {
    report += `### 🔴 Critical Issues — ${critical.length} found\n\n`;
    for (const f of critical) report += formatFinding(f, totalAgents);
  }
  if (warnings.length > 0) {
    report += `### 🟡 Warnings — ${warnings.length} found\n\n`;
    for (const f of warnings) report += formatFinding(f, totalAgents);
  }
  if (suggestions.length > 0) {
    report += `### 🟢 Suggestions — ${suggestions.length} found\n\n`;
    for (const f of suggestions) report += formatFinding(f, totalAgents);
  }

  if (successful.length > 0) {
    report += `### Per-Agent Scores\n\n`;
    report += `| Agent | Score | Findings |\n|-------|-------|----------|\n`;
    for (const r of successful) {
      report += `| ${r.displayName} | ${r.output?.score ?? "-"}/10 | ${r.output?.findings.length ?? 0} |\n`;
    }
    report += "\n";

    const summaries = successful.filter((r) => r.output?.summary).map((r) => r.output!.summary);
    if (summaries.length > 0) {
      report += `### Summary\n\n${summaries.join(" ")}\n`;
    }
  }

  return report;
}

// ─── Extension entry point ────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let activeAbortController: AbortController | null = null;

  pi.registerCommand("parallel-review", {
    description: "Multi-model parallel code review with consensus ranking",
    getArgumentCompletions: (prefix: string) => {
      const repos = listAvailableRepos(pi.getCwd());
      return repos.filter((r) => r.startsWith(prefix)).map((v) => ({ value: v, label: v }));
    },
    handler: async (args, ctx) => {
      if (activeAbortController) {
        ctx.ui.notify("A review is already running. Use /parallel-review-stop to cancel.", "warning");
        return;
      }

      const target = await resolveReviewTarget(pi, ctx, args);
      if (!target) return;

      const reviewModels = getReviewModels(ctx);
      if (reviewModels.length === 0) {
        ctx.ui.notify("No AI models available. Check your API key configuration.", "error");
        return;
      }

      ctx.ui.notify(
        `🚀 Starting parallel review: ${target.label} — ${reviewModels.length} agents in parallel`,
        "info",
      );
      ctx.ui.setStatus("parallel-review", `Parallel review: 0/${reviewModels.length} done`);

      // Write system prompt to temp file (diff is passed inline, no diff temp file needed)
      const promptTemp = writeTempFile("pi-parallel-review-", "reviewer-prompt.md", REVIEWER_SYSTEM_PROMPT);

      activeAbortController = new AbortController();
      const signal = activeAbortController.signal;

      try {
        let completedCount = 0;
        const total = reviewModels.length;

        // Launch all agents in parallel with a small fixed stagger between spawns.
        // Diff is embedded inline — no tools needed, no file reading, fast single-shot response.
        const results = await Promise.all(
          reviewModels.map(async (model, i): Promise<ReviewAgentResult> => {
            // Fixed stagger: each agent waits i*300ms before spawning (not cumulative)
            if (i > 0) await new Promise((r) => setTimeout(r, i * SPAWN_STAGGER_MS));

            if (signal.aborted) {
              return { model: model.modelId, displayName: model.displayName, output: null, error: "Cancelled", exitCode: 1 };
            }

            const startedAt = Date.now();
            ctx.ui.notify(`🔍 ${model.displayName} — reviewing...`, "info");

            // Per-agent timeout combined with the global cancellation signal
            const timeoutController = new AbortController();
            const timeoutId = setTimeout(() => timeoutController.abort(), AGENT_TIMEOUT_MS);
            const agentSignal = anySignal([signal, timeoutController.signal]);

            try {
              let messages: Message[] = [];
              let exitCode = 1;
              let stderr = "";
              let attempt = 0;

              while (attempt <= LOCK_RETRY_ATTEMPTS) {
                const result = await runReviewAgent(
                  target.repoCwd, model.provider, model.modelId,
                  target.diff, target.changedFiles, promptTemp.filePath, agentSignal,
                );
                messages = result.messages;
                exitCode = result.exitCode;
                stderr = result.stderr;

                if (exitCode !== 0 && stderr.includes("Lock file is already being held") && attempt < LOCK_RETRY_ATTEMPTS) {
                  attempt++;
                  await new Promise((r) => setTimeout(r, LOCK_RETRY_DELAY_MS * attempt));
                  continue;
                }
                break;
              }

              const durationSec = ((Date.now() - startedAt) / 1000).toFixed(0);
              completedCount++;
              ctx.ui.setStatus("parallel-review", `Parallel review: ${completedCount}/${total} done`);

              if (timeoutController.signal.aborted) {
                ctx.ui.notify(`⏱ ${model.displayName} — timed out after ${durationSec}s`, "warning");
                return { model: model.modelId, displayName: model.displayName, output: null, error: `Timed out after ${durationSec}s`, exitCode: 1 };
              }

              if (exitCode !== 0) {
                ctx.ui.notify(`❌ ${model.displayName} — failed (${durationSec}s)`, "warning");
                return { model: model.modelId, displayName: model.displayName, output: null, error: stderr.slice(0, 200) || `Exit ${exitCode}`, exitCode };
              }

              const parsed = parseReviewOutput(getFinalOutput(messages));
              const score = parsed?.score ?? "?";
              const count = parsed?.findings.length ?? 0;
              ctx.ui.notify(
                parsed
                  ? `✅ ${model.displayName} — ${durationSec}s · score ${score}/10 · ${count} issue(s)`
                  : `⚠️ ${model.displayName} — ${durationSec}s · could not parse output`,
                "info",
              );
              return { model: model.modelId, displayName: model.displayName, output: parsed, error: parsed ? undefined : "Failed to parse JSON", exitCode };
            } catch (err: any) {
              const durationSec = ((Date.now() - startedAt) / 1000).toFixed(0);
              completedCount++;
              ctx.ui.setStatus("parallel-review", `Parallel review: ${completedCount}/${total} done`);
              ctx.ui.notify(`❌ ${model.displayName} — failed after ${durationSec}s: ${err?.message || "unknown"}`, "warning");
              return { model: model.modelId, displayName: model.displayName, output: null, error: err?.message || "Unknown error", exitCode: 1 };
            } finally {
              clearTimeout(timeoutId);
            }
          }),
        );

        if (signal.aborted) {
          ctx.ui.notify("Review cancelled.", "warning");
          ctx.ui.setStatus("parallel-review", undefined);
          return;
        }

        const consolidated = consolidateFindings(results);
        const report = formatReport(results, consolidated, target.label, target.changedFiles.length, target.commitCount);

        ctx.ui.setStatus("parallel-review", undefined);
        ctx.ui.notify(`✅ Review complete! ${consolidated.length} findings consolidated from ${results.length} agents.`, "info");

        pi.sendMessage({
          customType: "parallel-review-report",
          content: report,
          display: true,
          details: { label: target.label, agents: results.length, findings: consolidated.length },
        });
      } finally {
        activeAbortController = null;
        cleanupTempFile(promptTemp.dir, promptTemp.filePath);
      }
    },
  });

  pi.registerCommand("parallel-review-stop", {
    description: "Cancel a running /parallel-review",
    handler: async (_args, ctx) => {
      if (!activeAbortController) {
        ctx.ui.notify("No review in progress.", "info");
        return;
      }
      activeAbortController.abort();
      activeAbortController = null;
      ctx.ui.setStatus("parallel-review", undefined);
      ctx.ui.notify("Review cancelled.", "warning");
    },
  });
}
