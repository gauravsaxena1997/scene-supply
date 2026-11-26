# Local LTX 2.5 command adapter

Configure once in `~/.config/scenesupply/production.json` (or `$XDG_CONFIG_HOME/scenesupply/production.json`). See `examples/production.json`. This is a protocol for your installed application's wrapper; SceneSupply does not assume an LTX API URL or bundle an LTX model/application.

Use an absolute executable path and an array of arguments. SceneSupply invokes it without a shell, with the normal inherited environment. Do not put secrets in arguments. Only machine-level configuration supplies executables; plans cannot do so. Configure the wrapper to use LTX 2.5. When no wrapper is configured, the same production task is returned to the agent for execution through the available local application.

The wrapper receives one JSON document on stdin:

```json
{
  "schemaVersion": "1.0",
  "destinationDir": "/consuming/project/assets/scenesupply/clip-01",
  "task": {
    "atomId": "clip-01",
    "type": "generated_video",
    "projectDir": "/consuming/project",
    "intent": {
      "prompt": "The climber takes two steps forward...",
      "camera": "Slow sideways tracking",
      "durationSeconds": 6
    },
    "dependencyAssets": {
      "reference-image": {"path": "assets/images/reference.png"}
    }
  }
}
```

`task` also contains the full atom intent, brand snapshot and affected shots. Resolve reference paths against projectDir. Use the requested duration (3–8 seconds), preserve reference continuity, generate the clip, inspect/probe its actual dimensions and duration, and wait until the output is complete.

Return one JSON object on stdout and exit zero:

```json
{
  "asset": {
    "path": "assets/scenesupply/clip-01/clip.mp4",
    "mediaType": "video",
    "durationSeconds": 6,
    "width": 1920,
    "height": 1080,
    "provenance": {
      "provider": "local_ltx_2_5",
      "rightsStatus": "review-required",
      "notes": "Generated with LTX 2.5 using the planned reference image."
    }
  }
}
```

If the application writes outside the project, include an absolute `sourceFile` alongside asset; SceneSupply copies it to asset.path without overwriting different content. Hash/bytes are computed by SceneSupply. Duration is reported by the wrapper and checked against the plan, not independently media-probed by SceneSupply; the wrapper must measure it. Logs belong on stderr or in local application logs. Failure/timeout leaves the atom failed and dependent tasks blocked. The default timeout is 1800 seconds, configurable up to 7200.

Source trim decisions remain shot fields. Use attach_asset shotUpdates or revise_plan to resolve them. A completed clip is not a rendered Remotion composition.
