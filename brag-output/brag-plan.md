# Brag Plan: SupOps

## What is this app?
A self-hosted AI SRE that actually fixes your servers — it investigates a problem from real evidence and acts, while every risky command stops and waits for a human's approval.

## The angle
Everyone ships "agentic AI ops" now. The scary part is obvious: an AI with root on prod. SupOps' whole pitch is the guardrail — it will investigate and fix, but it physically stops before anything risky and shows you the exact command. "Give it root. Keep control." Confident, product-film tone; the money shot is the approval gate.

## Hook (first 2-3s)
Black. The ⚡ SupOps mark snaps in with one line: "An AI SRE that actually fixes things." Fast-in, hold.

## Key moments (the middle)
- Investigate: a real problem is typed into the box — "checkout is returning 500s since 14:20".
- Live work: read-only commands stream in a terminal, each tagged green "read-only", running instantly.
- The gate: a state-changing command (`systemctl restart checkout`) appears with an amber "RISK: HIGH — waiting for approval" badge; a cursor clicks Approve and it flips green "approved · ran". This is the point of the product.

## Outro / punchline
"Give it root. Keep control." over the ⚡ SupOps logo; small line: "self-hosted · open source".

## User flow worth showing
Investigate (type the symptom) → agent runs read-only checks live → proposes a risky fix → human approves → it runs. entry → key action → result.

## Tone
- Preset: polished
- Creative direction: quiet, confident product film for a serious infra tool
- Interpretation: few scenes, longer holds, restrained motion; confidence through calm, not chaos.

## Format: landscape — 1920x1080
## Duration: ~19s

## Visual identity (from the project)
- Background: #08090F (near-black NOC ground)
- Accent: #0A84FF (SupOps blue)
- Text: #F5F7FA
- Risk colors: green #32D74B (read-only/ok), amber #F5A623 (medium/pending), red #FF453A (high)
- Display font: system-ui stack (app uses Outfit); Body/mono: ui-monospace stack (app uses JetBrains Mono)
- Strongest visual: the dark UI + the risk/approval gate

## Share copy (draft)
Introducing SupOps: a self-hosted AI SRE that investigates and fixes your servers — and stops for your approval before anything risky. Give it root, keep control.

## Audio direction
- Role: warm, understated corporate bed
- Music: assets/music/track.mp3 (happy-beats business), low volume, ends with the video
- Music treatment: quiet bed at ~0.45; the visuals lead, music supports
- Audio-reactive treatment: none (polished restraint)
- SFX posture: none in v1 (keep it clean)
- Restraint rule: music must never overpower; no beat-chasing motion

## Storyboard
### Scene 1 — Hook — 3.2s
⚡ SupOps wordmark scales/fades in center; subline "An AI SRE that actually fixes things." fades under it. Hold.
Transition: soft → Scene 2

### Scene 2 — Investigate — 4.0s
An "Investigate" card: label "WHAT'S WRONG?", a textarea where the line types out "checkout is returning 500s since 14:20", target chips prod/uat, a blue "Start" button.
Sequential/interaction: text types into the box; Start button emphasises at end.
Transition: soft → Scene 3

### Scene 3 — Live work — 4.2s
A terminal window; three read-only commands appear one by one, each with a green "read-only" tag, then a checkmark.
Sequential: 3 command rows arrive one by one (held readable).
Transition: soft → Scene 4

### Scene 4 — The gate — 4.6s
An approval card: command `systemctl restart checkout`, amber badge "RISK: HIGH · waiting for approval". A cursor glides to "Approve & run" and clicks; the badge flips green "approved · ran".
Sequential/interaction: simulated cursor click; state flip.
Transition: soft → Scene 5

### Scene 5 — Outro — 3.2s
⚡ SupOps logo; tagline "Give it root. Keep control."; small "self-hosted · open source".

**Music mood for this video:** upbeat-but-restrained corporate
**Audio summary:** a quiet warm bed under a calm, confident product film; visuals lead throughout.
