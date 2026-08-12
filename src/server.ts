import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';

import { BoardError, BoardStore, parseLimit, parseSince } from './store.ts';
import type { ListQuery, Post } from './store.ts';

function listQuery(url: URL): ListQuery {
  const get = (key: string) => url.searchParams.get(key) ?? undefined;
  return {
    topic: get('topic'),
    author: get('author'),
    tag: get('tag'),
    q: get('q'),
    status: get('status'),
    assignee: get('assignee'),
    repo: get('repo'),
    file: get('file'),
    since: parseSince(url.searchParams.get('since')),
    limit: parseLimit(url.searchParams.get('limit')),
  };
}

/** SettingMain 의 httpUtil 관례를 그대로 따른다. */
export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = Buffer.from(JSON.stringify(payload, null, 2), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.byteLength),
    'cache-control': 'no-store',
  });
  res.end(body);
}

export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

const MAX_BODY_BYTES = 1024 * 1024;

export async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.byteLength;
    if (size > MAX_BODY_BYTES) throw new BoardError(400, '본문이 너무 큽니다(1MB 초과)');
    chunks.push(buf);
  }
  if (size === 0) return {};
  // 잘못된 바이트는 여기서 U+FFFD 가 된다 → store 의 검증이 400 으로 거절한다.
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new BoardError(400, 'JSON 객체를 보내야 합니다');
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof BoardError) throw err;
    throw new BoardError(400, 'JSON 파싱 실패');
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/**
 * 글 하나를 **마크다운 파일 그대로** 준다 (`GET /api/posts/<id>.md`).
 *
 * 본문은 어차피 마크다운으로 쓰기로 했으므로, 다른 PC 의 클로드가 `curl -O` 한 번으로
 * `.md` 파일을 받아 그대로 읽거나 저장소에 넣을 수 있어야 한다. 작업 필드(status·files·next)는
 * 본문에 섞지 않고 **앞머리(front matter)** 로 올린다 — 사람이 읽어도, 파서가 읽어도 된다.
 */
export function toMarkdownFile(post: Post): string {
  const front: string[] = ['---'];
  const put = (key: string, value: unknown) => {
    if (value === null || value === undefined || value === '') return;
    // JSON 문자열·배열은 그대로 YAML 로도 읽힌다. 따옴표·콜론을 따로 신경 쓰지 않아도 된다.
    front.push(`${key}: ${JSON.stringify(value)}`);
  };

  put('seq', post.seq);
  put('id', post.id);
  put('topic', post.topic);
  put('author', post.author);
  put('title', post.title);
  if (post.status) put('status', post.status);
  put('assignee', post.assignee);
  put('repo', post.repo);
  if (post.files.length) put('files', post.files);
  put('next', post.next);
  if (post.tags.length) put('tags', post.tags);
  put('replyTo', post.replyTo);
  put('createdAt', post.createdAt);
  put('updatedAt', post.updatedAt);
  front.push('---');

  return `${front.join('\n')}\n\n# ${post.title}\n\n${post.body.replace(/\s+$/, '')}\n`;
}

function sendMarkdown(res: ServerResponse, post: Post): void {
  const body = Buffer.from(toMarkdownFile(post), 'utf8');
  res.writeHead(200, {
    'content-type': 'text/markdown; charset=utf-8',
    'content-length': String(body.byteLength),
    // 헤더 값은 ByteString 이라 한글 제목을 넣으면 클라이언트가 터진다 → 파일명은 ASCII 로만.
    'content-disposition': `inline; filename="board-${post.seq}-${post.id}.md"`,
    'cache-control': 'no-store',
  });
  res.end(body);
}

/**
 * HTTP 헤더 값은 ByteString 이라 한글 토큰을 쓰면 클라이언트가 헤더를 만드는 순간
 * 터진다(원인을 알기 어려운 TypeError). 서버를 켜는 자리에서 먼저 막는다.
 */
export function isUsableToken(token: string): boolean {
  return /^[\x21-\x7e]+$/.test(token);
}

export interface ServerOptions {
  store: BoardStore;
  webDir: string;
  token?: string;
}

function serveStatic(res: ServerResponse, webDir: string, pathname: string): void {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    sendError(res, 400, '경로를 해석할 수 없습니다');
    return;
  }

  // `..%2f` 처럼 디코딩한 뒤에야 드러나는 경로 조작을 먼저 잡는다.
  // normalize 가 루트에서 `..` 를 지워버리므로, 그 전에 봐야 404 가 아니라 403 을 준다.
  if (decoded.split(/[/\\]/).includes('..')) {
    sendError(res, 403, '허용되지 않는 경로입니다');
    return;
  }

  const relative = normalize(decoded === '/' ? '/index.html' : decoded).replace(/^[/\\]+/, '');
  const root = resolve(webDir);
  const target = resolve(join(root, relative));

  // 그물 하나 더 — 어떤 경로로든 web/ 밖으로 나가면 막는다.
  if (target !== root && !target.startsWith(root + sep)) {
    sendError(res, 403, '허용되지 않는 경로입니다');
    return;
  }
  if (!existsSync(target) || !statSync(target).isFile()) {
    sendError(res, 404, '파일이 없습니다');
    return;
  }

  const body = readFileSync(target);
  res.writeHead(200, {
    'content-type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
    'content-length': String(body.byteLength),
    'cache-control': 'no-store',
  });
  res.end(body);
}

export function createServer(options: ServerOptions): Server {
  const { store, webDir, token } = options;

  return createHttpServer((req, res) => {
    void handle(req, res).catch((err) => {
      if (err instanceof BoardError) sendError(res, err.status, err.message);
      else sendError(res, 500, err instanceof Error ? err.message : '서버 오류');
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = url.pathname;
    const method = req.method ?? 'GET';

    // health 는 토큰 없이 열린다. 클라이언트가 토큰이 필요한지 미리 알 수 있어야 하니까.
    if (pathname === '/api/health') {
      if (method !== 'GET') return sendError(res, 405, 'GET 만 허용합니다');
      return sendJson(res, 200, {
        ok: true,
        posts: store.count,
        // 에이전트가 health 한 번으로 작업 판을 볼 수 있게 한다.
        tasks: store.taskCounts(),
        cursor: store.cursor,
        auth: Boolean(token),
      });
    }

    if (pathname.startsWith('/api/')) {
      if (token && req.headers['x-board-token'] !== token) {
        return sendError(res, 401, 'x-board-token 헤더가 필요합니다');
      }
    }

    if (pathname === '/api/posts') {
      if (method === 'POST') {
        const body = await readJsonBody(req);
        const post = store.create(body);
        return sendJson(res, 201, { post });
      }
      if (method === 'GET') return sendJson(res, 200, store.list(listQuery(url)));
      return sendError(res, 405, 'GET 또는 POST 만 허용합니다');
    }

    // 과거 작업을 찾아 이어하기 위한 검색. 등록순이 아니라 관련도 순으로 준다.
    if (pathname === '/api/search') {
      if (method !== 'GET') return sendError(res, 405, 'GET 만 허용합니다');
      const q = url.searchParams.get('q');
      if (!q || !q.trim()) return sendError(res, 400, '검색어(q)가 필요합니다');
      return sendJson(res, 200, store.search({ ...listQuery(url), q }));
    }

    // 작업(status 가 붙은 글)만 본다. 에이전트가 제일 자주 부르는 경로다.
    if (pathname === '/api/tasks') {
      if (method !== 'GET') return sendError(res, 405, 'GET 만 허용합니다');
      const result = store.list({ ...listQuery(url), tasksOnly: true });
      return sendJson(res, 200, { tasks: result.posts, deleted: result.deleted, cursor: result.cursor });
    }

    if (pathname.startsWith('/api/posts/')) {
      const raw = decodeURIComponent(pathname.slice('/api/posts/'.length));
      // 글 id 에는 점이 없다(`<시각>-<seq>-<랜덤>`) → `.md` 꼬리는 헷갈릴 일이 없다.
      const wantsMarkdown = raw.endsWith('.md');
      const id = wantsMarkdown ? raw.slice(0, -'.md'.length) : raw;
      if (!id) return sendError(res, 404, '글 id 가 필요합니다');
      if (wantsMarkdown) {
        if (method !== 'GET') return sendError(res, 405, 'GET 만 허용합니다');
        return sendMarkdown(res, store.get(id).post);
      }
      if (method === 'GET') return sendJson(res, 200, store.get(id));
      if (method === 'PATCH') {
        const body = await readJsonBody(req);
        return sendJson(res, 200, { post: store.update(id, body) });
      }
      if (method === 'DELETE') {
        const removed = store.remove(id);
        if (removed === 0) return sendError(res, 404, `글이 없습니다: ${id}`);
        return sendJson(res, 200, { removed });
      }
      return sendError(res, 405, 'GET·PATCH·DELETE 만 허용합니다');
    }

    if (pathname === '/api/topics') {
      if (method !== 'GET') return sendError(res, 405, 'GET 만 허용합니다');
      return sendJson(res, 200, { topics: store.topics(), cursor: store.cursor });
    }

    if (pathname.startsWith('/api/')) return sendError(res, 404, '없는 API 입니다');

    if (method !== 'GET' && method !== 'HEAD') return sendError(res, 405, 'GET 만 허용합니다');
    return serveStatic(res, webDir, pathname);
  }
}
