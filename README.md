# 小册子双面拼版与页序核验后端

一个 **纯本地** 运行的小册子（booklet）双面拼版计划服务：给定文档总页数、每帖最大页数
与计划名称，输出每张纸正/反面、左/右位置应放的页码，以及补白页的位置；并能核验外部
传入的页序计划是否正确。

- 技术栈：TypeScript + Node.js（内置 `node:sqlite`），**无第三方运行时依赖**。
- 形态：只做 **HTTP API 与 CLI**，不含任何前端、PDF 解析、打印机或图像渲染。
- 平台：Windows 本地直接运行，**不需要 Docker / WSL / 付费服务 / 外部在线 API**。

> 需要 Node.js >= 22.5（开发与验证使用 Node v25，内置 `node:sqlite` 同步 API）。
> 首次访问 SQLite 时 Node 会打印一条 `ExperimentalWarning`，属正常提示，不影响功能。

## 装订模型与术语（支持范围）

本服务严格限定在以下简单骑缝（对折）装订模型：

- **左侧装订**：纸张沿中缝对折，折脊在左、书口在右。
- **每面两页**：纸张一面（side）平铺左右两页；一张纸（sheet）有
  **正面（front）** 与 **反面（back）**，对折后承载 4 个页位。
- **帖（signature）**：若干张纸叠在一起对折、用骑缝订合成的一个独立小册单元。
  一帖的页数必须是 **4 的倍数**。文档超过一帖容量时分成多帖，帖与帖依次装订成册。
- **正向观看**：输出中的“左页/右页”指把该面正对自己阅读时看到的左右位置。
  纸张翻面时上下方向不变（沿左脊翻），因此反面的左右就是阅读时实际的左右。

### 八页一帖基准（由外到内）

| 纸张 | 面   | 左 | 右 |
| ---- | ---- | -- | -- |
| 外张 | 正面 | 8  | 1  |
| 外张 | 反面 | 2  | 7  |
| 内张 | 正面 | 6  | 3  |
| 内张 | 反面 | 4  | 5  |

一般规则：一帖共 `size` 个页位（含补白），第 `k` 张（从 1 起，由外到内）：

- 正面：左 `size - 2(k-1)`，右 `2(k-1) + 1`
- 反面：左 `2(k-1) + 2`，右 `size - 2(k-1) - 1`

### 补白（blank）

- 最后一帖的真实页数不足 4 的倍数时，在帖的**最外层页位**补白到 4 的倍数
  （例如 6 页补成 8 页：外张正面左、反面右为补白）。
- 真实页码 `1..总页数` 贯穿各帖**连续编号**；补白用 `B1、B2…` 独立标记，
  **不占用真实页号**。

### 明确不做的事

不解析或修改 PDF、不连接打印机、不做纸张切割/开数优化、不做图像渲染、
不模拟真实折纸力学，也不输出印刷级 PDF。仅输出页码排布数据（JSON/CSV/表格）。

## 参数与错误码

- `totalPages`（总页数）：正整数，`>= 1`。
- `maxSignaturePages`（每帖最大页数）：`>= 4` 的正整数，作为**上界**；
  实际每帖页位取不超过它的最大 4 的倍数（例如传 14 表示每帖最多 12 页）。
  除最后一帖外都填满到该容量，最后一帖取余数并补白到 4 的倍数。
- `name`（计划名称）：非空字符串。

稳定错误码：`INVALID_PARAM`（参数非法，HTTP 400）、`NOT_FOUND`（404）、
`INVALID_JSON`（400）、`BODY_TOO_LARGE`（413）、`INTERNAL`（500）。
核验问题码见下文“核验”。

## 快速开始

```powershell
npm install        # 仅安装 typescript 与类型定义
npm run build      # 编译到 dist/
npm test           # 编译并运行全部测试（node --test）
npm run demo       # 内置演示（6/16/20 页 + 交换两页被拒）
npm start          # 启动 HTTP API（默认自动选择空闲端口）
```

也可直接用 node 运行 CLI：

```powershell
node dist/cli/index.js demo
node dist/cli/index.js serve --port 8080 --host 127.0.0.1 --db data/booklet.db
```

## CLI

```powershell
# 生成并保存计划（--format 可选 json|csv|table，默认 table）
node dist/cli/index.js generate --name demo20 --pages 20 --max 16 --format table

node dist/cli/index.js list
node dist/cli/index.js versions --name demo20

# 逐帖 / 逐张查看（不指定 --version 则用最新版本）
node dist/cli/index.js show --name demo20 --version 1 --signature 2
node dist/cli/index.js show --name demo20 --sheet 1

# 导出
node dist/cli/index.js export --name demo20 --version 1 --format csv

# 用新参数生成新版本（旧版本保留、可独立查询）
node dist/cli/index.js recalculate --name demo20 --pages 6 --max 8

# 核验外部页序计划 JSON（合法退出码 0，非法退出码 2）
node dist/cli/index.js verify --file plan.json

# 启动服务：--port 0（默认）自动选空闲端口
node dist/cli/index.js serve --port 0 --host 127.0.0.1 --db data/booklet.db
```

## HTTP API

服务默认监听 `127.0.0.1`，不传端口或传 `--port 0` 时自动选择空闲端口并打印实际地址。

| 方法 | 路径 | 说明 |
| ---- | ---- | ---- |
| GET  | `/health` | 健康检查 |
| POST | `/plans` | 生成并保存计划；同名再次提交会**追加新版本** |
| GET  | `/plans` | 列出计划 |
| GET  | `/plans/:name?version=N` | 查看某版本布局（默认最新） |
| GET  | `/plans/:name/versions` | 版本列表 |
| GET  | `/plans/:name/signatures/:idx?version=N` | 逐帖查看 |
| GET  | `/plans/:name/sheets/:n?version=N` | 逐张查看（跨帖同序号都会返回） |
| GET  | `/plans/:name/export?format=json\|csv\|table` | 导出 |
| POST | `/plans/:name/recalculate` | body `{totalPages,maxSignaturePages}` 生成新版本 |
| POST | `/verify` | 核验外部计划（body 为计划对象），或 `{name,version}` 核验已存版本 |
| GET  | `/verifications` | 最近 50 条核验记录 |

示例：

```powershell
$body = @{ name = 'demo'; totalPages = 6; maxSignaturePages = 16 } | ConvertTo-Json
Invoke-RestMethod http://127.0.0.1:<port>/plans -Method Post `
  -ContentType 'application/json; charset=utf-8' -Body $body
Invoke-RestMethod 'http://127.0.0.1:<port>/plans/demo/export?format=csv'
```

## 核验（verify）

请求体采用与生成结果相同的布局结构（`totalPages`、`maxSignaturePages`、
`signatures[].sheets[]`，每个页位为 `{kind:'real',page}` 或 `{kind:'blank',label}`）。
核验维度：

1. 参数合法（总页正整数、每帖上限 >=4）。
2. 帖数量、每帖纸张数量正确。
3. **每个真实页 1..总页数恰好出现一次**：漏页 `MISSING_PAGE`、重页 `DUPLICATE_PAGE`、
   越界 `OUT_OF_RANGE` 都会拒绝。
4. 补白数量正确（`BLANK_COUNT`），补白不得占用真实页号。
5. 每张纸正反面左右页位关系符合折叠规则（`POSITION_MISMATCH` / 结构错误 `MALFORMED`）。

> 注意：**仅页码总和相等不能说明合法**——交换两个页位后总和不变，但阅读顺序错误。
> 内置演示与测试专门覆盖了“交换两页即被拒绝”。

## 数据与持久化

- SQLite 数据库默认在项目内 `data/booklet.db`（自动创建目录，可用 `--db` 覆盖）。
- 表：`plans`（计划与当前版本）、`versions`（每次生成的**不可变**版本，含原始参数与
  完整布局 JSON）、`sheets`（每张纸四个页位，便于逐张核对）、`verifications`（核验结果）。
- 更改参数生成新版本后，旧版本原样保留，可按版本号独立查询/导出；**重启服务后数据仍在**。

## 演示场景

`npm run demo` 依次展示：

1. **6 页补成 8 页**：补白在外张 `B1/B2`，真实页 1..6 各一次。
2. **整 16 页**：恰好一帖 4 张纸、无补白。
3. **20 页文档**：分成 16 + 4 两帖，展示帖边界与贯穿页码（17..20）。
4. **交换两页核验**：合法计划通过；交换外张正面两页后，纸张数与页码总和都不变，
   仍因 `POSITION_MISMATCH` 被拒绝。

## 项目结构

```
src/core/imposition.ts   拼版算法与参数校验
src/core/verify.ts       外部页序核验
src/core/format.ts       JSON / CSV / 命令行表格输出
src/db/store.ts          SQLite 持久化（计划/版本/纸张/核验）
src/api/server.ts        纯 Node http REST API
src/cli/index.ts         CLI（含 serve 空闲端口选择与 demo）
test/*.test.ts           手写布局与持久化测试
```

## 已知限制

- 仅支持左侧装订、每面两页、对折骑缝的单一模型；不含胶装、多开、拼花等高级工艺。
- `node:sqlite` 在当前 Node 版本仍带实验性警告；API 保持在本项目内封装，
  未来如稳定化或更换实现，只需修改 `src/db/store.ts`。
