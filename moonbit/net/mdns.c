/*
 * syncx mDNS 胶水层(ADR-0026 §2「mDNS」项)。
 *
 * 上游 https://github.com/mjansson/mdns 是 **单头库**(mdns.h 全部 static inline,
 * 公有领域 / Unlicense,协议见 mdns.h 顶部注释),只提供报文构造与解析原语;
 * socket 事件循环由官方示例 main 程序自带,不随库分发。本文件即按任务约定的
 * 「最小子集」自写这部分封装:响应端 advertise + 查询端 browse,配套一个
 * 后台线程跑组播收发,MoonBit 侧只通过下面几个 `syncx_mdns_*` C 符号交互:
 *
 *   syncx_mdns_start / stop / kick / poll / build_announce / verify_announce / msleep
 *
 * 服务记录格式(与 Node `src/net/discovery.ts`、Rust `rust/.../discovery.rs` 对齐):
 *   - 服务名:         _syncx._tcp.local.
 *   - 实例名:         <device_id>._syncx._tcp.local.(Rust/mdns-sd 形态)
 *   - 服务级 SRV/TXT: name=_syncx._tcp.local.,TTL=120(Node 形态;TXT 为 deviceId=<id>)
 *   - 实例级 SRV/TXT: 挂在实例名下并带 cache-flush 位,供 mdns-sd 对端解析
 *   - 广播包 answer 节放 PTR(服务名→实例),additional 节放实例级 SRV/TXT
 *
 * 与 Node 的两点刻意差异沿用 Node/Rust 的既有语义:对端地址取发包源 IP,不解析
 * SRV target 为 IP;30 秒周期重播 + 主动查询(启动头 5 轮每秒一次,便于测试与
 * 快速收敛)。
 *
 * This file is provided under the same public domain (Unlicense) terms as the
 * vendored mdns.h; see the LICENSE text at the top of mdns.h.
 */

#ifdef _WIN32
#define _CRT_SECURE_NO_WARNINGS 1
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#else
#include <pthread.h>
#include <unistd.h>
#include <sys/select.h>
#include <sys/time.h>
#include <time.h>
#endif
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <stdint.h>

#include "mdns.h"

#define SYNCX_SERVICE_NAME "_syncx._tcp.local."
#define SYNCX_TTL_SECONDS 120
#define SYNCX_ANNOUNCE_INTERVAL_MS 30000
#define SYNCX_STARTUP_INTERVAL_MS 1000
#define SYNCX_STARTUP_BURST 5
#define SYNCX_QUEUE_CAPACITY 32
#define SYNCX_PKT_CAPACITY 2048
#define SYNCX_HOSTNAME_CAP 64
#define SYNCX_NAME_CAP 128
#define SYNCX_ID_LEN 10

typedef struct {
	char device_id[SYNCX_ID_LEN + 1];
	char host[SYNCX_HOSTNAME_CAP];
	uint16_t port;
	char address[48];
} syncx_peer_record_t;

typedef struct {
	int sock;
	int running;
	uint16_t port;
	char device_id[SYNCX_ID_LEN + 1];
	char hostname[SYNCX_HOSTNAME_CAP];
	char instance[SYNCX_ID_LEN + 32];    /* <device_id>._syncx._tcp.local. */
	char target[SYNCX_HOSTNAME_CAP + 8]; /* <hostname>.local. */
	syncx_peer_record_t queue[SYNCX_QUEUE_CAPACITY];
	int queue_head;
	int queue_count;
	void* mutex;
#ifdef _WIN32
	HANDLE thread;
#else
	pthread_t thread;
#endif
} syncx_mdns_t;

/* 回放一次收包时收集到的 SRV/TXT 结果(每个 mDNS 包一个实例) */
typedef struct {
	char address[48];
	int has_srv;
	uint16_t srv_port;
	char srv_target[SYNCX_NAME_CAP];
	char srv_name[SYNCX_NAME_CAP];
	int has_txt;
	char txt_value[SYNCX_ID_LEN + 1];
} syncx_parse_ctx_t;

/* ==================== 平台原语(锁 / 线程) ==================== */

static void
syncx_mutex_init(void** m) {
#ifdef _WIN32
	*m = malloc(sizeof(CRITICAL_SECTION));
	if (*m)
		InitializeCriticalSection((CRITICAL_SECTION*)*m);
#else
	*m = malloc(sizeof(pthread_mutex_t));
	if (*m)
		pthread_mutex_init((pthread_mutex_t*)*m, 0);
#endif
}

static void
syncx_mutex_lock(void** m) {
	if (!*m)
		return;
#ifdef _WIN32
	EnterCriticalSection((CRITICAL_SECTION*)*m);
#else
	pthread_mutex_lock((pthread_mutex_t*)*m);
#endif
}

static void
syncx_mutex_unlock(void** m) {
	if (!*m)
		return;
#ifdef _WIN32
	LeaveCriticalSection((CRITICAL_SECTION*)*m);
#else
	pthread_mutex_unlock((pthread_mutex_t*)*m);
#endif
}

static void
syncx_mutex_destroy(void** m) {
	if (!*m)
		return;
#ifdef _WIN32
	DeleteCriticalSection((CRITICAL_SECTION*)*m);
	free(*m);
	*m = 0;
#else
	pthread_mutex_destroy((pthread_mutex_t*)*m);
	free(*m);
	*m = 0;
#endif
}

static uint64_t
syncx_now_ms(void) {
#ifdef _WIN32
	return (uint64_t)GetTickCount64();
#else
	struct timeval tv;
	gettimeofday(&tv, 0);
	return (uint64_t)tv.tv_sec * 1000 + (uint64_t)tv.tv_usec / 1000;
#endif
}

/* Windows 需要 WSAStartup 才能用 socket(简单引用计数) */
static int
syncx_wsa_init(void) {
#ifdef _WIN32
	static WSADATA wsa;
	static int started = 0;
	if (!started) {
		if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0)
			return 0;
	}
	++started;
#endif
	return 1;
}

static void
syncx_wsa_fini(void) {
#ifdef _WIN32
	WSACleanup();
#endif
}

/* ==================== 小工具 ==================== */

static int
syncx_ascii_lower(int c) {
	if (c >= 'A' && c <= 'Z')
		return c + ('a' - 'A');
	return c;
}

/* 大小写不敏感的全串比较(b 为 NUL 结尾的字面量) */
static int
syncx_ieq(const char* a, size_t alen, const char* b) {
	size_t blen = strlen(b);
	if (alen != blen)
		return 0;
	for (size_t i = 0; i < alen; ++i) {
		if (syncx_ascii_lower((unsigned char)a[i]) != syncx_ascii_lower((unsigned char)b[i]))
			return 0;
	}
	return 1;
}

/* 判定 Device ID 形状:10 个 base32 字符 [A-Z2-7](与 Node 正则同一判据) */
static int
syncx_is_device_id(const char* s, size_t len) {
	if (len != SYNCX_ID_LEN)
		return 0;
	for (size_t i = 0; i < len; ++i) {
		char c = s[i];
		if (!((c >= 'A' && c <= 'Z') || (c >= '2' && c <= '7')))
			return 0;
	}
	return 1;
}

/* name 是 `_syncx._tcp.local.` 或 `<id>._syncx._tcp.local.`(不区分大小写) */
static int
syncx_name_is_service_or_instance(const char* name, size_t len) {
	static const char suffix[] = "._syncx._tcp.local.";
	size_t suffix_len = sizeof(suffix) - 1;
	if (syncx_ieq(name, len, SYNCX_SERVICE_NAME))
		return 1;
	if (len < suffix_len)
		return 0;
	if (!syncx_ieq(name + (len - suffix_len), suffix_len, suffix))
		return 0;
	return syncx_is_device_id(name, len - suffix_len);
}

static void
syncx_format_from(const struct sockaddr* from, size_t addrlen, char* out, size_t cap) {
	out[0] = 0;
	if (!from)
		return;
	if (from->sa_family == AF_INET && addrlen >= sizeof(struct sockaddr_in)) {
		const struct sockaddr_in* sin = (const struct sockaddr_in*)from;
		const unsigned char* b = (const unsigned char*)&sin->sin_addr.s_addr;
		snprintf(out, cap, "%u.%u.%u.%u", b[0], b[1], b[2], b[3]);
	}
}

static uint16_t
syncx_from_port(const struct sockaddr* from, size_t addrlen) {
	if (!from)
		return 0;
	if (from->sa_family == AF_INET && addrlen >= sizeof(struct sockaddr_in))
		return ntohs(((const struct sockaddr_in*)from)->sin_port);
	return 0;
}

/* ==================== 报文构造 ==================== */

/* 规范化 SRV target:去结尾的点;hostname 已带 .local 后缀时不重复加
 * (macOS 的 gethostname() 返回的就是 `xxx.local`)。Node 用 os.hostname() 原样,
 * 这里与 Node 对齐。 */
static void
syncx_make_target(const char* hostname, char* out, size_t cap) {
	char host[SYNCX_HOSTNAME_CAP];
	size_t hlen = strlen(hostname);
	if (hlen >= sizeof(host)) {
		out[0] = 0;
		return;
	}
	memcpy(host, hostname, hlen + 1);
	while (hlen && host[hlen - 1] == '.')
		host[--hlen] = 0;
	if (hlen > 6 && syncx_ieq(host + (hlen - 6), 6, ".local"))
		snprintf(out, cap, "%s.", host);
	else
		snprintf(out, cap, "%s.local.", host);
}

/* 序列化单条记录(支持本层用到的 PTR/SRV/TXT),失败返回 0 */
static void*
syncx_write_record(void* buffer, size_t capacity, void* data, mdns_string_table_t* table,
                   mdns_record_t record) {
	data = mdns_string_make(buffer, capacity, data, record.name.str, record.name.length, table);
	if (!data)
		return 0;
	size_t remain = capacity - MDNS_POINTER_DIFF(data, buffer);
	if (remain < 10)
		return 0;
	data = mdns_htons(data, record.type);
	data = mdns_htons(data, record.rclass);
	data = mdns_htonl(data, record.ttl);
	void* record_length = data;
	data = mdns_htons(data, 0);
	void* record_data = data;

	switch (record.type) {
		case MDNS_RECORDTYPE_PTR:
			data = mdns_string_make(buffer, capacity, data, record.data.ptr.name.str,
			                        record.data.ptr.name.length, table);
			break;
		case MDNS_RECORDTYPE_SRV:
			remain = capacity - MDNS_POINTER_DIFF(data, buffer);
			if (remain <= 6)
				return 0;
			data = mdns_htons(data, record.data.srv.priority);
			data = mdns_htons(data, record.data.srv.weight);
			data = mdns_htons(data, record.data.srv.port);
			data = mdns_string_make(buffer, capacity, data, record.data.srv.name.str,
			                        record.data.srv.name.length, table);
			break;
		case MDNS_RECORDTYPE_TXT: {
			const mdns_string_t* key = &record.data.txt.key;
			const mdns_string_t* value = &record.data.txt.value;
			size_t string_len = key->length + value->length + 1;
			remain = capacity - MDNS_POINTER_DIFF(data, buffer);
			if (remain < (string_len + 1))
				return 0;
			unsigned char* p = (unsigned char*)data;
			*p++ = (unsigned char)string_len;
			if (key->length)
				memcpy(p, key->str, key->length);
			p += key->length;
			*p++ = '=';
			if (value->length)
				memcpy(p, value->str, value->length);
			p += value->length;
			data = p;
			break;
		}
		default:
			return 0;
	}
	if (!data)
		return 0;
	mdns_htons(record_length, (uint16_t)MDNS_POINTER_DIFF(data, record_data));
	return data;
}

/*
 * 构造 announce/goodbye 包:
 *   answer(3):     PTR(服务名→实例) + SRV(服务名) + TXT(服务名, deviceId=)
 *   additional(2): SRV(实例名, cache-flush) + TXT(实例名, cache-flush)
 * Node 只发服务名上的 SRV/TXT;PTR 与实例级记录是给 mdns-sd(Rust 对端)的。
 * 返回包长,失败返回 0。
 */
static size_t
syncx_build_announce_packet(const char* device_id, const char* hostname, uint16_t port,
                            uint32_t ttl, void* buffer, size_t capacity) {
	char instance[SYNCX_ID_LEN + 32];
	char target[SYNCX_HOSTNAME_CAP + 8];
	if (strlen(device_id) != SYNCX_ID_LEN || !hostname[0])
		return 0;
	snprintf(instance, sizeof(instance), "%s.%s", device_id, SYNCX_SERVICE_NAME);
	syncx_make_target(hostname, target, sizeof(target));

	mdns_string_t service;
	service.str = SYNCX_SERVICE_NAME;
	service.length = sizeof(SYNCX_SERVICE_NAME) - 1;
	mdns_string_t instance_str;
	instance_str.str = instance;
	instance_str.length = strlen(instance);
	mdns_string_t target_str;
	target_str.str = target;
	target_str.length = strlen(target);
	mdns_string_t key;
	key.str = "deviceId";
	key.length = 8;
	mdns_string_t value;
	value.str = device_id;
	value.length = SYNCX_ID_LEN;

	if (capacity < sizeof(struct mdns_header_t))
		return 0;
	struct mdns_header_t* header = (struct mdns_header_t*)buffer;
	header->query_id = 0;
	header->flags = htons(0x8400); /* authoritative answer,无 question */
	header->questions = 0;
	header->answer_rrs = htons(3);
	header->authority_rrs = 0;
	header->additional_rrs = htons(2);

	mdns_string_table_t table;
	memset(&table, 0, sizeof(table));
	void* data = MDNS_POINTER_OFFSET(buffer, sizeof(struct mdns_header_t));
	mdns_record_t rec;
	memset(&rec, 0, sizeof(rec));

	/* 0: PTR 服务名 → 实例名(共享记录,不带 cache-flush) */
	rec.name = service;
	rec.type = MDNS_RECORDTYPE_PTR;
	rec.rclass = MDNS_CLASS_IN;
	rec.ttl = ttl;
	rec.data.ptr.name = instance_str;
	data = syncx_write_record(buffer, capacity, data, &table, rec);
	if (!data)
		return 0;

	/* 1: SRV 服务名(Node 形态) */
	rec.name = service;
	rec.type = MDNS_RECORDTYPE_SRV;
	rec.rclass = MDNS_CLASS_IN;
	rec.ttl = ttl;
	rec.data.srv.priority = 0;
	rec.data.srv.weight = 0;
	rec.data.srv.port = port;
	rec.data.srv.name = target_str;
	data = syncx_write_record(buffer, capacity, data, &table, rec);
	if (!data)
		return 0;

	/* 2: TXT 服务名,deviceId=<id>(Node 形态) */
	rec.name = service;
	rec.type = MDNS_RECORDTYPE_TXT;
	rec.rclass = MDNS_CLASS_IN;
	rec.ttl = ttl;
	rec.data.txt.key = key;
	rec.data.txt.value = value;
	data = syncx_write_record(buffer, capacity, data, &table, rec);
	if (!data)
		return 0;

	/* 3: SRV 实例名(mdns-sd 形态,cache-flush) */
	rec.name = instance_str;
	rec.type = MDNS_RECORDTYPE_SRV;
	rec.rclass = MDNS_CLASS_IN | MDNS_CACHE_FLUSH;
	rec.ttl = ttl;
	rec.data.srv.priority = 0;
	rec.data.srv.weight = 0;
	rec.data.srv.port = port;
	rec.data.srv.name = target_str;
	data = syncx_write_record(buffer, capacity, data, &table, rec);
	if (!data)
		return 0;

	/* 4: TXT 实例名(mdns-sd 形态,cache-flush) */
	rec.name = instance_str;
	rec.type = MDNS_RECORDTYPE_TXT;
	rec.rclass = MDNS_CLASS_IN | MDNS_CACHE_FLUSH;
	rec.ttl = ttl;
	rec.data.txt.key = key;
	rec.data.txt.value = value;
	data = syncx_write_record(buffer, capacity, data, &table, rec);
	if (!data)
		return 0;

	return (size_t)MDNS_POINTER_DIFF(data, buffer);
}

static int
syncx_send_announce(syncx_mdns_t* svc, uint32_t ttl) {
	char buffer[SYNCX_PKT_CAPACITY];
	size_t n =
	    syncx_build_announce_packet(svc->device_id, svc->hostname, svc->port, ttl, buffer, sizeof(buffer));
	if (!n)
		return -1;
	return mdns_multicast_send(svc->sock, buffer, n);
}

/* 主动查询:PTR/SRV/TXT 各一条,全挂在服务名上 */
static int
syncx_send_browse_query(syncx_mdns_t* svc) {
	char buffer[SYNCX_PKT_CAPACITY];
	mdns_query_t queries[3];
	queries[0].type = MDNS_RECORDTYPE_PTR;
	queries[1].type = MDNS_RECORDTYPE_SRV;
	queries[2].type = MDNS_RECORDTYPE_TXT;
	for (int i = 0; i < 3; ++i) {
		queries[i].name = SYNCX_SERVICE_NAME;
		queries[i].length = sizeof(SYNCX_SERVICE_NAME) - 1;
	}
	return mdns_multiquery_send(svc->sock, queries, 3, buffer, sizeof(buffer), 0);
}

/* ==================== 收包解析 ==================== */

static int
syncx_collect_cb(int sock, const struct sockaddr* from, size_t addrlen, mdns_entry_type_t entry,
                 uint16_t query_id, uint16_t rtype, uint16_t rclass, uint32_t ttl, const void* data,
                 size_t size, size_t name_offset, size_t name_length, size_t record_offset,
                 size_t record_length, void* user_data) {
	(void)sock;
	(void)from;
	(void)addrlen;
	(void)query_id;
	(void)rclass;
	(void)ttl;
	(void)record_length;
	(void)name_length;
	syncx_parse_ctx_t* ctx = (syncx_parse_ctx_t*)user_data;
	if (entry != MDNS_ENTRYTYPE_ANSWER && entry != MDNS_ENTRYTYPE_ADDITIONAL)
		return 0;

	char name[SYNCX_NAME_CAP];
	size_t nofs = name_offset;
	mdns_string_t nm = mdns_string_extract(data, size, &nofs, name, sizeof(name) - 1);
	if (nm.length == 0 || nm.length >= sizeof(name))
		return 0;
	name[nm.length] = 0;
	if (!syncx_name_is_service_or_instance(name, nm.length))
		return 0;

	if (rtype == MDNS_RECORDTYPE_SRV && !ctx->has_srv) {
		mdns_record_srv_t srv = mdns_record_parse_srv(data, size, record_offset, record_length,
		                                              ctx->srv_target, sizeof(ctx->srv_target) - 1);
		if (srv.name.length == 0 || srv.name.length >= sizeof(ctx->srv_target))
			return 0;
		ctx->srv_target[srv.name.length] = 0;
		ctx->srv_port = srv.port;
		memcpy(ctx->srv_name, name, nm.length + 1);
		ctx->has_srv = 1;
	} else if (rtype == MDNS_RECORDTYPE_TXT && !ctx->has_txt) {
		mdns_record_txt_t txts[8];
		size_t count = mdns_record_parse_txt(data, size, record_offset, record_length, txts, 8);
		for (size_t i = 0; i < count; ++i) {
			if (!txts[i].value.str || txts[i].value.length != SYNCX_ID_LEN)
				continue;
			if (syncx_ieq(txts[i].key.str, txts[i].key.length, "deviceId") &&
			    syncx_is_device_id(txts[i].value.str, txts[i].value.length)) {
				memcpy(ctx->txt_value, txts[i].value.str, SYNCX_ID_LEN);
				ctx->txt_value[SYNCX_ID_LEN] = 0;
				ctx->has_txt = 1;
				break;
			}
		}
	}
	return 0;
}

/* 是否要回应这个 question:名字是本服务/本实例,类型是 PTR/SRV/TXT/ANY */
static int
syncx_should_respond(const char* name, size_t len, uint16_t rtype) {
	if (!syncx_name_is_service_or_instance(name, len))
		return 0;
	switch (rtype) {
		case MDNS_RECORDTYPE_PTR:
		case MDNS_RECORDTYPE_SRV:
		case MDNS_RECORDTYPE_TXT:
		case MDNS_RECORDTYPE_ANY:
			return 1;
		default:
			return 0;
	}
}

static void
syncx_push_peer(syncx_mdns_t* svc, const syncx_peer_record_t* rec) {
	syncx_mutex_lock(&svc->mutex);
	if (svc->queue_count < SYNCX_QUEUE_CAPACITY) {
		int tail = (svc->queue_head + svc->queue_count) % SYNCX_QUEUE_CAPACITY;
		svc->queue[tail] = *rec;
		++svc->queue_count;
	}
	syncx_mutex_unlock(&svc->mutex);
}

static void
syncx_handle_packet(syncx_mdns_t* svc, char* buffer, size_t size, const struct sockaddr* from,
                    size_t addrlen) {
	if (size < sizeof(struct mdns_header_t))
		return;
	const struct mdns_header_t* header = (const struct mdns_header_t*)buffer;
	uint16_t flags = mdns_ntohs(&header->flags);
	uint16_t questions = mdns_ntohs(&header->questions);
	uint16_t answer_rrs = mdns_ntohs(&header->answer_rrs);
	uint16_t authority_rrs = mdns_ntohs(&header->authority_rrs);
	uint16_t additional_rrs = mdns_ntohs(&header->additional_rrs);
	uint16_t query_id = mdns_ntohs(&header->query_id);
	int is_response = (flags & 0x8000) != 0;
	int wants_response = 0;
	int unicast_response = 0;

	/* question 节:判断是否需要回应 */
	size_t offset = sizeof(struct mdns_header_t);
	for (uint16_t i = 0; i < questions; ++i) {
		size_t name_offset = offset;
		if (!mdns_string_skip(buffer, size, &offset))
			return;
		if ((offset + 4) > size)
			return;
		char qname[SYNCX_NAME_CAP];
		size_t nofs = name_offset;
		mdns_string_t nm = mdns_string_extract(buffer, size, &nofs, qname, sizeof(qname) - 1);
		if (nm.length == 0 || nm.length >= sizeof(qname))
			return;
		qname[nm.length] = 0;
		uint16_t rtype = mdns_ntohs(MDNS_POINTER_OFFSET_CONST(buffer, offset));
		uint16_t rclass = mdns_ntohs(MDNS_POINTER_OFFSET_CONST(buffer, offset + 2));
		offset += 4;
		if (!is_response && syncx_should_respond(qname, nm.length, rtype)) {
			wants_response = 1;
			if (rclass & MDNS_UNICAST_RESPONSE)
				unicast_response = 1;
		}
	}

	/* answer/authority/additional 节:收集对端 SRV/TXT */
	syncx_parse_ctx_t ctx;
	memset(&ctx, 0, sizeof(ctx));
	syncx_format_from(from, addrlen, ctx.address, sizeof(ctx.address));
	size_t roffset = offset;
	size_t parsed;
	parsed = mdns_records_parse(svc->sock, from, addrlen, buffer, size, &roffset,
	                            MDNS_ENTRYTYPE_ANSWER, query_id, answer_rrs, syncx_collect_cb, &ctx);
	if (parsed == answer_rrs)
		parsed = mdns_records_parse(svc->sock, from, addrlen, buffer, size, &roffset,
		                            MDNS_ENTRYTYPE_AUTHORITY, query_id, authority_rrs,
		                            syncx_collect_cb, &ctx);
	if (parsed == authority_rrs)
		(void)mdns_records_parse(svc->sock, from, addrlen, buffer, size, &roffset,
		                         MDNS_ENTRYTYPE_ADDITIONAL, query_id, additional_rrs,
		                         syncx_collect_cb, &ctx);

	/* 回应查询:legacy 查询(源端口非 5353)单播回去,其余组播 */
	if (wants_response) {
		char out[SYNCX_PKT_CAPACITY];
		size_t n = syncx_build_announce_packet(svc->device_id, svc->hostname, svc->port,
		                                       SYNCX_TTL_SECONDS, out, sizeof(out));
		if (n) {
			if (unicast_response || syncx_from_port(from, addrlen) != MDNS_PORT)
				mdns_unicast_send(svc->sock, from, addrlen, out, n);
			else
				mdns_multicast_send(svc->sock, out, n);
		}
	}

	/* 上报对端:deviceId 优先取 TXT,退回实例名前缀(与 Rust 同一语义) */
	if (is_response && ctx.has_srv) {
		char id[SYNCX_ID_LEN + 1];
		int have_id = 0;
		if (ctx.has_txt) {
			memcpy(id, ctx.txt_value, SYNCX_ID_LEN + 1);
			have_id = 1;
		} else {
			static const char suffix[] = "._syncx._tcp.local.";
			size_t suffix_len = sizeof(suffix) - 1;
			size_t namelen = strlen(ctx.srv_name);
			if (namelen > suffix_len &&
			    syncx_is_device_id(ctx.srv_name, namelen - suffix_len)) {
				memcpy(id, ctx.srv_name, SYNCX_ID_LEN);
				id[SYNCX_ID_LEN] = 0;
				have_id = 1;
			}
		}
		if (have_id && strcmp(id, svc->device_id) != 0) {
			syncx_peer_record_t rec;
			memset(&rec, 0, sizeof(rec));
			memcpy(rec.device_id, id, SYNCX_ID_LEN);
			rec.device_id[SYNCX_ID_LEN] = 0;
			/* host:SRV target 去掉结尾的点(与 Node 的 `target.replace(/\.$/, '')` 一致) */
			size_t tlen = strlen(ctx.srv_target);
			if (tlen && ctx.srv_target[tlen - 1] == '.')
				--tlen;
			if (tlen >= sizeof(rec.host))
				tlen = sizeof(rec.host) - 1;
			memcpy(rec.host, ctx.srv_target, tlen);
			rec.host[tlen] = 0;
			rec.port = ctx.srv_port;
			memcpy(rec.address, ctx.address, sizeof(rec.address));
			syncx_push_peer(svc, &rec);
		}
	}
}

/* ==================== 后台线程 ==================== */

static void
syncx_thread_main(syncx_mdns_t* svc) {
	char buffer[SYNCX_PKT_CAPACITY];
	uint64_t next_action = 0; /* 立即先播一轮 */
	int ticks = 0;
	for (;;) {
		syncx_mutex_lock(&svc->mutex);
		int running = svc->running;
		syncx_mutex_unlock(&svc->mutex);
		if (!running)
			break;

		uint64_t now = syncx_now_ms();
		if (now >= next_action) {
			/* 启动头 5 轮每秒一次(收敛 + 测试友好),之后 30 秒一轮 */
			syncx_send_announce(svc, SYNCX_TTL_SECONDS);
			syncx_send_browse_query(svc);
			++ticks;
			next_action = now + ((ticks <= SYNCX_STARTUP_BURST) ? SYNCX_STARTUP_INTERVAL_MS
			                                                    : SYNCX_ANNOUNCE_INTERVAL_MS);
		}

		struct timeval tv;
		tv.tv_sec = 0;
		tv.tv_usec = 200 * 1000;
		fd_set fds;
		FD_ZERO(&fds);
		FD_SET(svc->sock, &fds);
		int ready = select(svc->sock + 1, &fds, 0, 0, &tv);
		if (ready > 0) {
			struct sockaddr_storage from;
			socklen_t addrlen = sizeof(from);
			memset(&from, 0, sizeof(from));
			mdns_ssize_t n =
			    recvfrom(svc->sock, buffer, sizeof(buffer), 0, (struct sockaddr*)&from, &addrlen);
			if (n > 0)
				syncx_handle_packet(svc, buffer, (size_t)n, (struct sockaddr*)&from, addrlen);
		}
	}
}

#ifdef _WIN32
static DWORD WINAPI
syncx_thread_entry(LPVOID arg) {
	syncx_thread_main((syncx_mdns_t*)arg);
	return 0;
}
static int
syncx_thread_start(syncx_mdns_t* svc) {
	svc->thread = CreateThread(NULL, 0, syncx_thread_entry, svc, 0, NULL);
	return svc->thread != NULL;
}
static void
syncx_thread_join(syncx_mdns_t* svc) {
	if (svc->thread) {
		WaitForSingleObject(svc->thread, INFINITE);
		CloseHandle(svc->thread);
		svc->thread = NULL;
	}
}
#else
static void*
syncx_thread_entry(void* arg) {
	syncx_thread_main((syncx_mdns_t*)arg);
	return 0;
}
static int
syncx_thread_start(syncx_mdns_t* svc) {
	return pthread_create(&svc->thread, 0, syncx_thread_entry, svc) == 0;
}
static void
syncx_thread_join(syncx_mdns_t* svc) {
	pthread_join(svc->thread, 0);
}
#endif

/* ==================== C API(MoonBit FFI 入口) ==================== */

int64_t
syncx_mdns_start(uint16_t port, const uint8_t* device_id, int32_t device_id_len) {
	if (!device_id || device_id_len != SYNCX_ID_LEN ||
	    !syncx_is_device_id((const char*)device_id, (size_t)device_id_len))
		return 0;
	if (!syncx_wsa_init())
		return 0;
	syncx_mdns_t* svc = (syncx_mdns_t*)calloc(1, sizeof(syncx_mdns_t));
	if (!svc)
		return 0;
	/* 必须显式绑到 5353:传 NULL 会被库绑到随机临时端口(那是「一次性查询」的
	 * 用法),组播 224.0.0.251:5353 的流量就永远到不了我们手上 */
	struct sockaddr_in saddr;
	memset(&saddr, 0, sizeof(saddr));
	saddr.sin_family = AF_INET;
	saddr.sin_addr.s_addr = htonl(INADDR_ANY);
	saddr.sin_port = htons(MDNS_PORT);
#ifdef __APPLE__
	saddr.sin_len = sizeof(struct sockaddr_in);
#endif
	svc->sock = mdns_socket_open_ipv4(&saddr);
	if (svc->sock < 0) {
		free(svc);
		return 0;
	}
	svc->port = port;
	svc->running = 1;
	memcpy(svc->device_id, device_id, SYNCX_ID_LEN);
	svc->device_id[SYNCX_ID_LEN] = 0;
	if (gethostname(svc->hostname, sizeof(svc->hostname) - 1) != 0 || !svc->hostname[0])
		strncpy(svc->hostname, "syncx", sizeof(svc->hostname) - 1);
	svc->hostname[sizeof(svc->hostname) - 1] = 0;
	/* 去掉结尾的点;空主机名兜底为 syncx(Node 用 os.hostname(),同语义) */
	size_t hlen = strlen(svc->hostname);
	while (hlen && svc->hostname[hlen - 1] == '.')
		svc->hostname[--hlen] = 0;
	if (!hlen)
		strncpy(svc->hostname, "syncx", sizeof(svc->hostname) - 1);
	snprintf(svc->instance, sizeof(svc->instance), "%s.%s", svc->device_id, SYNCX_SERVICE_NAME);
	syncx_make_target(svc->hostname, svc->target, sizeof(svc->target));
	syncx_mutex_init(&svc->mutex);
	if (!syncx_thread_start(svc)) {
		syncx_mutex_destroy(&svc->mutex);
		mdns_socket_close(svc->sock);
		free(svc);
		return 0;
	}
	return (int64_t)(uintptr_t)svc;
}

void
syncx_mdns_stop(int64_t handle) {
	syncx_mdns_t* svc = (syncx_mdns_t*)(uintptr_t)handle;
	if (!svc)
		return;
	syncx_mutex_lock(&svc->mutex);
	svc->running = 0;
	syncx_mutex_unlock(&svc->mutex);
	syncx_thread_join(svc);
	if (svc->sock >= 0) {
		/* goodbye:同一套记录,TTL=0,让对端尽快认为我们下线(Rust unregister 语义) */
		syncx_send_announce(svc, 0);
		mdns_socket_close(svc->sock);
		svc->sock = -1;
	}
	syncx_mutex_destroy(&svc->mutex);
	free(svc);
	syncx_wsa_fini();
}

int32_t
syncx_mdns_kick(int64_t handle) {
	syncx_mdns_t* svc = (syncx_mdns_t*)(uintptr_t)handle;
	if (!svc)
		return -1;
	syncx_mutex_lock(&svc->mutex);
	int running = svc->running;
	syncx_mutex_unlock(&svc->mutex);
	if (!running)
		return -1;
	syncx_send_announce(svc, SYNCX_TTL_SECONDS);
	syncx_send_browse_query(svc);
	return 0;
}

/* 序列化布局: [id_len u8][id][host_len u8][host][port u16 BE][address utf8] */
int32_t
syncx_mdns_poll(int64_t handle, uint8_t* out, int32_t capacity) {
	syncx_mdns_t* svc = (syncx_mdns_t*)(uintptr_t)handle;
	if (!svc)
		return -1;
	syncx_mutex_lock(&svc->mutex);
	if (svc->queue_count == 0) {
		syncx_mutex_unlock(&svc->mutex);
		return 0;
	}
	syncx_peer_record_t rec = svc->queue[svc->queue_head];
	svc->queue_head = (svc->queue_head + 1) % SYNCX_QUEUE_CAPACITY;
	--svc->queue_count;
	syncx_mutex_unlock(&svc->mutex);

	size_t id_len = strlen(rec.device_id);
	size_t host_len = strlen(rec.host);
	size_t addr_len = strlen(rec.address);
	size_t need = 1 + id_len + 1 + host_len + 2 + addr_len;
	if (!out || (size_t)capacity < need)
		return -2;
	uint8_t* p = out;
	*p++ = (uint8_t)id_len;
	memcpy(p, rec.device_id, id_len);
	p += id_len;
	*p++ = (uint8_t)host_len;
	memcpy(p, rec.host, host_len);
	p += host_len;
	*p++ = (uint8_t)((rec.port >> 8) & 0xFF);
	*p++ = (uint8_t)(rec.port & 0xFF);
	if (addr_len)
		memcpy(p, rec.address, addr_len);
	return (int32_t)need;
}

/* 纯构造:不依赖网络,给测试/降级断言用 */
int32_t
syncx_mdns_build_announce(uint16_t port, const uint8_t* device_id, int32_t device_id_len,
                          const uint8_t* hostname, int32_t hostname_len, uint8_t* out,
                          int32_t capacity) {
	char id[SYNCX_ID_LEN + 1];
	char host[SYNCX_HOSTNAME_CAP];
	if (!device_id || device_id_len != SYNCX_ID_LEN ||
	    !syncx_is_device_id((const char*)device_id, (size_t)device_id_len))
		return -1;
	memcpy(id, device_id, SYNCX_ID_LEN);
	id[SYNCX_ID_LEN] = 0;
	if (!hostname || hostname_len <= 0 || (size_t)hostname_len >= sizeof(host))
		return -1;
	memcpy(host, hostname, (size_t)hostname_len);
	host[hostname_len] = 0;
	size_t n =
	    syncx_build_announce_packet(id, host, port, SYNCX_TTL_SECONDS, out, (size_t)capacity);
	return n ? (int32_t)n : -1;
}

/* 回解校验:验证 announce 包的每条记录,成功返回 0,失败返回负错误码 */
int32_t
syncx_mdns_verify_announce(const uint8_t* buf, int32_t len, uint16_t port,
                           const uint8_t* device_id, int32_t device_id_len,
                           const uint8_t* hostname, int32_t hostname_len) {
	char id[SYNCX_ID_LEN + 1];
	char host[SYNCX_HOSTNAME_CAP];
	char instance[SYNCX_ID_LEN + 32];
	char target[SYNCX_HOSTNAME_CAP + 8];
	if (!buf || len < (int32_t)sizeof(struct mdns_header_t) || !device_id ||
	    device_id_len != SYNCX_ID_LEN || !hostname || hostname_len <= 0 ||
	    (size_t)hostname_len >= sizeof(host))
		return -1;
	if (!syncx_is_device_id((const char*)device_id, (size_t)device_id_len))
		return -1;
	memcpy(id, device_id, SYNCX_ID_LEN);
	id[SYNCX_ID_LEN] = 0;
	memcpy(host, hostname, (size_t)hostname_len);
	host[hostname_len] = 0;
	snprintf(instance, sizeof(instance), "%s.%s", id, SYNCX_SERVICE_NAME);
	syncx_make_target(host, target, sizeof(target));

	const struct mdns_header_t* header = (const struct mdns_header_t*)buf;
	if (mdns_ntohs(&header->flags) != 0x8400)
		return -2;
	if (mdns_ntohs(&header->questions) != 0)
		return -3;
	if (mdns_ntohs(&header->answer_rrs) != 3)
		return -4;
	if (mdns_ntohs(&header->authority_rrs) != 0)
		return -5;
	if (mdns_ntohs(&header->additional_rrs) != 2)
		return -6;

	size_t size = (size_t)len;
	size_t offset = sizeof(struct mdns_header_t);
	for (int i = 0; i < 5; ++i) {
		char name[SYNCX_NAME_CAP];
		size_t name_offset = offset;
		size_t nofs = name_offset;
		mdns_string_t nm = mdns_string_extract(buf, size, &nofs, name, sizeof(name) - 1);
		if (nm.length == 0 || nm.length >= sizeof(name))
			return -10 - i;
		name[nm.length] = 0;
		offset = nofs;
		if ((offset + 10) > size)
			return -20 - i;
		uint16_t rtype = mdns_ntohs(MDNS_POINTER_OFFSET_CONST(buf, offset));
		uint16_t rclass = mdns_ntohs(MDNS_POINTER_OFFSET_CONST(buf, offset + 2));
		uint32_t ttl = mdns_ntohl(MDNS_POINTER_OFFSET_CONST(buf, offset + 4));
		uint16_t rlen = mdns_ntohs(MDNS_POINTER_OFFSET_CONST(buf, offset + 8));
		offset += 10;
		if ((offset + rlen) > size)
			return -30 - i;

		int expect_flush = (i >= 3);
		if (ttl != SYNCX_TTL_SECONDS)
			return -40 - i;
		if (((rclass & MDNS_CACHE_FLUSH) ? 1 : 0) != (expect_flush ? 1 : 0))
			return -50 - i;

		if (i == 0) { /* PTR 服务名 → 实例 */
			if (rtype != MDNS_RECORDTYPE_PTR || !syncx_ieq(name, nm.length, SYNCX_SERVICE_NAME))
				return -2;
			char ptr_target[SYNCX_NAME_CAP];
			size_t pofs = offset;
			mdns_string_t pt =
			    mdns_string_extract(buf, size, &pofs, ptr_target, sizeof(ptr_target) - 1);
			if (pt.length == 0 || pt.length >= sizeof(ptr_target))
				return -2;
			ptr_target[pt.length] = 0;
			if (!syncx_ieq(ptr_target, pt.length, instance))
				return -2;
		} else if (i == 1 || i == 3) { /* SRV */
			if (rtype != MDNS_RECORDTYPE_SRV)
				return -3;
			const char* want_name = (i == 1) ? SYNCX_SERVICE_NAME : instance;
			if (!syncx_ieq(name, nm.length, want_name))
				return -3;
			char srv_target[SYNCX_NAME_CAP];
			mdns_record_srv_t srv =
			    mdns_record_parse_srv(buf, size, offset, rlen, srv_target, sizeof(srv_target) - 1);
			if (srv.port != port || srv.name.length == 0 || srv.name.length >= sizeof(srv_target))
				return -3;
			srv_target[srv.name.length] = 0;
			if (!syncx_ieq(srv_target, srv.name.length, target))
				return -3;
		} else { /* TXT:deviceId=<id> */
			if (rtype != MDNS_RECORDTYPE_TXT)
				return -4;
			const char* want_name = (i == 2) ? SYNCX_SERVICE_NAME : instance;
			if (!syncx_ieq(name, nm.length, want_name))
				return -4;
			mdns_record_txt_t txts[8];
			size_t count = mdns_record_parse_txt(buf, size, offset, rlen, txts, 8);
			int found = 0;
			for (size_t t = 0; t < count; ++t) {
				if (syncx_ieq(txts[t].key.str, txts[t].key.length, "deviceId") &&
				    txts[t].value.length == SYNCX_ID_LEN &&
				    memcmp(txts[t].value.str, id, SYNCX_ID_LEN) == 0)
					found = 1;
			}
			if (!found)
				return -4;
		}
		offset += rlen;
	}
	return 0;
}

void
syncx_mdns_msleep(int32_t milliseconds) {
#ifdef _WIN32
	Sleep((DWORD)milliseconds);
#else
	struct timespec ts;
	ts.tv_sec = milliseconds / 1000;
	ts.tv_nsec = (long)(milliseconds % 1000) * 1000000L;
	nanosleep(&ts, 0);
#endif
}
