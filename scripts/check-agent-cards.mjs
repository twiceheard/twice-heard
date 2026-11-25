// Validates a pull request to the base repository. No dependencies.
// Rules: a PR may only add or change JSON cards under agents/<pr-author>/, each matching agents/schema.json.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const autore = process.env.PR_AUTHOR ?? "";
const base = process.env.BASE_SHA ?? "";
const head = process.env.HEAD_SHA ?? "";
if (!/^[A-Za-z0-9-]{1,39}$/.test(autore) || !/^[0-9a-f]{40}$/.test(base) || !/^[0-9a-f]{40}$/.test(head)) {
  console.error("Missing or invalid PR context");
  process.exit(1);
}

const righe = execFileSync("git", ["diff", "--name-status", "--no-renames", `${base}...${head}`], { encoding: "utf8" })
  .split("\n")
  .filter(Boolean);

const schema = JSON.parse(readFileSync("agents/schema.json", "utf8"));
const percorso = new RegExp(`^agents/${autore}/[A-Za-z0-9._-]{1,80}\\.json$`, "i");
const errori = [];

for (const riga of righe) {
  const [stato, file] = riga.split("\t");
  if (!percorso.test(file)) {
    errori.push(`${file}: a pull request may only touch agents/${autore}/<agent-name>.json`);
    continue;
  }
  if (stato === "D") continue;
  let scheda;
  try {
    scheda = JSON.parse(execFileSync("git", ["show", `${head}:${file}`], { encoding: "utf8" }));
  } catch {
    errori.push(`${file}: not valid JSON`);
    continue;
  }
  errori.push(...valida(scheda, schema).map((e) => `${file}: ${e}`));
}

if (!righe.length) errori.push("The pull request changes no files");
if (errori.length) {
  console.error(errori.join("\n"));
  process.exit(1);
}
console.log(`OK: ${righe.length} card(s) by ${autore}`);

/** Minimal validator for the subset of JSON Schema used by agents/schema.json. */
function valida(v, s) {
  const out = [];
  if (typeof v !== "object" || v === null || Array.isArray(v)) return ["must be a JSON object"];
  for (const k of s.required ?? []) if (!(k in v)) out.push(`missing "${k}"`);
  for (const [k, val] of Object.entries(v)) {
    const p = s.properties?.[k];
    if (!p) {
      if (s.additionalProperties === false) out.push(`unexpected field "${k}"`);
      continue;
    }
    if (typeof val !== "string") {
      out.push(`"${k}" must be a string`);
      continue;
    }
    if (p.minLength !== undefined && val.length < p.minLength) out.push(`"${k}" is too short`);
    if (p.maxLength !== undefined && val.length > p.maxLength) out.push(`"${k}" is too long`);
    if (p.pattern && !new RegExp(p.pattern).test(val)) out.push(`"${k}" has an invalid format`);
  }
  return out;
}
