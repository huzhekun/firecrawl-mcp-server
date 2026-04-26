# minimal-firecrawl-mcp

Tiny remote MCP server backed by Firecrawl with three tools:

- `web_search`
- `read_url`
- `current_time`

Designed for low token usage by keeping tool schemas and descriptions short.

## Features

- TypeScript + official MCP SDK
- Streamable HTTP transport on `POST /mcp` (required)
- Optional stdio mode via `MCP_TRANSPORT=stdio`
- Health check at `GET /healthz`
- Readiness probe at `GET /readyz` and liveness probe at `GET /livez`
- Firecrawl request timeout (60s)
- Output truncation via `MAX_OUTPUT_CHARS`
- Dockerized, non-root runtime image

## Environment Variables

- `FIRECRAWL_API_KEY` (required)
- `FIRECRAWL_BASE_URL` (optional, default: `https://api.firecrawl.dev`)
- `PORT` (optional, default: `3000`)
- `MAX_OUTPUT_CHARS` (optional, default: `20000`)
- `DEFAULT_SEARCH_LIMIT` (optional, default: `5`)
- `MCP_TRANSPORT` (optional: `http` or `stdio`, default: `http`)
- `HOST` (optional, default: `0.0.0.0`)
- `SHUTDOWN_GRACE_MS` (optional, default: `10000`)

## Tools

### `web_search`
Search the web and return concise markdown results.

Input:
- `query` (string, required)
- `limit` (number, optional, max 10)
- `sources` (array of `web`, `news`, `images`; optional, default `["web", "news"]`)
- `include_content` (boolean, optional, default true)

Notes:
- If `include_content=true`, sends Firecrawl `scrapeOptions` requesting markdown.
- If `include_content=false`, sends basic search request without scrape options.
- Images are opt-in because image results are usually token-heavier.
- Supports Firecrawl v2 search responses such as `data.web`, `data.news`, and `data.images`.

### `read_url`
Read one URL as clean markdown.

Input:
- `url` (string, required, must start with `http://` or `https://`)
- `max_chars` (number, optional, default `MAX_OUTPUT_CHARS`)
- `start_index` (number, optional, default `0`)

Notes:
- Use `start_index` with `max_chars` to read long pages in chunks.
- If more content is available, the response includes the next `start_index`.

### `current_time`
Get the current time including date.

Input:
- `time_zone` (string, optional, IANA time zone like `America/Los_Angeles`, default `UTC`)

Returns:
- Time in requested zone plus UTC reference
- Example:
  - `Current time (America/Los_Angeles): 2026-04-26T09:45:12 (GMT-7)`
  - `Day: Sunday`
  - `UTC: 2026-04-26T16:45:12.345Z`

## Local Development

```bash
npm ci
npm run build
npm start
```

Dev mode:

```bash
npm run dev
```

Server runs on `http://localhost:3000` by default.

## Docker

Build image:

```bash
docker build -t minimal-firecrawl-mcp .
```

Run container:

```bash
docker run --rm -p 3000:3000 \
  -e FIRECRAWL_API_KEY=fc-YOUR_KEY \
  -e MAX_OUTPUT_CHARS=20000 \
  minimal-firecrawl-mcp
```

## Cline Remote MCP Config

```json
{
  "mcpServers": {
    "firecrawl-lite": {
      "type": "streamableHttp",
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

## Quick curl checks

Health:

```bash
curl -s http://localhost:3000/healthz
```

Readiness:

```bash
curl -s http://localhost:3000/readyz
```

Liveness:

```bash
curl -s http://localhost:3000/livez
```

## Kubernetes notes

- The app now exposes:
  - `/livez` (liveness)
  - `/readyz` (readiness)
  - `/healthz` (general health alias)
- On `SIGTERM`/`SIGINT`, the service marks itself unready and gracefully closes the HTTP server before exit.
- Both container images include a Docker `HEALTHCHECK` that calls `/readyz`.

Search (direct Firecrawl endpoint sanity check):

```bash
curl -s -X POST "${FIRECRAWL_BASE_URL:-https://api.firecrawl.dev}/v2/search" \
  -H "Authorization: Bearer $FIRECRAWL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query":"firecrawl","limit":3}'
```

Scrape (direct Firecrawl endpoint sanity check):

```bash
curl -s -X POST "${FIRECRAWL_BASE_URL:-https://api.firecrawl.dev}/v2/scrape" \
  -H "Authorization: Bearer $FIRECRAWL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com","formats":["markdown"],"onlyMainContent":true}'
```
