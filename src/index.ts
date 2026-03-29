import { Hono } from "hono";
import { handleWebhook } from "./webhook";
import dashboard from "./dashboard";

const app = new Hono<{ Bindings: Env }>();

app.post("/webhook", handleWebhook);
app.route("/dashboard", dashboard);

export default app;
