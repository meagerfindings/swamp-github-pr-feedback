# @mgreten/github-pr-feedback

This read-only model reconstructs complete inline GitHub review conversations, GitHub resolution state, and commit-based addressed signals. It complements `@mgreten/github-pr-feed`: use the feed to poll and deduplicate new activity, then use this extension when a workflow needs the full conversation and current diff to evaluate a finding.

## Installation

```sh
swamp extension pull @mgreten/github-pr-feedback
```

## Setup

Install and authenticate the `gh` CLI with read access to the target repository. `repoSlug` is required; there are no organization-specific defaults.

```sh
swamp model create @mgreten/github-pr-feedback pr-feedback --global repoSlug=acme/widgets
```

## Methods

### `fetchFeedback`

Accepts `input` (required: bare PR number, GitHub PR URL, or optional Graphite stack text), `repoSlug` (optional per-call override), and `nowIso` (optional deterministic timestamp). It writes one `feedbackBundle`.

```sh
swamp model method run pr-feedback fetchFeedback --input input=https://github.com/acme/widgets/pull/42
```

```sh
swamp model method run pr-feedback fetchFeedback --input input=42
```

### `gatherContext`

Accepts `prNumber` (required), `repoSlug` and `nowIso` (optional). It writes one `prContext` containing metadata, changed filenames, and a bounded final-state patch. This is independently useful when detailed feedback must be checked against current code; it intentionally does not poll activity or duplicate feed watermarks.

```sh
swamp model method run pr-feedback gatherContext --input prNumber=42
```

## Global arguments

| Name | Type | Default | Purpose |
|---|---|---|---|
| `repoSlug` | `owner/repository` | required | GitHub repository |
| `botAuthors` | string array | common CI bots | Non-review noise bots |
| `reviewerBots` | string array | `[]` | Bots whose feedback is actionable |
| `maxDiffBytes` | positive integer | `60000` | Context diff byte cap |

## Resource contracts

`feedbackBundle` records the repository, timestamp, PR metadata, reconstructed root/reply threads, GitHub resolved/outdated flags, stack chains, and `likely_unaddressed`/`addressed_by_commit` evaluation counts. Resolved threads are omitted. `prContext` records metadata, changed filenames, bounded patch text, and a truncation flag. Both resources live seven days with twenty retained versions. Classification is evidence for review, not proof that code is correct.

## Pagination and rate limits

REST list endpoints use `gh api --paginate --slurp` and flatten all pages. GraphQL review threads follow `pageInfo.endCursor` until `hasNextPage` is false. The extension does not retry internally because `gh` does not expose a stable `Retry-After` contract to subprocess callers. Rate-limit errors fail before any resource write and tell the caller to retry after GitHub's reset time. Schedule retries outside the model to preserve observable workflow behavior.

## Failure behavior

Malformed stack text with no PR number fails before network access. Authentication, permission, malformed JSON, missing pagination cursors, and REST or GraphQL failures throw actionable errors and produce no partial resource. A missing patch is represented as `(patch unavailable)`; exceeding the configured cap sets `diffTruncated`. `gh auth status` is the recommended setup check.

## License

MIT — see LICENSE.txt for details.
