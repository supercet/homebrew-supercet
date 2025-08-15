import { gitOperations } from "../utils/gitHelpers";
import type { Context } from "hono";

export async function getRevParse(c: Context) {
  try {
    const { ref, remote } = c.req.query();
    const hash = await gitOperations.revParse(ref, remote);

    return c.json(hash);
  } catch (e) {
    console.error(`failed to get rev parse : ${e}`);
    return c.json({ error: "Failed to get rev parse" }, 500);
  }
}
