# Creation and task lifecycle

## User flow

The user may start from a prompt, supplied lyrics, an instrumental idea or an existing source track. Before submission, the UI validates the selected mode and saves the draft. A submitted task appears in the creation record, with its own status and provider identifier. Successful results join the private library and retain their source relationship for further edits.

## Execution rules

1. Validate input with the shared schema and resolve any source material in the requesting user's workspace.
2. Generate a client submission ID. Persist the job, draft and initial credit reservation in one transaction.
3. Return the existing job for a repeated ID with identical input; return a conflict if its input differs.
4. Submit to Mureka only after local preparation succeeds. Persist the provider task ID before polling.
5. Save outputs and related lyrics locally. A save retry resumes from the existing provider result.
6. After restart, continue eligible queued, running or saving tasks from persisted state.

## Acceptance

- Replaying one ID 100 times produces one job and one credit reservation in the [offline evaluation](../evaluation/run.ts).
- Job recovery, provider status changes, download retry and source ownership are covered by `tests/app.test.ts`, `tests/creative-tools.test.ts` and `tests/composition-tools.test.ts`.
