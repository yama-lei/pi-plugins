# Agent Guide

This repository develops a small Pi profile initializer and the separately packaged pi-better-ai extension. It is not a profile switcher, launcher, version manager, or sandbox.

## Current source of truth

- [README.md](README.md): supported commands, profile schema, installation behavior, limitations, and migration notes.
- [GLOSSARY.md](GLOSSARY.md): project terminology.
- `packages/*/package.json`: each extension's package name, entry point, published files, and host dependencies.
- The root `package.json` is a private npm workspace, not a publishable Pi package.

## Where to work

- `packages/pi-profile/profile.mjs`: validation, template registry, safe writes, local installation, and Markdown downloads.
- `packages/pi-profile/commands.mjs`: `/profile init`, `/profile sync`, `/profile-setup-with-llm`, and the confirmed `profile_save` tool.
- `packages/pi-profile/setup.mjs`: LLM guidance. It uses the current conversation and available search tools; it must not claim browsing occurred when it did not.
- `packages/pi-profile/index.ts`: thin Pi/TypeBox adapter. Keep host dependencies supplied by Pi, not bundled.
- `packages/pi-profile/profiles/`: schema-valid JSON examples, not automatically registered templates. Global registration is explicit and stores JSON only.
- `packages/pi-better-ai/`: independent npm package; installing pi-profile must not automatically enable it.
- `packages/*/tests/`: each package's tests and fixtures.
- `skills/` and `prompts/`: source content retained for reference, not automatically installed by either package. Their downstream instructions do not restrict development of this repository.
- For local Pi installation, use `packages/pi-profile/` or `packages/pi-better-ai/`, not the repository root.

## Behavioral rules

- Never publish, log in, or create tokens without explicit authorization. Keep release tooling local-only and gitignored; do not add release tests or README publishing instructions.
- Deploy resources only into the selected project. npm plugins use Pi's `--local`; skills use the Skills CLI's project copy mode; AGENTS.md is a raw HTTPS download at the project root.
- Global profile registration saves JSON under the agent directory's `profile-templates/`, never packages, skills, credentials, or global runtime settings.
- Keep Pi's native global resource loading and project-trust behavior. Do not silently add isolation, auto-approval, a launcher, or shared resource links.
- Preview and require interactive approval before saving or installing. The LLM setup must ask about workflows, verify original resource sources/compatibility, and ask whether a global template is wanted.
- Do not overwrite existing project profiles or global templates. Existing skills and AGENTS.md are skipped and reported; conflicting deployment symlinks are rejected. Preserve unrelated project settings and files.
- Validate inputs before side effects. Keep bounded HTTPS Markdown downloads; never treat HTML pages as raw Markdown. Pass command arguments as arrays, not interpolated shell strings.
- Report partial installation failures honestly; keep already installed resources. Do not invent rollback or merge guarantees.
- Use Pi's public APIs and documented reload lifecycle. Command contexts are invalid after reload; tool handlers queue the sync command rather than calling command-only reload APIs.
- Keep package sources unversioned in profiles, but bump npm package versions for releases. MCP, resource switching, Git revisions, and automatic updates are out of scope.

## Verification

```bash
npm run check
npm test
npm pack --dry-run ./packages/pi-profile
npm pack --dry-run ./packages/pi-better-ai
```

The root `npm test` runs both workspaces. To test one package, use `npm --prefix packages/pi-profile test` or `npm --prefix packages/pi-better-ai test`. Profile tests use temporary directories, mocked external commands, and mocked download responses; pi-better-ai tests reuse a local npm installation of Pi (or `PI_HOST_DIR`). Tests must not install real resources or modify personal Pi configuration. Use disposable projects/agent directories for native Pi loading checks. Consult installed Pi documentation and relevant examples before changing integration behavior.

## Documentation improvements

When agent-facing documentation contradicts code or contains mistakes, report the issue and ask before editing unless the user has already requested the relevant documentation changes. Update affected documentation and functional tests with behavioral changes.
