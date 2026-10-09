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
| `scenes` | yes | 1–20 objects. Each needs `narration` (non-empty string), `visual` (non-empty string) and `seconds` (number, 0.5–300, kept to one decimal). The app assigns ids `s1`, `s2`, … in order. |
| `claimsToVerify` | no | Array of strings. Anything the narration relies on that did not come from the supplied inputs. Shown in the app as "verify before publishing". |

Unknown fields are ignored with a warning. Warnings never block an import; errors always do.

## Where it goes

Importing a plan creates plan **v1** (or the next version if one exists; the app asks before replacing).
Editing a scene's narration, visual or seconds, choosing a different hook, or scaling the durations
creates the next plan version. Every plan change returns the reel to Draft and withdraws any approval.

A preview rendered from the plan records the plan version and the asset arrangement it was made from.
If the plan or the assignments change afterwards, the player says the preview is out of date and
approval is blocked until the preview is created again.
