import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseInline, parseMarkdown, renderMarkdown, safeUrl } from '../web/markdown.js';

/**
 * 브라우저 없이 렌더러를 시험하려고 아주 작은 가짜 document 를 만든다.
 * **innerHTML 이 없는 것이 핵심이다** — 렌더러가 그걸 쓰려 들면 여기서 바로 터진다.
 */
const VOID_TAGS = new Set(['br', 'hr', 'img']);

interface FakeNode {
  tag?: string;
  text?: string;
  attrs?: Record<string, string>;
  children: FakeNode[];
}

function createDoc() {
  const node = (tag: string): any => ({
    tag,
    attrs: {} as Record<string, string>,
    children: [] as any[],
    firstChild: null,
    appendChild(child: any) {
      this.children.push(child);
      this.firstChild = this.children[0];
      return child;
    },
    removeChild(child: any) {
      this.children = this.children.filter((item: any) => item !== child);
      this.firstChild = this.children[0] ?? null;
      return child;
    },
    setAttribute(name: string, value: string) {
      this.attrs[name] = value;
    },
  });

  return {
    createElement: (tag: string) => node(tag),
    createDocumentFragment: () => node('#fragment'),
    createTextNode: (text: string) => ({ text, children: [] }),
  };
}

/** 가짜 노드를 HTML 문자열로 되돌린다. 시험에서 눈으로 비교하기 위한 것. */
function html(node: any): string {
  if (node.text !== undefined) return node.text;
  const inner = node.children.map(html).join('');
  if (node.tag === '#fragment') return inner;
  const attrs = Object.entries(node.attrs ?? {})
    .map(([key, value]) => ` ${key}="${value}"`)
    .join('');
  if (VOID_TAGS.has(node.tag)) return `<${node.tag}${attrs}>`;
  return `<${node.tag}${attrs}>${inner}</${node.tag}>`;
}

function render(markdown: string): string {
  return html(renderMarkdown(markdown, createDoc() as any));
}

describe('parseMarkdown — 블록', () => {
  it('제목과 문단을 가른다', () => {
    const blocks = parseMarkdown('# 제목\n\n본문입니다.');
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].type, 'heading');
    assert.equal(blocks[0].level, 1);
    assert.equal(blocks[1].type, 'para');
  });

  it('울타리 코드 블록은 안쪽을 손대지 않는다', () => {
    const blocks = parseMarkdown('```ts\nconst a = **b**;\n# 제목 아님\n```');
    assert.equal(blocks.length, 1);
    assert.deepEqual(blocks[0], { type: 'code', lang: 'ts', text: 'const a = **b**;\n# 제목 아님' });
  });

  it('닫는 울타리가 없어도 끝까지 코드로 본다', () => {
    const blocks = parseMarkdown('```\n안 닫음');
    assert.equal(blocks[0].type, 'code');
    assert.equal(blocks[0].text, '안 닫음');
  });

  it('목록을 중첩까지 읽는다', () => {
    const blocks = parseMarkdown('- 하나\n- 둘\n  - 둘의 하나\n- 셋');
    assert.equal(blocks[0].type, 'list');
    assert.equal(blocks[0].ordered, false);
    assert.equal(blocks[0].items.length, 3);
    const nested = blocks[0].items[1].blocks;
    assert.equal(nested[0].type, 'para');
    assert.equal(nested[1].type, 'list');
    assert.equal(nested[1].items.length, 1);
  });

  it('번호 목록의 시작 번호를 지킨다', () => {
    const blocks = parseMarkdown('3. 셋\n4. 넷');
    assert.equal(blocks[0].ordered, true);
    assert.equal(blocks[0].start, 3);
  });

  it('표를 정렬 지정까지 읽는다', () => {
    const blocks = parseMarkdown('| 파일 | 상태 |\n| :--- | ---: |\n| a.ts | 완료 |\n| b.ts | 대기 |');
    assert.equal(blocks[0].type, 'table');
    assert.deepEqual(blocks[0].align, ['left', 'right']);
    assert.equal(blocks[0].rows.length, 2);
  });

  it('인용과 구분선을 읽는다', () => {
    const blocks = parseMarkdown('> 교훈: 먼저 검색한다\n\n---\n\n끝');
    assert.equal(blocks[0].type, 'quote');
    assert.equal(blocks[0].blocks[0].type, 'para');
    assert.equal(blocks[1].type, 'hr');
    assert.equal(blocks[2].type, 'para');
  });

  it('문단 중간에서 목록이 시작하면 거기서 끊는다', () => {
    const blocks = parseMarkdown('설명 문장\n- 항목');
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].type, 'para');
    assert.equal(blocks[1].type, 'list');
  });
});

describe('parseInline — 인라인', () => {
  it('굵게·기울임·취소선·코드', () => {
    const nodes = parseInline('**굵게** *기울임* ~~취소~~ `코드`');
    assert.deepEqual(nodes.map((node: any) => node.type), ['strong', 'text', 'em', 'text', 'del', 'text', 'code']);
  });

  it('밑줄은 낱말 가운데에서 기울임이 아니다', () => {
    const nodes = parseInline('slot_setup_front 는 파일명이다');
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0].type, 'text');
  });

  it('코드 스팬 안의 기호는 글자다', () => {
    const nodes = parseInline('`a * b * c`');
    assert.deepEqual(nodes, [{ type: 'code', value: 'a * b * c' }]);
  });

  it('역슬래시로 기호를 벗긴다', () => {
    assert.deepEqual(parseInline('\\*강조아님\\*'), [{ type: 'text', value: '*강조아님*' }]);
  });

  it('맨몸 URL 도 링크가 된다', () => {
    const nodes = parseInline('주소는 http://192.168.0.221:8787 입니다');
    assert.equal(nodes[1].type, 'link');
    assert.equal(nodes[1].href, 'http://192.168.0.221:8787');
  });
});

describe('safeUrl — 링크 검사', () => {
  it('http·https·mailto·상대경로는 통과', () => {
    assert.equal(safeUrl('https://example.com'), 'https://example.com');
    assert.equal(safeUrl('mailto:a@b.c'), 'mailto:a@b.c');
    assert.equal(safeUrl('/api/posts/abc.md'), '/api/posts/abc.md');
    assert.equal(safeUrl('#섹션'), '#섹션');
  });

  it('javascript·data 는 막는다', () => {
    assert.equal(safeUrl('javascript:alert(1)'), null);
    assert.equal(safeUrl('JAVASCRIPT:alert(1)'), null);
    assert.equal(safeUrl('data:text/html,<script>'), null);
    assert.equal(safeUrl('  '), null);
  });
});

describe('renderMarkdown — DOM', () => {
  it('제목은 카드 제목(h3) 아래 단계로 그린다', () => {
    assert.equal(render('# 큰 제목'), '<h3 data-level="1">큰 제목</h3>');
    assert.equal(render('### 작은 제목'), '<h5 data-level="3">작은 제목</h5>');
  });

  it('표는 가로 스크롤 상자로 감싼다', () => {
    const out = render('| a | b |\n| --- | --- |\n| 1 | 2 |');
    assert.match(out, /^<div class="table-wrap"><table>/);
    assert.match(out, /<th>a<\/th>/);
    assert.match(out, /<td>1<\/td>/);
  });

  it('링크는 새 창으로 열고 rel 을 붙인다', () => {
    assert.equal(
      render('[문서](https://example.com)'),
      '<p><a href="https://example.com" target="_blank" rel="noopener noreferrer">문서</a></p>',
    );
  });

  it('HTML 을 넣어도 태그가 아니라 글자로 남는다', () => {
    const out = render('<script>alert(1)</script>\n\n<img src=x onerror=alert(2)>');
    assert.equal(out, '<p><script>alert(1)</script></p><p><img src=x onerror=alert(2)></p>');
    // 실제 요소로 만들어진 것은 <p> 두 개뿐이다
    const fragment: any = renderMarkdown(
      '<script>alert(1)</script>\n\n<img src=x onerror=alert(2)>',
      createDoc() as any,
    );
    assert.deepEqual(fragment.children.map((node: any) => node.tag), ['p', 'p']);
  });

  it('위험한 스킴의 링크는 링크로 만들지 않는다', () => {
    assert.equal(render('[누르지마](javascript:alert(1))'), '<p>[누르지마](javascript:alert(1))</p>');
  });

  it('줄바꿈은 <br> 로 살린다 — 게시판 글은 손으로 줄을 끊어 쓴다', () => {
    assert.equal(render('첫 줄\n둘째 줄'), '<p>첫 줄<br>둘째 줄</p>');
  });

  it('코드 블록은 언어를 속성으로 남긴다', () => {
    assert.equal(render('```bash\ncurl -s "$BOARD_URL/api/health"\n```'),
      '<pre><code data-lang="bash">curl -s "$BOARD_URL/api/health"</code></pre>');
  });

  it('빈 본문도 터지지 않는다', () => {
    assert.equal(render(''), '');
  });
});
