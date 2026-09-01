import { readFile } from "node:fs/promises";

/**
 * Reads and parses a JSON file, keeping file-read failures (missing file,
 * permission denied, ...) distinguishable from JSON-syntax failures so
 * callers and their evidence trails do not conflate the two.
 */
export async function readJsonFile(path) {
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`${path} could not be read: ${error.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${error.message}`);
  }
}
