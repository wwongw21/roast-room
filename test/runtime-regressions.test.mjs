import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function withAppFixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "roast-room-test-"));
  const app = path.join(root, "app");
  fs.cpSync(path.join(sourceRoot, "app"), app, { recursive: true });
  fs.mkdirSync(path.join(root, ".claude", "skills", "roast-room"), { recursive: true });
  const load = async (relativePath) => import(`${pathToFileURL(path.join(app, relativePath)).href}?fixture=${randomUUID()}`);
  try {
    await run({ root, app, load });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function session(id, title, marker) {
  return {
    id,
    prompt: "A synthetic decision for a regression fixture.",
    mode: "full",
    status: "done",
    events: [{ type: "fixture", marker }],
    state: { title },
  };
}

test("saved sessions keep distinct IDs, retain legacy folders, and update only their own data", async () => {
  await withAppFixture(async ({ root, load }) => {
    const council = await load("lib/council.mjs");
    const sessionsDir = path.join(root, "sessions");

    const legacyDir = path.join(sessionsDir, "2026-10-22-same-decision");
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, "events.json"), JSON.stringify({
      id: "legacy-session",
      prompt: "A legacy prompt.",
      mode: "quick",
      status: "done",
      events: [{ type: "fixture", marker: "legacy" }],
    }));

    const variants = [
      session("2026-10-22-id-one", "Same Decision", "first"),
      session("2026-10-22-id-two", "Same Decision", "second"),
      session("2026-10-22-id-three", "Same! Decision?", "punctuation"),
      session("2026-10-22-id-four", "same decision", "case"),
      session("2026-10-22-id-five", `${"x".repeat(55)} first`, "long one"),
      session("2026-10-22-id-six", `${"x".repeat(55)} second`, "long two"),
    ];
    for (const item of variants) council.save(item);

    const listed = council.listSaved();
    for (const item of variants) {
      assert.equal(council.loadSaved(item.id).events[0].marker, item.events[0].marker);
      assert.equal(listed.some((entry) => entry.id === item.id), true);
    }
    assert.equal(council.loadSaved("legacy-session").events[0].marker, "legacy");

    const repeated = variants[0];
    const ownedDir = repeated.dir;
    repeated.state.title = "A later title for this same session";
    council.save(repeated);
    assert.equal(repeated.dir, ownedDir, "a repeated save of the same ID should update its folder");
    repeated.events = [{ type: "fixture", marker: "updated same ID" }];
    council.save(repeated);
    assert.equal(council.loadSaved(repeated.id).events[0].marker, "updated same ID");

    const otherOwner = { id: "different-id", prompt: "Other prompt", events: [{ marker: "do not replace" }] };
    fs.writeFileSync(path.join(ownedDir, "events.json"), JSON.stringify(otherOwner));
    repeated.events = [{ type: "fixture", marker: "new owner must use a new folder" }];
    council.save(repeated);
    assert.notEqual(repeated.dir, ownedDir, "a folder owned by another ID must not be reused");
    assert.equal(JSON.parse(fs.readFileSync(path.join(ownedDir, "events.json"), "utf8")).id, "different-id");
    assert.equal(council.loadSaved(repeated.id).events[0].marker, "new owner must use a new folder");
  });
});

test("an interrupted atomic replacement leaves the previous valid file intact", async () => {
  await withAppFixture(async ({ root, load }) => {
    const { atomicWriteFile } = await load("lib/council.mjs");
    const target = path.join(root, "previous.json");
    atomicWriteFile(target, JSON.stringify({ version: "previous" }));
    const failingFs = new Proxy(fs, {
      get(targetFs, key) {
        if (key === "renameSync") return () => { throw new Error("synthetic rename interruption"); };
        const value = Reflect.get(targetFs, key, targetFs);
        return typeof value === "function" ? value.bind(targetFs) : value;
      },
    });

    assert.throws(() => atomicWriteFile(target, JSON.stringify({ version: "new" }), failingFs), /synthetic rename interruption/);
    assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), { version: "previous" });
    assert.deepEqual(fs.readdirSync(root).filter((name) => name.endsWith(".tmp")), []);
  });
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

async function post(port, body) {
  const response = await fetch(`http://127.0.0.1:${port}/api/council`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  return { status: response.status, body: await response.json() };
}

async function withServer(load, councilApi, run) {
  const { createServer } = await load("server.mjs");
  const server = createServer({
    runner: "api",
    councilApi,
    watchApi: { getLive: () => null, listLive: () => [], runningId: () => null },
  });
  const port = await listen(server);
  try {
    await run(port);
  } finally {
    const closed = once(server, "close");
    server.close();
    await closed;
  }
}

function fakeCouncil() {
  const sessions = new Map();
  let starts = 0;
  return {
    sessions,
    get starts() { return starts; },
    listSaved: () => [],
    loadSaved: () => null,
    subscribe: () => {},
    getSession: (id) => sessions.get(id),
    startCouncil(prompt, mode) {
      starts += 1;
      const s = { id: `fixture-${starts}`, prompt, mode, status: "running", events: [] };
      sessions.set(s.id, s);
      return s;
    },
  };
}

function pendingPost(port, prompt) {
  let finish;
  const result = new Promise((resolve) => { finish = resolve; });
  const req = http.request({
    host: "127.0.0.1",
    port,
    method: "POST",
    path: "/api/council",
    headers: { "content-type": "application/json" },
  }, (res) => {
    let text = "";
    res.on("data", (chunk) => { text += chunk; });
    res.on("end", () => finish({ status: res.statusCode, body: JSON.parse(text) }));
  });
  req.write(JSON.stringify({ prompt }));
  return { req, result };
}

test("overlapping council bodies admit only the first completed valid request", async () => {
  await withAppFixture(async ({ load }) => {
    for (const acceptedIndex of [0, 1]) {
      const council = fakeCouncil();
      await withServer(load, council, async (port) => {
        const clients = [
          pendingPost(port, "The first synthetic decision."),
          pendingPost(port, "The second synthetic decision."),
        ];
        await new Promise((resolve) => setTimeout(resolve, 20));

        clients[acceptedIndex].req.end();
        const accepted = await clients[acceptedIndex].result;
        const rejectedIndex = 1 - acceptedIndex;
        clients[rejectedIndex].req.end();
        const rejected = await clients[rejectedIndex].result;

        assert.equal(accepted.status, 200);
        assert.equal(rejected.status, 409);
        assert.equal(council.starts, 1, "a rejected request must not start another council");
      });
    }
  });
});

test("invalid, disconnected, failed-start, and finished councils do not lock later requests", async () => {
  await withAppFixture(async ({ load }) => {
    const council = fakeCouncil();
    let failStartup = true;
    let startupAttempts = 0;
    const startCouncil = council.startCouncil.bind(council);
    council.startCouncil = (...args) => {
      startupAttempts += 1;
      if (failStartup) {
        failStartup = false;
        throw new Error("synthetic startup failure");
      }
      return startCouncil(...args);
    };

    await withServer(load, council, async (port) => {
      assert.equal((await post(port, "{")).status, 400);
      assert.equal((await post(port, JSON.stringify({ prompt: "short" }))).status, 400);
      assert.equal((await post(port, JSON.stringify({ prompt: 42 }))).status, 400);
      assert.equal((await post(port, JSON.stringify({ prompt: "x".repeat(100_001) }))).status, 400);
      assert.equal(council.starts, 0);

      const aborted = http.request({
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/api/council",
        headers: { "content-type": "application/json" },
      });
      const clientClosed = new Promise((resolve) => {
        aborted.once("error", resolve);
        aborted.once("close", resolve);
      });
      aborted.write('{"prompt":');
      await new Promise((resolve) => setTimeout(resolve, 20));
      aborted.destroy();
      await clientClosed;

      assert.equal((await post(port, JSON.stringify({ prompt: "A valid synthetic decision." }))).status, 500);
      assert.equal((await post(port, JSON.stringify({ prompt: "A valid synthetic decision." }))).status, 200);
      const active = [...council.sessions.values()].at(-1);
      active.status = "error";
      assert.equal((await post(port, JSON.stringify({ prompt: "A retry after council failure." }))).status, 200);
      const nextActive = [...council.sessions.values()].at(-1);
      nextActive.status = "done";
      const next = await post(port, JSON.stringify({ prompt: "Another valid synthetic decision." }));
      assert.equal(next.status, 200);
      assert.equal(startupAttempts, 4, "invalid and disconnected requests must not attempt startup");
      assert.equal(council.starts, 3, "a startup failure must not prevent later sessions");
    });
  });
});

const sse = (...events) => events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
const completedStream = (text, stopReason = "end_turn") => sse(
  { type: "message_start", message: { usage: { input_tokens: 3 } } },
  { type: "content_block_delta", delta: { type: "text_delta", text } },
  { type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: 2 } },
  { type: "message_stop" },
);

async function waitUntil(predicate, description, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

test("a failed first seat keeps HTTP admission closed until staggered round work drains", async () => {
  await withAppFixture(async ({ load }) => {
    const council = await load("lib/council.mjs");
    const originalFetch = globalThis.fetch;
    let seatCalls = 0;
    let activeSeatCalls = 0;
    let startAttempts = 0;
    let session;
    const liveEvents = [];
    const setup = {
      title: "Synthetic round failure",
      decision: "Test council failure handling",
      brief: "A synthetic fixture only.",
      options: [{ id: "A", label: "Test" }, { id: "B", label: "Wait" }],
      assumptions: [],
      weights: [],
      quick_seats: ["bezos", "graham", "hormozi", "garyvee"],
    };
    const validOpeningCard = [
      "SEAT: TEST",
      "STANCE: Yes",
      "OPTION SCORES: A 7 · B 4",
      "PILLAR SCORE: 7/10",
      "CONFIDENCE: 3/5",
      "RUIN RISK: possible",
      "DOOR: two-way",
      "THE CALL: Choose option A.",
      "WHY:",
      "1. This is a synthetic test.",
      "THE RISK I SEE: The fixture could end early.",
      "WHAT WOULD CHANGE MY MIND: A passing check.",
      "WHAT I'D DO THIS WEEK: Run the test.",
      "QUESTION FOR THE FOUNDER: Did the test pass?",
    ].join("\n");

    globalThis.fetch = async (_url, init) => {
      if (new URL(_url).hostname === "127.0.0.1") return originalFetch(_url, init);
      const requestBody = JSON.parse(init.body);
      if (requestBody.output_config) {
        return new Response(JSON.stringify({
          stop_reason: "end_turn",
          usage: { input_tokens: 2, output_tokens: 3 },
          content: [{ type: "text", text: JSON.stringify(setup) }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }

      seatCalls += 1;
      activeSeatCalls += 1;
      try {
        if (seatCalls > 1) await new Promise((resolve) => setTimeout(resolve, 700));
        const text = seatCalls === 1 ? "STANCE: Yes" : validOpeningCard;
        return new Response(completedStream(text), { status: 200 });
      } finally {
        activeSeatCalls -= 1;
      }
    };

    const councilApi = {
      ...council,
      startCouncil(prompt, mode) {
        startAttempts += 1;
        if (startAttempts > 1) return { id: `unexpected-${startAttempts}`, status: "running" };
        session = council.startCouncil(prompt, mode);
        session.subs.add({
          write(line) {
            if (line.startsWith("data: ")) liveEvents.push(JSON.parse(line.slice(6)));
          },
        });
        return session;
      },
    };

    try {
      await withServer(load, councilApi, async (port) => {
        const accepted = await post(port, JSON.stringify({ prompt: "A synthetic council decision.", mode: "quick" }));
        assert.equal(accepted.status, 200);
        assert.ok(session, "the real council runner should have started");

        await waitUntil(() => session.events.some((event) => event.type === "seat_error"), "first seat failure");
        await waitUntil(() => seatCalls >= 2 && activeSeatCalls > 0, "a delayed sibling seat request");

        const overlapping = await post(port, JSON.stringify({ prompt: "A second synthetic decision." }));
        assert.equal(overlapping.status, 409, "HTTP must reject a second council while the old round is draining");
        assert.equal(startAttempts, 1, "rejected work must not enter the council runner");
        assert.equal(session.status, "running", "the council must remain active while sibling work is pending");

        await waitUntil(() => session.status === "error", "the council's terminal error state");
        assert.equal(seatCalls, 4, "all four scheduled quick-mode seat calls should have settled");
        assert.equal(activeSeatCalls, 0, "terminal state must not leave model requests in flight");
        assert.equal(session.events.filter((event) => event.type === "seat_done").length, 3, "the three valid sibling cards should settle before failure is reported");
        assert.equal(session.events.some((event) => event.type === "round_done" || event.type === "verdict"), false, "a failed round must not score or produce a verdict");
        const errorIndex = session.events.findIndex((event) => event.type === "error");
        assert.notEqual(errorIndex, -1, "the failed council should retain an inspectable error event");
        assert.equal(session.events.slice(errorIndex + 1).some((event) => event.type.startsWith("seat_")), false, "seat events must not arrive after the terminal error");
        const liveEndIndex = liveEvents.findIndex((event) => event.type === "end");
        assert.notEqual(liveEndIndex, -1, "the failed council should close its live event stream");
        assert.equal(liveEvents.slice(liveEndIndex + 1).length, 0, "no live events may arrive after end");

        const terminalEventCount = session.events.length;
        const terminalLiveEventCount = liveEvents.length;
        const callsAtTerminal = seatCalls;
        await new Promise((resolve) => setTimeout(resolve, 75));
        assert.equal(session.events.length, terminalEventCount, "no late session events should arrive after failure");
        assert.equal(liveEvents.length, terminalLiveEventCount, "no late live events should arrive after end");
        assert.equal(seatCalls, callsAtTerminal, "no model work should start after the terminal error");
      });
    } finally {
      if (session) {
        await waitUntil(() => seatCalls === 4 && activeSeatCalls === 0, "fixture model calls to drain").catch(() => {});
        await waitUntil(() => session.status !== "running", "fixture council to finish").catch(() => {});
      }
      globalThis.fetch = originalFetch;
    }
  });
});

test("stream accepts split UTF-8 only after a supported complete message", async () => {
  await withAppFixture(async ({ load }) => {
    const { stream, usage } = await load("lib/anthropic.mjs");
    const originalFetch = globalThis.fetch;
    const originalUsage = { ...usage };
    const encoded = new TextEncoder().encode(completedStream("Hello 🌮"));
    globalThis.fetch = async () => new Response(new ReadableStream({
      start(controller) {
        for (let i = 0; i < encoded.length; i += 1) controller.enqueue(encoded.slice(i, i + 1));
        controller.close();
      },
    }), { status: 200 });
    try {
      const deltas = [];
      assert.equal(await stream({ model: "fixture", system: "fixture", messages: [], onText: (text) => deltas.push(text) }), "Hello 🌮");
      assert.equal(deltas.join(""), "Hello 🌮");
      assert.equal(usage.calls, originalUsage.calls + 1);
    } finally {
      globalThis.fetch = originalFetch;
      Object.assign(usage, originalUsage);
    }
  });
});

test("stream rejects truncation, refusal, token limits, protocol errors, and incomplete cards", async () => {
  await withAppFixture(async ({ load }) => {
    const { stream, json } = await load("lib/anthropic.mjs");
    const seats = await load("lib/seats.mjs");
    const council = await load("lib/council.mjs");
    const originalFetch = globalThis.fetch;
    const cases = [
      [sse({ type: "message_start", message: { usage: {} } }, { type: "content_block_delta", delta: { type: "text_delta", text: "partial" } }), /before message_stop/i],
      [completedStream("partial", "max_tokens"), /max_tokens/i],
      [completedStream("refusal text", "refusal"), /refusal/i],
      [completedStream("unsupported", "pause_turn"), /unsupported stop reason/i],
      [completedStream("unexpected stop sequence", "stop_sequence"), /unsupported stop reason/i],
      [sse({ type: "message_start", message: { usage: {} } }, { type: "message_delta", delta: { stop_reason: null } }, { type: "message_stop" }), /without a stop reason/i],
      [sse({ type: "error", error: { message: "fixture stream failure" } }), /fixture stream failure/],
    ];
    try {
      for (const [body, error] of cases) {
        globalThis.fetch = async () => new Response(body, { status: 200 });
        await assert.rejects(stream({ model: "fixture", system: "fixture", messages: [] }), error);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }

    for (const [stop_reason, message] of [
      ["max_tokens", /max_tokens/i],
      ["refusal", /refusal/i],
      ["model_context_window_exceeded", /unsupported stop reason/i],
    ]) {
      globalThis.fetch = async () => new Response(JSON.stringify({
        stop_reason,
        usage: { input_tokens: 2, output_tokens: 1 },
        content: [{ type: "text", text: "fixture" }],
      }), { status: 200, headers: { "content-type": "application/json" } });
      await assert.rejects(json({ model: "fixture", system: "fixture", prompt: "fixture", schema: {} }), message);
    }
    globalThis.fetch = originalFetch;

    const completeVote = [
      "VOTE: Endorse with amendment",
      "OPTION SCORES: A 7 · B 5",
      "FINAL SCORE: 8/10",
      "FINAL PILLAR SCORE: 7/10",
      "AMENDMENT OR DISSENT: Add the weekly check.",
      "ONE LINE FOR THE FOUNDER: Track the cost weekly.",
    ].join("\n");
    assert.deepEqual(seats.validateCard(completeVote, 3, ["A", "B"]), []);
    assert.match(seats.parseCard(completeVote.replace(/^VOTE:.*\n/m, ""), ["A", "B"]).vote, /^$/);
    assert.match(seats.validateCard(completeVote.replace(/^VOTE:.*\n/m, ""), 3, ["A", "B"]).join(" "), /vote/i);
    assert.match(seats.validateCard(completeVote.replace("A 7 · B 5", "A 17 · B 5"), 3, ["A", "B"]).join(" "), /A.*0.*10/i);
    assert.match(seats.validateCard(completeVote.replace("VOTE: Endorse with amendment", "VOTE: Endorse | Endorse with amendment | Dissent"), 3, ["A", "B"]).join(" "), /VOTE/i);
    assert.ok(seats.validateCard("", 1, ["A"]).length > 0, "an empty opening card must fail mandatory-field validation");
    const noVote = council.finalNumbers({
      rounds: [3],
      scores: { 3: { A: { score: 8, math: "8 / 1" } } },
      options: [{ id: "A" }],
      seats: ["bezos"],
      weights: { bezos: { weight: 1 } },
      cards: { 1: {}, 2: {}, 3: { bezos: { parsed: { optionScores: { A: 8 }, vote: "", finalScore: 8 } } } },
    });
    assert.deepEqual(noVote.votes, {}, "a missing vote must not become an endorsement");
  });
});
