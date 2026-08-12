import { networkInterfaces } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BoardStore } from './store.ts';
import { createServer, isUsableToken } from './server.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const port = Number(process.env.BOARD_PORT ?? 8787);
const host = process.env.BOARD_HOST ?? '0.0.0.0';
const token = process.env.BOARD_TOKEN?.trim() || undefined;
const dataFile = process.env.BOARD_DATA
  ? resolve(process.env.BOARD_DATA)
  : join(root, 'data', 'board.db');

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`[board] BOARD_PORT 값이 잘못됐습니다: ${process.env.BOARD_PORT}`);
  process.exit(1);
}

if (token && !isUsableToken(token)) {
  console.error('[board] BOARD_TOKEN 은 공백 없는 ASCII 문자만 됩니다(한글·공백 불가).');
  process.exit(1);
}

/** 원격 PC 가 붙을 주소를 알려주려고 LAN IPv4 를 모은다. */
function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}

const store = new BoardStore(dataFile);
const server = createServer({ store, webDir: join(root, 'web'), token });

server.listen(port, host, () => {
  console.log(`[board] 저장 파일: ${dataFile}  (글 ${store.count}건, 커서 ${store.cursor})`);
  console.log(`[board] 로컬:   http://127.0.0.1:${port}/`);
  for (const address of lanAddresses()) {
    console.log(`[board] 원격 PC: http://${address}:${port}/`);
  }
  console.log(`[board] 토큰 인증: ${token ? '켜짐 (x-board-token 필요)' : '꺼짐 (내부망 개방)'}`);
  console.log('[board] 종료: Ctrl+C');
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[board] 포트 ${port} 가 이미 쓰이고 있습니다. BOARD_PORT 로 바꾸세요.`);
    process.exit(1);
  }
  throw err;
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log('\n[board] 종료합니다.');
    server.close(() => process.exit(0));
  });
}
