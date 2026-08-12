/**
 * 게시판 본문(마크다운)을 DOM 으로 그린다. 의존성 0.
 *
 * **innerHTML 을 한 번도 쓰지 않는다.** 글은 다른 PC 의 클로드가 올린 것이라 본문에 무엇이
 * 들어올지 모른다. createElement/createTextNode 로만 조립하면 `<script>` 든 `<img onerror>` 든
 * 그냥 글자로 남는다 — 살균(sanitize) 목록을 관리할 필요 자체가 없어진다.
 *
 * 구조는 두 단계다.
 *   parseMarkdown(text) → 블록 트리(순수 데이터, DOM 없이 시험 가능)
 *   renderMarkdown(tree|text, doc) → DocumentFragment
 */

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`]*)$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const BULLET = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

/** 알 수 없는 스킴(javascript:, data: …)은 링크로 만들지 않고 글자로 남긴다. */
export function safeUrl(raw) {
  const url = String(raw ?? '').trim();
  if (!url) return null;
  if (/^(https?:|mailto:)/i.test(url)) return url;
  // 스킴이 붙어 있는데 위 목록에 없으면 거절. 스킴이 없으면 상대경로·앵커라 안전하다.
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return null;
  return url;
}

// ─────────────────────────────────────────── 인라인

const ESCAPABLE = '\\`*_{}[]()#+-.!|~>';

/** `**굵게**`, `` `코드` ``, `[글](주소)` 같은 것을 인라인 노드 배열로 만든다. */
export function parseInline(text) {
  const out = [];
  let buffer = '';
  let i = 0;

  const flush = () => {
    if (buffer) out.push({ type: 'text', value: buffer });
    buffer = '';
  };

  while (i < text.length) {
    const rest = text.slice(i);
    const ch = text[i];

    // 역슬래시 탈출 — 마크다운 기호를 글자로 쓰고 싶을 때
    if (ch === '\\' && ESCAPABLE.includes(text[i + 1])) {
      buffer += text[i + 1];
      i += 2;
      continue;
    }

    if (ch === '\n') {
      flush();
      out.push({ type: 'br' });
      i += 1;
      continue;
    }

    // 코드 스팬이 제일 세다. 안쪽의 * 나 [ 는 기호가 아니라 글자다.
    if (ch === '`') {
      const open = /^`+/.exec(rest)[0];
      const close = text.indexOf(open, i + open.length);
      if (close !== -1) {
        flush();
        out.push({ type: 'code', value: text.slice(i + open.length, close).replace(/^ | $/g, '') });
        i = close + open.length;
        continue;
      }
    }

    // 이미지 / 링크
    const media = ch === '!' && text[i + 1] === '[' ? matchLink(rest.slice(1)) : null;
    if (media) {
      const src = safeUrl(media.href);
      flush();
      if (src) out.push({ type: 'image', src, alt: media.label });
      else buffer += `![${media.label}](${media.href})`;
      i += media.length + 1;
      continue;
    }
    if (ch === '[') {
      const link = matchLink(rest);
      if (link) {
        const href = safeUrl(link.href);
        flush();
        if (href) out.push({ type: 'link', href, children: parseInline(link.label) });
        else buffer += `[${link.label}](${link.href})`;
        i += link.length;
        continue;
      }
    }

    // <http://…> 와 맨몸 URL 을 눌러지게 한다
    const angle = /^<((?:https?:\/\/|mailto:)[^>\s]+)>/.exec(rest);
    if (angle) {
      flush();
      out.push({ type: 'link', href: angle[1], children: [{ type: 'text', value: angle[1] }] });
      i += angle[0].length;
      continue;
    }
    const bare = /^https?:\/\/[^\s<>()[\]"']+/.exec(rest);
    if (bare) {
      flush();
      out.push({ type: 'link', href: bare[0], children: [{ type: 'text', value: bare[0] }] });
      i += bare[0].length;
      continue;
    }

    // 강조. 여는 기호와 닫는 기호가 같으므로 긴 것(**, ~~)부터 본다.
    const emphasis =
      matchWrap(rest, '***', 'strongem') ||
      matchWrap(rest, '**', 'strong') ||
      matchWrap(rest, '__', 'strong') ||
      matchWrap(rest, '~~', 'del') ||
      matchWrap(rest, '*', 'em') ||
      matchUnderscoreEm(text, i);
    if (emphasis) {
      flush();
      out.push(emphasis.node);
      i += emphasis.length;
      continue;
    }

    buffer += ch;
    i += 1;
  }

  flush();
  return out;
}

/** `[글](주소)` 를 통째로 잰다. 라벨 안의 대괄호 짝을 세므로 `[a[b]c](x)` 도 맞는다. */
function matchLink(text) {
  if (text[0] !== '[') return null;
  let depth = 0;
  let end = -1;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\\') { i += 1; continue; }
    if (ch === '[') depth += 1;
    else if (ch === ']') {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end === -1 || text[end + 1] !== '(') return null;

  let close = -1;
  let paren = 0;
  for (let i = end + 1; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\\') { i += 1; continue; }
    if (ch === '(') paren += 1;
    else if (ch === ')') {
      paren -= 1;
      if (paren === 0) { close = i; break; }
    }
  }
  if (close === -1) return null;

  const target = text.slice(end + 2, close).trim();
  // 제목("…")이 붙어 있으면 떼어낸다
  const href = target.replace(/\s+["'(].*$/, '').trim();
  return { label: text.slice(1, end), href, length: close + 1 };
}

function matchWrap(text, marker, type) {
  if (!text.startsWith(marker)) return null;
  const close = text.indexOf(marker, marker.length);
  if (close === -1) return null;
  const inner = text.slice(marker.length, close);
  // `** **` 이나 `**` 만 있는 줄은 강조가 아니다
  if (!inner.trim()) return null;

  const children = parseInline(inner);
  const node =
    type === 'strongem'
      ? { type: 'strong', children: [{ type: 'em', children }] }
      : { type, children };
  return { node, length: close + marker.length };
}

/**
 * `_기울임_` 은 낱말 가운데(`snake_case_name`)에서는 강조가 아니다.
 * 한글은 띄어쓰기가 적어 이 규칙이 없으면 파일 이름이 통째로 기울어진다.
 */
function matchUnderscoreEm(text, i) {
  if (text[i] !== '_') return null;
  const before = i === 0 ? ' ' : text[i - 1];
  if (/[\w가-힣]/.test(before)) return null;
  const rest = text.slice(i);
  const found = /^_([^_]+)_(?![\w가-힣])/.exec(rest);
  if (!found || !found[1].trim()) return null;
  return { node: { type: 'em', children: parseInline(found[1]) }, length: found[0].length };
}

// ─────────────────────────────────────────── 블록

export function parseMarkdown(text) {
  return parseBlocks(String(text ?? '').replace(/\r\n?/g, '\n').split('\n'));
}

function parseBlocks(lines) {
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i += 1; continue; }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1];
      const body = [];
      i += 1;
      while (i < lines.length && !new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`).test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1; // 닫는 울타리 (없이 끝나도 그냥 넘어간다)
      blocks.push({ type: 'code', lang: fence[2].trim(), text: body.join('\n') });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, inline: parseInline(heading[2]) });
      i += 1;
      continue;
    }

    if (HR.test(line)) {
      blocks.push({ type: 'hr' });
      i += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const inner = [];
      while (i < lines.length && lines[i].trim()) {
        const quoted = QUOTE.exec(lines[i]);
        // 인용 안에서 줄이 이어지면 `>` 를 안 붙여도 이어지는 것으로 본다(lazy continuation).
        inner.push(quoted ? quoted[1] : lines[i]);
        i += 1;
      }
      blocks.push({ type: 'quote', blocks: parseBlocks(inner) });
      continue;
    }

    const table = parseTable(lines, i);
    if (table) {
      blocks.push(table.block);
      i = table.next;
      continue;
    }

    if (BULLET.test(line)) {
      const list = parseList(lines, i);
      blocks.push(list.block);
      i = list.next;
      continue;
    }

    // 나머지는 문단. 다른 블록이 시작되면 거기서 끊는다.
    const paragraph = [];
    while (i < lines.length && lines[i].trim() && !startsBlock(lines, i)) {
      paragraph.push(lines[i].trim());
      i += 1;
    }
    if (paragraph.length === 0) { i += 1; continue; }
    blocks.push({ type: 'para', inline: parseInline(paragraph.join('\n')) });
  }

  return blocks;
}

function startsBlock(lines, i) {
  const line = lines[i];
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    HR.test(line) ||
    QUOTE.test(line) ||
    BULLET.test(line) ||
    Boolean(parseTable(lines, i))
  );
}

function parseTable(lines, start) {
  const header = lines[start];
  const divider = lines[start + 1];
  if (!header || !header.includes('|')) return null;
  if (!divider || !divider.includes('-') || !TABLE_DIVIDER.test(divider)) return null;

  const head = splitRow(header);
  const align = splitRow(divider).map((cell) => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    if (left) return 'left';
    return null;
  });
  if (head.length !== align.length) return null;

  const rows = [];
  let i = start + 2;
  while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
    const cells = splitRow(lines[i]);
    // 칸 수가 모자라거나 남아도 표는 유지한다 — 빈 칸으로 채우고 넘치면 버린다.
    while (cells.length < head.length) cells.push('');
    rows.push(cells.slice(0, head.length).map(parseInline));
    i += 1;
  }

  return {
    block: { type: 'table', head: head.map(parseInline), align, rows },
    next: i,
  };
}

/** `\|` 는 칸 구분이 아니라 글자다. */
function splitRow(line) {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells = [];
  let cell = '';
  for (let i = 0; i < trimmed.length; i += 1) {
    if (trimmed[i] === '\\' && trimmed[i + 1] === '|') { cell += '|'; i += 1; continue; }
    if (trimmed[i] === '|') { cells.push(cell.trim()); cell = ''; continue; }
    cell += trimmed[i];
  }
  cells.push(cell.trim());
  return cells;
}

function parseList(lines, start) {
  const first = BULLET.exec(lines[start]);
  const baseIndent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const startNumber = ordered ? Number.parseInt(first[2], 10) : 1;

  const items = [];
  let current = null;
  let i = start;
  let loose = false;
  let blanks = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      // 빈 줄 하나는 항목 사이 여백일 수 있다. 다음 줄을 보고 판단한다.
      const next = lines[i + 1] ?? '';
      const continues = next.trim() && (BULLET.test(next) ? BULLET.exec(next)[1].length >= baseIndent : indentOf(next) > baseIndent);
      if (!continues) break;
      blanks += 1;
      if (current) current.lines.push('');
      i += 1;
      continue;
    }

    const bullet = BULLET.exec(line);
    const indent = indentOf(line);

    if (bullet && bullet[1].length <= baseIndent + 1) {
      if (blanks > 0 && items.length > 0) loose = true;
      blanks = 0;
      current = { lines: [bullet[3]] };
      items.push(current);
      i += 1;
      continue;
    }

    if (current && indent > baseIndent) {
      // 항목에 딸린 줄(중첩 목록·이어지는 문단·코드). 들여쓰기를 벗겨 다시 파싱한다.
      current.lines.push(line.slice(Math.min(indent, baseIndent + 2)));
      blanks = 0;
      i += 1;
      continue;
    }

    if (current && !bullet && blanks === 0) {
      // 들여쓰기 없이 이어 쓴 줄도 그 항목의 것으로 본다.
      current.lines.push(line.trim());
      i += 1;
      continue;
    }

    break;
  }

  return {
    block: {
      type: 'list',
      ordered,
      start: startNumber,
      loose,
      items: items.map((item) => ({ blocks: parseBlocks(item.lines) })),
    },
    next: i,
  };
}

function indentOf(line) {
  return /^\s*/.exec(line)[0].length;
}

// ─────────────────────────────────────────── DOM 그리기

/**
 * 마크다운을 DocumentFragment 로 그린다.
 * `doc` 을 받는 것은 시험에서 가짜 document 를 넣기 위해서다(브라우저에서는 생략).
 */
export function renderMarkdown(source, doc = globalThis.document) {
  const blocks = typeof source === 'string' ? parseMarkdown(source) : source;
  const fragment = doc.createDocumentFragment();
  for (const node of renderBlocks(blocks, doc)) fragment.appendChild(node);
  return fragment;
}

/** 자주 쓰는 모양: 요소를 비우고 그 안에 그린다. */
export function renderMarkdownInto(element, text, doc = globalThis.document) {
  while (element.firstChild) element.removeChild(element.firstChild);
  element.appendChild(renderMarkdown(text, doc));
  return element;
}

function renderBlocks(blocks, doc) {
  return blocks.map((block) => renderBlock(block, doc));
}

function renderBlock(block, doc) {
  switch (block.type) {
    case 'heading': {
      const el = doc.createElement(`h${Math.min(block.level + 2, 6)}`);
      // 게시판 카드 제목이 h3 이므로 본문 제목은 그 아래 단계로 민다.
      el.setAttribute('data-level', String(block.level));
      appendInline(el, block.inline, doc);
      return el;
    }
    case 'code': {
      const pre = doc.createElement('pre');
      const code = doc.createElement('code');
      if (block.lang) code.setAttribute('data-lang', block.lang);
      code.appendChild(doc.createTextNode(block.text));
      pre.appendChild(code);
      return pre;
    }
    case 'hr':
      return doc.createElement('hr');
    case 'quote': {
      const el = doc.createElement('blockquote');
      for (const child of renderBlocks(block.blocks, doc)) el.appendChild(child);
      return el;
    }
    case 'list': {
      const el = doc.createElement(block.ordered ? 'ol' : 'ul');
      if (block.ordered && block.start !== 1) el.setAttribute('start', String(block.start));
      for (const item of block.items) {
        const li = doc.createElement('li');
        // 문단 하나뿐인 항목은 <p> 로 감싸지 않는다(줄 간격이 벌어지지 않게).
        if (!block.loose && item.blocks.length === 1 && item.blocks[0].type === 'para') {
          appendInline(li, item.blocks[0].inline, doc);
        } else {
          for (const child of renderBlocks(item.blocks, doc)) li.appendChild(child);
        }
        el.appendChild(li);
      }
      return el;
    }
    case 'table': {
      const table = doc.createElement('table');
      const thead = doc.createElement('thead');
      const headRow = doc.createElement('tr');
      block.head.forEach((cell, index) => {
        const th = doc.createElement('th');
        if (block.align[index]) th.setAttribute('align', block.align[index]);
        appendInline(th, cell, doc);
        headRow.appendChild(th);
      });
      thead.appendChild(headRow);
      table.appendChild(thead);

      const tbody = doc.createElement('tbody');
      for (const row of block.rows) {
        const tr = doc.createElement('tr');
        row.forEach((cell, index) => {
          const td = doc.createElement('td');
          if (block.align[index]) td.setAttribute('align', block.align[index]);
          appendInline(td, cell, doc);
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);

      // 넓은 표가 카드를 밀어내지 않게 감싼다
      const wrap = doc.createElement('div');
      wrap.setAttribute('class', 'table-wrap');
      wrap.appendChild(table);
      return wrap;
    }
    default: {
      const el = doc.createElement('p');
      appendInline(el, block.inline, doc);
      return el;
    }
  }
}

function appendInline(parent, nodes, doc) {
  for (const node of nodes) parent.appendChild(renderInline(node, doc));
}

function renderInline(node, doc) {
  switch (node.type) {
    case 'code': {
      const el = doc.createElement('code');
      el.appendChild(doc.createTextNode(node.value));
      return el;
    }
    case 'strong':
    case 'em':
    case 'del': {
      const tag = node.type === 'strong' ? 'strong' : node.type === 'em' ? 'em' : 'del';
      const el = doc.createElement(tag);
      appendInline(el, node.children, doc);
      return el;
    }
    case 'link': {
      const el = doc.createElement('a');
      el.setAttribute('href', node.href);
      el.setAttribute('target', '_blank');
      el.setAttribute('rel', 'noopener noreferrer');
      appendInline(el, node.children, doc);
      return el;
    }
    case 'image': {
      const el = doc.createElement('img');
      el.setAttribute('src', node.src);
      el.setAttribute('alt', node.alt);
      el.setAttribute('loading', 'lazy');
      return el;
    }
    case 'br':
      return doc.createElement('br');
    default:
      return doc.createTextNode(node.value);
  }
}
