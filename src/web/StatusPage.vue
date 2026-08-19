<script setup lang="ts">
interface SyncProgressItem {
  folder: string;
  pending: number;
  sending: number;
  receiving: number;
}

defineProps<{
  status: {
    deviceId: string;
    entries: number;
    tombstones: number;
    folders: Array<{ path: string; devices: string[] }>;
    peers: Array<{ deviceId: string; online: boolean; url?: string }>;
    syncProgress: SyncProgressItem[];
  };
  message?: string;
}>();

function progressPercent(p: SyncProgressItem): number {
  const total = p.pending + p.sending + p.receiving;
  return total > 0 ? Math.round((p.receiving / total) * 100) : 0;
}
</script>

<template>
  <div class="container">
    <h1>syncx 状态</h1>
    <div v-if="message" class="message">{{ message }}</div>

    <div class="card">
      <div class="muted">本机设备</div>
      <div class="deviceId">{{ status.deviceId }}</div>
      <div class="stat-row">
        <div class="stat"><b>{{ status.entries }}</b>索引条目</div>
        <div class="stat"><b>{{ status.tombstones }}</b>墓碑</div>
        <div class="stat"><b>{{ status.folders.length }}</b>共享目录</div>
      </div>
      <div class="actions">
        <form method="POST" action="/actions" style="display:inline">
          <input type="hidden" name="action" value="rescan">
          <button type="submit">手动扫描</button>
        </form>
      </div>
    </div>

    <div class="card">
      <div class="muted">对端连接</div>
      <table>
        <thead>
          <tr><th>设备</th><th>状态</th><th>操作</th></tr>
        </thead>
        <tbody>
          <tr v-if="status.peers.length === 0">
            <td colspan="3" class="muted">暂无对端</td>
          </tr>
          <tr v-for="p in status.peers" :key="p.deviceId">
            <td><span class="dot" :class="p.online ? 'dot-online' : 'dot-offline'"></span>{{ p.deviceId }}</td>
            <td :class="p.online ? 'online' : 'offline'">{{ p.online ? '在线' : '离线' }}</td>
            <td>
              <form v-if="!p.online" method="POST" action="/actions" style="display:inline">
                <input type="hidden" name="action" value="reconnect">
                <input type="hidden" name="deviceId" :value="p.deviceId">
                <button type="submit" class="btn-sm">重连</button>
              </form>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="card">
      <div class="muted">同步进度</div>
      <table>
        <thead>
          <tr><th>目录</th><th>待处理</th><th>发送中</th><th>接收中</th><th>进度</th></tr>
        </thead>
        <tbody>
          <tr v-if="status.syncProgress.length === 0">
            <td colspan="5" class="muted">同步中无待处理任务</td>
          </tr>
          <tr v-for="p in status.syncProgress" :key="p.folder">
            <td>{{ p.folder }}</td>
            <td>{{ p.pending }}</td>
            <td>{{ p.sending }}</td>
            <td>{{ p.receiving }}</td>
            <td>
              <div class="progress-bar"><div class="progress-fill" :style="{ width: progressPercent(p) + '%' }"></div></div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="card">
      <div class="muted">共享目录</div>
      <table>
        <thead>
          <tr><th>路径</th><th>已配对设备</th><th></th></tr>
        </thead>
        <tbody>
          <tr v-if="status.folders.length === 0">
            <td colspan="3" class="muted">暂无共享目录</td>
          </tr>
          <tr v-for="f in status.folders" :key="f.path">
            <td>{{ f.path }}</td>
            <td>{{ f.devices.join(', ') }}</td>
            <td class="actions">
              <form method="POST" action="/folders" style="display:inline">
                <input type="hidden" name="_method" value="DELETE">
                <input type="hidden" name="path" :value="f.path">
                <button type="submit">移除</button>
              </form>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="card">
      <div class="muted">添加共享目录</div>
      <form method="POST" action="/folders">
        <input name="path" placeholder="本地目录绝对路径,如 /home/me/Documents">
        <input name="devices" placeholder="允许的设备 ID,逗号分隔,如 DEV1234567">
        <button type="submit">添加</button>
      </form>
    </div>
  </div>
</template>
