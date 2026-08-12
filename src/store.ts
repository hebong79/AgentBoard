import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * 게시판 저장소 (SQLite).
 *
 * 이 게시판은 사람이 아니라 **에이전트가 읽는 것**이 목적이다. 그래서 글은 자유 텍스트만이
 * 아니라 작업 상태(`status`·`assignee`·`repo`·`files`·`next`)를 구조화된 필드로 들고 있고,
 * 상태만 따로 갱신할 수 있다.
 *
 * 순서·진도의 기준은 두 개다.
 * - `seq`        : 만들어진 순서. 목록 정렬에 쓴다.
 * - `updatedSeq` : 마지막으로 바뀐 순서. **폴링은 이걸 기준으로 돈다.**
 *
 * 둘을 나눈 이유: 상태가 바뀐 작업이 폴링에 안 잡히면 갱신 API 가 무의미해진다.
 * `updatedSeq` 를 올려 두면 "완료로 바뀐 작업"도 다른 에이전트에게 전달된다.
 */

/** 주의: 타입 스트리핑 모드는 생성자 파라미터 프로퍼티를 지원하지 않는다. */
export class BoardError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'BoardError';
    this.status = status;
  }
}

/**
 * 상태 값은 **ASCII 를 정본**으로 쓴다. 한글을 정본으로 삼으면 `?status=진행중` 같은 필터가
 * URL 인코딩 없이는 Node 의 HTTP 파서에 막힌다(본문 없는 400). 에이전트가 가장 자주 거는
 * 필터라 여기서 사고가 나면 안 된다. 입력으로 들어온 한글은 아래 별칭표로 받아준다.
 */
export const STATUSES = ['todo', 'doing', 'done', 'blocked'] as const;
export type Status = (typeof STATUSES)[number];

export const STATUS_LABEL: Record<Status, string> = {
  todo: '대기',
  doing: '진행중',
  done: '완료',
  blocked: '막힘',
};

const STATUS_ALIAS: Record<string, Status> = {
  todo: 'todo', 대기: 'todo', 할일: 'todo',
  doing: 'doing', 진행중: 'doing', 진행: 'doing',
  done: 'done', 완료: 'done', 끝: 'done',
  blocked: 'blocked', 막힘: 'blocked', 블록: 'blocked', 보류: 'blocked',
};

export function normalizeStatus(value: unknown, field = 'status'): Status {
  if (typeof value !== 'string') throw new BoardError(400, `${field} 는 문자열이어야 합니다`);
  const found = STATUS_ALIAS[value.trim().toLowerCase()] ?? STATUS_ALIAS[value.trim()];
  if (!found) {
    throw new BoardError(400, `${field} 는 ${STATUSES.join('/')} 중 하나여야 합니다 (받은 값: ${value})`);
  }
  return found;
}

export interface Post {
  id: string;
  seq: number;
  updatedSeq: number;
  topic: string;
  author: string;
  title: string;
  body: string;
  tags: string[];
  replyTo: string | null;
  /** null 이면 그냥 글, 값이 있으면 작업이다. */
  status: Status | null;
  assignee: string | null;
  repo: string | null;
  files: string[];
  next: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PostEvent {
  kind: 'created' | 'updated' | 'deleted';
  by: string | null;
  changes: Record<string, unknown>;
  seq: number;
  at: string;
}

export interface CreateInput {
  topic?: unknown;
  author?: unknown;
  title?: unknown;
  body?: unknown;
  tags?: unknown;
  replyTo?: unknown;
  status?: unknown;
  assignee?: unknown;
  repo?: unknown;
  files?: unknown;
  next?: unknown;
}

export interface UpdateInput {
  status?: unknown;
  assignee?: unknown;
  repo?: unknown;
  files?: unknown;
  next?: unknown;
  by?: unknown;
}

export interface ListQuery {
  topic?: string;
  author?: string;
  tag?: string;
  q?: string;
  status?: string;
  assignee?: string;
  repo?: string;
  /** files 안의 경로 부분일치. "이 파일 건드린 과거 작업" 을 찾는 용도. */
  file?: string;
  since?: number;
  limit?: number;
  /** true 면 작업(status 가 있는 글)만 */
  tasksOnly?: boolean;
}

export interface SearchHit extends Post {
  /** 관련도. 제목에서 맞으면 높고, 본문에서만 맞으면 낮다. */
  score: number;
  /** 본문에서 검색어가 나온 자리 앞뒤를 잘라낸 것. */
  snippet: string;
}

export interface ListResult {
  posts: Post[];
  /** since 폴링일 때, 그 사이 지워진 글의 id. 삭제도 전파된다. */
  deleted: string[];
  cursor: number;
}

export interface TopicSummary {
  topic: string;
  posts: number;
  lastSeq: number;
  lastAt: string;
}

const MAX_LIMIT = 500;
const DEFAULT_TOPIC = 'general';

/**
 * Node 의 utf8 디코더는 잘못된 바이트를 조용히 U+FFFD 로 바꾼다. 그냥 두면 깨진 한글이
 * 게시판에 영구히 남으므로 받는 자리에서 거절한다.
 */
export function hasMojibake(value: string): boolean {
  return value.includes('�');
}

function asText(value: unknown, field: string, required: boolean): string {
  if (value === undefined || value === null) {
    if (required) throw new BoardError(400, `${field} 가 필요합니다`);
    return '';
  }
  if (typeof value !== 'string') throw new BoardError(400, `${field} 는 문자열이어야 합니다`);
  const text = value.trim();
  if (required && text.length === 0) throw new BoardError(400, `${field} 가 비어 있습니다`);
  if (hasMojibake(text)) {
    throw new BoardError(
      400,
      `${field} 의 인코딩이 깨졌습니다(U+FFFD). 본문을 UTF-8 파일에 써서 --data-binary @파일 로 보내세요`,
    );
  }
  return text;
}

function asStringArray(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new BoardError(400, `${field} 는 배열이어야 합니다`);
  const out: string[] = [];
  for (const raw of value) {
    const item = asText(raw, `${field} 항목`, false);
    if (item && !out.includes(item)) out.push(item);
  }
  return out;
}

function optionalText(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  return asText(value, field, true);
}

interface Row {
  id: string;
  seq: number;
  updated_seq: number;
  topic: string;
  author: string;
  title: string;
  body: string;
  tags: string;
  reply_to: string | null;
  status: string | null;
  assignee: string | null;
  repo: string | null;
  files: string;
  next_step: string | null;
  created_at: string;
  updated_at: string;
  deleted: number;
}

function toPost(row: Row): Post {
  return {
    id: row.id,
    seq: row.seq,
    updatedSeq: row.updated_seq,
    topic: row.topic,
    author: row.author,
    title: row.title,
    body: row.body,
    tags: JSON.parse(row.tags) as string[],
    replyTo: row.reply_to,
    status: row.status as Status | null,
    assignee: row.assignee,
    repo: row.repo,
    files: JSON.parse(row.files) as string[],
    next: row.next_step,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS posts (
  id          TEXT PRIMARY KEY,
  seq         INTEGER NOT NULL UNIQUE,
  updated_seq INTEGER NOT NULL,
  topic       TEXT NOT NULL,
  author      TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  tags        TEXT NOT NULL,
  reply_to    TEXT,
  status      TEXT,
  assignee    TEXT,
  repo        TEXT,
  files       TEXT NOT NULL,
  next_step   TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_posts_updated_seq ON posts(updated_seq);
CREATE INDEX IF NOT EXISTS idx_posts_topic       ON posts(topic);
CREATE INDEX IF NOT EXISTS idx_posts_status      ON posts(status);
CREATE INDEX IF NOT EXISTS idx_posts_reply_to    ON posts(reply_to);

CREATE TABLE IF NOT EXISTS events (
  rowid_      INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id     TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  by_who      TEXT,
  changes     TEXT NOT NULL,
  at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_post ON events(post_id);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export class BoardStore {
  file: string;
  private db: DatabaseSync;

  constructor(file: string) {
    this.file = file;
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    // 여러 요청이 겹쳐도 읽기가 막히지 않게. 쓰기 프로세스는 서버 하나뿐이다.
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(SCHEMA);
    if (this.readSeq() === null) this.writeSeq(0);
    this.migrateFromJsonl();
  }

  close(): void {
    this.db.close();
  }

  private readSeq(): number | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('seq') as
      | { value: string }
      | undefined;
    return row ? Number(row.value) : null;
  }

  private writeSeq(value: number): void {
    this.db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?')
      .run('seq', String(value), String(value));
  }

  /** 지운 글의 번호도 소비된 채로 남는다 → 번호를 재사용하지 않는다. */
  private nextSeq(): number {
    const next = (this.readSeq() ?? 0) + 1;
    this.writeSeq(next);
    return next;
  }

  /**
   * JSONL 로 쓰던 시절의 글을 한 번만 옮겨 담는다. 옮긴 뒤 파일은 `.migrated` 로 이름을
   * 바꿔 둔다(지우지 않는다 — 되돌릴 여지를 남긴다).
   */
  private migrateFromJsonl(): void {
    const legacy = this.file.replace(/\.db$/, '') + '.jsonl';
    const alt = dirname(this.file) + '/posts.jsonl';
    const source = existsSync(legacy) ? legacy : existsSync(alt) ? alt : null;
    if (!source) return;

    const already = this.db.prepare('SELECT COUNT(*) AS c FROM posts').get() as { c: number };
    if (already.c > 0) return;

    const deleted = new Set<string>();
    const rows: Array<Record<string, unknown>> = [];
    for (const line of readFileSync(source, 'utf8').split('\n')) {
      const text = line.trim();
      if (!text) continue;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        continue; // 쓰다 만 줄 — 버린다
      }
      if (typeof parsed.id !== 'string') continue;
      if (parsed.deleted === true) deleted.add(parsed.id);
      else rows.push(parsed);
    }
    if (rows.length === 0) return;

    let maxSeq = 0;
    const insert = this.db.prepare(
      `INSERT OR REPLACE INTO posts
       (id, seq, updated_seq, topic, author, title, body, tags, reply_to,
        status, assignee, repo, files, next_step, created_at, updated_at, deleted)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    this.db.exec('BEGIN');
    try {
      for (const row of rows) {
        const seq = Number(row.seq);
        if (!Number.isInteger(seq)) continue;
        if (seq > maxSeq) maxSeq = seq;
        const at = String(row.createdAt ?? new Date().toISOString());
        insert.run(
          String(row.id),
          seq,
          seq,
          String(row.topic ?? DEFAULT_TOPIC),
          String(row.author ?? 'unknown'),
          String(row.title ?? ''),
          String(row.body ?? ''),
          JSON.stringify(Array.isArray(row.tags) ? row.tags : []),
          row.replyTo === undefined ? null : (row.replyTo as string | null),
          null,
          null,
          null,
          '[]',
          null,
          at,
          at,
          deleted.has(String(row.id)) ? 1 : 0,
        );
      }
      this.writeSeq(Math.max(maxSeq, this.readSeq() ?? 0));
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    renameSync(source, `${source}.migrated`);
    console.log(`[board] JSONL ${rows.length}건을 SQLite 로 옮겼습니다 → ${source}.migrated`);
  }

  get cursor(): number {
    return this.readSeq() ?? 0;
  }

  get count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM posts WHERE deleted = 0').get() as {
      c: number;
    };
    return row.c;
  }

  /** 상태별 작업 수. 에이전트가 health 한 번으로 판을 볼 수 있게 한다. */
  taskCounts(): Record<Status, number> {
    const out = { todo: 0, doing: 0, done: 0, blocked: 0 } as Record<Status, number>;
    const rows = this.db
      .prepare('SELECT status, COUNT(*) AS c FROM posts WHERE deleted = 0 AND status IS NOT NULL GROUP BY status')
      .all() as Array<{ status: Status; c: number }>;
    for (const row of rows) out[row.status] = row.c;
    return out;
  }

  private nextId(seq: number): string {
    const stamp = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 6);
    return `${stamp}-${seq}-${rand}`;
  }

  private row(id: string, includeDeleted = false): Row | undefined {
    const sql = includeDeleted
      ? 'SELECT * FROM posts WHERE id = ?'
      : 'SELECT * FROM posts WHERE id = ? AND deleted = 0';
    return this.db.prepare(sql).get(id) as Row | undefined;
  }

  private logEvent(postId: string, seq: number, kind: PostEvent['kind'], by: string | null, changes: unknown): void {
    this.db
      .prepare('INSERT INTO events (post_id, seq, kind, by_who, changes, at) VALUES (?,?,?,?,?,?)')
      .run(postId, seq, kind, by, JSON.stringify(changes), new Date().toISOString());
  }

  create(input: CreateInput): Post {
    const title = asText(input.title, 'title', true);
    const body = asText(input.body, 'body', true);
    const author = asText(input.author, 'author', true);
    const topic =
      input.topic === undefined || input.topic === null || input.topic === ''
        ? DEFAULT_TOPIC
        : asText(input.topic, 'topic', true);
    const tags = asStringArray(input.tags, 'tags');
    const files = asStringArray(input.files, 'files');
    const assignee = optionalText(input.assignee, 'assignee');
    const repo = optionalText(input.repo, 'repo');
    const next = optionalText(input.next, 'next');
    const status =
      input.status === undefined || input.status === null || input.status === ''
        ? null
        : normalizeStatus(input.status);

    let replyTo: string | null = null;
    if (input.replyTo !== undefined && input.replyTo !== null && input.replyTo !== '') {
      replyTo = asText(input.replyTo, 'replyTo', true);
      if (!this.row(replyTo)) throw new BoardError(404, `답글 대상 글이 없습니다: ${replyTo}`);
    }

    this.db.exec('BEGIN');
    try {
      const seq = this.nextSeq();
      const id = this.nextId(seq);
      const at = new Date().toISOString();

      this.db
        .prepare(
          `INSERT INTO posts
           (id, seq, updated_seq, topic, author, title, body, tags, reply_to,
            status, assignee, repo, files, next_step, created_at, updated_at, deleted)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`,
        )
        .run(
          id, seq, seq, topic, author, title, body, JSON.stringify(tags), replyTo,
          status, assignee, repo, JSON.stringify(files), next, at, at,
        );

      this.logEvent(id, seq, 'created', author, { status, assignee });
      this.db.exec('COMMIT');
      return toPost(this.row(id)!);
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * 작업 상태만 바꾼다.
   *
   * 제목·본문은 **일부러 못 바꾸게 했다.** 사실 기록은 그대로 남기고 정정은 답글로 쌓는 것이
   * 원래 규칙이다. 바뀌어야 하는 것은 "무슨 일이 있었나"가 아니라 "지금 어디까지 됐나"뿐이다.
   */
  update(id: string, patch: UpdateInput): Post {
    const current = this.row(id);
    if (!current) throw new BoardError(404, `글이 없습니다: ${id}`);

    const by = optionalText(patch.by, 'by');
    const changes: Record<string, unknown> = {};

    if ('status' in patch && patch.status !== undefined) {
      changes.status = patch.status === null ? null : normalizeStatus(patch.status);
    }
    if ('assignee' in patch && patch.assignee !== undefined) {
      changes.assignee = optionalText(patch.assignee, 'assignee');
    }
    if ('repo' in patch && patch.repo !== undefined) changes.repo = optionalText(patch.repo, 'repo');
    if ('next' in patch && patch.next !== undefined) changes.next = optionalText(patch.next, 'next');
    if ('files' in patch && patch.files !== undefined) changes.files = asStringArray(patch.files, 'files');

    if (Object.keys(changes).length === 0) {
      throw new BoardError(400, '바꿀 항목이 없습니다 (status·assignee·repo·files·next 중 하나)');
    }

    this.db.exec('BEGIN');
    try {
      // 상태가 바뀌면 updated_seq 를 올린다 → since 폴링에 다시 실린다.
      const seq = this.nextSeq();
      const at = new Date().toISOString();

      this.db
        .prepare(
          `UPDATE posts SET
             status      = CASE WHEN ? THEN ? ELSE status END,
             assignee    = CASE WHEN ? THEN ? ELSE assignee END,
             repo        = CASE WHEN ? THEN ? ELSE repo END,
             files       = CASE WHEN ? THEN ? ELSE files END,
             next_step   = CASE WHEN ? THEN ? ELSE next_step END,
             updated_seq = ?,
             updated_at  = ?
           WHERE id = ?`,
        )
        .run(
          'status' in changes ? 1 : 0, (changes.status ?? null) as string | null,
          'assignee' in changes ? 1 : 0, (changes.assignee ?? null) as string | null,
          'repo' in changes ? 1 : 0, (changes.repo ?? null) as string | null,
          'files' in changes ? 1 : 0, JSON.stringify(changes.files ?? []),
          'next' in changes ? 1 : 0, (changes.next ?? null) as string | null,
          seq, at, id,
        );

      this.logEvent(id, seq, 'updated', by, changes);
      this.db.exec('COMMIT');
      return toPost(this.row(id)!);
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** 검색어를 공백으로 쪼갠다. 각 낱말은 AND 로 묶이므로 순서가 상관없다. */
  private static terms(q: string): string[] {
    return q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  }

  /**
   * 한 낱말이 어느 필드에든 들어 있으면 참. **부분일치**라 조사가 붙어도("좌표계와")
   * 두 글자 낱말("좌표")로 찾힌다. 한국어는 교착어라 단어 경계 토크나이저(FTS5)로는
   * 이게 안 된다 — trigram 은 두 글자를 못 받고, unicode61 은 조사에 걸려 놓친다.
   */
  private static readonly MATCH_SQL =
    '(lower(title) LIKE ? OR lower(body) LIKE ? OR lower(tags) LIKE ?' +
    " OR lower(COALESCE(repo,'')) LIKE ? OR lower(files) LIKE ?)";

  private static matchArgs(term: string): string[] {
    const needle = `%${term}%`;
    return [needle, needle, needle, needle, needle];
  }

  private filters(query: ListQuery): { where: string[]; args: Array<string | number> } {
    const where: string[] = [];
    const args: Array<string | number> = [];

    if (query.topic?.trim()) { where.push('topic = ?'); args.push(query.topic.trim()); }
    if (query.author?.trim()) { where.push('author = ?'); args.push(query.author.trim()); }
    if (query.assignee?.trim()) { where.push('assignee = ?'); args.push(query.assignee.trim()); }
    if (query.repo?.trim()) { where.push('repo = ?'); args.push(query.repo.trim()); }
    if (query.status?.trim()) { where.push('status = ?'); args.push(normalizeStatus(query.status)); }
    if (query.tasksOnly) where.push('status IS NOT NULL');
    if (query.tag?.trim()) {
      // tags 는 JSON 배열 문자열이다. 항목 하나를 정확히 맞춘다.
      where.push('EXISTS (SELECT 1 FROM json_each(posts.tags) WHERE json_each.value = ?)');
      args.push(query.tag.trim());
    }
    if (query.file?.trim()) {
      // 전체 경로로도, 파일 이름만으로도 찾히게 부분일치로 본다.
      where.push(
        'EXISTS (SELECT 1 FROM json_each(posts.files) WHERE lower(json_each.value) LIKE ?)',
      );
      args.push(`%${query.file.trim().toLowerCase()}%`);
    }
    if (query.q?.trim()) {
      for (const term of BoardStore.terms(query.q)) {
        where.push(BoardStore.MATCH_SQL);
        args.push(...BoardStore.matchArgs(term));
      }
    }
    return { where, args };
  }

  list(query: ListQuery = {}): ListResult {
    const { where, args } = this.filters(query);

    const since = query.since;
    const polling = typeof since === 'number';

    if (polling) {
      where.unshift('updated_seq > ?');
      args.unshift(since);
    } else {
      where.unshift('deleted = 0');
    }

    // 폴링은 바뀐 순서로, 둘러보기는 만들어진 순서로.
    const orderCol = polling ? 'updated_seq' : 'seq';
    const rows = this.db
      .prepare(`SELECT * FROM posts WHERE ${where.join(' AND ')} ORDER BY ${orderCol} ASC`)
      .all(...args) as Row[];

    const alive = rows.filter((row) => row.deleted === 0);
    const deleted = rows.filter((row) => row.deleted === 1).map((row) => row.id);

    let posts = alive.map(toPost);

    /**
     * limit 을 자르는 방향이 계약이다.
     * - since 가 있으면 = 폴링 → 오래된 쪽에서 limit 개. 뒤에서 자르면 커서만 앞서 나가고
     *   그 사이 글은 영원히 전달되지 않는다.
     * - since 가 없으면 = 둘러보기 → 최신 쪽 limit 개를 남긴다.
     */
    const limit = query.limit;
    if (typeof limit === 'number' && limit >= 0 && posts.length > limit) {
      posts = polling ? posts.slice(0, limit) : posts.slice(posts.length - limit);
    }

    // 커서는 필터와 무관하게 서버 전체의 최신값이다.
    return { posts, deleted, cursor: this.cursor };
  }

  /**
   * 과거 작업을 찾아 이어하기 위한 검색.
   *
   * `list({q})` 과 걸러내는 조건은 같지만, 결과를 **관련도 순**으로 준다. 글이 쌓일수록
   * 등록순 목록은 쓸모가 없어지기 때문이다. 제목에서 맞은 것이 본문에서만 맞은 것보다 위에
   * 오고, 점수가 같으면 최근 것이 위다.
   */
  search(query: ListQuery & { q: string }): { results: SearchHit[]; cursor: number } {
    const terms = BoardStore.terms(query.q ?? '');
    if (terms.length === 0) throw new BoardError(400, '검색어(q)가 필요합니다');

    const { where, args } = this.filters({ ...query, q: undefined });
    where.unshift('deleted = 0');

    // 점수식이 SELECT 에 들어가므로 그 인자를 WHERE 인자보다 먼저 묶는다.
    const scoreParts: string[] = [];
    const scoreArgs: string[] = [];
    for (const term of terms) {
      const needle = `%${term}%`;
      scoreParts.push(
        '(CASE WHEN lower(title) LIKE ? THEN 3 ELSE 0 END)' +
        ' + (CASE WHEN lower(tags) LIKE ? THEN 2 ELSE 0 END)' +
        " + (CASE WHEN lower(COALESCE(repo,'')) LIKE ? THEN 2 ELSE 0 END)" +
        ' + (CASE WHEN lower(files) LIKE ? THEN 2 ELSE 0 END)' +
        ' + (CASE WHEN lower(body) LIKE ? THEN 1 ELSE 0 END)',
      );
      scoreArgs.push(needle, needle, needle, needle, needle);
    }

    /**
     * 낱말은 **OR** 로 묶는다(목록 필터인 `list({q})` 의 AND 와 다르다).
     *
     * 과거 작업을 찾을 때는 놓치는 쪽이 더 나쁘다. AND 로 묶으면 "카메라 각도" 로 찾을 때
     * 제목이 "회전각 단위" 인 글이 통째로 빠지고, 에이전트는 이력을 모른 채 그냥 시작한다.
     * 여러 낱말이 맞은 글은 점수가 높아 어차피 위로 오므로, OR 로 넓게 훑고 순위로 거른다.
     */
    const termClauses: string[] = [];
    for (const term of terms) {
      termClauses.push(BoardStore.MATCH_SQL);
      args.push(...BoardStore.matchArgs(term));
    }
    where.push(`(${termClauses.join(' OR ')})`);

    const limit = Math.min(query.limit ?? 20, MAX_LIMIT);
    const rows = this.db
      .prepare(
        `SELECT *, (${scoreParts.join(' + ')}) AS score
           FROM posts
          WHERE ${where.join(' AND ')}
          ORDER BY score DESC, seq DESC
          LIMIT ?`,
      )
      .all(...scoreArgs, ...args, limit) as Array<Row & { score: number }>;

    return {
      results: rows.map((row) => ({
        ...toPost(row),
        score: row.score,
        snippet: makeSnippet(row.body, terms),
      })),
      cursor: this.cursor,
    };
  }

  get(id: string): { post: Post; replies: Post[]; history: PostEvent[] } {
    const row = this.row(id);
    if (!row) throw new BoardError(404, `글이 없습니다: ${id}`);

    const replies = (
      this.db
        .prepare('SELECT * FROM posts WHERE reply_to = ? AND deleted = 0 ORDER BY seq ASC')
        .all(id) as Row[]
    ).map(toPost);

    const history = (
      this.db
        .prepare('SELECT seq, kind, by_who, changes, at FROM events WHERE post_id = ? ORDER BY rowid_ ASC')
        .all(id) as Array<{ seq: number; kind: string; by_who: string | null; changes: string; at: string }>
    ).map((event) => ({
      kind: event.kind as PostEvent['kind'],
      by: event.by_who,
      changes: JSON.parse(event.changes) as Record<string, unknown>,
      seq: event.seq,
      at: event.at,
    }));

    return { post: toPost(row), replies, history };
  }

  /** 글과 그 답글을 함께 지운다. 이미 지운 글이면 0. */
  remove(id: string): number {
    if (!this.row(id)) return 0;

    const targets = [id, ...(this.db
      .prepare('SELECT id FROM posts WHERE reply_to = ? AND deleted = 0')
      .all(id) as Array<{ id: string }>).map((row) => row.id)];

    this.db.exec('BEGIN');
    try {
      const mark = this.db.prepare('UPDATE posts SET deleted = 1, updated_seq = ?, updated_at = ? WHERE id = ?');
      const at = new Date().toISOString();
      for (const target of targets) {
        // 삭제도 updated_seq 를 올린다 → 폴링으로 전파된다.
        const seq = this.nextSeq();
        mark.run(seq, at, target);
        this.logEvent(target, seq, 'deleted', null, {});
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return targets.length;
  }

  /** 마지막 활동이 최신인 순. */
  topics(): TopicSummary[] {
    return (
      this.db
        .prepare(
          `SELECT topic,
                  COUNT(*)      AS posts,
                  MAX(seq)      AS lastSeq,
                  MAX(created_at) AS lastAt
             FROM posts
            WHERE deleted = 0
            GROUP BY topic
            ORDER BY lastSeq DESC`,
        )
        .all() as Array<{ topic: string; posts: number; lastSeq: number; lastAt: string }>
    ).map((row) => ({ topic: row.topic, posts: row.posts, lastSeq: row.lastSeq, lastAt: row.lastAt }));
  }
}

const SNIPPET_RADIUS = 60;

/** 검색어가 나온 자리 앞뒤를 잘라 준다. 에이전트가 본문 전체를 안 읽고 판단할 수 있게. */
export function makeSnippet(body: string, terms: string[]): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  const lower = flat.toLowerCase();

  let at = -1;
  for (const term of terms) {
    const found = lower.indexOf(term);
    if (found !== -1 && (at === -1 || found < at)) at = found;
  }
  if (at === -1) return flat.slice(0, SNIPPET_RADIUS * 2) + (flat.length > SNIPPET_RADIUS * 2 ? '…' : '');

  const start = Math.max(0, at - SNIPPET_RADIUS);
  const end = Math.min(flat.length, at + SNIPPET_RADIUS);
  return (start > 0 ? '…' : '') + flat.slice(start, end) + (end < flat.length ? '…' : '');
}

export function parseLimit(raw: string | null): number | undefined {
  if (raw === null || raw.trim() === '') return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new BoardError(400, 'limit 은 0 이상의 정수여야 합니다');
  }
  return Math.min(value, MAX_LIMIT);
}

export function parseSince(raw: string | null): number | undefined {
  if (raw === null || raw.trim() === '') return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new BoardError(400, 'since 는 0 이상의 정수여야 합니다');
  }
  return value;
}
