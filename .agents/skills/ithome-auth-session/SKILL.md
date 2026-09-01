---
name: ithome-auth-session
description: Bootstrap or recover the Playwright Microsoft Edge login session for iT Ironman publishing. Use when storageState is missing or expired, Facebook OAuth is required, login identity cannot be verified, or the site returns an authentication failure; do not use for draft or publish mutations.
---

# iT authentication session

Use the repository scripts for session handling; never copy cookies from the user's everyday Edge profile.

## Boundary

- The TypeScript `auth-bootstrap` CLI owns browser launch and storageState serialization.
- The user must complete Facebook OAuth, credentials, MFA, CAPTCHA, or consent screens manually. Never automate those steps.
- This skill decides whether reauthentication is needed and verifies the result. It does not create drafts or publish.

## Workflow

1. Confirm `infra/.env` uses `BROWSER_CHANNEL=msedge` and `HEADLESS=false`. The live site has returned 403 to headless Edge.
2. Run `task auth` from the repository root.
3. Ask the user to complete authentication in the new Playwright Edge window and return to the iT homepage.
4. Only after the user confirms completion, let the CLI save `infra/.auth/storage-state.json`.
5. Run `task draft:preview DAY=N` as the non-mutating session check.
6. If exit code 3 recurs, inspect diagnostics before asking the user to log in again; a selector or 403 failure is not necessarily session expiry.

The auth file is a credential. Verify it remains ignored by Git, and never print, commit, upload, or share its contents.
