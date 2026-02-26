import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  mkdirSync,
} from "fs";
import { join } from "path";
import { homedir } from "os";
import { parse as parseYaml } from "yaml";

// ─── Helpers: Project config ───

interface RepoConfig {
  name: string;
  path: string;
  type?: string;
  stack?: string;
}

interface ProjectConfig {
  project: { name: string; description: string };
  repos: RepoConfig[];
  repo_structure: string;
  conventions: {
    branch_format: string;
    commit_format: string;
    linter: string;
    test_command: string;
    pr_template: string;
    merge_strategy: string;
    required_approvals: number;
  };
  deployment: { strategy: string; notes: string };
  agent: {
    autonomy: string;
    guardrails: string[];
    protected_files: string[];
  };
  jira: {
    board_id: number | null;
    ticket_prefixes: string[];
    exclude_prefixes: string[];
  };
}

function loadProjectConfig(cwd: string): ProjectConfig | null {
  const configPath = join(cwd, "project.yml");
  if (!existsSync(configPath)) return null;
  try {
    const raw = readFileSync(configPath, "utf-8");
    return parseYaml(raw) as ProjectConfig;
  } catch {
    return null;
  }
}

// ─── Helpers: Local config ───

interface LocalConfig {
  reposPath?: string;
}

function loadLocalConfig(cwd: string): LocalConfig {
  const configPath = join(cwd, ".pi", "local.json");
  if (existsSync(configPath)) {
    try {
      return JSON.parse(readFileSync(configPath, "utf-8")) as LocalConfig;
    } catch {}
  }
  return {};
}

function getReposPath(cwd: string): string {
  const config = loadLocalConfig(cwd);
  return config.reposPath || cwd;
}

function getConfiguredRepoNames(cwd: string): string[] {
  const project = loadProjectConfig(cwd);
  if (project?.repos?.length) {
    return project.repos.map((r) => r.name);
  }
  // Fallback: scan memory/repos/ for existing memory files
  return listRepoMemoryFiles(cwd);
}

// ─── Helpers: Memory files ───

function readMemoryFile(cwd: string, relativePath: string): string | null {
  const fullPath = join(cwd, relativePath);
  if (existsSync(fullPath)) {
    return readFileSync(fullPath, "utf-8");
  }
  return null;
}

function listRepoMemoryFiles(cwd: string): string[] {
  const dir = join(cwd, "memory/repos");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(".md", ""));
}

// ─── Helpers: Jira auth ───

interface JiraAuth {
  baseUrl: string;
  email: string;
  apiToken: string;
}

const JIRA_AUTH_PATH = join(homedir(), ".pi", "agent", "jira-auth.json");

function loadJiraAuth(): JiraAuth | null {
  if (!existsSync(JIRA_AUTH_PATH)) return null;
  try {
    const data = JSON.parse(readFileSync(JIRA_AUTH_PATH, "utf-8"));
    if (data.baseUrl && data.email && data.apiToken) return data as JiraAuth;
  } catch {}
  return null;
}

function saveJiraAuth(auth: JiraAuth): void {
  const dir = join(homedir(), ".pi", "agent");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(JIRA_AUTH_PATH, JSON.stringify(auth, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
}

async function jiraFetch(
  auth: JiraAuth,
  path: string
): Promise<{ ok: boolean; status: number; data: any }> {
  const url = `${auth.baseUrl}/rest/api/3/${path}`;
  const headers = {
    Authorization:
      "Basic " +
      Buffer.from(`${auth.email}:${auth.apiToken}`).toString("base64"),
    Accept: "application/json",
  };
  const res = await fetch(url, { headers });
  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = { errorMessages: [text.slice(0, 200)] };
  }
  return { ok: res.ok, status: res.status, data };
}

async function jiraAgileGet(
  auth: JiraAuth,
  path: string
): Promise<{ ok: boolean; status: number; data: any }> {
  const url = `${auth.baseUrl}/rest/agile/1.0/${path}`;
  const headers = {
    Authorization:
      "Basic " +
      Buffer.from(`${auth.email}:${auth.apiToken}`).toString("base64"),
    Accept: "application/json",
  };
  const res = await fetch(url, { headers });
  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = { errorMessages: [text.slice(0, 200)] };
  }
  return { ok: res.ok, status: res.status, data };
}

// ─── Helpers: Jira content formatting ───

function adfToText(node: any): string {
  if (!node) return "";
  if (typeof node === "string") return node;

  let text = "";

  if (node.type === "text") {
    text += node.text || "";
  }
  if (node.type === "hardBreak") {
    text += "\n";
  }
  if (node.type === "heading") {
    const level = node.attrs?.level || 1;
    const prefix = "#".repeat(level);
    const content = (node.content || []).map(adfToText).join("");
    text += `${prefix} ${content}\n\n`;
    return text;
  }
  if (node.type === "paragraph") {
    const content = (node.content || []).map(adfToText).join("");
    text += content + "\n\n";
    return text;
  }
  if (node.type === "bulletList" || node.type === "orderedList") {
    const items = node.content || [];
    items.forEach((item: any, i: number) => {
      const prefix = node.type === "orderedList" ? `${i + 1}. ` : "- ";
      const content = (item.content || []).map(adfToText).join("").trim();
      text += `${prefix}${content}\n`;
    });
    text += "\n";
    return text;
  }
  if (node.type === "codeBlock") {
    const content = (node.content || []).map(adfToText).join("");
    const lang = node.attrs?.language || "";
    text += `\`\`\`${lang}\n${content}\n\`\`\`\n\n`;
    return text;
  }
  if (node.type === "inlineCard" || node.type === "blockCard") {
    text += node.attrs?.url || "";
    return text;
  }
  if (node.content && Array.isArray(node.content)) {
    text += node.content.map(adfToText).join("");
  }
  return text;
}

function formatTicket(issue: any): string {
  const fields = issue.fields;
  let out = `# ${issue.key}: ${fields.summary}\n\n`;
  out += `**Status:** ${fields.status?.name || "Unknown"}\n`;
  out += `**Type:** ${fields.issuetype?.name || "Unknown"}\n`;
  out += `**Priority:** ${fields.priority?.name || "Unknown"}\n`;
  out += `**Assignee:** ${fields.assignee?.displayName || "Unassigned"}\n`;
  out += `**Reporter:** ${fields.reporter?.displayName || "Unknown"}\n`;
  if (fields.labels?.length > 0)
    out += `**Labels:** ${fields.labels.join(", ")}\n`;
  if (fields.components?.length > 0)
    out += `**Components:** ${fields.components.map((c: any) => c.name).join(", ")}\n`;
  if (fields.fixVersions?.length > 0)
    out += `**Fix Versions:** ${fields.fixVersions.map((v: any) => v.name).join(", ")}\n`;
  if (fields.parent)
    out += `**Parent:** ${fields.parent.key} — ${fields.parent.fields?.summary || ""}\n`;

  out += "\n## Description\n\n";
  if (fields.description) {
    out += adfToText(fields.description).trim() + "\n";
  } else {
    out += "_No description provided._\n";
  }

  const acceptanceCriteria =
    fields.customfield_10035 ||
    fields.customfield_10036 ||
    fields.customfield_10028;
  if (acceptanceCriteria) {
    out += "\n## Acceptance Criteria\n\n";
    if (typeof acceptanceCriteria === "string") {
      out += acceptanceCriteria + "\n";
    } else {
      out += adfToText(acceptanceCriteria).trim() + "\n";
    }
  }
  return out;
}

// ─── Extension entry point ───

export default function (pi: ExtensionAPI) {
  // ─── System prompt injection ───
  pi.on("before_agent_start", async (event, ctx) => {
    const cwd = ctx.cwd;
    const directives = readMemoryFile(cwd, "memory/DIRECTIVES.md");
    const architecture = readMemoryFile(cwd, "memory/ARCHITECTURE.md");

    if (!directives && !architecture) return undefined;

    let memoryBlock = "\n\n# Project Memory (auto-loaded)\n";
    memoryBlock +=
      "The following project knowledge was loaded from the memory/ directory.\n";
    memoryBlock +=
      "Use this context when planning and implementing changes.\n";
    memoryBlock +=
      "When you learn something new, update these files with your findings.\n\n";

    if (directives) memoryBlock += "## Directives\n\n" + directives + "\n\n";
    if (architecture)
      memoryBlock += "## Architecture\n\n" + architecture + "\n\n";

    // Project config summary
    const project = loadProjectConfig(cwd);
    if (project?.project?.name) {
      memoryBlock += "## Project Config\n";
      memoryBlock += `Project: ${project.project.name}\n`;
      if (project.project.description)
        memoryBlock += `Description: ${project.project.description}\n`;
      if (project.repo_structure)
        memoryBlock += `Repo structure: ${project.repo_structure}\n`;
      if (project.agent?.guardrails?.length) {
        memoryBlock += `\nGuardrails:\n`;
        for (const g of project.agent.guardrails) {
          memoryBlock += `- ${g}\n`;
        }
      }
      if (project.agent?.protected_files?.length) {
        memoryBlock += `\nProtected files (do NOT modify):\n`;
        for (const f of project.agent.protected_files) {
          memoryBlock += `- ${f}\n`;
        }
      }
      memoryBlock += "\n";
    }

    const reposPath = getReposPath(cwd);
    memoryBlock +=
      "## Repository Location\n" +
      `Repos are at: \`${reposPath}\`\n` +
      "Use this path when navigating to repos (e.g. `cd " +
      reposPath +
      "/<repo-name>`).\n\n";

    const repos = listRepoMemoryFiles(cwd);
    if (repos.length > 0) {
      memoryBlock +=
        "## Per-Repo Memory\n" +
        "Available repos: " +
        repos.join(", ") +
        "\n" +
        "**IMPORTANT**: After determining which repo(s) a task affects, " +
        "call the `load_repo_context` tool to load repo-specific knowledge " +
        "before starting implementation.\n";
    }

    const jiraAuth = loadJiraAuth();
    if (jiraAuth) {
      memoryBlock +=
        "\n## Jira Integration\n" +
        `Connected to: ${jiraAuth.baseUrl}\n` +
        "Use the `jira_ticket` tool to fetch ticket details by ID.\n" +
        "Use the `jira_sprint` tool to fetch sprint tickets.\n";
    }

    // Check GitHub CLI auth
    try {
      const { execSync } = await import("child_process");
      const ghStatus = execSync("gh auth status 2>&1", { encoding: "utf-8" });
      if (ghStatus.includes("Logged in")) {
        memoryBlock +=
          "\n## GitHub Integration\n" +
          "GitHub CLI (gh) is authenticated. You can use `gh` commands for PRs, issues, checks, etc.\n";
      }
    } catch {}

    return { systemPrompt: event.systemPrompt + memoryBlock };
  });

  // ─── Tool: load_repo_context ───
  pi.registerTool({
    name: "load_repo_context",
    label: "Load Repo Context",
    description:
      "Load the memory file for specific repositories before starting implementation.",
    parameters: Type.Object({
      repos: Type.Array(Type.String(), {
        description:
          'Repository names (e.g. ["my-backend", "my-frontend"])',
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { repos } = params as { repos: string[] };
      const results: string[] = [];
      for (const repo of repos) {
        const content = readMemoryFile(ctx.cwd, `memory/repos/${repo}.md`);
        if (content) {
          results.push(`# Memory: ${repo}\n\n${content}`);
        } else {
          results.push(
            `# Memory: ${repo}\n\nNo memory file found. Run /onboard to populate.`
          );
        }
      }
      return {
        content: [{ type: "text", text: results.join("\n\n---\n\n") }],
        details: { repos },
      };
    },
  });

  // ─── Tool: search_memory ───
  pi.registerTool({
    name: "search_memory",
    label: "Search Memory",
    description:
      "Search across ALL memory files (DIRECTIVES, ARCHITECTURE, and all repo files) for a keyword or phrase. " +
      "Returns matching lines with context. Useful for finding how other repos handle similar problems " +
      "without loading each repo's memory individually.",
    parameters: Type.Object({
      query: Type.String({
        description: "Search term or phrase (case-insensitive)",
      }),
      context_lines: Type.Optional(
        Type.Number({
          description:
            "Number of context lines around each match (default: 2)",
        })
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { query, context_lines = 2 } = params as {
        query: string;
        context_lines?: number;
      };

      const memoryDir = join(ctx.cwd, "memory");
      const files = [
        { path: "DIRECTIVES.md", label: "DIRECTIVES" },
        { path: "ARCHITECTURE.md", label: "ARCHITECTURE" },
      ];

      const reposDir = join(memoryDir, "repos");
      if (existsSync(reposDir)) {
        for (const f of readdirSync(reposDir)) {
          if (f.endsWith(".md")) {
            files.push({
              path: join("repos", f),
              label: f.replace(".md", ""),
            });
          }
        }
      }

      const queryLower = query.toLowerCase();
      const results: string[] = [];
      let totalMatches = 0;

      for (const file of files) {
        const content = readMemoryFile(ctx.cwd, join("memory", file.path));
        if (!content) continue;

        const lines = content.split("\n");
        const matchIndices: number[] = [];

        for (let i = 0; i < lines.length; i++) {
          if (lines[i].toLowerCase().includes(queryLower)) {
            matchIndices.push(i);
          }
        }

        if (matchIndices.length === 0) continue;
        totalMatches += matchIndices.length;

        const snippets: string[] = [];
        const ranges: Array<[number, number]> = [];
        for (const idx of matchIndices) {
          const start = Math.max(0, idx - context_lines);
          const end = Math.min(lines.length - 1, idx + context_lines);
          if (ranges.length > 0 && start <= ranges[ranges.length - 1][1] + 1) {
            ranges[ranges.length - 1][1] = end;
          } else {
            ranges.push([start, end]);
          }
        }

        for (const [start, end] of ranges) {
          const snippet = lines
            .slice(start, end + 1)
            .map((line, i) => {
              const lineNum = start + i;
              const isMatch = matchIndices.includes(lineNum);
              return `${isMatch ? ">>>" : "   "} ${line}`;
            })
            .join("\n");
          snippets.push(snippet);
        }

        results.push(
          `### ${file.label} (${matchIndices.length} match${matchIndices.length > 1 ? "es" : ""})\n\n${snippets.join("\n...\n")}`
        );
      }

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No matches found for "${query}" across ${files.length} memory files.`,
            },
          ],
          details: { query, matches: 0 },
        };
      }

      const header = `Found ${totalMatches} match${totalMatches > 1 ? "es" : ""} for "${query}" across ${results.length} file${results.length > 1 ? "s" : ""}:\n\n`;
      return {
        content: [{ type: "text", text: header + results.join("\n\n---\n\n") }],
        details: { query, matches: totalMatches, files: results.length },
      };
    },
  });

  // ─── Tool: jira_ticket ───
  pi.registerTool({
    name: "jira_ticket",
    label: "Jira Ticket",
    description:
      "Fetch a Jira ticket by ID. Returns summary, description, acceptance criteria, status, metadata.",
    parameters: Type.Object({
      ticketId: Type.String({
        description: "Jira ticket ID (e.g. PROJ-123)",
      }),
      includeComments: Type.Optional(
        Type.Boolean({ description: "Also fetch comments (default: false)" })
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { ticketId, includeComments } = params as {
        ticketId: string;
        includeComments?: boolean;
      };
      const auth = loadJiraAuth();
      if (!auth)
        return {
          content: [
            { type: "text", text: "Jira not configured. Run /jira-login." },
          ],
          details: {},
        };

      const { ok, status, data } = await jiraFetch(
        auth,
        `issue/${ticketId}?fields=summary,description,status,issuetype,priority,` +
          `assignee,reporter,labels,components,fixVersions,parent,` +
          `customfield_10035,customfield_10036,customfield_10028`
      );
      if (!ok)
        return {
          content: [
            {
              type: "text",
              text: `Failed to fetch ${ticketId}: HTTP ${status} — ${data?.errorMessages?.join(", ") || "Unknown error"}`,
            },
          ],
          details: {},
        };

      let result = formatTicket(data);

      if (includeComments) {
        const commentsRes = await jiraFetch(
          auth,
          `issue/${ticketId}/comment?orderBy=-created&maxResults=10`
        );
        if (commentsRes.ok && commentsRes.data.comments?.length > 0) {
          result += "\n## Comments (latest 10)\n\n";
          for (const comment of commentsRes.data.comments) {
            const author = comment.author?.displayName || "Unknown";
            const date = comment.created?.slice(0, 10) || "";
            const body = adfToText(comment.body).trim();
            result += `**${author}** (${date}):\n${body}\n\n---\n\n`;
          }
        }
      }
      return {
        content: [{ type: "text", text: result }],
        details: { ticketId },
      };
    },
  });

  // ─── Tool: jira_sprint ───
  pi.registerTool({
    name: "jira_sprint",
    label: "Jira Sprint",
    description:
      "Fetch tickets from a Jira sprint. Can get the active or next upcoming sprint for a board. " +
      "Returns all tickets with their summary, status, type, and assignee.",
    parameters: Type.Object({
      boardId: Type.Number({ description: "Jira board ID" }),
      sprint: Type.Optional(
        Type.String({
          description:
            'Which sprint: "active" (default), "next" (first future sprint), or a sprint ID number',
        })
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { boardId, sprint = "active" } = params as {
        boardId: number;
        sprint?: string;
      };
      const auth = loadJiraAuth();
      if (!auth)
        return {
          content: [
            { type: "text", text: "Jira not configured. Run /jira-login." },
          ],
          details: {},
        };

      let sprintId: number;
      let sprintName: string;

      if (/^\d+$/.test(sprint)) {
        sprintId = parseInt(sprint, 10);
        sprintName = `Sprint #${sprintId}`;
      } else {
        const state = sprint === "next" ? "future" : "active";
        const sprintsRes = await jiraAgileGet(
          auth,
          `board/${boardId}/sprint?state=${state}&maxResults=5`
        );
        if (!sprintsRes.ok || !sprintsRes.data.values?.length) {
          return {
            content: [
              {
                type: "text",
                text: `No ${state} sprint found for board ${boardId}. Error: ${JSON.stringify(sprintsRes.data?.errorMessages || sprintsRes.status)}`,
              },
            ],
            details: {},
          };
        }
        const target = sprintsRes.data.values[0];
        sprintId = target.id;
        sprintName = target.name;
      }

      const issuesRes = await jiraAgileGet(
        auth,
        `sprint/${sprintId}/issue?maxResults=50&fields=summary,status,issuetype,priority,assignee,labels,storyPoints,customfield_10028`
      );
      if (!issuesRes.ok) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to fetch sprint issues: ${JSON.stringify(issuesRes.data?.errorMessages || issuesRes.status)}`,
            },
          ],
          details: {},
        };
      }

      const issues = issuesRes.data.issues || [];
      let result = `# Sprint: ${sprintName}\n\n`;
      result += `**Total tickets:** ${issues.length}\n\n`;

      result += "| Key | Type | Summary | Status | Assignee | Priority |\n";
      result += "|-----|------|---------|--------|----------|----------|\n";
      for (const issue of issues) {
        const f = issue.fields;
        result += `| ${issue.key} | ${f.issuetype?.name || ""} | ${f.summary} | ${f.status?.name || ""} | ${f.assignee?.displayName || "—"} | ${f.priority?.name || ""} |\n`;
      }

      return {
        content: [{ type: "text", text: result }],
        details: { sprintId, sprintName, ticketCount: issues.length },
      };
    },
  });

  // ─── Session start ───
  pi.on("session_start", async (_event, ctx) => {
    const parts: string[] = [];
    const project = loadProjectConfig(ctx.cwd);
    if (project?.project?.name) {
      parts.push(`wyebot loaded — ${project.project.name}.`);
    } else {
      parts.push("wyebot loaded. Run /onboard to configure your project.");
    }
    const jiraAuth = loadJiraAuth();
    if (jiraAuth) parts.push(`Jira: ${jiraAuth.baseUrl}`);
    try {
      const { execSync } = await import("child_process");
      const ghStatus = execSync("gh auth status 2>&1", { encoding: "utf-8" });
      if (ghStatus.includes("Logged in")) parts.push("GitHub: connected");
    } catch {}
    ctx.ui.notify(parts.join(" "), "info");
  });

  // ─── Memory update reminder ───
  pi.on("agent_end", async (_event, ctx) => {
    const entries = ctx.sessionManager.getBranch();
    const recentMessages = entries.slice(-10);

    const reminderText = "You've made code changes during this session";
    const hasRecentMemoryReminder = recentMessages.some((entry) => {
      if (entry.type !== "message" || entry.message.role !== "user")
        return false;
      const content = entry.message.content;
      if (typeof content === "string") return content.includes(reminderText);
      if (Array.isArray(content)) {
        return content.some(
          (c: any) => c.type === "text" && c.text?.includes(reminderText)
        );
      }
      return false;
    });

    if (hasRecentMemoryReminder) return;

    const hasRecentCodeEdits = recentMessages.some(
      (entry) =>
        entry.type === "message" &&
        entry.message.role === "toolResult" &&
        (entry.message.toolName === "write" ||
          entry.message.toolName === "edit") &&
        entry.message.content?.some(
          (c: any) =>
            c.type === "text" &&
            !c.text.includes("memory/DIRECTIVES.md") &&
            !c.text.includes("memory/ARCHITECTURE.md") &&
            !c.text.includes("memory/repos/")
        )
    );

    if (hasRecentCodeEdits) {
      pi.sendUserMessage(
        "You've made code changes during this session. Before finishing, check if you learned " +
          "something new about the codebase (new patterns, conventions, gotchas, or architecture). " +
          "If so, update the relevant memory files (memory/DIRECTIVES.md, memory/ARCHITECTURE.md, " +
          "or memory/repos/<repo>.md) using topic-based upsert — find the matching ### topic and " +
          "update in-place. If nothing new was learned, just say so briefly.",
        { deliverAs: "followUp" }
      );
    }
  });

  // ─── Compaction recovery ───
  pi.on("session_compact", async (_event, ctx) => {
    pi.sendMessage(
      {
        customType: "wyebot-compaction-recovery",
        content:
          "⚠️ **Context was compacted.** Your project memory (DIRECTIVES.md, ARCHITECTURE.md) " +
          "has been re-loaded in the system prompt. Before continuing:\n" +
          "1. Review the compaction summary above to understand what was accomplished.\n" +
          "2. If you were working on a specific repo, call `load_repo_context` to reload its memory.\n" +
          "3. If significant work was completed before compaction, update the relevant memory files " +
          "with any new learnings (use topic-based upsert — find the matching `###` topic and update in-place).",
        display: true,
      },
      { deliverAs: "nextTurn" }
    );
  });

  // ─── Commands ───

  pi.registerCommand("setup", {
    description:
      "Initial setup: choose AI provider, authenticate, connect services, onboard project",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Welcome to wyebot setup!", "info");

      // Step 1: Choose provider
      const provider = await ctx.ui.select(
        "Step 1 — Choose your AI provider:",
        [
          "anthropic — Claude (Recommended)",
          "openai — GPT",
          "google-vertex — Gemini",
        ]
      );
      if (!provider) {
        ctx.ui.notify("Setup cancelled.", "warning");
        return;
      }

      const providerId = provider.split(" — ")[0];

      const modelOptions: Record<string, string[]> = {
        anthropic: [
          "claude-opus-4-6 (Most capable)",
          "claude-sonnet-4-5-20250929 (Fast + capable)",
          "claude-haiku-4-5-20251001 (Fastest)",
        ],
        openai: [
          "gpt-4o (Most capable)",
          "o3 (Reasoning)",
          "gpt-4o-mini (Fastest)",
        ],
        "google-vertex": [
          "gemini-3-pro-preview (Most capable)",
          "gemini-2.5-pro (Balanced)",
          "gemini-2.5-flash (Fastest)",
        ],
      };

      const models = modelOptions[providerId] || [];
      const modelChoice = await ctx.ui.select(
        `Select model for ${providerId}:`,
        models
      );
      if (!modelChoice) {
        ctx.ui.notify("Setup cancelled.", "warning");
        return;
      }
      const model = modelChoice.split(" (")[0];

      const settingsPath = join(ctx.cwd, ".pi", "settings.json");
      if (existsSync(settingsPath)) {
        const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
        settings.defaultProvider = providerId;
        settings.defaultModel = model;
        writeFileSync(
          settingsPath,
          JSON.stringify(settings, null, 2) + "\n",
          "utf-8"
        );
        ctx.ui.notify(`Provider set to ${providerId} / ${model}`, "info");
      }

      // Step 2: Authenticate with provider
      if (providerId === "anthropic") {
        ctx.ui.notify(
          "Step 2 — Authenticate with Anthropic.\n" +
            "Run /login to open OAuth in your browser.",
          "info"
        );
      } else if (providerId === "openai") {
        ctx.ui.notify(
          "Step 2 — Set your OpenAI API key.\n" +
            "Run in your terminal: export OPENAI_API_KEY=sk-...\n" +
            "Add it to your shell profile (~/.zshrc or ~/.bashrc) to persist it.",
          "info"
        );
      } else if (providerId === "google-vertex") {
        ctx.ui.notify(
          "Step 2 — Authenticate with Google Cloud.\n" +
            "Run in your terminal: gcloud auth application-default login",
          "info"
        );
      }

      // Step 3: Optional services
      const services = await ctx.ui.select(
        "Step 3 — Connect additional services?",
        [
          "Connect Jira + GitHub",
          "Connect Jira only",
          "Connect GitHub only",
          "Skip for now",
        ]
      );

      if (services && services.includes("Jira") && !services.includes("only")) {
        ctx.ui.notify(
          "Run /jira-login and /github-login to connect.",
          "info"
        );
      } else if (services?.includes("Jira only")) {
        ctx.ui.notify("Run /jira-login to connect Jira.", "info");
      } else if (services?.includes("GitHub only")) {
        ctx.ui.notify("Run /github-login to connect GitHub.", "info");
      }

      // Step 4: Onboard
      const onboard = await ctx.ui.select(
        "Step 4 — Onboard your project?",
        [
          "Yes — scan my repos and configure the agent now",
          "Later — I'll run /onboard when ready",
        ]
      );

      if (onboard?.startsWith("Yes")) {
        pi.sendUserMessage("/skill:onboard", { deliverAs: "followUp" });
      } else {
        ctx.ui.notify(
          "Setup complete! Run /onboard when you're ready to configure your project.\n" +
            "Restart the agent for provider changes to take effect.",
          "info"
        );
      }
    },
  });

  pi.registerCommand("jira-login", {
    description: "Configure Jira authentication",
    handler: async (_args, ctx) => {
      const url = await ctx.ui.input(
        "Jira instance URL:",
        "https://yourteam.atlassian.net"
      );
      if (!url) {
        ctx.ui.notify("Cancelled.", "warning");
        return;
      }

      let baseUrl = url.trim().replace(/\/+$/, "");
      if (!baseUrl.startsWith("http://") && !baseUrl.startsWith("https://")) {
        baseUrl = "https://" + baseUrl;
      }

      const email = await ctx.ui.input("Jira email:");
      if (!email) {
        ctx.ui.notify("Cancelled.", "warning");
        return;
      }
      const token = await ctx.ui.input(
        "API token (from id.atlassian.com):"
      );
      if (!token) {
        ctx.ui.notify("Cancelled.", "warning");
        return;
      }

      const auth: JiraAuth = {
        baseUrl,
        email: email.trim(),
        apiToken: token.trim(),
      };
      try {
        const { ok, status } = await jiraFetch(auth, "myself");
        if (!ok) {
          ctx.ui.notify(`Auth failed (HTTP ${status}).`, "error");
          return;
        }
      } catch (err: any) {
        ctx.ui.notify(`Connection failed: ${err.message}`, "error");
        return;
      }

      saveJiraAuth(auth);
      ctx.ui.notify(`Jira connected! Saved to ${JIRA_AUTH_PATH}`, "info");
    },
  });

  pi.registerCommand("github-login", {
    description: "Setup GitHub CLI authentication",
    handler: async (_args, ctx) => {
      try {
        const { execSync } = await import("child_process");
        execSync("which gh", { stdio: "ignore" });
      } catch {
        ctx.ui.notify(
          "GitHub CLI (gh) is not installed. Install it from https://cli.github.com/",
          "error"
        );
        return;
      }

      try {
        const { execSync } = await import("child_process");
        const status = execSync("gh auth status 2>&1", { encoding: "utf-8" });
        const alreadyLogged = status.includes("Logged in");
        if (alreadyLogged) {
          const reauth = await ctx.ui.select(
            "GitHub CLI is already authenticated. What do you want to do?",
            [
              "Keep current session",
              "Re-authenticate (run gh auth login again)",
            ]
          );
          if (!reauth || reauth.startsWith("Keep")) {
            ctx.ui.notify("GitHub: already connected.", "info");
            return;
          }
        }
      } catch {}

      ctx.ui.notify(
        "Opening GitHub authentication in your browser...\n" +
          "Run this in your terminal: gh auth login\n" +
          "Select: GitHub.com → HTTPS → Login with a web browser",
        "info"
      );

      try {
        const { execSync } = await import("child_process");
        execSync("gh auth login -h github.com -p https -w", {
          stdio: "inherit",
          timeout: 120_000,
        });
        ctx.ui.notify("GitHub connected!", "info");
      } catch (err: any) {
        ctx.ui.notify(
          "Automatic login failed. Run 'gh auth login' manually in your terminal, then come back.",
          "warning"
        );
      }
    },
  });

  pi.registerCommand("github-logout", {
    description: "Logout from GitHub CLI",
    handler: async (_args, ctx) => {
      try {
        const { execSync } = await import("child_process");
        execSync("gh auth logout -h github.com", {
          stdio: "inherit",
          timeout: 10_000,
        });
        ctx.ui.notify("GitHub: logged out.", "info");
      } catch {
        ctx.ui.notify(
          "No active GitHub session or gh not installed.",
          "info"
        );
      }
    },
  });

  pi.registerCommand("jira-logout", {
    description: "Remove stored Jira credentials",
    handler: async (_args, ctx) => {
      if (existsSync(JIRA_AUTH_PATH)) {
        const { unlinkSync } = await import("fs");
        unlinkSync(JIRA_AUTH_PATH);
        ctx.ui.notify("Jira credentials removed.", "info");
      } else ctx.ui.notify("No Jira credentials found.", "info");
    },
  });

  pi.registerCommand("onboard", {
    description:
      "Scan your project repos, detect stack and conventions, and configure the agent",
    handler: async (args, ctx) => {
      const project = loadProjectConfig(ctx.cwd);
      const hasExistingConfig =
        project?.repos && project.repos.length > 0;

      if (hasExistingConfig) {
        const mode = await ctx.ui.select(
          "Project is already configured. What do you want to do?",
          [
            "Full reset — re-scan everything from scratch",
            "Complement — keep existing config, add/update with new findings",
            "Cancel",
          ]
        );
        if (!mode || mode === "Cancel") {
          ctx.ui.notify("Cancelled.", "warning");
          return;
        }
        const isReset = mode.startsWith("Full reset");
        pi.sendUserMessage(
          `/skill:onboard\n\nMode: ${isReset ? "reset" : "complement"}`,
          { deliverAs: "followUp" }
        );
      } else {
        pi.sendUserMessage("/skill:onboard\n\nMode: fresh", {
          deliverAs: "followUp",
        });
      }
    },
  });

  pi.registerCommand("ticket", {
    description:
      "Start working on a ticket. Accepts Jira ID or description",
    handler: async (args, ctx) => {
      if (args && args.trim()) {
        const input = args.trim();
        const jiraPattern = /^[A-Z][A-Z0-9]+-\d+$/;
        if (jiraPattern.test(input) && loadJiraAuth()) {
          pi.sendUserMessage(
            `/skill:ticket\n\nFetch Jira ticket ${input} using the jira_ticket tool, then proceed with the workflow.`,
            { deliverAs: "followUp" }
          );
        } else {
          pi.sendUserMessage(`/skill:ticket\n\nTicket: ${input}`, {
            deliverAs: "followUp",
          });
        }
      } else {
        pi.sendUserMessage("/skill:ticket", { deliverAs: "followUp" });
      }
    },
  });

  pi.registerCommand("pr-desc", {
    description: "Generate a PR description for the current branch",
    handler: async (args, ctx) => {
      if (args && args.trim()) {
        pi.sendUserMessage(
          `/skill:pr-description\n\nRepo: ${args.trim()}`,
          { deliverAs: "followUp" }
        );
      } else {
        pi.sendUserMessage("/skill:pr-description", {
          deliverAs: "followUp",
        });
      }
    },
  });

  pi.registerCommand("learn", {
    description: "Review recent changes and update memory files",
    handler: async (args, ctx) => {
      if (args && args.trim()) {
        pi.sendUserMessage(`/skill:learn\n\nRepo: ${args.trim()}`, {
          deliverAs: "followUp",
        });
      } else {
        pi.sendUserMessage("/skill:learn", { deliverAs: "followUp" });
      }
    },
  });

  pi.registerCommand("sprint-notes", {
    description: "Generate sprint notes from Jira sprint tickets",
    handler: async (args, ctx) => {
      const project = loadProjectConfig(ctx.cwd);
      const boardId = project?.jira?.board_id;
      if (!boardId) {
        ctx.ui.notify(
          "Jira board ID not configured. Set `jira.board_id` in project.yml or run /onboard.",
          "warning"
        );
        pi.sendUserMessage(
          `/skill:sprint-notes\n\n${args?.trim() || ""}`.trim(),
          { deliverAs: "followUp" }
        );
        return;
      }
      pi.sendUserMessage(
        `/skill:sprint-notes\n\nBoard ID: ${boardId}. Sprint: next. ${args?.trim() || ""}`.trim(),
        { deliverAs: "followUp" }
      );
    },
  });

  pi.registerCommand("release-notes", {
    description:
      "Generate release notes from the latest tags in configured repos",
    handler: async (args, ctx) => {
      pi.sendUserMessage(
        `/skill:release-notes\n\n${args?.trim() || ""}`.trim(),
        { deliverAs: "followUp" }
      );
    },
  });

  pi.registerCommand("change-provider", {
    description: "Change the AI provider and model",
    handler: async (_args, ctx) => {
      const provider = await ctx.ui.select("Select AI provider:", [
        "anthropic — Claude (Opus, Sonnet)",
        "openai — GPT (GPT-4o, o3)",
        "google-vertex — Gemini",
      ]);
      if (!provider) {
        ctx.ui.notify("Cancelled.", "warning");
        return;
      }

      const providerId = provider.split(" — ")[0];

      const modelOptions: Record<string, string[]> = {
        anthropic: [
          "claude-opus-4-6",
          "claude-sonnet-4-5-20250929",
          "claude-haiku-4-5-20251001",
        ],
        openai: ["gpt-4o", "o3", "gpt-4o-mini"],
        "google-vertex": [
          "gemini-3-pro-preview",
          "gemini-2.5-pro",
          "gemini-2.5-flash",
        ],
      };

      const models = modelOptions[providerId] || [];
      const model = await ctx.ui.select(
        `Select model for ${providerId}:`,
        models
      );
      if (!model) {
        ctx.ui.notify("Cancelled.", "warning");
        return;
      }

      const settingsPath = join(ctx.cwd, ".pi", "settings.json");
      if (!existsSync(settingsPath)) {
        ctx.ui.notify("Settings file not found.", "error");
        return;
      }

      const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      settings.defaultProvider = providerId;
      settings.defaultModel = model;
      writeFileSync(
        settingsPath,
        JSON.stringify(settings, null, 2) + "\n",
        "utf-8"
      );

      ctx.ui.notify(
        `Provider changed to ${providerId} / ${model}.\n` +
          "Restart the agent for changes to take effect.",
        "info"
      );
    },
  });

  pi.registerCommand("memory", {
    description: "Show status of memory files",
    handler: async (_args, ctx) => {
      pi.sendUserMessage(
        "List all files in the memory/ directory with their last modification dates. " +
          "Show a brief summary of what's documented. Use `ls -la memory/ memory/repos/`.",
        { deliverAs: "followUp" }
      );
    },
  });
}
