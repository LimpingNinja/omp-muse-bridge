# Muse Session Protocol (MSP) — bridge wire notes

Source: `muse schema generate-json-schema --out /tmp/msp-schema --experimental` (muse 1.0.2, build d57a141c, schema version 1, fingerprint `sha256:03312c213efd…`).
Empirically probed against `muse serve` on 2026-09-04. This doc records what the bridge relies on; regenerate with `muse schema` after any muse upgrade.

## Transport

- `muse serve` = stdio session host. **Framing: newline-delimited JSON-RPC 2.0** (ndjson, no Content-Length headers) — probe-confirmed.
- Client owns stdin/stdout; that pipe is the host's only connection.
- Sandbox posture fixed at spawn (flags); **approval mode selected on the wire**, not a flag.
- Requests carry `trace?` (W3C passthrough). `params` omitted (never `null`) when empty. Results always objects.
- RequestId: integer or string; `1` ≠ `"1"`.

## Handshake (probe-confirmed)

1. `→ initialize {clientInfo{name,version}, capabilities{experimentalApi, requestedCapabilities[], optOutNotificationMethods[]}}`
   `← {serverInfo, userAgent, museHome, platformFamily/Os, schema{version,fingerprint}, grantedCapabilities[], experimentalApi, sessionDurability}`
2. `→ initialized` (client→server notification; accepted silently; server also lists it in notifications table).
3. Methods gated until initialize (`ErrorKind.notInitialized`).

## Idempotency: UUIDv7 everywhere

Every command takes `commandId` = **UUIDv7** minted by the client (server never mints). `turnId` derives from `turn/start`'s commandId (fresh turn: `turnId == commandId`). Bridge must implement uuidv7 (ms timestamp prefix + random, ver=7, var=10).

## Methods used by this bridge

| Method | Required params | Result |
|---|---|---|
| `session/start` | `commandId`, `sessionId?` (client-mintable!), `workspaceRoot`, `modelId?`, `providerId?`, `approvalMode?`, `config?` (reserved) | `{session, viewCursor}` — auto-subscribed |
| `session/resume` | `commandId`, `sessionId`, `cursor?`, `history?`(auto/inline/snapshot/anchored), `excludeItems?` | `{session, viewCursor, history, pendingRequests[]}` — auto-subscribed |
| `turn/start` | `commandId`, `sessionId`, `input: TurnInputPart[]` (non-empty), `displayText?`, `ifBusy?`(queue\|steer\|replace, default **queue**), `reasoningEffort?` | `{commandId, turnId, disposition(started\|queued\|steered), startedNewTurn, status:"accepted"}` |
| `turn/steer` | `commandId`, `sessionId`, `expectedTurnId`, `input[]`, `reasoningEffort?` | `{commandId, turnId, status}` — `expectedTurnId` closes the race (stale → error, fall back) |
| `turn/interrupt` | `commandId`, `sessionId`, `turnId?`, `retract?` | `{commandId, turnId, status}` |
| `turn/cancel` / `turn/unqueue` | `commandId`, `sessionId`, `turnId` (unqueue: exact queued turnId from ack) | `{commandId, turnId, status}` |
| `userInput/cancel` | `commandId`, `sessionId`, `userInputId`, `reason?` | settles prompt; model sees cancelled result |
| `approval/decide` | (unused while allowAll) | — |

TurnInputPart: `{type:"text",text}` | `{type:"image",base64Data,mediaType,width?+height?}`.

**ApprovalMode (closed enum, probe-confirmed):** `allowAll | promptUnmatched | onRequest | denyUnmatched`. YOLO parity = wire `approvalMode:"allowAll"` + spawn flags `--disable-sandbox --trust-workspace`. **`"never"` is INVALID** (probe: `-32602 unknown variant`).

`session/start` with client-chosen `sessionId` = new root session with that exact id; `session/resume` for existing. Errors: `sessionNotFound -32020`, `sessionInUse`, `sessionNotLoaded`, `commandRejected`, `backpressured`.

## Notifications (server→client; auto-subscribed after start/resume)

`initialized`, `item/started` (full Item rev 1), `item/delta` `{itemId, delta, field?}` — **absent `field` = item `text`**; concatenation in cursor order equals the field. `field` dotted paths e.g. `"summary.0"`, `"output"`. `item/updated` / `item/completed` (full Item at revision/terminal), `turn/started` `{turnId,commandId,sessionId,viewCursor,sourceRange}`, `turn/completed` `{turnId, terminal: completed|failed|cancelled, error?:{kind,message,retryable}, reason?, usage?:TokenUsage, durationMs?, timeToFirstTokenMs?}`, `turn/retracted`, `turn/retryScheduled`, `turn/unqueued`, `session/{tokenUsage,contextUsage,modelChanged,approvalModeChanged,branchChanged,goalChanged,todoListChanged}`, `userInput/requested` `{userInputId,turnId,toolCallId,toolName,itemId,questions[],autoResolutionMs?}`, `userInput/settled`, `approval/{requested,resolved,updated}`, `view/gap {after,next,sessionId}`.

All params carry `sessionId, viewCursor` (monotonic opaque), view events also `sourceRange`.

**Gap strategy (splice-fill):** on `view/gap {after, next}` the subscription dropped the open interval `(after, next)`; **live delivery resumes AT `next`**. Cursors are opaque relay tokens — compare only by string equality. The run marks recovery synchronously, buffers every later notification (including nested gaps, which chain serially), pages `view/page{cursor: after, direction: forward}` — `nextCursor` is the last event's cursor and never skips — replaying hole events until a returned event at cursor `== next` (discarded; the buffered live copy owns it), then drains the buffer in arrival order. `item/completed` still carries authoritative text; deltas are display-only. Paging that errors, stalls, or ends before `next` fails the turn with a diagnostic — a live-but-slow turn is never failed.

## Item kinds

`userMessage | agentMessage | reasoning | toolCall | userShell | subagent | workflow | reminderChild | compaction` (open enum — render unknown generically).
Status: `inProgress | completed | failed | cancelled | rejected | timedOut` (anything but inProgress = terminal).
Bridge consumes: `agentMessage` (text field → stream), `reasoning` (`summary.N` deltas — ignorable), `toolCall` (progress diagnostics only). Key fields: Item.{itemId,kind,status,text,args,tool,callId,turnId,usage,visibleOutput,outputRef,truncated}.

## TokenUsage

`{inputTokens, outputTokens, cachedTokens, reasoningTokens}` required; `cacheReadTokens`/`cacheWriteTokens` optional (provider-dependent).

## ErrorObject

`{code, message, data{kind:ErrorKind,…}}`. Bridge branches on `data.kind` only: notable kinds — `notInitialized`, `invalidParams`, `sessionNotFound`, `sessionInUse`, `sessionNotLoaded`, `commandRejected`, `backpressured`, `turnNotFound`-family via `notFound`, `userInputAlreadySettled`, `approvalAlreadyResolved`, `overloaded(retryable)`, `interrupted`, `cancelled`. Error `message` never a branch point (SS1.6).

## Reserved / experimental

- `workflow/*` methods spec'd, **not served** yet (no row in bundle).
- Reserved error block -32060..-32069 (raw log, v1 never emits); -32012 never assigned.
- Grantable capability: `userShell` only.
- `--experimental` needed only for experimental surface; stable surface suffices for bridge v1.

## Empirics (probes)

- Init handshake + `model/list` OK over ndjson; model list includes `muse-spark-1.3`, contextLimit 1,007,997, outputLimit 128,000 (note: differs from exec `/v1` 262k alias).
- `session/start` rejects `approvalMode:"never"`; yolo value is **`allowAll`**. Full turn probed green with it: session/start (bridge-minted uuid kept verbatim) → turn/start (`turnId==commandId`, `disposition:"started"`) → `item/started`/`item/delta` (`field:"text"` sent **explicitly**; absent=text too) → `item/completed` (authoritative `item.text`) → `session/tokenUsage` → `turn/completed` (`usage:null` — usage arrives via tokenUsage notification; durationMs 2024, TTFT 1932).
- `session/started` notification observed on start. viewCursor format `v:<sessionId>:<ordinal>` (opaque). Latency: host turn ~2 s vs exec ~9–14 s.
- `session/…` before start → `-32020 sessionNotFound` (host tracks loaded set; durable store shared with exec).

## Bridge design (tiers)

- **Tier 1:** persistent `muse serve` host under `streamSimple`. Lazy spawn `--disable-sandbox --trust-workspace`; wire `allowAll`. Muse session ids are **bridge-minted uuidv7, never the OMP session id**, and `OMP id -> Muse id` is persisted in `<agentDir>/omp-muse-bridge-sessions.json` so a restart reattaches the same Muse session. Sessions this call creates receive an initial prompt (OMP's system prompt with tool docs stripped + post-compaction context window + task); resumed sessions get the bare task. Deltas from `item/delta` (agentMessage, `field:"text"`); authoritative text from `item/completed`, terminal from `turn/completed`: completed→stop, failed→error, cancelled→aborted. `options.signal` abort → `turn/interrupt`, and the run settles itself as cancelled after a 3 s grace so it can never outlive the user's ESC. Spawn/handshake/open failure → **exec fallback** with a visible degraded warning. Host death mid-run → outcome carries the error, host marked dead, respawned next call.
- **Tier 2:** module-level active-run registry keyed by Muse session id. `pi.on("input")` **first requires the active model's provider to be `muse-code`** — the hook sees every interactive message, and without that gate a stale run swallowed input aimed at other providers. Then a run is steerable only while it owns a live turn: not settled, no terminal resolved, not interrupted, and **not parked in the successor hold** (`heldTerminal`). Landed steer → `{handled:true}` plus a `muse-steer` custom message rendered with its line breaks intact; refused steer → falls through to a normal turn. A single boolean tracks the unanswered steer (a counter drifted and re-armed the hold forever). `userInput/requested` → auto `userInput/cancel` (exec parity).
- **Progress reporting:** every non-answer item is reported as Markdown on the thinking channel with a `**[Muse]**` tag, tool name and target in inline code, and unicode status glyphs. Raw `visibleOutput` is never surfaced (file contents/listings); only a failure reason or a self-reported change stat. Web tools report the query plus hostnames parsed with `new URL(...).hostname`. Todo calls are hidden and delivered to the provider as a structured snapshot, which renders as a themed panel through `registerAssistantThinkingRenderer` — OMP exposes no todo-write API to extensions, so the panel is display-only.

## Gap strategy (rewritten after E2/E3)

`view/page` serves the **durable** view: its own cursor namespace, no `item/delta`. Live `after`/`next` cursors from `view/gap` are therefore invalid page anchors, and dropped deltas are unrecoverable by design. On a gap the bridge keeps processing live events and pages the durable view from its start, applying only this turn's `item/completed agentMessage` text and `turn/completed`. Paging failure never fails a turn that is still streaming; it fails only when no live event has arrived since the gap. Gaps proved unprovokable under a 25 s stdout stall (the host backpressures).

## Host quirks worth remembering

- `session/start` on an id the durable store already holds is rejected as `commandRejected: "already exists or is reserved"` on muse 1.0.3 (older builds used `sessionInUse`/`invalidParams`); the bridge treats that as "resume instead".
- **A resumed session can be unobservable:** `session/resume` may return an empty `viewCursor` and then stream zero notifications while the turn runs and completes durably. The bridge refuses such a session before admission (`MuseSessionUnusableError`) and mints a replacement, re-seeding context.
- `session/read` reports the **stored** record. Mid-flight it shows no active turn, so it is useless as a liveness gate for steering — run-local state is authoritative there.
- `turn/steer` is not a mid-generation interrupt: it is an inbox item drained at the next model-call boundary. A pure monologue answers in a **successor run** with its own `turnId` (`user_successor.run_origin: pure_followup`), which the bridge adopts so the steered answer reaches the same `streamSimple`.
