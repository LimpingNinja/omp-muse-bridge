# Muse Session Protocol (MSP): bridge wire notes

Source: `muse schema generate-json-schema --out /tmp/msp-schema --experimental` (muse 1.0.2, build d57a141c, schema
version 1, fingerprint `sha256:03312c213efd...`), plus probes against `muse serve` on 2026-09-04. This file records
only what the bridge relies on. Regenerate the schema after a muse upgrade and re-check the tables below.

## Transport

- `muse serve` is a stdio session host. Framing is newline-delimited JSON-RPC 2.0 (ndjson, no `Content-Length`
  headers).
- The client owns stdin/stdout; that pipe is the host's only connection.
- Sandbox posture is fixed at spawn time by flags. Approval mode is chosen on the wire, not by a flag.
- Requests may carry `trace` (W3C passthrough). `params` is omitted rather than `null` when empty. Results are always
  objects.
- RequestId is an integer or a string, and `1` is not the same id as `"1"`.

## Handshake

1. Client sends `initialize {clientInfo{name,version}, capabilities{experimentalApi, requestedCapabilities[],
   optOutNotificationMethods[]}}`.
2. Server replies `{serverInfo, userAgent, museHome, platformFamily/Os, schema{version,fingerprint},
   grantedCapabilities[], experimentalApi, sessionDurability}`.
3. Client sends the `initialized` notification. It is accepted silently; the server also lists it in its own
   notification table.
4. Every other method fails with `ErrorKind.notInitialized` until `initialize` returns.

## Idempotency

Every command takes a `commandId` that the client mints as a UUIDv7; the server never mints one. `turnId` derives from
the `turn/start` `commandId`, so a fresh turn has `turnId == commandId`. The bridge therefore carries its own uuidv7
implementation (ms timestamp prefix, random tail, version 7, variant 10).

## Methods used by this bridge

| Method | Required params | Result |
|---|---|---|
| `session/start` | `commandId`, `sessionId?` (client may choose it), `workspaceRoot`, `modelId?`, `providerId?`, `approvalMode?`, `config?` (reserved) | `{session, viewCursor}`, auto-subscribed |
| `session/resume` | `commandId`, `sessionId`, `cursor?`, `history?` (auto/inline/snapshot/anchored), `excludeItems?` | `{session, viewCursor, history, pendingRequests[]}`, auto-subscribed |
| `turn/start` | `commandId`, `sessionId`, `input: TurnInputPart[]` (non-empty), `displayText?`, `ifBusy?` (queue\|steer\|replace, default queue), `reasoningEffort?` | `{commandId, turnId, disposition (started\|queued\|steered), startedNewTurn, status:"accepted"}` |
| `turn/steer` | `commandId`, `sessionId`, `expectedTurnId`, `input[]`, `reasoningEffort?` | `{commandId, turnId, status}`; `expectedTurnId` closes the race, a stale id errors so the caller can fall back |
| `turn/interrupt` | `commandId`, `sessionId`, `turnId?`, `retract?` | `{commandId, turnId, status}` |
| `turn/cancel`, `turn/unqueue` | `commandId`, `sessionId`, `turnId` (unqueue needs the exact queued `turnId` from the ack) | `{commandId, turnId, status}` |
| `userInput/cancel` | `commandId`, `sessionId`, `userInputId`, `reason?` | settles the prompt; the model sees a cancelled result |
| `approval/decide` | unused while approval mode is `allowAll` | n/a |

`TurnInputPart` is `{type:"text",text}` or `{type:"image",base64Data,mediaType,width?,height?}`.

`ApprovalMode` is a closed enum: `allowAll`, `promptUnmatched`, `onRequest`, `denyUnmatched`. Yolo parity is wire
`approvalMode:"allowAll"` plus the spawn flags `--disable-sandbox --trust-workspace`. `"never"` is invalid and the
probe returns `-32602 unknown variant`.

`session/start` with a client-chosen `sessionId` creates a new root session with exactly that id; an existing session
needs `session/resume`. Relevant errors: `sessionNotFound` (-32020), `sessionInUse`, `sessionNotLoaded`,
`commandRejected`, `backpressured`.

## Notifications

Server to client, auto-subscribed after `session/start` or `session/resume`:

`initialized`, `item/started` (full Item at revision 1), `item/delta {itemId, delta, field?}` where an absent `field`
means the item `text` and concatenation in cursor order equals the field (dotted paths appear, for example
`"summary.0"` and `"output"`), `item/updated` and `item/completed` (full Item at that revision or terminal),
`turn/started {turnId, commandId, sessionId, viewCursor, sourceRange}`, `turn/completed {turnId, terminal:
completed|failed|cancelled, error?{kind,message,retryable}, reason?, usage?: TokenUsage, durationMs?,
timeToFirstTokenMs?}`, `turn/retracted`, `turn/retryScheduled`, `turn/unqueued`, `session/tokenUsage`,
`session/contextUsage`, `session/modelChanged`, `session/approvalModeChanged`, `session/branchChanged`,
`session/goalChanged`, `session/todoListChanged`, `userInput/requested {userInputId, turnId, toolCallId, toolName,
itemId, questions[], autoResolutionMs?}`, `userInput/settled`, `approval/requested`, `approval/resolved`,
`approval/updated`, and `view/gap {after, next, sessionId}`.

Every notification carries `sessionId` and `viewCursor` (monotonic, opaque). View events also carry `sourceRange`.

## Gap handling

`view/page` serves the durable view: its own cursor namespace, and no `item/delta` records. The live `after` and `next`
cursors from `view/gap` are therefore not valid page anchors, and dropped deltas cannot be recovered. On a gap the
bridge keeps processing live events and pages the durable view from its start, applying only this turn's
`item/completed` `agentMessage` text and `turn/completed`. Paging failure never fails a turn that is still streaming;
it fails only when no live event has arrived since the gap. Cursors are opaque relay tokens, compared by string
equality only. Gaps proved unprovokable under a 25 s stdout stall, because the host backpressures instead.

An earlier design paged the live cursor namespace and spliced the hole into the live stream. It cannot work: the
durable view has different cursors, so that path is gone.

## Item kinds

`userMessage`, `agentMessage`, `reasoning`, `toolCall`, `userShell`, `subagent`, `workflow`, `reminderChild`,
`compaction`. The enum is open, so unknown kinds render generically.

Status is `inProgress`, `completed`, `failed`, `cancelled`, `rejected`, or `timedOut`; anything other than
`inProgress` is terminal.

The bridge consumes `agentMessage` (the `text` field feeds the stream), `reasoning` (`summary.N` deltas, ignorable),
and `toolCall` (progress diagnostics only). Item fields it reads: `itemId`, `kind`, `status`, `text`, `args`, `tool`,
`callId`, `turnId`, `usage`, `visibleOutput`, `outputRef`, `truncated`.

## TokenUsage

`inputTokens`, `outputTokens`, `cachedTokens`, and `reasoningTokens` are required. `cacheReadTokens` and
`cacheWriteTokens` are optional and provider-dependent.

## ErrorObject

`{code, message, data{kind: ErrorKind, ...}}`. The bridge branches on `data.kind` only. Notable kinds:
`notInitialized`, `invalidParams`, `sessionNotFound`, `sessionInUse`, `sessionNotLoaded`, `commandRejected`,
`backpressured`, the `turnNotFound` family via `notFound`, `userInputAlreadySettled`, `approvalAlreadyResolved`,
`overloaded` (retryable), `interrupted`, `cancelled`. The `message` string is never a branch point.

## Reserved and experimental surface

- `workflow/*` methods are specified but not served; they have no row in the bundle.
- Error codes -32060 to -32069 are reserved (they appear in the raw log, but v1 never emits them). -32012 is never
  assigned.
- The only grantable capability is `userShell`.
- `--experimental` is needed only for experimental surface. The stable surface covers everything the bridge uses.

## Probe results

- The init handshake and `model/list` work over ndjson. The model list includes `muse-spark-1.3` with a context limit
  of 1,007,997 and an output limit of 128,000; that differs from the exec `/v1` alias, which reports 262k.
- `session/start` rejects `approvalMode:"never"`; the yolo value is `allowAll`. A full turn ran green with it:
  `session/start` (the bridge-minted uuid is kept verbatim), `turn/start` (`turnId == commandId`,
  `disposition:"started"`), `item/started` and `item/delta` (`field:"text"` is sent explicitly, and an absent field
  also means text), `item/completed` (authoritative `item.text`), `session/tokenUsage`, then `turn/completed` with
  `usage: null`, `durationMs` 2024, and `timeToFirstTokenMs` 1932. Usage arrives through the `session/tokenUsage`
  notification.
- `session/started` fires on start. The `viewCursor` format is `v:<sessionId>:<ordinal>` and is treated as opaque.
- A host turn takes about 2 s where `muse exec` takes 9 to 14 s.
- Any `session/...` call before a start returns `-32020 sessionNotFound`; the host tracks its loaded set, and the
  durable store is shared with exec.

## Bridge design

Turn path:

- A persistent `muse serve` host backs `streamSimple`. It is spawned lazily with `--disable-sandbox
  --trust-workspace`, and the wire approval mode is `allowAll`.
- Muse session ids are bridge-minted uuidv7 values, never the OMP session id, and the `OMP id -> Muse id` pairs are
  persisted in `<agentDir>/omp-muse-bridge-sessions.json` so a restart reattaches the same Muse session.
- A session this bridge creates receives an initial prompt: OMP's system prompt with tool documentation stripped, the
  post-compaction context window, and the task. A resumed session gets the bare task.
- Deltas come from `item/delta` on `agentMessage` with `field:"text"`. Authoritative text comes from
  `item/completed`, and the terminal comes from `turn/completed`: completed maps to stop, failed to error, cancelled
  to aborted.
- An `options.signal` abort sends `turn/interrupt`, and the run settles itself as cancelled after a 3 s grace so it
  cannot outlive the user's ESC.
- Spawn, handshake, or open failure falls back to `muse exec` with a visible degraded warning. A host death mid-run
  puts the error in the outcome, marks the host dead, and respawns on the next call.

Steering:

- A module-level active-run registry is keyed by Muse session id.
- `pi.on("input")` first requires `ctx.model?.provider === "muse-code"`. The hook sees every interactive message, and
  without that gate a stale run swallowed input aimed at other providers.
- A run is steerable only while it owns a live turn: not settled, no terminal resolved, not interrupted, and not
  parked in the successor hold (`heldTerminal`).
- A landed steer returns `{handled:true}` and persists a `muse-steer` custom message rendered with its line breaks
  intact. A refused steer falls through to a normal turn.
- A single boolean tracks the unanswered steer. A counter drifted when steers were queued, rejected, or coalesced,
  and it re-armed the hold forever.
- `userInput/requested` is answered with an automatic `userInput/cancel`, matching exec behavior.

Progress reporting:

- Every non-answer item is reported as Markdown on the thinking channel with a `[Muse]` tag, the tool name and target
  in inline code, and a status glyph.
- Raw `visibleOutput` is never surfaced, so file contents and directory listings stay out of the transcript. Only a
  failure reason or a self-reported change stat is shown.
- Web tools report the query plus hostnames parsed with `new URL(...).hostname`.
- Todo calls are hidden from the activity lines and delivered to the provider as a structured snapshot, which renders
  as a themed panel through `registerAssistantThinkingRenderer`. OMP exposes no todo-write API to extensions, so the
  panel is display-only.

## Host behavior the bridge works around

- `session/start` on an id the durable store already holds is rejected as `commandRejected: "already exists or is
  reserved"` on muse 1.0.3; older builds used `sessionInUse` or `invalidParams`. The bridge treats all of those as
  "resume instead".
- A resumed session can be unobservable: `session/resume` may return an empty `viewCursor` and then stream zero
  notifications while the turn runs and completes durably. The bridge refuses such a session before admission
  (`MuseSessionUnusableError`), mints a replacement, and re-seeds context.
- `session/read` reports the stored record. Mid-flight it shows no active turn, so it is useless as a liveness gate
  for steering; run-local state is authoritative there.
- `turn/steer` is not a mid-generation interrupt. It is an inbox item drained at the next model-call boundary. A pure
  monologue answers in a successor run with its own `turnId` (`user_successor.run_origin: pure_followup`), which the
  bridge adopts so the steered answer reaches the same `streamSimple` call.
