# Accounts and credits

## Account flow

New users submit a username and password. The pending queue has a default capacity of five requests; an administrator approves or rejects each request. The account becomes usable after approval. Administrators can create users, reset passwords, change roles, adjust credits and view aggregate usage.

Tracks, source materials, drafts, jobs, media downloads and personal backups are resolved through the signed-in user's workspace. A role change, password change or account disablement invalidates existing sessions. Mutating API requests require the current CSRF token.

## Credit flow

Each ordinary account receives 1,000 points at the Monday boundary in Asia/Shanghai. The quote is reserved when a paid job is accepted and settled once the result is known. If the exact upstream cost is unclear, the record stays available for administrator review. A positive remaining balance may be used once for a known operation costing at most ¥3; a successful charge brings that balance to zero. Administrator accounts have unlimited access under the same job ledger.

## Acceptance

- Cross-account media, export, material, collection and job identifiers do not return another user's data.
- Registration capacity and approval status remain consistent under concurrent requests.
- Repeated settlement does not charge twice; rollover and delayed refunds follow the appropriate week.
- Evidence: `tests/auth.test.ts`, `tests/registration.test.ts`, `tests/credits.test.ts`.
