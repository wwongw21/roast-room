# roast-room engineering handoff

Review date: **22 October 2026**. All findings remain **OPEN**. This handoff contains proposed repairs and release checks; no source fixes or new runtime acceptance are claimed.

**Reviewed source:** [`main` at `f5e7b631a172ecc8ef5488760654ad37f24204b0`](https://github.com/wwongw21/roast-room/tree/f5e7b631a172ecc8ef5488760654ad37f24204b0).

The full structured handoff is in [report.json](report.json). Historical commands retain their original review-workspace paths; read the prerequisites before running them. Only repository-specific diagnostics listed below are attached.

## Audience and required outcome

### Audience

Engineer taking ownership of the local Node app, API runner and saved-session lifecycle.

### Outcome

Implement the two confirmed API-runner reliability fixes, decide on the lower-priority SSE hardening, and verify persistence and concurrency without incurring API costs during regression testing.

## Scope and reviewed branches

Default-branch application server, SSE/API runner, folder viewer, scoring/card parsing, persistence, frontend event handling, smoke script and bundled sessions.

## Architecture

### Item 1

#### Component

Local HTTP entry point

#### Source

app/server.mjs

#### Responsibility

Serves static frontend, session APIs and SSE; binds 127.0.0.1, default port 4730. COUNCIL_RUNNER defaults to viewer; api enables paid council creation.

### Item 2

#### Component

API council orchestration

#### Source

app/lib/council.mjs

#### Responsibility

Creates in-memory sessions, asks Chair/seat models for rounds, calculates scores, emits events and persists API-runner sessions. A global running ID in server.mjs represents the intended single active council.

### Item 3

#### Component

Anthropic transport

#### Source

app/lib/anthropic.mjs

#### Responsibility

fetch-based JSON/SSE requests, retries on selected HTTP statuses, incremental text delivery and token accounting. The paid smoke command uses this transport.

### Item 4

#### Component

Folder viewer

#### Source

app/lib/watch.mjs

#### Responsibility

Polls Claude Code council folders every second and translates JSON/Markdown stage files into the event stream. This is the default execution mode and does not create model calls.

### Item 5

#### Component

Seat interpretation and frontend

#### Source

app/lib/seats.mjs; app/public/app.js; app/public/pdf.js

#### Responsibility

Loads advisor instructions, parses card fields and checks quoted text; browser queues playback events and builds the PDF. Unparsed votes can default to endorse in scoring/UI paths, which increases the importance of complete cards.

### Item 6

#### Component

Filesystem configuration

#### Source

app/lib/env.mjs

#### Responsibility

For this standalone layout, sessions live beside app/ under sessions/ and .env is read from repository root. Layout detection depends on .claude/skills/roast-room; preserve it in copied test fixtures.

## Immediate mitigations

1. Keep the default COUNCIL_RUNNER=viewer when the app is only displaying councils run by Claude Code; the persistence collision and POST race are in the optional API runner.

2. Before additional API-runner councils, copy existing sessions to a separate backup location. A changed title is not a complete collision prevention measure because titles are normalized and truncated.

3. For API mode, avoid overlapping submissions from multiple tabs until the server guard is repaired. UI button disabling alone does not enforce the server invariant.

4. Keep regression transport calls mocked. npm run smoke is a live model call and was not run during the review.

## Prioritized sequence

### Item 1

#### Step

1

#### Finding

ROAST-1

#### Action

Protect persisted session identity and backward-compatible history reads before running more repeated decisions.

### Item 2

#### Step

2

#### Finding

ROAST-2

#### Action

Enforce the single-council invariant after asynchronous body parsing, then test overlapping clients.

### Item 3

#### Step

3

#### Finding

ROAST-3

#### Action

Require a complete SSE protocol and define incomplete-card behavior. This is lower priority because only synthetic clean truncation was demonstrated.

### Item 4

#### Step

4

#### Action

Add cheap offline regressions for persistence, request concurrency and protocol completion, followed by viewer/optional live API acceptance on the target machine.

## Findings and implementation handoff

### ROAST-1 Medium: Repeated council titles overwrite saved sessions

**Status:** OPEN. [Pinned source](https://github.com/wwongw21/roast-room/blob/f5e7b631a172ecc8ef5488760654ad37f24204b0/app/lib/council.mjs#L428).

#### Evidence classification

Confirmed through the validation described below

#### Observed mechanism

save() derives the output directory from date + slugified state.title or prompt, omitting the unique session ID. fs.writeFileSync replaces an existing events.json at that path.

#### Impact and scope

Running the same decision again on the same day silently destroys the previous saved session and report. A second failed attempt can overwrite a previous successful council with the same prompt. This affects the optional API runner; the default Claude Code viewer writes its own folders.

#### Repair direction

Include the unique session ID in the directory name, preserve existing sessions, and use atomic writes for session files.

#### Verification already obtained

Executed production save/listSaved/loadSaved from an isolated copied app with two different session IDs and identical prompts: only the second remained and loading the first returned null. Independently checked by a second reviewer; the old in-memory session can survive until restart, but persisted history is lost.

#### Priority

First

#### Change surface

1. app/lib/council.mjs:428-443 save

2. app/lib/council.mjs:468-479 listSaved/loadSaved

3. Any documentation or consumer assuming date-title directory names

#### Repair steps

1. Use the stable unique session ID in the persisted directory name; retain the human-readable title only as additional metadata or a non-identity suffix.

2. Never replace a different session's events.json. Treat an existing directory belonging to another ID as a collision requiring a new destination or an explicit error.

3. Write session files through a temporary file plus rename where supported so interruption cannot leave a partially written JSON history file.

4. Keep listSaved/loadSaved able to read previously created date-title directories. No bulk rename of existing user sessions is required to correct new writes.

#### Invariants

1. One distinct session ID owns one persisted session; a repeated title never removes an earlier session.

2. A successful new save does not make any previous ID unresolvable.

3. Existing saved-session formats remain readable.

#### Acceptance criteria

1. Two same-day API sessions with the same prompt/title both appear in history after server restart.

2. Both IDs load their own events and report content.

3. An interrupted write leaves either the previous valid file or the new valid file, with a clear failure signal if persistence did not complete.

#### Regression cases

1. Identical titles; titles differing only in punctuation/case; titles differing after the 50-character slug prefix.

2. Two saves with different IDs and an existing unrelated date-title directory.

3. Repeated save of the same session ID, legacy history reads and injected filesystem failure.

#### Risks and rollback

1. Directory names are an external file-navigation surface; preserve old readers and document the new naming scheme.

2. Back up sessions before deployment. If reverting, retain new directories and verify the previous reader can enumerate them; do not merge or delete session data to roll back code.

#### Detailed handoff evidence

The production save/listSaved/loadSaved functions in an isolated copied app retained only the second of two distinct IDs with the same prompt. A second reviewer independently confirmed the mechanism. In-memory data may last until restart; persisted history is already overwritten.

### ROAST-2 Medium: Concurrent submissions bypass the single-council guard

**Status:** OPEN. [Pinned source](https://github.com/wwongw21/roast-room/blob/f5e7b631a172ecc8ef5488760654ad37f24204b0/app/server.mjs#L38).

#### Evidence classification

Confirmed through the validation described below

#### Observed mechanism

The server checks running status before awaiting readJson(req). Two requests that begin together both pass the check and later start independent councils; running points only to the last.

#### Impact and scope

Multiple tabs or overlapping clients can start simultaneous paid councils despite the advertised one-at-a-time rule, duplicating API spending and making one running session absent from the running-session pointer.

#### Repair direction

Acquire the single-run reservation after reading/validating the body, with no await between the running check and startCouncil; or reserve before awaiting and release on failed requests.

#### Verification already obtained

Actual HTTP server reproduction in a copied app: opened two request bodies, completed the first then the second, and both returned 200 with distinct running IDs. Outbound fetch was mocked to a pending promise, so no API requests or costs occurred. Independently checked by a second reviewer.

#### Priority

Second

#### Change surface

1. app/server.mjs:38-45 POST /api/council

2. app/lib/council.mjs startCouncil/getSession status lifecycle

#### Repair steps

1. Read and validate the body, then re-check running immediately before startCouncil with no intervening await; alternatively reserve a single-run slot before parsing and release it on every validation/body error.

2. Return 409 to the second valid submission while a council is running and keep running pointing to the accepted session.

3. Cover failed/invalid bodies and completed/error councils so the guard cannot remain permanently occupied.

#### Invariants

1. At most one API council may be admitted at once.

2. The running pointer refers to the only accepted active session.

3. Rejected requests trigger zero model calls.

#### Acceptance criteria

1. Two overlapping request bodies produce one 200 and one 409, with exactly one startCouncil invocation.

2. A later request succeeds after the previous council completes or fails.

3. Malformed/oversized bodies do not permanently lock the runner.

#### Regression cases

1. Two requests begun before either body completes; finish them in either order.

2. A valid request overlapping an invalid or disconnected request.

3. Council startup failure and completion, followed by retry.

#### Risks and rollback

1. Changing the guard can accidentally reserve on invalid inputs or reject all future submissions. Exercise the entire release lifecycle.

2. If the repair must be reverted, use viewer mode while preserving saved data; do not rely solely on frontend disabled buttons.

#### Detailed handoff evidence

A real loopback server with outbound fetch mocked accepted two pending request bodies and returned 200 with distinct running IDs. No paid requests were made. Independently checked by a second reviewer.

### ROAST-3 Low: Truncated SSE streams are accepted as complete advisor cards

**Status:** OPEN. [Pinned source](https://github.com/wwongw21/roast-room/blob/f5e7b631a172ecc8ef5488760654ad37f24204b0/app/lib/anthropic.mjs#L39).

#### Evidence classification

Confirmed protocol validation omission; upstream occurrence not observed

#### Observed mechanism

The stream reader returns accumulated text on body EOF without requiring message_stop or checking a max_tokens stop reason. runSeat then parses and emits it as seat_done.

#### Impact and scope

A gracefully closed incomplete response, or a token-limited response missing its later fields, can enter scoring and verdict generation as a complete card; missing votes default to endorse elsewhere. Transport errors that reject iteration are already caught, so this finding concerns EOF without protocol completion and unchecked stop reasons.

#### Repair direction

Require the Anthropic protocol completion event and validate stop_reason and required card fields before marking a seat done; fail clearly or retry an incomplete seat.

#### Verification already obtained

Mocked fetch returned a successful SSE body containing only a content_block_delta and EOF; stream returned the partial text without error. No remote API was contacted.

#### Priority

Lower-priority protocol hardening

#### Change surface

1. app/lib/anthropic.mjs:26-63 stream

2. app/lib/council.mjs:298-315 runSeat

3. Card parser and missing-vote defaults

#### Repair steps

1. Track receipt of message_stop and the message_delta stop_reason; fail a clean EOF before protocol completion.

2. Decide how max_tokens, refused output and missing mandatory card fields are surfaced; do not silently mark incomplete text as seat_done.

3. Make retries explicit and bounded, avoiding duplicate displayed deltas or double-counted usage.

#### Invariants

1. A completed seat card came from a completed supported model response.

2. An incomplete card cannot be interpreted as an implicit endorsement.

#### Acceptance criteria

1. A normal split-chunk UTF-8 SSE response completes successfully.

2. EOF without message_stop and a max_tokens stop reason fail clearly without a completed card.

3. Protocol errors leave the session in an inspectable error state rather than manufacturing votes.

#### Regression cases

1. Normal message_stop; clean truncated EOF; rejected stream iteration; SSE error event; max_tokens; partial lines split across network chunks.

#### Risks and rollback

1. The synthetic probe proves acceptance of clean truncated SSE; ordinary broken HTTP transport often already throws. Do not describe this as an observed Anthropic outage.

2. Stricter completion checks can reject previously tolerated responses. Capture protocol metadata without credential values; use controlled fixtures to establish compatibility before enabling live calls.

#### Detailed handoff evidence

A mocked HTTP 200 SSE body containing only one content_block_delta returned its partial text without an error. Actual upstream clean truncation was not observed.

## Verification

### Prerequisites

1. Node.js >=20 (review host used v24.19.0), Python 3 for bundled quote checker, pinned source checkout.

2. Existing diagnostics assume /workspace/review and a copied roast-sandbox containing app/, package.json and .claude/. They are prior-review diagnostic scripts, not an installed project test suite.

3. For the persistence diagnostic, create an isolated sandbox with no bundled or user session history. The script writes two same-title diagnostic sessions and asserts listSaved().length === 1 after their collision; copied example sessions would invalidate that assertion. Keep all user sessions outside this sandbox.

4. For roast-http-repro.mjs, loopback port 14731 must be free. The diagnostic launches and terminates its own server; it is not designed to attach to a running user server.

### Recorded commands

#### Item 1

##### Command

```
node /workspace/review/roast-repro.mjs
```

##### Observed result

PASS: demonstrates persistence overwrite and clean SSE EOF acceptance using the copied app and mocked fetch. Its assertions encode current bugs; they must be inverted or replaced for post-fix regression tests.

#### Item 2

##### Command

```
node /workspace/review/roast-http-repro.mjs
```

##### Observed result

PASS: demonstrates two accepted concurrent councils on port 14731. Uses mock-fetch.mjs to prevent remote calls and terminates its child server.

#### Item 3

##### Command

```
find app -name '*.mjs' -o -name '*.js' | xargs -n1 node --check
```

##### Working directory

Pinned roast-room checkout

##### Observed result

PASS: syntax only.

#### Item 4

##### Command

```
python .claude/skills/roast-room/scripts/check_quotes.py sessions/<example-folder>
```

##### Observed result

Executed against each of three existing example folders. take-the-seed and first-sales-hire passed; raise-coaching-price reported one unverified quote. This is an example validation mismatch, not proof of fabricated attribution.

### Other observed checks

1. Local viewer HTTP: /, /api/seats and /api/sessions returned 200. All three bundled saved sessions loaded with status done and a verdict event.

2. No automated test suite or CI workflow found; GitHub Actions API returned zero runs for this fork.

### Post fix gates not run

1. Run new offline regression tests against repaired code; old bug-demonstration assertions are not expected to keep passing.

2. Open viewer mode in the target browser, replay all three examples and verify live folder ingestion.

3. Render/download a PDF and inspect pagination/text on the target browser.

4. If API mode is required, explicitly run one budgeted live council using a configured account, verify model IDs/protocol completion, reload history after restart and confirm usage. No live acceptance was run here.

### Evidence to preserve

1. Pinned SHA, both local diagnostic scripts and copied fixture, observed response statuses, saved session IDs and file contents.

2. Any session backups made before a future repair. Never use a live user sessions directory for collision tests.

## Completion checklist

1. ROAST-1 and ROAST-2 repair commits reviewed independently.

2. New regressions verify expected corrected behavior, including failure paths.

3. Legacy and new persisted sessions survive restart and load independently.

4. Viewer smoke remains green; API acceptance performed only if API mode is in release scope.

5. Update OPEN statuses only after fix evidence exists; do not treat this handoff as remediation.

## Limitations

1. No browser/PDF/live API checks were performed.

2. No remote exploit was demonstrated; concurrency was a local two-client correctness test.

3. The baseline review remains a risk-focused source review rather than an exhaustive security audit.

## Delivery and diagnostic files

### Destination repository

wwongw21/roast-room

### Status

All findings remain OPEN; documentation transfer only.

### Portable evidence

This JSON retains the complete repository-specific handoff. Historical /workspace paths are evidence references and prerequisites, not portable hyperlinks. Applicable repository-specific diagnostics are included alongside the report.

### Diagnostics included

1. roast-repro.mjs

2. roast-http-repro.mjs

3. mock-fetch.mjs

### Not included

Original environments, model weights, user data and complete source snapshots are not included. Clone the pinned source and follow the recorded prerequisites. Bug-demonstration scripts intentionally assert pre-fix behavior; they are not a post-fix passing suite.

- [roast-repro.mjs](diagnostics/roast-repro.mjs)
- [roast-http-repro.mjs](diagnostics/roast-http-repro.mjs)
- [mock-fetch.mjs](diagnostics/mock-fetch.mjs)

## Remaining review limits

1. No real Anthropic calls or paid smoke test; no configured key.

2. No browser automation or PDF rendering validation.

3. No automated test suite or CI workflow found. GitHub Actions API returned no workflow runs on this fork.

4. This broad review is not an exhaustive audit or formal security scan.

