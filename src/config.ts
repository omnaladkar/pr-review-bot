export type Severity = "error" | "warning" | "info" | "success";

export interface ReviewFinding {
  rule: string;
  severity: Severity;
  message: string;
  file?: string;
  line?: number;
  category: "ai" | "lint" | "security" | "conventional" | "tests";
  suggestedFix?: string;
}

export interface ReviewResult {
  findings: ReviewFinding[];
  summary: string;
}

export interface CheckConfig {
  enabled: boolean;
  severity: Severity;
  maxWarnings?: number;
}

export interface BotConfig {
  checks: {
    ai: CheckConfig;
    lint: CheckConfig;
    security: CheckConfig;
    conventional: CheckConfig;
  };
  ai: {
    provider: "openai" | "anthropic" | "openrouter" | "ollama" | "none";
    model: string;
    apiKeyEnv: string;
    baseUrl?: string;
    temperature: number;
    maxOutputTokens: number;
    onlyOnDiff: boolean;
  };
  approval: {
    approveOnPass: boolean;
    requestChangesOnError: boolean;
    maxCommentLines: number;
  };
  excludePaths: string[];
  lintCommand?: string;
  security: {
    secretPatterns: Array<{ name: string; pattern: string }>;
  };
}

export function loadConfig(): BotConfig {
  const raw = process.env.BOT_CONFIG
    ? JSON.parse(process.env.BOT_CONFIG)
    : {};

  const secretPatterns = (raw.security?.secretPatterns ?? defaultSecretPatterns).map(
    (p: { name: string; pattern: string }) => ({ name: p.name, pattern: p.pattern })
  );

  return {
    checks: {
      ai: {
        enabled: (raw.checks?.ai?.enabled ?? true) === true,
        severity: raw.checks?.ai?.severity ?? "warning",
      },
      lint: {
        enabled: (raw.checks?.lint?.enabled ?? true) === true,
        severity: raw.checks?.lint?.severity ?? "error",
        maxWarnings: raw.checks?.lint?.maxWarnings ?? 0,
      },
      security: {
        enabled: (raw.checks?.security?.enabled ?? true) === true,
        severity: raw.checks?.security?.severity ?? "error",
      },
      conventional: {
        enabled: (raw.checks?.conventional?.enabled ?? true) === true,
        severity: raw.checks?.conventional?.severity ?? "warning",
      },
    },
    ai: {
      provider: (raw.ai?.provider ?? "openai") as BotConfig["ai"]["provider"],
      model: raw.ai?.model ?? defaultModelFor(raw.ai?.provider),
      apiKeyEnv: raw.ai?.apiKeyEnv ?? inferApiKeyEnv(raw.ai?.provider),
      baseUrl: raw.ai?.baseUrl ?? defaultBaseUrl(raw.ai?.provider),
      temperature: raw.ai?.temperature ?? 0.2,
      maxOutputTokens: raw.ai?.maxOutputTokens ?? 4000,
      onlyOnDiff: (raw.ai?.onlyOnDiff ?? true) === true,
    },
    approval: {
      approveOnPass: (raw.approval?.approveOnPass ?? false) === true,
      requestChangesOnError: (raw.approval?.requestChangesOnError ?? true) === true,
      maxCommentLines: raw.approval?.maxCommentLines ?? 100,
    },
    excludePaths: raw.excludePaths ?? [
      "package-lock.json",
      "yarn.lock",
      "pnpm-lock.yaml",
      "*.min.js",
      "dist/",
      "build/",
    ],
    lintCommand: raw.lintCommand,
    security: { secretPatterns },
  };
}

function defaultModelFor(provider?: string): string {
  switch (provider) {
    case "anthropic":
      return "claude-sonnet-4-20250514";
    case "openrouter":
      return "anthropic/claude-sonnet-4";
    case "ollama":
      return "exaone3.5:2.4b";
    case "none":
      return "";
    default:
      return "gpt-4o-mini";
  }
}

function defaultBaseUrl(provider?: string): string | undefined {
  if (provider === "ollama") return "http://localhost:11434";
  return undefined;
}

function inferApiKeyEnv(provider?: string): string {
  switch (provider) {
    case "anthropic":
      return "ANTHROPIC_API_KEY";
    case "openrouter":
      return "OPENROUTER_API_KEY";
    case "none":
    case "ollama":
      return "";
    default:
      return "OPENAI_API_KEY";
  }
}

const defaultSecretPatterns = [
  {
    name: "AWS Access Key",
    pattern: "\\bAKIA[0-9A-Z]{16}\\b",
  },
  {
    name: "AWS Secret Key",
    pattern: "\\b(?i)aws.{0,20}?(?:secret|access)[\\w\\-]?key[\\s:=]{1,3}[A-Z0-9/+=]{20,}\\b",
  },
  {
    name: "GitHub Token",
    pattern: "\\bgh[pousr]_[A-Za-z0-9_]{20,}\\b",
  },
  {
    name: "GitHub PAT (legacy)",
    pattern: "\\bghp_[A-Za-z0-9]{36}\\b",
  },
  {
    name: "Generic Private Key",
    pattern: "-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----",
  },
  {
    name: "Slack Token",
    pattern: "\\b[xopsapb]-[A-Za-z0-9-]{10,}\\b",
  },
  {
    name: "Stripe Secret Key",
    pattern: "\\bsk_live_[A-Za-z0-9]{20,}\\b",
  },
  {
    name: "Google API Key",
    pattern: "\\bAIza[0-9A-Za-z\\-_]{35}\\b",
  },
  {
    name: "Generic Password Assignment",
    pattern: "\\b(?:password|passwd|pwd|secret)\\s*[:=]\\s*['\"][^'\"]{6,}['\"]",
  },
  {
    name: "Bearer Token",
    pattern: "\\b(?:api[_-]?key|token|secret)\\s*[:=]\\s*['\"]?(?:Bearer\\s+)?[A-Za-z0-9\\-_.=]{20,}['\"]?",
  },
];
