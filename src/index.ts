import { Hono } from "hono";
import { handleWebhook } from "./webhook";
import type { Env } from "./types";

const app = new Hono<{ Bindings: Env }>();

app.post("/webhook", handleWebhook);

export default app;
