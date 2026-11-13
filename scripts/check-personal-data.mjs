#!/usr/bin/env node
/**
 * Personal-data check for a public repository.
 *
 * Fails when a tracked file (or, with --history, a commit message or a
 * commit's author and committer name and email) contains
 *  - an email address outside the documentation domains (example.com,
 *    example.org, example.net) and GitHub noreply addresses, or
 *  - something that looks like a real Vercel token (`vcp_…`) or team id
 *    (`team_` + 20 or more characters) and is not a placeholder (one that
 *    contains "test", "example", "demo" or "fake"), or
 *  - a term from PRIVACY_DENYLIST (newline- or comma-separated, kept in a CI
 *    secret so the list itself is not published). Matching is
 *    case-insensitive.
 *
 * Usage: node scripts/check-personal-data.mjs [--history]
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const ALLOWED_EMAIL_DOMAINS = [
  /(^|\.)example\.(com|org|net)$/i,
  /^users\.noreply\.github\.com$/i,
  /^noreply\.github\.com$/i,
  /^noreply\./i,
];
// GitHub commits merges and squashes as `GitHub <noreply@github.com>`;
// Dependabot signs off its commits with `dependabot[bot] <support@github.com>`.
const ALLOWED_ADDRESSES = new Set(["noreply@github.com", "support@github.com"]);
// Email addresses are found without a regex: a nested group like (?:[a-z0-9-]+\.)+
// backtracks super-linearly. Every "@" with a local part before it is a candidate.
const LOCAL_CHAR = /[A-Za-z0-9._%+-]/;
const DOMAIN_CHAR = /[A-Za-z0-9.-]/;

/**
 * Addresses in a line as { address, domain }.
 * @param {string} line
 */
function emails(line) {
  /** @type {{ address: string, domain: string }[]} */
  const found = [];
  for (let at = line.indexOf("@"); at !== -1; at = line.indexOf("@", at + 1)) {
    let start = at;
    while (start > 0 && LOCAL_CHAR.test(line.charAt(start - 1))) start--;
    if (start === at) continue;
    let end = at + 1;
    while (end < line.length && DOMAIN_CHAR.test(line.charAt(end))) end++;
    const domain = emailDomain(line.slice(at + 1, end));
    if (domain)
      found.push({ address: `${line.slice(start, at)}@${domain}`, domain });
  }
  return found;
}

/**
 * The domain of an email candidate, or null when it is not a domain with a TLD.
 * @param {string} raw
 */
function emailDomain(raw) {
  // Labels up to the first empty one ("a..b", a leading or trailing dot)
  /** @type {string[]} */
  const labels = [];
  for (const label of raw.split(".")) {
    if (label === "") break;
    labels.push(label);
  }
  // The longest "label.label....tld" prefix whose last part starts with 2+ letters
  for (let k = labels.length - 1; k >= 1; k--) {
    const tld = /^[A-Za-z]*/.exec(labels[k] ?? "")?.[0] ?? "";
    if (tld.length >= 2) return [...labels.slice(0, k), tld].join(".");
  }
  return null;
}
const VERCEL_IDS = /\b(vc[a-z]_[A-Za-z0-9_]{16,}|team_[A-Za-z0-9]{20,})\b/g;
const PLACEHOLDER = /test|example|demo|fake/i;
const SKIP_FILES = [/^pnpm-lock\.yaml$/, /\.(png|jpe?g|gif|ico|webp|woff2?)$/i];

const denylist = (process.env.PRIVACY_DENYLIST ?? "")
  .split(/[\n,]/)
  .map((t) => t.trim().toLowerCase())
  .filter((t) => t.length >= 3);

/** @param {string[]} args */
const git = (...args) =>
  // A local and CI developer tool: it runs the git on PATH, like any git hook.
  execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }); // NOSONAR(javascript:S4036)

/** @type {string[]} */
const findings = [];

/**
 * @param {string} label
 * @param {string} text
 */
function scan(label, text) {
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const { address, domain } of emails(line)) {
      if (
        !ALLOWED_ADDRESSES.has(address.toLowerCase()) &&
        !ALLOWED_EMAIL_DOMAINS.some((re) => re.test(domain))
      ) {
        findings.push(
          `${label}:${i + 1}: email address outside example domains`,
        );
      }
    }
    for (const match of line.matchAll(VERCEL_IDS)) {
      if (!PLACEHOLDER.test(match[0]))
        findings.push(`${label}:${i + 1}: Vercel token or team id`);
    }
    const lower = line.toLowerCase();
    for (const term of denylist) {
      if (lower.includes(term))
        findings.push(`${label}:${i + 1}: denylisted term`);
    }
  });
}

for (const file of git("ls-files", "-z").split("\0").filter(Boolean)) {
  if (SKIP_FILES.some((re) => re.test(file))) continue;
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  if (text.includes("\0")) continue; // binary
  scan(file, text);
}

if (process.argv.includes("--history")) {
  const log = git("log", "--format=%H%n%B%n--END--");
  for (const entry of log.split("--END--")) {
    const [sha, ...body] = entry.trim().split("\n");
    if (sha) scan(`commit ${sha.slice(0, 12)}`, body.join("\n"));
  }
  // Identities: a real name in the author or committer field is published
  // with the history just like one in the message.
  const people = git("log", "--format=%H%x00%an <%ae>%x00%cn <%ce>");
  for (const line of people.split("\n").filter(Boolean)) {
    const [sha = "", author = "", committer = ""] = line.split("\0");
    scan(`commit ${sha.slice(0, 12)} author`, author);
    scan(`commit ${sha.slice(0, 12)} committer`, committer);
  }
}

if (findings.length > 0) {
  console.error(`Personal-data check failed (${findings.length}):`);
  for (const f of findings) console.error(`  ${f}`);
  process.exit(1);
}
console.log(
  `Personal-data check passed${denylist.length ? ` (${denylist.length} denylisted terms)` : ""}.`,
);
