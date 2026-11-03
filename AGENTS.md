# dsh-mijia-sidebar — 项目须知

新会话先读这一份。这里记的是**从代码本身看不出来**的东西：约定、坑、已经不做的决定、以及在哪验证。

---

## 1. 这是什么

DSH 侧边栏插件：一个「米家控制」面板，列设备、读写属性、执行动作与场景，**全程不经过大模型**。

| 项 | 值 |
| --- | --- |
| 仓库 | https://github.com/EchoChan314/dsh-mijia-sidebar |
| 包名 | `dsh-mijia-sidebar`（npm，MIT） |
| 当前版本 | 1.1.0（仓库 `package.json` / tag `v1.1.0` / GitHub Release `v1.1.0`） |
| 作者 | EchoChan `<czmecho@gmail.com>` |
| 唯一分支 | `main`（单提交历史，用 `--amend` 保持整洁） |

---

## 2. 三个半边，改哪半边要分清

| 半边 | 文件 | 何时生效 |
| --- | --- | --- |
| host（Node） | `lib/index.js`、`lib/parse.js` | **必须重启 DSH**（进程启动时加载） |
| client（浏览器） | `lib/client.js` | 刷新面板即可（手写 classic script，经 `window.__ModuleLoader__.load`，**无构建步骤**） |
| python 助手 | `lib/state.py` | 每次调用重新起进程，改完即生效 |

**安装方式是 symlink**：profile 里的 `node_modules/dsh-mijia-sidebar` 指向本仓库目录，
所以**改文件即时可见**，不需要重装插件。调试时这是最容易搞错的一点：以为改动没生效，其实是 host 半边需要重启。

注册约定：`package.json` 的 `dsh.bundle.patch` → `cordis.patch.yml` 插入一行；
host 用 `ctx.connection.register(ctx, '/mijia', handler)`，**handler 的返回值就是 RPC 信封**：

```js
{ ok: true, value }                                  // 成功
{ ok: false, error: { code, message, details } }     // 失败，code 形如 mijia/*
```

---

## 3. Python 调用约定

- 解释器探测链：`MIJIA_PYTHON` → `python3` → `python` →（win32）`py -3`，**每次调用探测**，成功后缓存。
  实测 `python3` 在 Windows 上可能是 WindowsApps 别名，比 `python` 慢约 70ms。
- `lib/state.py` 三种模式：`--mode list`（设备列表）/ `--mode spec --spec_type X`（规格）/ `--did D [--spec_type X]`（属性值）。
- 失败时 **stderr 输出单行 JSON** 后退出，退出码即分类：`3` auth-missing、`4` auth-expired、`5` dependency-missing、`1` 其他。
  stdout 永远只放那一个 JSON 文档，host 不需要猜读到的是数据还是日志。
- 分类逻辑在 `lib/parse.js` 的 `classifyError`，测试在 `tests/parse.test.js`。

---

## 4. 性能设计（**改动前务必读这节**）

面板的慢**不在渲染，也不在米家云**，而在「每起一个 Python 进程就要重新导入 `requests`+`mijiaAPI`（约 400~600ms）」。
所以整套设计的核心是：**什么时候必须等 python，能拖就拖。**

实测基线（本机）：

| 场景 | 值 |
| --- | --- |
| `python -c pass` | 29 ms |
| `import requests` + `mijiaAPI` | 400~640 ms |
| `get_devices_list()`（云） | 0.6~2.9 s（抖动大） |
| 冷启动打开面板（两个进程并行） | ~1.05 s |
| 有缓存打开面板 | **~17 ms** |
| 冷展开设备（props ∥ state） | ~0.87 s |
| 有缓存展开设备 | **~6 ms** |

### 三层缓存

1. **内存**：`listCache`（5s）、`specCache`（300s）、`stateInflight`/`specInflight`/`inflight` 去重。
2. **磁盘快照** `$DSH_HOME/mijia-sidebar.snapshot.json`：上次成功的设备列表。
3. **磁盘 spec + 设备状态** `$DSH_HOME/mijia-sidebar.cache.json`：`{ specs: {specType: {ts,value}}, states: {did: {ts,states}} }`，
   spec 保留 30 份、状态保留 60 份（`pruneStore` 按 ts 淘汰）。spec 磁盘 TTL 7 天，过期后仍先答旧值、后台重取。

### stale-while-revalidate 握手（客户端与 host 的契约）

```
客户端 call('snapshot')            → host 有缓存就返回 {...cached, stale: true}，同时后台刷新
客户端若见 stale，再 call('snapshot', { refresh: true })  → 强制走 python，拿到后静默替换
```
`state` 同理（返回 `{did, name, model, states, stale}`）。

> **不变量（加缓存时最容易踩的坑）**：`set` 之后的**回读核对**、以及面板上的 **⟳ 手动刷新**，
> 必须带 `{ refresh: true }` 跳过缓存。否则会拿旧值判断「写入是否生效」，或在用户明确要求刷新时给回旧数据。
> 客户端里这两处分别在 `reconcileState` 与 `onRefreshState`（`fetchState(device, { force: true })`）。

### 其他已做的优化

- **展开设备并行**：`props`（规格）与 `state`（属性）用 `Promise.all` 一起发，耗时=较慢的那条。
- **`state` 传 `spec_type` 走快路径**：`mijiaDevice()` 构造时会重拉整份设备列表来解析 did（实测 0.4~2.9s），
  而 did/spec_type 面板早就知道。传了 `spec_type` 就直接由本地缓存的 spec 构造属性表（`props_from_spec`），
  不传则回退原路径。**改完必须比对两路径返回的 states 是否一致**（曾实测 10/10 相同）。
- **启动预热**：`apply()` 后 2 秒在后台取一次快照写缓存，使 DSH 启动后第一次点击也命中。

### 已评估但**否决**的方案（不要重复提议）

- **常驻 / 空闲超时 Python worker**：能省掉每次 400~600ms 的导入（冷路径约再快一倍），
  但代价是有状态长驻子进程（崩溃自愈、退出清理、并发排队、卡死检测、协议层测试只能靠 CI）。
  内存不是问题（常驻约 39~45 MiB，与现在瞬时峰值相同），**问题是复杂度**。
  **2026-11-03 用户明确决定放弃。**
- 改用手写 HTTP 绕过 `mijiaAPI`：要复刻签名/鉴权，风险远大于收益。
- 预测性预热 spec/state：与「面板挂载即取数」重复，无增量收益。

---

## 5. 运行期文件（都在 `$DSH_HOME`，默认 `~/.dsh`）

| 文件 | 内容 |
| --- | --- |
| `mijia-sidebar.snapshot.json` | 磁盘快照缓存 |
| `mijia-sidebar.cache.json` | spec + 设备状态缓存 |
| `mijia-sidebar.config.json` | 用户配置：`hiddenDids`、`aliases`（按 model 的中文别名） |
| `mijia-sidebar.log` / `.log.1` | 变更日志，1 MiB 轮转 |

**调试提示**：怀疑缓存串味时，删掉前两个文件即可回到全冷状态。

---

## 6. 开发与验证

```bash
npm run check                                   # node --check ×3 + python -m py_compile
node --test                                      # 30 条（29 通过，1 条本机沙箱 skip，CI 上 30/30）
python -m unittest discover -s tests -p "*_test.py"   # 20 条
npm pack --dry-run                               # 打包核对，应只有 14 个文件、无 __pycache__
```

- **沙箱那条 skip 是环境限制**：本机沙箱禁止管道子进程（spawn EPERM），所以「走完探测链报 ENOENT」这条
  在本机永远 skip，**CI 上真跑**。不要为了让它变绿去改代码。
- 测试全部离线：第三方依赖（`requests`、`mijiaAPI`）在 `sys.modules` 里被打桩，不需要账号、不联网。
  - `tests/state_test.py` 用内存桩（`_install_stubs`）；`tests/fixtures/stubs/` 是给子进程路径用的。
  - **给桩加成员时两处都要改**：`state.py` 新增对 `mijiaAPI.devices.DevProp` 的导入时，内存桩与
    `fixtures/stubs/mijiaAPI/devices.py` 都得补，否则测试在导入期就报 dependency-missing。
- 新增「缓存必须生效」类测试的正确姿势：在**无解释器环境**里跑（清空 PATH、`MIJIA_PYTHON` 指向不存在的路径、
  `process.platform` 伪成 linux），凡还能答上来的必然走了缓存；未缓存与 `{refresh:true}` 则必须失败。

---

## 7. 发布

- `.github/workflows/ci.yml`：ubuntu-latest + Node 22，跑 check / 测试 / JSON 校验。
- `.github/workflows/publish.yml`：`release: published` 或手动 `workflow_dispatch`；Node 24；
  `permissions: contents: read, id-token: write`；先 `npm view` 幂等判断，再 `npm publish --provenance --access public`。
- **受信发布（OIDC）已打通**（2026-11-03 由 Release `v1.1.0` 触发验证）：
  日志含 `Publishing to https://registry.npmjs.org/ with tag latest and public access`、
  `Signed provenance statement with source and build information from GitHub Actions`，全程无 token、无 OTP。
- **Release ≠ Tag**：`/releases` 页面只列 Release，`/tags` 才有全部 tag。**推 tag 之后必须再建 Release**，
  否则页面上看不到新版本（这个坑踩过一次）。
- 应用户要求，发布到 npm 属于不可逆公开动作，**先问再发**。

### npm 规则与坑（都踩过，别再踩）

1. **版本号永久唯一**，被撤下的版本号不能再用。
2. **撤销「最后一个版本」会把整包记录删掉**（曾经因此连同 1.0.0 一起消失）；撤销后 24 小时内不能重发。
3. **Trusted Publisher 绑定会随包记录一起消失**，需重新配置，否则 CI 报 `ENEEDAUTH`。
4. **分阶段发布（staged）会留下 `0.0.0-stage` 占位版本**，属正常现象，别手动删它。
5. 发布前 `npm pack --dry-run` 核对；`files` 用 glob（`lib/*.js`、`lib/*.py`）以免把 `lib/__pycache__/*.pyc` 打进去。
6. 默认镜像可能是 `mirrors.cloud.tencent.com`（无写权限），`package.json` 里已用 `publishConfig.registry` 钉死官方源。

---

## 8. 本机环境坑（Windows + DSH 沙箱）

| 现象 | 原因 / 做法 |
| --- | --- |
| node 里 `spawn` python 报 EPERM/EACCES | 沙箱禁止管道子进程。**本机无法端到端验证 host→python**，只能分段测（python 侧单独跑、host 侧用测试桩），或交给 CI |
| `git push` 报 `cannot create standard input pipe` | 同上。用 `GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND="ssh -o BatchMode=yes"` + `sandbox_permissions: danger-full-access` 走 SSH |
| `~/.npmrc` 写不进去 | 用 `--userconfig` 或 `npm_config_cache` 指向工作区内目录 |
| 控制台中文乱码 | GBK 代码页的显示问题，**不是文件损坏**；用 `encoding='utf-8'` 读原文判断 |
| 临时目录 `PermissionError [Errno 13]` | 已由 `dsh-python-tempfile-shim` 插件自动注入修复，不要提权「解决」 |

---

## 9. 协作偏好

- **提交保持单个干净 commit**（改动用 `git commit --amend`），提交信息里的数字只写实测输出。
- 报告里区分「已实测」与「未验证/推测」，不要含糊。
- 破坏性或不可逆动作（发布、删版本、强推）先说明后果再执行。

---

## 10. 当前未决（2026-11-03）

**npm 上 `1.1.0` 的 tarball 取不到。** 状态如下（本机视角）：

| 检查点 | 结果 |
| --- | --- |
| packument `GET /dsh-mijia-sidebar` | 正常，`versions = 0.0.0-stage, 1.0.1, 1.1.0` |
| `dist-tags` | `{"latest":"1.1.0"}` |
| `GET /dsh-mijia-sidebar/latest` | 1.1.0，含 SLSA provenance 声明 |
| attestation 端点 `@1.1.0` | HTTP 200（15 KB）→ 服务端确实记录并签名了这次发布 |
| **`.../-/dsh-mijia-sidebar-1.1.0.tgz`** | **HTTP 404 `{"error":"Not found"}`**（1.0.1 的 tarball 正常 200） |
| `npm pack dsh-mijia-sidebar@1.1.0` | 404，**当前别人装不上这一版** |

判断：元数据与签名都在，**只有文件本体取不到**，属注册表侧/环境侧问题，不是发布操作有误。
待办：①（用户侧）刷新 npmjs.com 包页并试 `npm pack dsh-mijia-sidebar@1.1.0` 复现；
② 若长时间仍 404，**不要 `npm unpublish`**（见 §7 第 2 条，风险极高），
更稳的是发一个干净的新版本号（如 `1.1.1`）。

其他可选待办：向 awesome-dsh-plugin 提交条目（`data/plugins/EchoChan314__dsh-mijia-sidebar.yml`，
`category: ui`，双语描述）。
