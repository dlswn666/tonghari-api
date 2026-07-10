# Development Rules

## Branch Flow

1. Start every change from the repository default branch (`master` for this repo, `main` where applicable).
2. Fetch the remote default branch before starting work.
3. Create a dedicated work branch from the up-to-date default branch.
4. Do all implementation, dependency, and verification work on the work branch.
5. Before completion, fetch the remote default branch again and merge it into the work branch.
6. Resolve conflicts on the work branch and rerun required checks.
7. Switch back to the default branch, merge the completed work branch, and push the default branch.

## Verification Flow

1. Run dependency/security checks when package files change.
2. Run type checks before build.
3. Run build before merging into the default branch.
4. Run focused tests for changed behavior when practical.
5. Do not merge or push if security audit, type-check, or build fails.

## Multi-Agent Flow

1. Use a planning agent for risk, dependency, and sequencing review.
2. Use code-part agents only with clear file/module ownership.
3. Use a verification agent after implementation to review diffs and check command results.
4. Integrate agent work on the main work branch and resolve inconsistencies before final verification.
