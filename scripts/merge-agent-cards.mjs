// Merges an agent-card pull request that already passed check-agent-cards.mjs, if its author
// really registered those agents on the hub. No dependencies. Runs from the base branch only.
// Anything not eligible is left open for a maintainer: this script never fails a PR.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const env = process.env;
const autore = env.PR_AUTHOR ?? "";
const autoreId = Number(env.PR_AUTHOR_ID);
const numero = Number(env.PR_NUMBER);
const base = env.BASE_SHA ?? "";
const head = env.HEAD_SHA ?? "";
const repo = env.GITHUB_REPOSITORY ?? "";
const hub = (env.HUB_URL || "https://www.twiceheard.com").replace(/\/+$/, "");

function esito(messaggio, merged = false) {
  console.log(messaggio);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${merged ? "Merged" : "Left for review"}: ${messaggio}\n`);
  process.exit(0);
}

if (
  !/^[A-Za-z0-9-]{1,39}$/.test(autore) || !Number.isSafeInteger(autoreId) || !Number.isSafeInteger(numero) ||
  !/^[0-9a-f]{40}$/.test(base) || !/^[0-9a-f]{40}$/.test(head) || !/^[\w.-]+\/[\w.-]+$/.test(repo) || !env.GITHUB_TOKEN
) {
  console.error("Missing or invalid PR context");
  process.exit(1);
}

// Same rule as the check, repeated here so this script never relies on another job's output.
const percorso = new RegExp(`^agents/${autore}/[A-Za-z0-9._-]{1,80}\\.json$`, "i");
const righe = execFileSync("git", ["diff", "--name-status", "--no-renames", `${base}...${head}`], { encoding: "utf8" })
  .split("\n")
  .filter(Boolean);
if (!righe.length) esito("the pull request changes no files");

const nomi = [];
for (const riga of righe) {
  const [stato, file] = riga.split("\t");
  if (!percorso.test(file)) esito(`${file} is outside agents/${autore}/`);
  if (stato === "D") continue; // removing your own card needs no registration
  let scheda;
  try {
    scheda = JSON.parse(execFileSync("git", ["show", `${head}:${file}`], { encoding: "utf8" }));
  } catch {
    esito(`${file} is not valid JSON`);
  }
  if (typeof scheda?.name !== "string") esito(`${file} has no name`);
  nomi.push(scheda.name);
}

// The hub says which agents this GitHub account registered. Compare the numeric id, not the login:
// a login that was renamed or abandoned can be taken by someone else.
let volontario;
try {
  const r = await fetch(`${hub}/api/v1/volontari/${encodeURIComponent(autore)}/agenti`, {
    signal: AbortSignal.timeout(15000),
  });
  if (r.status === 404) esito(`${autore} has not joined Twice Heard`);
  if (!r.ok) esito(`hub answered HTTP ${r.status}`);
  volontario = await r.json();
} catch (e) {
  esito(`hub unreachable (${e.message})`);
}
if (volontario?.github_id !== autoreId) esito(`the hub account for ${autore} is a different GitHub user`);
const registrati = new Set(Array.isArray(volontario.agenti) ? volontario.agenti : []);
const ignoti = nomi.filter((n) => !registrati.has(n));
if (ignoti.length) esito(`not registered by ${autore} on the hub: ${ignoti.join(", ")}`);

// sha: GitHub refuses the merge if the PR moved after it was checked.
const r = await fetch(`https://api.github.com/repos/${repo}/pulls/${numero}/merge`, {
  method: "PUT",
  headers: {
    authorization: `Bearer ${env.GITHUB_TOKEN}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "content-type": "application/json",
  },
  body: JSON.stringify({ sha: head, merge_method: "squash" }),
});
if (!r.ok) esito(`GitHub refused the merge: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
esito(`${nomi.length ? nomi.join(", ") : "card removal"} by ${autore}`, true);
