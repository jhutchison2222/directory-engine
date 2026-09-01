import { readFile } from "node:fs/promises";

// Keeps "file could not be read" and "file is not valid JSON" distinguishable,
// so a missing or unreadable fixture is never mislabeled as invalid JSON.
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
