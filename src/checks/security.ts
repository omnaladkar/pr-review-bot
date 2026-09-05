import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ReviewFinding } from "../config.js";
import { findProjectRoot } from "./lint.js";

export interface SecurityCheckOptions {
  diffText: string;
  changedFiles: Array<{ filename: string; patch?: string }>;
  secretPatterns: Array<{ name: string; pattern: string }>;
  workingDir: string;
}

export function runSecurityChecks(
  opts: SecurityCheckOptions
): { findings: ReviewFinding[]; output: string[] } {
  const findings: ReviewFinding[] = [];
  const output: string[] = [];

  // 1. Secret scanning on the diff.
  for (const file of opts.changedFiles) {
    if (!file.patch) continue;
    const lines = file.patch.split("\n");
    let lineOffset = 0;
    for (const line of lines) {
      const hm = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hm) {
        lineOffset = Number(hm[1]);
        continue;
      }
      if (!line.startsWith("+") || line.startsWith("+++")) continue;
      const content = line.slice(1);
      lineOffset++;
      for (const { name, pattern } of opts.secretPatterns) {
        const re = new RegExp(pattern);
        if (re.test(content)) {
          findings.push({
            rule: `SEC/${name.replace(/\s+/g, "_")}`,
            severity: "error",
            message: `Possible ${name} detected in added line.`,
            file: file.filename,
            line: lineOffset,
            category: "security",
          });
          const masked = content.replace(re, "[REDACTED]");
          output.push(`${file.filename}:${lineOffset} ${name}: ${masked.trim()}`);
        }
      }
    }
  }

  // 2. Dependency audit.
  const audit = runNpmAudit(opts.workingDir);
  if (audit) {
    output.push(audit.output);
    findings.push(...audit.findings);
  }

  return { findings, output };
}

function runNpmAudit(workingDir: string): {
  findings: ReviewFinding[];
  output: string;
} | null {
  const root = findProjectRoot(workingDir);
  if (!root) return null;
  if (
    !existsSync(resolve(root, "package.json")) &&
    !existsSync(resolve(root, "package-lock.json"))
  ) {
    return null;
  }

  try {
    const out = execFileSync("npm", ["audit", "--json"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const parsed = JSON.parse(out) as {
      metadata?: { vulnerabilities?: Record<string, number> };
      vulnerabilities?: Record<string, unknown>;
    };
    const vulns =
      parsed.metadata?.vulnerabilities ??
      (parsed.vulnerabilities
        ? Object.entries(parsed.vulnerabilities).reduce(
            (acc, [k, v]) => {
              const count = (v as { count?: number })?.count ?? 1;
              acc[k] = (acc[k] ?? 0) + count;
              return acc;
            },
            {} as Record<string, number>
          )
        : {});
    const total = Object.values(vulns).reduce((a, b) => a + b, 0);
    if (total === 0) {
      return {
        findings: [
          {
            rule: "SEC/audit",
            severity: "success",
            message: "No known vulnerabilities in dependencies.",
            category: "security",
          },
        ],
        output: "npm audit: 0 vulnerabilities",
      };
    }
    const findings: ReviewFinding[] = [];
    for (const [sev, count] of Object.entries(vulns)) {
      if (sev === "info") continue;
      findings.push({
        rule: `SEC/audit_${sev}`,
        severity: sev === "critical" || sev === "high" ? "error" : "warning",
        message: `${count} ${sev} severity vulnerability(ies) in dependencies. Run \`npm audit fix\`.`,
        category: "security",
      });
    }
    return {
      findings,
      output: `npm audit: ${Object.entries(vulns)
        .map(([k, v]) => `${v} ${k}`)
        .join(", ")}`,
    };
  } catch (err: unknown) {
    const e = err as { stdout?: string };
    try {
      const parsed = JSON.parse(e.stdout ?? "{}") as {
        metadata?: { vulnerabilities?: Record<string, number> };
      };
      const vulns = parsed.metadata?.vulnerabilities ?? {};
      const findings: ReviewFinding[] = [];
      for (const [sev, count] of Object.entries(vulns)) {
        if (sev === "info") continue;
        findings.push({
          rule: `SEC/audit_${sev}`,
          severity: sev === "critical" || sev === "high" ? "error" : "warning",
          message: `${count} ${sev} severity vulnerability(ies) in dependencies. Run \`npm audit fix\`.`,
          category: "security",
        });
      }
      return {
        findings,
        output: `npm audit: ${Object.entries(vulns)
          .map(([k, v]) => `${v} ${k}`)
          .join(", ")}`,
      };
    } catch {
      return null;
    }
  }
}
