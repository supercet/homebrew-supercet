import { gitOperations } from "../utils/gitHelpers";
import type { Context } from "hono";

type CommitReqBody = {
  message: string;
};

export async function postCommit(c: Context) {
  try {
    const data: CommitReqBody = await c.req.json();

    if (data?.message?.length) {
      try {
        await gitOperations.commit(data.message);

        return c.json({}, 201);
      } catch (e) {
        console.error("failed git commit", e);
        return c.json({ error: "Failed to commit" }, 500);
      }
    } else {
      console.log("no commit message");
      return c.json({ error: "No commit message provided" }, 400);
    }
  } catch (e) {
    console.error(`commit error : ${e}`);
    return c.json({ error: "Failed to commit" }, 500);
  }
}
