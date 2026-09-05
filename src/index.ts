#!/usr/bin/env node
import { Command } from "commander";

import { loadConfig } from "./config.js";
import { GitHubClient } from "./github.js";
import { orchestrate } from "./orchestrator.js";

const programRunner = new Command();

programRunner
  .name("pr-review-bot")
  .description("Auto-review GitHub PRs: AI review + lint + security + conventional checks")
  .version("1.0.0");

programRunner
  .command("run")
  .description("Review a PR (in Actions: uses env vars; locally: --owner/--repo/--pr)")
  .option("-o, --owner <owner>", "Repository owner")
  .option("-r, --repo <repo>", "Repository name")
  .option("-p, --pr <number>", "PR number")
  .option("-t, --token <token>", "GitHub token (or GITHUB_TOKEN)")
  .option("-d, --dir <dir>", "Working directory for lint/audit (default: cwd)")
  .option("-c, --config <json>", 'Inline JSON config (overrides BOT_CONFIG env)')
  .option("--ollama [model]", "Use local Korean model via Ollama (default: exaone3.5:2.4b)")
  .option("--no-post", "Do not post comments/reviews to GitHub; just print report")
  .action(async (opts) => {
    await run(opts);
  });

programRunner
  .command("init")
  .description("Print a sample config.json")
  .action(() => {
    console.log(sampleConfig());
  });

async function run(opts: {
  owner?: string;
  repo?: string;
  pr?: string;
  token?: string;
  dir?: string;
  config?: string;
  ollama?: string | boolean;
  post: boolean;
}) {
  // Merge config override.
  if (opts.config) {
    process.env.BOT_CONFIG = opts.config;
  }
  // --ollama shortcut: use the local Korean model, no API key needed.
  if (opts.ollama !== undefined) {
    const model =
      typeof opts.ollama === "string" && opts.ollama.length > 0
        ? opts.ollama
        : "exaone3.5:2.4b";
    const base = process.env.BOT_CONFIG ? JSON.parse(process.env.BOT_CONFIG) : {};
    process.env.BOT_CONFIG = JSON.stringify({
      ...base,
      checks: { ...(base.checks ?? {}), ai: { ...(base.checks?.ai ?? {}), enabled: true } },
      ai: { ...(base.ai ?? {}), provider: "ollama", model, baseUrl: "http://localhost:11434" },
    });
  }

  const config = loadConfig();

  // Build connection info from CLI or env.
  const owner = opts.owner || process.env.REPO_OWNER;
  const repo = opts.repo || process.env.REPO_NAME;
  const prNumber = opts.pr ? Number(opts.pr) : Number(process.env.PR_NUMBER || "0");

  const token = opts.token || process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!owner || !repo) {
    console.error("Missing owner/repo. Use -o/-r or set REPO_OWNER/REPO_NAME.");
    process.exit(2);
  }
  if (!prNumber) {
    console.error("Missing PR number. Use -p or set PR_NUMBER.");
    process.exit(2);
  }
  if (!token) {
    console.error("Missing GitHub token. Use -t or set GITHUB_TOKEN.");
    process.exit(2);
  }

  const workingDir = opts.dir || process.cwd();

  const client = new GitHubClient({
    token,
    owner,
    repo,
    prNumber,
    apiUrl: process.env.GITHUB_API_URL,
  });

  console.log(
    `Reviewing PR ${owner}/${repo}#${prNumber} (${workingDir})...`
  );

  const result = await orchestrate({ config, client, prNumber, workingDir });

  // Print report.
  console.log("\n=== PR REVIEW SUMMARY ===");
  console.log(result.summary);
  console.log("\n=== DETAILS ===");
  const order = ["conventional", "lint", "security", "ai"];
  for (const key of order) {
    if (result.sections[key]) {
      console.log(result.sections[key]);
      console.log();
    }
  }
  console.log(`\nScore: ${result.score}`);
  console.log(`Outcome: ${result.outcome === "pass" ? "PASS" : "FAIL"}`);
  console.log(`REVIEW_OUTCOME=${result.outcome}`);
  console.log(`REVIEW_SCORE=${result.score}`);

  // Post to GitHub if allowed.
  if (opts.post !== false) {
    const pr = await client.getPullRequest(prNumber);
    await postResult(client, prNumber, pr.head.sha, result, config);
  }
}

async function postResult(
  client: GitHubClient,
  prNumber: number,
  headSha: string,
  result: Awaited<ReturnType<typeof orchestrate>>,
  config: ReturnType<typeof loadConfig>
) {
  const errs = result.findings.filter((f) => f.severity === "error");
  const hasErrors = errs.length > 0;

  let body = [
    `## 🤖 PR Review Bot Report`,
    ``,
    result.summary,
    ``,
    `**Score:** ${result.score} | **Outcome:** ${result.outcome === "pass" ? "✅ PASS" : "❌ FAIL"}`,
    ``,
  ].join("\n");

  for (const key of ["conventional", "lint", "security", "ai"] as const) {
    if (result.sections[key]) {
      body += `\n<details>\n<summary>${result.sections[key].split("\n")[0].replace(/^##\s*/, "")}</summary>\n\n${result.sections[key]}\n\n</details>\n`;
    }
  }

  // Set a commit status.
  await client.setStatus({
    headSha,
    state: hasErrors ? "failure" : "success",
    description: `PR Review Bot: ${result.outcome === "pass" ? "passed" : `failed (${errs.length} errors)`}`,
    context: "pr-review-bot/review",
  });

  // Post review comment with inline comments ONLY on lines that exist in the PR diff.
  // GitHub rejects ("Line could not be resolved") any comment on unchanged/reviewed-off code.
  const reviewable = await client.getReviewableLines(prNumber);
  const withLoc = result.findings.filter((f) => f.file && f.line);
  const inline: Array<{ path: string; line: number; body: string }> = [];
  const noLoc: string[] = [];
  for (const f of withLoc.slice(0, 50)) {
    const isValidLine = reviewable.get(f.file!)?.has(f.line!);
    const tooltip = `**[${f.severity}] ${f.rule}** — ${f.message}${f.suggestedFix ? `\n\n_Fix:_ ${f.suggestedFix}` : ""}`;
    if (isValidLine) {
      inline.push({ path: f.file!, line: f.line!, body: tooltip });
    } else {
      noLoc.push(`- ${tooltip.replace(/\n/g, " ")}`);
    }
  }
  if (noLoc.length > 0) {
    body += `\n\n<details><summary>Findings without reviewable location</summary>\n\n${noLoc.join("\n")}\n\n</details>`;
  }

  const event = hasErrors && config.approval.requestChangesOnError ? "REQUEST_CHANGES" : config.approval.approveOnPass ? "APPROVE" : "COMMENT";

  try {
    await client.postReview({
      prNumber,
      headSha,
      body: hasErrors ? `${body}\n\nReview requested changes by default.` : body,
      event,
      comments: inline,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // GitHub forbids REQUEST_CHANGES/APPROVE on your own PR -> fall back to COMMENT.
    if (/own pull request|request changes on your own/i.test(msg)) {
      await client.postReview({
        prNumber,
        headSha,
        body: `${body}\n\n(_Auto-fallback: posting as comment because GitHub doesn't allow requesting changes on your own PR._)`,
        event: "COMMENT",
        comments: inline,
      });
    } else if (/line could not be resolved/i.test(msg)) {
      // Some inline comment points at an unresolvable line; retry without inline comments.
      await client.postReview({
        prNumber,
        headSha,
        body: `${body}\n\n(_Inline comments omitted: some findings couldn't be anchored to the diff._)`,
        event: event === "APPROVE" || event === "COMMENT" ? event : "COMMENT",
      });
    } else {
      throw err;
    }
  }

  console.log("\nPosted review to GitHub.");
}

function sampleConfig(): string {
  return `{
  "checks": {
    "ai": { "enabled": true, "severity": "warning" },
    "lint": { "enabled": true, "severity": "error" },
    "security": { "enabled": true, "severity": "error" },
    "conventional": { "enabled": true, "severity": "warning" }
  },
  "ai": {
    "provider": "openai",
    "model": "gpt-4o-mini",
    "apiKeyEnv": "OPENAI_API_KEY",
    "temperature": 0.2,
    "maxOutputTokens": 4000
  },
  "approval": {
    "approveOnPass": false,
    "requestChangesOnError": true
  },
  "excludePaths": ["package-lock.json", "yarn.lock", "dist/", "build/"],
  "lintCommand": "npm run lint",
  "security": {
    "secretPatterns": []
  }
}`;
}

// In GitHub Actions, `run` is the default if invoked as bin.
if (process.env.GITHUB_ACTIONS === "true") {
  // When triggered from the action.yml, we call run directly via entrypoint.
}

programRunner.parse(process.argv);