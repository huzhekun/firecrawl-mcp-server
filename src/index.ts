#!/usr/bin/env node
import express, { type Request, type Response } from 'express';
import { createServer, type Server as HttpServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const PORT = Number(process.env.PORT ?? 3000);
const FIRECRAWL_BASE_URL = process.env.FIRECRAWL_BASE_URL ?? 'https://api.firecrawl.dev';
const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY;
const MAX_OUTPUT_CHARS = Number(process.env.MAX_OUTPUT_CHARS ?? 20000);
const DEFAULT_SEARCH_LIMIT = Number(process.env.DEFAULT_SEARCH_LIMIT ?? 5);
const DEFAULT_SEARCH_SOURCES = ['web', 'news'] as const;
const SEARCH_SOURCES = ['web', 'news', 'images'] as const;
const REQUEST_TIMEOUT_MS = 60_000;
const TRANSPORT = process.env.MCP_TRANSPORT ?? 'http';
const HOST = process.env.HOST ?? '0.0.0.0';
const SHUTDOWN_GRACE_MS = Number(process.env.SHUTDOWN_GRACE_MS ?? 10_000);
type SearchSource = (typeof SEARCH_SOURCES)[number];

if (!FIRECRAWL_API_KEY) {
  console.error('FIRECRAWL_API_KEY is required');
  process.exit(1);
}

function truncate(text: string, maxChars: number): string {
  if (!Number.isFinite(maxChars) || maxChars <= 0) return '';
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n...[truncated]`;
}

function paginateText(text: string, startIndex: number, maxChars: number): string {
  if (!Number.isFinite(maxChars) || maxChars <= 0) return '';
  const safeStartIndex = Math.max(0, Math.min(startIndex, text.length));
  const endIndex = Math.min(safeStartIndex + maxChars, text.length);
  const page = text.slice(safeStartIndex, endIndex);

  const lines = [page];

  if (endIndex < text.length) {
    lines.push(
      '',
      `[Content truncated. Call read_url again with start_index=${endIndex} to continue.]`
    );
  }

  return lines.join('\n');
}

function bodyExcerpt(body: string, max = 500): string {
  return body.length > max ? `${body.slice(0, max)}...` : body;
}

function getSearchItems(payload: any, sources: readonly SearchSource[]): any[] {
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.results)) return payload.results;
  if (Array.isArray(payload?.data?.results)) return payload.data.results;

  const sourceBuckets = payload?.data;
  if (sourceBuckets && typeof sourceBuckets === 'object') {
    const items: any[] = [];

    for (const source of sources) {
      if (Array.isArray(sourceBuckets[source])) {
        items.push(...sourceBuckets[source]);
      }
    }

    return items.filter(
      (item, index, array) =>
        array.findIndex(
          (candidate) =>
            candidate?.url === item?.url &&
            candidate?.title === item?.title &&
            candidate?.description === item?.description
        ) === index
    );
  }

  return [];
}

function formatSearchMarkdown(items: any[], includeContent: boolean): string {
  if (!items.length) return 'No results.';

  const lines: string[] = [];
  items.forEach((item, index) => {
    const title = item?.title || `Result ${index + 1}`;
    const url = item?.url || item?.sourceURL || '';
    const description = item?.description || item?.snippet || '';
    const content = item?.markdown || item?.content || item?.rawContent || '';

    lines.push(`## ${index + 1}. ${title}`);
    if (url) lines.push(`- URL: ${url}`);
    if (description) lines.push(`- Description: ${description}`);
    if (includeContent && content) {
      lines.push('');
      lines.push(content.slice(0, 1200));
    }
    lines.push('');
  });

  return lines.join('\n').trim();
}

function formatReadMarkdown(payload: any): string {
  const data = payload?.data ?? payload;
  const markdown = data?.markdown || data?.content || '';
  const metadata = data?.metadata ?? {};

  const lines = ['# Read URL'];

  const title = metadata?.title || data?.title;
  const sourceUrl = data?.url || metadata?.sourceURL || metadata?.url;
  const description = metadata?.description;

  if (title) lines.push(`- Title: ${title}`);
  if (sourceUrl) lines.push(`- URL: ${sourceUrl}`);
  if (description) lines.push(`- Description: ${description}`);
  lines.push('');
  lines.push(markdown || 'No markdown content returned.');

  return lines.join('\n');
}

async function callFirecrawl(path: string, body: unknown): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${FIRECRAWL_BASE_URL}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${FIRECRAWL_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const rawText = await response.text();

    if (!response.ok) {
      throw new Error(
        `Firecrawl API error ${response.status}: ${bodyExcerpt(rawText)}`
      );
    }

    try {
      return JSON.parse(rawText);
    } catch {
      throw new Error(`Firecrawl API returned non-JSON response: ${bodyExcerpt(rawText)}`);
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Firecrawl API timeout after ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'firecrawl-lite',
    version: '0.1.0',
  });

  server.registerTool(
    'web_search',
    {
      description: 'Return web search results. Defaults to web and news; request images only when needed.',
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().min(1).max(10).optional(),
        sources: z
          .array(z.enum(SEARCH_SOURCES))
          .min(1)
          .max(3)
          .describe('Result sources to search: web, news, and/or images. Defaults to web and news.')
          .optional(),
        include_content: z.boolean().optional(),
      },
    },
    async ({ query, limit, sources, include_content }) => {
      const finalLimit = Math.max(1, Math.min(limit ?? DEFAULT_SEARCH_LIMIT, 10));
      const includeContent = include_content ?? true;
      const finalSources = sources ?? [...DEFAULT_SEARCH_SOURCES];

      const body: Record<string, unknown> = {
        query,
        limit: finalLimit,
        sources: finalSources,
      };

      if (includeContent) {
        body.scrapeOptions = {
          formats: ['markdown'],
          onlyMainContent: true,
        };
      }

      const result = await callFirecrawl('/v2/search', body);
      const items = getSearchItems(result, finalSources);
      const text = truncate(formatSearchMarkdown(items, includeContent), MAX_OUTPUT_CHARS);

      return {
        content: [{ type: 'text', text }],
      };
    }
  );

  server.registerTool(
    'read_url',
    {
      description: 'Read one URL as clean markdown.',
      inputSchema: {
        url: z.string().min(1),
        max_chars: z.number().int().positive().optional(),
        start_index: z
          .number()
          .int()
          .min(0)
          .describe('Character index to start reading from. Use the continuation hint to fetch the next chunk.')
          .optional(),
      },
    },
    async ({ url, max_chars, start_index }) => {
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        throw new Error('Invalid URL: must start with http:// or https://');
      }

      const body = {
        url,
        formats: ['markdown'],
        onlyMainContent: true,
      };

      const result = await callFirecrawl('/v2/scrape', body);
      const maxChars = max_chars ?? MAX_OUTPUT_CHARS;
      const text = paginateText(formatReadMarkdown(result), start_index ?? 0, maxChars);

      return {
        content: [{ type: 'text', text }],
      };
    }
  );

  return server;
}

async function runHttpServer(): Promise<void> {
  const app = express();
  let isShuttingDown = false;
  const startedAt = new Date().toISOString();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  app.get(['/healthz', '/health', '/livez'], (_req, res) => {
    res.status(200).json({ ok: true, status: 'live', transport: TRANSPORT, startedAt });
  });

  app.get('/readyz', (_req, res) => {
    if (isShuttingDown) {
      return res.status(503).json({ ok: false, status: 'shutting_down' });
    }

    return res.status(200).json({ ok: true, status: 'ready' });
  });

  app.post('/mcp', async (req: Request, res: Response) => {
    console.log(`[${new Date().toISOString()}] POST /mcp`);

    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    res.on('close', () => {
      transport.close();
      server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('MCP request failed:', error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: error instanceof Error ? error.message : 'Internal error' },
          id: null,
        });
      }
    }
  });

  const methodNotAllowed = (_req: Request, res: Response) => {
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed.' },
      id: null,
    });
  };

  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);

  const httpServer: HttpServer = createServer(app);

  httpServer.keepAliveTimeout = 61_000;
  httpServer.headersTimeout = 65_000;

  const closeHttpServer = () =>
    new Promise<void>((resolve, reject) => {
      httpServer.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`[${new Date().toISOString()}] Received ${signal}, shutting down...`);

    const forceExitTimer = setTimeout(() => {
      console.error(`Forced shutdown after ${SHUTDOWN_GRACE_MS}ms`);
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);

    forceExitTimer.unref();

    try {
      await closeHttpServer();
      console.log('HTTP server closed gracefully');
      process.exit(0);
    } catch (error) {
      console.error('Error while shutting down HTTP server:', error);
      process.exit(1);
    } finally {
      clearTimeout(forceExitTimer);
    }
  };

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });

  httpServer.listen(PORT, HOST, () => {
    console.log(`firecrawl-lite MCP listening on ${HOST}:${PORT}`);
  });
}

async function runStdioServer(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (TRANSPORT === 'stdio') {
  runStdioServer().catch((error) => {
    console.error('Failed to start stdio MCP server:', error);
    process.exit(1);
  });
} else {
  runHttpServer().catch((error) => {
    console.error('Failed to start HTTP MCP server:', error);
    process.exit(1);
  });
}
