import type { Context } from "hono";
import { verify } from "@octokit/webhooks-methods";
import type { Env } from "./types";
import { handlePullRequest } from "./handler";

export async function handleWebhook(c: Context<{ Bindings: Env }>) {
  const signature = c.req.header("x-hub-signature-256");
  if (!signature) {
    return c.text("Missing signature", 400);
  }

  const body = await c.req.text();
  const isValid = await verify(c.env.WEBHOOK_SECRET, body, signature);
  if (!isValid) {
    return c.text("Invalid signature", 401);
  }

  const event = c.req.header("x-github-event");
  const payload = JSON.parse(body);

  if (event === "pull_request") {
    try {
      await handlePullRequest(payload, c.env);
      return c.json({ ok: true });
    } catch (error) {
      console.error("Error handling pull_request event:", error);
      return c.json({ error: String(error) }, 500);
    }
  }

  return c.json({ ignored: true, event });
}
