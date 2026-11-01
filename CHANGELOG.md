# Changelog

本文件记录 dsh-mijia-sidebar 的版本变更；版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## 1.0.1 — 2026-11-02

重新发布版本，内容与 1.0.0 完全一致（无代码改动）。

1.0.0 曾发布到 npm 后因清理一个占位版本（`0.0.0-stage`）而连同整包被撤下；npm 会永久保留
已撤版本的版本号，`1.0.0` 无法再次发布，故以 1.0.1 重发。教训已记入本文件末尾的发布注意事项。

## 1.0.0 — 2026-11-01

首个公开发布版本。此前 0.1.x 是仅在本机使用的原型，本次按"能给别人装"的标准做了通用化、错误引导、文档与测试。

### 新增

- **首次使用引导**：面板不再是"读不到设备就给一行报错"。缺少 Python、缺少 `mijiaAPI` 依赖、没有登录凭证、凭证过期四种情况各自显示带步骤的引导卡片（中文/英文），并给出可复制的命令。
- **解释器探测链**：依次尝试 `MIJIA_PYTHON` → `python3` → `python` →（Windows）`py -3`，命中后缓存；某个候选不可用不会中断整条链。
- **错误码**：失败信封的 `code` 从恒为 `mijia/error` 改为 `mijia/python-missing`、`mijia/dependency-missing`、`mijia/auth-missing`、`mijia/auth-expired`、`mijia/timeout`、`mijia/error`；原始 stderr 只进 `details`，用户看到的是可操作文案。
- **双语文档**：`README.md`（中文）与 `README.en.md`（英文），含前置条件、安装、配置参考、错误码排查、隐私说明。
- **离线测试与 CI**：`node --test`（宿主半区与解析函数）+ `python -m unittest`（助手脚本纯函数与退出码契约），GitHub Actions 跑语法检查、测试与 JSON 校验。测试不需要米家账号、不联网。
- **日志轮转**：`$DSH_HOME/mijia-sidebar.log` 达到 1 MiB 后轮转为 `mijia-sidebar.log.1`，只保留一代。

### 修复

- **设备动作全部失效**：宿主半区 `handle(action, …)` 的参数名遮蔽了同名的设备动作处理函数，任何 `action` 请求都会抛 `TypeError: action is not a function`。改名后设备动作（开机/关机/摆头等）恢复可用。该缺陷从原型期就存在。

### 变更

- 移除 `package.json` 的 `private` 标记，补充 `license`（MIT）、`author`、`repository`、`homepage`、`bugs`、`keywords`、`engines`，可直接作为包发布。
- 解释器不再写死为本机路径；`lib/parse.js` 提取为无副作用纯函数模块，便于单测。
- `lib/state.py` 增加运行前检查：凭证缺失退出码 3、凭证过期 4、缺少依赖 5，均向 stderr 输出单行 JSON。
## 发布注意事项

这几条是实际踩坑后写下的，发版前请过一遍。

1. **不要在只有一个正式版本时删任何版本。** npm 的规则是：若删除后包里不再有任何版本，整个包记录会被清空，
   连同 Trusted Publisher 绑定一起消失；恢复要等 24 小时冷却，且绑定需在包有版本后重新配置。
   要清理多余的版本（例如 staged publishing 留下的 `0.0.0-stage` 占位），先发布一个新的正式版本，
   让包里至少有两个版本，再删旧的。
2. **撤销过的版本号永久不可复用。** 撤包后同一版本号再发会被 `400 Cannot publish over previously
   published version` 拒绝，只能发新版本号（本项目的 1.0.1 就是这么来的）。
3. **撤包后 24 小时内不能重发同名包**，会返回 `403 cannot be republished until 24 hours have passed`。
4. **发布需要 2FA。** 交互式发布会打印 `https://www.npmjs.com/auth/cli/...` 授权链接；CI 侧走
   Trusted Publisher（OIDC），不需要 token，但该绑定要求包已存在且版本可发。
5. `npm publish` 前先跑 `npm pack --dry-run`，确认 `files` 白名单没有把 `__pycache__`、`*.tgz`、
   测试夹具之外的产物带进去（本项目曾把 `lib/__pycache__/*.pyc` 打进包里）。
