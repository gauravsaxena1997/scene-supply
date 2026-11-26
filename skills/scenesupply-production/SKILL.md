---
name: scenesupply-production
description: Use SceneSupply MCP to plan, source, assemble, and review short-form video production across projects. Use when the user requests the shared SceneSupply workflow.
---

# SceneSupply production

1. Call `get_workflow_guidance` and `read_project_context`. Those are the canonical SOP and contracts. Load the project's recorded personalization cases, creative brief, and approval scope. Keep decisions and assets with their consuming project.
2. Plan the emotional hook, product or story proof, resolution and single CTA before selecting tools. Save the creative treatment with `plan` or `revise_plan`. Plan edit frames, narration spans, original dialogue, music and SFX explicitly. Start with one short pilot unless directed otherwise.
3. Transcribe the selected voiceover with a language-capable recognizer and word timestamps. Review the audio, save raw and corrected transcripts, then anchor SceneSupply captions, visuals, actions and SFX to reviewed speech timing. Re-align after a voiceover change. Mark uncertain timing as estimated.
4. For supporting video, search licensed stock through SceneSupply first when it fits the beat. Use web search for otherwise unavailable material, ChatGPT for original stills, and the authorized Flow browser for custom B-roll, silent reactions or native dialogue. Use `attach_asset` for actual provider output and source metadata.
5. Use `produce` for dependency-ready work. ElevenLabs synthesis spends credits and requires an explicit intended use. Confirm account rights before brand audio. Use project-relative source paths and keep secrets in runtime configuration.
6. Use `validate_plan` and `prepare_assembly` before the project's Remotion render. Treat the manifest as a handoff with pending gates. Inspect the final render at phone size and collect review feedback as scoped cases.
7. Identify useful cross-project components and reuse or create them when needed. Plan gesture, interaction response, action SFX and directional camera movement together. When a real edit exposes a contract gap, identify the narrow reusable change, preserve older plans, and verify it in SceneSupply. Keep project choices out of global guidance.
