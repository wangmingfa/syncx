///|
/// 版本号单一来源是仓库根 package.json;CI 在构建前用 sed 注入(mvm 同款)。
/// 本地开发保持与 package.json 一致,scripts/check-moonbit-version.mjs 会校验。
pub const VERSION : String = "0.4.1"
