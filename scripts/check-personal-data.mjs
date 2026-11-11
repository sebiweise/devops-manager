#!/usr/bin/env node
/**
 * Personal-data check for a public repository.
 *
 * Fails when a tracked file (or, with --history, a commit message or a
 * commit's author and committer name and email) contains
 *  - an email address outside the documentation domains (example.com,
 *    example.org, example.net) and GitHub noreply addresses, or
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
const EMAIL =
  /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g;
const SKIP_FILES = [/^pnpm-lock\.yaml$/, /\.(png|jpe?g|gif|ico|webp|woff2?)$/i];

const denylist = (process.env.PRIVACY_DENYLIST ?? "")
  .split(/[\n,]/)
  .map((t) => t.trim().toLowerCase())
  .filter((t) => t.length >= 3);

/** @param {string[]} args */
const git = (...args) =>
  execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

/** @type {string[]} */
const findings = [];

/**
 * @param {string} label
 * @param {string} text
 */
function scan(label, text) {
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const match of line.matchAll(EMAIL)) {
      const domain = match[1] ?? "";
      if (!ALLOWED_EMAIL_DOMAINS.some((re) => re.test(domain))) {
        findings.push(
          `${label}:${i + 1}: email address outside example domains`,
        );
      }
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
