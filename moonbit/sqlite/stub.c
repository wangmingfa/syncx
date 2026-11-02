// sqlite3 C API 的最小 FFI 封装(ADR-0026 §2)。
// 约定:
//  - 句柄用 int64 承载(sqlite3* / sqlite3_stmt*),0 = 失败/空。
//  - 文本与二进制一律走 MoonBit Bytes + 显式长度,不做 char* 隐式约定;
//    C 侧需要 NUL 结尾的 API(open/exec/prepare)自行拷贝加终止符。
//  - 返回的文本/blob 在 C 侧用 moonbit_make_bytes 拷出,MoonBit 侧永远
//    拿到独立副本,不共享 sqlite 内部缓冲。
#include "moonbit.h"
#include "sqlite3.h"
#include <stdlib.h>
#include <string.h>

// 拷贝 moonbit bytes 并补 NUL,调用方负责 free;分配失败返回 NULL。
static char *dup_nul(const uint8_t *p, int32_t len) {
  char *out = (char *)malloc((size_t)len + 1);
  if (out == NULL) return NULL;
  if (len > 0) memcpy(out, p, (size_t)len);
  out[len] = '\0';
  return out;
}

long long c_sqlite3_open(const uint8_t *path, int32_t len) {
  char *cpath = dup_nul(path, len);
  if (cpath == NULL) return 0;
  sqlite3 *db = NULL;
  int rc = sqlite3_open_v2(cpath, &db,
                           SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_NOMUTEX,
                           NULL);
  free(cpath);
  if (rc != SQLITE_OK) {
    if (db != NULL) sqlite3_close(db);
    return 0;
  }
  sqlite3_busy_timeout(db, 5000);
  return (long long)db;
}

// 错误消息拷成 moonbit bytes(UTF-8),永远非 NULL。
moonbit_bytes_t c_sqlite3_errmsg(long long db) {
  const char *msg = sqlite3_errmsg((sqlite3 *)db);
  int32_t len = (int32_t)strlen(msg);
  moonbit_bytes_t out = moonbit_make_bytes(len, 0);
  if (len > 0) memcpy(out, msg, (size_t)len);
  return out;
}

// 返回 0 = OK,非 0 = sqlite 错误码;错误消息用 c_sqlite3_errmsg 取。
int32_t c_sqlite3_exec(long long db, const uint8_t *sql, int32_t len) {
  char *csql = dup_nul(sql, len);
  if (csql == NULL) return SQLITE_NOMEM;
  char *err = NULL;
  int rc = sqlite3_exec((sqlite3 *)db, csql, NULL, NULL, &err);
  if (err != NULL) sqlite3_free(err);
  free(csql);
  return rc;
}

// 返回 stmt 句柄,0 = 语法错误。
long long c_sqlite3_prepare(long long db, const uint8_t *sql, int32_t len) {
  char *csql = dup_nul(sql, len);
  if (csql == NULL) return 0;
  sqlite3_stmt *stmt = NULL;
  int rc = sqlite3_prepare_v2((sqlite3 *)db, csql, (int)len + 1, &stmt, NULL);
  free(csql);
  if (rc != SQLITE_OK) return 0;
  return (long long)stmt;
}

int32_t c_sqlite3_bind_int64(long long stmt, int32_t idx, long long v) {
  return sqlite3_bind_int64((sqlite3_stmt *)stmt, idx, v);
}

int32_t c_sqlite3_bind_double(long long stmt, int32_t idx, double v) {
  return sqlite3_bind_double((sqlite3_stmt *)stmt, idx, v);
}

int32_t c_sqlite3_bind_text(long long stmt, int32_t idx, const uint8_t *p, int32_t len) {
  return sqlite3_bind_text((sqlite3_stmt *)stmt, idx, (const char *)p, len, SQLITE_TRANSIENT);
}

int32_t c_sqlite3_bind_blob(long long stmt, int32_t idx, const uint8_t *p, int32_t len) {
  return sqlite3_bind_blob((sqlite3_stmt *)stmt, idx, p, len, SQLITE_TRANSIENT);
}

int32_t c_sqlite3_bind_null(long long stmt, int32_t idx) {
  return sqlite3_bind_null((sqlite3_stmt *)stmt, idx);
}

int32_t c_sqlite3_step(long long stmt) {
  return sqlite3_step((sqlite3_stmt *)stmt);
}

int32_t c_sqlite3_reset(long long stmt) {
  sqlite3_reset((sqlite3_stmt *)stmt);
  return sqlite3_clear_bindings((sqlite3_stmt *)stmt);
}

void c_sqlite3_finalize(long long stmt) {
  sqlite3_finalize((sqlite3_stmt *)stmt);
}

void c_sqlite3_close(long long db) {
  sqlite3_close_v2((sqlite3 *)db);
}

int32_t c_sqlite3_column_count(long long stmt) {
  return sqlite3_column_count((sqlite3_stmt *)stmt);
}

int32_t c_sqlite3_column_type(long long stmt, int32_t col) {
  return sqlite3_column_type((sqlite3_stmt *)stmt, col);
}

long long c_sqlite3_column_int64(long long stmt, int32_t col) {
  return sqlite3_column_int64((sqlite3_stmt *)stmt, col);
}

double c_sqlite3_column_double(long long stmt, int32_t col) {
  return sqlite3_column_double((sqlite3_stmt *)stmt, col);
}

// NULL 列返回空 Bytes;类型请先用 c_sqlite3_column_type 判。
moonbit_bytes_t c_sqlite3_column_text(long long stmt, int32_t col) {
  const unsigned char *p = sqlite3_column_text((sqlite3_stmt *)stmt, col);
  if (p == NULL) return moonbit_make_bytes(0, 0);
  int32_t len = sqlite3_column_bytes((sqlite3_stmt *)stmt, col);
  moonbit_bytes_t out = moonbit_make_bytes(len, 0);
  if (len > 0) memcpy(out, p, (size_t)len);
  return out;
}

moonbit_bytes_t c_sqlite3_column_blob(long long stmt, int32_t col) {
  const void *p = sqlite3_column_blob((sqlite3_stmt *)stmt, col);
  if (p == NULL) return moonbit_make_bytes(0, 0);
  int32_t len = sqlite3_column_bytes((sqlite3_stmt *)stmt, col);
  moonbit_bytes_t out = moonbit_make_bytes(len, 0);
  if (len > 0) memcpy(out, p, (size_t)len);
  return out;
}

long long c_sqlite3_changes(long long db) {
  return sqlite3_changes64((sqlite3 *)db);
}

long long c_sqlite3_last_insert_rowid(long long db) {
  return sqlite3_last_insert_rowid((sqlite3 *)db);
}
