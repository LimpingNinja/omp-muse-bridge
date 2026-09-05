# omp-muse-bridge

An [Oh My Pi](https://github.com/can1357/oh-my-pi) plugin that registers an authenticated
[Muse Code](https://github.com/meta-pytorch/muse) installation as the OMP model provider `muse-code`.

Muse owns tool execution. OMP displays its replies, reasoning, short activity summaries, and committed todo snapshots.
A persistent `muse serve` host keeps backend context between matching turns. The bundled `muse-spark` agent lets
OMP's built-in `task` tool delegate to Muse; no separate subagent extension or modified host is required.

## Screenshots

Tool activity in OMP:

![Muse Bridge showing tool activity and a response in OMP](https://raw.githubusercontent.com/LimpingNinja/omp-muse-bridge/main/docs/screenshots/Muse-Bridge-Running.png)

Muse's plan display:

![Muse Bridge showing pending, in-progress, and completed tasks](https://raw.githubusercontent.com/LimpingNinja/omp-muse-bridge/main/docs/screenshots/Muse-Bridge-Todo.png)

These screenshots show the earlier panel layout. Plans now use a live widget and a saved per-turn transcript snapshot.

## Requirements

- OMP 18.1.10 or later, including its `@oh-my-pi/pi-ai`, `pi-catalog`, `pi-coding-agent`, and `pi-utils` packages
- Muse on `PATH`, authenticated with `muse login`, with a populated local model catalog
- Bun 1.3.14 or later for development and the test runner

The bridge reads Muse's cache at `$XDG_DATA_HOME/muse/model-catalog`, or `~/.local/share/muse/model-catalog` when
`XDG_DATA_HOME` is unset. It does not download or rebuild the catalog. Authentication alone does not prove the cache
is available: if it is missing, open Muse normally and verify its model picker and a normal turn before retrying OMP.
There is no catalog-refresh subcommand in the inspected Muse CLI help.

`PI_MUSE_BINARY=/path/to/muse` selects the executable for both the persistent host and exec fallback.

## Install

```sh
omp plugin marketplace add LimpingNinja/omp-muse-bridge
omp plugin install omp-muse-bridge@omp-muse-bridge
```

Restart OMP afterwards. Extensions load at startup; `/reload-plugins` reloads skills, commands, and MCP, not this provider.

For delegation, run:

```text
/muse-setup
```

This copies the bundled definition to `<agentDir>/agents/muse-spark.md`. The default is
`~/.omp/agent/agents/muse-spark.md`; OMP profiles and `PI_CODING_AGENT_DIR` change that location.

Rerun `/muse-setup` after plugin upgrades. Identical definitions are left alone; managed definitions are replaced
atomically under a file lock. Edits that retain the managed marker can be overwritten. Unrelated files and symlinks
are refused. `/muse-remove` removes only the managed agent definition, not the plugin or Muse session history.

## Use

For an explicit non-contributor model:

```text
/model muse-code/muse-spark-1.3
```

The bundled delegated agent also pins `muse-code/muse-spark-1.3`. Ask OMP, for example:

```text
Use the muse-spark agent to explain this repository.
```

OMP delegates through its built-in `task` API. A parallel batch uses shared `context` plus distinct `tasks`:

```js
task({
  i: "Reviewing independent code areas",
  context: "Review only. Do not edit files or run builds, tests, linters, or formatters.",
  tasks: [
    {
      agent: "muse-spark",
      task: "Review src/api for correctness and security. Return findings with file and line evidence; do not inspect src/ui.",
    },
    {
      agent: "muse-spark",
      task: "Review src/ui for correctness and accessibility. Return findings with file and line evidence; do not inspect src/api.",
    },
  ],
})
```

## Models and privacy

Every model in the local Muse catalog is registered as `muse-code/<model-id>`. The inspected catalog exposes:

- `muse-code/muse-spark-1.3`
- `muse-code/muse-spark-1.3-contributor`
- `muse-code/muse-spark-1.2`
- `muse-code/muse-spark-1.2-contributor`

`muse-code/muse-spark` is an additional alias for the catalog's `is_default` row, **not** Muse's configured/current model.
The picker label includes the resolved ID. In the inspected catalog the alias selects `muse-spark-1.3-contributor`,
while Muse settings select `muse-spark-1.3`.

The contributor model description says content, including inter-session messages, may be used for product improvement.
Choose an explicit non-contributor ID when that distinction matters. Seeding forwards OMP instructions and conversation
context to the selected Muse model, including bounded tool-result excerpts.

Model registration happens at plugin startup. Restart OMP after Muse changes its catalog. The bridge merges local cache
files by model ID; it does not select a Muse provider/profile or pass provider/profile overrides to either transport.
The supported configuration is Muse's standard Meta provider with a single catalog profile. Multiple provider/profile
caches are not independently routable through this bridge.

Missing, corrupt, or unknown catalog data raises an execution error. An alias-only placeholder keeps the provider
registered if setup is missing; it does not make Muse available or bypass authentication.

OMP thinking levels map to Muse reasoning effort, including `off` to `none` and `max` to `ultra`. Availability still
depends on the selected Muse model and service.

## Sessions and recovery

- Each OMP session owns a separate bridge-minted UUIDv7 Muse session ID. Forks do not share a mutable backend session.
- Mappings and context checkpoints are saved at `<agentDir>/omp-muse-bridge-sessions.json`. Writes are locked across
  OMP processes, atomically replaced, private (`0600`), and bounded to the 200 most recently updated entries. Corrupt
  stores are reported and left untouched rather than silently overwritten.
- A backend is reused only when the OMP owner, workspace, operating instructions, and committed conversation still
  match its checkpoint. Provider changes, tree edits, compaction, or unfinished prior work can require a new backend.
  This deliberately prefers current OMP context over stale backend history.
- Fresh sessions receive OMP instructions with tool documentation removed, at most 40,000 characters of preceding
  conversation, and the current task once. The most recent compaction summary gets space before recent messages;
  tool arguments/results are clipped to 400 characters. Matching resumed sessions receive only the current task.
- A session opened without an observable view stream is rejected before admission. The bridge tries one fresh,
  re-seeded replacement. Spawn, handshake, or session-open failure may instead use exec; once `turn/start` has been
  sent, uncertain admission or host failure never triggers a second execution through fallback.
- Missing live deltas are not replayable. Durable recovery can replace partial text with completed agent messages,
  and outstanding recovery is drained before the final answer is published. Recovery has bounded retries and a deadline.
- Successful and failed responses release request ownership before OMP sees their terminal event. A completed turn
  must not cause the next message to be treated as an overlapping request.

The exec fallback is degraded: no MSP steering, reasoning/activity events, or todo updates. A fresh exec session receives
full seeded context too. Neither transport has an overall model-execution timeout; cancellation is separate.

## Steering, cancellation, and display

Interactive input is offered to Muse only when `muse-code` is the active provider and a run is live and uninterrupted.
Slash commands and OMP's `->` / `=>` queue markers retain OMP parsing. A refused steer falls through to OMP.

Steering is not a mid-generation interrupt. Muse may answer a late steer in a successor run. The bridge reconciles
pending acknowledgements with notifications and adopts that successor into the same response stream. It does not
accept another steer while waiting for a successor. The successor wait is bounded to five seconds.

ESC requests `turn/interrupt`; a successor adopted during cancellation is interrupted too. Host-backed cancellation
settles locally after a three-second grace if Muse supplies no terminal. **Local settlement does not prove backend
termination** and is reported as unconfirmed. Pre-admission waits are also abortable. Exec cancellation stops the
spawned process group, waits up to five seconds before `SIGKILL`, and checks termination even if the leader exited first.

Activity uses Markdown `[Muse]` labels with tool names, targets, and outcomes. Raw tool output is not quoted; only bounded
change statistics, failure reasons, and referenced web hostnames are extracted. A referenced hostname is not proof the
agent visited that site. Reasoning/activity visibility depends on OMP's thinking-display settings.

Only committed `session/todoListChanged` snapshots update the plan, including empty-list clears. The live widget belongs
to its OMP session; the turn-end snapshot belongs to its transcript entry. Older messages do not acquire a later plan,
and snapshots stay out of model context. This is display-only: OMP exposes no native todo-write API to extensions.

## Current limits

- Fresh turns are text-only; image attachments are rejected explicitly. The live steering path can encode image parts
  when OMP supplies them, but this is not general image support and images are not preserved in the text-only steer echo.
- Muse question prompts are automatically cancelled, including in interactive OMP. No interactive question adapter is
  installed. The protocol and OMP's optional dialog API can support one, but it needs session ownership and settlement handling.
- Host usage uses Muse's counted-once prompt/total fields. Cache tokens are not added twice. Context occupancy comes
  from `session/contextUsage`, not cumulative session totals. Exec uses the counters it reports; absent usage is unknown,
  not a measured zero. Costs are catalog-based estimates, and a catalog without prices yields zero estimates.
- There are no bridge status/reset commands. `session/read` returned stored state in the observed host and is not a
  steering-liveness gate. A safe reset must clear both idle in-memory ownership and the persisted mapping; deleting a
  mapping during a run is not safe. A new OMP session provides a separate backend without deleting Muse history.
- Sandbox posture is process-wide for the shared host. It cannot change while a host turn is active.

[WIRE.md](https://github.com/LimpingNinja/omp-muse-bridge/blob/main/WIRE.md) records protocol fields and observed host behavior.

## Security

Default host launch: `muse serve --disable-sandbox --trust-workspace`, with wire approval mode `allowAll`.
Default fallback: `muse exec --yolo`. Both disable sandboxing and approval prompts.

To keep Muse's sandbox while leaving headless approvals disabled:

```sh
omp --muse-sandboxed
```

Delegated OMP processes do not automatically inherit command-line flags. To apply sandboxing to child processes too:

```sh
PI_MUSE_SANDBOXED=1 omp
```

Sandboxed launch uses `muse serve --trust-workspace`; fallback uses `muse exec --trust-workspace --disable-approval`.
Extensions and unsandboxed agents run with your user permissions. Only install packages you trust.

## Development

Use Bun 1.3.14+, a POSIX shell, and a Node release with TypeScript-aware `node --check` support.

```sh
bun install --frozen-lockfile
npm run check          # tsc --noEmit plus a syntax check per source file
npm test               # bun test test/
npm run prepublishOnly # check plus tests, the publish gate
```

Tests use isolated processes and temporary directories rather than changing your Muse installation or OMP profile.
The npm package includes source, the agent, and README; protocol notes and screenshots use hosted links instead of
adding them to the tarball.
