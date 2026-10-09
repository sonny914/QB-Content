# Quiet Bands Content

A platform for brand setup, content planning, video previews, revisions,
approvals and, eventually, social publishing.

Status: project setup only. No dependencies, screens or service connections yet.

## First milestone: one QB reel, brief to download

Move a single Quiet Bands reel through the full loop:

1. **Brief**: capture what the reel is for, who it's for, the message, and
   which existing assets and recorded voice it should use.
2. **Preview**: produce a viewable preview of the reel.
3. **Revision**: collect feedback against the preview and produce a revised
   version. Each revision is kept, not overwritten.
4. **Approval**: an explicit approve or reject step, recorded with who
   approved and when.
5. **Download**: the approved reel can be downloaded as a final file.

Done means one real QB reel has been through every step end to end. Until a
step has a real implementation, it uses clearly labelled mock data or
simulated integrations.

## Later milestones (not started)

- **Social account connections**: link the brand's social accounts.
- **Scheduled publishing**: queue approved content to go out at set times.
- **Client workspaces**: separate brands, content and approvals per client.
- **Billing**: charge clients for the platform or the work.

Each of these touches external services, money or public posting, so each
needs explicit approval before any work begins (see `CLAUDE.md`).

## Dependencies under consideration

### Ootto content-skills

- A **potential** dependency. Nothing has been cloned, vendored or installed.
- It is MIT-licensed. If we reuse any of it, we keep its license file and
  copyright notice and record where the code came from.
- It is **not** the source code for Ootto's hosted platform. Using it gives us
  the content skills only, not a copy of their product. Anything the hosted
  platform does beyond those skills, we build ourselves or don't have.
