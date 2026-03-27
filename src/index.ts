import { Hono } from "hono";
import { handleWebhook } from "./webhook";
import type { Env } from "./types";
import indexHtml from "./index.html";

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) => c.html(indexHtml));
app.post("/webhook", handleWebhook);

export default app;
