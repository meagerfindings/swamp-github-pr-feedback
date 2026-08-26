import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.14";
import {
  apiError,
  assembleThreads,
  flattenRestPages,
  groupStacks,
  parsePrNumbers,
  RepoSlugSchema,
  type ReviewComment,
} from "./github_pr_feedback.ts";

const comment = (
  id: number,
  login: string,
  reply: number | null = null,
  at = `2026-08-25T00:00:0${id}Z`,
): ReviewComment => ({
  id,
  in_reply_to_id: reply,
  user: { login },
  path: "src/index.ts",
  line: 4,
  body: "Please handle this case",
  created_at: at,
});

Deno.test("REST pagination flattens every page", () =>
  assertEquals(flattenRestPages<number>("[[1,2],[3]]"), [1, 2, 3]));
Deno.test("REST pagination rejects malformed shape", () => {
  assertThrows(() => flattenRestPages("{}"), Error, "invalid");
});
Deno.test("API failures preserve operation and rate-limit recovery", () =>
  assertEquals(
    apiError("repos/acme/widgets/pulls/42", {
      success: false,
      stdout: "",
      stderr: "HTTP 429 rate limit exceeded",
      code: 1,
    }).message.includes("Retry after GitHub's reset time"),
    true,
  ));
Deno.test("optional Graphite stack parsing and malformed input", () => {
  assertEquals(
    parsePrNumbers(
      "[#42](https://app.graphite.com/github/pr/acme/widgets/42)\n[#41](https://app.graphite.com/github/pr/acme/widgets/41)",
    ),
    [42, 41],
  );
  assertEquals(parsePrNumbers("not stack data"), []);
});
Deno.test("GitHub URLs and bare PRs parse", () => {
  assertEquals(parsePrNumbers("https://github.com/example/tools/pull/17"), [
    17,
  ]);
  assertEquals(parsePrNumbers("9"), [9]);
  assertEquals(
    parsePrNumbers("ordinary prose mentions #99 but is not a stack"),
    [],
  );
});
Deno.test("repository slugs reject paths, queries, and fragments", () => {
  assertEquals(RepoSlugSchema.parse("example/widgets"), "example/widgets");
  for (
    const value of [
      "example/widgets/extra",
      "example/widgets?x=1",
      "example/widgets#main",
      "../widgets",
    ]
  ) assertThrows(() => RepoSlugSchema.parse(value));
});
Deno.test("GraphQL states reconstruct reply threads and resolution", () => {
  const states = new Map([[1, { resolved: true, outdated: false }]]);
  const threads = assembleThreads(
    [comment(1, "reviewer"), comment(2, "author", 1)],
    "author",
    new Set(),
    new Set(),
    states,
  );
  assertEquals(threads[0].comments.length, 2);
  assertEquals(threads[0].status, "resolved");
});
Deno.test("classification distinguishes author reply, commit, and open feedback", () => {
  assertEquals(
    assembleThreads(
      [comment(1, "reviewer"), comment(2, "author", 1)],
      "author",
      new Set(),
      new Set(),
    )[0].status,
    "likely_addressed",
  );
  assertEquals(
    assembleThreads(
      [comment(1, "reviewer")],
      "author",
      new Set(),
      new Set(),
      new Map(),
      "2026-08-25T00:01:00Z",
    )[0].status,
    "addressed_by_commit",
  );
  assertEquals(
    assembleThreads([comment(1, "reviewer")], "author", new Set(), new Set())[0]
      .status,
    "likely_unaddressed",
  );
});
Deno.test("stack reconstruction handles branches", () =>
  assertEquals(
    groupStacks([{ number: 1, baseRef: "main", headRef: "one" }, {
      number: 2,
      baseRef: "one",
      headRef: "two",
    }, { number: 3, baseRef: "one", headRef: "three" }]),
    [[1, 2], [1, 3]],
  ));
