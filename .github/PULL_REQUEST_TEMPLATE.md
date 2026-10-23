## What changed

<!-- One paragraph. Link the issue if there is one. -->

## Why

<!-- The problem this solves, and what happens without it. -->

## Checks

- [ ] `npm run typecheck`
- [ ] `npm run test:unit`
- [ ] `npm run acceptance:base` (for build, CSP, service or browser-visible changes)
- [ ] `npm run test:browser:byok` (for `src/lib/ai.ts`, settings or request-body changes)
- [ ] No credentials, personal data or third-party confidential material in the diff
- [ ] `npm run notices` re-run and its output committed (if dependencies changed)
