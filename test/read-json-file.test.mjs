import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readJsonFile } from "../scripts/lib/read-json-file.mjs";

describe("readJsonFile", () => {
  let dir;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "read-json-file-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("parses a valid JSON file", async () => {
    const file = join(dir, "valid.json");
    await writeFile(file, JSON.stringify({ ok: true }), "utf8");
    await expect(readJsonFile(file)).resolves.toEqual({ ok: true });
  });

  it("reports a missing file as unreadable, not as invalid JSON", async () => {
    const file = join(dir, "does-not-exist.json");
    await expect(readJsonFile(file)).rejects.toThrow(/could not be read/);
    await expect(readJsonFile(file)).rejects.not.toThrow(/is not valid JSON/);
  });

  it("reports malformed content as invalid JSON, not as unreadable", async () => {
    const file = join(dir, "malformed.json");
    await writeFile(file, "{ not: valid json", "utf8");
    await expect(readJsonFile(file)).rejects.toThrow(/is not valid JSON/);
    await expect(readJsonFile(file)).rejects.not.toThrow(/could not be read/);
  });
});
