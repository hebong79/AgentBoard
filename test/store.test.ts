import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BoardError, BoardStore } from '../src/store.ts';

const roots: string[] = [];

function freshDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

function freshStore(): BoardStore {
  return new BoardStore(join(freshDir('board-store-'), 'board.db'));
}

function seed(store: BoardStore, count: number): void {
  for (let i = 1; i <= count; i += 1) {
    store.create({ author: 'claude@a', title: `제목 ${i}`, body: `본문 ${i}` });
  }
}

after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

describe('BoardStore', () => {
  it('seq 는 1부터 단조 증가하고 커서가 따라온다', () => {
    const store = freshStore();
    const a = store.create({ author: 'claude@a', title: '첫 글', body: '본문' });
    const b = store.create({ author: 'claude@b', title: '둘째 글', body: '본문' });

    assert.equal(a.seq, 1);
    assert.equal(b.seq, 2);
    assert.equal(a.updatedSeq, 1, '만들 때는 updatedSeq 가 seq 와 같다');
    assert.equal(store.cursor, 2);
    assert.notEqual(a.id, b.id);
  });

  it('topic 기본값은 general 이고 태그 중복은 제거된다', () => {
    const store = freshStore();
    const post = store.create({
      author: 'claude@a',
      title: '제목',
      body: '본문',
      tags: ['공지', '공지', '질문'],
    });

    assert.equal(post.topic, 'general');
    assert.deepEqual(post.tags, ['공지', '질문']);
    assert.equal(post.replyTo, null);
    assert.equal(post.status, null, 'status 가 없으면 작업이 아니라 그냥 글이다');
  });

  it('필수 항목이 빠지면 400, 없는 글에 답글이면 404', () => {
    const store = freshStore();

    assert.throws(
      () => store.create({ author: 'claude@a', body: '본문' }),
      (err: unknown) => err instanceof BoardError && err.status === 400,
    );
    assert.throws(
      () => store.create({ author: 'claude@a', title: '제목', body: '   ' }),
      (err: unknown) => err instanceof BoardError && err.status === 400,
    );
    assert.throws(
      () => store.create({ author: 'claude@a', title: '제목', body: '본문', replyTo: '없는id' }),
      (err: unknown) => err instanceof BoardError && err.status === 404,
    );
  });

  it('인코딩이 깨진(U+FFFD) 본문은 거절한다', () => {
    const store = freshStore();

    assert.throws(
      () => store.create({ author: 'claude@a', title: '제목', body: '깨진 �� 본문' }),
      (err: unknown) => err instanceof BoardError && err.status === 400,
    );
    assert.equal(store.count, 0);
  });

  it('topic·author·tag·q 로 걸러낸다', () => {
    const store = freshStore();
    store.create({ topic: '작업공유', author: 'claude@a', title: '리팩터링', body: '스토어 정리', tags: ['공지'] });
    store.create({ topic: '작업공유', author: 'claude@b', title: '테스트', body: '커버리지 확대', tags: ['질문'] });
    store.create({ topic: '잡담', author: 'claude@a', title: '점심', body: '리팩터링 얘기' });

    assert.equal(store.list({ topic: '작업공유' }).posts.length, 2);
    assert.equal(store.list({ author: 'claude@a' }).posts.length, 2);
    assert.equal(store.list({ tag: '질문' }).posts.length, 1);
    assert.equal(store.list({ tag: '질' }).posts.length, 0, '태그는 부분일치가 아니라 정확히 맞아야 한다');
    assert.equal(store.list({ q: '리팩터링' }).posts.length, 2);
    assert.equal(store.list({ topic: '작업공유', author: 'claude@a' }).posts.length, 1);
  });

  it('since 는 그 번호를 넘는 글만 오래된 순으로 준다', () => {
    const store = freshStore();
    seed(store, 5);

    const result = store.list({ since: 3 });
    assert.deepEqual(result.posts.map((p) => p.seq), [4, 5]);
    assert.equal(result.cursor, 5);
    assert.equal(store.list({ since: 5 }).posts.length, 0);
  });

  it('limit 은 폴링이면 오래된 쪽에서, 둘러보기면 최신 쪽에서 자른다', () => {
    const store = freshStore();
    seed(store, 7);

    assert.deepEqual(store.list({ since: 0, limit: 3 }).posts.map((p) => p.seq), [1, 2, 3]);
    assert.deepEqual(store.list({ limit: 3 }).posts.map((p) => p.seq), [5, 6, 7]);
  });

  it('limit 으로 나눠 폴링해도 1~7 이 빠짐없이 도착한다', () => {
    const store = freshStore();
    seed(store, 7);

    const received: number[] = [];
    let since = 0;
    for (let guard = 0; guard < 10; guard += 1) {
      const page = store.list({ since, limit: 3 });
      if (page.posts.length === 0) break;
      for (const post of page.posts) received.push(post.seq);
      since = page.posts[page.posts.length - 1]!.updatedSeq;
    }

    assert.deepEqual(received, [1, 2, 3, 4, 5, 6, 7]);
  });

  it('글을 지우면 답글도 함께 지워지고, 두 번째 삭제는 0 이다', () => {
    const store = freshStore();
    const root = store.create({ author: 'claude@a', title: '뿌리', body: '본문' });
    store.create({ author: 'claude@b', title: '답글1', body: '본문', replyTo: root.id });
    store.create({ author: 'claude@c', title: '답글2', body: '본문', replyTo: root.id });
    const other = store.create({ author: 'claude@a', title: '남을 글', body: '본문' });

    assert.equal(store.remove(root.id), 3);
    assert.equal(store.remove(root.id), 0);
    assert.equal(store.count, 1);
    assert.equal(store.list().posts[0]!.id, other.id);
    assert.throws(
      () => store.get(root.id),
      (err: unknown) => err instanceof BoardError && err.status === 404,
    );
  });

  it('get 은 답글을 seq 순으로 함께 준다', () => {
    const store = freshStore();
    const root = store.create({ author: 'claude@a', title: '뿌리', body: '본문' });
    const r1 = store.create({ author: 'claude@b', title: '답글1', body: '본문', replyTo: root.id });
    const r2 = store.create({ author: 'claude@c', title: '답글2', body: '본문', replyTo: root.id });

    const view = store.get(root.id);
    assert.equal(view.post.id, root.id);
    assert.deepEqual(view.replies.map((p) => p.id), [r1.id, r2.id]);
  });

  it('topics 는 마지막 활동이 최신인 순으로, 글 수와 함께 준다', () => {
    const store = freshStore();
    store.create({ topic: '작업공유', author: 'claude@a', title: 'a', body: '본문' });
    store.create({ topic: '잡담', author: 'claude@a', title: 'b', body: '본문' });
    store.create({ topic: '작업공유', author: 'claude@a', title: 'c', body: '본문' });

    const topics = store.topics();
    assert.deepEqual(topics.map((t) => t.topic), ['작업공유', '잡담']);
    assert.equal(topics[0]!.posts, 2);
    assert.equal(topics[0]!.lastSeq, 3);
    assert.equal(topics[1]!.posts, 1);
  });

  it('재기동하면 글과 커서가 복원되고, 지운 글의 번호는 재사용하지 않는다', () => {
    const file = join(freshDir('board-restart-'), 'board.db');

    const first = new BoardStore(file);
    first.create({ author: 'claude@a', title: '남을 글', body: '본문' });
    const doomed = first.create({ author: 'claude@a', title: '지울 글', body: '본문' });
    first.remove(doomed.id); // seq 3 을 소비한다
    first.close();

    const second = new BoardStore(file);
    assert.equal(second.count, 1);
    assert.equal(second.cursor, 3, '삭제로 올라간 커서까지 복원돼야 한다');

    const next = second.create({ author: 'claude@a', title: '새 글', body: '본문' });
    assert.equal(next.seq, 4, '이미 쓴 번호를 다시 쓰면 폴링이 글을 건너뛴다');
    second.close();
  });

  // ── 작업 상태 ──────────────────────────────────────────────────────────

  it('작업 필드를 붙여 만들 수 있고, 한글 상태는 ASCII 정본으로 바뀐다', () => {
    const store = freshStore();
    const task = store.create({
      topic: '작업공유',
      author: 'claude@dev-2',
      title: 'CCTV 좌표 버그',
      body: '회전각 단위가 섞여 있음',
      status: '진행중',
      assignee: 'claude@dev-2',
      repo: 'baroCCTVSimulator',
      files: ['src/camera.ts', 'src/camera.ts'],
      next: '단위 통일 후 테스트',
    });

    assert.equal(task.status, 'doing', '한글 별칭이 ASCII 정본으로 정규화돼야 한다');
    assert.equal(task.assignee, 'claude@dev-2');
    assert.equal(task.repo, 'baroCCTVSimulator');
    assert.deepEqual(task.files, ['src/camera.ts'], 'files 도 중복 제거');
    assert.equal(task.next, '단위 통일 후 테스트');

    assert.throws(
      () => store.create({ author: 'a', title: 't', body: 'b', status: '아무거나' }),
      (err: unknown) => err instanceof BoardError && err.status === 400,
    );
  });

  it('상태를 갱신하면 updatedSeq 가 올라 폴링에 다시 실린다', () => {
    const store = freshStore();
    const task = store.create({ author: 'claude@a', title: '작업', body: '본문', status: 'todo' });
    store.create({ author: 'claude@a', title: '다른 글', body: '본문' });

    // 이미 seq 2 까지 받아 간 에이전트에게는 새 글이 없다
    assert.equal(store.list({ since: 2 }).posts.length, 0);

    const updated = store.update(task.id, { status: '완료', by: 'claude@b' });
    assert.equal(updated.status, 'done');
    assert.equal(updated.seq, 1, 'seq(만들어진 순서)는 그대로다');
    assert.equal(updated.updatedSeq, 3, 'updatedSeq 는 새 번호를 받는다');

    const polled = store.list({ since: 2 });
    assert.equal(polled.posts.length, 1, '상태가 바뀐 작업이 폴링으로 전달돼야 한다');
    assert.equal(polled.posts[0]!.status, 'done');
    assert.equal(polled.cursor, 3);
  });

  it('갱신은 작업 상태만 건드리고 제목·본문은 못 바꾼다', () => {
    const store = freshStore();
    const task = store.create({ author: 'claude@a', title: '원래 제목', body: '원래 본문', status: 'todo' });

    const updated = store.update(task.id, {
      status: 'doing',
      assignee: 'claude@b',
      title: '바꾼 제목',
      body: '바꾼 본문',
    } as Record<string, unknown>);

    assert.equal(updated.title, '원래 제목', '사실 기록은 그대로 남고 정정은 답글로 쌓는다');
    assert.equal(updated.body, '원래 본문');
    assert.equal(updated.status, 'doing');
    assert.equal(updated.assignee, 'claude@b');

    assert.throws(
      () => store.update(task.id, {}),
      (err: unknown) => err instanceof BoardError && err.status === 400,
    );
    assert.throws(
      () => store.update('없는id', { status: 'done' }),
      (err: unknown) => err instanceof BoardError && err.status === 404,
    );
  });

  it('null 로 비우는 갱신이 실제로 비운다', () => {
    const store = freshStore();
    const task = store.create({
      author: 'claude@a', title: '작업', body: '본문',
      status: 'doing', assignee: 'claude@a', next: '다음 할 일',
    });

    const cleared = store.update(task.id, { assignee: null, next: null });
    assert.equal(cleared.assignee, null, '담당자를 비울 수 있어야 손을 뗄 수 있다');
    assert.equal(cleared.next, null);
    assert.equal(cleared.status, 'doing', '건드리지 않은 필드는 유지된다');
  });

  it('작업만 골라내고 status·assignee·repo 로 거른다', () => {
    const store = freshStore();
    store.create({ author: 'claude@a', title: '그냥 글', body: '본문' });
    store.create({ author: 'claude@a', title: '작업1', body: '본문', status: 'doing', assignee: 'claude@a', repo: 'baroQuantum' });
    store.create({ author: 'claude@b', title: '작업2', body: '본문', status: 'todo', assignee: 'claude@b', repo: 'baroQuantum' });
    store.create({ author: 'claude@b', title: '작업3', body: '본문', status: 'done', repo: 'baro_calory' });

    assert.equal(store.list({ tasksOnly: true }).posts.length, 3, '그냥 글은 빠져야 한다');
    assert.equal(store.list({ tasksOnly: true, status: '진행중' }).posts.length, 1);
    assert.equal(store.list({ tasksOnly: true, assignee: 'claude@b' }).posts.length, 1);
    assert.equal(store.list({ tasksOnly: true, repo: 'baroQuantum' }).posts.length, 2);
    assert.deepEqual(store.taskCounts(), { todo: 1, doing: 1, done: 1, blocked: 0 });
  });

  it('삭제도 폴링으로 전파된다', () => {
    const store = freshStore();
    const a = store.create({ author: 'claude@a', title: 'a', body: '본문' });
    store.create({ author: 'claude@a', title: 'b', body: '본문' });

    const before = store.list({ since: 0 });
    assert.equal(before.posts.length, 2);
    assert.deepEqual(before.deleted, []);

    store.remove(a.id);

    const after = store.list({ since: 2 });
    assert.deepEqual(after.deleted, [a.id], '이미 받아 간 글이 지워진 것을 알 수 있어야 한다');
    assert.equal(after.posts.length, 0);
    // 둘러보기 응답에는 묘비를 섞지 않는다
    assert.deepEqual(store.list().deleted, []);
  });

  it('history 에 생성·갱신·삭제가 남는다', () => {
    const store = freshStore();
    const task = store.create({ author: 'claude@a', title: '작업', body: '본문', status: 'todo' });
    store.update(task.id, { status: 'doing', by: 'claude@b' });
    store.update(task.id, { status: 'done', by: 'claude@b' });

    const history = store.get(task.id).history;
    assert.deepEqual(history.map((h) => h.kind), ['created', 'updated', 'updated']);
    assert.equal(history[1]!.by, 'claude@b', '누가 바꿨는지 남아야 한다');
    assert.equal((history[2]!.changes as { status: string }).status, 'done');
  });

  // ── 과거 작업 찾기 ────────────────────────────────────────────────────

  function seedHistory(store: BoardStore) {
    store.create({
      topic: '작업공유', author: 'claude@dev-2', title: 'CCTV 좌표 버그', status: 'done',
      body: '회전각 계산에서 라디안/도 단위가 섞였다. 좌표계 변환을 경계에서만 하도록 고쳤다.',
      repo: 'baroCCTVSimulator', files: ['src/camera.ts', 'src/view.ts'], tags: ['버그'],
    });
    store.create({
      topic: '작업공유', author: 'claude@dev-3', title: '칼로리 합산 리팩터링', status: 'done',
      body: '중복 로직 정리. 좌표와는 무관하다.', repo: 'baro_calory', files: ['src/sum.ts'],
    });
    store.create({
      topic: '질문', author: 'claude@a', title: '카메라 각도 기준이 뭔가요',
      body: '센서 기준인지 화면 기준인지 헷갈립니다', repo: 'baroCCTVSimulator',
    });
  }

  it('검색은 낱말 순서와 무관하다', () => {
    const store = freshStore();
    seedHistory(store);

    const forward = store.search({ q: '좌표 버그' }).results.map((r) => r.title);
    const backward = store.search({ q: '버그 좌표' }).results.map((r) => r.title);

    assert.equal(forward[0], 'CCTV 좌표 버그');
    assert.deepEqual(backward, forward, 'LIKE 한 줄로 붙여 찾으면 순서가 바뀔 때 놓친다');
  });

  it('낱말 하나만 맞아도 찾되, 많이 맞은 것이 위로 온다', () => {
    const store = freshStore();
    seedHistory(store);

    // "카메라" 와 "라디안" 은 서로 다른 글에 흩어져 있다. AND 로 묶으면 0건이 되어
    // 관련 이력이 있는데도 못 본 채 시작하게 된다.
    const hits = store.search({ q: '카메라 라디안' }).results;
    assert.equal(hits.length, 2, '놓치는 쪽이 더 나쁘다 — 한 낱말만 맞아도 나와야 한다');

    // 두 낱말이 다 맞으면 점수가 높아 위로 온다
    const both = store.search({ q: '카메라 각도' }).results;
    assert.equal(both[0]!.title, '카메라 각도 기준이 뭔가요');

    // 목록 필터(list)는 반대로 AND 다 — 넓히는 도구가 아니라 좁히는 도구이기 때문
    assert.equal(store.list({ q: '카메라 라디안' }).posts.length, 0);
    assert.equal(store.list({ q: '카메라' }).posts.length, 1);
  });

  it('두 글자 낱말과 조사가 붙은 말도 찾는다', () => {
    const store = freshStore();
    seedHistory(store);

    // 본문에는 "좌표계", "좌표와는" 으로만 나온다 — 단어 경계 토크나이저면 놓치는 자리다
    const hits = store.search({ q: '좌표' }).results;
    assert.equal(hits.length, 2);
    assert.equal(hits[0]!.title, 'CCTV 좌표 버그', '제목에서 맞은 것이 위로 온다');
  });

  it('관련도 순으로 준다 — 제목에서 맞으면 본문보다 위', () => {
    const store = freshStore();
    store.create({ author: 'a', title: '그냥 잡담', body: '리팩터링 얘기를 좀 했다' });
    store.create({ author: 'a', title: '리팩터링 완료', body: '본문에는 다른 말' });

    const hits = store.search({ q: '리팩터링' }).results;
    assert.deepEqual(hits.map((h) => h.title), ['리팩터링 완료', '그냥 잡담']);
    assert.ok(hits[0]!.score > hits[1]!.score);
  });

  it('검색 결과에 본문 발췌가 붙는다', () => {
    const store = freshStore();
    seedHistory(store);

    const hit = store.search({ q: '라디안' }).results[0]!;
    assert.match(hit.snippet, /라디안/, '검색어가 나온 자리를 잘라 줘야 한다');
    assert.ok(hit.snippet.length < 200, '본문 전체를 그대로 주면 발췌가 아니다');
  });

  it('빈 검색어는 400', () => {
    const store = freshStore();
    assert.throws(
      () => store.search({ q: '   ' }),
      (err: unknown) => err instanceof BoardError && err.status === 400,
    );
  });

  it('파일 경로로 그 파일을 건드린 과거 작업을 찾는다', () => {
    const store = freshStore();
    seedHistory(store);

    assert.deepEqual(store.list({ file: 'src/camera.ts' }).posts.map((p) => p.title), ['CCTV 좌표 버그']);
    assert.deepEqual(store.list({ file: 'camera' }).posts.map((p) => p.title), ['CCTV 좌표 버그'], '파일 이름만으로도 찾힌다');
    assert.equal(store.list({ file: 'src/sum.ts' }).posts.length, 1);
    assert.equal(store.list({ file: '없는파일.ts' }).posts.length, 0);
  });

  it('검색에 저장소·상태 필터를 겹쳐 걸 수 있다', () => {
    const store = freshStore();
    seedHistory(store);

    assert.equal(store.search({ q: '기준', repo: 'baroCCTVSimulator' }).results.length, 1);
    assert.equal(store.search({ q: '기준', repo: 'baro_calory' }).results.length, 0);
    assert.equal(store.search({ q: '좌표', status: 'done' }).results.length, 2);
    assert.equal(store.search({ q: '좌표', tasksOnly: true }).results.length, 2, '질문 글은 빠진다');
  });

  it('지운 글은 검색에 안 나온다', () => {
    const store = freshStore();
    seedHistory(store);
    const target = store.search({ q: '칼로리' }).results[0]!;

    store.remove(target.id);
    assert.equal(store.search({ q: '칼로리' }).results.length, 0);
  });

  // ── 마이그레이션 ──────────────────────────────────────────────────────

  it('예전 JSONL 을 SQLite 로 옮기고, 쓰다 만 마지막 줄은 버린다', () => {
    const dir = freshDir('board-migrate-');
    const jsonl = join(dir, 'posts.jsonl');

    const lines = [
      JSON.stringify({ id: 'old-1', seq: 1, topic: '공지', author: 'claude@a', title: '옛 글1', body: '본문', tags: ['공지'], replyTo: null, createdAt: '2026-08-11T00:00:00.000Z' }),
      JSON.stringify({ id: 'old-2', seq: 2, topic: '잡담', author: 'claude@b', title: '옛 글2', body: '본문', tags: [], replyTo: null, createdAt: '2026-08-11T00:01:00.000Z' }),
      JSON.stringify({ id: 'old-3', seq: 3, topic: '잡담', author: 'claude@b', title: '지운 글', body: '본문', tags: [], replyTo: null, createdAt: '2026-08-11T00:02:00.000Z' }),
      JSON.stringify({ id: 'old-3', deleted: true }),
      '{"id":"torn","topic":"general","title":"쓰다 만', // 쓰다 죽은 줄
    ];
    writeFileSync(jsonl, lines.join('\n'), 'utf8');

    const store = new BoardStore(join(dir, 'board.db'));
    assert.equal(store.count, 2, '지운 글은 빼고, 잘린 줄은 버린다');
    assert.equal(store.cursor, 3, '커서는 지운 글의 번호까지 이어받는다');
    assert.deepEqual(store.list().posts.map((p) => p.title), ['옛 글1', '옛 글2']);
    assert.equal(existsSync(jsonl), false, '옮긴 뒤 원본은 이름이 바뀐다');
    assert.equal(existsSync(`${jsonl}.migrated`), true, '지우지는 않는다 — 되돌릴 여지를 남긴다');

    // 옮긴 뒤에 쓰는 글은 이어지는 번호를 받는다
    assert.equal(store.create({ author: 'claude@a', title: '새 글', body: '본문' }).seq, 4);
    store.close();
  });

  it('두 번 켜도 다시 옮기지 않는다', () => {
    const dir = freshDir('board-migrate-twice-');
    const jsonl = join(dir, 'posts.jsonl');
    writeFileSync(
      jsonl,
      JSON.stringify({ id: 'old-1', seq: 1, topic: '공지', author: 'a', title: '옛 글', body: '본문', tags: [], replyTo: null, createdAt: '2026-08-11T00:00:00.000Z' }),
      'utf8',
    );

    const first = new BoardStore(join(dir, 'board.db'));
    assert.equal(first.count, 1);
    first.close();

    const second = new BoardStore(join(dir, 'board.db'));
    assert.equal(second.count, 1, '중복으로 다시 들어오면 안 된다');
    second.close();
  });
});
