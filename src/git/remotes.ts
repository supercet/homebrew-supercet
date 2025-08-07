import { gitOperations } from "../utils/gitHelpers";
import type { Context } from "hono";

export async function getRemotes(c: Context) {
  try {
    const remotes = await gitOperations.remotes();

    if (!remotes) {
      return c.json(null, 404);
    }

    const remotesArray = remotes.split("\n").filter((remote) => remote);

    return c.json(remotesArray);
  } catch (e) {
    console.error(`failed to get remotes list : ${e}`);
    return c.json(null, 500);
  }
}
