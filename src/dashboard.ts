import { Hono } from "hono";
import { html } from "hono/html";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { App } from "octokit";

interface Session {
  token: string;
  login: string;
}

interface SubStatuses {
  autoMerge: boolean | null;    // null = unknown (API error / permission denied)
  hasProtection: boolean | null; // null = unknown
}

type OverallStatus = "good" | "setup-needed" | "unknown";

interface RepoStatus {
  owner: string;
  name: string;
  fullName: string;
  subStatuses: SubStatuses;
  status: OverallStatus;
}

const SESSION_COOKIE = "sid";
const SESSION_TTL = 28800; // 8 hours
const STATE_TTL = 600;     // 10 minutes

function computeStatus(sub: SubStatuses): OverallStatus {
  if (sub.autoMerge === null || sub.hasProtection === null) return "unknown";
  if (sub.autoMerge && sub.hasProtection) return "good";
  return "setup-needed";
}

function statusEmoji(status: OverallStatus): string {
  if (status === "good") return "✅";
  if (status === "setup-needed") return "⚠️";
  return "❓";
}

function statusLabel(status: OverallStatus): string {
  if (status === "good") return "Good to go";
  if (status === "setup-needed") return "Setup needed";
  return "Unknown";
}

function subStatusIcon(value: boolean | null, trueLabel: string, falseLabel: string): string {
  if (value === null) return "❓ Unknown";
  return value ? `✅ ${trueLabel}` : `❌ ${falseLabel}`;
}

type HonoEnv = { Bindings: Env; Variables: { session: Session } };

const dashboard = new Hono<HonoEnv>();

dashboard.use("/*", async (c, next) => {
  if (c.req.path === "/dashboard/login" || c.req.path === "/dashboard/callback") {
    return next();
  }

  const sessionId = getCookie(c, SESSION_COOKIE);
  if (!sessionId) return c.redirect("/dashboard/login");

  const stored = await c.env.SESSIONS_KV.get(`session:${sessionId}`);
  if (!stored) {
    deleteCookie(c, SESSION_COOKIE, { path: "/dashboard" });
    return c.redirect("/dashboard/login");
  }

  c.set("session", JSON.parse(stored) as Session);
  return next();
});

dashboard.get("/login", async (c) => {
  const state = crypto.randomUUID().replace(/-/g, "");
  await c.env.SESSIONS_KV.put(`oauth_state:${state}`, "1", {
    expirationTtl: STATE_TTL,
  });

  const reqUrl = new URL(c.req.url);
  const callbackUrl = `${reqUrl.protocol}//${reqUrl.host}/dashboard/callback`;

  const authUrl = new URL("https://github.com/login/oauth/authorize");
  authUrl.searchParams.set("client_id", c.env.CLIENT_ID);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("redirect_uri", callbackUrl);

  return c.redirect(authUrl.toString());
});

dashboard.get("/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");

  if (!code || !state) return c.text("Missing code or state", 400);

  const storedState = await c.env.SESSIONS_KV.get(`oauth_state:${state}`);
  if (!storedState) return c.text("Invalid or expired OAuth state", 400);
  await c.env.SESSIONS_KV.delete(`oauth_state:${state}`);

  const app = new App({
    appId: c.env.APP_ID,
    privateKey: c.env.PRIVATE_KEY,
    oauth: { clientId: c.env.CLIENT_ID, clientSecret: c.env.CLIENT_SECRET },
  });

  const { authentication } = await app.oauth.createToken({ code });
  const accessToken = authentication.token;

  const userOctokit = await app.oauth.getUserOctokit({ token: accessToken });
  const { data: user } =
    await userOctokit.rest.users.getAuthenticated();

  const sessionId = crypto.randomUUID().replace(/-/g, "");
  const session: Session = { token: accessToken, login: user.login };
  await c.env.SESSIONS_KV.put(
    `session:${sessionId}`,
    JSON.stringify(session),
    { expirationTtl: SESSION_TTL },
  );

  setCookie(c, SESSION_COOKIE, sessionId, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/dashboard",
    maxAge: SESSION_TTL,
  });

  return c.redirect("/dashboard");
});

dashboard.get("/logout", async (c) => {
  const sessionId = getCookie(c, SESSION_COOKIE);
  if (sessionId) {
    await c.env.SESSIONS_KV.delete(`session:${sessionId}`);
  }
  deleteCookie(c, SESSION_COOKIE, { path: "/dashboard" });
  return c.redirect("/");
});

dashboard.get("/", async (c) => {
  const { token, login } = c.get("session");

  const app = new App({
    appId: c.env.APP_ID,
    privateKey: c.env.PRIVATE_KEY,
    oauth: { clientId: c.env.CLIENT_ID, clientSecret: c.env.CLIENT_SECRET },
  });
  const userOctokit = await app.oauth.getUserOctokit({ token });

  const repos: RepoStatus[] = [];

  try {
    const {
      data: { installations },
    } = await userOctokit.rest.apps.listInstallationsForAuthenticatedUser();

    for (const installation of installations) {
      const {
        data: { repositories },
      } =
        await userOctokit.rest.apps.listInstallationReposForAuthenticatedUser({
          installation_id: installation.id,
        });

      if (repositories.length === 0) continue;

      const installOctokit = await app.getInstallationOctokit(installation.id);

      // Batch-query all repos in one GraphQL request using numeric aliases
      const queryParts = repositories.map(
        (repo, i) =>
          `r${i}: repository(owner: ${JSON.stringify(repo.owner.login)}, name: ${JSON.stringify(repo.name)}) {
            autoMergeAllowed
            branchProtectionRules(first: 1) { totalCount }
            rulesets(first: 1) { totalCount }
          }`,
      );

      type RepoGql = {
        autoMergeAllowed: boolean;
        branchProtectionRules: { totalCount: number };
        rulesets: { totalCount: number };
      } | null;

      let gqlResult: Record<string, RepoGql> = {};
      let batchFailed = false;

      try {
        gqlResult = await installOctokit.graphql<Record<string, RepoGql>>(
          `{ ${queryParts.join("\n")} }`,
        );
      } catch {
        batchFailed = true;
      }

      for (let i = 0; i < repositories.length; i++) {
        const repo = repositories[i];
        let sub: SubStatuses;

        if (batchFailed || !gqlResult[`r${i}`]) {
          sub = { autoMerge: null, hasProtection: null };
        } else {
          const d = gqlResult[`r${i}`]!;
          sub = {
            autoMerge: d.autoMergeAllowed,
            hasProtection:
              d.branchProtectionRules.totalCount > 0 ||
              d.rulesets.totalCount > 0,
          };
        }

        repos.push({
          owner: repo.owner.login,
          name: repo.name,
          fullName: repo.full_name,
          subStatuses: sub,
          status: computeStatus(sub),
        });
      }
    }
  } catch (err) {
    console.error("Failed to fetch installations:", err);
  }

  repos.sort((a, b) => a.fullName.localeCompare(b.fullName));

  return c.html(renderPage(login, repos));
});

function repoCard(repo: RepoStatus) {
  const emoji = statusEmoji(repo.status);
  const label = statusLabel(repo.status);
  return html`
    <details class="repo-card status-${repo.status}">
      <summary>
        <span class="repo-name">${repo.fullName}</span>
        <span class="status-badge" title="${label}">${emoji} ${label}</span>
      </summary>
      <div class="repo-detail">
        <table>
          <tbody>
            <tr>
              <td class="sub-label">Auto-merge</td>
              <td>${subStatusIcon(repo.subStatuses.autoMerge, "Enabled", "Disabled")}</td>
            </tr>
            <tr>
              <td class="sub-label">Branch protection / rulesets</td>
              <td>${subStatusIcon(repo.subStatuses.hasProtection, "Configured", "Not configured")}</td>
            </tr>
          </tbody>
        </table>
        <div class="repo-links">
          <a href="https://github.com/${repo.fullName}" target="_blank" rel="noopener">View repo ↗</a>
          <a href="https://github.com/${repo.fullName}/settings" target="_blank" rel="noopener">Repo settings ↗</a>
          <a href="https://github.com/${repo.fullName}/settings/branches" target="_blank" rel="noopener">Branch protection ↗</a>
        </div>
      </div>
    </details>`;
}

function renderPage(login: string, repos: RepoStatus[]) {
  const goodCount = repos.filter((r) => r.status === "good").length;
  const total = repos.length;

  return html`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Dashboard · Mergerita</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --lime: #e8f48c;
      --lime-dark: #d4e070;
      --lime-deeper: #b8c840;
      --text: #1a1a1a;
      --muted: #555;
      --card-bg: rgba(255,255,255,0.55);
      --card-border: rgba(0,0,0,0.1);
      --radius: 10px;
      --font: system-ui, -apple-system, sans-serif;
    }

    body {
      background: var(--lime);
      background-image: radial-gradient(ellipse at 70% 20%, #f5ffb0 0%, var(--lime) 60%);
      min-height: 100vh;
      font-family: var(--font);
      color: var(--text);
      padding: 0 1rem 4rem;
    }

    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 1.25rem 0;
      border-bottom: 1.5px solid var(--lime-deeper);
      margin-bottom: 2rem;
      max-width: 760px;
      margin-left: auto;
      margin-right: auto;
    }

    .logo { font-size: 1.35rem; font-weight: 700; text-decoration: none; color: inherit; }

    .header-right {
      display: flex;
      align-items: center;
      gap: 1rem;
      font-size: 0.9rem;
      color: var(--muted);
    }

    .header-right a { color: inherit; text-decoration: underline; }
    .header-right a:hover { color: var(--text); }

    main { max-width: 760px; margin: 0 auto; }

    .page-title {
      font-size: 1.6rem;
      font-weight: 700;
      margin-bottom: 0.35rem;
    }

    .page-subtitle {
      font-size: 0.9rem;
      color: var(--muted);
      margin-bottom: 1.75rem;
    }

    .repo-list { display: flex; flex-direction: column; gap: 0.5rem; }

    details.repo-card {
      background: var(--card-bg);
      border: 1.5px solid var(--card-border);
      border-radius: var(--radius);
      backdrop-filter: blur(4px);
      overflow: hidden;
      transition: border-color 0.15s;
    }

    details.repo-card[open] { border-color: var(--lime-deeper); }

    details.repo-card > summary {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.85rem 1.1rem;
      cursor: pointer;
      list-style: none;
      gap: 1rem;
      user-select: none;
    }

    details.repo-card > summary::-webkit-details-marker { display: none; }

    details.repo-card > summary::before {
      content: '›';
      font-size: 1.2rem;
      color: var(--muted);
      margin-right: 0.5rem;
      transition: transform 0.15s;
      display: inline-block;
      flex-shrink: 0;
    }

    details.repo-card[open] > summary::before { transform: rotate(90deg); }

    .repo-name {
      font-weight: 600;
      font-size: 0.95rem;
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .status-badge {
      font-size: 0.82rem;
      white-space: nowrap;
      flex-shrink: 0;
    }

    .repo-detail {
      padding: 0 1.1rem 1.1rem;
      border-top: 1px solid var(--card-border);
    }

    .repo-detail table {
      width: 100%;
      border-collapse: collapse;
      margin: 0.75rem 0 1rem;
      font-size: 0.88rem;
    }

    .repo-detail td { padding: 0.35rem 0; }
    .repo-detail td.sub-label { color: var(--muted); width: 55%; }

    .repo-links {
      display: flex;
      gap: 1rem;
      flex-wrap: wrap;
      font-size: 0.82rem;
    }

    .repo-links a {
      color: var(--muted);
      text-decoration: underline;
    }

    .repo-links a:hover { color: var(--text); }

    .empty-state {
      background: var(--card-bg);
      border: 1.5px solid var(--card-border);
      border-radius: var(--radius);
      padding: 2.5rem 2rem;
      text-align: center;
    }

    .empty-state p { color: var(--muted); margin-bottom: 1rem; font-size: 0.95rem; }
    .empty-state a { color: var(--text); font-weight: 600; }
  </style>
</head>
<body>
  <header>
    <a class="logo" href="/">🍸 Mergerita</a>
    <div class="header-right">
      <span>@${login}</span>
      <a href="/dashboard/logout">Log out</a>
    </div>
  </header>

  <main>
    <h1 class="page-title">Your repositories</h1>
    <p class="page-subtitle">
      ${total === 0
        ? "No repositories installed yet."
        : total === goodCount
          ? `All ${total} ${total === 1 ? "repository is" : "repositories are"} good to go.`
          : `${goodCount} of ${total} ${total === 1 ? "repository" : "repositories"} good to go.`}
    </p>

    ${total === 0
      ? html`
        <div class="empty-state">
          <p>Mergerita isn't installed on any repositories yet.</p>
          <a href="https://github.com/apps/mergerita/installations/new" target="_blank" rel="noopener">
            Install Mergerita on GitHub ↗
          </a>
        </div>`
      : html`<div class="repo-list">${repos.map(repoCard)}</div>`}
  </main>
</body>
</html>`;
}

export default dashboard;
