<script setup lang="ts">
const props = defineProps<{
  status: { deviceId: string; entries: number; tombstones: number; folders: Array<{ path: string; devices: string[] }> };
  message?: string;
}>();
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
    </div>

    <div class="card">
      <div class="muted">共享目录</div>
      <table>
        <thead>
          <tr><th>路径</th><th>已配对设备</th><th></th></tr>
        </thead>
        <tbody>
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
