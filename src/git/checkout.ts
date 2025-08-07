import { gitOperations } from "../utils/gitHelpers";
import type { Context } from "hono";

type CheckoutReqBody = {
  branch: string;
  isNew: boolean;
};

export async function postCheckout(c: Context) {
  try {
    const data: CheckoutReqBody = await c.req.json();

    if (data?.branch?.length) {
      try {
        await gitOperations.checkout(data.branch, data.isNew);

        if (data.isNew) {
          return c.json({}, 201);
        } else {
          return c.json({}, 200);
        }
      } catch (e) {
        if (e instanceof Error) {
          // Branch not found
          if (e.message.includes("not match any file")) {
            return c.json({ error: "Branch not found" }, 404);
            // Uncommitted files found
          } else if (e.message.includes("Please commit your changes")) {
            return c.json({ error: "Please commit your changes" }, 422);
          }
        } else {
          console.error("failed git checkout", e);
          return c.json({ error: "Failed to checkout branch" }, 500);
        }
      }
    } else {
      console.log("no checkout branch");
      return c.json({ error: "No branch provided" }, 400);
    }
  } catch (e) {
    console.error(`checkout error : ${e}`);
    return c.json({ error: "Failed to checkout branch" }, 500);
  }
}
