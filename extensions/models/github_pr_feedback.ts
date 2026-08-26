/**
 * @module Reconstruct detailed GitHub pull-request feedback for deterministic review.
 */
import { z } from "npm:zod@4";

/** Strict GitHub `owner/repository` identifier accepted by every method. */
export const RepoSlugSchema = z.string().regex(
  /^(?!\.\.?\/)(?!.*\/\.\.?$)[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/,
  "repoSlug must be exactly owner/repository using GitHub slug characters (no query, fragment, path, or dot segment)",
);

const GlobalArgsSchema = z.object({
  repoSlug: RepoSlugSchema.describe(
    "GitHub owner/repository",
  ),
  botAuthors: z.array(z.string()).default([
    "github-actions[bot]",
    "dependabot[bot]",
    "renovate[bot]",
    "codecov[bot]",
  ]),
  reviewerBots: z.array(z.string()).default([]),
  maxDiffBytes: z.number().int().positive().default(60_000),
});

const StatusSchema = z.enum([
  "resolved",
  "likely_addressed",
  "addressed_by_commit",
  "likely_unaddressed",
]);
const CommentSchema = z.object({
  id: z.number(),
  author: z.string(),
  authorType: z.enum(["human", "bot", "author"]),
  body: z.string(),
  createdAt: z.string(),
});
const ThreadSchema = z.object({
  kind: z.enum(["inline", "issue_comment", "review"]),
  rootId: z.number(),
  path: z.string(),
  line: z.number().nullable(),
  comments: z.array(CommentSchema),
  lastCommenter: z.string(),
  authorRepliedLast: z.boolean(),
  status: StatusSchema,
  githubResolved: z.boolean(),
  githubOutdated: z.boolean(),
});
const PrSchema = z.object({
  number: z.number(),
  title: z.string(),
  url: z.string(),
  author: z.string(),
  baseRef: z.string(),
  headRef: z.string(),
  threads: z.array(ThreadSchema),
  unaddressedCount: z.number(),
  needsEvaluationCount: z.number(),
});
const BundleSchema = z.object({
  repoSlug: z.string(),
  fetchedAt: z.string(),
  prs: z.array(PrSchema),
  stacks: z.array(z.array(z.number())),
  totalUnaddressed: z.number(),
  totalNeedsEvaluation: z.number(),
});
const ContextSchema = z.object({
  prNumber: z.number(),
  title: z.string(),
  url: z.string(),
  body: z.string(),
  baseRef: z.string(),
  headRef: z.string(),
  diff: z.string(),
  diffTruncated: z.boolean(),
  changedFiles: z.array(z.string()),
  gatheredAt: z.string(),
});

/** GitHub review-thread state keyed by the root REST comment id. */
export type ThreadState = { resolved: boolean; outdated: boolean };
/** Minimal REST review-comment shape accepted by reconstruction. */
export type ReviewComment = {
  id: number;
  in_reply_to_id: number | null;
  user: { login: string } | null;
  author_association?: string;
  path: string;
  line: number | null;
  body: string;
  created_at: string;
};
type PullRequest = {
  title: string;
  html_url: string;
  body: string | null;
  user: { login: string };
  base: { ref: string };
  head: { ref: string };
};
type Commit = {
  commit: {
    committer?: { date?: string };
    author?: { date?: string };
  };
};
const PullRequestSchema: z.ZodType<PullRequest> = z.object({
  title: z.string(),
  html_url: z.url(),
  body: z.string().nullable(),
  user: z.object({ login: z.string().min(1) }),
  base: z.object({ ref: z.string() }),
  head: z.object({ ref: z.string() }),
});
const ReviewCommentSchema: z.ZodType<ReviewComment> = z.object({
  id: z.number().int().positive(),
  in_reply_to_id: z.number().int().positive().nullable(),
  user: z.object({ login: z.string() }).nullable(),
  author_association: z.string().optional(),
  path: z.string(),
  line: z.number().int().nullable(),
  body: z.string(),
  created_at: z.iso.datetime(),
});
const CommitSchema: z.ZodType<Commit> = z.object({
  commit: z.object({
    committer: z.object({ date: z.iso.datetime().optional() }).optional(),
    author: z.object({ date: z.iso.datetime().optional() }).optional(),
  }),
});
const FileSchema = z.object({
  filename: z.string().min(1),
  patch: z.string().optional(),
});
type CmdResult = {
  success: boolean;
  stdout: string;
  stderr: string;
  code: number;
};
type Runner = (args: string[]) => Promise<CmdResult>;

async function systemRun(args: string[]): Promise<CmdResult> {
  const out = await new Deno.Command(args[0], {
    args: args.slice(1),
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    success: out.success,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
    code: out.code,
  };
}
let commandRunner: Runner = systemRun;
/** Replace command execution in deterministic tests. */
export function setCommandRunnerForTests(next: Runner): void {
  commandRunner = next;
}
/** Restore production command execution after a test. */
export function resetCommandRunnerForTests(): void {
  commandRunner = systemRun;
}

/** Flatten the page arrays emitted by `gh api --paginate --slurp`. */
export function flattenRestPages<T>(text: string, schema = z.unknown()): T[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `GitHub REST returned malformed JSON: ${(error as Error).message}`,
    );
  }
  const pages = z.array(z.array(schema)).safeParse(value);
  if (!pages.success) {
    throw new Error(
      `GitHub paginated REST response was invalid: ${
        z.prettifyError(pages.error)
      }`,
    );
  }
  return pages.data.flat() as T[];
}

/** Build an actionable error for failed GitHub CLI API calls. */
export function apiError(path: string, result: CmdResult): Error {
  const detail = result.stderr.trim().slice(0, 500);
  const hint = /rate limit|HTTP 429/i.test(detail)
    ? " Retry after GitHub's reset time; no partial resource was written."
    : " Verify gh authentication, repository access, and the PR number.";
  return new Error(
    `GitHub API ${path} failed (exit ${result.code}): ${detail}.${hint}`,
  );
}

async function rest<T>(
  path: string,
  schema: z.ZodType<T>,
  paginate = false,
): Promise<T> {
  const args = ["gh", "api"];
  if (paginate) args.push("--paginate", "--slurp");
  args.push(path);
  const result = await commandRunner(args);
  if (!result.success) throw apiError(path, result);
  try {
    return paginate
      ? schema.parse(flattenRestPages(result.stdout))
      : schema.parse(JSON.parse(result.stdout));
  } catch (error) {
    throw new Error(
      `GitHub REST ${path} returned an invalid response: ${
        error instanceof z.ZodError
          ? z.prettifyError(error)
          : (error as Error).message
      }`,
    );
  }
}

/** Parse PR numbers from a bare number, GitHub URL, or optional Graphite stack text. */
export function parsePrNumbers(input: string): number[] {
  const values: number[] = [];
  const seen = new Set<number>();
  const recognized =
    /https:\/\/(?:github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/pull\/|app\.graphite\.com\/github\/pr\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/)(\d+)|^\s*(?:[-*]\s*)?\[#?(\d+)\]\(https:\/\/app\.graphite\.com\/github\/pr\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/\2\)\s*$/gm;
  for (const match of input.matchAll(recognized)) {
    const n = Number(match[1] ?? match[2]);
    if (!seen.has(n)) {
      seen.add(n);
      values.push(n);
    }
  }
  if (!values.length && /^\d+$/.test(input.trim())) {
    values.push(Number(input.trim()));
  }
  return values;
}

/** Group pull requests into base/head chains, bottom to top. */
export function groupStacks(
  prs: Array<{ number: number; baseRef: string; headRef: string }>,
): number[][] {
  const byHead = new Map(prs.map((p) => [p.headRef, p.number]));
  const children = new Map<number, number[]>();
  const roots: number[] = [];
  for (const p of prs) {
    const parent = byHead.get(p.baseRef);
    if (parent === undefined) roots.push(p.number);
    else children.set(parent, [...(children.get(parent) ?? []), p.number]);
  }
  const result: number[][] = [];
  const walk = (n: number, prefix: number[]): void => {
    const kids = children.get(n) ?? [];
    if (!kids.length) result.push([...prefix, n]);
    else for (const kid of kids) walk(kid, [...prefix, n]);
  };
  for (const root of roots) walk(root, []);
  return result;
}

/** Reconstruct REST reply chains and classify their likely disposition. */
export function assembleThreads(
  comments: ReviewComment[],
  author: string,
  noiseBots: Set<string>,
  reviewerBots: Set<string>,
  states: Map<number, ThreadState> = new Map(),
  latestCommitAt: string | null = null,
): z.infer<typeof ThreadSchema>[] {
  const replies = new Map<number, ReviewComment[]>();
  for (const c of comments) {
    if (c.in_reply_to_id !== null) {
      replies.set(c.in_reply_to_id, [
        ...(replies.get(c.in_reply_to_id) ?? []),
        c,
      ]);
    }
  }
  return comments.filter((c) => c.in_reply_to_id === null).map((root) => {
    const chain = [
      root,
      ...(replies.get(root.id) ?? []).sort((a, b) =>
        a.created_at.localeCompare(b.created_at)
      ),
    ];
    const nodes = chain.map((c) => {
      const login = c.user?.login ?? "unknown";
      const authorType = login === author
        ? "author" as const
        : (noiseBots.has(login) || login.endsWith("[bot]") ||
            c.author_association === "BOT")
        ? "bot" as const
        : "human" as const;
      return {
        id: c.id,
        author: login,
        authorType,
        body: c.body,
        createdAt: c.created_at,
      };
    });
    const last = nodes.at(-1)!;
    const state = states.get(root.id);
    const reviewerLast = last.authorType === "human" ||
      reviewerBots.has(last.author);
    const status = state?.resolved
      ? "resolved"
      : last.authorType === "author" || !reviewerLast
      ? "likely_addressed"
      : latestCommitAt && latestCommitAt > last.createdAt
      ? "addressed_by_commit"
      : "likely_unaddressed";
    return {
      kind: "inline" as const,
      rootId: root.id,
      path: root.path,
      line: root.line,
      comments: nodes,
      lastCommenter: last.author,
      authorRepliedLast: last.authorType === "author",
      status,
      githubResolved: state?.resolved ?? false,
      githubOutdated: state?.outdated ?? false,
    };
  });
}

async function threadStates(
  repoSlug: string,
  number: number,
): Promise<Map<number, ThreadState>> {
  const [owner, name] = repoSlug.split("/");
  const states = new Map<number, ThreadState>();
  let cursor: string | null = null;
  do {
    const query =
      `query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$cursor){pageInfo{hasNextPage endCursor}nodes{isResolved isOutdated comments(first:1){nodes{databaseId}}}}}}}`;
    const args = [
      "gh",
      "api",
      "graphql",
      "-f",
      `query=${query}`,
      "-F",
      `owner=${owner}`,
      "-F",
      `name=${name}`,
      "-F",
      `number=${number}`,
    ];
    if (cursor) args.push("-F", `cursor=${cursor}`);
    const result = await commandRunner(args);
    if (!result.success) throw apiError("graphql reviewThreads", result);
    const GraphqlPageSchema = z.object({
      data: z.object({
        repository: z.object({
          pullRequest: z.object({
            reviewThreads: z.object({
              pageInfo: z.object({
                hasNextPage: z.boolean(),
                endCursor: z.string().nullable(),
              }),
              nodes: z.array(
                z.object({
                  isResolved: z.boolean(),
                  isOutdated: z.boolean(),
                  comments: z.object({
                    nodes: z.array(
                      z.object({ databaseId: z.number().int().positive() }),
                    ).max(1),
                  }),
                }),
              ),
            }),
          }),
        }),
      }),
    });
    let page: z.infer<
      typeof GraphqlPageSchema
    >["data"]["repository"]["pullRequest"]["reviewThreads"];
    try {
      page = GraphqlPageSchema.parse(JSON.parse(result.stdout)).data.repository
        .pullRequest.reviewThreads;
    } catch (error) {
      throw new Error(
        `GitHub GraphQL reviewThreads returned an invalid response: ${
          error instanceof z.ZodError
            ? z.prettifyError(error)
            : (error as Error).message
        }`,
      );
    }
    for (const node of page.nodes) {
      const id = node?.comments?.nodes?.[0]?.databaseId;
      if (typeof id === "number") {
        states.set(id, {
          resolved: !!node.isResolved,
          outdated: !!node.isOutdated,
        });
      }
    }
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    if (page.pageInfo.hasNextPage && !cursor) {
      throw new Error(
        "GitHub GraphQL pagination indicated another page without an end cursor",
      );
    }
  } while (cursor);
  return states;
}

type MethodContext = {
  globalArgs: z.infer<typeof GlobalArgsSchema>;
  logger: {
    info: (message: string, properties?: Record<string, unknown>) => void;
  };
  writeResource: (
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
};

/** Swamp model for detailed feedback reconstruction and optional PR diff context. */
export const model = {
  type: "@mgreten/github-pr-feedback",
  version: "2026.08.26.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    feedbackBundle: {
      description: "Reconstructed PR feedback threads and evaluation counts",
      schema: BundleSchema,
      lifetime: "7d" as const,
      garbageCollection: 20,
    },
    prContext: {
      description:
        "Detailed final-state PR diff and metadata used to evaluate feedback",
      schema: ContextSchema,
      lifetime: "7d" as const,
      garbageCollection: 20,
    },
  },
  methods: {
    fetchFeedback: {
      description:
        "Fetch and reconstruct detailed feedback for one PR or an optional Graphite stack",
      arguments: z.object({
        input: z.string(),
        repoSlug: RepoSlugSchema.optional(),
        nowIso: z.string().optional(),
      }),
      execute: async (
        args: { input: string; repoSlug?: string; nowIso?: string },
        context: MethodContext,
      ): Promise<{ dataHandles: Record<string, unknown>[] }> => {
        const repo = RepoSlugSchema.parse(
          args.repoSlug ?? context.globalArgs.repoSlug,
        );
        const numbers = parsePrNumbers(args.input);
        if (!numbers.length) {
          throw new Error(
            "No PR number found; provide a bare number, GitHub PR URL, or Graphite stack text",
          );
        }
        context.logger.info(
          "Fetching detailed feedback for {count} PRs in {repo}",
          { count: numbers.length, repo },
        );
        const prs: z.infer<typeof PrSchema>[] = [];
        for (const number of numbers) {
          const pr = await rest(
            `repos/${repo}/pulls/${number}`,
            PullRequestSchema,
          );
          const [comments, states, commits] = await Promise.all([
            rest(
              `repos/${repo}/pulls/${number}/comments?per_page=100`,
              z.array(ReviewCommentSchema),
              true,
            ),
            threadStates(repo, number),
            rest(
              `repos/${repo}/pulls/${number}/commits?per_page=100`,
              z.array(CommitSchema),
              true,
            ),
          ]);
          const latest = commits.map((c) =>
            c.commit?.committer?.date ?? c.commit?.author?.date
          ).filter(Boolean).sort().at(-1) ?? null;
          const threads = assembleThreads(
            comments,
            pr.user.login,
            new Set(context.globalArgs.botAuthors),
            new Set(context.globalArgs.reviewerBots),
            states,
            latest,
          ).filter((t) =>
            t.status !== "resolved"
          );
          const unaddressedCount =
            threads.filter((t) => t.status === "likely_unaddressed").length;
          const needsEvaluationCount = threads.filter((t) =>
            t.status === "likely_unaddressed" ||
            t.status === "addressed_by_commit"
          ).length;
          prs.push({
            number,
            title: pr.title,
            url: pr.html_url,
            author: pr.user.login,
            baseRef: pr.base.ref,
            headRef: pr.head.ref,
            threads,
            unaddressedCount,
            needsEvaluationCount,
          });
        }
        const data = {
          repoSlug: repo,
          fetchedAt: args.nowIso ?? new Date().toISOString(),
          prs,
          stacks: groupStacks(prs),
          totalUnaddressed: prs.reduce((n, p) => n + p.unaddressedCount, 0),
          totalNeedsEvaluation: prs.reduce(
            (n, p) => n + p.needsEvaluationCount,
            0,
          ),
        };
        const handle = await context.writeResource(
          "feedbackBundle",
          `feedback-${numbers.join("-")}`,
          data,
        );
        context.logger.info("Reconstructed {count} PRs", { count: prs.length });
        return { dataHandles: [handle] };
      },
    },
    gatherContext: {
      description:
        "Fetch PR metadata and a bounded final-state diff for detailed feedback evaluation",
      arguments: z.object({
        prNumber: z.number().int().positive(),
        repoSlug: RepoSlugSchema.optional(),
        nowIso: z.string().optional(),
      }),
      execute: async (
        args: { prNumber: number; repoSlug?: string; nowIso?: string },
        context: MethodContext,
      ): Promise<{ dataHandles: Record<string, unknown>[] }> => {
        const repo = RepoSlugSchema.parse(
          args.repoSlug ?? context.globalArgs.repoSlug,
        );
        context.logger.info("Gathering PR context for {number} in {repo}", {
          number: args.prNumber,
          repo,
        });
        const pr = await rest(
          `repos/${repo}/pulls/${args.prNumber}`,
          PullRequestSchema,
        );
        const files = await rest(
          `repos/${repo}/pulls/${args.prNumber}/files?per_page=100`,
          z.array(FileSchema),
          true,
        );
        let diff = "";
        let truncated = false;
        for (const file of files) {
          const section = `\n### ${file.filename}\n${
            file.patch ?? "(patch unavailable)"
          }\n`;
          if (
            new TextEncoder().encode(diff + section).length >
              context.globalArgs.maxDiffBytes
          ) {
            truncated = true;
            break;
          }
          diff += section;
        }
        const data = {
          prNumber: args.prNumber,
          title: pr.title,
          url: pr.html_url,
          body: pr.body ?? "",
          baseRef: pr.base.ref,
          headRef: pr.head.ref,
          diff: diff.trim(),
          diffTruncated: truncated,
          changedFiles: files.map((f) => f.filename),
          gatheredAt: args.nowIso ?? new Date().toISOString(),
        };
        const handle = await context.writeResource(
          "prContext",
          `context-${args.prNumber}`,
          data,
        );
        context.logger.info("Gathered context for PR {number}", {
          number: args.prNumber,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
