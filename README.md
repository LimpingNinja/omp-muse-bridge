# omp-muse-bridge

Use Muse Spark as an agent in Pi's official `subagent` extension through an authenticated [Muse Code](https://github.com/meta-pytorch/muse) installation.

The package registers Muse Code as a Pi model provider. It does **not** register another subagent tool or require a modified subagent host.

## Requirements

- Pi 0.84.x
- Pi's official subagent extension
- Muse Code installed and authenticated with `muse login`

## Install

```sh
omp plugin marketplace add LimpingNinja/omp-muse-bridge
omp plugin install omp-muse-bridge@omp-muse-bridge
```

Restart Pi, then install the bundled agent definition explicitly:

```text
/muse-setup
```

The command copies the bundled definition to `~/.pi/agent/agents/muse-spark.md`. It is idempotent and refuses to overwrite an unrelated agent with the same name.

Pi's official subagent extension discovers agents when its tool runs, so no subagent-host fork or reload is required.

## Use

```js
subagent({ agent: "muse-spark", task: "Explain this repository" })
```

Official-host parallel and chain modes work normally:

```js
subagent({
  tasks: [
    { agent: "muse-spark", task: "Review the API" },
    { agent: "muse-spark", task: "Review the implementation" },
  ],
})
```

The official host launches a child Pi process with `muse-code/muse-spark`. The bridge provider then launches Muse Code and streams its response back as a regular Pi assistant message.

## Models

`muse-code/muse-spark` is a stable alias for the model marked `is_default` in Muse's local catalog. Catalog models are also registered under `muse-code/<model-id>` and can be pinned by editing the installed agent definition:

```yaml
model: muse-code/muse-spark-1.2
```

Missing, corrupt, or unknown catalog data produces an explicit execution error. The provider remains registered when Muse has not been installed yet so Pi itself can still start and explain the setup problem when the agent is used.

Pi thinking levels are passed to Muse (`off` becomes `none`, and `max` becomes `ultra`).

## Session host (this OMP build)

Turns run over a persistent `muse serve` stdio host instead of one `muse exec` per turn:

- **Continuity** — one Muse session per Pi session (`providerSessionState`); later turns are `turn/start` on the live host, and a resumed Pi session re-attaches via `session/resume`. Pre-admission or host-spawn failures fall back to the proven `muse exec` path with a visible diagnostic.
- **Steering** — typing while a Muse turn is active routes through `turn/steer`; the input is injected into the active run (the model/host decides whether it alters the current response or is consumed at its end). `/commands` and Pi's own queue markers (`->`, `=>`) always pass through untouched.
- **Interrupt** — aborting a turn sends `turn/interrupt`; the host survives for the next turn.
- **View gaps** — dropped notification ranges are repaired by `view/page` splice-fill (opaque cursors, boundary-exact, buffered live drain); unreplayable gaps fail the turn loudly instead of hanging. Wire notes in `WIRE.md`.

Tests: `bun test test/` (deterministic gap protocol suite; the `src/msp.ts` leaf graph is import-clean without the Pi host).

## Security

Delegated runs use Muse's unrestricted mode by default:

```sh
muse exec --yolo
```

This disables Muse approval prompts and sandboxing. To retain Muse's sandbox while keeping headless approval prompts disabled, start Pi with:

```sh
pi --muse-sandboxed
```

For official subagents, the child Pi process receives Pi's extension flags only when they are part of its invocation. To apply sandboxing consistently to child Pi processes, set:

```sh
PI_MUSE_SANDBOXED=1 pi
```

Sandboxed mode uses `muse exec --trust-workspace --disable-approval`.

Extensions and unsandboxed agents execute with your user permissions. Only install packages you trust.

## Remove the agent

```text
/muse-remove
```

This removes only an agent definition managed by `omp-muse-bridge`. Removing the Pi package itself does not silently mutate your agent directory.

## Development

```sh
npm install
npm run check
npm test
```
