import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../src/config/schema.js';
import { PlaywrightPublisherSite } from '../src/site/playwright-publisher-site.js';
import { runPublishWorkflow } from '../src/workflow/publish-workflow.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('Playwright adapter end-to-end against a semantic fixture site', () => {
  it('uploads a colocated image, creates a draft, publishes, and verifies the public article', async () => {
    const state: FixtureState = { saved: false, published: false, title: '', markdown: '' };
    const server = createServer((request, response) => {
      void handleRequest(request, response, state);
    });
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const runDirectory = await mkdtemp(join(tmpdir(), 'ironman-e2e-'));
    temporaryDirectories.push(runDirectory);
    const authDirectory = join(runDirectory, '.auth');
    await mkdir(authDirectory);
    const authStatePath = join(authDirectory, 'storage-state.json');
    await writeFile(authStatePath, '{"cookies":[],"origins":[]}', 'utf8');

    const config: AppConfig = {
      profileUrl: `${baseUrl}/users/20107519`,
      userIdentifier: 'test-user',
      ironmanYear: 2026,
      seriesTitle: 'Test Ironman Series',
      articlesDir: resolve(process.cwd(), '../../articles'),
      startDate: '2026-09-01',
      maximumDay: 30,
      timeZone: 'Asia/Taipei',
      primarySchedule: '10:17',
      fallbackSchedule: '20:47',
      publishDryRun: false,
      publishedUpdatePolicy: 'report',
      headless: true,
      authStatePath,
      diagnosticsDir: join(runDirectory, 'diagnostics'),
      statePath: join(runDirectory, 'state.json'),
      lockPath: join(runDirectory, 'publisher.lock'),
      lockStaleMs: 7_200_000,
      actionTimeoutMs: 5_000,
      navigationTimeoutMs: 5_000,
      verificationAttempts: 2,
      verificationDelayMs: 0,
      traceMode: 'off',
      logLevel: 'silent',
    };

    const logger = pino({ level: 'silent' });
    const site = await PlaywrightPublisherSite.create(config, logger);
    try {
      const result = await runPublishWorkflow(
        {
          timeZone: config.timeZone,
          startDate: config.startDate,
          maximumDay: config.maximumDay,
          articlesDir: config.articlesDir,
          dryRun: false,
          publishedUpdatePolicy: config.publishedUpdatePolicy,
          verificationAttempts: config.verificationAttempts,
          verificationDelayMs: config.verificationDelayMs,
        },
        {
          site,
          logger,
          now: () => new Date('2026-09-01T02:17:00.000Z'),
          sleep: async () => undefined,
        },
      );

      expect(result).toMatchObject({
        status: 'published',
        dayNumber: 1,
        expectedTitle: 'Day 001：先讓 Agent 自己發文——ADE 的第一個自動化應用',
        draftAction: 'created',
      });
      expect(state.saved).toBe(true);
      expect(state.published).toBe(true);
      expect(state.markdown).toContain(`${baseUrl}/uploaded/ref-image-001.png`);
      expect(state.markdown).not.toContain('./ref-image-001.png');
    } finally {
      await site.close(false);
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolveClose()));
      });
    }
  }, 20_000);
});

interface FixtureState {
  saved: boolean;
  published: boolean;
  title: string;
  markdown: string;
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  state: FixtureState,
): Promise<void> {
  const requestUrl = new URL(request.url ?? '/', 'http://fixture.test');
  if (request.method === 'GET' && requestUrl.pathname === '/') {
    sendHtml(
      response,
      pageShell('<nav><a href="/drafts">草稿</a><a href="/new">新增文章</a></nav><main>首頁</main>'),
    );
    return;
  }

  if (request.method === 'GET' && requestUrl.pathname === '/users/20107519') {
    sendHtml(response, pageShell('<main>test-user 個人頁 <a href="/users/20107519/articles">文章</a></main>'));
    return;
  }

  if (request.method === 'GET' && requestUrl.pathname === '/users/20107519/articles') {
    const listing = state.published
      ? `<main><article><h2><a href="/article/1">${escapeHtml(state.title)}</a></h2><time datetime="2026-09-01">2026-09-01</time></article></main>`
      : '<main><p>尚無文章</p></main>';
    sendHtml(response, pageShell(listing));
    return;
  }
  if (request.method === 'GET' && requestUrl.pathname === '/drafts') {
    if (state.saved) {
      sendHtml(response, pageShell(`<main><article><h2><a href="/draft/1">${escapeHtml(state.title)}</a></h2></article></main>`));
    } else {
      sendHtml(response, pageShell('<main><p>尚無文章</p></main>'));
    }
    return;
  }

  if (request.method === 'GET' && requestUrl.pathname === '/series') {
    const listing = state.published
      ? `<main><article><h2><a href="/article/1">${escapeHtml(state.title)}</a></h2><time datetime="2026-09-01">2026-09-01</time></article></main>`
      : '<main><p>尚無文章</p></main>';
    sendHtml(response, pageShell(listing));
    return;
  }

  if (request.method === 'GET' && requestUrl.pathname === '/article/1') {
    sendHtml(response, pageShell(`<main><h1>${escapeHtml(state.title)}</h1><a href="/users/20107519/ironman/123">Test Ironman Series</a></main>`));
    return;
  }

  if (request.method === 'GET' && requestUrl.pathname === '/users/20107519/ironman/123') {
    const listing = `<main><article><h2><a href="/article/1">${escapeHtml(state.title)}</a></h2><time datetime="2026-09-01">2026-09-01</time></article></main>`;
    sendHtml(response, pageShell(listing));
    return;
  }

  if (request.method === 'GET' && requestUrl.pathname === '/new') {
    sendHtml(response, editorPage('', '', false, request.headers.host ?? 'fixture.test'));
    return;
  }

  if (request.method === 'POST' && requestUrl.pathname === '/draft/1') {
    const form = new URLSearchParams(await readBody(request));
    state.title = form.get('title') ?? '';
    state.markdown = form.get('content') ?? '';
    state.saved = true;
    sendHtml(response, editorPage(state.title, state.markdown, true, request.headers.host ?? 'fixture.test'));
    return;
  }

  if (request.method === 'GET' && requestUrl.pathname === '/draft/1') {
    sendHtml(response, editorPage(state.title, state.markdown, true, request.headers.host ?? 'fixture.test'));
    return;
  }

  if (request.method === 'POST' && requestUrl.pathname === '/publish') {
    state.published = true;
    response.writeHead(303, { Location: '/series' });
    response.end();
    return;
  }

  response.writeHead(404);
  response.end('not found');
}

function pageShell(content: string): string {
  return `<!doctype html><html><body><header>test-user · Test Ironman Series</header>${content}</body></html>`;
}

function editorPage(title: string, markdown: string, saved: boolean, host: string): string {
  const publishForm = saved
    ? '<form method="post" action="/publish"><button type="submit">發表文章</button></form>'
    : '';
  return pageShell(`
    <main>
      <p>Test Ironman Series</p>
      <form method="post" action="/draft/1">
        <label>標題<input aria-label="標題" name="title" value="${escapeAttribute(title)}"></label>
        <label>內容<textarea aria-label="內容" name="content">${escapeHtml(markdown)}</textarea></label>
        <label>標籤<input aria-label="標籤" type="text" onkeydown="if(event.key==='Enter'){event.preventDefault()}"></label>
        <input id="image-upload" type="file" accept="image/*" hidden>
        <button type="submit">儲存草稿</button>
      </form>
      ${publishForm}
    </main>
    <script>
      document.querySelector('#image-upload').addEventListener('change', (event) => {
        const file = event.target.files[0];
        const editor = document.querySelector('[aria-label="內容"]');
        editor.value += '\\n![uploaded](http://${escapeJavaScript(host)}/uploaded/' + encodeURIComponent(file.name) + ')';
        editor.dispatchEvent(new Event('input', { bubbles: true }));
      });
    </script>
  `);
}

function sendHtml(response: ServerResponse, html: string): void {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(html);
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replaceAll('"', '&quot;');
}

function escapeJavaScript(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll("'", "\\'");
}
