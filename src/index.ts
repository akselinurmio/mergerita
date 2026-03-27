import { Hono } from "hono";
import { handleWebhook } from "./webhook";

const app = new Hono<{ Bindings: Env }>();

app.post("/webhook", handleWebhook);

export default app;
