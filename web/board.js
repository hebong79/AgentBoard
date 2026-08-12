import { renderMarkdownInto } from './markdown.js';

const el = (id) => document.getElementById(id);

const ui = {
  status: el('status'),
  topics: el('topics'),
  statuses: el('statuses'),
  search: el('search'),
  filterAuthor: el('filter-author'),
  filterRepo: el('filter-repo'),
  refresh: el('refresh'),
  compose: el('compose'),
  composeTitle: el('compose-title'),
  topic: el('f-topic'),
  author: el('f-author'),
  title: el('f-title'),
  body: el('f-body'),
  tags: el('f-tags'),
  taskStatus: el('f-status'),
  assignee: el('f-assignee'),
  repo: el('f-repo'),
  files: el('f-files'),
  next: el('f-next'),
  replyTo: el('f-reply-to'),
  cancelReply: el('cancel-reply'),
  preview: el('preview'),
  previewBody: el('preview-body'),
  previewToggle: el('preview-toggle'),
  hint: el('compose-hint'),
  posts: el('posts'),
};

// 상태 값은 ASCII 가 정본이다. 한글은 화면에 보일 때만 쓴다.
const STATUS_LABEL = { todo: '대기', doing: '진행중', done: '완료', blocked: '막힘' };
const STATUS_ORDER = ['todo', 'doing', 'done', 'blocked'];

const state = {
  topic: '',
  status: '',
  needsAuth: false,
  cursor: 0,
  counts: {},
};

function token() {
  return localStorage.getItem('board.token') || '';
}

function headers(extra) {
  const out = Object.assign({}, extra);
  if (state.needsAuth && token()) out['x-board-token'] = token();
  return out;
}

async function api(path, options) {
  const res = await fetch(path, options);
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_) {
    data = null;
  }
  if (!res.ok) {
    const message = (data && data.error) || `HTTP ${res.status}`;
    throw new Error(message);
  }
  return data;
}

function setStatus(text, kind) {
  ui.status.textContent = text;
  ui.status.className = `status${kind ? ` ${kind}` : ''}`;
}

function askTokenIfNeeded() {
  if (!state.needsAuth || token()) return;
  const entered = window.prompt('이 게시판은 토큰이 필요합니다. x-board-token 값을 넣어주세요.');
  if (entered) localStorage.setItem('board.token', entered.trim());
}

async function loadHealth() {
  try {
    const health = await api('/api/health');
    state.needsAuth = Boolean(health.auth);
    state.cursor = health.cursor;
    state.counts = health.tasks || {};
    askTokenIfNeeded();
    renderStatuses();
    const doing = state.counts.doing || 0;
    const blocked = state.counts.blocked || 0;
    setStatus(
      `글 ${health.posts}건 · 진행중 ${doing} · 막힘 ${blocked} · 커서 ${health.cursor}` +
        (health.auth ? ' · 토큰 필요' : ''),
      blocked > 0 ? 'bad' : 'ok',
    );
  } catch (err) {
    setStatus(`서버 연결 실패: ${err.message}`, 'bad');
  }
}

async function loadTopics() {
  try {
    const data = await api('/api/topics', { headers: headers() });
    ui.topics.replaceChildren();
    ui.topics.append(topicItem('전체', '', null));
    for (const topic of data.topics) {
      ui.topics.append(topicItem(topic.topic, topic.topic, topic.posts));
    }
  } catch (err) {
    setStatus(`게시판 목록 실패: ${err.message}`, 'bad');
  }
}

function renderStatuses() {
  ui.statuses.replaceChildren();
  ui.statuses.append(statusItem('전체', '', null));
  for (const key of STATUS_ORDER) {
    ui.statuses.append(statusItem(STATUS_LABEL[key], key, state.counts[key] || 0));
  }
}

function statusItem(label, value, count) {
  const li = document.createElement('li');
  const button = document.createElement('button');
  button.type = 'button';
  button.setAttribute('aria-current', String(state.status === value));

  const name = document.createElement('span');
  name.textContent = label;
  button.append(name);

  if (count !== null) {
    const badge = document.createElement('span');
    badge.className = 'count';
    badge.textContent = String(count);
    button.append(badge);
  }

  button.addEventListener('click', () => {
    state.status = value;
    renderStatuses();
    loadPosts();
  });

  li.append(button);
  return li;
}

function topicItem(label, value, count) {
  const li = document.createElement('li');
  const button = document.createElement('button');
  button.type = 'button';
  button.setAttribute('aria-current', String(state.topic === value));

  const name = document.createElement('span');
  name.textContent = label;
  button.append(name);

  if (count !== null) {
    const badge = document.createElement('span');
    badge.className = 'count';
    badge.textContent = String(count);
    button.append(badge);
  }

  button.addEventListener('click', () => {
    state.topic = value;
    if (value) ui.topic.value = value;
    loadTopics();
    loadPosts();
  });

  li.append(button);
  return li;
}

async function loadPosts() {
  const params = new URLSearchParams();
  if (state.topic) params.set('topic', state.topic);
  if (state.status) params.set('status', state.status);
  if (ui.search.value.trim()) params.set('q', ui.search.value.trim());
  if (ui.filterAuthor.value.trim()) params.set('author', ui.filterAuthor.value.trim());
  if (ui.filterRepo.value.trim()) params.set('repo', ui.filterRepo.value.trim());
  params.set('limit', '200');

  try {
    const data = await api(`/api/posts?${params.toString()}`, { headers: headers() });
    state.cursor = data.cursor;
    render(data.posts);
  } catch (err) {
    setStatus(`목록 실패: ${err.message}`, 'bad');
  }
}

function render(posts) {
  ui.posts.replaceChildren();

  if (posts.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = '글이 없습니다.';
    ui.posts.append(empty);
    return;
  }

  const replies = new Map();
  const roots = [];
  for (const post of posts) {
    if (post.replyTo) {
      if (!replies.has(post.replyTo)) replies.set(post.replyTo, []);
      replies.get(post.replyTo).push(post);
    } else {
      roots.push(post);
    }
  }

  // 최신 글이 위로. 답글은 부모 밑에 시간순.
  roots.sort((a, b) => b.seq - a.seq);

  for (const root of roots) {
    ui.posts.append(card(root, false));
    for (const reply of (replies.get(root.id) || []).sort((a, b) => a.seq - b.seq)) {
      ui.posts.append(card(reply, true));
      replies.delete(reply.id);
    }
    replies.delete(root.id);
  }

  // 부모가 필터에서 빠진 답글도 흘리지 않고 보여준다.
  for (const orphans of replies.values()) {
    for (const orphan of orphans.sort((a, b) => a.seq - b.seq)) {
      ui.posts.append(card(orphan, true));
    }
  }
}

function card(post, isReply) {
  const article = document.createElement('article');
  article.className = `post${isReply ? ' reply' : ''}`;

  const title = document.createElement('h3');
  if (post.status) {
    const badge = document.createElement('span');
    badge.className = `badge status-${post.status}`;
    badge.textContent = STATUS_LABEL[post.status] || post.status;
    title.append(badge, ' ');
  }
  title.append(post.title);
  article.append(title);

  const meta = document.createElement('div');
  meta.className = 'meta';
  const bits = [`#${post.seq}`, post.topic, post.author];
  if (post.assignee) bits.push(`담당 ${post.assignee}`);
  if (post.repo) bits.push(`저장소 ${post.repo}`);
  bits.push(new Date(post.createdAt).toLocaleString('ko-KR'));
  // 만든 뒤 상태가 바뀐 적이 있으면 그것도 보여준다
  if (post.updatedSeq !== post.seq) {
    bits.push(`갱신 ${new Date(post.updatedAt).toLocaleString('ko-KR')}`);
  }
  for (const text of bits) {
    const span = document.createElement('span');
    span.textContent = text;
    meta.append(span);
  }
  article.append(meta);

  const view = bodyView(post);
  article.append(view.wrap);

  if (post.files && post.files.length) {
    const files = document.createElement('div');
    files.className = 'tags';
    for (const path of post.files) {
      const chip = document.createElement('span');
      chip.className = 'tag file';
      chip.textContent = path;
      files.append(chip);
    }
    article.append(files);
  }

  if (post.next) {
    const next = document.createElement('p');
    next.className = 'next';
    next.textContent = `다음 → ${post.next}`;
    article.append(next);
  }

  if (post.tags.length) {
    const tags = document.createElement('div');
    tags.className = 'tags';
    for (const tag of post.tags) {
      const chip = document.createElement('span');
      chip.className = 'tag';
      chip.textContent = tag;
      tags.append(chip);
    }
    article.append(tags);
  }

  const tools = document.createElement('div');
  tools.className = 'tools';

  if (view.long) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'more';
    more.textContent = '펼치기';
    more.addEventListener('click', () => {
      const clipped = view.wrap.classList.toggle('clipped');
      more.textContent = clipped ? '펼치기' : '접기';
    });
    tools.append(more);
  }

  // 렌더된 글과 마크다운 원문을 오간다. 원문은 그대로 복사해 다른 문서에 붙일 수 있다.
  const rawToggle = document.createElement('button');
  rawToggle.type = 'button';
  rawToggle.className = 'raw-toggle';
  rawToggle.textContent = '원문(md)';
  rawToggle.setAttribute('aria-pressed', 'false');
  rawToggle.addEventListener('click', () => {
    const showRaw = view.rendered.hidden === false;
    view.rendered.hidden = showRaw;
    view.raw.hidden = !showRaw;
    rawToggle.setAttribute('aria-pressed', String(showRaw));
    rawToggle.textContent = showRaw ? '보기' : '원문(md)';
  });
  tools.append(rawToggle);

  const copy = document.createElement('button');
  copy.type = 'button';
  copy.textContent = '복사';
  copy.addEventListener('click', () => copyMarkdown(post, copy));
  tools.append(copy);

  const download = document.createElement('button');
  download.type = 'button';
  download.textContent = '.md 저장';
  download.addEventListener('click', () => downloadMarkdown(post));
  tools.append(download);

  if (post.status) {
    for (const key of STATUS_ORDER) {
      if (key === post.status) continue;
      const move = document.createElement('button');
      move.type = 'button';
      move.className = 'move';
      move.textContent = `→ ${STATUS_LABEL[key]}`;
      move.addEventListener('click', () => changeStatus(post, key));
      tools.append(move);
    }
  }

  const replyButton = document.createElement('button');
  replyButton.type = 'button';
  replyButton.textContent = '답글';
  replyButton.addEventListener('click', () => startReply(post));
  tools.append(replyButton);

  const deleteButton = document.createElement('button');
  deleteButton.type = 'button';
  deleteButton.className = 'delete';
  deleteButton.textContent = '삭제';
  deleteButton.addEventListener('click', () => removePost(post));
  tools.append(deleteButton);

  article.append(tools);
  return article;
}

/** 이보다 긴 글은 접어 둔다. 목록이 긴 보고서 하나로 덮이지 않게. */
const CLIP_CHARS = 1500;

/** 본문을 마크다운으로 그린 것과 원문(.md) 두 벌로 만든다. 버튼으로 오간다. */
function bodyView(post) {
  const wrap = document.createElement('div');
  wrap.className = 'body-wrap';

  const rendered = document.createElement('div');
  rendered.className = 'body markdown';
  renderMarkdownInto(rendered, post.body);

  const raw = document.createElement('pre');
  raw.className = 'body raw';
  raw.textContent = post.body;
  raw.hidden = true;

  wrap.append(rendered, raw);

  const long = post.body.length > CLIP_CHARS;
  if (long) wrap.classList.add('clipped');

  return { wrap, rendered, raw, long };
}

async function copyMarkdown(post, button) {
  const label = button.textContent;
  try {
    await navigator.clipboard.writeText(post.body);
    button.textContent = '복사됨';
  } catch (_) {
    // 브라우저가 클립보드를 막으면(비 HTTPS 등) 원문을 골라 주고 사용자가 Ctrl+C 하게 한다.
    button.textContent = '직접 복사';
  }
  setTimeout(() => (button.textContent = label), 1500);
}

/**
 * 서버가 만든 `.md` 파일을 그대로 받는다 — 앞머리(front matter)에 작업 필드가 실려 있어
 * 저장소 문서로 바로 쓸 수 있다. 토큰이 걸린 게시판도 되게 fetch 로 받아 저장한다.
 */
async function downloadMarkdown(post) {
  try {
    const res = await fetch(`/api/posts/${encodeURIComponent(post.id)}.md`, { headers: headers() });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `board-${post.seq}-${post.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 40)}.md`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (err) {
    setStatus(`.md 저장 실패: ${err.message}`, 'bad');
  }
}

function startReply(post) {
  ui.replyTo.value = post.id;
  ui.topic.value = post.topic;
  ui.composeTitle.textContent = `답글: ${post.title}`;
  ui.title.value = `Re: ${post.title}`;
  ui.cancelReply.hidden = false;
  ui.body.focus();
}

function cancelReply() {
  ui.replyTo.value = '';
  ui.composeTitle.textContent = '새 글';
  ui.title.value = '';
  ui.cancelReply.hidden = true;
}

async function changeStatus(post, status) {
  try {
    await api(`/api/posts/${encodeURIComponent(post.id)}`, {
      method: 'PATCH',
      headers: headers({ 'content-type': 'application/json; charset=utf-8' }),
      body: JSON.stringify({ status, by: ui.author.value.trim() || null }),
    });
    await Promise.all([loadHealth(), loadPosts()]);
  } catch (err) {
    setStatus(`상태 변경 실패: ${err.message}`, 'bad');
  }
}

async function removePost(post) {
  if (!window.confirm(`"${post.title}" 을(를) 지웁니다. 답글도 함께 지워집니다.`)) return;
  try {
    const data = await api(`/api/posts/${encodeURIComponent(post.id)}`, {
      method: 'DELETE',
      headers: headers(),
    });
    setStatus(`${data.removed}건 삭제`, 'ok');
    await Promise.all([loadTopics(), loadPosts()]);
  } catch (err) {
    setStatus(`삭제 실패: ${err.message}`, 'bad');
  }
}

ui.compose.addEventListener('submit', async (event) => {
  event.preventDefault();
  const payload = {
    topic: ui.topic.value.trim() || undefined,
    author: ui.author.value.trim(),
    title: ui.title.value.trim(),
    body: ui.body.value,
    tags: splitList(ui.tags.value),
    replyTo: ui.replyTo.value || null,
    status: ui.taskStatus.value || null,
    assignee: ui.assignee.value.trim() || null,
    repo: ui.repo.value.trim() || null,
    files: splitList(ui.files.value),
    next: ui.next.value.trim() || null,
  };

  try {
    await api('/api/posts', {
      method: 'POST',
      headers: headers({ 'content-type': 'application/json; charset=utf-8' }),
      body: JSON.stringify(payload),
    });
    localStorage.setItem('board.author', payload.author);
    ui.body.value = '';
    if (!ui.preview.hidden) renderMarkdownInto(ui.previewBody, '');
    ui.tags.value = '';
    ui.files.value = '';
    ui.next.value = '';
    cancelReply();
    ui.hint.textContent = '올렸습니다.';
    setTimeout(() => (ui.hint.textContent = ''), 2000);
    await Promise.all([loadHealth(), loadTopics(), loadPosts()]);
  } catch (err) {
    ui.hint.textContent = `실패: ${err.message}`;
  }
});

ui.cancelReply.addEventListener('click', cancelReply);

// 올리기 전에 마크다운이 어떻게 보일지 확인한다 — 표·코드 블록은 눈으로 봐야 안다.
ui.previewToggle.addEventListener('click', () => {
  const show = ui.preview.hidden;
  ui.preview.hidden = !show;
  ui.previewToggle.textContent = show ? '미리보기 닫기' : '미리보기';
  if (show) renderMarkdownInto(ui.previewBody, ui.body.value);
});

ui.body.addEventListener('input', () => {
  if (!ui.preview.hidden) renderMarkdownInto(ui.previewBody, ui.body.value);
});
ui.refresh.addEventListener('click', () => {
  loadHealth();
  loadTopics();
  loadPosts();
});

function splitList(value) {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

let searchTimer = null;
for (const input of [ui.search, ui.filterAuthor, ui.filterRepo]) {
  input.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadPosts, 250);
  });
}

ui.author.value = localStorage.getItem('board.author') || '';

(async function boot() {
  await loadHealth();
  await loadTopics();
  await loadPosts();
  setInterval(() => {
    loadHealth();
    loadPosts();
  }, 5000);
})();
