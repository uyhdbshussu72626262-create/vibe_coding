// 把同步的 localStorage 风格接口桥接到异步的 SQLite 键值存储上：
// 启动时把需要的键读进内存，写入时先更新内存、再异步落库。

import type { FocusStorage } from './focus';

export interface AsyncKvStore {
  kvGet(key: string): Promise<string | null>;
  kvSet(key: string, value: string): Promise<void>;
}

export async function createKvFocusStorage(
  kv: AsyncKvStore,
  keys: string[],
): Promise<FocusStorage> {
  const cache = new Map<string, string>();
  await Promise.all(
    keys.map(async (key) => {
      try {
        const value = await kv.kvGet(key);
        if (value) cache.set(key, value);
      } catch {
        // 读取失败按空处理，不影响本次使用。
      }
    }),
  );

  const pending = new Map<string, number>();
  const flush = (key: string): void => {
    pending.delete(key);
    const value = cache.get(key);
    if (value === undefined) return;
    void kv.kvSet(key, value).catch(() => undefined);
  };

  return {
    getItem: (key: string) => cache.get(key) ?? null,
    setItem: (key: string, value: string) => {
      cache.set(key, value);
      // 合并写入：倒计时运行期间不会每秒都写数据库。
      if (!pending.has(key)) {
        pending.set(
          key,
          window.setTimeout(() => flush(key), 800),
        );
      }
    },
    removeItem: (key: string) => {
      cache.delete(key);
      void kv.kvSet(key, '').catch(() => undefined);
    },
  };
}
