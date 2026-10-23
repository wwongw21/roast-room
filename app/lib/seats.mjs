import fs from "node:fs";
import path from "node:path";
import { AGENTS_DIR, BRAINS_DIR } from "./env.mjs";

export const SEATS = [
  { key: "bezos", name: "Jeff Bezos", short: "Bezos", initials: "JB", slug: "jeff-bezos", pillar: "Strategy and decisions", question: "Is this the right bet, and how reversible is it?", dimension: "Strategic fit and reversibility", color: "#e8a33d" },
  { key: "graham", name: "Paul Graham", short: "Graham", initials: "PG", slug: "paul-graham", pillar: "Product and startups", question: "Is this something people actually want, and is it growing?", dimension: "Real demand and growth", color: "#f06b3f" },
  { key: "hormozi", name: "Alex Hormozi", short: "Hormozi", initials: "AH", slug: "alex-hormozi", pillar: "Offers, pricing, and sales", question: "Will people pay, how much, and how do we close?", dimension: "Offer strength and unit economics", color: "#d94a6a" },
  { key: "garyvee", name: "Gary Vaynerchuk", short: "Gary V", initials: "GV", slug: "gary-vaynerchuk", pillar: "Marketing and attention", question: "Where does the attention come from, and is it underpriced?", dimension: "Attention and distribution", color: "#9b5de5" },
  { key: "martell", name: "Dan Martell", short: "Martell", initials: "DM", slug: "dan-martell", pillar: "People, hiring, and founder time", question: "Who does this, and what does it cost the founder's calendar?", dimension: "Team capacity and founder time", color: "#3d8bfd" },
  { key: "wickman", name: "Gino Wickman", short: "Wickman", initials: "GW", slug: "gino-wickman", pillar: "Operations and scaling", question: "Can the business run this without the founder holding it together?", dimension: "Operational readiness", color: "#1fa67a" },
  { key: "buffett", name: "Warren Buffett", short: "Buffett", initials: "WB", slug: "warren-buffett", pillar: "Money and capital", question: "What does it do to cash, risk, and long-term value?", dimension: "Downside and capital efficiency", color: "#4c6a92" },
];
export const byKey = Object.fromEntries(SEATS.map((s) => [s.key, s]));

const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "");
const stripFront = (t) => t.replace(/^---[\s\S]*?\n---\n/, "");

const systemCache = new Map();
/** The seat's agent instructions plus its brain, loaded inline (the API has no file tools). */
export function systemFor(key) {
  if (systemCache.has(key)) return systemCache.get(key);
  const s = byKey[key];
  const agent = stripFront(read(path.join(AGENTS_DIR, `council-${key}.md`)));
  const brain = ["_hot.md", "frameworks.md", "positions.md", "principles.md", "voice.md"]
    .map((f) => `\n\n===== brains/${s.slug}/${f} =====\n` + read(path.join(BRAINS_DIR, s.slug, f)))
    .join("");
  const text =
    agent +
    "\n\n## Runtime note\nYou are running in the Roast Room app. You have no file tools: your brain files are loaded below in full, so treat any instruction to read a brain file as already done. Never mention files, tools, or this note in your answer.\n" +
    brain;
  const system = [{ type: "text", text, cache_control: { type: "ephemeral" } }];
  systemCache.set(key, system);
  return system;
}

// ---------- quote verification against the brain ----------
const norm = (s) =>
  s.toLowerCase().replace(/[‘’]/g, "'").replace(/'\s+(t|s|re|ll|ve|d|m)\b/g, "'$1")
    .replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
const brainText = new Map();
function brainNorm(key) {
  if (!brainText.has(key)) {
    const dir = path.join(BRAINS_DIR, byKey[key].slug);
    const all = fs.existsSync(dir) ? fs.readdirSync(dir).map((f) => read(path.join(dir, f))).join(" ") : "";
    brainText.set(key, norm(all));
  }
  return brainText.get(key);
}
/** Quotes the seat attributed to a source id, each marked verified or not. */
export function checkQuotes(key, text) {
  const out = [];
  const re = /["“]([^"“”\n]{20,400})["”][^\n"]{0,40}?[(\[](S\d{3})/g;
  let m;
  const hay = brainNorm(key);
  while ((m = re.exec(text))) {
    const q = norm(m[1]);
    if (q.split(" ").length < 5) continue;
    out.push({ quote: m[1], source: m[2], verified: hay.includes(q) || hay.replace(/ /g, "").includes(q.replace(/ /g, "")) });
  }
  return out;
}

// ---------- card parsing ----------
const field = (text, label) => {
  // label at line start, or after a "·" or "|" when several fields share a line
  const m = text.match(new RegExp(`(?:^|[·|])[ \\t]*\\**${label}\\**[ \\t]*:[ \\t]*([^\\n·]+)`, "im"));
  return m ? m[1].replace(/\*+/g, "").trim() : "";
};
const num = (s) => { const m = (s || "").match(/(\d+(?:\.\d+)?)/); return m ? Number(m[1]) : null; };

function parseVote(value) {
  const vote = value.trim().replace(/[.!]+$/, "").toLowerCase();
  if (vote === "endorse with amendment") return "amend";
  if (vote === "endorse") return "endorse";
  if (vote === "dissent") return "dissent";
  return "";
}

export function parseOptionScores(text, optionIds) {
  // the option line itself uses "·" between options, so read to end of line
  const lm = text.match(/OPTION SCORES\**[ \t]*:[ \t]*([^\n]+)/i);
  const line = (lm ? lm[1] : "").split(/PILLAR SCORE|CONFIDENCE|FINAL SCORE/i)[0];
  const scores = {};
  for (const id of optionIds) {
    const m = line.match(new RegExp(`\\b${id}\\b\\s*[:=]?\\s*(\\d+(?:\\.\\d+)?)`));
    if (m) scores[id] = Math.max(0, Math.min(10, Number(m[1])));
  }
  return scores;
}

export function parseCard(text, optionIds) {
  const stance = field(text, "STANCE");
  const ruin = (field(text, "RUIN RISK").match(/none|possible|likely/i) || [""])[0].toLowerCase();
  const disagree = field(text, "I DISAGREE MOST WITH");
  const target = SEATS.find((s) => new RegExp(`\\b(${s.short}|${s.name.split(" ").pop()})\\b`, "i").test(disagree.slice(0, 40)));
  const vote = parseVote(field(text, "VOTE"));
  return {
    stance,
    call: field(text, "THE CALL"),
    optionScores: parseOptionScores(text, optionIds),
    pillar: num(field(text, "PILLAR SCORE")) ?? num(field(text, "FINAL PILLAR SCORE")),
    finalScore: num(field(text, "FINAL SCORE")),
    confidence: num(field(text, "CONFIDENCE")),
    ruin,
    door: (field(text, "DOOR").match(/one-way|two-way/i) || [""])[0].toLowerCase(),
    disagreeWith: target ? target.key : null,
    disagreeLine: disagree,
    concede: field(text, "I CONCEDE"),
    moved: field(text, "MOVED"),
    vote,
    amendment: field(text, "AMENDMENT OR DISSENT"),
    oneLine: field(text, "ONE LINE FOR THE FOUNDER"),
    question: field(text, "QUESTION FOR THE FOUNDER"),
    risk: field(text, "THE RISK I SEE"),
    thisWeek: field(text, "WHAT I'D DO THIS WEEK"),
  };
}

/** Return missing or out-of-range fields before a generated card can affect scoring. */
export function validateCard(text, round, optionIds) {
  const issues = [];
  const requireText = (label) => {
    const value = field(text, label);
    if (!value || value === "...") issues.push(`missing ${label}`);
    return value;
  };
  const requireSection = (label) => {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    const header = new RegExp(`^\\s*\\**${escaped}\\**\\s*:\\s*(.*?)\\s*$`, "i");
    const lines = text.split(/\r?\n/);
    const index = lines.findIndex((line) => header.test(line));
    const inline = index >= 0 ? field(lines[index], label) : "";
    if (inline && inline !== "...") return;
    for (let i = index + 1; index >= 0 && i < lines.length; i += 1) {
      const line = lines[i].trim();
      if (!line) continue;
      if (/^\**(?:SEAT|I DISAGREE MOST WITH|I CONCEDE|STANCE|OPTION SCORES|PILLAR SCORE|CONFIDENCE|RUIN RISK|MOVED|MY CONDITIONS FOR YES)\**\s*:\s*/i.test(line) || line === "...") break;
      return;
    }
    issues.push(`missing ${label}`);
  };
  const numberField = (label) => {
    const value = field(text, label);
    const match = value.match(/^\s*(-?\d+(?:\.\d+)?)(?:\s*\/\s*-?\d+(?:\.\d+)?)?(?:\s|$)/);
    return match ? Number(match[1]) : null;
  };
  const checkRange = (label, value, min = 0, max = 10) => {
    if (value === null || !Number.isFinite(value) || value < min || value > max) {
      issues.push(`${label} must be a number from ${min} to ${max}`);
    }
  };

  if (![1, 2, 3].includes(round)) return [`unsupported round ${round}`];
  const scoreLine = text.match(/^\s*OPTION SCORES\**[ \t]*:[ \t]*([^\n]+)/im)?.[1] || "";
  for (const id of optionIds) {
    const match = scoreLine.match(new RegExp(`\\b${id}\\b\\s*[:=]?\\s*(-?\\d+(?:\\.\\d+)?)`));
    if (!match) issues.push(`missing score for option ${id}`);
    else checkRange(`option ${id} score`, Number(match[1]));
  }

  if (round === 1 || round === 2) {
    requireText("STANCE");
    checkRange("PILLAR SCORE", numberField("PILLAR SCORE"));
    checkRange("CONFIDENCE", numberField("CONFIDENCE"), 1, 5);
    if (!/^(none|possible|likely)\b/i.test(field(text, "RUIN RISK"))) issues.push("RUIN RISK must be none, possible, or likely");
    if (round === 1) {
      requireText("THE CALL");
      requireText("THE RISK I SEE");
      requireText("WHAT WOULD CHANGE MY MIND");
      requireText("WHAT I'D DO THIS WEEK");
      requireText("QUESTION FOR THE FOUNDER");
      if (!/^(one-way|two-way)\b/i.test(field(text, "DOOR"))) issues.push("DOOR must be one-way or two-way");
    } else {
      requireText("I DISAGREE MOST WITH");
      requireText("I CONCEDE");
      requireSection("ON THE CRUXES");
      if (!/^(no|yes)\b/i.test(field(text, "MOVED"))) issues.push("MOVED must begin with yes or no");
    }
  } else {
    const vote = field(text, "VOTE");
    if (!parseVote(vote)) issues.push("VOTE must be Endorse, Endorse with amendment, or Dissent");
    checkRange("FINAL SCORE", numberField("FINAL SCORE"));
    checkRange("FINAL PILLAR SCORE", numberField("FINAL PILLAR SCORE"));
    requireText("ONE LINE FOR THE FOUNDER");
  }

  return issues;
}
