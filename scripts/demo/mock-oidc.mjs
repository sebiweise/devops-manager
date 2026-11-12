#!/usr/bin/env node
// A local OIDC issuer for the demo setup (never production).
//
//   node scripts/demo/mock-oidc.mjs [--port 3998] [--email admin@example.com]
//
// Starts the same mock issuer the integration tests use (oauth2-mock-server,
// a dev dependency) on 127.0.0.1 and signs every user in as the given
// example address, verified and in the "devops-users" group. Point the app
// at it with OIDC_ISSUER=http://127.0.0.1:<port>. It refuses to start with
// NODE_ENV=production, binds to the loopback interface only, and is not part
// of the production build or image, so it cannot be enabled there.

import { OAuth2Server } from "oauth2-mock-server";

if (process.env.NODE_ENV === "production") {
  console.error(
    "refusing to start the mock OIDC issuer with NODE_ENV=production",
  );
  process.exit(1);
}

/** @param {string} name @param {string} fallback @returns {string} */
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return (i > 0 ? process.argv[i + 1] : undefined) ?? fallback;
};
const port = Number(arg("--port", "3998"));
const email = arg("--email", "admin@example.com");
if (!/@example\.(com|org)$/.test(email)) {
  console.error("use an example.com or example.org address");
  process.exit(1);
}

const server = new OAuth2Server();
await server.issuer.keys.generate("RS256");
await server.start(port, "127.0.0.1");
const claims = {
  sub: `demo-${email}`,
  email,
  email_verified: true,
  name: "Example Admin",
  groups: ["devops-users"],
};
server.service.on("beforeTokenSigning", (token) => {
  Object.assign(token.payload, {
    aud: process.env.OIDC_CLIENT_ID ?? "devops-manager",
    ...claims,
  });
});
server.service.on("beforeUserinfo", (res) => {
  res.body = { ...claims };
});
console.log(`mock OIDC issuer on ${server.issuer.url} (signs in ${email})`);
