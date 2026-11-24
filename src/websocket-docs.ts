import { Logger } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyReply } from 'fastify';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Marked } from 'marked';

const logger = new Logger('WebsocketDocs');
const DOC_PATH = path.join(process.cwd(), 'docs', 'websocket.md');

const markdown = new Marked({
  gfm: true,
  renderer: {
    html() {
      return '';
    },
  },
});

/**
 * Страница контракта Socket.IO. OpenAPI этот протокол не описывает,
 * поэтому документ читается из docs/websocket.md и отдаётся отдельно от Swagger.
 */
export function registerWebsocketDocs(
  app: NestFastifyApplication,
  swaggerPath: string,
): void {
  const instance = app.getHttpAdapter().getInstance();
  const handler = async (_request: unknown, reply: FastifyReply) => {
    try {
      const source = await readFile(DOC_PATH, 'utf8');
      const body = markdown.parse(source, { async: false });

      return reply
        .header('Cache-Control', 'no-store')
        .type('text/html; charset=utf-8')
        .send(renderPage(body, swaggerPath));
    } catch (error) {
      logger.error('Не удалось прочитать docs/websocket.md', error);

      return reply
        .code(500)
        .type('text/plain; charset=utf-8')
        .send('Не удалось открыть документацию WebSocket');
    }
  };

  instance.get('/websocket-docs', handler);
  instance.get('/websocket-docs/', handler);
}

function renderPage(body: string, swaggerPath: string): string {
  const restHref = escapeHtml(`/${encodeURI(swaggerPath)}`);

  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>WebSocket — VKS Service</title>
  <style>
    :root { color-scheme: light; }
    body { margin: 0; font: 16px/1.55 system-ui, sans-serif; color: #1c1917; background: #fafaf9; }
    header { display: flex; gap: 1.5rem; align-items: center; padding: 0.85rem 1.5rem; background: #1c1917; color: #fafaf9; }
    header strong { font-size: 0.95rem; }
    header a { color: #e7e5e4; text-decoration: none; }
    header a[aria-current="page"] { color: #fff; font-weight: 650; }
    main { max-width: 48rem; margin: 0 auto; padding: 1.5rem 1.25rem 4rem; }
    h1 { font-size: 1.8rem; line-height: 1.2; margin: 0 0 1rem; }
    h2 { font-size: 1.3rem; margin: 2rem 0 0.75rem; }
    h3 { font-size: 1.05rem; margin: 1.5rem 0 0.5rem; }
    p, ul, ol { margin: 0.75rem 0; }
    a { color: #9a3412; }
    code { font-family: ui-monospace, monospace; font-size: 0.9em; background: #f5f5f4; padding: 0.1em 0.35em; border-radius: 0.25rem; }
    pre { overflow: auto; padding: 0.9rem 1rem; background: #1c1917; color: #fafaf9; border-radius: 0.5rem; }
    pre code { background: transparent; color: inherit; padding: 0; }
    table { width: 100%; border-collapse: collapse; margin: 1rem 0; font-size: 0.95rem; }
    th, td { text-align: left; vertical-align: top; padding: 0.45rem 0.6rem; border-bottom: 1px solid #e7e5e4; }
    th { background: #f5f5f4; }
  </style>
</head>
<body>
  <header>
    <strong>VKS Service</strong>
    <nav>
      <a href="/websocket-docs/" aria-current="page">WebSocket</a>
      <a href="${restHref}">REST</a>
    </nav>
  </header>
  <main>${body}</main>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
