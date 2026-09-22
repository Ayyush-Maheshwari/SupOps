# Hyperframes Composition Brief: SupOps

## Objective
A ~19s polished launch/brag video for SupOps (self-hosted AI SRE).

## Output
- Composition dir: brag-output/composition/
- Rendered video: brag-output/brag.mp4
- Format: landscape 1920x1080
- Duration: ~19s

## Source material
- Product: SupOps
- Strongest claim: "An AI SRE that actually fixes things."
- Copy that must appear verbatim: "checkout is returning 500s since 14:20", "RISK: HIGH", "Approve & run", "Give it root. Keep control."
- Key UI to recreate: dark NOC UI, Investigate box, live terminal, the risk/approval gate.

## Creative direction
- Tone: polished; quiet confident product film.
- Angle: everyone claims agentic ops; SupOps' differentiator is the guardrail — it fixes, but stops for approval on anything risky.
- Avoid: generic SaaS language, abstract filler, redesigning the brand.

## Visual identity
- Background #08090F, text #F5F7FA, accent #0A84FF; risk green #32D74B, amber #F5A623, red #FF453A.
- Fonts: system-ui (display) + ui-monospace (mono), no external fonts.

## Storyboard
See brag-plan.md. Scenes: 1 Hook 3.2s · 2 Investigate 4.0s · 3 Live work 4.2s · 4 The gate 4.6s · 5 Outro 3.2s.

## Audio
- Music: assets/music/track.mp3, low bed ~0.45, no SFX, no audio-reactive.
- Single <audio id="bgm"> from start.

## Hyperframes instructions
- Standalone single index.html, one paused GSAP timeline on window.__timelines["main"].
- Show real UI (terminal + approval gate). Keep all text readable. 15-25s.
- Run hyperframes check before render (single gate).
