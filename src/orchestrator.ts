import type {
  BotConfig,
  ReviewFinding,
  ReviewResult,
  Severity,
} from "./config.js";
import { runAIReview } from "./ai.js";
import { runLint } from "./checks/lint.js";
import { runConventionalChecks } from "./checks/conventional.js";
import { runSecurityChecks } from "./checks/security.js";
import type { GitHubClient } from "./github.js";

export interface OrchestratorInput {
  config: BotConfig;
  client: GitHubClient;
  prNumber: number;
  workingDir: string;
}

export interface OrchestratorOutput {
  findings: ReviewFinding[];
  summary: string;
  sections: Record<string, string>;
}

function isExcluded(filename: string, excludePaths: string[]): boolean {
  return excludePaths.some((p) => {
    if (p.includes("*")) {
      // glob-ish.
      const re = new RegExp(
        "^" + p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$"
      );
      return re.test(filename);
    }
    return filename === p || filename.startsWith(p);
  });
}

function scoreFindings(findings: ReviewFinding[]): number {
  let score = 0;
  for (const f of findings) {
    switch (f.severity) {
      case "error":
        score += 10;
        break;
      case "warning":
        score += 3;
        break;
      case "info":
        score += 1;
        break;
      default:
        break;
    }
  }
  return score;
}

export function formatSummary(findings: ReviewFinding[]): string {
  const groups = new Map<string, ReviewFinding[]>();
  for (const f of findings) groups.set(f.category, [...(groups.get(f.category) ?? []), f]);
  const lines: string[] = [];
  for (const [cat, list] of groups) {
    const errs = list.filter((f) => f.severity === "error").length;
    const warns = list.filter((f) => f.severity === "warning").length;
    const infos = list.filter((f) => f.severity === "info").length;
    lines.push(
      `- **${cat}**: ${errs} error(s), ${warns} warning(s), ${infos} info`
    );
  }
  return lines.join("\n") || "No issues found.";
}

export async function orchestrate(
  input: OrchestratorInput
): Promise<OrchestratorOutput & { score: number; outcome: "pass" | "fail" }> {
  const { config, client, prNumber, workingDir } = input;
  const findings: ReviewFinding[] = [];
  const sections: Record<string, string> = {};

  const pr = await client.getPullRequest(prNumber);
  const changedFiles = await client.getChangedFiles(prNumber);
  const diffText = await client.getPullRequestDiff(prNumber);

  // Filter out excluded files for consultation.
  const reviewFiles = changedFiles.filter((f) => !isExcluded(f.filename, config.excludePaths));
  const diffForAI = filterDiffByFiles(diffText, reviewFiles.map((f) => f.filename));

  // Conventional checks.
  if (config.checks.conventional.enabled) {
    const ci = await client.getStatusChecks(pr.head.sha);
    const st = await client.mergeableState(prNumber, pr.head.sha);
    const conv = runConventionalChecks({
      title: pr.title,
      body: pr.body ?? "",
      additions: pr.additions ?? 0,
      deletions: pr.deletions ?? 0,
      changedFiles: changedFiles.length,
      mergeable: pr.mergeable,
      mergeableState: pr.mergeable_state,
      ciChecks: ci.map((c) => ({
        name: c.name,
        status: c.status,
        conclusion: c.conclusion,
      })),
      baseRef: pr.base?.ref ?? "main",
      headRef: pr.head?.ref ?? "head",
    });
    findings.push(...conv);
    sections.conventional = formatSection("Conventional checks", conv);
  }

  // Lint checks.
  if (config.checks.lint.enabled) {
    const lintRes = await runLint({
      workingDir,
      changedFiles: reviewFiles.map((f) => f.filename),
      command: config.lintCommand,
      maxWarnings: config.checks.lint.maxWarnings ?? 0,
    });
    findings.push(...lintRes.findings);
    sections.lint = formatSection("Static analysis / lint", lintRes.findings);
  }

  // Security checks.
  if (config.checks.security.enabled) {
    const secRes = await runSecurityChecks({
      diffText,
      changedFiles: changedFiles
        .filter((f) => !isExcluded(f.filename, config.excludePaths))
        .map((f) => ({ filename: f.filename })),
      secretPatterns: config.security.secretPatterns,
      workingDir,
    });
    findings.push(...secRes.findings);
    sections.security = formatSection("Security checks", secRes.findings);
  }

  // AI review.
  if (config.checks.ai.enabled && config.ai.provider !== "none") {
    try {
      const aiRes = await runAIReview({
        diffText: diffForAI,
        changedFiles: reviewFiles.map((f) => ({ filename: f.filename, additions: f.additions })),
        title: pr.title,
        body: pr.body ?? "",
        config,
      });
      findings.push(...aiRes.findings);
      sections.ai = formatFull("AI review", aiRes.raw, aiRes.findings);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      findings.push({
        rule: "AI/provider_error",
        severity: "warning",
        message: `AI review skipped: ${msg.slice(0, 300)}`,
        category: "ai",
      });
      sections.ai = formatSection("AI review", [
        {
          rule: "AI/provider_error",
          severity: "warning",
          message: `AI review skipped: ${msg.slice(0, 300)}`,
          category: "ai",
        },
      ]);
    }
  }

  const summary = formatSummary(findings);
  const score = scoreFindings(findings);
  const hasErrors = findings.some((f) => f.severity === "error");

  return {
    findings,
    summary,
    sections,
    score,
    outcome: hasErrors ? "fail" : "pass",
  };
}

function formatSection(title: string, findings: ReviewFinding[]): string {
  if (findings.length === 0) return `## ${title}\n- No issues found.`;
  const lines = findings.map((f) => {
    const loc = f.file ? `\`${f.file}${f.line ? `:${f.line}` : ""}\`` : "";
    return `- [${f.severity}] **${f.rule}** ${loc} — ${f.message}`;
  });
  return `## ${title}\n${lines.join("\n")}`;
}

function formatFull(title: string, raw: string, findings: ReviewFinding[]): string {
  const head = `## ${title}\n`;
  if (findings.length === 0) return `${head}\nNo issues found.`;
  const lines = findings.map((f) => {
    const loc = f.file ? `\`${f.file}${f.line ? `:${f.line}` : ""}\`` : "";
    return `- [${f.severity}] **${f.rule}** ${loc} — ${f.message}${f.suggestedFix ? `\n  - *Fix: ${f.suggestedFix}*` : ""}`;
  });
  return `${head}\n${lines.join("\n")}`;
}

function filterDiffByFiles(diff: string, keep: string[]): string {
  if (!diff) return "";
  const keepSet = new Set(keep);
  const hunks = diff.split(/\n(?=diff --git )/);
  return hunks
    .filter((h) => {
      const m = h.match(/^diff --git a\/(\S+) b\//);
      if (!m) return false;
      return keepSet.has(m[1]);
    })
    .join("\n");
}