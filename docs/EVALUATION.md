# Evaluation record

**Checked on 9 October 2026 (Asia/Shanghai)** against this public snapshot. Local verification used Node.js 24.11.1, pnpm 11.25.0 and FFmpeg `N-118038-g8629306627-20241210` on Windows. The GitHub workflow runs the same lint, build, test and evaluation commands on Linux.

## Reproduce

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm build
pnpm test
pnpm eval
```

`pnpm test` reported **13/13 test files and 128/128 tests passed**. It covers authenticated API and media access, registration approval, wallet settlement, source preparation, job recovery, save retries, crop operations, audio format handling, uploads and backup/restore. The suite uses a local SQLite database and a deterministic provider fixture.

## Focused scenarios

`evaluation/run.ts` is a small executable evaluation, separate from the regression suite:

| Scenario | Procedure | Observed result |
| :--- | :--- | :--- |
| Submission replay | Send the same validated request ID through Fastify's HTTP injection 100 times | 100 accepted responses; **1 stored job, 1 reservation** |
| Conflicting replay | Reuse that ID with a changed prompt | HTTP **409** |
| Saved audio duration | Pass a generated 8,000 ms WAV through the normal processing function | **3,000 ms** output; 5,000 ms removed |
| Original preservation | SHA-256 the WAV before and after processing | Hash unchanged |

The task worker is intentionally not started in the replay scenario; that measurement checks the submission and reservation boundary. It is not a provider throughput benchmark. The audio fixture is a generated 220 Hz sine wave and needs FFmpeg/FFprobe. The command prints JSON; the checked-in [results file](../evaluation/results.json) records this run.

The regression suite also exercises the same audio rule on WAV, MP3, FLAC and M4A, and checks MP3 duration at 44.1 and 48 kHz. Account tests create separate users and verify that guessed track, media, export and material IDs do not cross workspaces. Credit tests cover repeated settlement, weekly refresh and non-negative balances.

## Real music and repeatable tests

The [live demo](https://chenglan-mureka-platform.chenglan.tech/demo) contains two complete Mureka-created tracks with their saved prompts and settings. They demonstrate the listening experience. Evaluation uses local fixtures so anyone can rerun it without spending API credit or accessing a private account.
