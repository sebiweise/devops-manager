import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Foreign or unknown ids answer HTTP 404 (design §9): the account layout and
 * the pages call notFound() before anything is streamed. A `loading.tsx`
 * puts a Suspense boundary above them; its fallback starts the stream with
 * status 200, and notFound() then only renders the 404 UI. Pages that need a
 * placeholder wrap their slow part in <Suspense> below the checks instead
 * (the run page's steps).
 */

const appDir = fileURLToPath(new URL("./", import.meta.url));

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)],
  );
}

describe("route-level loading boundaries", () => {
  it("there is no loading file above a page that answers 404", () => {
    const loading = files(appDir)
      .filter((f) => /[\\/]loading\.(tsx|ts|jsx|js)$/.test(f))
      .map((f) => relative(appDir, f));
    expect(loading).toEqual([]);
  });
});
