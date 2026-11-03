# Agent notes

## Workflow: branch → PR

Never commit straight to `main`. For every change:

1. Create a branch named after the change (`feat/…`, `fix/…`, `ci/…`, `docs/…`).
2. Commit (Conventional Commits, below) and push the branch.
3. Open a pull request using `.gitea/pull_request_template.md`: Summary, Testing (tests added/changed), and the
   checklist (edge cases covered by tests, no regressions, optimized for efficiency/cost/systems).
4. The user reviews and merges. CI lints and tests the PR (`.gitea/workflows/checks.yml`); merging to `main` builds
   the image and deploys it (`.gitea/workflows/deploy.yml`).

## Commits

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

Types:

- `feat`: a new feature for the user
- `fix`: a bug fix
- `docs`: documentation-only changes
- `style`: formatting (white-space, semicolons) that doesn't change logic
- `refactor`: a change that neither fixes a bug nor adds a feature
- `perf`: a performance improvement
- `test`: adding or correcting tests
- `chore`: build tasks, dependencies, or configuration
- `ci`: CI workflows and the runner (`.gitea/workflows/`, `runner/`)

commitlint enforces this through a husky `commit-msg` hook.

Scopes are optional; use the area touched when it helps, e.g. `feat(dashboard):`, `fix(auth):`, `ci(runner):`.

## Tests

Every change comes with tests, and they must pass before anything deploys.

- For each change, think through its edge cases (empty, missing, zero, boundaries, bad input, branching data) and
  test them, not just the happy path.
- Pick the right level: unit tests for pure logic, integration tests where parts meet (server ↔ Gitea API,
  server ↔ the `claude` CLI and its stream-json log, page ↔ API data shape), and end-to-end or browser checks for
  user-facing flows. Say which levels you covered and what is still untested.
- When fixing a bug, add a test that fails without the fix.
- `npm test` runs `test/*.test.js` with Node's built-in runner. The server tests start the real server against a
  mock Gitea API and a fake `claude` CLI (`test/fixtures/`), so they cover HTTP routes, auth and whole task runs
  without network or a Claude login. They need Linux or macOS (node-pty); on Windows run them in Docker the way
  `checks.yml` does.
- `checks.yml` runs lint and tests on every PR; branch protection on `main` requires both to pass before merging.
- The dashboard's JavaScript has no automated tests. For UI changes, render the pages against a mock of the API
  (desktop light and dark, and a real 390px width) and look at the result.

## Lint and format

- Biome lints `src/` and `test/` (`biome.json`, recommended rules). `npm run lint` fails on warnings too. Fix lint
  errors rather than silencing them; a deliberate exception gets a `biome-ignore` comment with the reason.
- No formatter is enforced. Match the surrounding code: 2-space indent, single quotes, semicolons, ES modules.

## CI (Gitea Actions)

- Keep the job log readable: quiet on success, full output on failure. Gitea records live progress views
  frame by frame, so nothing should print one: `docker build --progress=quiet` with a `--progress=plain` rebuild
  if it fails, `docker push -q`, `docker compose pull -q` / `up --quiet-pull`, `COMPOSE_PROGRESS=quiet`, and the
  equivalent (quiet flags, no spinners) for any new step or tool.
- Builds must stay cacheable: don't use `--no-cache`. A layer that has to refresh (like the Claude Code install)
  gets a build arg with the version it should install.
