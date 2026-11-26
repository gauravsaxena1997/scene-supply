# SceneSupply

SceneSupply is a local, project-agnostic visual planning and asset production toolkit. It reads the consuming project's channel guidance, saves a script-mapped visual plan, produces assets through direct adapters and agent tools, and attaches their paths/provenance to that same plan. It searches Pexels, Pixabay, Coverr and the Tailark OSS, Eldora UI, Cult UI, KokonutUI, and Magic UI component registries.

This is a CLI, JavaScript package, and local MCP server. The agent makes creative shot decisions and operates image-generation/coding/capture tools; SceneSupply supplies schemas, guidance, source integrations, resumable production and asset registration. SceneSupply emits the timed assembly manifest for a project-owned Remotion composition.

## Requirements

- Node.js 20 or newer.
- Your own API keys for the stock or narration providers you use. The setup check and sample plan run without keys.
- FFmpeg's `ffprobe` on your PATH if you generate ElevenLabs narration through SceneSupply.
- Rights review for each selected media asset and component before publication or redistribution.

## Install for use from any project

Clone this repository, or download and extract the source archive from a release:

```sh
git clone https://github.com/gauravsaxena1997/scene-supply.git
cd scene-supply
npm ci
node src/cli.js doctor
```

For a ZIP download, start with `npm ci` inside the extracted folder. To make the commands available from other projects:

```sh
npm link
scenesupply doctor
```

You can also skip `npm link` and run `node /path/to/scene-supply/src/cli.js` with the same arguments, or import the package from JavaScript.

For Codex, register its MCP server once at user level:

```sh
codex mcp add scenesupply -- scenesupply-mcp
```

Without `npm link`, register `codex mcp add scenesupply -- node /absolute/path/to/scene-supply/src/mcp.js`. Substitute the actual path and quote it if it contains spaces. For another MCP client, use the same command and arguments with stdio transport. The MCP client starts the process locally on connection. The CLI and MCP server use the same user-level credentials. Reconnect after upgrades and check that `get_workflow_guidance` appears in the active session.

### Try the sample without provider keys

From the SceneSupply checkout, run these commands in a POSIX shell. Use a fresh folder for each run because plan creation preserves existing files.

```sh
demo="$(mktemp -d)"
cp examples/script.md "$demo/script.md"
node src/cli.js plan --project "$demo" --script script.md --draft examples/draft.json --automatic --allow-generic-style
node src/cli.js inspect-plan --plan "$demo/visual-plan.json"
node src/cli.js validate-plan --plan "$demo/visual-plan.json"
```

This demonstrates the planning contract. Asset readiness still requires real media and verified trims.

## Plan, produce, and attach

Each channel/project stays in its own folder. Optional `.scenesupply/project.json` declares `guidanceFiles`, a `personalizationFile` for feedback and taste cases, allowed atoms, default composition, styles and narrator references. Paths are relative to the consuming project. See the [project example](examples/project.json). Existing AGENTS.md and common brand-guidelines files are also discovered. Credentials remain at machine level.

Main MCP tools:

| Tool | Behavior |
| --- | --- |
| `source_status` | Configuration and execution routes; health is explicitly not probed |
| `get_workflow_guidance` | Generic SOP and versioned JSON schemas |
| `read_project_context` | Channel guidance, hashes and project configuration |
| `plan` | Prepare brief; with an agent-authored draft, validate/save visual-plan.json |
| `produce` | Execute direct adapters and return agent tasks; checkpoint each result |
| `next_production_tasks` | Dependency-ready tasks, stock candidates and blocked atoms |
| `attach_asset` | Attach actual assets and resolve shot trims/placements |
| `revise_plan` | Explicit creative/timing revisions with optimistic revision checking |
| `validate_plan` | Coverage, composition, dependency, file/hash and readiness checks |
| `inspect_plan` | Shot timeline, assets, progress and issues |

Existing stock/component search, inspect, fetch and download tools remain available.

Start in a channel folder:

```sh
scenesupply plan --project . --script script.md
```

This returns the script with stable segment IDs, channel guidance, schemas and the planning SOP. It does not fabricate a visual plan. The agent makes shot decisions, then saves its draft:

```sh
scenesupply plan --project . --script script.md --draft draft.json
scenesupply produce --plan visual-plan.json
scenesupply next-production-tasks --plan visual-plan.json
```

If the channel has no composition, supply `--composition composition.json` or explicitly permit automatic choice with `--automatic`. With no brand guidance/styles, explicit `--allow-generic-style` is required. Resolved style values can be supplied using `--styles styles.json`. Plan output must be a new filename in the project root, keeping all asset paths portable. See [draft example](examples/draft.json) for the full shot contract. Its script span matches [script example](examples/script.md); it is an illustrative draft, not a generated asset.

Composition measures primary visual duration, including overlay-free stills and clips. Supporting components/labels do not double count. Every script word is mapped once in order. The plan preserves prompts, intended motion, annotations/captions, source choices, reference-image dependencies, actual asset metadata and a channel guidance/style snapshot. Caption modes are bottom, primary (suppress bottom), or none.

`produce` never silently picks the first search result. It searches permitted stock sources and returns candidates for the agent to inspect. Pass explicit choices in a JSON object keyed by atom ID:

```sh
scenesupply produce --plan visual-plan.json --selections selections.json
```

Each selection contains provider, type, id, and available sourcePage/creator/duration fields from search results. Exact footage intervals are resolved after inspecting the downloaded clip, not invented during planning. Originals remain intact; shot playback records sourceInSeconds, sourceOutSeconds, speed and audio policy. Asset duration must be measured and attached before assembly readiness.

Image generation runs through the agent's exposed ChatGPT image-generation tool. Component tasks specify purpose/content/layout/animation before searching the five registries; the agent fetches references and writes a frame-driven React component. Evidence capture uses the agent's available tools and retains the original source URL. SceneSupply cannot invoke another agent tool by itself. It returns explicit tasks and accepts actual results:

```sh
scenesupply attach-asset --plan visual-plan.json --atom summit-image --asset asset.json --source-file /absolute/generated/summit.png
scenesupply inspect-plan --plan visual-plan.json
scenesupply validate-plan --plan visual-plan.json
```

See [asset example](examples/asset.json). The source file is copied to asset.path, which must remain inside the consuming project. Hash and bytes are computed by SceneSupply. Attach component entry points/export names/props/dependencies and registry provenance, not downloaded registry JSON masquerading as a component. File validation does not compile components or certify visual quality.

Local LTX 2.5 consumes resolved reference images and generates 3–8 second clips. Configure a machine-level wrapper using the [LTX adapter contract](knowledge/ltx-adapter.md); without it, produce returns an agent handoff instead of claiming a working local app connection.

Completed atoms are skipped, dependencies are respected, and every result/failure is checkpointed. `--shots shot-001,shot-002` limits production while including their reference dependencies. Plan updates preserve previous JSON in `.scenesupply/history/` and use a lock directory; do not remove a lock while a producer is active. Production may leave an unattached file after failure; inspect/attach that file or choose a new path rather than assuming success. Verified stock sidecars can be recovered on a retry.

Use revisions for narration alignment, caption cues, final trims and placement, or changed creative direction:

```sh
scenesupply revise-plan --plan visual-plan.json --draft revised-draft.json --revision 3
scenesupply revise-plan --plan visual-plan.json --draft revised-draft.json --revision 4 --invalidate summit-image
```

Changing an attached atom's intent requires explicit invalidation. Dependent generated assets are also invalidated; files and history are retained. attach_asset can update metadata/shot treatment for the same unchanged file when expectedRevision/`--revision` is supplied. It cannot silently replace attached content.

Readiness progresses through planned, in_production, assets_ready, assembly_ready. Estimated timing, missing trims, unresolved placements and missing assets prevent assembly readiness. Rights-review warnings stay visible and are not publication clearance. Rendering and human visual acceptance remain later stages.

## Generic knowledge and schemas

[Planning and production SOP](knowledge/planning-and-production.md) covers narrative beats, shot variety, composition, evidence, motion, captions, component adaptation and recovery. Channel rules define the aesthetic; generic guidance does not introduce a shared brand. Machine-readable schema exports are in `schemas/` and available through `scenesupply schemas` or get_workflow_guidance.

Reusable agent instruction:

> Use SceneSupply to read this channel's guidance and plan visuals for the script. Resolve composition from my instructions or channel defaults; ask if neither permits a choice. Save a complete shot plan, then produce its assets through SceneSupply. Perform returned image-generation, evidence and component tasks using available tools and attach their actual files/provenance. Inspect and validate the plan. Do not render a video yet.

## Configure once

```sh
scenesupply auth set pexels
scenesupply auth set pixabay
scenesupply auth set coverr
scenesupply auth set elevenlabs
scenesupply doctor
```

The command reads each key through hidden terminal input. It saves keys in `~/.config/scenesupply/credentials.json` (or `$XDG_CONFIG_HOME/scenesupply/credentials.json`) with owner-only file permissions. This is a **local plaintext credential file**, outside this Git repository. An environment variable (`PEXELS_API_KEY`, `PIXABAY_API_KEY`, `COVERR_API_KEY`, or `ELEVENLABS_API_KEY`) takes precedence and can be supplied by your existing secret manager. Do not put tokens in arguments, project files, or commits.

Coverr also offers an [MCP endpoint](https://coverr.co/developers), and several component sources offer MCP servers. SceneSupply uses their direct APIs or public registries so the CLI works from any folder without per-project MCP setup. Your coding agent can additionally connect its own MCP servers once at user level.

## Find and download stock

```sh
scenesupply stock search video "rainy city street" --provider all --out rainy.results.json
scenesupply stock search image "historic typewriter" --provider pixabay --out typewriter.results.json
scenesupply stock download rainy.results.json 1 --out ./video-assets
```

The index is 1-based. Search results include provider attribution and source pages. A download writes the media file plus an `.asset.json` sidecar with provider ID, source page, creator, retrieval time, hash, and a `review-required` rights status. The sidecar does **not** assert that the asset is cleared for every use. Keep results and downloads in the consuming project, not in this public repository.

Some providers return signed download URLs. SceneSupply retrieves those only when downloading and does not save them in search results or provenance. Pixabay asks applications to show Pixabay as the source in search results and to download images used permanently. [Pixabay API](https://pixabay.com/api/docs/)

## Find component sources

```sh
scenesupply components sources
scenesupply components search "text animation" --out text.results.json
scenesupply components inspect magicui meteors
scenesupply components fetch magicui meteors --out ./component-references
```

`search` queries live registry catalogs. `inspect` reports dependencies and files. `fetch` saves the registry item and source metadata for a coding agent to review and adapt. It does not modify the target application. Many web components rely on hover, scrolling, client state, or time-based animation and need changes before frame-based video use.

The Tailark integration uses its free OSS registry. Quartz is plan gated and is not bundled. Magic UI Pro templates are also outside the public registry. Cult UI catalog and item retrieval use its public GitHub repository because its website may rate limit automated requests. [Tailark setup](https://tailark.com/docs), [Cult UI MCP/registry](https://www.cult-ui.com/docs/mcp-server), [KokonutUI MCP/registry](https://kokonutui.com/docs/mcp), [Eldora UI MCP](https://www.eldoraui.site/docs/mcp), [Magic UI MCP](https://magicui.design/docs/mcp)

If you have a Tailark Quartz plan, run `scenesupply auth set tailark-quartz` once and search it explicitly with `--source tailark-quartz`. SceneSupply sends the key in Tailark's documented `x-api-key` header. It never saves paid component source in this public repository. Quartz is excluded from the default `all` search because access is optional.

## Use from an agent

Copy this prompt into an agent with shell access or a connected SceneSupply MCP server:

> Use SceneSupply for the script and project folder I provide. If SceneSupply MCP is available, call `get_workflow_guidance` and `read_project_context`. Otherwise use the CLI equivalents `scenesupply guidance` and `scenesupply context --project <folder>`. If neither is available and you can run a shell, clone the official SceneSupply repo (or use the release archive), install dependencies with `npm ci`, and run `node <checkout>/src/cli.js doctor` before using that CLI. Resolve the project's guidance and taste cases before planning. Map each shot to the actual narration or script, save the editable plan, and produce only the assets in scope. Attach actual files, check their provenance and trims, then run plan validation. Open the project's Remotion preview if asked. Report unresolved assets and checks. Wait for my request before exporting or publishing.

From any local project, ask your agent to call the `scenesupply` CLI. For example:

> Search Pexels, Pixabay, and Coverr for a rainy city street. Show the source pages and creators. Download the selected clip into this project's assets folder and keep its provenance record.

> Search the five component sources for a terminal animation. Inspect candidates, fetch one into this project's references folder, and adapt its visual treatment for the target codebase after checking its licence.

The CLI returns JSON, including per-source errors. It will not silently pretend an unavailable provider was searched.

## Optional local cleanup for Google Flow clips

Download the video CLI for Windows x64, Linux x64, or macOS from the official [VeoWatermarkRemover releases](https://github.com/allenk/VeoWatermarkRemover/releases). The upstream video CLI is a preview. We verified version 0.6.4 on macOS. Download and extract the matching archive, then run the executable locally. On Windows, use `GeminiWatermarkTool-Video.exe`.

```sh
./GeminiWatermarkTool-Video --veo -i "flow-original.mp4" -o "flow-cleaned.mp4"
```

Keep the original and its generation provenance. Check the cleaned corner, runtime, frame count, and audio before attaching the cleaned copy as the editing asset. Use the cleanup step for footage you have permission to edit. SceneSupply does not install or run this tool automatically.

## Scope

Current: channel and personalization snapshots, editable shot/audio/action contracts, stock and agent-assisted assets, opt-in ElevenLabs narration and Remotion assembly manifests. Google Flow remains an agent/browser handoff. Final rendering is owned by the consuming project.

See the [shared production SOP](knowledge/planning-and-production.md) and [agent skill](skills/scenesupply-production/SKILL.md).

## Reference and licences

The stock search pattern was informed by [MoneyPrinterTurbo](https://github.com/harry0703/MoneyPrinterTurbo). SceneSupply implements its own adapters and does not include MoneyPrinterTurbo's video editor. Its code licence does not grant rights to third-party media. Component registry items remain governed by their own licences and terms. SceneSupply's original code is MIT licensed.
