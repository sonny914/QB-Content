# Upstream review: Ootto content-skills

Inspection only. Nothing from this repository has been copied into QB Content, installed, or
activated. The clone was made to a temporary directory outside this repo and its installer was not run.

## Source

| | |
|---|---|
| URL | https://github.com/Ootto-AI/claude-content-skills |
| Commit inspected | `5263be7b209fee3f98a59ec185446b8144bca88f` |
| Commit date | 2026-10-08 14:40:45 +0530 |
| Commit message | `feat(skills): add viral-carousel - find the carousels your niche saved, then build yours on their structure` |
| Plugin version | `claude-content-skills` 1.4.0 (`.claude-plugin/plugin.json`) |
| History | 39 commits |
| Size | 69 files: 43 skills, 3 PNGs, `install.sh`, one Python script |

Re-check this commit before reusing anything. The repo changes often: `reel-builder` and
`content-factory` were both rewritten on 2026-07-13.

### This is not Ootto's hosted platform

The repo holds prompt files only. The README says plainly that these skills are "the manual,
do-it-yourself version" and that "[Ootto] is the autopilot". There is no server, database, UI, auth,
queue, renderer, or publishing code here. The commit history backs this up. Commit `feab070` mentions
Ootto MCP tools (`dissect_reel`, `reel_create`, `reel_post`, `autoreply`). The next commit, `e284e4e`,
removed them in favour of "Apify + Remotion + Composio directly (no Ootto MCP wrapper)". Those hosted
tools are Ootto's private product, and none of their code is in this repo.

## License and notices

- **License:** MIT, `Copyright (c) 2026 Ootto` (`LICENSE`). Every skill's frontmatter also says
  `license: MIT` and `author: Ootto`.
- **No NOTICE file and no bundled third-party license files.**
- **One bundled third-party work:** `skills/agent-reach/` is "vendored from Panniantong/Agent-Reach
  (MIT)". The only credit is a line of prose inside its `SKILL.md`. Its license text and copyright line
  are not included. If we ever want any of it, we should take it from
  https://github.com/Panniantong/Agent-Reach with that project's own LICENSE, not from Ootto's copy.
  For milestone 1 we don't need it.

### What we must preserve if we reuse anything

1. The full MIT text with `Copyright (c) 2026 Ootto`, kept with the reused material. The proposed
   location is `third_party/ootto-content-skills/LICENSE`.
2. A source note next to it with the upstream URL, the commit above, which files we took, and what we
   changed.
3. The `license: MIT` and author attribution in any adapted skill's frontmatter. We can add our own
   name as the adapter.

### Not required, and not recommended

- The "Built by Ootto — Book a demo" marketing footers. MIT doesn't require them. A one-line
  attribution is enough.
- `assets/banner.png`, `assets/star.png`, `assets/workflow.png`. These are Ootto's branding, and MIT
  doesn't license their trademark. Don't reuse them.
- Ootto's pricing, product claims and published view counts ("36,369 views", "$599 done-for-you tier",
  "$20 self-serve"). These are their business facts, not ours. Using them would also break our own rule
  against putting unverified numbers on screen.

## The six skills reviewed

| Skill | What it is | Executable code? | External services it names |
|---|---|---|---|
| `ai-brain` | A prompt for saving session notes to an Obsidian vault and recalling them | No | Filesystem MCP pointed at a local Obsidian vault (free, local) |
| `reel-analyzer` | A prompt template for tearing down someone else's viral reel: hook, beats, pacing, visuals | No | Relies on `agent-reach` (yt-dlp, Whisper via Groq, Exa/Jina) to get the video or transcript |
| `viral-hook-writer` | A prompt: 10 hooks under 12 words across 7 angles, each with on-screen text, top 3 flagged | No | None |
| `reel-scripter` | A prompt: 30–45s script in a hook / context / value / payoff+CTA structure, two columns (spoken \| on-screen), about 140 words, one B-roll idea per beat | No | None |
| `reel-builder` | A prompt for a beat-by-beat build table, plus a "render harness" section of rules | No | Seedance via **Runway** (RunwayML SDK), **Remotion** |
| `content-factory` | An orchestrator prompt that runs the others in order, 3× a day | No | **Apify** MCP, **Composio** MCP → **Instagram** (post + DM), Remotion, Runway |

The only executable files in the whole repo are `install.sh` and `skills/hook-mining/mine_hooks.py`.
`hook-mining` is a CSV hook ranker and isn't one of the six we reviewed.

## External services and potentially paid operations

| Service | Named in | What it would do | Cost / risk |
|---|---|---|---|
| Runway (Seedance `seedance2`, image-to-video) | reel-builder, content-factory | Generate ~5s acting clips | **Paid.** Upstream estimates "$6–12 per reel". Needs an API key. |
| Remotion | reel-builder, content-factory | Render text/graphic beats to MP4 in code | Upstream calls it "$0". **Check Remotion's own license before adopting it:** it isn't plain open source, and companies above a small size need a paid company license. |
| Apify MCP | content-factory | Scrape and tear down a model reel | Account required. Usage-billed beyond a free allowance. |
| Composio MCP → Instagram | content-factory | **Publish posts**; auto-reply to comments and send DMs, 24/7 | Account plus an Instagram connection. **Public, irreversible actions.** Against our rules without per-action approval. |
| agent-reach toolchain (yt-dlp, Whisper via Groq, Exa, Jina, bili-cli) | reel-analyzer (indirect) | Download other creators' reels and transcribe them | Free tiers or keys. Raises content rights questions. Its SKILL.md tells the agent to fetch and follow install instructions from a remote URL. |
| Obsidian + Filesystem MCP | ai-brain | Local memory | Free and local |
| Claude itself | all | Text generation | Normal usage cost |

**Higgsfield isn't referenced anywhere in the upstream repo.** Nothing here would spend Higgsfield
credits. That only becomes a risk if we wire Higgsfield in ourselves.

### Installer warning

`install.sh` copies **all 43 skills** into the global `~/.claude/skills/`, not into a project. That
includes `agent-reach`, whose description says "MUST USE" on any URL or research request. Installing
it would change agent behaviour in every project, including the live Quiet Bands site. Don't run it.
If we adopt anything, we copy single adapted prompts into this repo by hand, with notices.

## What's implemented vs. only described in prompts

Nothing in the six skills is implemented as software. Each is a Markdown prompt that Claude reads.
The gap between what the prompts claim and what the repo contains:

| Claim in the prompt | What actually exists |
|---|---|
| reel-analyzer: Claude "watches the whole thing — frame by frame" | No frame extraction or transcription code. Someone has to supply frames and a transcript. |
| content-factory: "This runs for REAL … it is a harness, not a description" | It's a prompt. Everything real depends on the user connecting Apify, Composio/Instagram and a Remotion install, none of which the repo provides. |
| reel-builder: "actually RENDER the reel → a real mp4" | No Remotion project, no compositions, no Runway calls, no VO alignment code. The render section is a list of rules. |
| reel-builder: sync cuts to VO word timestamps | No transcription or alignment code |
| reel-builder: "watch and measure playback… extract frames at ~12fps… autocorrelation" | No verification code. It's a checklist. |
| content-factory: comment → DM lead loop, 24/7 | Entirely external (Composio). Not in this repo. |
| ai-brain: permanent memory | A note-writing convention. Storage is the user's own Filesystem MCP. |

What **is** real and useful is the craft guidance: the script structure, the beat table format, and
hard-won rules like "sync to the voiceover, not the clock", "progressive action, never ping-pong
loops", "high-contrast emphasis text", "no fabricated numbers" and "watch the render before
shipping". That's knowledge we can adopt. It isn't a pipeline.

## Smallest useful subset for milestone 1

Milestone 1 flow: **brief → script → existing assets + recorded voice → video preview → revision →
approval → download.**

| Our step | Upstream help | Take | Leave |
|---|---|---|---|
| Brief | None directly. reel-builder's input list (topic, voice, CTA) is a starting point. | Field ideas only | — |
| Script | **reel-scripter** (core). **viral-hook-writer** as an optional sub-step for the opening line. | Structure, two-column spoken \| on-screen format, ~140-word budget, B-roll per beat. 10 hooks → pick one. | "Follow/DM/comment" growth framing where it doesn't fit QB |
| Existing assets + recorded voice | **reel-builder** build table: `# \| spoken line \| on-screen text \| visual \| ~secs` | Use the table as the shot list that maps each beat to **an existing asset** and **a segment of your recorded VO** | Seedance/Runway generation, character-acting beats |
| Video preview | reel-builder's render rules (sync to VO, readable text, front-loaded hook, watch before ship) | The rules as acceptance criteria for a preview | Remotion as a decision. Picking a renderer is a separate step that needs a license check. |
| Revision | None upstream | — | — |
| Approval | None upstream (content-factory only has "pause for my OK" before posting) | — | — |
| Download | None upstream | — | — |

**Not needed for milestone 1:**
- `content-factory`: built around Apify scraping and Composio/Instagram publishing and DMs, which is
  out of scope until the later social milestones and needs explicit approval.
- `reel-analyzer` and `agent-reach`: modelling other creators' reels means downloading third-party
  content. QB starts from its own brief and assets.
- `ai-brain`: brand memory for QB can be plain files in this repo. The Obsidian/MCP setup adds nothing
  yet.

**Net:** upstream covers the **script** step (two prompts) plus a **rules checklist** for the preview.
Brief capture, asset/voice mapping, rendering, revisions, approvals and download all have to be built
by us. Reusing two prompts means copying two adapted Markdown files plus the MIT notice. We need no
code or dependencies from this repo.

## Open questions for the owner

1. Do we adopt the reel-scripter and viral-hook-writer prompts (adapted, with notices), or just borrow
   the structure and write our own?
2. How will the preview be rendered (Remotion vs. ffmpeg vs. something else)? This needs its own
   decision, including a Remotion license check.
3. Where do the existing QB assets and voice recordings live, and in what formats?
