## What and why

<!-- What does this change, and why? Link the issue if there is one. -->

## Checks

- [ ] `npm run check` (eslint, prettier, tsc, vitest)
- [ ] `npm run test:py` (pytest), `ruff check .` and `pyright` (0 errors)
- [ ] `npx playwright test` for UI changes (app running, `E2E_BASE_URL` set if not on :3000)
- [ ] A test that would have caught the bug / covers the new behaviour
- [ ] UI texts in both `apps/web/src/lib/i18n/da.ts` and `en.ts`
- [ ] Old projects, databases and `performance.json` still load (schema / migration)
- [ ] No API keys or tokens can reach the browser, the logs, project data or exports
- [ ] `CHANGELOG.md`: user-visible changes added under **Unreleased**
- [ ] New or changed dependency: permissive licence, listed in `docs/licensing.md`
      (the installer's `THIRD_PARTY_NOTICES.txt` is generated from what is installed)
