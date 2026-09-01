import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readJsonFile } from "../scripts/lib/read-json-file.mjs";

describe("readJsonFile", () => {
  let dir;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "read-json-file-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("parses a valid JSON fixture", async () => {
    await expect(readJsonFile("test/fixtures/valid.json")).resolves.toEqual({ ok: true });
  });

  it("reports a distinct error for a missing file", async () => {
    const missingPath = join(dir, "does-not-exist.json");
    await expect(readJsonFile(missingPath)).rejects.toThrow(/could not be read/);
  });

  it("reports a distinct error for invalid JSON syntax", async () => {
    const invalidPath = join(dir, "invalid-syntax.json");
    await writeFile(invalidPath, '{ "ok": true,, }', "utf8");
    await expect(readJsonFile(invalidPath)).rejects.toThrow(/is not valid JSON/);
  });

  it("does not describe a missing file as invalid JSON", async () => {
    const missingPath = join(dir, "does-not-exist.json");
    await expect(readJsonFile(missingPath)).rejects.not.toThrow(/is not valid JSON/);
  });
});
