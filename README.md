# PR Review Bot

Automated review bot for GitHub pull requests. Every time a PR is opened, updated, or pushed to, it runs four kinds of checks and posts the result directly to the PR as a review.

## What it checks

| Category | What it does |
|---|---|
| **AI review** | Sends the PR diff to an LLM (OpenAI / Anthropic / OpenRouter) and reports logic bugs, security issues, performance problems, missing error handling, and test gaps. Findings can be posted as inline code comments. |
| **Lint / static analysis** | Runs your project's lint script (e.g. `npm run lint`, `tsc --noEmit`) and parses errors/warnings, failing the review on real errors. |
| **Security** | Scans added lines for leaked secrets/keys (AWS, GitHub tokens, private keys, Slack/Stripe/Google keys, passwords) and runs `npm audit` for known dependency vulnerabilities. |
| **Conventional** | Checks PR title (Conventional Commits), PR size, merge conflicts, and CI status. |

## Quick start (GitHub Action)

Add this workflow to your repo (or copy `.github/workflows/pr-review.yml` from this repo):

```yaml
name: PR Review Bot

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read
  pull-requests: write
  checks: write
  statuses: write

concurrency:
  group: pr-review-${{ github.event.pull_request.number }}
  cancel-in-progress: false

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: Run PR Review Bot
        uses: your-org/pr-review-bot@main
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          ai-provider: openai
          ai-model: gpt-4o-mini
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

Set up secrets in your repo settings:
- `OPENAI_API_KEY` — for OpenAI
- or `ANTHROPIC_API_KEY` / `OPENROUTER_API_KEY` for those providers
- `GITHUB_TOKEN` is automatic (from `secrets.GITHUB_TOKEN`)

## Free local AI review (no API key, no cost)

Use the **EXAONE Korean model** from LG AI Research, running 100% on your machine via [Ollama](https://ollama.com). No VPN, no API key, no subscription.

```bash
# One-time setup: install Ollama + download the Korean model (~1.6 GB)
npm run setup:ollama

# Then review a PR with the local model (bilingual Korean/English, free forever)
set GITHUB_TOKEN=ghp_xxx
node dist/index.js run -o owner -r repo -p 42 --ollama
```

You can override the model size: `--ollama exaone3.5:7.8b` (better quality, ~4.8 GB, needs ~8 GB RAM) or `--ollama exaone3.5:32b` (best, ~19 GB, needs ~24 GB RAM).

> Note: EXAONE is licensed for **non-commercial use** (research/personal). For commercial use, prefer `--ollama llama3.2` or a GPT/Claude provider.

## Running locally (CLI)

```bash
# Install
npm install
npm run build

# Review a PR (posts a GitHub review by default)
set GITHUB_TOKEN=ghp_xxx
node dist/index.js run -o owner -r repo -p 42

# Dry-run: review without posting    --no-post
node dist/index.js run -o owner -r repo -p 42 --no-post

# Custom working dir (for lint/audit)
node dist/index.js run -o owner -r repo -p 42 -d C:\path\to\repo
```

## Configuration

The bot is configurable via the `BOT_CONFIG` env var (JSON) or the `--config` CLI flag.

```json
{
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
  "security": { "secretPatterns": [] }
}
```

Key options:

- `ai.provider`: `openai` (default), `anthropic`, `openrouter`, `ollama` (local free), or `none` to skip.
- `ai.model`: model name. Defaults pick a sensible model per provider (Ollama defaults to `exaone3.5:2.4b`).
- `approval.requestChangesOnError`: when `true`, the bot requests changes instead of a plain comment when there are error-severity findings.
- `approval.approveOnPass`: when `true`, bot approves PRs with no errors.
- `excludePaths`: files/paths skipped for AI & secret scanning (e.g. lockfiles).
- `security.secretPatterns`: add your own secret patterns.

## Outputs

The bot posts a **GitHub review** to the PR containing:
- A summary table (`ai`, `lint`, `security`, `conventional` counts)
- Collapsible sections with each finding (severity, rule, file:line)
- Up to 50 inline comments on the offending lines
- A commit status check (`pr-review-bot/review` = success/failure)
- `REQUEST_CHANGES` when errors exist (configurable)

## Requirements

- Node.js >= 20
- A GitHub token with `repo` scope (or just the default `GITHUB_TOKEN` in Actions)
- An LLM API key for AI review (skip with `ai-provider: none`)

## Disclaimer

The AI and secret-scanning checks are best-effort heuristics and may produce false positives/negatives. They complement — not replace — human review.