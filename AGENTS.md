# AGENTS.md

## 隐私规则（给 AI agent / 协作者）

- 本仓库是**公开**的时候，任何提交都会被全网看到并可能被缓存、fork；删掉再推也收不回来。
- 提交前扫一遍 diff 和新增文件：API key、token、Cookie、密码、手机号、身份证号、学号、银行卡号、真实账单/订单号、个人文档名、本机绝对路径。
- 测试数据、示例、文档一律用**虚构数据**（张三/李四、13800000000、卡号尾号 6789、`sk-xxxx` 这类），不要从真实导出里复制。
- 临时脚本、调试截图、个人文件导出不要 `git add -A` 一把带上去；只 add 明确要提交的路径。
- 下面列出的本地文件含真实凭据或个人数据，已在 `.gitignore` 中，**不要**提交、不要打印到日志/issue/PR 里，也不要改 `.gitignore` 把它们放出来。

### 本仓库的敏感文件 / 数据

- `config.json`：多 provider 配置，最容易被贴进 key。示例写 `sk-xxxx` 或 `${ENV}`。
- `plugins-state.json`、`.proxy-context/`：本地插件状态与保留的对话/工具证据。
- 仓库根目录下的调试脚本和产物（`doctest.mjs`、`lotest*.mjs`、`patch-*.mjs`、`_docx*.jpg` 等）引用了个人文档（如 `/storage/emulated/0/Download/…`），不要提交。
