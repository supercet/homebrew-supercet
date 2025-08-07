import { gitOperations } from "../utils/gitHelpers";
import type { Context } from "hono";

export async function getDiff(c: Context) {
  try {
    const from = c.req.query("from") || "";
    const to = c.req.query("to") || "";

    const diff = await gitOperations.diff(from, to);

    return c.json(diff);
  } catch (e) {
    console.error(`exec error : ${e}`);
    return c.json({ error: "Failed to get diff" }, 500);
  }
}
