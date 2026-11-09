# Cairn

An open-source intelligence (OSINT) workbench: a live map over public data feeds, a set of investigation tools that run in the browser, a curated directory of OSINT tools, and case workspaces to keep notes in.

Built with Next.js 15, React 19, TypeScript, PostgreSQL and MapLibre.

## Features

**Live map.** Toggleable layers over public feeds, each one timestamped and linked back to its source:

| Layer | Source |
| --- | --- |
| Aircraft | adsb.lol (ADS-B) |
| Earthquakes | USGS |
| Wildfires | NASA FIRMS |
| Weather alerts | US National Weather Service |
| Webcams and traffic cameras | public camera catalogues (3,000+ cameras) |
| Radio | Radio Browser |
| 911 dispatch | Seattle Fire, San Francisco Police open data |

Every layer also has an accessible table view, and the map is opt-in because WebGL can be used for fingerprinting.

**Toolbench.** About 15 tools, client-side wherever possible so files never leave the browser:
EXIF viewer and metadata stripper, file hashing, image comparison, reverse image search links, JWT decoder, DNS and certificate transparency (crt.sh) lookups, IP info, OpenStreetMap Overpass queries, coordinate conversion (MGRS, Plus Codes), sun position for photo dating, and text transforms.

**Directory.** 94 OSINT tools in 10 categories, each with cost, licence, jurisdiction notes, a confidence rating and a last-verified date.

**Playbooks and workspaces.** Step-by-step investigation methods linked to the tools. Signed-in users get case workspaces with checklists, timestamped notes, saved map features and Markdown/PDF export.

## Ground rules

Cairn only uses sources that are public, allow third-party use, and have known rate limits. It never does facial recognition, never searches breached credentials, doesn't store investigation subjects as platform data, and doesn't use ad or behavioural trackers.

## Stack

- Next.js 15 (App Router, Server Components), React 19, TypeScript strict
- Tailwind CSS v4, Radix primitives
- PostgreSQL with Drizzle ORM
- Auth.js (magic link sign-in)
- MapLibre GL
- Vitest, Testing Library and Playwright
- Docker and Caddy for deployment

## Running locally

Requires Node 22+ and pnpm.

```bash
pnpm install
cp .env.example .env.local   # fill in what you need
pnpm dev:db                  # starts a disposable local Postgres
pnpm db:migrate
pnpm db:seed
pnpm dev
```

Open http://localhost:3000. Sign-in is optional; without an email provider configured the public parts of the site still work.

## Scripts

| Command | What it does |
| --- | --- |
| `pnpm dev` | Dev server |
| `pnpm build` | Production build (doesn't need a database or secrets) |
| `pnpm typecheck` | TypeScript check |
| `pnpm lint` | ESLint |
| `pnpm test` | Unit and integration tests (Vitest) |
| `pnpm test:e2e` | End-to-end tests (Playwright) |
| `pnpm content:check` | Validate the directory and camera data |
| `pnpm csp:check` | Check the Content Security Policy is up to date |

## Deployment

`Dockerfile`, `docker-compose.prod.yml` and `infra/` hold a Docker + Caddy setup for a single VPS, with `infra/bootstrap.sh` to set up a fresh server.

## License

MIT
