# Mergerita

GitHub App that auto-merges Dependabot PRs in your repositories, with a web dashboard to check setup status.

When Dependabot opens or updates a pull request, Mergerita enables GitHub's native auto-merge. GitHub then merges the PR once all required status checks pass.

Hosted on Cloudflare Workers (free plan).

## How it works

1. Dependabot opens or pushes new commits to a PR
2. GitHub sends a `pull_request` webhook to Mergerita (`opened`, `reopened`, or `synchronize`)
3. Mergerita verifies the webhook signature
4. Mergerita checks that the PR author is `dependabot[bot]`
5. Mergerita enables auto-merge (squash)
6. GitHub merges the PR when all required checks pass

## Prerequisites

- A [GitHub](https://github.com) account
- A [Cloudflare](https://dash.cloudflare.com/sign-up) account (free plan works)
- [Node.js](https://nodejs.org) 18+ and npm
- The [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) (`npm install -g wrangler`)
- `openssl` (for private key conversion)

## Setup

### 1. Deploy the Worker

This gives you the URL you'll need when creating the GitHub App.

```sh
# Clone and install
git clone <repo-url> mergerita
cd mergerita
npm install

# Authenticate with Cloudflare
wrangler login

# Deploy (note the URL it prints, e.g. https://mergerita.<you>.workers.dev)
wrangler deploy
```

### 2. Create the GitHub App

Go to **[github.com/settings/apps/new](https://github.com/settings/apps/new)** and fill in:

| Field               | Value                                                    |
| ------------------- | -------------------------------------------------------- |
| **GitHub App name** | `mergerita` (or any unique name)                         |
| **Homepage URL**    | Your Worker URL                                          |
| **Callback URL**    | `https://mergerita.<you>.workers.dev/dashboard/callback` |
| **Webhook URL**     | `https://mergerita.<you>.workers.dev/webhook`            |
| **Webhook secret**  | Generate one: `openssl rand -hex 32`                     |

**Permissions** (Repository):

| Permission     | Access       |
| -------------- | ------------ |
| Administration | Read-only    |
| Contents       | Read & write |
| Metadata       | Read-only    |
| Pull requests  | Read & write |

**Subscribe to events:**

- [x] Pull request

Set **"Where can this GitHub App be installed?"** to "Only on this account" (you can change this later for publication).

Click **Create GitHub App**.

### 3. Generate a private key

On the app settings page, scroll to **Private keys** and click **Generate a private key**. A `.pem` file will download.

Convert it to PKCS#8 format (required for Cloudflare Workers):

```sh
openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt \
  -in ~/Downloads/<app-name>.<date>.private-key.pem \
  -out private-key.pem
```

### 4. Configure secrets

Note your **App ID** and **Client ID** from the app settings page.

```sh
wrangler secret put APP_ID
wrangler secret put WEBHOOK_SECRET
cat private-key.pem | wrangler secret put PRIVATE_KEY
wrangler secret put CLIENT_ID      # from GitHub App settings "Client ID"
wrangler secret put CLIENT_SECRET  # from GitHub App settings → "Generate a new client secret"
```

### 5. Create the KV namespace for sessions

The dashboard stores login sessions in a Cloudflare KV namespace.

```sh
wrangler kv namespace create SESSIONS_KV
```

The command prints a namespace ID. Add it to `wrangler.jsonc`:

```jsonc
"kv_namespaces": [
  { "binding": "SESSIONS_KV", "id": "<paste-your-namespace-id-here>" }
]
```

Then redeploy:

```sh
wrangler deploy
```

### 6. Install the app

Go to your app's settings page and click **Install App** in the sidebar. Choose the account and select which repositories the app should have access to.

### 7. Enable auto-merge on your repositories

For each repository where you want Mergerita to work, go to **Settings > General** and check **Allow auto-merge**.

## Dashboard

Visit `https://mergerita.<you>.workers.dev/dashboard` to log in with GitHub and see the setup status of all repositories where Mergerita is installed.

Each repository shows one of three statuses:

| Status          | Meaning                                                                                |
| --------------- | -------------------------------------------------------------------------------------- |
| ✅ Good to go   | Auto-merge is enabled and at least one branch protection rule or ruleset is configured |
| ⚠️ Setup needed | One or more settings are missing                                                       |
| ❓ Unknown      | Status could not be retrieved (API error or insufficient permissions)                  |

Click any repository row to expand it and see sub-status details, plus links to the repo and its settings pages on GitHub.

The dashboard uses GitHub's OAuth flow (via the same GitHub App). Sessions are stored in Cloudflare KV and expire after 8 hours. There is no client-side JavaScript.

## Local development

```sh
# Copy the example env file and fill in your secrets
cp .dev.vars.example .dev.vars

# Start the local dev server
npm run dev
```

To receive webhooks locally, use a tunnel like [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-local-tunnel/) or [smee.io](https://smee.io), and point your GitHub App's webhook URL to the tunnel.

## Project structure

```
src/
  index.ts      Hono app entry point and routes
  webhook.ts    Webhook signature verification and event dispatch
  dashboard.ts  Dashboard: OAuth login, session management, repo status UI
  github.ts     GitHub API helpers: auto-merge via GraphQL
public/
  index.html    Landing page
```

## Architecture decisions

- **GitHub native auto-merge** over manual merge-on-green: Delegates check-watching to GitHub, making the Worker stateless and simple. One webhook event, one API call, done.
- **Raw `fetch`** for GitHub API: Only one endpoint is called (GraphQL for auto-merge). A full SDK would be unnecessary weight.
- **`@octokit/auth-app`** for authentication: Handles JWT signing and installation token exchange correctly with Web Crypto API.
- **GitHub App OAuth** for the dashboard: Reuses the existing app's Client ID and Client Secret — no separate OAuth App needed.
- **Cloudflare KV** for sessions: Minimal state, free tier sufficient, naturally expires stale sessions.
- **`<details>`/`<summary>`** for expandable repo cards: Zero client-side JavaScript required.
- **Batch GraphQL with aliases** for repo status: One query per installation instead of one per repository, keeping API usage low.
