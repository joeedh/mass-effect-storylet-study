import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadContent } from "../src/storylet/loader.ts";
import type { Content } from "../src/storylet/model.ts";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Strip the common leading indentation, so YAML can be indented with the test code. */
export function dedent(text: string): string {
  const lines = text.split("\n");
  const indents = lines.filter((l) => l.trim()).map((l) => /^ */.exec(l)![0].length);
  const n = Math.min(...indents);
  return lines.map((l) => l.slice(n)).join("\n");
}

/** Load content from one YAML file in a fresh temporary directory. */
export function contentFrom(yaml: string): Content {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "storylet-test-"));
  fs.writeFileSync(path.join(dir, "c.yaml"), dedent(yaml), "utf8");
  return loadContent(dir);
}
