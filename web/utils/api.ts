/**
 * 执行 JSON API 请求,统一处理「非 2xx → 透出后端错误」。
 * 后端各路由在出错时返回 { error: '具体原因' },这里把它抽出来作为异常消息抛出,
 * 调用方 catch 后即可把后端校验/失败原因直接展示给用户,而不是千篇一律的「操作失败,请重试」。
 */
export interface ApiError extends Error {
  status?: number;
}

/**
 * 会话失效(401)后统一跳回登录页的一次性守卫:避免并发请求各自触发跳转。
 * 置位后页面即将卸载(跳转),后续请求不会再 assign。
 */
let authRedirected = false;

export async function apiJson<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  // 会话已失效:统一跳回登录页。否则接口静默 401、页面还停在「已登录」界面,
  // 用户以为操作成功、实则未生效,只能手动刷新才发现掉线。
  // 这里作为副作用直接跳转(在抛异常之前),调用方的 catch 即使吞掉异常也不影响跳转。
  if (res.status === 401) {
    if (!authRedirected) {
      authRedirected = true;
      globalThis.location.assign('/login');
    }
    const err = new Error('登录已过期，请重新登录') as ApiError;
    err.status = 401;
    throw err;
  }
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      // 非 JSON 响应体(纯文本错误页等),保留为 null,下方用状态码兜底
    }
  }
  if (!res.ok) {
    const obj = (data ?? {}) as { error?: unknown; message?: unknown };
    const msg =
      (typeof obj.error === 'string' && obj.error) ||
      (typeof obj.message === 'string' && obj.message) ||
      `请求失败 (${res.status})`;
    const err = new Error(msg) as ApiError;
    err.status = res.status;
    throw err;
  }
  return data as T;
}

/** 把异常转成给用户看的文案:优先用后端返回的具体原因,兜底用通用提示。 */
export function errText(e: unknown, fallback = '操作失败,请重试'): string {
  return e instanceof Error && e.message ? e.message : fallback;
}
