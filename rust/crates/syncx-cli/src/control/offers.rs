//! 待确认项(配对请求 / 目录邀请)的落盘规则。
//!
//! 逐条对齐 Node 侧 `src/offers.ts`:去重键、回填只补空值、mutual 跳过、
//! 接受 / 忽略 / 恢复的状态机、撤销清理。这些规则决定「对端重连时会不会反复弹卡片」,
//! 任何一条写错都会表现为「每次重连都弹一次」或「卡片永远点不掉」。

use syncx_api::config::{ConfigStore, PendingOffer};

/// 接收方视角的去重键:同一对方 + 同类 + 同一目录。
fn dedupe_key(kind: &str, from_device_id: &str, folder_id: Option<&str>) -> String {
    format!("{from_device_id}|{kind}|{}", folder_id.unwrap_or(""))
}

fn key_of(offer: &PendingOffer) -> String {
    dedupe_key(
        &offer.kind,
        &offer.from_device_id,
        offer.folder_id.as_deref(),
    )
}

/// 收到一条邀请。返回新落成的待确认项;被去重 / 互信跳过时返回 `None`。
///
/// 去重命中时**只回填空值的来源信息**并仅在真的回填了才落盘 —— 否则对端每重连一次
/// 就重写一遍 config.json,配置文件的 mtime 会被无谓地刷新(热重载据此判断变化)。
///
/// 参数与 Node `receiveOffer` 一一对应;拆成结构体会让每一处调用点都得写一遍字段名,
/// 而与 Node 对拍时按位置比对反而更直接。
#[allow(clippy::too_many_arguments)]
pub fn receive_offer(
    store: &ConfigStore,
    id: &str,
    kind: &str,
    from_device_id: &str,
    folder_id: Option<&str>,
    folder_name: Option<&str>,
    from_hostname: Option<&str>,
    from_ip: Option<&str>,
) -> Option<PendingOffer> {
    let mut created: Option<PendingOffer> = None;
    let key = dedupe_key(kind, from_device_id, folder_id);
    let _ = store.mutate::<_, std::io::Error>(|config| {
        if let Some(existing) = config.pending_offers.iter_mut().find(|o| key_of(o) == key) {
            let mut dirty = false;
            if existing.from_ip.is_none() && from_ip.is_some() {
                existing.from_ip = from_ip.map(str::to_string);
                dirty = true;
            }
            if existing.from_hostname.is_none() && from_hostname.is_some() {
                existing.from_hostname = from_hostname.map(str::to_string);
                dirty = true;
            }
            created = None;
            return Ok(dirty);
        }

        // 已 mutual:目录已与对方互相同步 → 这是建连时的重发回声,不再弹确认
        if kind == "folder" {
            if let Some(folder_id) = folder_id {
                let mutual = config.shared_folders.iter().any(|folder| {
                    folder.folder_id() == folder_id
                        && folder.devices.iter().any(|id| id == from_device_id)
                });
                if mutual {
                    created = None;
                    return Ok(false);
                }
            }
        }
        // 已 mutual:对方已是已知设备 → pairing 请求是回声
        if kind == "pairing"
            && config
                .known_devices
                .iter()
                .any(|device| device.id == from_device_id)
        {
            created = None;
            return Ok(false);
        }

        let offer = PendingOffer {
            id: id.to_string(),
            kind: kind.to_string(),
            from_device_id: from_device_id.to_string(),
            folder_id: folder_id.map(str::to_string),
            folder_name: folder_name
                .map(str::to_string)
                .or_else(|| folder_id.map(str::to_string)),
            from_hostname: from_hostname.map(str::to_string),
            from_ip: from_ip.map(str::to_string),
            status: "pending".to_string(),
            created_at: crate::invite::now_ms(),
            extra: Default::default(),
        };
        config.pending_offers.push(offer.clone());
        created = Some(offer);
        Ok(true)
    });
    created
}

/// 置为 accepted。返回被置状态的项(不存在 = `None`,调用方据此报 `offer not found`)。
pub fn mark_accepted(store: &ConfigStore, id: &str) -> Option<PendingOffer> {
    set_status(store, id, "accepted", None)
}

/// 置为 declined。
pub fn mark_declined(store: &ConfigStore, id: &str) -> Option<PendingOffer> {
    set_status(store, id, "declined", None)
}

/// 仅 declined 可恢复回 pending。
pub fn restore_declined(store: &ConfigStore, id: &str) -> Option<PendingOffer> {
    set_status(store, id, "pending", Some("declined"))
}

fn set_status(
    store: &ConfigStore,
    id: &str,
    status: &str,
    require: Option<&str>,
) -> Option<PendingOffer> {
    let mut result: Option<PendingOffer> = None;
    let _ = store.mutate::<_, std::io::Error>(|config| {
        let Some(offer) = config.pending_offers.iter_mut().find(|o| o.id == id) else {
            result = None;
            return Ok(false);
        };
        if let Some(require) = require {
            if offer.status != require {
                result = None;
                return Ok(false);
            }
        }
        offer.status = status.to_string();
        result = Some(offer.clone());
        Ok(true)
    });
    result
}

/// 清理「已被对方撤销」的目录邀请。
///
/// 对端经 `folder-sync-list` 宣告的 `folderIds` 是它**当前仍想共享给本机**的集合,
/// 不在其中的 pending 目录邀请说明对方已删除该共享 —— 留着就是一张永远点不动的卡片。
/// 只动 pending:accepted 走正常的「已停止共享」逻辑,declined 保留供恢复。
pub fn prune_revoked(store: &ConfigStore, from_device_id: &str, folder_ids: &[String]) -> usize {
    let keep: std::collections::HashSet<&str> = folder_ids.iter().map(String::as_str).collect();
    let mut removed = 0usize;
    let _ = store.mutate::<_, std::io::Error>(|config| {
        let before = config.pending_offers.len();
        config.pending_offers.retain(|offer| {
            !(offer.kind == "folder"
                && offer.status == "pending"
                && offer.from_device_id == from_device_id
                && offer
                    .folder_id
                    .as_deref()
                    .is_some_and(|id| !keep.contains(id)))
        });
        removed = before - config.pending_offers.len();
        Ok(removed > 0)
    });
    removed
}

/// 生成本机发起邀请的 id。前半段随机(同一次会话里不重复),后半段是可读的用途标记。
pub fn make_offer_id(prefix: &str, remote_device_id: &str, folder_id: Option<&str>) -> String {
    let mut bytes = [0u8; 4];
    use rand::RngCore;
    rand::thread_rng().fill_bytes(&mut bytes);
    format!(
        "{}:{prefix}:{remote_device_id}:{}",
        hex::encode(bytes),
        folder_id.unwrap_or("")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (tempdir::TempDir, ConfigStore) {
        let dir = tempdir::TempDir::new();
        let path = dir.path().join("config.json");
        (dir, ConfigStore::new(path))
    }

    mod tempdir {
        pub struct TempDir(std::path::PathBuf);
        impl TempDir {
            pub fn new() -> Self {
                let path = std::env::temp_dir().join(format!(
                    "syncx-offers-{}-{}",
                    std::process::id(),
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap()
                        .as_nanos()
                ));
                std::fs::create_dir_all(&path).unwrap();
                Self(path)
            }
            pub fn path(&self) -> &std::path::Path {
                &self.0
            }
        }
        impl Drop for TempDir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
    }

    #[test]
    fn dedupe_keeps_single_card_and_backfills_source() {
        let (_dir, store) = store();
        let first = receive_offer(&store, "o1", "pairing", "dev-a", None, None, None, None);
        assert!(first.is_some());
        let second = receive_offer(
            &store,
            "o2",
            "pairing",
            "dev-a",
            None,
            None,
            Some("host-a"),
            None,
        );
        assert!(second.is_none(), "同一对方同类的第二条必须去重");
        let config = store.load();
        assert_eq!(config.pending_offers.len(), 1);
        assert_eq!(
            config.pending_offers[0].from_hostname.as_deref(),
            Some("host-a")
        );
    }

    #[test]
    fn decline_then_restore_only_from_declined() {
        let (_dir, store) = store();
        receive_offer(&store, "o1", "pairing", "dev-a", None, None, None, None);
        assert!(
            restore_declined(&store, "o1").is_none(),
            "pending 不可「恢复」"
        );
        assert!(mark_declined(&store, "o1").is_some());
        assert!(restore_declined(&store, "o1").is_some());
        assert_eq!(store.load().pending_offers[0].status, "pending");
    }

    #[test]
    fn revoked_folder_offers_are_pruned_but_declined_kept() {
        let (_dir, store) = store();
        receive_offer(
            &store,
            "o1",
            "folder",
            "dev-a",
            Some("f1"),
            None,
            None,
            None,
        );
        receive_offer(
            &store,
            "o2",
            "folder",
            "dev-a",
            Some("f2"),
            None,
            None,
            None,
        );
        mark_declined(&store, "o2");
        let removed = prune_revoked(&store, "dev-a", &["f2".to_string()]);
        assert_eq!(removed, 1);
        let config = store.load();
        assert_eq!(config.pending_offers.len(), 1);
        assert_eq!(config.pending_offers[0].id, "o2");
    }
}
