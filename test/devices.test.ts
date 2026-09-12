import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { rmDir } from './helpers.js';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { addSharedFolder, removeSharedFolder, isPeerAllowed, addPeer, removePeer, acceptFolderInvitation } from '../src/devices.js';
import type { SharedFolderConfig } from '../src/config.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'syncx-devices-'));
}

describe('shared folder configuration', () => {
  it('adds a shared folder to an empty config', () => {
    const dir = tempDir();
    const configPath = join(dir, 'config.json');

    addSharedFolder(configPath, join(dir, 'docs'), ['DEV1234567']);

    const raw = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(raw.sharedFolders).toHaveLength(1);
    expect(raw.sharedFolders[0].devices).toEqual(['DEV1234567']);
    expect(raw.sharedFolders[0].id).toMatch(/^[0-9a-f]{12}$/);

    rmDir(dir);
  });

  it('auto-creates a missing folder path (recursively) and reports it', () => {
    const dir = tempDir();
    const configPath = join(dir, 'config.json');
    const nested = join(dir, 'deeply', 'nested', 'docs');

    const created = addSharedFolder(configPath, nested, ['DEV1234567']);

    expect(created).toBe(true);
    expect(existsSync(nested) && statSync(nested).isDirectory()).toBe(true);

    rmDir(dir);
  });

  it('does not recreate an existing folder and reports created=false', () => {
    const dir = tempDir();
    const configPath = join(dir, 'config.json');
    const docs = join(dir, 'docs');
    mkdirSync(docs);

    const created = addSharedFolder(configPath, docs, ['DEV1234567']);

    expect(created).toBe(false);

    rmDir(dir);
  });

  it('rejects a path that exists but is a file', () => {
    const dir = tempDir();
    const configPath = join(dir, 'config.json');
    const file = join(dir, 'not-a-dir');
    writeFileSync(file, 'x');

    expect(() => addSharedFolder(configPath, file, ['DEV1234567'])).toThrow('not a directory');

    rmDir(dir);
  });

  it('appends a shared folder to an existing config', () => {
    const dir = tempDir();
    const configPath = join(dir, 'config.json');
    addSharedFolder(configPath, join(dir, 'docs'), ['DEV1234567']);

    addSharedFolder(configPath, join(dir, 'photos'), ['DEV1234567', 'DEVABCDEFG']);

    const raw = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(raw.sharedFolders).toHaveLength(2);
    expect(raw.sharedFolders[1].devices).toEqual(['DEV1234567', 'DEVABCDEFG']);
    expect(raw.sharedFolders[1].id).toMatch(/^[0-9a-f]{12}$/);

    rmDir(dir);
  });

  it('collapses equivalent path spellings into one entry (normalize before dedup)', () => {
    const dir = tempDir();
    const configPath = join(dir, 'config.json');
    const base = join(dir, 'docs');
    mkdirSync(base);

    addSharedFolder(configPath, base, ['DEV1234567']);
    // 等价写法:尾斜杠(Windows 上 C:\a\b\、POSIX 上 /a/b/),应并到同一条目而非新增
    addSharedFolder(configPath, join(dir, 'docs', ''), ['DEVABCDEFG']);

    const raw = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(raw.sharedFolders).toHaveLength(1);
    expect(raw.sharedFolders[0].devices.sort()).toEqual(['DEV1234567', 'DEVABCDEFG']);
    // 存储路径被归一化(无尾斜杠),与 resolve 结果一致
    expect(raw.sharedFolders[0].path).toBe(resolve(base));

    rmDir(dir);
  });

  it('removes a shared folder by path', () => {
    const dir = tempDir();
    const configPath = join(dir, 'config.json');
    addSharedFolder(configPath, join(dir, 'docs'), ['DEV1234567']);
    addSharedFolder(configPath, join(dir, 'photos'), ['DEV1234567']);

    removeSharedFolder(configPath, join(dir, 'docs'));

    const raw = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(raw.sharedFolders).toHaveLength(1);
    expect(raw.sharedFolders[0].path).toBe(join(dir, 'photos'));
    expect(raw.sharedFolders[0].id).toMatch(/^[0-9a-f]{12}$/);

    rmDir(dir);
  });

  it('rejects a relative path', () => {
    const dir = tempDir();
    const configPath = join(dir, 'config.json');

    expect(() => addSharedFolder(configPath, 'relative/path', ['DEV1234567'])).toThrow('must be absolute');
    expect(() => addSharedFolder(configPath, './relative', ['DEV1234567'])).toThrow('must be absolute');

    rmDir(dir);
  });

  it('rejects system and privacy-sensitive paths (platform-aware)', () => {
    const dir = tempDir();
    const configPath = join(dir, 'config.json');
    const forbidden =
      process.platform === 'win32'
        ? [
            join(homedir(), '.ssh'),
            join(homedir(), 'AppData', 'Roaming', '.ssh'),
            join(homedir(), 'AppData', 'Roaming', '.aws'),
            join(process.env.SystemRoot ?? 'C:\\Windows'),
            join(process.env.ProgramData ?? 'C:\\ProgramData'),
          ]
        : [
            '/etc',
            '/etc/nginx',
            '/usr/local',
            '/root/.ssh',
            '/home/user/.ssh',
            '/home/user/.gnupg',
            // .ssh2 等变体名不得绕过黑名单(用 (\/|$) 收尾而非 \b)
            '/home/user/.ssh2',
            '/home/user/.ssh2/keys',
            '/home/user/.aws',
            '/home/user/.kube',
            '/home/user/.docker',
            '/home/user/.local',
            '/home/user/.cache',
          ];
    for (const p of forbidden) {
      expect(() => addSharedFolder(configPath, p, ['DEV1234567'])).toThrow('not allowed');
    }
    rmDir(dir);
  });

  it('rejects two shared folders sharing the same folder id at different paths', () => {
    const dir = tempDir();
    const configPath = join(dir, 'config.json');
    addSharedFolder(configPath, join(dir, 'docs'), ['DEV1234567'], 'fid-1');
    // 同 id 不同 path:会导致两个索引库文件同名(版本向量交叉写)且 session-manager 按
    // folderId 建索引后者覆盖前者 → 一条目录静默失效。必须拒绝。
    expect(() => addSharedFolder(configPath, join(dir, 'photos'), ['DEV1234567'], 'fid-1')).toThrow(
      /already used by another shared folder/,
    );
    rmDir(dir);
  });
});

describe('isPeerAllowed', () => {
  const folders: SharedFolderConfig[] = [
    { path: '/docs', devices: ['AA', 'BB'] },
    { path: '/pics', devices: ['BB', 'CC'] },
  ];

  it('allows a peer matching any shared folder devices list', () => {
    expect(isPeerAllowed('AA', folders)).toBe(true);
    expect(isPeerAllowed('BB', folders)).toBe(true);
    expect(isPeerAllowed('CC', folders)).toBe(true);
  });

  it('rejects a peer not present in any devices list', () => {
    expect(isPeerAllowed('XX', folders)).toBe(false);
  });

  it('rejects when sharedFolders is empty', () => {
    expect(isPeerAllowed('AA', [])).toBe(false);
  });

  it('allows a pasted known device even with no shared folders (Syncthing-style device introduction)', () => {
    expect(isPeerAllowed('KK', [], [{ id: 'KK' }])).toBe(true);
    // 未知设备仍拒绝
    expect(isPeerAllowed('ZZ', [], [{ id: 'KK' }])).toBe(false);
    // 未传 knownDevices 时退回仅目录授权(空 knownDevices 默认拒绝)
    expect(isPeerAllowed('KK', [])).toBe(false);
  });

  it('rejects empty peer id', () => {
    expect(isPeerAllowed('', folders)).toBe(false);
  });
});

describe('manual peer address (addPeer)', () => {
  it('appends a ws:// peer address to config.peers', () => {
    const dir = tempDir();
    const configPath = join(dir, 'config.json');

    addPeer(configPath, 'ws://10.13.18.36:22000');

    const raw = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(raw.peers).toEqual(['ws://10.13.18.36:22000']);

    rmDir(dir);
  });

  it('is idempotent for the same address', () => {
    const dir = tempDir();
    const configPath = join(dir, 'config.json');

    addPeer(configPath, 'ws://172.25.48.139:22000');
    addPeer(configPath, 'ws://172.25.48.139:22000');

    const raw = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(raw.peers).toEqual(['ws://172.25.48.139:22000']);

    rmDir(dir);
  });

  it('treats ::ffff:-mapped IPv6 form as equivalent to plain IPv4 (normalized on write)', () => {
    const dir = tempDir();
    const configPath = join(dir, 'config.json');

    // 入站反向发现学到 ::ffff: 形式(旧版遗留场景),手动又填了纯 IPv4:应合并为一条
    addPeer(configPath, 'ws://[::ffff:10.13.18.36]:22000');
    addPeer(configPath, 'ws://10.13.18.36:22000');

    const raw = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(raw.peers).toEqual(['ws://10.13.18.36:22000']);

    rmDir(dir);
  });

  it('rejects a non-ws:// address', () => {
    const dir = tempDir();
    const configPath = join(dir, 'config.json');

    expect(() => addPeer(configPath, 'http://10.13.18.36:22000')).toThrow('ws://');
    expect(() => addPeer(configPath, '10.13.18.36:22000')).toThrow('ws://');

    rmDir(dir);
  });

  it('removePeer deletes the exact address and is idempotent', () => {
    const dir = tempDir();
    const configPath = join(dir, 'config.json');

    addPeer(configPath, 'ws://10.13.18.36:22000');
    addPeer(configPath, 'ws://172.25.48.139:22000');

    removePeer(configPath, 'ws://10.13.18.36:22000');
    let raw = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(raw.peers).toEqual(['ws://172.25.48.139:22000']);

    // 幂等:删除不存在的地址不应报错,也不改变配置
    removePeer(configPath, 'ws://10.13.18.36:22000');
    raw = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(raw.peers).toEqual(['ws://172.25.48.139:22000']);

    rmDir(dir);
  });

  describe('shared folder mount must not nest (any source)', () => {
    it('rejects a received mount nested inside another received folder', () => {
      const dir = tempDir();
      const configPath = join(dir, 'config.json');
      const D = join(dir, 'D');
      const C = join(D, 'C');
      mkdirSync(C, { recursive: true });

      addSharedFolder(configPath, D, ['peer'], 'fd', true);
      expect(() => addSharedFolder(configPath, C, ['peer'], 'fc', true)).toThrow(/must not nest/);

      rmDir(dir);
    });

    it('rejects a received mount containing another received folder (either order)', () => {
      const dir = tempDir();
      const configPath = join(dir, 'config.json');
      const D = join(dir, 'D');
      const C = join(D, 'C');
      mkdirSync(C, { recursive: true });

      // 反向顺序:先加内部的 C,再加外层的 D
      addSharedFolder(configPath, C, ['peer'], 'fc', true);
      expect(() => addSharedFolder(configPath, D, ['peer'], 'fd', true)).toThrow(/must not nest/);

      rmDir(dir);
    });

    it('rejects nested mounts for local/own shared folders too (bidirectional sharing)', () => {
      const dir = tempDir();
      const configPath = join(dir, 'config.json');
      const A = join(dir, 'A');
      const B = join(A, 'child');
      mkdirSync(B, { recursive: true });

      // 不传 remote(本机自有共享),嵌套父+子目录同样拒绝:共享是双向的,
      // 本机嵌套在对方侧即表现为接收映射嵌套,会产生重复订阅与同步歧义。
      addSharedFolder(configPath, A, ['peer'], 'fa');
      expect(() => addSharedFolder(configPath, B, ['peer'], 'fb')).toThrow(/must not nest/);

      rmDir(dir);
    });

    it('rejects a local folder nested inside a received folder (mixed source)', () => {
      const dir = tempDir();
      const configPath = join(dir, 'config.json');
      const D = join(dir, 'D');
      const C = join(D, 'C');
      mkdirSync(C, { recursive: true });

      // 先接收映射 D,再本机 add 内部 C:混合来源嵌套同样拒绝
      addSharedFolder(configPath, D, ['peer'], 'fd', true);
      expect(() => addSharedFolder(configPath, C, ['peer'], 'fc')).toThrow(/must not nest/);

      rmDir(dir);
    });

    it('merges an exact-duplicate path instead of rejecting (any source)', () => {
      const dir = tempDir();
      const configPath = join(dir, 'config.json');
      const D = join(dir, 'D');
      mkdirSync(D, { recursive: true });

      addSharedFolder(configPath, D, ['p1'], 'fd', true);
      expect(() => addSharedFolder(configPath, D, ['p2'], 'fd', true)).not.toThrow();

      const raw = JSON.parse(readFileSync(configPath, 'utf8'));
      expect(raw.sharedFolders).toHaveLength(1);
      expect(raw.sharedFolders[0].devices).toEqual(['p1', 'p2']);

      rmDir(dir);
    });
  });
});

describe('acceptFolderInvitation', () => {
  it('reuses an existing local folder with the same id (no localPath needed)', () => {
    const dir = tempDir();
    const configPath = join(dir, 'config.json');
    addSharedFolder(configPath, join(dir, 'docs'), ['DEV1234567'], 'fid-x');
    acceptFolderInvitation(configPath, 'fid-x', 'PEER2');
    const raw = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(raw.sharedFolders).toHaveLength(1);
    expect(raw.sharedFolders[0].devices).toEqual(expect.arrayContaining(['DEV1234567', 'PEER2']));
    rmDir(dir);
  });

  it('aligns a same-path folder to the offered id instead of keeping the wrong id', () => {
    const dir = tempDir();
    const configPath = join(dir, 'config.json');
    const docsPath = join(dir, 'docs');
    // B 本机已有该目录但 id 不同(各自独立创建):接受邀请时必须把 id 对齐成对方的 folderId,
    // 否则对端按 folderId 推送会找不到本机目录(旧逻辑静默不同步)。
    addSharedFolder(configPath, docsPath, ['DEV1234567'], 'local-id');
    acceptFolderInvitation(configPath, 'remote-id', 'PEER2', docsPath);
    const raw = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(raw.sharedFolders).toHaveLength(1);
    expect(raw.sharedFolders[0].id).toBe('remote-id');
    expect(raw.sharedFolders[0].path).toBe(resolve(docsPath));
    expect(raw.sharedFolders[0].devices).toContain('PEER2');
    expect(raw.sharedFolders[0].remote).toBe(true);
    rmDir(dir);
  });

  it('creates a new folder with the offered id when the path is new', () => {
    const dir = tempDir();
    const configPath = join(dir, 'config.json');
    const docsPath = join(dir, 'docs');
    acceptFolderInvitation(configPath, 'remote-id', 'PEER2', docsPath);
    const raw = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(raw.sharedFolders).toHaveLength(1);
    expect(raw.sharedFolders[0].id).toBe('remote-id');
    expect(raw.sharedFolders[0].path).toBe(resolve(docsPath));
    expect(raw.sharedFolders[0].remote).toBe(true);
    rmDir(dir);
  });

  it('requires a local path when no matching folder exists', () => {
    const dir = tempDir();
    const configPath = join(dir, 'config.json');
    expect(() => acceptFolderInvitation(configPath, 'remote-id', 'PEER2')).toThrow(/local path is required/);
    rmDir(dir);
  });

  it('routes by folder id even when a different local path is supplied (no duplicate id created)', () => {
    const dir = tempDir();
    const configPath = join(dir, 'config.json');
    const docsPath = join(dir, 'docs');
    const photosPath = join(dir, 'photos');
    mkdirSync(docsPath, { recursive: true });
    mkdirSync(photosPath, { recursive: true });
    addSharedFolder(configPath, docsPath, ['DEV1234567'], 'fid-1');
    // 用户填了 photosPath,但本机 docs 已是 fid-1 → 应按 id 复用 docs,而非用 photosPath 新建重复条目
    acceptFolderInvitation(configPath, 'fid-1', 'PEER2', photosPath);
    const raw = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(raw.sharedFolders).toHaveLength(1);
    expect(raw.sharedFolders[0].id).toBe('fid-1');
    expect(raw.sharedFolders[0].path).toBe(resolve(docsPath));
    expect(raw.sharedFolders[0].devices).toContain('PEER2');
    rmDir(dir);
  });
});
