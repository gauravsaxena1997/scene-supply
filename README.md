# SceneSupply

SceneSupply is a local, project-agnostic source layer for video work. It searches stock media from Pexels, Pixabay, and Coverr; downloads selected assets with provenance; and searches and fetches React component registry items from Tailark, Eldora UI, Cult UI, KokonutUI, and Magic UI. It does not impose a brand, narrator, video template, or editor.

This is an early CLI, JavaScript package, and local MCP server. It does not generate complete videos or install web components into a Remotion project.

## Requirements

- Node.js 20 or newer.
- Your own API keys for whichever stock providers you use.
- Rights review for each selected media asset and component before publication or redistribution.

## Install for use from any project

From a checkout of this repository:

```sh
npm link
scenesupply doctor
```

`npm link` makes `scenesupply` available in any terminal project on that machine. You may also import the package from JavaScript. No project-specific configuration is required.

For Codex, register its MCP server once at user level:

```sh
codex mcp add scenesupply -- scenesupply-mcp
```

The server offers `source_status`, `search_stock`, `download_stock`, `search_components`, `inspect_component`, and `fetch_component`. It uses the same user-level credentials as the CLI, so each consuming project needs no separate key setup. Asset and component files are written only to the destination directory supplied to a download or fetch call.

## Configure once

```sh
scenesupply auth set pexels
scenesupply auth set pixabay
scenesupply auth set coverr
scenesupply doctor
```

The command reads each key through hidden terminal input. It saves keys in `~/.config/scenesupply/credentials.json` (or `$XDG_CONFIG_HOME/scenesupply/credentials.json`) with owner-only file permissions. This is a **local plaintext credential file**, outside this Git repository. An environment variable (`PEXELS_API_KEY`, `PIXABAY_API_KEY`, or `COVERR_API_KEY`) takes precedence and can be supplied by your existing secret manager. Do not put tokens in arguments, project files, or commits.

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

From any local project, ask your agent to call the `scenesupply` CLI. For example:

> Search Pexels, Pixabay, and Coverr for a rainy city street. Show the source pages and creators. Download the selected clip into this project's assets folder and keep its provenance record.

> Search the five component sources for a terminal animation. Inspect candidates, fetch one into this project's references folder, and adapt its visual treatment for the target codebase after checking its licence.

The CLI returns JSON, including per-source errors. It will not silently pretend an unavailable provider was searched.

## Scope

Planned later: project-level brand rules, narration contracts, asset generation providers, shot plans, and Remotion assembly. Those will consume this package; they are not part of the first release.

## Reference and licences

The stock search pattern was informed by [MoneyPrinterTurbo](https://github.com/harry0703/MoneyPrinterTurbo). SceneSupply implements its own adapters and does not include MoneyPrinterTurbo's video editor. Its code licence does not grant rights to third-party media. Component registry items remain governed by their own licences and terms. SceneSupply's original code is MIT licensed.
