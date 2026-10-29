import { readFileSync } from "node:fs";

/** Read from package.json (one level above both src/ and dist/). */
export const VERSION: string = (
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version;
