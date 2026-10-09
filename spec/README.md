# Product specifications

This directory presents the design and acceptance rules used to develop the music workspace. It distills the original project plan and version-by-version implementation decisions into a small public set that can be checked against the current code.

| Specification | Main decisions | Evidence |
| :--- | :--- | :--- |
| [Creation and task lifecycle](CREATION.md) | Inputs, idempotency, provider work, saved results and recovery | `tests/app.test.ts`, `tests/creative-tools.test.ts`, `pnpm eval` |
| [Accounts and credits](ACCOUNTS.md) | Approval, personal workspaces, sessions, weekly allowance and settlement | `tests/auth.test.ts`, `tests/registration.test.ts`, `tests/credits.test.ts` |
| [Audio and editing](AUDIO.md) | Immutable source, processed copies, crop, lyrics and formats | `tests/postprocess.test.ts`, `tests/crop-audio.test.ts`, `tests/library-tools.test.ts` |

Each specification states the expected user behavior, the data that must persist and the acceptance checks. The [architecture](../docs/ARCHITECTURE.md) explains where those responsibilities live; the [evaluation record](../docs/EVALUATION.md) gives the observed results for this public snapshot.
