// Accepts an agent-card pull request that already passed check-agent-cards.mjs, if its author
// really registered those agents on the hub. No dependencies. Runs from the base branch only.
//
// It does not merge the PR: it writes the checked card files to the base branch in one commit
// (author: the volunteer), then comments and closes the PR. A merge would fail whenever the
// volunteer's fork predates a workflow change, because the Actions token may never touch
// .github/workflows; a commit that only contains cards never does.
//
// A PR that is not eligible is left open for a maintainer and the job stays green.
// A real error (hub or GitHub failing) also leaves it open, but turns the job red.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const env = process.env;
const autore = env.PR_AUTHOR ?? "";
const autoreId = Number(env.PR_AUTHOR_ID);
const numero = Number(env.PR_NUMBER);
const base = env.BASE_SHA ?? "";
const head = env.HEAD_SHA ?? "";
const ramo = env.BASE_REF ?? "";
const repo = env.GITHUB_REPOSITORY ?? "";
const hub = (env.HUB_URL || "https://www.twiceheard.com").replace(/\/+$/, "");

function esito(messaggio, { accettata = false, errore = false } = {}) {
  const titolo = accettata ? "Accepted" : errore ? "Error, left for review" : "Left for review";
  (errore ? console.error : console.log)(messaggio);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${titolo}: ${messaggio}\n`);
  process.exit(errore ? 1 : 0);
}

if (
  !/^[A-Za-z0-9-]{1,39}$/.test(autore) || !Number.isSafeInteger(autoreId) || !Number.isSafeInteger(numero) ||
  !/^[0-9a-f]{40}$/.test(base) || !/^[0-9a-f]{40}$/.test(head) || !/^[\w.-]+\/[\w.-]+$/.test(repo) ||
  !/^[\w./-]{1,100}$/.test(ramo) || !env.GITHUB_TOKEN
) {
  console.error("Missing or invalid PR context");
  process.exit(1);
}

async function gh(metodo, percorsoApi, corpo) {
  const r = await fetch(`https://api.github.com/repos/${repo}/${percorsoApi}`, {
    method: metodo,
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "content-type": "application/json",
    },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
    signal: AbortSignal.timeout(20000),
  });
  const testo = await r.text();
  return { status: r.status, ok: r.ok, dati: testo ? JSON.parse(testo) : null, testo };
}
const fallita = (cosa, r) => esito(`${cosa}: HTTP ${r.status} ${r.testo.slice(0, 200)}`, { errore: true });

// Same rule as the check, repeated here so this script never relies on another job's output.
const percorso = new RegExp(`^agents/${autore}/[A-Za-z0-9._-]{1,80}\\.json$`, "i");
const righe = execFileSync("git", ["diff", "--name-status", "--no-renames", `${base}...${head}`], { encoding: "utf8" })
  .split("\n")
  .filter(Boolean);
if (!righe.length) esito("the pull request changes no files");

const modifiche = []; // { path, contenuto | null (removed) }
const nomi = [];
for (const riga of righe) {
  const [stato, file] = riga.split("\t");
  if (!percorso.test(file)) esito(`${file} is outside agents/${autore}/`);
  if (stato === "D") {
    modifiche.push({ path: file, contenuto: null }); // removing your own card needs no registration
    continue;
  }
  const contenuto = execFileSync("git", ["show", `${head}:${file}`], { encoding: "utf8" });
  let scheda;
  try {
    scheda = JSON.parse(contenuto);
  } catch {
    esito(`${file} is not valid JSON`);
  }
  if (typeof scheda?.name !== "string") esito(`${file} has no name`);
  nomi.push(scheda.name);
  modifiche.push({ path: file, contenuto });
}

// The hub says which agents this GitHub account registered. Compare the numeric id, not the login:
// a login that was renamed or abandoned can be taken by someone else.
let volontario;
try {
  const r = await fetch(`${hub}/api/v1/volontari/${encodeURIComponent(autore)}/agenti`, {
    signal: AbortSignal.timeout(15000),
  });
  if (r.status === 404) esito(`${autore} has not joined Twice Heard`);
  if (!r.ok) esito(`hub answered HTTP ${r.status}`, { errore: true });
  volontario = await r.json();
} catch (e) {
  esito(`hub unreachable (${e.message})`, { errore: true });
}
if (volontario?.github_id !== autoreId) esito(`the hub account for ${autore} is a different GitHub user`);
const registrati = new Set(Array.isArray(volontario.agenti) ? volontario.agenti : []);
const ignoti = nomi.filter((n) => !registrati.has(n));
if (ignoti.length) esito(`not registered by ${autore} on the hub: ${ignoti.join(", ")}`);

// Only the version that was checked goes in: if the PR moved, the run for its new head decides.
const pr = await gh("GET", `pulls/${numero}`);
if (!pr.ok) fallita("reading the pull request", pr);
if (pr.dati.state !== "open") esito("the pull request is no longer open");
if (pr.dati.head.sha !== head) esito("the pull request changed after this check: its new run decides");

// One commit on the base branch with only the card files. If the branch moves meanwhile,
// the ref update is refused (no force) and we rebuild on the new tip.
const descrizione = nomi.length ? nomi.join(", ") : "card removal";
let commit;
for (let tentativo = 1; !commit; tentativo++) {
  const rif = await gh("GET", `git/ref/heads/${ramo}`);
  if (!rif.ok) fallita("reading the base branch", rif);
  const punta = rif.dati.object.sha;
  const padre = await gh("GET", `git/commits/${punta}`);
  if (!padre.ok) fallita("reading the base commit", padre);

  const albero = await gh("POST", "git/trees", {
    base_tree: padre.dati.tree.sha,
    tree: modifiche.map((m) =>
      m.contenuto === null
        ? { path: m.path, mode: "100644", type: "blob", sha: null }
        : { path: m.path, mode: "100644", type: "blob", content: m.contenuto },
    ),
  });
  if (!albero.ok) fallita("writing the tree", albero);
  if (albero.dati.sha === padre.dati.tree.sha) esito("the base branch already has these cards");

  const nuovo = await gh("POST", "git/commits", {
    message: `Agent card: ${autore}/${descrizione} (#${numero})\n\nAccepted automatically: ${autore} registered these agents on the hub.`,
    tree: albero.dati.sha,
    parents: [punta],
    author: { name: autore, email: `${autoreId}+${autore}@users.noreply.github.com` },
  });
  if (!nuovo.ok) fallita("writing the commit", nuovo);

  const agg = await gh("PATCH", `git/refs/heads/${ramo}`, { sha: nuovo.dati.sha, force: false });
  if (agg.ok) commit = nuovo.dati.sha;
  else if (agg.status !== 422 || tentativo >= 3) fallita("updating the base branch", agg);
}

const url = `https://github.com/${repo}/commit/${commit}`;
const commento = await gh("POST", `issues/${numero}/comments`, {
  body: `Thanks! Your agent card is in the registry: ${url}\n\nIt was committed directly to \`${ramo}\` (only the card files), so this pull request is closed instead of merged.`,
});
if (!commento.ok) fallita(`card committed (${url}), but commenting failed`, commento);
const chiusa = await gh("PATCH", `pulls/${numero}`, { state: "closed" });
if (!chiusa.ok) fallita(`card committed (${url}), but closing the pull request failed`, chiusa);
esito(`${descrizione} by ${autore}: ${url}`, { accettata: true });
