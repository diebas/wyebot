/**
 * /parallel-review-lite — Same as /parallel-review but capped at 3 models.
 * Faster and cheaper for quick checks. Same consensus ranking system.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@mariozechner/pi-ai";
import { type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";

const SPAWN_STAGGER_MS = 300;
const AGENT_TIMEOUT_MS = 180_000; // 3-minute hard timeout per agent
const LOCK_RETRY_ATTEMPTS = 2;
const LOCK_RETRY_DELAY_MS = 3000;
const LITE_MAX_MODELS = 3;
const MAX_DIFF_CHARS = 40_000;

const SEVERITY_WEIGHT: Record<string, number> = { critical: 3, warning: 2, suggestion: 1 };

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
  file: string; line: number;
  severity: "critical" | "warning" | "suggestion";
  category: string; title: string; description: string; suggestion?: string;
}
interface ReviewAgentOutput { findings: ReviewFinding[]; summary: string; score: number; }
interface ReviewAgentResult {
  model: string; displayName: string;
  output: ReviewAgentOutput | null; error?: string; exitCode: number;
}
interface ConsolidatedFinding extends ReviewFinding { agents: string[]; consensusScore: number; }
interface ModelSelection { provider: string; modelId: string; displayName: string; }
interface PrReference { owner: string; repo: string; number: number; }
interface PrInfo {
  diff: string; changedFiles: string[]; branch: string;
  baseBranch: string; commitCount: number; repoSlug: string;
}
interface ReviewTarget {
  diff: string; changedFiles: string[]; branch: string;
  baseBranch: string; commitCount: number; repoCwd: string; label: string;
}

// ─── Helpers (same as multi-model-review.ts) ─────────────────────────────────

function getReposPath(cwd: string): string {
  const p = path.join(cwd, ".pi", "local.json");
  if (fs.existsSync(p)) { try { const c = JSON.parse(fs.readFileSync(p, "utf-8")); if (c.reposPath) return c.reposPath; } catch {} }
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

function parsePrReference(input: string): PrReference | null {
  const u = input.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (u) return { owner: u[1], repo: u[2], number: parseInt(u[3], 10) };
  const s = input.match(/^([^/]+)\/([^#]+)#(\d+)$/);
  if (s) return { owner: s[1], repo: s[2], number: parseInt(s[3], 10) };
  return null;
}
function parseBareNumber(input: string): number | null {
  const m = input.trim().match(/^#?(\d+)$/); return m ? parseInt(m[1], 10) : null;
}
async function getRepoSlug(pi: ExtensionAPI, repoCwd: string): Promise<string | null> {
  const { stdout, code } = await pi.exec("git", ["-C", repoCwd, "remote", "get-url", "origin"]);
  if (code !== 0) return null;
  const m = stdout.trim().match(/github\.com[:/]([^/]+\/[^/.]+)/);
  return m ? m[1].replace(/\.git$/, "") : null;
}
async function fetchPrInfo(pi: ExtensionAPI, pr: PrReference): Promise<PrInfo | { error: string }> {
  const repoSlug = `${pr.owner}/${pr.repo}`;
  const { stdout: diff, code: dc, stderr: de } = await pi.exec("gh", ["pr", "diff", String(pr.number), "--repo", repoSlug]);
  if (dc !== 0) return { error: `Failed to fetch PR diff: ${de.trim() || `exit code ${dc}`}` };
  if (!diff.trim()) return { error: "PR has no changes." };
  const { stdout: prJson, code: pc } = await pi.exec("gh", ["pr", "view", String(pr.number), "--repo", repoSlug, "--json", "headRefName,baseRefName,changedFiles,commits"]);
  const fd = () => [...new Set(Array.from(diff.matchAll(/^diff --git a\/(.+?) b\//gm), (m) => m[1]))];
  if (pc !== 0) return { diff, changedFiles: fd(), branch: `PR #${pr.number}`, baseBranch: "unknown", commitCount: 0, repoSlug };
  try {
    const meta = JSON.parse(prJson);
    return { diff, changedFiles: (meta.changedFiles || []).map((f: any) => f.path || f), branch: meta.headRefName || `PR #${pr.number}`, baseBranch: meta.baseRefName || "unknown", commitCount: (meta.commits || []).length, repoSlug };
  } catch { return { diff, changedFiles: fd(), branch: `PR #${pr.number}`, baseBranch: "unknown", commitCount: 0, repoSlug }; }
}
async function fetchPrInfoFromRepo(pi: ExtensionAPI, repoCwd: string, n: number): Promise<PrInfo | { error: string }> {
  const slug = await getRepoSlug(pi, repoCwd);
  if (!slug) return { error: "Could not determine GitHub repo from git remote." };
  const [owner, repo] = slug.split("/"); return fetchPrInfo(pi, { owner, repo, number: n });
}
async function searchPrsInRepo(pi: ExtensionAPI, repoCwd: string, query: string): Promise<Array<{ number: number; title: string; headRefName: string; state: string }>> {
  const slug = await getRepoSlug(pi, repoCwd); if (!slug) return [];
  const { stdout, code } = await pi.exec("gh", ["pr", "list", "--repo", slug, "--search", query, "--state", "all", "--json", "number,title,headRefName,state", "--limit", "10"]);
  if (code !== 0) return []; try { return JSON.parse(stdout); } catch { return []; }
}
async function resolveFlexiblePrInput(pi: ExtensionAPI, ui: ExtensionContext["ui"], input: string, repoCwd: string): Promise<PrInfo | { error: string } | null> {
  const t = input.trim();
  const prRef = parsePrReference(t); if (prRef) { ui.notify(`Fetching PR #${prRef.number}...`, "info"); return fetchPrInfo(pi, prRef); }
  const n = parseBareNumber(t); if (n !== null) { ui.notify(`Fetching PR #${n}...`, "info"); return fetchPrInfoFromRepo(pi, repoCwd, n); }
  ui.notify(`Searching PRs matching "${t}"...`, "info");
  const prs = await searchPrsInRepo(pi, repoCwd, t);
  if (prs.length === 0) return { error: `No PRs found matching "${t}".` };
  if (prs.length === 1) { ui.notify(`Found PR #${prs[0].number}: ${prs[0].title}`, "info"); return fetchPrInfoFromRepo(pi, repoCwd, prs[0].number); }
  const choices = [...prs.map((p) => `#${p.number}: ${p.title} [${p.state}]`), "Cancel"];
  const choice = await ui.select(`Multiple PRs found for "${t}":`, choices);
  if (!choice || choice === "Cancel") return null;
  const sn = parseInt(choice.match(/#(\d+)/)?.[1] || "0", 10); if (!sn) return { error: "Could not parse selection." };
  return fetchPrInfoFromRepo(pi, repoCwd, sn);
}
async function detectBaseBranch(pi: ExtensionAPI, repoCwd: string): Promise<string> {
  const { code: mc } = await pi.exec("git", ["-C", repoCwd, "rev-parse", "--verify", "master"]); if (mc === 0) return "master";
  const { code: mainc } = await pi.exec("git", ["-C", repoCwd, "rev-parse", "--verify", "main"]); if (mainc === 0) return "main"; return "master";
}

async function resolveReviewTarget(pi: ExtensionAPI, ctx: ExtensionContext, args: string): Promise<ReviewTarget | null> {
  const t = args.trim();
  const prFromArgs = t ? parsePrReference(t) : null;
  if (prFromArgs) {
    ctx.ui.notify(`Fetching PR #${prFromArgs.number}...`, "info");
    const info = await fetchPrInfo(pi, prFromArgs); if ("error" in info) { ctx.ui.notify(info.error, "error"); return null; }
    const rp = getReposPath(ctx.cwd); const ld = path.join(rp, prFromArgs.repo);
    return { ...info, repoCwd: fs.existsSync(path.join(ld, ".git")) ? ld : ctx.cwd, label: `PR #${prFromArgs.number} (${prFromArgs.repo})` };
  }
  const repos = listAvailableRepos(ctx.cwd);
  if (repos.length === 0) { ctx.ui.notify("No repos found.", "error"); return null; }
  let repo: string | null = null;
  if (t && repos.includes(t)) { repo = t; } else {
    const c = await ctx.ui.select("Which repo?", [...repos, "Cancel"]); if (!c || c === "Cancel") { ctx.ui.notify("Cancelled.", "info"); return null; } repo = c;
  }
  const rp = getReposPath(ctx.cwd); const repoCwd = path.join(rp, repo);
  if (t && t !== repo) {
    const info = await resolveFlexiblePrInput(pi, ctx.ui, t, repoCwd);
    if (!info) { ctx.ui.notify("Cancelled.", "info"); return null; }
    if ("error" in info) { ctx.ui.notify(info.error, "error"); return null; }
    return { ...info, repoCwd, label: `${info.branch} → ${info.baseBranch} (${repo})` };
  }
  const { stdout: branchRaw, code: bc } = await pi.exec("git", ["-C", repoCwd, "rev-parse", "--abbrev-ref", "HEAD"]);
  const branch = bc === 0 ? branchRaw.trim() : null;
  const options: string[] = [];
  if (branch && !["master", "main", "HEAD"].includes(branch)) options.push(`Review current branch (${branch})`);
  options.push("Review a PR (number, URL, Jira ticket, or branch name)", "Cancel");
  const rc = await ctx.ui.select(`What to review in ${repo}?`, options);
  if (!rc || rc === "Cancel") { ctx.ui.notify("Cancelled.", "info"); return null; }
  if (rc.startsWith("Review a PR")) {
    const ui2 = await ctx.ui.input("PR number, URL, Jira ticket, or branch name:", "e.g. 42, PROJ-123");
    if (!ui2) { ctx.ui.notify("Cancelled.", "info"); return null; }
    const info = await resolveFlexiblePrInput(pi, ctx.ui, ui2, repoCwd);
    if (!info) { ctx.ui.notify("Cancelled.", "info"); return null; }
    if ("error" in info) { ctx.ui.notify(info.error, "error"); return null; }
    return { ...info, repoCwd, label: `${info.branch} → ${info.baseBranch} (${repo})` };
  }
  const base = await detectBaseBranch(pi, repoCwd);
  const { code: bk } = await pi.exec("git", ["-C", repoCwd, "rev-parse", "--verify", base]);
  if (bk !== 0) { ctx.ui.notify(`Base branch '${base}' not found.`, "error"); return null; }
  const [fr, dr, lr] = await Promise.all([
    pi.exec("git", ["-C", repoCwd, "diff", "--name-only", `${base}...HEAD`]),
    pi.exec("git", ["-C", repoCwd, "diff", `${base}...HEAD`]),
    pi.exec("git", ["-C", repoCwd, "log", "--oneline", `${base}...HEAD`]),
  ]);
  const changedFiles = fr.stdout.trim().split("\n").filter(Boolean);
  if (changedFiles.length === 0) { ctx.ui.notify(`No changes between '${branch}' and '${base}'.`, "warning"); return null; }
  return { diff: dr.stdout, changedFiles, branch: branch!, baseBranch: base, commitCount: lr.stdout.trim().split("\n").filter(Boolean).length, repoSlug: "", repoCwd, label: `${branch} → ${base} (${repo})` };
}

function getReviewModels(ctx: ExtensionContext, max: number): ModelSelection[] {
  const available = ctx.modelRegistry.getAvailable(); const models: ModelSelection[] = [];
  const claude = available.filter((m) => m.provider === "anthropic");
  for (const id of CLAUDE_PREFERRED) { const f = claude.find((m) => m.id === id); if (f) models.push({ provider: f.provider, modelId: f.id, displayName: f.name || f.id }); if (models.length >= Math.min(2, max)) break; }
  if (models.length === 0) { for (const m of claude.slice(0, 1)) models.push({ provider: m.provider, modelId: m.id, displayName: m.name || m.id }); }
  for (const [provider, defaultId] of EXTRA_PROVIDER_PREFERRED) {
    if (models.length >= max) break;
    const pm = available.filter((m) => m.provider === provider);
    if (pm.length > 0) { const best = pm.find((m) => m.id === defaultId) ?? pm[0]; models.push({ provider: best.provider, modelId: best.id, displayName: best.name || best.id }); }
  }
  return models.slice(0, max);
}

function writeTempFile(prefix: string, name: string, content: string): { dir: string; filePath: string } {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const fp = path.join(d, name.replace(/[^\w.-]+/g, "_"));
  fs.writeFileSync(fp, content, { encoding: "utf-8", mode: 0o600 }); return { dir: d, filePath: fp };
}
function cleanupTempFile(dir: string, filePath: string): void {
  try { fs.unlinkSync(filePath); } catch {} try { fs.rmdirSync(dir); } catch {}
}

function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) { const msg = messages[i]; if (msg.role === "assistant") { for (const p of msg.content) { if (p.type === "text") return p.text; } } } return "";
}

function anySignal(signals: AbortSignal[]): AbortSignal {
  if (typeof (AbortSignal as any).any === "function") return (AbortSignal as any).any(signals);
  const c = new AbortController();
  for (const s of signals) { if (s.aborted) { c.abort(s.reason); return c.signal; } s.addEventListener("abort", () => c.abort(s.reason), { once: true }); }
  return c.signal;
}

async function runReviewAgent(cwd: string, provider: string, modelId: string, diff: string, changedFiles: string[], promptPath: string, signal?: AbortSignal): Promise<{ messages: Message[]; exitCode: number; stderr: string }> {
  const truncated = diff.length > MAX_DIFF_CHARS ? diff.slice(0, MAX_DIFF_CHARS) + `\n\n[... truncated ...]` : diff;
  const userPrompt = `Review this code diff (${changedFiles.length} files: ${changedFiles.join(", ")}).\n\nOutput JSON only.\n\n\`\`\`diff\n${truncated}\n\`\`\``;
  const args = ["--mode", "json", "-p", "--no-session", "--provider", provider, "--model", modelId, "--append-system-prompt", promptPath, userPrompt];
  return new Promise((resolve) => {
    const proc = spawn("pi", args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let buffer = ""; const messages: Message[] = []; let stderr = "";
    const pl = (line: string) => { if (!line.trim()) return; try { const e = JSON.parse(line); if (e.type === "message_end" && e.message) messages.push(e.message); if (e.type === "tool_result_end" && e.message) messages.push(e.message); } catch {} };
    proc.stdout.on("data", (d: Buffer) => { buffer += d.toString(); const lines = buffer.split("\n"); buffer = lines.pop() || ""; for (const l of lines) pl(l); });
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.on("close", (code) => { if (buffer.trim()) pl(buffer); resolve({ messages, exitCode: code ?? 1, stderr }); });
    proc.on("error", () => resolve({ messages, exitCode: 1, stderr: stderr || "Failed to spawn" }));
    if (signal) { const kill = () => { proc.kill("SIGTERM"); setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, 5000); }; if (signal.aborted) kill(); else signal.addEventListener("abort", kill, { once: true }); }
  });
}

function parseReviewOutput(text: string): ReviewAgentOutput | null {
  const t = text.trim(); const candidates: string[] = [];
  const fr = /```(?:json)?\s*([\s\S]*?)```/g; let m: RegExpExecArray | null;
  while ((m = fr.exec(t)) !== null) candidates.push(m[1].trim());
  const idx = t.indexOf('"findings"');
  if (idx >= 0) { const s = t.lastIndexOf("{", idx); if (s >= 0) { let d = 0; for (let i = s; i < t.length; i++) { if (t[i] === "{") d++; else if (t[i] === "}") d--; if (d === 0) { candidates.push(t.slice(s, i + 1)); break; } } } }
  const js = t.indexOf("{"); const je = t.lastIndexOf("}"); if (js >= 0 && je > js) candidates.push(t.slice(js, je + 1));
  candidates.push(t);
  for (const c of candidates) { try { const p = JSON.parse(c); if (!p.findings || !Array.isArray(p.findings)) continue; const findings: ReviewFinding[] = p.findings.filter((f: any) => f.file && f.title).map((f: any) => ({ file: String(f.file), line: Number(f.line) || 0, severity: (["critical", "warning", "suggestion"].includes(f.severity) ? f.severity : "suggestion") as ReviewFinding["severity"], category: String(f.category || "other"), title: String(f.title), description: String(f.description || ""), suggestion: f.suggestion ? String(f.suggestion) : undefined })); return { findings, summary: String(p.summary || ""), score: Math.min(10, Math.max(1, Number(p.score) || 5)) }; } catch { continue; } }
  return null;
}

const STOP_WORDS = new Set(["the","a","an","is","are","was","were","be","been","being","have","has","had","do","does","did","will","would","could","should","may","might","can","shall","to","of","in","for","on","with","at","by","from","as","into","through","during","before","after","above","below","between","under","again","further","then","once","here","there","when","where","why","how","all","each","every","both","few","more","most","other","some","such","no","nor","not","only","own","same","so","than","too","very","just","because","but","and","or","if","while","that","this","these","those","it","its","also","which","about","using","used","use","like"]);
function extractSignificantWords(text: string): Set<string> { return new Set(text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP_WORDS.has(w))); }
function findingSimilarity(a: ReviewFinding, b: ReviewFinding): number {
  if (a.file !== b.file) return 0; if (Math.abs(a.line - b.line) > 15) return 0;
  const aw = extractSignificantWords(`${a.title} ${a.description}`); const bw = extractSignificantWords(`${b.title} ${b.description}`);
  if (aw.size === 0 || bw.size === 0) return 0; let overlap = 0; for (const w of aw) { if (bw.has(w)) overlap++; } return overlap / Math.min(aw.size, bw.size);
}

function consolidateFindings(results: ReviewAgentResult[]): ConsolidatedFinding[] {
  const all: Array<{ finding: ReviewFinding; agent: string }> = [];
  for (const r of results) { if (!r.output) continue; for (const f of r.output.findings) all.push({ finding: f, agent: r.displayName }); }
  const groups: ConsolidatedFinding[] = [];
  for (const { finding, agent } of all) {
    let best: ConsolidatedFinding | null = null; let bestScore = 0;
    for (const g of groups) { const s = findingSimilarity(finding, g as ReviewFinding); if (s > bestScore) { bestScore = s; best = g; } }
    if (best && bestScore >= 0.3) {
      if (!best.agents.includes(agent)) best.agents.push(agent);
      if (SEVERITY_WEIGHT[finding.severity] > SEVERITY_WEIGHT[best.severity]) best.severity = finding.severity;
      if (finding.description.length > best.description.length) { best.description = finding.description; best.title = finding.title; }
      if (finding.suggestion && (!best.suggestion || finding.suggestion.length > best.suggestion.length)) best.suggestion = finding.suggestion;
      best.consensusScore = best.agents.length * SEVERITY_WEIGHT[best.severity];
    } else { groups.push({ ...finding, agents: [agent], consensusScore: SEVERITY_WEIGHT[finding.severity] }); }
  }
  return groups.sort((a, b) => b.consensusScore !== a.consensusScore ? b.consensusScore - a.consensusScore : SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity]);
}

function formatReport(results: ReviewAgentResult[], findings: ConsolidatedFinding[], label: string, filesChanged: number, commitCount: number): string {
  const ok = results.filter((r) => r.output); const failed = results.filter((r) => !r.output); const total = results.length;
  const critical = findings.filter((f) => f.severity === "critical"); const warnings = findings.filter((f) => f.severity === "warning"); const suggestions = findings.filter((f) => f.severity === "suggestion");
  let r = `## Parallel Review (Lite) — ${label}\n\n**Agents:** ${ok.map((r) => r.displayName).join(", ")}\n**Files changed:** ${filesChanged} | **Commits:** ${commitCount}\n\n`;
  if (failed.length > 0) r += `> ⚠️ ${failed.length} agent(s) failed: ${failed.map((a) => a.displayName).join(", ")}\n\n`;
  if (findings.length === 0) r += "✅ **No issues found.**\n\n";
  if (critical.length > 0) { r += `### 🔴 Critical — ${critical.length}\n\n`; for (const f of critical) r += `**[${f.agents.length}/${total}]** \`${f.file}:${f.line}\` — **${f.title}**\n  ${f.description}\n${f.suggestion ? `  > 💡 ${f.suggestion}\n` : ""}\n`; }
  if (warnings.length > 0) { r += `### 🟡 Warnings — ${warnings.length}\n\n`; for (const f of warnings) r += `**[${f.agents.length}/${total}]** \`${f.file}:${f.line}\` — **${f.title}**\n  ${f.description}\n${f.suggestion ? `  > 💡 ${f.suggestion}\n` : ""}\n`; }
  if (suggestions.length > 0) { r += `### 🟢 Suggestions — ${suggestions.length}\n\n`; for (const f of suggestions) r += `**[${f.agents.length}/${total}]** \`${f.file}:${f.line}\` — **${f.title}**\n  ${f.description}\n${f.suggestion ? `  > 💡 ${f.suggestion}\n` : ""}\n`; }
  if (ok.length > 0) { r += `### Scores\n\n| Agent | Score | Findings |\n|-------|-------|----------|\n`; for (const a of ok) r += `| ${a.displayName} | ${a.output?.score ?? "-"}/10 | ${a.output?.findings.length ?? 0} |\n`; r += "\n"; }
  r += `\n💡 Use \`/parallel-review\` for full coverage (all configured models)\n`;
  return r;
}

export default function (pi: ExtensionAPI) {
  let activeAbortController: AbortController | null = null;

  pi.registerCommand("parallel-review-lite", {
    description: `Multi-model parallel review, lite (max ${LITE_MAX_MODELS} models, faster & cheaper)`,
    getArgumentCompletions: (prefix: string) => {
      const repos = listAvailableRepos(pi.getCwd());
      return repos.filter((r) => r.startsWith(prefix)).map((v) => ({ value: v, label: v }));
    },
    handler: async (args, ctx) => {
      if (activeAbortController) { ctx.ui.notify("A review is already running. Use /parallel-review-lite-stop to cancel.", "warning"); return; }

      const target = await resolveReviewTarget(pi, ctx, args);
      if (!target) return;

      const reviewModels = getReviewModels(ctx, LITE_MAX_MODELS);
      if (reviewModels.length === 0) { ctx.ui.notify("No AI models available.", "error"); return; }

      ctx.ui.notify(`🚀 Lite parallel review: ${target.label} — ${reviewModels.length} agents`, "info");
      ctx.ui.setStatus("parallel-review-lite", `Lite review: 0/${reviewModels.length} done`);

      const promptTemp = writeTempFile("pi-parallel-lite-", "reviewer-prompt.md", REVIEWER_SYSTEM_PROMPT);
      activeAbortController = new AbortController();
      const signal = activeAbortController.signal;

      try {
        let completedCount = 0;
        const total = reviewModels.length;

        const results = await Promise.all(
          reviewModels.map(async (model, i): Promise<ReviewAgentResult> => {
            if (i > 0) await new Promise((r) => setTimeout(r, i * SPAWN_STAGGER_MS));
            if (signal.aborted) return { model: model.modelId, displayName: model.displayName, output: null, error: "Cancelled", exitCode: 1 };

            const startedAt = Date.now();
            ctx.ui.notify(`🔍 ${model.displayName} — reviewing...`, "info");

            const timeoutController = new AbortController();
            const timeoutId = setTimeout(() => timeoutController.abort(), AGENT_TIMEOUT_MS);
            const agentSignal = anySignal([signal, timeoutController.signal]);

            try {
              let messages: Message[] = []; let exitCode = 1; let stderr = ""; let attempt = 0;
              while (attempt <= LOCK_RETRY_ATTEMPTS) {
                const res = await runReviewAgent(target.repoCwd, model.provider, model.modelId, target.diff, target.changedFiles, promptTemp.filePath, agentSignal);
                messages = res.messages; exitCode = res.exitCode; stderr = res.stderr;
                if (exitCode !== 0 && stderr.includes("Lock file is already being held") && attempt < LOCK_RETRY_ATTEMPTS) { attempt++; await new Promise((r) => setTimeout(r, LOCK_RETRY_DELAY_MS * attempt)); continue; } break;
              }
              const durationSec = ((Date.now() - startedAt) / 1000).toFixed(0);
              completedCount++; ctx.ui.setStatus("parallel-review-lite", `Lite review: ${completedCount}/${total} done`);
              if (timeoutController.signal.aborted) {
                ctx.ui.notify(`⏱ ${model.displayName} — timed out after ${durationSec}s`, "warning");
                return { model: model.modelId, displayName: model.displayName, output: null, error: `Timed out after ${durationSec}s`, exitCode: 1 };
              }
              if (exitCode !== 0) {
                ctx.ui.notify(`❌ ${model.displayName} — failed (${durationSec}s)`, "warning");
                return { model: model.modelId, displayName: model.displayName, output: null, error: stderr.slice(0, 200) || `Exit ${exitCode}`, exitCode };
              }
              const parsed = parseReviewOutput(getFinalOutput(messages));
              ctx.ui.notify(
                parsed
                  ? `✅ ${model.displayName} — ${durationSec}s · score ${parsed.score}/10 · ${parsed.findings.length} issue(s)`
                  : `⚠️ ${model.displayName} — ${durationSec}s · could not parse output`,
                "info",
              );
              return { model: model.modelId, displayName: model.displayName, output: parsed, error: parsed ? undefined : "Failed to parse JSON", exitCode };
            } catch (err: any) {
              const durationSec = ((Date.now() - startedAt) / 1000).toFixed(0);
              completedCount++; ctx.ui.setStatus("parallel-review-lite", `Lite review: ${completedCount}/${total} done`);
              ctx.ui.notify(`❌ ${model.displayName} — failed after ${durationSec}s`, "warning");
              return { model: model.modelId, displayName: model.displayName, output: null, error: err?.message || "Unknown", exitCode: 1 };
            } finally {
              clearTimeout(timeoutId);
            }
          }),
        );

        if (signal.aborted) { ctx.ui.notify("Review cancelled.", "warning"); ctx.ui.setStatus("parallel-review-lite", undefined); return; }

        const consolidated = consolidateFindings(results);
        const report = formatReport(results, consolidated, target.label, target.changedFiles.length, target.commitCount);

        ctx.ui.setStatus("parallel-review-lite", undefined);
        ctx.ui.notify(`✅ Lite review complete! ${consolidated.length} findings from ${results.length} agents.`, "info");

        pi.sendMessage({ customType: "parallel-review-lite-report", content: report, display: true, details: { label: target.label, agents: results.length, findings: consolidated.length } });
      } finally {
        activeAbortController = null;
        cleanupTempFile(promptTemp.dir, promptTemp.filePath);
      }
    },
  });

  pi.registerCommand("parallel-review-lite-stop", {
    description: "Cancel a running /parallel-review-lite",
    handler: async (_args, ctx) => {
      if (!activeAbortController) { ctx.ui.notify("No review in progress.", "info"); return; }
      activeAbortController.abort(); activeAbortController = null;
      ctx.ui.setStatus("parallel-review-lite", undefined);
      ctx.ui.notify("Review cancelled.", "warning");
    },
  });
}
