import { git } from "../utils/gitWrapper";
import type { Context } from "hono";

export async function getDiff(c: Context) {
  try {
    const from = c.req.query("from") || "";
    const to = c.req.query("to") || "";
    // '-w', '--ignore-space-at-eol' ignores whitespace but still renders the no newline at end of file marker
    const args = [from, to, "-w", "--ignore-space-at-eol", "-U5"].filter(
      (val) => val
    );
    let diff;
    if (args && args.length) {
      diff = await git.diff(args);
    }

    return c.json(diff);
  } catch (e) {
    console.error(`exec error : ${e}`);
    return c.json({ error: "Failed to get diff" }, 500);
  }
}
