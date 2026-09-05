import type { BotConfig, ReviewFinding } from "./config.js";

export interface AIReviewOptions {
  diffText: string;
  changedFiles: Array<{ filename: string; additions: number }>;
  title: string;
  body: string;
  config: BotConfig;
}

interface AIFinding {
  rule: string;
  severity: string;
  message: string;
  file?: string;
  line?: number;
  suggestedFix?: string;
}

const MANIFEST = [
  {
    rule: "AI/Critical_Bug",
    severity: "error",
    description: "Logic errors, null-derefs, race conditions, wrong API usage, silent data loss",
  },
  {
    rule: "AI/Performance",
    severity: "warning",
    description: "Unnecessary O(n^2) loops, blocking IO in hot paths, missing caching",
  },
  {
    rule: "AI/Security",
    severity: "error",
    description: "Unsanitized input, injection, auth bypass, secrets, unsafe eval",
  },
  {
    rule: "AI/Error_Handling",
    severity: "warning",
    description: "Swallowed errors, missing try/catch, abandonment in finally",
  },
  {
    rule: "AI/Clean_Code",
    severity: "info",
    description: "Readability, premature complexity, dead code, naming",
  },
  {
    rule: "AI/Testing",
    severity: "warning",
    description: "Untested critical paths, insufficient assertions, missing edge cases",
  },
];

export function loadManifest(): AIFinding[] {
  return MANIFEST.map((m) => ({ ...m, message: m.description }));
}

export function buildPrompt(opts: AIReviewOptions): string {
  const { diffText, title, body, changedFiles, config } = opts;

  const fileList = changedFiles
    .map((f) => `- ${f.filename} (+${f.additions} lines)`)
    .join("\n");

  const manifest = MANIFEST.map(
    (m) => `- ${m.rule} (${m.severity}): ${m.description}`
  ).join("\n");

  return `
You are a senior code reviewer. Review the pull request below.

PR title: ${title}
PR description: ${body?.slice(0, 1500) || "(none)"}

Changed files:
${fileList}

Rules to apply, in this priority order:
${manifest}

Respond with ONLY a valid JSON array. Each element:
{
  "rule": "AI/XXXX",
  "severity": "info" | "warning" | "error",
  "message": "Concise, specific, actionable finding (max 140 chars)",
  "file": "path/to/file.ts",
  "line": 42,
  "suggestedFix": "optional short suggestion"
}

Constraints:
- Only report real issues; ignore trivial nits.
- If the diff is good, return [].
- Do not invent files or lines. Omit "file"/"line" if not applicable.
- Max 10 findings.
- Some files may be large; focus on the changed hunks.

--- DIFF START ---
${diffText.slice(0, config.ai.maxOutputTokens * 4)}
--- DIFF END ---
`.trim();
}

export async function runAIReview(
  opts: AIReviewOptions
): Promise<{ findings: ReviewFinding[]; raw: string }> {
  const prompt = buildPrompt(opts);
  const raw = await callProvider(opts, prompt);

  let parsed: AIFinding[] = [];
  try {
    parsed = parseAIResponse(raw);
  } catch {
    return { findings: [], raw };
  }

  return {
    findings: parsed.map((f, i) => ({
      rule: f.rule && f.rule.startsWith("AI/") ? f.rule : `AI/Finding_${i + 1}`,
      severity: normalizeSeverity(f.severity),
      message: f.message,
      file: f.file,
      line: f.line,
      category: "ai" as const,
      suggestedFix: f.suggestedFix,
    })),
    raw,
  };
}

function normalizeSeverity(s: string): ReviewFinding["severity"] {
  const lower = s.toLowerCase();
  if (lower === "error") return "error";
  if (lower === "warning" || lower === "warn") return "warning";
  return "info";
}

async function callProvider(
  opts: AIReviewOptions,
  prompt: string
): Promise<string> {
  const { config } = opts;
  const { provider, model, apiKeyEnv, baseUrl, temperature } = config.ai;

  if (provider === "ollama") {
    return callOllama(
      baseUrl ?? "http://localhost:11434",
      model,
      temperature,
      prompt
    );
  }

  const apiKey = process.env[apiKeyEnv];
  if (!apiKey) {
    throw new Error(
      `AI provider "${provider}" requires ${apiKeyEnv} to be set.`
    );
  }

  if (provider === "openai" || provider === "openrouter") {
    return callChatCompletions(
      baseUrl ?? "https://api.openai.com/v1",
      model,
      apiKey,
      temperature,
      prompt
    );
  }
  if (provider === "anthropic") {
    return callAnthropic(apiKey, model, temperature, prompt);
  }
  throw new Error(`Unsupported AI provider: ${provider}`);
}

async function callOllama(
  baseUrl: string,
  model: string,
  temperature: number,
  prompt: string
): Promise<string> {
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      options: { temperature },
      messages: [
        { role: "system", content: "You are a terse senior code reviewer." },
        { role: "user", content: prompt },
      ],
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Ollama request failed (${res.status}): ${text.slice(0, 500)}`
    );
  }
  const data = (await res.json()) as {
    message?: { content?: string };
  };
  return data.message?.content ?? "";
}

async function callChatCompletions(
  baseUrl: string,
  model: string,
  apiKey: string,
  temperature: number,
  prompt: string
): Promise<string> {
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature,
      messages: [
        { role: "system", content: "You are a terse senior code reviewer." },
        { role: "user", content: prompt },
      ],
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `AI request failed (${res.status}): ${text.slice(0, 500)}`
    );
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return data.choices?.[0]?.message?.content ?? "";
}

async function callAnthropic(
  apiKey: string,
  model: string,
  temperature: number,
  prompt: string
): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 4000,
      temperature,
      system: "You are a terse senior code reviewer.",
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Anthropic request failed (${res.status}): ${text.slice(0, 500)}`
    );
  }
  const data = (await res.json()) as {
    content?: Array<{ type: string; text?: string }>;
  };
  const texts =
    data.content
      ?.filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n") ?? "";
  return texts;
}

export function parseAIResponse(raw: string): AIFinding[] {
  const cleaned = raw
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();
  // Find the first '[' and last ']' to extract the array.
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("No JSON array found in AI response");
  }
  const json = cleaned.slice(start, end + 1);
  const parsed = JSON.parse(json) as AIFinding[];
  if (!Array.isArray(parsed)) {
    throw new Error("AI response is not an array");
  }
  return parsed.filter(
    (f) => f && typeof f.message === "string" && f.message.length > 0
  );
}