import type { ReviewFinding } from "../config.js";

export interface ConventionalCheckOptions {
  title: string;
  body: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  mergeable: boolean | null;
  mergeableState: string | null;
  ciChecks: Array<{
    name: string;
    status: string;
    conclusion: string | null;
  }>;
  baseRef: string;
  headRef: string;
}

const CONVENTIONAL_COMMIT_RE =
  /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\(.+\))?(\!)?:\s.+/i;

export function runConventionalChecks(
  opts: ConventionalCheckOptions
): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  const {
    title,
    additions,
    deletions,
    changedFiles,
    mergeable,
    mergeableState,
    ciChecks,
    baseRef,
    headRef,
  } = opts;

  // Title check.
  if (!title || title.trim().length === 0) {
    findings.push({
      rule: "CONV/title_empty",
      severity: "error",
      message: "PR has no title.",
      category: "conventional",
    });
  } else if (title.trim().length < 5) {
    findings.push({
      rule: "CONV/title_too_short",
      severity: "warning",
      message: `PR title is very short ("${title.trim()}"). A descriptive title helps reviewers.`,
      category: "conventional",
    });
  } else if (!CONVENTIONAL_COMMIT_RE.test(title.trim())) {
    findings.push({
      rule: "CONV/title_conventional_commits",
      severity: "warning",
      message: `Title "${title.trim()}" does not follow Conventional Commits (e.g. "feat: add login").`,
      category: "conventional",
      suggestedFix: `Use a prefix like feat, fix, docs, refactor, test, chore, ci. Example: "feat: ${title.trim()}"`,
    });
  }

  // Size check.
  const totalChanges = additions + deletions;
  if (totalChanges > 1000) {
    findings.push({
      rule: "CONV/pr_too_large",
      severity: "warning",
      message: `PR is large: +${additions}/-${deletions} across ${changedFiles} files. Consider splitting it into smaller reviewable PRs.`,
      category: "conventional",
    });
  }

  // Conflict check.
  if (mergeable === false) {
    findings.push({
      rule: "CONV/merge_conflict",
      severity: "error",
      message: `PR has merge conflicts with ${baseRef}. Rebase or merge ${baseRef} into ${headRef}.`,
      category: "conventional",
    });
  } else if (mergeableState && mergeableState !== "clean") {
    findings.push({
      rule: "CONV/mergeable_state",
      severity: "warning",
      message: `Mergeable state is "${mergeableState}" (expected "clean").`,
      category: "conventional",
    });
  }

  // CI checks.
  const failed = ciChecks.filter(
    (c) => c.conclusion === "failure" || c.conclusion === "cancelled"
  );
  const pending = ciChecks.filter(
    (c) => c.status === "in_progress" || c.conclusion === "neutral" || !c.conclusion
  );
  if (failed.length > 0) {
    findings.push({
      rule: "CONV/ci_failed",
      severity: "error",
      message: `CI failed on ${failed.length} check(s): ${failed
        .map((c) => c.name)
        .slice(0, 5)
        .join(", ")}.`,
      category: "conventional",
    });
  }
  if (pending.length > 0 && failed.length === 0) {
    findings.push({
      rule: "CONV/ci_pending",
      severity: "info",
      message: `${pending.length} CI check(s) still pending.`,
      category: "conventional",
    });
  }

  return findings;
}