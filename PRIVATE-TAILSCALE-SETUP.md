# Private TermForge access with Tailscale (macOS)

This guide serves TermForge from your Mac to a few invited, trusted people
through your private Tailscale network. Your Mac remains the server: it must be
powered on, connected to the internet, and running PostgreSQL, the API, worker,
Caddy, and Tailscale.

This is for a **private, trusted-user test**, not public registration. The
current worker uses Docker containers that share the Mac's host kernel; it is
not a security-certified public sandbox. Do not use Tailscale Funnel, router
port forwarding, or expose the worker or Docker daemon to the internet.

Tailscale Serve is available only to devices/users allowed by your tailnet.
Every invited tester needs Tailscale access. Check Tailscale's current plan and
sharing limits before inviting them; plan terms can change.

## 1. Preserve and push the version you want to serve

The current local TermForge worktree may contain uncommitted fixes. Review and
commit/push the exact changes you want testers to use, or do the deployment
from the existing local checkout. Never commit `.env` files, passwords, tokens,
database dumps, or other secrets.

## 2. Install and sign in to Tailscale

1. Install Tailscale for macOS from [Tailscale's download page](https://tailscale.com/download/mac).
2. Sign in on the Mac that will host TermForge.
3. Ask each tester to install Tailscale and join your tailnet, or use Tailscale's
   device-sharing/access-control feature for only this host.
4. Keep access limited to the people you trust. Do not enable Funnel.

Tailscale Serve may prompt you to enable HTTPS certificates for your tailnet.
Allow that only if you intend to serve this private app over HTTPS.

## 3. Confirm PostgreSQL is running

Open Terminal:

```sh
pg_isready
```

If PostgreSQL is not ready, start it using the same app/service you installed
PostgreSQL with (for example, Postgres.app or your package manager). Do not
reset, drop, or recreate your existing TermForge database. Keep the existing
database URL in `api/.env` if that is the database whose data you want to keep.

## 4. Configure local secrets and sandbox images

Open `api/.env` and `worker/.env` in an editor on the Mac. Do not paste their
contents into chat, a browser, a GitHub issue, or a source file. Do not replace
an existing `.env` blindly.

The API configuration must include:

```dotenv
NODE_ENV=production
JWT_SECRET=<a-new-random-secret-at-least-32-characters>
COOKIE_SECURE=true
DATABASE_URL=<your-existing-local-PostgreSQL-connection-string>
SANDBOX_WORKER_URL=http://127.0.0.1:7001
SANDBOX_WORKER_TOKEN=<a-long-random-private-token>
```

The worker configuration must include the **same** `SANDBOX_WORKER_TOKEN`,
bind locally, and select the Git and Docker images:

```dotenv
WORKER_HOST=127.0.0.1
WORKER_PORT=7001
SANDBOX_WORKER_TOKEN=<the-same-long-random-private-token>
SANDBOX_IMAGE_GIT=termforge/git-exam:local
SANDBOX_IMAGE_DOCKER=termforge/docker-exam:local
```

Generate random values locally, for example:

```sh
openssl rand -base64 48
```

Use one generated value for `JWT_SECRET` and a different value for the worker
token. Do not put either value in frontend configuration. Keep
`api/.env` and `worker/.env` out of Git.

Build the sandbox images from the repository root:

```sh
docker build -f worker/sandbox-images/git/Dockerfile \
  -t termforge/git-exam:local worker/
docker build -f worker/sandbox-images/docker/Dockerfile \
  -t termforge/docker-exam:local worker/
```

Docker Desktop must be running. Do not mount the host Docker socket into exam
containers or enable network access for candidate workspaces.

## 5. Install dependencies, migrate, and build

Run these commands from the repository root:

```sh
cd api && npm ci && npm run build
cd ../worker && npm ci && npm run build
cd ../web && npm ci && npm run build
```

Apply the committed migrations to the database selected by `DATABASE_URL`:

```sh
cd ../api
npm run db:migrate
```

Before migrating, confirm in your local editor that `DATABASE_URL` points to
the intended database. This command applies migrations; it is not a database
reset. Do not run `db:push`, drop tables, or delete data as a deployment step.

## 6. Install Caddy for the local frontend/API reverse proxy

Caddy serves the built frontend and forwards API and WebSocket requests to the
API. The proxy listens only on `127.0.0.1`; Tailscale Serve will provide the
private HTTPS endpoint.

Install Caddy if needed:

```sh
brew install caddy
```

Create a file named `Caddyfile` in the repository root with:

```caddyfile
http://127.0.0.1:8080 {
	handle /api/* {
		reverse_proxy 127.0.0.1:3001
	}

	handle /health {
		reverse_proxy 127.0.0.1:3001
	}

	handle {
		root * /Users/premkumar/Desktop/TermForge/web/dist
		try_files {path} /index.html
		file_server
	}
}
```

If the repository is in a different directory, replace the `root` path with
the absolute path to that checkout's `web/dist` directory. Validate it:

```sh
caddy validate --config ./Caddyfile
```

The `/api/*` proxy also handles the exam terminal WebSocket. Do not remove
WebSocket proxy support or change the API/worker to listen on a public
interface.

## 7. Start TermForge services

Keep these processes running. Use separate Terminal windows/tabs, starting each
command from the indicated directory:

**Terminal 1 — worker**

```sh
cd /Users/premkumar/Desktop/TermForge/worker
npm start
```

**Terminal 2 — API**

```sh
cd /Users/premkumar/Desktop/TermForge/api
npm start
```

**Terminal 3 — Caddy**

```sh
cd /Users/premkumar/Desktop/TermForge
caddy run --config ./Caddyfile
```

The app loads each `.env` from its service's working directory. Keep these
terminals open. For a short test on a Mac that would otherwise sleep, you can
run `caffeinate -dimsu` in another Terminal window and stop it with Ctrl+C when
finished. Keep the Mac plugged in and awake. If the Mac or PostgreSQL stops,
the site and saved-data access will be unavailable until services restart.

## 8. Verify locally before sharing

In another Terminal window:

```sh
curl -fsS http://127.0.0.1:3001/health
curl -fsS http://127.0.0.1:7001/health
curl -I http://127.0.0.1:8080/
```

The API health response should report PostgreSQL as connected. The worker
health response should report Docker available. If either fails, do not share
the URL yet; inspect that service's terminal output without printing `.env`
values.

## 9. Create the private HTTPS URL

Run:

```sh
tailscale serve --https=443 http://127.0.0.1:8080
```

If prompted, follow Tailscale's HTTPS setup. Keep the command running and copy
the `https://...ts.net` address it prints. Confirm the active configuration:

```sh
tailscale serve status
```

The Serve URL is reachable only through your tailnet/device-sharing access;
this is not a public website. It does not require router port forwarding.
**Do not run `tailscale funnel`** for this app.

Open the HTTPS URL on your Mac first. Then open it from a tester's device after
that tester has joined the allowed Tailscale network. Register/sign in and take
a Git & GitHub test. Verify terminal input works, question progress saves, and
the final submission shows the score and answer review.

## 10. Keep the deployment private and available

- Keep ports `3001`, `7001`, and `8080` off the public firewall/router.
- Keep the worker bound to `127.0.0.1`; do not expose its token in web code.
- Do not invite unknown users. Restrict tailnet access to your small test group.
- Do not use this Docker sandbox for hostile/public candidates.
- The Mac, PostgreSQL, Docker Desktop, worker, API, Caddy, and Tailscale must
  remain running for the URL to work.
- Back up the local PostgreSQL data regularly and protect backups like secrets.
- To stop sharing, stop the Serve command with Ctrl+C and stop the services.
  Check `tailscale serve status` to ensure the Serve mapping is no longer
  active. Stopping the web link does not delete exam data.

## Official references

- [Tailscale Serve CLI](https://tailscale.com/docs/reference/tailscale-cli/serve)
- [Tailscale Serve overview](https://tailscale.com/docs/features/tailscale-serve)
- [Caddy reverse proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)
- [Tailscale plans](https://tailscale.com/pricing)
