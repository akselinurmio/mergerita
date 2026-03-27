import { Hono } from "hono";
import { handleWebhook } from "./webhook";
import type { Env } from "./types";
import indexHtml from "./index.html";
import favicon from "../static/cocktail.png";

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) => c.html(indexHtml));
app.get("/favicon.ico", (c) => {
  return c.body(favicon, { headers: { "Content-Type": "image/png" } });
});
app.post("/webhook", handleWebhook);

export default app;
