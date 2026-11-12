# 划词引用 · dsh-selection-quote-plugin

> 在 DeepSeek Harness 里选中一段文字，直接把它引用进输入框——会话消息、右侧栏文件预览、表格单元格都能引用，并且带上模型能定位的来源信息。
>
> **Select anything in DeepSeek Harness and drop it into the composer as a quote block — chat messages, sidebar previews, and spreadsheet cell ranges, each with the source label, sheet/range, and absolute file path the model needs to find it again.**

这是一个 [DeepSeek Harness](https://github.com/deepseek-ai) 客户端插件（Cordis bundle + Web 客户端半侧），零依赖、无构建步骤：`index.js` 只做挂载，全部逻辑在 `client.js`。

## 功能

| 位置 | 选中什么 | 结果 |
| --- | --- | --- |
| 会话消息 | 一段文字 | 选区旁浮动条「引用 \| N 字符」，点击插入 `> 引用 · 助手回复 · 第 N 轮` + 选中内容 |
| 右侧栏文本 / 代码 / Markdown 预览 | 一段文字 | 同上，并多一行 `> 来源：<文件绝对路径>` |
| 右侧栏表格预览（csv / xlsx） | 拖选一批单元格 | 浮动条「引用单元格」→ 插入逐行 `\| a \| b \|` 的表格块 + `> 工作表：<sheet>` + `> 区域：A1:C3`（左上角:右下角）+ 文件绝对路径；浮动条上同时显示 `Sheet1!A1:C3 · N 行 × M 列` |
| 右侧栏预览头部 | 不选中 | 「引用」插入整个文件的绝对路径；表格文件另有「引用单元格」读剪贴板里的区域 |
| 任意位置（键盘） | 已有选区 | `Ctrl+Shift+Q` 直接引用，不必点浮动条 |

插入后光标停在引用块下方，可以接着写追问；`Ctrl+Z` 一次撤销整次插入。

## 引用长什么样

会话：

```markdown
> 引用 · 助手回复 · 第 8 轮
> 如果那个位置你更希望是我们原来那条带字符数的浮动条
>
```

文件预览：

```markdown
> 引用 · 文件 · asar.js
> 来源：D:\deepseek-harness\default-workspace\asar.js
> const fs = require('fs');
>
```

表格（刻意不加 `| --- |` 表头分隔行——框选区域不一定有标题行）：

```markdown
> 引用 · 表格 · regions.xlsx
> 工作表：华东
> 区域：B2:D5
> 来源：D:\work\regions.xlsx
>
> | 区域 | 负责人 | 营收 |
> | 华东 | 张三 | 120 |
```

## 与 DSH 内置引用的关系

DSH 0.2.2 自带 `@deepseek-ai/dsh-message-quotes`：它在会话选区旁放一个「引用文本」按钮，并把 `> ` 行渲染成引用卡片。

本插件**接管按钮、保留渲染**：在 `conversation.chat.text-interaction` 的 `quote` 位以 `priority: -1` 注册自己的组件（keyed slot 同优先级抢同一个 key 会直接抛错），于是会话里出现的是本插件的浮动条与引用块；内置插件继续负责把引用显示成卡片，所以**请不要停用 `message-quotes`**——用户消息本身是纯文本渲染，停用后引用会退化成字面 `>` 文本。

## 安装

三种方式，任选其一（都通过 DSH 的 `plugin_manager` 完成，不要手改 profile 文件）：

1. **GitHub 直装（推荐）**

   在 DSH 的设置 → 插件里粘贴：

   ```
   github:YuzhenZhou1327/dsh-selection-quote
   ```

   或者直接对会话里的 AI 说：「用 plugin_manager 安装 `github:YuzhenZhou1327/dsh-selection-quote`」。

2. **npm**

   ```
   dsh-selection-quote-plugin
   ```

3. **本地目录**：传该目录的绝对路径即可（`link:` 方式，适合开发）。

安装后页面需要重新加载一次（设置 → 重新加载界面，或 `Ctrl+R`）。

## 兼容性

- 需要 DSH **0.2.2 及以上**：本插件依赖 `conversation.chat.text-interaction` 插槽接管会话选区按钮。更老的 Harness 没有这个插槽，插件会自动退回自己的浮动条（会话里也能用，只是不接管内置按钮）。
- 引用上限 6000 字符，超出部分截断。
- 表格的 sheet 名与选区来自 FortuneSheet 渲染器自己的 UI（`.luckysheet-sheets-item-active` 与 `.fortune-name-box`），DSH 改版若动了这两处 class 需要同步调整 `sheetLocation()`。

## 已知限制

- **HTML 预览是 sandbox iframe**，父页面读不到里面的选区，因此 HTML 里选文字不会出现浮动条。可以用预览头部的「引用」引用整个文件，或把该文件切到「纯文本」渲染再选。
- PDF / 图片预览没有可选文本，只能引用文件本身。
- 表格选区在 canvas 里，靠向渲染器派发一次合成的 `Ctrl+C` 走它自己的复制流程，因此需要页面处于可聚焦状态（预览刚加载完立刻拖选偶尔会慢一拍）。

## 实现要点

- 四个插槽：`conversation.composer.dock`（拿到 `InputActions` 的无视觉 bridge）、`shell.overlay`（预览区浮动条，root 作用域）、`sidebar.right.tab.document.actions`（预览头部按钮，能拿到文件绝对路径）、`conversation.chat.text-interaction` 的 key `quote`（接管会话选区按钮）。
- 写入输入框只走公开的 `InputActions.captureInsertion()` + `insertText()`，不碰编辑器内部结构，因此每次插入都是一次可撤销的纯文本编辑。
- 会话里的选区手势（定位、滚动隐藏、Escape/外部点击关闭、清除选区）由 DSH 的 Chat text-interaction 服务负责，插件只渲染内容——所以浮动条样式可以完全自定义。
- 表格选区的文本只能从渲染器自己的复制流程里拿：拖选结束后派发合成 `Ctrl+C`，再依次尝试 `sessionStorage.localClipboard`、`clipboardData`、`navigator.clipboard`。

## 开发

```bash
node scripts/check.mjs   # 校验三处必须一致的地方：包名 = client.js 里的模块 id = cordis.patch.yml 的 name
node --check client.js   # 语法检查（无构建步骤）
```

**改名时三处必须一起改**：`package.json` 的 `name`、`client.js` 顶部 `window.__ModuleLoader__.load({ id })`、`cordis.patch.yml` 里 insert 的 `name`。模块 id 与包名不一致时，Host 仍会按包名加载 bundle，loader 会把它执行两次并报 `duplicate factory registration`——表现为 **DSH 重启时渲染进程启动失败**（`renderer-startup` 崩溃报告），而不是普通的插件报错。`scripts/check.mjs` 就是防这个的。

profile 里以 `link:` 方式安装时，改完 `client.js` 会被 client-hmr 自动热重载，几秒内生效，无需重启或刷新。

## License

[MIT](./LICENSE) © 2026 YuzhenZhou1327
