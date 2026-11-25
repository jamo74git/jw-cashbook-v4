# Project continuity — READ ME FIRST, every session

This is an ONGOING, multi-session project (OAC Cashbook). Work may resume on a different
device as long as this workspace folder is present (via OneDrive sync and/or the git repo
`github.com/jamo74git/jw-cashbook-v4`).

## At the START of every session, before acting
- Read **`PROJECT-LOG.md`** at the workspace root. Its **CURRENT STATE** section is the
  authoritative snapshot (branch/commit, what is applied to the backend, what is pending,
  next steps). The **SESSION JOURNAL** below it is the dated history (newest first).
- Also honour the other steering files (environment-context, tech/steering conventions).
- Reconcile the log against reality with cheap read-only checks (e.g. `git log`,
  `git status`, and — only if a specific fact is needed — a read-only backend query).

## After meaningful progress, and at session end
- Rewrite **CURRENT STATE** so it matches reality, and PREPEND a short dated entry to the
  **SESSION JOURNAL** (what changed, what was applied to the backend, what is next). Keep
  each entry concise — a handful of lines, not a transcript.
- Commit it; push when the user allows (git is the real cross-device backup, not OneDrive).

## Share the Vercel link after significant pushes
- After a successful push of significance that needs user testing, post the Vercel
  Preview URL for the branch as a plain clickable link in the chat, with a one-line note
  of what to test. Repeat on every such push. The link is stored in `PROJECT-LOG.md`
  (CURRENT STATE, "Vercel Preview URL"). If it is not recorded, ask the user once.

## Keep it small — archive rule
- When `PROJECT-LOG.md` exceeds ~40 KB or ~12 journal entries, move the OLDEST entries into
  `.kiro/project-log-archive/PROJECT-LOG-<oldest-date>_to_<newest-moved-date>.md` and leave
  a one-line pointer in the journal. Never let the live log sprawl.

## Never store secrets in the log or archives
No passwords, no access tokens, no service-role key. Those live only in local `.env.local`
(gitignored) and must be re-provided on a new device. The log should *name* the dependency,
never the value.
