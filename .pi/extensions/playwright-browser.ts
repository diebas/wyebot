/**
 * Browser Automation Extension for Pi
 *
 * Provides a headless browser tool powered by Playwright.
 * Auto-detects Playwright installation and offers setup if missing.
 *
 * Features:
 *   - goto: Navigate to a URL
 *   - screenshot: Take a screenshot (returns as image attachment)
 *   - click: Click an element by CSS selector or text
 *   - fill: Type text into an input by CSS selector
 *   - select: Select an option from a dropdown
 *   - html: Get page HTML content
 *   - evaluate: Run arbitrary JS in the page context
 *   - wait: Wait for a selector to appear
 *
 * Commands:
 *   /browser-setup  — Check & install Playwright + browsers
 *   /browser-reset  — Close current browser session and start fresh
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { existsSync, readFileSync } from "fs";

export default function (pi: ExtensionAPI) {
  let browser: any = null;
  let context: any = null;
  let page: any = null;
  let pw: any = null;
  let playwrightAvailable: boolean | null = null;

  // ─── Helpers ───

  function checkPlaywrightInstalled(): boolean {
    if (playwrightAvailable !== null) return playwrightAvailable;
    try {
      require.resolve("playwright");
      playwrightAvailable = true;
    } catch {
      playwrightAvailable = false;
    }
    return playwrightAvailable;
  }

  async function ensureBrowser() {
    if (!checkPlaywrightInstalled()) {
      throw new Error(
        "Playwright is not installed. Run /browser-setup to install it.\n" +
        "Or manually: npm install -g playwright && npx playwright install chromium"
      );
    }

    if (!pw) {
      pw = require("playwright");
    }
    if (!browser) {
      browser = await pw.chromium.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      });
      context = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      });
      page = await context.newPage();

      // Set a default timeout for all operations
      page.setDefaultTimeout(10000);
    }
    return page;
  }

  async function closeBrowser() {
    if (browser) {
      try { await browser.close(); } catch {}
      browser = null;
      context = null;
      page = null;
    }
  }

  // ─── Lifecycle ───

  pi.on("session_shutdown", async () => {
    await closeBrowser();
  });

  pi.on("session_start", async (_event, ctx) => {
    const installed = checkPlaywrightInstalled();
    if (!installed) {
      ctx.ui.notify(
        "⚠️ Browser tool: Playwright not found. Run /browser-setup to install.",
        "warning"
      );
    }
  });

  // ─── Commands ───

  pi.registerCommand("browser-setup", {
    description: "Check and install browser automation tools (Playwright)",
    handler: async (_args, ctx) => {
      // Step 1: Check current status
      const installed = checkPlaywrightInstalled();

      if (installed) {
        // Check which browsers are available
        const { execSync } = await import("child_process");
        let version = "unknown";
        try {
          version = execSync("npx playwright --version 2>/dev/null", { encoding: "utf-8" }).trim();
        } catch {}

        const reinstall = await ctx.ui.select(
          `✅ Playwright ${version} is already installed. What do you want to do?`,
          [
            "Keep current installation",
            "Reinstall browsers (Chromium, Firefox, WebKit)",
            "Install only Chromium (lightweight)",
            "Update Playwright to latest version",
          ]
        );

        if (!reinstall || reinstall.startsWith("Keep")) {
          ctx.ui.notify("Browser setup is good to go! 🎉", "info");
          return;
        }

        if (reinstall.includes("Update")) {
          ctx.ui.notify("Updating Playwright...", "info");
          try {
            execSync("npm install -g playwright@latest", { encoding: "utf-8", stdio: "pipe" });
            execSync("npx playwright install chromium", { encoding: "utf-8", stdio: "pipe" });
            playwrightAvailable = null; // Reset cache
            ctx.ui.notify("Playwright updated! ✅", "info");
          } catch (err: any) {
            ctx.ui.notify(`Update failed: ${err.message}`, "error");
          }
          return;
        }

        if (reinstall.includes("only Chromium")) {
          ctx.ui.notify("Installing Chromium...", "info");
          try {
            execSync("npx playwright install chromium", { encoding: "utf-8", stdio: "pipe" });
            ctx.ui.notify("Chromium installed! ✅", "info");
          } catch (err: any) {
            ctx.ui.notify(`Install failed: ${err.message}`, "error");
          }
          return;
        }

        // Reinstall all browsers
        ctx.ui.notify("Installing all browsers...", "info");
        try {
          execSync("npx playwright install", { encoding: "utf-8", stdio: "pipe" });
          ctx.ui.notify("All browsers installed! ✅", "info");
        } catch (err: any) {
          ctx.ui.notify(`Install failed: ${err.message}`, "error");
        }
        return;
      }

      // Not installed — offer installation options
      const choice = await ctx.ui.select(
        "🔧 Playwright is not installed. How would you like to set it up?",
        [
          "Install Playwright with Chromium only (recommended, ~120MB)",
          "Install Playwright with all browsers (Chromium + Firefox + WebKit, ~400MB)",
          "Cancel",
        ]
      );

      if (!choice || choice === "Cancel") {
        ctx.ui.notify("Setup cancelled.", "info");
        return;
      }

      ctx.ui.notify("Installing Playwright... This may take a minute.", "info");

      try {
        const { execSync } = await import("child_process");

        // Install playwright package
        execSync("npm install -g playwright", {
          encoding: "utf-8",
          stdio: "pipe",
          timeout: 120_000,
        });

        // Install browsers
        if (choice.includes("all browsers")) {
          execSync("npx playwright install", {
            encoding: "utf-8",
            stdio: "pipe",
            timeout: 300_000,
          });
        } else {
          execSync("npx playwright install chromium", {
            encoding: "utf-8",
            stdio: "pipe",
            timeout: 120_000,
          });
        }

        playwrightAvailable = null; // Reset cache
        ctx.ui.notify(
          "✅ Playwright installed successfully!\n" +
          "The `browser` tool is now available. Try it with:\n" +
          "  \"Navigate to https://example.com and take a screenshot\"",
          "info"
        );
      } catch (err: any) {
        ctx.ui.notify(
          `❌ Installation failed: ${err.message}\n` +
          "Try manually:\n" +
          "  npm install -g playwright\n" +
          "  npx playwright install chromium",
          "error"
        );
      }
    },
  });

  pi.registerCommand("browser-reset", {
    description: "Close current browser session and start fresh",
    handler: async (_args, ctx) => {
      await closeBrowser();
      ctx.ui.notify("Browser session closed. A new browser will start on next use.", "info");
    },
  });

  // ─── Browser Tool ───

  pi.registerTool({
    name: "browser",
    label: "Browser",
    description:
      "Control a headless browser for testing and verification. " +
      "Actions: goto (navigate), screenshot (capture page as image), click (click element), " +
      "fill (type into input), select (pick dropdown option), html (get page source), " +
      "evaluate (run JS), wait (wait for selector).",
    parameters: Type.Object({
      action: StringEnum([
        "goto", "screenshot", "click", "fill", "select",
        "html", "evaluate", "wait",
      ] as const),
      url: Type.Optional(
        Type.String({ description: "URL to navigate to (for goto)" })
      ),
      selector: Type.Optional(
        Type.String({ description: "CSS selector (for click/fill/select/wait)" })
      ),
      text: Type.Optional(
        Type.String({
          description: "Text to type (for fill), option value/label (for select), or JS code (for evaluate)",
        })
      ),
      path: Type.Optional(
        Type.String({
          description: "Screenshot save path (for screenshot, defaults to /tmp/screenshot.png)",
        })
      ),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      try {
        const p = await ensureBrowser();

        switch (params.action) {
          case "goto": {
            if (!params.url)
              return { content: [{ type: "text", text: "Error: url is required for goto" }] };
            // Try networkidle first, fall back to load
            await p
              .goto(params.url, { waitUntil: "networkidle", timeout: 15000 })
              .catch(() => p.goto(params.url!, { waitUntil: "load", timeout: 15000 }));
            const title = await p.title();
            const url = p.url();
            return {
              content: [
                {
                  type: "text",
                  text: `Navigated to ${url}\nTitle: "${title}"`,
                },
              ],
            };
          }

          case "screenshot": {
            const savePath = params.path || "/tmp/screenshot.png";
            await p.screenshot({ path: savePath, fullPage: false });

            // Return image as attachment so the model can see it
            // Pi's internal image format uses { type: "image", data, mimeType }
            // NOT the Anthropic API format { type: "image", source: { ... } }
            try {
              const imgBuffer = readFileSync(savePath);
              const base64 = imgBuffer.toString("base64");
              return {
                content: [
                  {
                    type: "image",
                    data: base64,
                    mimeType: "image/png",
                  } as any,
                  {
                    type: "text",
                    text: `Screenshot saved to ${savePath}`,
                  },
                ],
              };
            } catch {
              return {
                content: [{ type: "text", text: `Screenshot saved to ${savePath} (could not attach as image)` }],
              };
            }
          }

          case "click": {
            if (!params.selector)
              return { content: [{ type: "text", text: "Error: selector is required for click" }] };

            // Try CSS selector first, then try text-based selector
            try {
              await p.click(params.selector, { timeout: 5000 });
            } catch {
              // Try as text content
              await p.click(`text="${params.selector}"`, { timeout: 5000 });
            }
            // Wait a bit for any navigation/JS to settle
            await p.waitForTimeout(500);
            return {
              content: [
                { type: "text", text: `Clicked: ${params.selector}\nCurrent URL: ${p.url()}` },
              ],
            };
          }

          case "fill": {
            if (!params.selector || params.text === undefined)
              return {
                content: [{ type: "text", text: "Error: selector and text are required for fill" }],
              };
            // Clear field first, then fill
            await p.fill(params.selector, "", { timeout: 5000 });
            await p.fill(params.selector, params.text, { timeout: 5000 });
            return {
              content: [
                { type: "text", text: `Filled "${params.selector}" with "${params.text}"` },
              ],
            };
          }

          case "select": {
            if (!params.selector || !params.text)
              return {
                content: [
                  { type: "text", text: "Error: selector and text (option value or label) are required for select" },
                ],
              };
            // Try by value first, then by label
            try {
              await p.selectOption(params.selector, { value: params.text }, { timeout: 5000 });
            } catch {
              await p.selectOption(params.selector, { label: params.text }, { timeout: 5000 });
            }
            return {
              content: [
                { type: "text", text: `Selected "${params.text}" in "${params.selector}"` },
              ],
            };
          }

          case "html": {
            const html = await p.content();
            // Truncate to avoid overwhelming context
            const truncated =
              html.length > 30000
                ? html.substring(0, 30000) + "\n... [truncated at 30KB]"
                : html;
            return { content: [{ type: "text", text: truncated }] };
          }

          case "evaluate": {
            if (!params.text)
              return {
                content: [{ type: "text", text: "Error: text (JS code) is required for evaluate" }],
              };
            const result = await p.evaluate(params.text);
            const output =
              typeof result === "object" ? JSON.stringify(result, null, 2) : String(result);
            return { content: [{ type: "text", text: `Result: ${output}` }] };
          }

          case "wait": {
            if (!params.selector)
              return {
                content: [{ type: "text", text: "Error: selector is required for wait" }],
              };
            await p.waitForSelector(params.selector, { timeout: 10000 });
            return {
              content: [
                { type: "text", text: `Element found: ${params.selector}` },
              ],
            };
          }

          default:
            return {
              content: [{ type: "text", text: `Unknown action: ${params.action}` }],
            };
        }
      } catch (err: any) {
        return {
          content: [
            {
              type: "text",
              text: `Browser error: ${err.message}\n\nTip: If the browser crashed, use /browser-reset to start a new session.`,
            },
          ],
        };
      }
    },
  });
}
