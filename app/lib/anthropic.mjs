import { env } from "./env.mjs";

const URL = "https://api.anthropic.com/v1/messages";
const RETRY = new Set([429, 500, 502, 503, 529]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function headers() {
  return {
    "x-api-key": env("ANTHROPIC_API_KEY"),
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  };
}

// Running token tally for the whole app, shown in the UI.
export const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 };
function addUsage(u = {}) {
  usage.input += u.input_tokens || 0;
  usage.output += u.output_tokens || 0;
  usage.cacheRead += u.cache_read_input_tokens || 0;
  usage.cacheWrite += u.cache_creation_input_tokens || 0;
  usage.calls += 1;
}

/** Stream a message; calls onText(delta) as text arrives. Returns only complete text responses. */
export async function stream({ model, system, messages, maxTokens = 2000, onText = () => {} }) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(URL, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ model, system, messages, max_tokens: maxTokens, stream: true }),
    });
    if (RETRY.has(res.status)) { await sleep(Math.min(30000, 2000 * 2 ** attempt)); continue; }
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
    let text = "";
    let buf = "";
    const dec = new TextDecoder();
    const finalUsage = {};
    let sawMessageStart = false;
    let sawMessageStop = false;
    let refusalBlock = false;
    let stopReason = null;
    const consumeLine = (rawLine) => {
      const line = rawLine.replace(/\r$/, "").trim();
      if (!line.startsWith("data:")) return;
      let ev;
      try { ev = JSON.parse(line.slice(5).trimStart()); } catch { return; }
      if (ev.type === "message_start") {
        sawMessageStart = true;
        Object.assign(finalUsage, ev.message?.usage || {});
      } else if (ev.type === "message_delta") {
        Object.assign(finalUsage, ev.usage || {});
        if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
      } else if (ev.type === "content_block_start" && ev.content_block?.type === "refusal") {
        refusalBlock = true;
      } else if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
        text += ev.delta.text;
        onText(ev.delta.text);
      } else if (ev.type === "message_stop") {
        sawMessageStop = true;
      } else if (ev.type === "error") {
        throw new Error(`Anthropic stream error: ${JSON.stringify(ev.error).slice(0, 300)}`);
      }
    };

    try {
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          consumeLine(buf.slice(0, i));
          buf = buf.slice(i + 1);
        }
      }
      buf += dec.decode();
      if (buf) for (const line of buf.split("\n")) consumeLine(line);
    } finally {
      // A clean refusal or truncated stream still consumed this request's reported tokens.
      if (sawMessageStart) addUsage(finalUsage);
    }

    if (!sawMessageStart) throw new Error("Anthropic stream ended without message_start");
    if (!sawMessageStop) throw new Error("Anthropic stream ended before message_stop");
    if (refusalBlock || stopReason === "refusal") throw new Error("Anthropic refusal: the requested response was not completed");
    if (!stopReason) throw new Error("Anthropic stream ended without a stop reason");
    if (stopReason !== "end_turn") {
      throw new Error(`Anthropic stream ended with unsupported stop reason: ${stopReason}`);
    }
    return text;
  }
  throw new Error("Anthropic API kept refusing after retries");
}

/** One call with structured JSON output matching `schema`. */
export async function json({ model, system, prompt, schema, maxTokens = 4000 }) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(URL, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model, system, max_tokens: maxTokens,
        output_config: { format: { type: "json_schema", schema } },
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (RETRY.has(res.status)) { await sleep(Math.min(30000, 2000 * 2 ** attempt)); continue; }
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const j = await res.json();
    addUsage(j.usage);
    if (j.stop_reason === "max_tokens") throw new Error("Chair output hit max_tokens");
    if (j.stop_reason === "refusal") throw new Error("Chair refusal: the requested response was not completed");
    if (j.stop_reason !== "end_turn") {
      throw new Error(`Chair output ended with unsupported stop reason: ${j.stop_reason || "missing"}`);
    }
    return JSON.parse(j.content.map((b) => b.text || "").join(""));
  }
  throw new Error("Anthropic API kept refusing after retries");
}

// JSON schema helpers
export const S = {
  str: { type: "string" },
  num: { type: "number" },
  int: { type: "integer" },
  bool: { type: "boolean" },
  arr: (items) => ({ type: "array", items }),
  obj: (props) => ({ type: "object", properties: props, required: Object.keys(props), additionalProperties: false }),
  enum: (...v) => ({ type: "string", enum: v }),
};
