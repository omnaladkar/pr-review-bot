import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ReviewFinding } from "../config.js";

export interface LintRunOptions {
  workingDir: string;
  changedFiles: string[];
  command?: string;
  maxWarnings: number;
}

export function findProjectRoot(dir: string): string | null {
  let current = resolve(dir);
  for (;;) {
    if (
      existsSync(resolve(current, "package.json")) ||
      existsSync(resolve(current, "tsconfig.json"))
    ) {
      return current;
    }
    const parent = resolve(current, "..");
    if (parent === current) return null;
    current = parent;
  }
}

export function hasLintScript(projectRoot: string): boolean {
  try {
    const pkg = JSON.parse(
      readFileSync(resolve(projectRoot, "package.json"), "utf8")
    ) as { scripts?: Record<string, string> };
    return Boolean(pkg.scripts && "lint" in pkg.scripts);
  } catch {
    return false;
  }
}

export function runLint(
  opts: LintRunOptions
): { findings: ReviewFinding[]; output: string } {
  const root = findProjectRoot(opts.workingDir);
  const findings: ReviewFinding[] = [];

  // No lockfile observed, try running the lint script.
  const lintScript = guessLintCommand(root, opts.command);
  if (!root || !lintScript) {
    findings.push({
      rule: "LINT/setup",
      severity: "info",
      message:
        "No lint script or command configured. Set `lintCommand` in config to enable lint checks.",
      category: "lint",
    });
    return { findings, output: "" };
  }

  try {
    const fullCmd = [lintScript.cmd, ...lintScript.args].join(" ");
    const out = execFileSync(fullCmd, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
    });
    return { findings: [], output: out };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string };
    const output = `${e.stdout ?? ""}\n${e.stderr ?? ""}`.trim();
    const lines = output.split("\n");

    for (const line of lines) {
      const m = line.match(
        /^(?:error|warning)\s+([^\s]+)\s+line\s+(\d+)(?::\s+col\s+(\d+))?\s+-\s+(.+)$/
      );
      if (m) {
        findings.push({
          rule: `LINT/${m[1]}`,
          severity: m[1] === "error" ? "error" : "warning",
          message: m[4],
          category: "lint",
        });
      }
    }

    const errorCount = (output.match(/\berror\b/gi) ?? []).length;
    const warningCount = (output.match(/\bwarning\b/gi) ?? []).length;
    if (errorCount > 0 || warningCount > 0) {
      findings.push({
        rule: "LINT/summary",
        severity: errorCount > 0 ? "error" : "warning",
        message: `Lint reported ${errorCount} error(s) and ${warningCount} warning(s).`,
        category: "lint",
      });
    } else {
      findings.push({
        rule: "LINT/summary",
        severity: "success",
        message: "Lint completed without reported errors.",
        category: "lint",
      });
    }
    return { findings, output };
  }
}

function guessLintCommand(
  root: string | null,
  optCommand?: string
): { cmd: string; args: string[] } | null {
  if (optCommand) {
    return { cmd: optCommand, args: [] };
  }
  if (!root) return null;
  const pkgPath = resolve(root, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    scripts?: Record<string, string>;
  };
  if (pkg.scripts && pkg.scripts.lint) {
    return { cmd: "npm", args: ["run", "lint"] };
  }
  return null;
}
