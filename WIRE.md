# Muse Session Protocol: bridge wire notes

Schema source: `muse schema generate-json-schema --out /tmp/msp-schema --experimental`, generated with Muse 1.0.2
(build d57a141c, schema version 1, fingerprint `sha256:03312c213efd...`). Host observations below came from Muse
1.0.2/1.0.3 probes on 2026-09-04. They are version-specific observations, not additional protocol guarantees.
Regenerate the schema and repeat the relevant probes after upgrading Muse.

## Transport and handshake

`muse serve` is a stdio host using newline-delimited JSON-RPC 2.0, without `Content-Length` headers. The client owns
stdin/stdout. `PI_MUSE_BINARY` selects the executable for both this host and the exec fallback.

The bridge sends `initialize {clientInfo:{name,title,version}}`, waits for its object result, then sends `initialized`.
The schema also permits capability negotiation; the bridge does not request experimental capabilities. The initialize
result describes the server, schema, granted capabilities, and session durability. Calls before initialization fail
with `notInitialized`.

Request IDs can be numbers or strings; `1` and `"1"` are distinct. Empty `params` must be an object or omitted, not null.
The bridge narrows decoded envelopes before dispatch. Durable page entries are `{method,params}` records rather than
complete JSON-RPC envelopes. Opaque cursors are compared by equality, never parsed as sequence numbers.

Sandbox posture is fixed when the host spawns. Default flags are `--disable-sandbox --trust-workspace`; sandboxed mode
uses `--trust-workspace`. Approval mode is chosen on the wire. A live host cannot change sandbox posture while a turn
is active.

## Commands and queries used

Commands carry client-minted UUIDv7 `commandId` values. The observed host derives a fresh `turnId` from the `turn/start`
command ID, so the bridge registers that ID before sending the request and can accept notifications preceding its ack.

| Method | Bridge request | Relevant result |
|---|---|---|
| `session/start` | `commandId`, `sessionId`, `workspaceRoot`, `modelId`, `approvalMode:"allowAll"` | `{session,viewCursor}`; subscribes the host |
| `session/resume` | `commandId`, `sessionId` | `{session,viewCursor,history,pendingRequests}`; subscribes the host |
| `session/setModel` | `commandId`, `sessionId`, `model:{modelId}` | acceptance of the durable selection for subsequent model calls |
| `turn/start` | `commandId`, `sessionId`, nonempty `input`, optional `reasoningEffort` | `{commandId,turnId,disposition,startedNewTurn,status}` |
| `turn/steer` | `commandId`, `sessionId`, `expectedTurnId`, nonempty `input`, optional `reasoningEffort` | `{commandId,turnId,status}`; stale expected IDs are rejected |
| `turn/interrupt` | `commandId`, `sessionId`, `turnId` | `{commandId,turnId,status}`; acceptance is not a termination proof |
| `userInput/cancel` | `commandId`, `sessionId`, `userInputId`, `reason` | settles the question as cancelled |
| `view/page` | `sessionId`, `direction:"forward"`, `limit:1000`, optional durable `cursor` | `{events,nextCursor,...}` |

`model/list` is available for discovery probes but is not used for ordinary registration; registration reads Muse's
local catalog. `turn/cancel`, `turn/unqueue`, and `approval/decide` exist in the schema but are not used by the bridge.

The wire `ApprovalMode` values are `allowAll`, `promptUnmatched`, `onRequest`, and `denyUnmatched`. The CLI's `never`
spelling is not a valid wire value. Unrestricted parity combines wire `allowAll` with the default host flags.

`TurnInputPart` is either `{type:"text",text}` or `{type:"image",base64Data,mediaType,width?,height?}`. Fresh bridge
turns remain text-only and reject image attachments. Steering can pass image parts supplied by OMP. Question-answer
image attachments are reserved/rejected by this schema version.

## Notifications and ownership

The bridge consumes:

- `turn/started` and `turn/completed`
- `item/started`, `item/updated`, `item/completed`, and `item/delta`
- `session/tokenUsage`, `session/contextUsage`, and `session/todoListChanged`
- `view/gap` and `userInput/requested`

Session notifications are routed by `sessionId`. Items and usage are further scoped to the current turn and successors
owned by that response stream; unrelated turns must not contribute text or acknowledge a steer.

`item/delta {itemId,delta,field?}` appends to a tracked item. An absent/empty field is treated as `text`. Agent text feeds
the response; `reasoning` fields named `summary.N` feed thinking. Raw tool/shell output deltas are not displayed.
`item/completed` carries authoritative full item text, which replaces an incomplete streamed version.

Most session-view events carry `viewCursor`. `view/gap` instead carries `after`, `next`, and `sessionId`, without a
`viewCursor`. `sourceRange` is optional durable provenance: ephemeral `item/delta` events and ephemeral item starts do
not have it. Not every notification is a durable view event.

Known item kinds include `userMessage`, `agentMessage`, `reasoning`, `toolCall`, `userShell`, `subagent`, `workflow`,
`reminderChild`, and `compaction`. Unknown non-answer kinds get a generic activity label. The bridge distinguishes
`inProgress` from terminal statuses such as `completed`, `failed`, `cancelled`, `rejected`, and `timedOut`.

## Gap recovery

Observed `view/page` results contain the durable view, with a separate cursor namespace and no dropped live deltas.
The live `after`/`next` values in a gap are not durable page anchors.

On a gap, live delivery continues immediately. Recovery pages from the durable beginning and applies owned completed
agent messages and relevant terminals. It has a 15-second deadline, at most 50 pages per attempt, and at most three
attempts with two-second retry delays. Another gap arriving during recovery causes another catch-up pass afterwards.
A page error fails the turn only if no live event has arrived since the gap; otherwise it is diagnostic.

A live terminal can resolve the run's terminal promise while recovery is pending. The outcome builder still drains
recovery before reading final text and publishing the response. Cancellation can stop waiting for recovery. The final
text concatenates each owned agent item's authoritative text, or its streamed text when no completion was recovered;
items are kept in their observed order without invented separator text.

A successful page with no terminal is not proof the turn ended. There is no overall execution timeout. Missing deltas
cannot be reconstructed, and a failed recovery may leave partial text; diagnostics must not promise a recovered answer.
A 25-second stdout-stall probe did not produce a gap: that host backpressured instead. Gap regressions therefore use
controlled host fixtures as well as ordinary live-turn smoke checks.

## Usage and context occupancy

`TokenUsage` contains raw `inputTokens`, `outputTokens`, `cachedTokens`, and `reasoningTokens`, plus optional
`cacheReadTokens` and `cacheWriteTokens`. Whether cached tokens are inside raw input is provider-dependent.

`session/tokenUsage` supplies one report per model completion:

- `promptTokens` and `totalTokens` are server-derived, counted-once values.
- `usage` contains raw provider counters; `cumulative` contains session-lifetime accounting, not context occupancy.
- OMP uncached input is `max(0, promptTokens - cacheReadTokens - cacheWriteTokens)`. The bridge sums the server total
  directly, without adding cache tokens again or separately adding reasoning tokens.
- If counted-once fields are absent, the bridge preserves raw input and uses a best-effort component sum. This cannot
  establish the provider's cache-overlap convention and is not equivalent to canonical accounting.

`session/contextUsage.usedTokens` replaces the latest measured occupancy, including zero. Absence is distinct from a
measured zero. The provider passes a measured value to OMP's `contextSnapshot`; it never substitutes cumulative usage.

Exec records are normalized separately: absent counters retain the last report, explicit zero counters replace it,
and reported totals take precedence over derived totals. Records with no accounting fields do not replace a canonical
total. Pricing is estimated through OMP's catalog pricing API; absent Muse prices produce zero estimates, not a claim
of free service.

## Session continuity and admission

The OMP session owns a bridge-minted Muse session ID, never the OMP ID itself. The provider's in-memory state records
that owner and request occupancy. The durable map at `<agentDir>/omp-muse-bridge-sessions.json` records the backend ID,
initialization state, semantic context checkpoint, instruction/workspace fingerprint, and update time.

Store writes use the SDK's cross-process lock and atomic private-file replacement. Legacy string-ID mappings remain
readable but have no checkpoint, so they are re-seeded. Corrupt stores are reported without overwriting them. Pruning
retains the 200 most recently updated mappings; it does not delete Muse's own session history.

Before a turn, the provider compares owner and committed context. A fork gets its own backend without closing the
parent's state. Changed instructions, workspace, tree history, compaction, another provider's work, or a missing
checkpoint require a fresh backend. A checkpoint is cleared before admission and committed only after success.

A fresh backend receives the complete seed once: OMP instructions without tool documentation, a 40,000-character
history budget that reserves the latest compaction summary first, bounded tool details, and the task. The seed is
built lazily only when needed. Matching resumed sessions receive the current task, not the seed again. Fresh exec
fallbacks follow the same seeding rule.

An empty open result `viewCursor` raises `MuseSessionUnusableError`. That subtype survives the pre-admission catch so
the provider can mint and seed one replacement instead of entering exec fallback. Spawn, handshake, and other open
failures may raise `HostUnavailableError` and select exec. Once any `turn/start` request has been sent, admission is
potentially effective: an error or missing acknowledgement does not permit fallback and duplicate execution.

Request ownership is released before a done/error event is published. A late continuation from that completed request
must not clear a subsequent request's busy state.

## Steering and cancellation

OMP's input hook requires interactive input and an active `muse-code` model. Slash commands and explicit queue markers
are left to OMP. A run refuses steering once interrupted, settled, terminal, or held waiting for a successor. A refused
or rejected steer falls through to OMP rather than disappearing.

A pending-steer record is installed before waiting for its acknowledgement. Acknowledgements and notifications from
the same stdout chunk are reconciled, including consumed steered user messages. A rejected request must not clear a
previously accepted, unanswered steer. An accepted-answer boolean is separate from pending requests, so rejected or
coalesced requests do not create an unbounded counter.

A completed parent with an unanswered steer is held for at most five seconds. A successor `turn/started` is adopted
into that response stream. If none arrives, the bridge releases the held terminal with a diagnostic that the steer
was not answered. `turn/steer` is an inbox operation, not a guaranteed interruption of the current model call.

Abortable pre-admission waits return locally without sending a turn. After `turn/start` is sent, cancellation requests
`turn/interrupt`; a subsequently adopted successor receives its own interrupt. A host `cancelled` terminal confirms
cancellation. If no terminal arrives within three seconds, local settlement sets `aborted` but not
`backendInterrupted`. Local settlement does not prove that Muse or its tools stopped, and the error states that
termination was unconfirmed.

Exec uses a detached process group on POSIX. Cancellation sends `SIGTERM`, waits up to five seconds, escalates to
`SIGKILL`, and waits for group termination even if the leader already exited. `EPERM` from a liveness probe is treated
as possible continued existence, never as proof of termination. Windows uses `taskkill /t /f`; that path has not been
runtime-verified on the macOS development host.

## Activity, plans, and questions

Activity is Markdown thinking text with a `[Muse]` tag, tool/target labels, and outcomes. Raw `visibleOutput` is not
quoted. Extraction permits bounded statistic syntax, failure reasons, and up to five distinct referenced web hostnames.
Model-authored fallback descriptions are bounded separately. Hostnames identify references, not proof of visits.

Todo calls themselves are hidden. Only validated committed `session/todoListChanged` snapshots replace the plan;
`items:[]` clears it. The provider uses a session-owned live widget and persists an immutable custom-message snapshot
at turn end. Message details restore that snapshot on reload/tree navigation. Snapshots are excluded from model context.
This is display-only, not OMP's native todo state: the public extension API has no native todo writer.

`userInput/requested` is currently cancelled automatically even in interactive OMP. MSP has `userInput/answer`,
`userInput/cancel`, and `userInput/clarify`, and the current OMP SDK has an optional `askDialog` API. An interactive
adapter is feasible but is not implemented; it must preserve session ownership and handle late or already-settled
prompts. Headless cancellation must remain defined.

## Error handling and observed host quirks

RPC errors are `{code,message,data:{kind,...}}`. Most recovery branches use `data.kind`. One explicit compatibility
exception also examines message text: Muse 1.0.3 reported an existing/reserved session as `commandRejected` with
`already exists or is reserved`. The bridge resumes for that combination or for `sessionInUse`. It does not treat
arbitrary `invalidParams` errors as permission to resume.

The observed host could open a durable session with an empty view cursor and then complete work without live
notifications. The empty-cursor guard prevents admission to that unobservable session.

`session/read` returned stored state without an active turn during observed live runs. Do not use it as a steering
liveness gate merely because its schema contains `activeTurnId`; bridge-owned run state is authoritative for that gate.
There are no `session/status` or `session/reset` methods. A future bridge reset must refuse active ownership and clear
both its in-memory state and durable mapping; it must not claim to delete Muse history.
