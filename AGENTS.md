# Agent Guide

This repository is an npm workspace of independently packaged Pi extensions under `packages/`. Package-specific behavior, limits, and development constraints live in each package's own README, listed in the table in [README.md](README.md).

## Current source of truth

- [README.md](README.md): package index and repository-level notes.
- `packages/<name>/README.md`: that package's commands, behavior, limitations, and development constraints. Read it before changing the package.
- `packages/*/package.json`: each extension's package name, entry point, published files, and host dependencies.
- The root `package.json` is a private npm workspace, not a publishable Pi package.

## Where to work

- `packages/<name>/`: one independent npm package per directory. Installing one package must not automatically enable another.
- `packages/*/tests/`: each package's tests and fixtures.
- `skills/` and `prompts/`: source content retained for reference, not automatically installed by any package. Their downstream instructions do not restrict development of this repository.
- For local Pi installation, use a package directory (`packages/<name>/`), not the repository root.

## Behavioral rules

- Never publish, log in, or create tokens without explicit authorization. Keep release tooling local-only and gitignored; do not add release tests or README publishing instructions.
- Keep Pi's native global resource loading and project-trust behavior. Do not silently add isolation, auto-approval, a launcher, or shared resource links.
- Validate inputs before side effects. Pass command arguments as arrays, not interpolated shell strings.
- Use Pi's public APIs and documented reload lifecycle. Keep host dependencies supplied by Pi, not bundled.
- Bump npm package versions for releases.
- Commit codes when a feature is done.

## Verification

```bash
npm run check
npm test
npm pack --dry-run ./packages/<name>   # for each package
```

The root `npm test` runs every workspace. To test one package, use `npm --prefix packages/<name> test`. Tests must not install real resources or modify personal Pi configuration; use disposable projects/agent directories for native Pi loading checks. Consult installed Pi documentation and relevant examples before changing integration behavior.

## Documentation improvements

When agent-facing documentation contradicts code or contains mistakes, report the issue and ask before editing unless the user has already requested the relevant documentation changes. Update affected documentation and functional tests with behavioral changes.