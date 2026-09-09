# Release checklist

Run through this before tagging a version — the right-sized version of a QA
process for a single-maintainer project (advance.md §8), not a full
release-engineering pipeline.

- [ ] `cd backend && .venv/bin/python -m pytest tests -q` passes in full.
- [ ] `cd frontend && npm run build` passes (typecheck + bundle) with no errors.
- [ ] `cd frontend && npm run build && npm run smoke` passes against a
      seeded, running instance.
- [ ] Migration tested against a copy of real data, not only the empty test
      database: run `./run.sh --seed`, take a `data/` copy, upgrade it with
      `alembic upgrade head`, confirm the app still starts and reads correctly.
- [ ] Export → import round-trip verified: export the seeded instance,
      import it into a second, empty instance, confirm the result matches.
- [ ] `CHANGELOG.md` has an entry for this release under a new version
      heading (move content out of `[Unreleased]`).
- [ ] `VERSION` file at the repo root is bumped to match the new tag.
- [ ] The priority-seven items from `advance.md`'s "Priority read" section
      are actually done, not merely planned, for anything this release
      touches.
- [ ] No secrets (`.env`, real data, API keys) are staged for commit —
      `git status` and a manual glance at the diff, on top of whatever the
      pre-commit secret-scanning hook already catches.
- [ ] Tag the release: `git tag -a vX.Y.Z -m "vX.Y.Z" && git push --tags`.
- [ ] Push to `main`, then deploy with `sudo artboard-ctl update` on the
      actual box, not by hand — the backup-before-migrate step only exists
      if that script is the thing that runs. `update` always deploys the
      tip of `main`, so the tag above is a changelog/version record, not a
      deploy target — make sure `main` is what you want live before running it.
