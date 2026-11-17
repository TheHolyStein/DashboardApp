# Home Dashboard

A modular, themeable, multi-user home dashboard for a headless home server, reached over Tailscale.

TypeScript pnpm monorepo (Node 24). Workspaces live in `apps/`, `packages/`, `modules/` and `themes/`.

```sh
pnpm install
pnpm check   # lint (incl. import boundaries) + typecheck + tests
```

See `CLAUDE.md` for the commands and constraints, and `docs/superpowers/` for the spec and plans.

## Develop

```sh
pnpm dev                          # server (from source, restarts on change) on 127.0.0.1:8787 + Vite on http://localhost:5173
pnpm dev:admin --name Admin       # once: creates an admin in ./.data, prompts for the password
```

Open the Vite URL; it proxies `/api` to the server. Data lives in `./.data`. Ctrl-C stops both processes.

## End-to-end tests

```sh
pnpm exec playwright install chromium   # once
pnpm e2e                                # headless Chromium against the production build
```

The run builds first if `apps/server/dist` or `apps/web/dist` is missing (run `pnpm build` yourself after code changes),
starts the built server on a free port with a temporary data directory and tears it down afterwards. Not part of `pnpm check`.
