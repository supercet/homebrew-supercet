import { git } from "../utils/gitWrapper";
import type { Context } from "hono";

export async function getStatus(c: Context) {
  try {
    const status = await git.status();

    return c.json(status);
  } catch (e) {
    console.error(`exec error : ${e}`);
    return c.json({ error: "Failed to get status" }, 500);
  }
}
