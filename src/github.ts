import { Octokit } from "@octokit/rest";

export interface GitHubConfig {
  token: string;
  owner: string;
  repo: string;
  prNumber?: number;
  headSha?: string;
  baseSha?: string;
  apiUrl?: string;
}

export class GitHubClient {
  readonly octokit: Octokit;
  readonly owner: string;
  readonly repo: string;

  constructor(cfg: GitHubConfig) {
    this.owner = cfg.owner;
    this.repo = cfg.repo;
    this.octokit = new Octokit({
      auth: cfg.token,
      ...(cfg.apiUrl ? { baseUrl: cfg.apiUrl } : {}),
    });
  }

  static fromEnv(): GitHubConfig {
    const token =
      process.env.GITHUB_TOKEN ||
      process.env.GH_TOKEN ||
      process.env.INPUT_GITHUB_TOKEN;

    if (!token) {
      throw new Error(
        "No GitHub token found. Set GITHUB_TOKEN (or GH_TOKEN) environment variable."
      );
    }

    const owner = process.env.REPO_OWNER;
    const repo = process.env.REPO_NAME;

    if (!owner || !repo) {
      throw new Error(
        "REPO_OWNER and REPO_NAME environment variables are required. In Actions these come from GITHUB_REPOSITORY."
      );
    }

    const prNumber = process.env.PR_NUMBER
      ? Number(process.env.PR_NUMBER)
      : undefined;

    return {
      token,
      owner,
      repo,
      prNumber,
      headSha: process.env.PR_HEAD_SHA,
      baseSha: process.env.PR_BASE_SHA,
      apiUrl: process.env.GITHUB_API_URL,
    };
  }

  async getPullRequest(prNumber: number) {
    const res = await this.octokit.pulls.get({
      owner: this.owner,
      repo: this.repo,
      pull_number: prNumber,
    });
    return res.data;
  }

  async getPullRequestDiff(prNumber: number): Promise<string> {
    const res = await this.octokit.pulls.get({
      owner: this.owner,
      repo: this.repo,
      pull_number: prNumber,
      mediaType: { format: "diff" },
    });
    return res.data as unknown as string;
  }

  async getChangedFiles(prNumber: number) {
    const files: Array<{
      filename: string;
      status: string;
      additions: number;
      deletions: number;
      changes: number;
      patch?: string;
    }> = [];
    let page = 1;
    for (;;) {
      const res = await this.octokit.pulls.listFiles({
        owner: this.owner,
        repo: this.repo,
        pull_number: prNumber,
        per_page: 100,
        page,
      });
      files.push(
        ...res.data.map((f) => ({
          filename: f.filename,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          changes: f.changes,
          patch: f.patch,
        }))
      );
      if (res.data.length < 100) break;
      page++;
    }
    return files;
  }

  /**
   * Compute the set of (file, line) that appear as *added* lines in the PR diff.
   * GitHub only allows inline review comments on lines present in the diff.
   */
  async getReviewableLines(
    prNumber: number
  ): Promise<Map<string, Set<number>>> {
    const map = new Map<string, Set<number>>();
    const files = await this.getChangedFiles(prNumber);
    for (const f of files) {
      if (!f.patch) continue;
      let newLine = 0;
      let inAdd = false;
      for (const raw of f.patch.split("\n")) {
        const hm = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (hm) {
          newLine = Number(hm[1]);
          inAdd = false;
          continue;
        }
        if (!raw.startsWith("@@")) {
          if (raw.startsWith("+")) {
            inAdd = true;
            const set = map.get(f.filename) ?? new Set<number>();
            set.add(newLine);
            map.set(f.filename, set);
            newLine++;
          } else if (raw.startsWith("-")) {
            inAdd = false;
          } else if (raw.startsWith(" ") || raw.startsWith("\\")) {
            newLine++;
            inAdd = false;
          }
        }
      }
      void inAdd;
    }
    return map;
  }

  async getStatusChecks(headSha: string) {
    try {
      const combined = await this.octokit.checks.listForRef({
        owner: this.owner,
        repo: this.repo,
        ref: headSha,
      });
      return combined.data.check_runs;
    } catch {
      return [];
    }
  }

  async mergeableState(prNumber: number, headSha: string) {
    const res = await this.octokit.pulls.get({
      owner: this.owner,
      repo: this.repo,
      pull_number: prNumber,
      headers: {
        "If-None-Match": "",
      },
    });
    return {
      state: res.data.mergeable_state,
      mergeable: res.data.mergeable,
      baseRef: res.data.base?.ref,
      headRef: res.data.head?.ref,
      headSha: res.data.head?.sha,
    };
  }

  async postReview({
    prNumber,
    headSha,
    body,
    event,
    comments,
  }: {
    prNumber: number;
    headSha: string;
    body: string;
    event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
    comments?: Array<{ path: string; line: number; body: string }>;
  }) {
    await this.octokit.pulls.createReview({
      owner: this.owner,
      repo: this.repo,
      pull_number: prNumber,
      commit_id: headSha,
      body,
      event,
      comments:
        comments && comments.length > 0
          ? comments.slice(0, 50)
          : undefined,
    });
  }

  async postComment(prNumber: number, body: string) {
    await this.octokit.issues.createComment({
      owner: this.owner,
      repo: this.repo,
      issue_number: prNumber,
      body,
    });
  }

  async setStatus({
    headSha,
    state,
    description,
    context,
    targetUrl,
  }: {
    headSha: string;
    state: "error" | "failure" | "pending" | "success";
    description: string;
    context: string;
    targetUrl?: string;
  }) {
    await this.octokit.repos.createCommitStatus({
      owner: this.owner,
      repo: this.repo,
      sha: headSha,
      state,
      description,
      context,
      target_url: targetUrl,
    });
  }
}
