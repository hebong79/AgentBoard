import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BoardStore } from '../src/store.ts';
import { createServer, isUsableToken } from '../src/server.ts';

const webDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const TOKEN = 'board-secret-1234';
const cleanups: Array<() => void> = [];

interface Harness {
  base: string;
  file: string;
  store: BoardStore;
  request: (path: string, init?: RequestInit) => Promise<{ status: number; body: any; text: string }>;
}

async function startBoard(token?: string): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'board-server-'));
  const file = join(dir, 'board.db');
  const store = new BoardStore(file);
  const server = createServer({ store, webDir, token });

  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;

  cleanups.push(() => {
    server.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const request = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (token && !headers.has('x-board-token')) headers.set('x-board-token', token);
    if (init.body && !headers.has('content-type')) {
      headers.set('content-type', 'application/json; charset=utf-8');
    }
    const res = await fetch(`${base}${path}`, { ...init, headers });
    const text = await res.text();
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { status: res.status, body, text };
  };

  return { base, file, store, request };
}

function post(fields: Record<string, unknown>): RequestInit {
  return { method: 'POST', body: JSON.stringify(fields) };
}

function patch(fields: Record<string, unknown>): RequestInit {
  return { method: 'PATCH', body: JSON.stringify(fields) };
}

after(() => {
  for (const cleanup of cleanups) cleanup();
});

describe('board server', () => {
  it('health 는 토큰 없이 열리고 인증 여부와 작업 현황을 알려준다', async () => {
    const open = await startBoard();
    const guarded = await startBoard(TOKEN);

    await open.request('/api/posts', post({ author: 'claude@a', title: '작업', body: '본문', status: 'doing' }));

    const a = await fetch(`${open.base}/api/health`).then((r) => r.json());
    assert.equal(a.ok, true);
    assert.equal(a.auth, false);
    assert.equal(a.posts, 1);
    assert.deepEqual(a.tasks, { todo: 0, doing: 1, done: 0, blocked: 0 }, '한 번의 호출로 판을 볼 수 있어야 한다');

    const b = await fetch(`${guarded.base}/api/health`);
    assert.equal(b.status, 200);
    const health = await b.json();
    assert.equal(health.auth, true, '토큰이 필요한지 미리 알 수 있어야 한다');
    assert.equal(health.token, undefined, '토큰 값 자체는 알려주지 않는다');
  });

  it('토큰이 없거나 틀리면 401', async () => {
    const board = await startBoard(TOKEN);

    assert.equal((await fetch(`${board.base}/api/posts`)).status, 401);
    assert.equal(
      (await fetch(`${board.base}/api/posts`, { headers: { 'x-board-token': 'wrong' } })).status,
      401,
    );
    assert.equal(
      (await fetch(`${board.base}/api/posts`, { headers: { 'x-board-token': TOKEN } })).status,
      200,
    );
  });

  it('토큰은 ASCII 여야 한다 — 한글 토큰은 헤더에 실리지 않는다', () => {
    assert.equal(isUsableToken('board-secret-1234'), true);
    assert.equal(isUsableToken('비밀토큰'), false, '한글 토큰은 클라이언트가 헤더를 만들 때 터진다');
    assert.equal(isUsableToken('띄어 쓰기'), false);
    assert.equal(isUsableToken(''), false);
    assert.throws(() => new Headers({ 'x-board-token': '비밀토큰' }));
  });

  it('글을 올리면 201 이고 다시 조회된다', async () => {
    const board = await startBoard();
    const created = await board.request(
      '/api/posts',
      post({ topic: '작업공유', author: 'claude@main-pc', title: '제목', body: '내용', tags: ['공지'] }),
    );

    assert.equal(created.status, 201);
    assert.equal(created.body.post.seq, 1);
    assert.equal(created.body.post.topic, '작업공유');

    const fetched = await board.request(`/api/posts/${created.body.post.id}`);
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.post.title, '제목');
    assert.deepEqual(fetched.body.replies, []);
    assert.equal(fetched.body.history.length, 1, '생성 기록이 남는다');
  });

  it('한글 본문이 왕복해도 무손실이고 디스크에도 그대로 들어간다', async () => {
    const board = await startBoard();
    const body = '한글 본문 왕복 시험\n둘째 줄 — 특수문자 「」 ★ 😀';

    const created = await board.request('/api/posts', post({ author: '클로드@메인', title: '한글 제목', body }));
    assert.equal(created.status, 201);
    assert.equal(created.body.post.body, body);

    const fetched = await board.request(`/api/posts/${created.body.post.id}`);
    assert.equal(fetched.body.post.body, body);
    assert.equal(fetched.body.post.author, '클로드@메인');

    // 별도 연결로 파일을 다시 열어 확인한다 (WAL 이라 동시 읽기가 된다)
    const reader = new BoardStore(board.file);
    assert.equal(reader.get(created.body.post.id).post.body, body, 'DB 에도 깨지지 않고 들어가야 한다');
    reader.close();
  });

  it('본문에 U+FFFD 가 섞이면 400 으로 거절한다', async () => {
    const board = await startBoard();
    const created = await board.request(
      '/api/posts',
      post({ author: 'claude@a', title: '제목', body: '깨진 �� 본문' }),
    );

    assert.equal(created.status, 400);
    assert.equal((await board.request('/api/posts')).body.posts.length, 0, '깨진 글이 남으면 안 된다');
  });

  it('답글이 부모 글 조회에 함께 나온다', async () => {
    const board = await startBoard();
    const root = await board.request('/api/posts', post({ author: 'claude@a', title: '뿌리', body: '본문' }));
    const rootId = root.body.post.id;

    const reply = await board.request(
      '/api/posts',
      post({ author: 'claude@dev-2', title: '답글', body: '다른 PC 에서 씀', replyTo: rootId }),
    );
    assert.equal(reply.status, 201);

    const view = await board.request(`/api/posts/${rootId}`);
    assert.equal(view.body.replies.length, 1);
    assert.equal(view.body.replies[0].author, 'claude@dev-2');

    const orphan = await board.request(
      '/api/posts',
      post({ author: 'claude@a', title: '답글', body: '본문', replyTo: '없는id' }),
    );
    assert.equal(orphan.status, 404);
  });

  it('since 폴링은 새 글만 오래된 순으로 준다', async () => {
    const board = await startBoard();
    for (let i = 1; i <= 3; i += 1) {
      await board.request('/api/posts', post({ author: 'claude@a', title: `글${i}`, body: '본문' }));
    }

    const first = await board.request('/api/posts?since=0&limit=2');
    assert.deepEqual(first.body.posts.map((p: any) => p.seq), [1, 2]);
    assert.equal(first.body.cursor, 3);

    const next = await board.request('/api/posts?since=2');
    assert.deepEqual(next.body.posts.map((p: any) => p.seq), [3]);

    const empty = await board.request('/api/posts?since=3');
    assert.equal(empty.body.posts.length, 0);
    assert.equal(empty.body.cursor, 3);
  });

  it('필터에 걸린 글이 있어도 cursor 는 서버 전체 최신값을 유지한다', async () => {
    const board = await startBoard();
    await board.request('/api/posts', post({ topic: '내게시판', author: 'claude@a', title: 'a', body: '본문' }));
    await board.request('/api/posts', post({ topic: '남의게시판', author: 'claude@b', title: 'b', body: '본문' }));
    await board.request('/api/posts', post({ topic: '남의게시판', author: 'claude@b', title: 'c', body: '본문' }));

    const mine = await board.request('/api/posts?topic=내게시판');
    assert.equal(mine.body.posts.length, 1);
    assert.equal(mine.body.cursor, 3, '커서가 멈추면 폴링이 같은 구간을 다시 훑는다');
  });

  it('topic·author·q 필터가 HTTP 로도 동작한다', async () => {
    const board = await startBoard();
    await board.request('/api/posts', post({ topic: '작업공유', author: 'claude@a', title: '리팩터링', body: '스토어 정리' }));
    await board.request('/api/posts', post({ topic: '잡담', author: 'claude@b', title: '점심', body: '리팩터링 얘기' }));

    assert.equal((await board.request('/api/posts?topic=작업공유')).body.posts.length, 1);
    assert.equal((await board.request('/api/posts?author=claude@b')).body.posts.length, 1);
    assert.equal((await board.request('/api/posts?q=리팩터링')).body.posts.length, 2);
    assert.equal((await board.request('/api/posts?q=없는말')).body.posts.length, 0);
  });

  it('topics 는 게시판 목록과 글 수를 준다', async () => {
    const board = await startBoard();
    await board.request('/api/posts', post({ topic: '작업공유', author: 'claude@a', title: 'a', body: '본문' }));
    await board.request('/api/posts', post({ topic: '잡담', author: 'claude@a', title: 'b', body: '본문' }));
    await board.request('/api/posts', post({ topic: '작업공유', author: 'claude@a', title: 'c', body: '본문' }));

    const res = await board.request('/api/topics');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.topics.map((t: any) => t.topic), ['작업공유', '잡담']);
    assert.equal(res.body.topics[0].posts, 2);
  });

  it('삭제는 답글을 동반하고, 다시 지우면 404', async () => {
    const board = await startBoard();
    const root = await board.request('/api/posts', post({ author: 'claude@a', title: '뿌리', body: '본문' }));
    const rootId = root.body.post.id;
    await board.request('/api/posts', post({ author: 'claude@b', title: '답글', body: '본문', replyTo: rootId }));

    const removed = await board.request(`/api/posts/${rootId}`, { method: 'DELETE' });
    assert.equal(removed.status, 200);
    assert.equal(removed.body.removed, 2);

    assert.equal((await board.request(`/api/posts/${rootId}`, { method: 'DELETE' })).status, 404);
    assert.equal((await board.request(`/api/posts/${rootId}`)).status, 404);
    assert.equal((await board.request('/api/posts')).body.posts.length, 0);
  });

  it('400 / 404 / 405 상태코드를 구분한다', async () => {
    const board = await startBoard();

    assert.equal((await board.request('/api/posts', { method: 'POST', body: '{이건 JSON 이 아님' })).status, 400);
    assert.equal((await board.request('/api/posts?limit=-3')).status, 400);
    assert.equal((await board.request('/api/없는것')).status, 404);
    assert.equal((await board.request('/api/posts/없는id')).status, 404);
    assert.equal((await board.request('/api/posts', { method: 'PUT', body: '{}' })).status, 405);
    assert.equal((await board.request('/api/topics', { method: 'DELETE' })).status, 405);
    assert.equal((await board.request('/api/tasks', { method: 'POST', body: '{}' })).status, 405);
  });

  it('웹 화면은 200 이고, ..%2f 경로 조작은 403', async () => {
    const board = await startBoard();

    const page = await fetch(`${board.base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type') ?? '', /text\/html/);
    assert.match(await page.text(), /클로드 공유 게시판/);

    assert.equal((await fetch(`${board.base}/board.js`)).status, 200);
    assert.equal((await fetch(`${board.base}/board.css`)).status, 200);
    assert.equal((await fetch(`${board.base}/..%2f..%2fpackage.json`)).status, 403);
    assert.equal((await fetch(`${board.base}/없는파일.html`)).status, 404);
  });

  // ── 작업 상태 ──────────────────────────────────────────────────────────

  it('PATCH 로 상태를 갱신하면 폴링하는 다른 에이전트에게 전달된다', async () => {
    const board = await startBoard();
    const created = await board.request(
      '/api/posts',
      post({
        topic: '작업공유', author: 'claude@dev-2', title: 'CCTV 좌표 버그', body: '회전각 단위 혼용',
        status: '진행중', assignee: 'claude@dev-2', repo: 'baroCCTVSimulator',
        files: ['src/camera.ts'], next: '단위 통일',
      }),
    );
    assert.equal(created.status, 201);
    assert.equal(created.body.post.status, 'doing', '한글 상태가 ASCII 정본으로 정규화된다');

    const id = created.body.post.id;
    // 다른 에이전트가 여기까지 받아 갔다
    const cursorBefore = created.body.post.updatedSeq;
    assert.equal((await board.request(`/api/posts?since=${cursorBefore}`)).body.posts.length, 0);

    const updated = await board.request(`/api/posts/${id}`, patch({ status: '완료', next: null, by: 'claude@dev-2' }));
    assert.equal(updated.status, 200);
    assert.equal(updated.body.post.status, 'done');
    assert.equal(updated.body.post.next, null);
    assert.equal(updated.body.post.seq, 1, 'seq 는 그대로');
    assert.ok(updated.body.post.updatedSeq > cursorBefore, 'updatedSeq 는 올라간다');

    const polled = await board.request(`/api/posts?since=${cursorBefore}`);
    assert.equal(polled.body.posts.length, 1, '상태 변화가 폴링으로 전달돼야 한다');
    assert.equal(polled.body.posts[0].status, 'done');

    const history = (await board.request(`/api/posts/${id}`)).body.history;
    assert.deepEqual(history.map((h: any) => h.kind), ['created', 'updated']);
    assert.equal(history[1].by, 'claude@dev-2');
  });

  it('GET /api/tasks 는 작업만 주고 status·assignee·repo 로 걸러진다', async () => {
    const board = await startBoard();
    await board.request('/api/posts', post({ author: 'claude@a', title: '그냥 공지', body: '본문' }));
    await board.request('/api/posts', post({ author: 'claude@a', title: '작업1', body: '본문', status: 'doing', assignee: 'claude@a', repo: 'baroQuantum' }));
    await board.request('/api/posts', post({ author: 'claude@b', title: '작업2', body: '본문', status: 'todo', assignee: 'claude@b', repo: 'baroQuantum' }));
    await board.request('/api/posts', post({ author: 'claude@b', title: '작업3', body: '본문', status: 'blocked', repo: 'baro_calory' }));

    const all = await board.request('/api/tasks');
    assert.equal(all.status, 200);
    assert.equal(all.body.tasks.length, 3, '그냥 글은 빠진다');
    assert.equal(all.body.cursor, 4);

    assert.equal((await board.request('/api/tasks?status=doing')).body.tasks.length, 1);
    assert.equal((await board.request('/api/tasks?status=blocked')).body.tasks.length, 1);
    assert.equal((await board.request('/api/tasks?assignee=claude@b')).body.tasks.length, 1);
    assert.equal((await board.request('/api/tasks?repo=baroQuantum')).body.tasks.length, 2);
    // 상태 필터는 ASCII 라 URL 인코딩 없이도 안전하다
    assert.equal((await board.request('/api/tasks?status=todo&repo=baroQuantum')).body.tasks.length, 1);
  });

  it('잘못된 상태 갱신은 400, 없는 글이면 404', async () => {
    const board = await startBoard();
    const created = await board.request('/api/posts', post({ author: 'claude@a', title: '작업', body: '본문', status: 'todo' }));
    const id = created.body.post.id;

    assert.equal((await board.request(`/api/posts/${id}`, patch({ status: '아무거나' }))).status, 400);
    assert.equal((await board.request(`/api/posts/${id}`, patch({}))).status, 400, '바꿀 항목이 없으면 400');
    assert.equal((await board.request('/api/posts/없는id', patch({ status: 'done' }))).status, 404);

    // 제목·본문은 갱신 대상이 아니다
    const attempted = await board.request(`/api/posts/${id}`, patch({ status: 'doing', title: '바꾼 제목' }));
    assert.equal(attempted.status, 200);
    assert.equal(attempted.body.post.title, '작업', '사실 기록은 그대로 남는다');
  });

  it('GET /api/search 는 관련도 순으로 주고 발췌를 붙인다', async () => {
    const board = await startBoard();
    await board.request('/api/posts', post({
      author: 'claude@dev-2', title: 'CCTV 좌표 버그', status: 'done',
      body: '회전각 계산에서 라디안/도 단위가 섞였다. 좌표계 변환을 경계에서만 하도록 고쳤다.',
      repo: 'baroCCTVSimulator', files: ['src/camera.ts'],
    }));
    await board.request('/api/posts', post({
      author: 'claude@a', title: '잡담', body: '좌표 얘기를 잠깐 했다',
    }));

    const res = await board.request('/api/search?q=%EC%A2%8C%ED%91%9C'); // q=좌표
    assert.equal(res.status, 200);
    assert.equal(res.body.results.length, 2);
    assert.equal(res.body.results[0].title, 'CCTV 좌표 버그', '제목에서 맞은 것이 위');
    assert.ok(res.body.results[0].score > res.body.results[1].score);
    assert.match(res.body.results[0].snippet, /좌표/);

    // 낱말 순서를 바꿔도 같은 결과
    const a = await board.request('/api/search?q=' + encodeURIComponent('좌표 버그'));
    const b = await board.request('/api/search?q=' + encodeURIComponent('버그 좌표'));
    assert.deepEqual(
      a.body.results.map((r: any) => r.id),
      b.body.results.map((r: any) => r.id),
    );

    assert.equal((await board.request('/api/search')).status, 400, '검색어가 없으면 400');
    assert.equal((await board.request('/api/search?q=%20')).status, 400);
    assert.equal((await board.request('/api/search?q=x', { method: 'POST', body: '{}' })).status, 405);
  });

  it('file 필터로 그 파일을 건드린 과거 작업을 찾는다', async () => {
    const board = await startBoard();
    await board.request('/api/posts', post({
      author: 'claude@dev-2', title: '좌표 버그', body: '본문', status: 'done',
      repo: 'baroCCTVSimulator', files: ['src/camera.ts', 'src/view.ts'],
    }));
    await board.request('/api/posts', post({
      author: 'claude@dev-3', title: '합산 정리', body: '본문', status: 'done', files: ['src/sum.ts'],
    }));

    assert.equal((await board.request('/api/posts?file=src/camera.ts')).body.posts.length, 1);
    assert.equal((await board.request('/api/posts?file=camera')).body.posts.length, 1, '파일 이름만으로도');
    assert.equal((await board.request('/api/tasks?file=src/sum.ts')).body.tasks.length, 1);
    assert.equal((await board.request('/api/posts?file=nope.ts')).body.posts.length, 0);
  });

  it('삭제도 폴링으로 전파된다', async () => {
    const board = await startBoard();
    const a = await board.request('/api/posts', post({ author: 'claude@a', title: 'a', body: '본문' }));
    await board.request('/api/posts', post({ author: 'claude@a', title: 'b', body: '본문' }));

    await board.request(`/api/posts/${a.body.post.id}`, { method: 'DELETE' });

    const polled = await board.request('/api/posts?since=2');
    assert.deepEqual(polled.body.deleted, [a.body.post.id], '지워진 글을 알 수 있어야 한다');
    assert.equal(polled.body.posts.length, 0);

    const browsing = await board.request('/api/posts');
    assert.deepEqual(browsing.body.deleted, [], '둘러보기에는 묘비를 섞지 않는다');
  });
});

describe('마크다운 (.md)', () => {
  const BODY = [
    '## 무엇을 했나',
    '',
    '- 원인: 라디안/도 단위가 섞임',
    '- 고친 곳: `src/camera.ts`',
  ].join('\n');

  it('글을 .md 파일로 내려준다 — 앞머리에 작업 필드가 실린다', async () => {
    const board = await startBoard();
    const created = await board.request('/api/posts', post({
      topic: '작업공유',
      author: 'claude@dev-2',
      title: 'CCTV 좌표 버그: 단위 통일',
      body: BODY,
      status: 'doing',
      assignee: 'claude@dev-2',
      repo: 'baroCCTVSimulator',
      files: ['src/camera.ts'],
      next: '테스트 6개 추가',
      tags: ['버그'],
    }));

    const res = await fetch(`${board.base}/api/posts/${created.body.post.id}.md`);
    const text = await res.text();

    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /^text\/markdown; charset=utf-8$/);
    assert.match(res.headers.get('content-disposition') ?? '', /\.md"$/);

    // 앞머리 → 제목 → 본문 순서. 값은 JSON 인용이라 콜론이 들어가도 YAML 로 읽힌다.
    assert.match(text, /^---\n/);
    assert.match(text, /\ntitle: "CCTV 좌표 버그: 단위 통일"\n/);
    assert.match(text, /\nstatus: "doing"\n/);
    assert.match(text, /\nfiles: \["src\/camera\.ts"\]\n/);
    assert.match(text, /\n---\n\n# CCTV 좌표 버그: 단위 통일\n\n## 무엇을 했나\n/);
    assert.ok(text.endsWith('- 고친 곳: `src/camera.ts`\n'), '본문이 그대로 끝에 붙는다');
  });

  it('작업이 아닌 글에는 상태 칸이 아예 없다', async () => {
    const board = await startBoard();
    const created = await board.request('/api/posts', post({
      author: 'claude@dev-2', title: '공지', body: '본문입니다',
    }));

    const text = await (await fetch(`${board.base}/api/posts/${created.body.post.id}.md`)).text();
    assert.doesNotMatch(text, /status:/);
    assert.doesNotMatch(text, /files:/);
    assert.match(text, /\nauthor: "claude@dev-2"\n/);
  });

  it('없는 글은 404, GET 이 아니면 405', async () => {
    const board = await startBoard();
    assert.equal((await board.request('/api/posts/없는id.md')).status, 404);
    assert.equal((await board.request('/api/posts/없는id.md', { method: 'DELETE' })).status, 405);
  });

  it('토큰이 걸린 게시판에서는 .md 도 토큰을 요구한다', async () => {
    const board = await startBoard(TOKEN);
    const created = await board.request('/api/posts', post({
      author: 'claude@a', title: '제목', body: '본문',
    }));

    const open = await fetch(`${board.base}/api/posts/${created.body.post.id}.md`);
    assert.equal(open.status, 401);
    assert.equal((await board.request(`/api/posts/${created.body.post.id}.md`)).status, 200);
  });

  it('웹 화면이 마크다운 렌더러를 받아 갈 수 있다', async () => {
    const board = await startBoard();
    const res = await fetch(`${board.base}/markdown.js`);
    assert.equal(res.status, 200, 'board.js 가 import 하므로 없으면 화면이 통째로 멈춘다');
    assert.match(res.headers.get('content-type') ?? '', /javascript/);
  });
});
