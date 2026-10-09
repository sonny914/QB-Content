# Content plan format

The JSON a writing session returns to QB Content. The app's "Copy planning prompt" asks for exactly this
shape; "Import plan" validates it and lists every problem before anything is changed.

Current: `format: "qb-content-plan"`, `version: 1`. A future version bumps `version`; the app refuses
versions it doesn't understand and says so.

```json
{
  "format": "qb-content-plan",
  "version": 1,
  "hooks": ["<opening line 1>", "<opening line 2>", "<opening line 3>"],
  "recommendedHook": 0,
  "script": "<the full narration: the scene narrations joined in order>",
  "scenes": [
    { "narration": "<the words spoken during this scene>", "visual": "<what is on screen>", "seconds": 4 }
  ],
  "claimsToVerify": ["<one concrete thing the owner must confirm before publishing>"]
}
```

| Field | Required | Rules |
|---|---|---|
| `format` | yes | Must be `"qb-content-plan"`. |
| `version` | yes | Must be `1`. |
| `hooks` | yes | 1–5 non-empty strings. The prompt asks for exactly 3; another count is a warning. |
| `recommendedHook` | no | Integer index into `hooks`. Defaults to `0`. |
| `script` | yes | Non-empty string: the full narration. |
| `scenes` | yes | 1–20 objects. Each needs `narration` (non-empty string), `visual` (non-empty string) and `seconds` (number, 0.5–300, kept to one decimal). Optional `kind` (`"asset"`, the default, or `"graphic"`) and `graphic` (below). The app assigns ids `s1`, `s2`, … in order. |
| `claimsToVerify` | no | Array of strings. Anything the narration relies on that did not come from the supplied inputs. Shown in the app as "verify before publishing". |

Unknown fields are ignored with a warning. Warnings never block an import; errors always do.

## Graphic scenes

A scene with `"kind": "graphic"` (or simply a `graphic` object) is drawn by the local renderer instead of
showing an uploaded file. The renderer understands only these properties; `visual` stays a description
for people.

```json
{
  "narration": "Day shift logs it, tries the easy fix, clocks out.",
  "visual": "Day shift's card",
  "seconds": 4,
  "kind": "graphic",
  "graphic": {
    "template": "card",
    "label": "Day shift",
    "headline": "Logged.",
    "support": "",
    "items": [{ "label": "Tried", "text": "The easy fix" }, { "label": "Then", "text": "Clocked out" }],
    "emphasize": 1,
    "gather": false
  }
}
```

| Property | Rules |
|---|---|
| `template` | `title` (headline, optional support), `card` (labelled card with items entering one by one), `notes` (separate notes scattered across the frame; `gather: true` makes them travel into one card mid-scene), `question` (closing question with an orange rule), `hero` (oversized type: the headline punches in at `land`, then shrinks up as `support` lands at `beat`), `device` (an uploaded screenshot or recording on a floating device card, optional push into `focus`), `presenter` (an uploaded clip of the owner to camera, full frame). Default `title`. |
| `headline` | Required, up to 90 characters. Wrapped and shrunk to fit the frame. |
| `support` | Optional, up to 160 characters. |
| `label` | Optional small-caps label such as "Morning", up to 24 characters. |
| `items` | Up to 4 `{ label, text }` entries (label ≤ 20, text ≤ 60 characters). `notes` needs at least one. |
| `emphasize` | `"headline"` or an item index. Lights that element orange just past the middle of the scene. |
| `gather` | `notes` only. |
| `theme` | `dark` (default: black ground, cream type) or `light` (cream ground with a faint dot grid and orange corner forms, black type). |
| `accent` | Space-separated words drawn in orange wherever they appear in the headline or support line. |
| `media` | `device` and `presenter` only: `asset` (default) takes the next uploaded image or clip; `placeholder` draws a labelled empty slot and never a stand-in picture. |
| `frame` | `device` only: `auto` (phone card for portrait media, desktop card for landscape), `phone`, `desktop`. |
| `focus` | `{ x, y, w, h }` fractions of the media to push into; the push runs over `zoom: { start, end }` seconds (default 0.4–1.6). |
| `land`, `beat` | `hero` only: seconds when the headline hits (default 0.3) and when the support line takes over (default mid-scene). |
| `captions` | Up to 12 cues `{ start, end, text, highlight }` in seconds from the scene start, drawn at the bottom with the `highlight` word in orange. Timing is set by hand or from the recording's pauses; nothing aligns them to speech automatically. |

Motion is fixed per template: fade-and-rise entrances (items staggered), the emphasis pulse, the
gather, and a short fade at the end. Colours are QB's black, cream and orange. Text always stays inside
the frame's safe area; a scene with more words than its seconds allow gets a warning (about three words
per second plus a settle-in second).

`docs/examples/handoff-reel-plan.json` is a complete plan built from graphic scenes only.
`docs/examples/style-test-plan.json` is the 10.4 s style test: hero → device (takes one uploaded recording) → presenter placeholder, with captions timed to the owner's recording.

## Where it goes

Importing a plan creates plan **v1** (or the next version if one exists; the app asks before replacing).
Editing a scene's narration, visual or seconds, choosing a different hook, or scaling the durations
creates the next plan version. Every plan change returns the reel to Draft and withdraws any approval.

A preview rendered from the plan records the plan version and the asset arrangement it was made from.
If the plan or the assignments change afterwards, the player says the preview is out of date and
approval is blocked until the preview is created again.
