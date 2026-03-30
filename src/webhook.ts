import type { Context } from "hono";
import type {
  EmitterWebhookEvent,
  EmitterWebhookEventName,
} from "@octokit/webhooks";
import { App } from "octokit";
import { enableAutoMerge } from "./github";

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

  const app = new App({
    appId: c.env.APP_ID,
    privateKey: c.env.PRIVATE_KEY,
    webhooks: { secret: c.env.WEBHOOK_SECRET },
  });

  const isValid = await app.webhooks.verify(body, signature);
  if (!isValid) {
    console.log("Rejected: invalid signature");
    return c.text("Invalid signature", 401);
  }

  app.webhooks.on(
    [
      "pull_request.opened",
      "pull_request.reopened",
      "pull_request.synchronize",
    ],
    async ({ octokit, payload }) => {
      if (payload.pull_request.user?.login !== "dependabot[bot]") {
        console.log(
          `Skipped: author is "${payload.pull_request.user?.login ?? "unknown"}", not dependabot[bot]`,
        );
        return;
      }

      const [owner, repo] = payload.repository.full_name.split("/");
      console.log(
        `Processing Dependabot PR #${payload.pull_request.number} in ${owner}/${repo}`,
      );

      await enableAutoMerge(octokit, payload.pull_request.node_id);
      console.log(`Auto-merge enabled for PR #${payload.pull_request.number}`);
    },
  );

  c.executionCtx.waitUntil(
    app.webhooks
      .receive({
        id: deliveryId ?? "",
        name: event as EmitterWebhookEventName,
        payload: JSON.parse(body),
      } as EmitterWebhookEvent)
      .catch((error: unknown) => console.error("Handler error:", error)),
  );

  return c.text("OK");
}
