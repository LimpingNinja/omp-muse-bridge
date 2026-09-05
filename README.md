# omp-muse-bridge

An [Oh My Pi](https://github.com/can1357/oh-my-pi) plugin that registers an authenticated
[Muse Code](https://github.com/meta-pytorch/muse) installation as the OMP model provider `muse-code`.

Turns run over a persistent `muse serve` session host, so a Muse session keeps its context across turns and across OMP
restarts. The plugin does not add a subagent tool and does not need a modified subagent host; it also ships a
`muse-spark` agent definition so OMP's own `subagent` tool can delegate to Muse.

Version 0.4.3.

## Requirements

- OMP with `@oh-my-pi/pi-ai`, `@oh-my-pi/pi-coding-agent`, and `@oh-my-pi/pi-utils` at version 18 or later
- `muse` on `PATH`, authenticated with `muse login`
- OMP's `subagent` extension only if you want the delegated path

## Install

```sh
omp plugin marketplace add LimpingNinja/omp-muse-bridge
omp plugin install omp-muse-bridge@omp-muse-bridge
```

Restart OMP afterwards. Extensions are loaded at startup, so `/reload-plugins` is not enough (it covers skills,
commands, and MCP only).

For the delegated path, install the bundled agent definition once:

```text
/muse-setup
```

That copies the definition to `~/.omp/agent/agents/muse-spark.md`. It is idempotent and refuses to overwrite an agent
of the same name that this plugin does not manage. `/muse-remove` deletes only a definition this plugin manages.

## Use

Interactively, select a Muse model and talk to it like any other provider:

```text
/model muse-code/muse-spark
```

Or delegate through OMP's subagent tool:

```js
subagent({ agent: "muse-spark", task: "Explain this repository" })
```

Parallel and chained delegation work normally:

```js
subagent({
  tasks: [
    { agent: "muse-spark", task: "Review the API" },
    { agent: "muse-spark", task: "Review the implementation" },
  ],
})
```

## Models

`muse-code/muse-spark` is a stable alias for whichever model Muse's local catalog marks `is_default`. Every catalog
model is also registered as `muse-code/<model-id>`, so an agent definition can pin one:

```yaml
model: muse-code/muse-spark-1.2
```

Missing, corrupt, or unknown catalog data raises an explicit execution error. The provider stays registered even when
Muse is not installed, so OMP still starts and reports the setup problem when the model is used.

OMP thinking levels map onto Muse reasoning effort, with `off` becoming `none` and `max` becoming `ultra`.

## Session host

- Continuity: each OMP session gets its own bridge-minted UUIDv7 Muse session id, and the `OMP id -> Muse id` pairs are
  persisted in `~/.omp/agent/omp-muse-bridge-sessions.json`. A later OMP process reattaches the same Muse session
  instead of starting cold. Reusing the OMP session id as the Muse id does not work: resuming a session the host never
  created returns an empty view stream and the turn completes with no notifications at all.
- Recovery: a remembered session that the host opens without a live view stream is refused before the turn is admitted;
  the bridge mints a replacement session and re-seeds it. If the host cannot be spawned or the handshake fails, the
  turn falls back to `muse exec` and reports a visible diagnostic.
- Seeding: a session this bridge creates receives OMP's system prompt with tool documentation stripped, a bounded
  post-compaction slice of the conversation, and the task. Resumed sessions get only the task.
- Steering: typing while a Muse turn is live routes through `turn/steer`. The input hook only claims a message when the
  active model's provider is `muse-code`, and only while the run owns a live turn; otherwise the message becomes a
  normal turn. Steers are not mid-generation interrupts, so a steer that lands late is answered in a successor run,
  which the bridge adopts into the same response stream.
- Interrupt: ESC sends `turn/interrupt` and the run settles itself as cancelled after a short grace, so it cannot
  outlive the interrupt. The host survives for the next turn.
- Activity: tool calls, shell commands, and other non-answer items are reported as `[Muse]` lines on the thinking
  channel with the tool name and target. Raw tool output is never printed. Muse's todo list renders as a themed panel;
  OMP exposes no todo-write API to extensions, so that panel is display-only.

Wire-level details, probe results, and the host quirks the bridge works around are in `WIRE.md`.

## Security

By default Muse runs unrestricted: the host is spawned as `muse serve --disable-sandbox --trust-workspace`, and the
exec fallback uses `muse exec --yolo`. That disables Muse's sandbox and its approval prompts.

To keep Muse's sandbox while leaving headless approval prompts disabled, start OMP with:

```sh
omp --muse-sandboxed
```

Child OMP processes (for example, official subagents) receive flags only when they are part of their own invocation, so
set the environment variable instead to apply sandboxing everywhere:

```sh
PI_MUSE_SANDBOXED=1 omp
```

Sandboxed mode spawns `muse serve --trust-workspace` and falls back to `muse exec --trust-workspace
--disable-approval`.

Extensions and unsandboxed agents run with your user permissions. Only install packages you trust.

## Development

```sh
npm install
npm run check          # tsc --noEmit plus a syntax check per source file
npm test               # bun test test/
npm run prepublishOnly # check plus tests, the publish gate
```
