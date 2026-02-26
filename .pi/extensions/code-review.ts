/**
 * Multi-Agent Code Review Extension
 *
 * Performs comprehensive code review by spawning multiple AI agents in parallel
 * (across different models/providers), then consolidating findings by consensus.
 *
 * Commands:
 *   /review [base-branch]  - Start a multi-agent code review
 *   /review-stop           - Cancel a running review
 *
 * Each agent reviews the same diff independently, then results are merged:
 * findings reported by more agents are ranked higher (consensus scoring).
 *
 * The command name is configurable via --review-cmd flag to avoid conflicts
 * with other extensions that may register /review.
 *
 * Usage:
 *   pi -e /path/to/code-review.ts
 *   /review              (auto-detects master or main)
 *   /review develop      (compare against develop)
 *   /review-stop         (cancel in-progress review)
 *
 *   # Custom command name:
 *   pi -e /path/to/code-review.ts --review-cmd cr
 *   /cr                  (same as /review)
 *   /cr-stop             (same as /review-stop)
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@mariozechner/pi-ai";
import { type ExtensionAPI, type ExtensionContext, getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Box, Markdown } from "@mariozechner/pi-tui";

// ============================================================================
// Helpers: repo discovery
// ============================================================================

// No hardcoded repos — discovered dynamically from project.yml or by scanning directories.

function getReposPath(cwd: string): string {
	// Try local.json first
	const localConfigPath = path.join(cwd, ".pi", "local.json");
	if (fs.existsSync(localConfigPath)) {
		try {
			const config = JSON.parse(fs.readFileSync(localConfigPath, "utf-8"));
			if (config.reposPath) return config.reposPath;
		} catch {}
	}
	return cwd;
}

function listAvailableRepos(cwd: string): string[] {
	const reposPath = getReposPath(cwd);

	// Try project.yml first for configured repos
	const projectPath = path.join(cwd, "project.yml");
	if (fs.existsSync(projectPath)) {
		try {
			const { parse } = require("yaml");
			const config = parse(fs.readFileSync(projectPath, "utf-8"));
			if (config?.repos?.length) {
				return config.repos
					.map((r: any) => r.name)
					.filter((name: string) => {
						const repoDir = path.join(reposPath, name);
						return fs.existsSync(path.join(repoDir, ".git"));
					});
			}
		} catch {}
	}

	// Fallback: scan directory for git repos
	if (!fs.existsSync(reposPath)) return [];
	return fs.readdirSync(reposPath).filter((name) => {
		if (name.startsWith(".")) return false;
		const repoDir = path.join(reposPath, name);
		return fs.statSync(repoDir).isDirectory() && fs.existsSync(path.join(repoDir, ".git"));
	});
}

// ============================================================================
// Types
// ============================================================================

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

// ============================================================================
// Constants
// ============================================================================

const MAX_CONCURRENCY = 4;
const STAGGER_DELAY_MS = 1500; // Delay between agent spawns to avoid lock file contention
const LOCK_RETRY_ATTEMPTS = 2;
const LOCK_RETRY_DELAY_MS = 3000;

const SEVERITY_WEIGHT: Record<string, number> = {
	critical: 3,
	warning: 2,
	suggestion: 1,
};

const REVIEWER_SYSTEM_PROMPT = `You are a senior code reviewer. Analyze the provided code diff thoroughly.

Focus areas:
- **Bugs**: Logic errors, null/undefined issues, race conditions, edge cases
- **Security**: Injection vulnerabilities, auth issues, data exposure, OWASP top 10
- **Performance**: N+1 queries, unnecessary allocations, algorithmic complexity
- **Style**: Naming, readability, code organization, DRY/SOLID principles
- **Best practices**: Error handling, testing gaps, documentation gaps

You MUST output ONLY valid JSON with this exact schema (no markdown fences, no extra text):
{
  "findings": [
    {
      "file": "path/to/file.ts",
      "line": 42,
      "severity": "critical" | "warning" | "suggestion",
      "category": "bug" | "security" | "performance" | "style" | "best-practice",
      "title": "Brief issue title",
      "description": "Detailed explanation of the issue",
      "suggestion": "Optional: suggested fix or improvement"
    }
  ],
  "summary": "2-3 sentence overall assessment of code quality",
  "score": 7
}

Rules:
- Use bash only for read-only commands (git diff, git log, git show). Do NOT modify any files.
- Read changed files using the read tool to understand full context around the diff.
- Be specific with file paths and line numbers.
- The score should be 1-10, where 10 is perfect code.
- Only report real issues, not style nitpicks unless they hurt readability significantly.
- Output raw JSON only. No markdown code fences. No explanation before or after the JSON.`;

// ============================================================================
// Preferred models per provider
// ============================================================================

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

// ============================================================================
// Helper: concurrency-limited parallel map
// ============================================================================

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
	staggerMs = 0,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			// Stagger: delay each agent spawn to avoid lock file contention
			if (staggerMs > 0 && current > 0) {
				await new Promise((r) => setTimeout(r, current * staggerMs));
			}
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

// ============================================================================
// Helper: write temp file
// ============================================================================

function writeTempFile(name: string, content: string): { dir: string; filePath: string } {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-review-"));
	const safeName = name.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, safeName);
	fs.writeFileSync(filePath, content, { encoding: "utf-8", mode: 0o600 });
	return { dir: tmpDir, filePath };
}

function cleanupTempFile(dir: string, filePath: string): void {
	try { fs.unlinkSync(filePath); } catch { /* ignore */ }
	try { fs.rmdirSync(dir); } catch { /* ignore */ }
}

// ============================================================================
// Helper: detect base branch
// ============================================================================

async function detectBaseBranch(pi: ExtensionAPI, repoCwd?: string): Promise<string> {
	const gitArgs = repoCwd ? ["-C", repoCwd] : [];
	const { code: masterCode } = await pi.exec("git", [...gitArgs, "rev-parse", "--verify", "master"]);
	if (masterCode === 0) return "master";
	const { code: mainCode } = await pi.exec("git", [...gitArgs, "rev-parse", "--verify", "main"]);
	if (mainCode === 0) return "main";
	return "master";
}

// ============================================================================
// Helper: parse PR reference from user input
// ============================================================================

interface PrReference {
	owner: string;
	repo: string;
	number: number;
}

// ============================================================================
// Flexible input helpers: bare PR number, Jira ticket, repo slug, search
// ============================================================================

function parseBareNumber(input: string): number | null {
	const match = input.trim().match(/^#?(\d+)$/);
	return match ? parseInt(match[1], 10) : null;
}

function isJiraTicketId(input: string): boolean {
	return /^[A-Z]+-\d+$/i.test(input.trim());
}

async function getRepoSlug(pi: ExtensionAPI, repoCwd: string): Promise<string | null> {
	const { stdout, code } = await pi.exec("git", ["-C", repoCwd, "remote", "get-url", "origin"]);
	if (code !== 0) return null;
	const match = stdout.trim().match(/github\.com[:/]([^/]+\/[^/.]+)/);
	if (!match) return null;
	return match[1].replace(/\.git$/, "");
}

async function fetchPrInfoFromRepo(
	pi: ExtensionAPI,
	repoCwd: string,
	prNumber: number,
): Promise<PrInfo | { error: string }> {
	const slug = await getRepoSlug(pi, repoCwd);
	if (!slug) return { error: "Could not determine GitHub repository from git remote." };
	const [owner, repo] = slug.split("/");
	return fetchPrInfo(pi, { owner, repo, number: prNumber });
}

async function searchPrsInRepo(
	pi: ExtensionAPI,
	repoCwd: string,
	query: string,
): Promise<Array<{ number: number; title: string; url: string; headRefName: string; state: string }>> {
	const slug = await getRepoSlug(pi, repoCwd);
	if (!slug) return [];
	const { stdout, code } = await pi.exec("gh", [
		"pr", "list", "--repo", slug, "--search", query, "--state", "all",
		"--json", "number,title,url,headRefName,state", "--limit", "10",
	]);
	if (code !== 0) return [];
	try {
		return JSON.parse(stdout);
	} catch {
		return [];
	}
}

/**
 * Resolve flexible user input to a PR.
 * Accepts: full URL, owner/repo#number, bare PR number (#42 or 42),
 * Jira ticket ID (PROJ-123), or branch name / search query.
 * Returns PrInfo on success, { error } on failure, or null if user cancelled.
 */
async function resolveFlexiblePrInput(
	pi: ExtensionAPI,
	ui: ExtensionContext["ui"],
	input: string,
	repoCwd: string,
): Promise<PrInfo | { error: string } | null> {
	const trimmed = input.trim();

	// 1. Full GitHub URL or owner/repo#number
	const prRef = parsePrReference(trimmed);
	if (prRef) {
		ui.notify(`Fetching PR #${prRef.number} from ${prRef.owner}/${prRef.repo}...`, "info");
		return fetchPrInfo(pi, prRef);
	}

	// 2. Bare PR number (#42 or 42)
	const bareNum = parseBareNumber(trimmed);
	if (bareNum !== null) {
		ui.notify(`Fetching PR #${bareNum}...`, "info");
		return fetchPrInfoFromRepo(pi, repoCwd, bareNum);
	}

	// 3. Jira ticket ID or branch name → search for matching PRs
	ui.notify(`Searching for PRs matching "${trimmed}"...`, "info");
	const prs = await searchPrsInRepo(pi, repoCwd, trimmed);
	if (prs.length === 0) {
		return { error: `No PRs found matching "${trimmed}" in this repo.` };
	}
	if (prs.length === 1) {
		ui.notify(`Found PR #${prs[0].number}: ${prs[0].title}`, "info");
		return fetchPrInfoFromRepo(pi, repoCwd, prs[0].number);
	}

	// Multiple matches: let user choose
	const choices = prs.map((pr) => `#${pr.number}: ${pr.title} [${pr.state}]`);
	choices.push("Cancel");
	const choice = await ui.select(`Multiple PRs found for "${trimmed}":`, choices);
	if (!choice || choice === "Cancel") return null;
	const selectedNum = parseInt(choice.match(/#(\d+)/)?.[1] || "0", 10);
	if (!selectedNum) return { error: "Could not parse selection." };
	return fetchPrInfoFromRepo(pi, repoCwd, selectedNum);
}

function parsePrReference(input: string): PrReference | null {
	// Full GitHub URL: https://github.com/owner/repo/pull/123
	const urlMatch = input.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
	if (urlMatch) {
		return { owner: urlMatch[1], repo: urlMatch[2], number: parseInt(urlMatch[3], 10) };
	}

	// Short format: owner/repo#123
	const shortMatch = input.match(/^([^/]+)\/([^#]+)#(\d+)$/);
	if (shortMatch) {
		return { owner: shortMatch[1], repo: shortMatch[2], number: parseInt(shortMatch[3], 10) };
	}

	return null;
}

// ============================================================================
// Helper: fetch PR diff and metadata via gh CLI
// ============================================================================

interface PrInfo {
	diff: string;
	changedFiles: string[];
	branch: string;
	baseBranch: string;
	commitCount: number;
	repoSlug: string;
}

async function fetchPrInfo(pi: ExtensionAPI, pr: PrReference): Promise<PrInfo | { error: string }> {
	const repoSlug = `${pr.owner}/${pr.repo}`;

	// Get PR diff
	const { stdout: diff, code: diffCode, stderr: diffErr } = await pi.exec("gh", [
		"pr", "diff", String(pr.number), "--repo", repoSlug,
	]);
	if (diffCode !== 0) {
		return { error: `Failed to fetch PR diff: ${diffErr.trim() || `exit code ${diffCode}`}` };
	}
	if (!diff.trim()) {
		return { error: "PR has no changes (empty diff)." };
	}

	// Get PR metadata (branch, base, files)
	const { stdout: prJson, code: prCode } = await pi.exec("gh", [
		"pr", "view", String(pr.number), "--repo", repoSlug,
		"--json", "headRefName,baseRefName,changedFiles,commits",
	]);
	if (prCode !== 0) {
		// Fallback: parse changed files from diff
		const filesFromDiff = [...new Set(
			Array.from(diff.matchAll(/^diff --git a\/(.+?) b\//gm), (m) => m[1]),
		)];
		return {
			diff,
			changedFiles: filesFromDiff,
			branch: `PR #${pr.number}`,
			baseBranch: "unknown",
			commitCount: 0,
			repoSlug,
		};
	}

	try {
		const metadata = JSON.parse(prJson);
		const changedFiles = (metadata.changedFiles || []).map((f: any) => f.path || f);
		return {
			diff,
			changedFiles,
			branch: metadata.headRefName || `PR #${pr.number}`,
			baseBranch: metadata.baseRefName || "unknown",
			commitCount: (metadata.commits || []).length,
			repoSlug,
		};
	} catch {
		const filesFromDiff = [...new Set(
			Array.from(diff.matchAll(/^diff --git a\/(.+?) b\//gm), (m) => m[1]),
		)];
		return {
			diff,
			changedFiles: filesFromDiff,
			branch: `PR #${pr.number}`,
			baseBranch: "unknown",
			commitCount: 0,
			repoSlug,
		};
	}
}

// ============================================================================
// Helper: get review models from available providers
// ============================================================================

interface ModelSelection {
	provider: string;
	modelId: string;
	displayName: string;
}

function getReviewModels(ctx: ExtensionContext): ModelSelection[] {
	const available = ctx.modelRegistry.getAvailable();
	const models: ModelSelection[] = [];

	// Pick up to 3 Claude models for variety of perspectives
	const claudeModels = available.filter((m) => m.provider === "anthropic");
	for (const preferredId of CLAUDE_PREFERRED) {
		const found = claudeModels.find((m) => m.id === preferredId);
		if (found) {
			models.push({
				provider: found.provider,
				modelId: found.id,
				displayName: found.name || found.id,
			});
		}
		if (models.length >= 3) break;
	}
	// If no preferred Claude found, take whatever Claude is available
	if (models.length === 0) {
		for (const m of claudeModels.slice(0, 2)) {
			models.push({
				provider: m.provider,
				modelId: m.id,
				displayName: m.name || m.id,
			});
		}
	}

	// 1 agent per extra configured provider
	for (const [provider, defaultModelId] of EXTRA_PROVIDER_PREFERRED) {
		const providerModels = available.filter((m) => m.provider === provider);
		if (providerModels.length > 0) {
			const best = providerModels.find((m) => m.id === defaultModelId) ?? providerModels[0];
			models.push({
				provider: best.provider,
				modelId: best.id,
				displayName: best.name || best.id,
			});
		}
	}

	return models;
}

// ============================================================================
// Helper: get final text output from pi JSON mode messages
// ============================================================================

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

// ============================================================================
// Run a single review agent
// ============================================================================

async function runReviewAgent(
	cwd: string,
	provider: string,
	modelId: string,
	diffFilePath: string,
	changedFiles: string[],
	systemPromptPath: string,
	signal?: AbortSignal,
): Promise<{ messages: Message[]; exitCode: number; stderr: string }> {
	const args: string[] = [
		"--mode", "json",
		"-p", "--no-session",
		"--provider", provider,
		"--model", modelId,
		"--tools", "read,grep,find,ls,bash",
		"--append-system-prompt", systemPromptPath,
		`Review the code diff at ${diffFilePath}. Changed files: ${changedFiles.join(", ")}. Read the diff file and the changed files to understand context. Output your findings as JSON only.`,
	];

	return new Promise<{ messages: Message[]; exitCode: number; stderr: string }>((resolve) => {
		const proc = spawn("pi", args, {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let buffer = "";
		const messages: Message[] = [];
		let stderr = "";

		const processLine = (line: string) => {
			if (!line.trim()) return;
			let event: any;
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}

			if (event.type === "message_end" && event.message) {
				messages.push(event.message as Message);
			}
			if (event.type === "tool_result_end" && event.message) {
				messages.push(event.message as Message);
			}
		};

		proc.stdout.on("data", (data: Buffer) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) processLine(line);
		});

		proc.stderr.on("data", (data: Buffer) => {
			stderr += data.toString();
		});

		proc.on("close", (code: number | null) => {
			if (buffer.trim()) processLine(buffer);
			resolve({ messages, exitCode: code ?? 1, stderr });
		});

		proc.on("error", () => {
			resolve({ messages, exitCode: 1, stderr: stderr || "Failed to spawn pi process" });
		});

		if (signal) {
			const killProc = () => {
				proc.kill("SIGTERM");
				setTimeout(() => {
					if (!proc.killed) proc.kill("SIGKILL");
				}, 5000);
			};
			if (signal.aborted) killProc();
			else signal.addEventListener("abort", killProc, { once: true });
		}
	});
}

// ============================================================================
// Parse JSON output from agent
// ============================================================================

function parseReviewOutput(text: string): ReviewAgentOutput | null {
	// Try multiple strategies to extract JSON from the agent's response
	const candidates: string[] = [];

	const trimmed = text.trim();

	// Strategy 1: extract from markdown code fences (```json ... ``` or ``` ... ```)
	const fenceRegex = /```(?:json)?\s*([\s\S]*?)```/g;
	let fenceMatch: RegExpExecArray | null;
	while ((fenceMatch = fenceRegex.exec(trimmed)) !== null) {
		candidates.push(fenceMatch[1].trim());
	}

	// Strategy 2: find outermost { ... } that contains "findings"
	const findingsIdx = trimmed.indexOf('"findings"');
	if (findingsIdx >= 0) {
		// Walk backwards to find the opening {
		let braceStart = trimmed.lastIndexOf("{", findingsIdx);
		if (braceStart >= 0) {
			// Walk forward to find the matching closing }
			let depth = 0;
			for (let i = braceStart; i < trimmed.length; i++) {
				if (trimmed[i] === "{") depth++;
				else if (trimmed[i] === "}") depth--;
				if (depth === 0) {
					candidates.push(trimmed.slice(braceStart, i + 1));
					break;
				}
			}
		}
	}

	// Strategy 3: first { to last }
	const jsonStart = trimmed.indexOf("{");
	const jsonEnd = trimmed.lastIndexOf("}");
	if (jsonStart >= 0 && jsonEnd > jsonStart) {
		candidates.push(trimmed.slice(jsonStart, jsonEnd + 1));
	}

	// Strategy 4: the whole text as-is
	candidates.push(trimmed);

	// Try each candidate
	for (const candidate of candidates) {
		try {
			const parsed = JSON.parse(candidate);
			if (!parsed.findings || !Array.isArray(parsed.findings)) continue;

			// Validate and normalize findings
			const findings: ReviewFinding[] = [];
			for (const f of parsed.findings) {
				if (!f.file || !f.title) continue;
				findings.push({
					file: String(f.file),
					line: Number(f.line) || 0,
					severity: ["critical", "warning", "suggestion"].includes(f.severity) ? f.severity : "suggestion",
					category: String(f.category || "other"),
					title: String(f.title),
					description: String(f.description || ""),
					suggestion: f.suggestion ? String(f.suggestion) : undefined,
				});
			}
			return {
				findings,
				summary: String(parsed.summary || ""),
				score: Math.min(10, Math.max(1, Number(parsed.score) || 5)),
			};
		} catch {
			continue;
		}
	}

	return null;
}

// ============================================================================
// Consolidate findings across agents (similarity-based deduplication)
// ============================================================================

/** Stop words excluded from similarity comparison */
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

/** Extract meaningful words from text for similarity comparison */
function extractSignificantWords(text: string): Set<string> {
	const words = text
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, " ")
		.split(/\s+/)
		.filter((w) => w.length > 2 && !STOP_WORDS.has(w));
	return new Set(words);
}

/** Compute word-overlap similarity between two findings (0..1) */
function findingSimilarity(a: ReviewFinding, b: ReviewFinding): number {
	// Must be the same file — non-negotiable
	if (a.file !== b.file) return 0;

	// Lines must be within ±15 of each other
	if (Math.abs(a.line - b.line) > 15) return 0;

	// Compare significant words from title + description
	const aWords = extractSignificantWords(`${a.title} ${a.description}`);
	const bWords = extractSignificantWords(`${b.title} ${b.description}`);

	if (aWords.size === 0 || bWords.size === 0) return 0;

	let overlap = 0;
	for (const w of aWords) {
		if (bWords.has(w)) overlap++;
	}

	// Use overlap / min(|A|, |B|) — biased toward the smaller set so that
	// a short finding can still match a longer one about the same issue.
	const minSize = Math.min(aWords.size, bWords.size);
	return overlap / minSize;
}

/** Similarity threshold above which two findings are considered duplicates */
const SIMILARITY_THRESHOLD = 0.3;

function consolidateFindings(results: ReviewAgentResult[]): ConsolidatedFinding[] {
	// 1. Flatten all findings with their agent source
	const all: Array<{ finding: ReviewFinding; agent: string }> = [];
	for (const result of results) {
		if (!result.output) continue;
		for (const finding of result.output.findings) {
			all.push({ finding, agent: result.displayName });
		}
	}

	// 2. Greedy pairwise grouping: for each finding, try to merge into an
	//    existing group; if no group is similar enough, start a new one.
	const groups: ConsolidatedFinding[] = [];

	for (const { finding, agent } of all) {
		let bestGroup: ConsolidatedFinding | null = null;
		let bestScore = 0;

		for (const group of groups) {
			// Compare against the "representative" finding stored in the group
			const sim = findingSimilarity(finding, {
				file: group.file,
				line: group.line,
				severity: group.severity,
				category: group.category,
				title: group.title,
				description: group.description,
			});
			if (sim > bestScore) {
				bestScore = sim;
				bestGroup = group;
			}
		}

		if (bestGroup && bestScore >= SIMILARITY_THRESHOLD) {
			// Merge into existing group
			if (!bestGroup.agents.includes(agent)) {
				bestGroup.agents.push(agent);
			}
			// Upgrade severity if higher
			if (SEVERITY_WEIGHT[finding.severity] > SEVERITY_WEIGHT[bestGroup.severity]) {
				bestGroup.severity = finding.severity;
			}
			// Keep the most detailed description
			if (finding.description.length > bestGroup.description.length) {
				bestGroup.description = finding.description;
				bestGroup.title = finding.title;
			}
			if (finding.suggestion && (!bestGroup.suggestion || finding.suggestion.length > bestGroup.suggestion.length)) {
				bestGroup.suggestion = finding.suggestion;
			}
			bestGroup.consensusScore = bestGroup.agents.length * SEVERITY_WEIGHT[bestGroup.severity];
		} else {
			// Start a new group
			groups.push({
				file: finding.file,
				line: finding.line,
				severity: finding.severity,
				category: finding.category,
				title: finding.title,
				description: finding.description,
				suggestion: finding.suggestion,
				agents: [agent],
				consensusScore: SEVERITY_WEIGHT[finding.severity],
			});
		}
	}

	// 3. Sort by consensus score DESC, then severity DESC
	return groups.sort((a, b) => {
		if (b.consensusScore !== a.consensusScore) return b.consensusScore - a.consensusScore;
		return SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity];
	});
}

// ============================================================================
// Format the final report
// ============================================================================

function formatReport(
	results: ReviewAgentResult[],
	findings: ConsolidatedFinding[],
	branch: string,
	baseBranch: string,
	filesChanged: number,
	commitCount: number,
	totalAgents: number,
): string {
	const successfulAgents = results.filter((r) => r.output);
	const agentNames = successfulAgents.map((r) => r.displayName).join(", ");
	const modelCount = new Set(successfulAgents.map((r) => r.model)).size;

	const critical = findings.filter((f) => f.severity === "critical");
	const warnings = findings.filter((f) => f.severity === "warning");
	const suggestions = findings.filter((f) => f.severity === "suggestion");

	let report = `## Code Review Results (${successfulAgents.length} agents, ${modelCount} models)\n\n`;
	report += `**Agents used:** ${agentNames}\n`;
	report += `**Branch:** ${branch} → ${baseBranch}\n`;
	report += `**Files changed:** ${filesChanged} | **Commits:** ${commitCount}\n\n`;

	// Failed agents warning
	const failed = results.filter((r) => !r.output);
	if (failed.length > 0) {
		report += `> **Note:** ${failed.length} agent(s) failed: ${failed.map((r) => `${r.displayName} (${r.error || "unknown error"})`).join(", ")}\n\n`;
	}

	if (findings.length === 0) {
		report += "**No issues found.** All agents report clean code.\n\n";
	}

	// Critical issues
	if (critical.length > 0) {
		report += `### Critical Issues (must fix) — ${critical.length} found\n\n`;
		for (const f of critical) {
			report += formatFinding(f, totalAgents);
		}
	}

	// Warnings
	if (warnings.length > 0) {
		report += `### Warnings (should fix) — ${warnings.length} found\n\n`;
		for (const f of warnings) {
			report += formatFinding(f, totalAgents);
		}
	}

	// Suggestions
	if (suggestions.length > 0) {
		report += `### Suggestions (nice to have) — ${suggestions.length} found\n\n`;
		for (const f of suggestions) {
			report += formatFinding(f, totalAgents);
		}
	}

	// Per-agent scores table
	if (successfulAgents.length > 0) {
		report += `### Per-Agent Scores\n\n`;
		report += `| Agent | Model | Score | Findings |\n`;
		report += `|-------|-------|-------|----------|\n`;
		for (const r of successfulAgents) {
			const findingCount = r.output?.findings.length ?? 0;
			const score = r.output?.score ?? "-";
			report += `| ${r.displayName} | ${r.model} | ${score}/10 | ${findingCount} |\n`;
		}
		report += "\n";
	}

	// Consolidated summary
	if (successfulAgents.length > 0) {
		report += `### Summary\n\n`;
		const summaries = successfulAgents
			.filter((r) => r.output?.summary)
			.map((r) => r.output!.summary);
		if (summaries.length > 0) {
			report += summaries.join(" ") + "\n";
		} else {
			report += `Review completed with ${findings.length} total finding(s) across ${successfulAgents.length} agents.\n`;
		}
	}

	return report;
}

function formatFinding(f: ConsolidatedFinding, totalAgents: number): string {
	let text = `**[Consensus: ${f.agents.length}/${totalAgents}]** \`${f.file}:${f.line}\` — **${f.title}**\n`;
	text += `  ${f.description}\n`;
	if (f.suggestion) {
		text += `  \`\`\`suggestion\n  ${f.suggestion}\n  \`\`\`\n`;
	}
	text += "\n";
	return text;
}

// ============================================================================
// Extension entry point
// ============================================================================

export default function (pi: ExtensionAPI) {
	// Configurable command name via --review-cmd flag
	// Usage: pi -e code-review.ts --review-cmd cr
	//   → registers /cr and /cr-stop instead of /review and /review-stop
	pi.registerFlag("review-cmd", {
		description: "Command name for code review (default: review). E.g. --review-cmd cr → /cr",
		type: "string",
		default: "review-me",
	});

	const cmdName = (pi.getFlag("--review-cmd") as string) || "review-me";
	const stopCmdName = `${cmdName}-stop`;

	// Register a renderer for the review report message
	pi.registerMessageRenderer("code-review-report", (message, _options, theme) => {
		const mdTheme = getMarkdownTheme();
		const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
		box.addChild(new Markdown(String(message.content), 0, 0, mdTheme));
		return box;
	});

	let activeAbortController: AbortController | null = null;

	// /review [PR-url | owner/repo#number]  (or custom name)
	pi.registerCommand(cmdName, {
		description: "Start a multi-agent code review on a repo",
		getArgumentCompletions: undefined,
		handler: async (args: string, ctx) => {
			// Check if a review is already running
			if (activeAbortController) {
				ctx.ui.notify(`A review is already in progress. Use /${stopCmdName} to cancel it.`, "warning");
				return;
			}

			const cwd = ctx.cwd;
			const trimmedArgs = args.trim();

			// Check if args look like a PR reference (skip repo selection if so)
			const prFromArgs = trimmedArgs ? parsePrReference(trimmedArgs) : null;

			let diff: string;
			let changedFiles: string[];
			let branch: string;
			let baseBranch: string;
			let commitCount: number;
			let repoCwd: string = cwd; // working directory for the review agents

			if (prFromArgs) {
				// ── PR mode (from args) ──
				ctx.ui.notify(`Fetching PR #${prFromArgs.number} from ${prFromArgs.owner}/${prFromArgs.repo}...`, "info");
				const prInfo = await fetchPrInfo(pi, prFromArgs);
				if ("error" in prInfo) {
					ctx.ui.notify(prInfo.error, "error");
					return;
				}
				diff = prInfo.diff;
				changedFiles = prInfo.changedFiles;
				branch = prInfo.branch;
				baseBranch = prInfo.baseBranch;
				commitCount = prInfo.commitCount;

				// Try to find the repo locally so agents can read full files
				const reposPath = getReposPath(cwd);
				const localRepoDir = path.join(reposPath, prFromArgs.repo);
				if (fs.existsSync(path.join(localRepoDir, ".git"))) {
					repoCwd = localRepoDir;
				}
			} else {
				// ── Interactive mode: ask repo, then what to review ──

				// Step 1: Pick a repo
				const availableRepos = listAvailableRepos(cwd);
				if (availableRepos.length === 0) {
					ctx.ui.notify(
						"No repos found. Check your .pi/local.json reposPath or clone repos into this directory.",
						"error",
					);
					return;
				}

				// If a repo name was passed as argument, use it directly
				let selectedRepo: string | null = null;
				if (trimmedArgs && availableRepos.includes(trimmedArgs)) {
					selectedRepo = trimmedArgs;
				} else {
					const repoChoice = await ctx.ui.select("Which repo do you want to review?", [...availableRepos, "Cancel"]);
					if (!repoChoice || repoChoice === "Cancel") {
						ctx.ui.notify("Review cancelled.", "info");
						return;
					}
					selectedRepo = repoChoice;
				}

				const reposPath = getReposPath(cwd);
				repoCwd = path.join(reposPath, selectedRepo);

				// If args contained a flexible input (not a repo name), resolve it directly
				// This handles: /review-me 42, /review-me PROJ-123, /review-me branch-name
				let resolvedFromArgs = false;
				if (trimmedArgs && trimmedArgs !== selectedRepo) {
					const prInfo = await resolveFlexiblePrInput(pi, ctx.ui, trimmedArgs, repoCwd);
					if (prInfo === null) {
						ctx.ui.notify("Review cancelled.", "info");
						return;
					}
					if ("error" in prInfo) {
						ctx.ui.notify(prInfo.error, "error");
						return;
					}
					diff = prInfo.diff;
					changedFiles = prInfo.changedFiles;
					branch = prInfo.branch;
					baseBranch = prInfo.baseBranch;
					commitCount = prInfo.commitCount;
					resolvedFromArgs = true;
				}

				if (!resolvedFromArgs) {
				// Step 2: Pick what to review (current branch, a PR, or cancel)
				// Get branch info from the selected repo
				const { stdout: currentBranchRaw, code: branchCode } = await pi.exec(
					"git", ["-C", repoCwd, "rev-parse", "--abbrev-ref", "HEAD"],
				);
				const currentBranchName = branchCode === 0 ? currentBranchRaw.trim() : null;

				const reviewOptions: string[] = [];
				if (currentBranchName && currentBranchName !== "master" && currentBranchName !== "main" && currentBranchName !== "HEAD") {
					reviewOptions.push(`Review current branch (${currentBranchName})`);
				}
				reviewOptions.push("Review a PR (number, URL, ticket ID, or branch name)");
				reviewOptions.push("Cancel");

				const reviewChoice = await ctx.ui.select(`What do you want to review in ${selectedRepo}?`, reviewOptions);
				if (!reviewChoice || reviewChoice === "Cancel") {
					ctx.ui.notify("Review cancelled.", "info");
					return;
				}

				if (reviewChoice.startsWith("Review a PR")) {
					// ── PR mode (interactive, flexible input) ──
					const userInput = await ctx.ui.input(
						"PR number, URL, ticket ID, or branch name:",
						"e.g. 42, #42, PROJ-123, feature/my-branch, https://github.com/owner/repo/pull/123",
					);
					if (!userInput) {
						ctx.ui.notify("Review cancelled.", "info");
						return;
					}
					const prInfo = await resolveFlexiblePrInput(pi, ctx.ui, userInput, repoCwd);
					if (prInfo === null) {
						ctx.ui.notify("Review cancelled.", "info");
						return;
					}
					if ("error" in prInfo) {
						ctx.ui.notify(prInfo.error, "error");
						return;
					}
					diff = prInfo.diff;
					changedFiles = prInfo.changedFiles;
					branch = prInfo.branch;
					baseBranch = prInfo.baseBranch;
					commitCount = prInfo.commitCount;
				} else {
					// ── Branch mode: diff current branch against master/main ──
					const localBaseBranch = await detectBaseBranch(pi, repoCwd);

					// Verify base branch exists in the repo
					const { code: baseCheck } = await pi.exec("git", ["-C", repoCwd, "rev-parse", "--verify", localBaseBranch]);
					if (baseCheck !== 0) {
						ctx.ui.notify(`Base branch '${localBaseBranch}' not found in ${selectedRepo}.`, "error");
						return;
					}

					branch = currentBranchName!;

					const [_diffStatResult, filesResult, logResult, diffResult] = await Promise.all([
						pi.exec("git", ["-C", repoCwd, "diff", "--stat", `${localBaseBranch}...HEAD`]),
						pi.exec("git", ["-C", repoCwd, "diff", "--name-only", `${localBaseBranch}...HEAD`]),
						pi.exec("git", ["-C", repoCwd, "log", "--oneline", `${localBaseBranch}...HEAD`]),
						pi.exec("git", ["-C", repoCwd, "diff", `${localBaseBranch}...HEAD`]),
					]);

					changedFiles = filesResult.stdout.trim().split("\n").filter(Boolean);
					commitCount = logResult.stdout.trim().split("\n").filter(Boolean).length;

					if (changedFiles.length === 0) {
						ctx.ui.notify(`No changes found between '${branch}' and '${localBaseBranch}' in ${selectedRepo}.`, "warning");
						return;
					}

					diff = diffResult.stdout;
					baseBranch = localBaseBranch;
				}
				} // end if (!resolvedFromArgs)
			}

			// -----------------------------------------------------------
			// Common review flow (same for local and remote)
			// -----------------------------------------------------------

			// Detect available review models
			const reviewModels = getReviewModels(ctx);
			if (reviewModels.length === 0) {
				ctx.ui.notify("No AI models available. Check your API key configuration.", "error");
				return;
			}

			const totalAgents = reviewModels.length;
			const modelSummary = reviewModels.map((m) => m.displayName).join(", ");
			ctx.ui.notify(
				`Starting review with ${totalAgents} agent(s): ${modelSummary}`,
				"info",
			);

			// Write diff to temp file
			const diffTemp = writeTempFile("review-diff.patch", diff);

			// Write system prompt to temp file
			const promptTemp = writeTempFile("reviewer-prompt.md", REVIEWER_SYSTEM_PROMPT);

			// Set up abort controller
			activeAbortController = new AbortController();
			const signal = activeAbortController.signal;

			try {
				// Launch all review agents in parallel
				ctx.ui.setStatus("review", `Review: 0/${totalAgents} done`);

				let completedCount = 0;

				const results = await mapWithConcurrencyLimit(
					reviewModels,
					MAX_CONCURRENCY,
					async (model): Promise<ReviewAgentResult> => {
						if (signal.aborted) {
							return {
								model: model.modelId,
								displayName: model.displayName,
								output: null,
								error: "Cancelled",
								exitCode: 1,
							};
						}

						try {
							let messages: Message[] = [];
							let exitCode = 1;
							let stderr = "";
							let attempt = 0;
							const maxAttempts = 1 + LOCK_RETRY_ATTEMPTS;

							while (attempt < maxAttempts) {
								const result = await runReviewAgent(
									repoCwd,
									model.provider,
									model.modelId,
									diffTemp.filePath,
									changedFiles,
									promptTemp.filePath,
									signal,
								);
								messages = result.messages;
								exitCode = result.exitCode;
								stderr = result.stderr;

								// Retry on lock file errors
								if (exitCode !== 0 && stderr.includes("Lock file is already being held") && attempt < maxAttempts - 1) {
									attempt++;
									const delay = LOCK_RETRY_DELAY_MS * attempt;
									ctx.ui.setStatus("review", `Review: ${completedCount}/${totalAgents} done (retrying ${model.displayName}...)`);
									await new Promise((r) => setTimeout(r, delay));
									continue;
								}
								break;
							}

							completedCount++;
							ctx.ui.setStatus("review", `Review: ${completedCount}/${totalAgents} done`);

							if (exitCode !== 0) {
								return {
									model: model.modelId,
									displayName: model.displayName,
									output: null,
									error: stderr.slice(0, 200) || `Exit code ${exitCode}`,
									exitCode,
								};
							}

							const finalText = getFinalOutput(messages);
							const parsed = parseReviewOutput(finalText);

							return {
								model: model.modelId,
								displayName: model.displayName,
								output: parsed,
								error: parsed ? undefined : "Failed to parse JSON output",
								exitCode,
							};
						} catch (err: any) {
							completedCount++;
							ctx.ui.setStatus("review", `Review: ${completedCount}/${totalAgents} done`);
							return {
								model: model.modelId,
								displayName: model.displayName,
								output: null,
								error: err?.message || "Unknown error",
								exitCode: 1,
							};
						}
					},
					STAGGER_DELAY_MS,
				);

				if (signal.aborted) {
					ctx.ui.notify("Review was cancelled.", "warning");
					ctx.ui.setStatus("review", undefined);
					return;
				}

				// Consolidate findings
				const consolidated = consolidateFindings(results);

				// Format and send report
				const report = formatReport(
					results,
					consolidated,
					branch,
					baseBranch,
					changedFiles.length,
					commitCount,
					totalAgents,
				);

				ctx.ui.setStatus("review", undefined);
				ctx.ui.notify("Review complete!", "info");

				// Send the report as a custom message (doesn't require a model)
				pi.sendMessage({
					customType: "code-review-report",
					content: report,
					display: true,
					details: {
						agentCount: totalAgents,
						findingCount: consolidated.length,
						branch,
						baseBranch,
					},
				});
			} finally {
				// Cleanup
				activeAbortController = null;
				cleanupTempFile(diffTemp.dir, diffTemp.filePath);
				cleanupTempFile(promptTemp.dir, promptTemp.filePath);
			}
		},
	});

	// /review-stop (or custom name)
	pi.registerCommand(stopCmdName, {
		description: "Cancel a running code review",
		handler: async (_args: string, ctx) => {
			if (!activeAbortController) {
				ctx.ui.notify("No review in progress.", "info");
				return;
			}
			activeAbortController.abort();
			activeAbortController = null;
			ctx.ui.setStatus("review", undefined);
			ctx.ui.notify("Review cancelled. Agents are being stopped.", "warning");
		},
	});
}
