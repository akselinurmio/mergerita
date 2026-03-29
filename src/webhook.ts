import type { Context } from "hono";
import { verify } from "@octokit/webhooks-methods";
import { handlePullRequest } from "./handler";

export async function handleWebhook(c: Context<{ Bindings: Env }>) {
  const deliveryId = c.req.header("x-github-delivery");
  const event = c.req.header("x-github-event");
  const signature = c.req.header("x-hub-signature-256");

  console.log(`Webhook received: event=${event} delivery=${deliveryId}`);

  if (!signature) {
    console.log("Rejected: missing signature");
    return c.text("Missing signature", 400);
  }

  const body = await c.req.text();
  const isValid = await verify(c.env.WEBHOOK_SECRET, body, signature);
  if (!isValid) {
    console.log("Rejected: invalid signature");
    return c.text("Invalid signature", 401);
  }

  const payload = JSON.parse(body);

  if (event === "pull_request") {
    const { action, pull_request, repository } = payload;
    console.log(`pull_request.${action} PR #${pull_request?.number} in ${repository?.full_name} by ${pull_request?.user?.login}`);

    c.executionCtx.waitUntil(handlePullRequest(payload, c.env));
  } else {
    console.log(`Ignored event: ${event}`);
  }

  return c.text("OK");
}
