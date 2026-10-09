# CLAUDE.md: rules for working on Quiet Bands Content

See `PROJECT.md` for what we're building and the milestone order.

## How we work

- Work in small steps. Do only the step that was asked for, then stop and
  report. Don't start the next step on your own.

## Hard rules

### Money, credits and anything public

- Never spend credits, call paid generation APIs, purchase services, publish
  content or deploy without explicit approval from the owner, given for that
  specific action.
- **Higgsfield: only 50 credits exist.** Treat that as a hard limit, not a
  budget to use. Having credits is never permission to spend them. Before any
  Higgsfield call that could cost credits, state the expected cost and wait
  for a yes.
- Approval for one action doesn't carry over to the next one.

### Assets

- Prefer existing assets and the owner's recorded voice over generating new
  media.

### Licenses

- When reusing upstream code (e.g. Ootto content-skills, MIT), keep its
  license file and copyright and attribution notices, and note the source.

### Secrets

- Never put secrets (API keys, tokens, passwords, service credentials) in
  browser or client code. They belong server-side only.
- Never commit secrets to Git. Use local env files, which `.gitignore`
  excludes, and commit only an example file with placeholder values.

### Mock data

- Clearly label all mock data and simulated integrations, in code and in the
  UI, so nothing fake can be mistaken for real.
