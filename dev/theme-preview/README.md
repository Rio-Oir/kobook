# 配色候选预览

2026-10-19 配色评审的工件。**`src/` 下没有任何文件读这里的东西**，它不参与构建，`tsconfig.json` 也只 include `src`，所以它不会进入产物。

> **这些候选已经定案，页面只作过程记录。** 用户最终选了「日间＝白 `#ffffff` / `#000000`，夜间＝黑 `#000000` / `#ffffff`」，两个模式已在应用里实现（`src/lib/theme.ts` + `src/index.css`）。下面的六套候选（中性白 / 米纸 / 旧纸 / 中性夜 / 石墨 / 纯黑）是走到那个决定之前的路径，应用不再读取它们。
>
> 想看**当前实现**的两种模式，用 `node --import tsx dev/theme-preview/shoot-modes.mjs`——它驱动应用自己的按钮，不注入任何配色。

研究结论与待决事项见 `docs/配色研究记录-2026-10-19.md`；层次感问题的诊断与规则见 `docs/配色逻辑-2026-10-19.md`。

## 跑起来

在仓库根目录：

```bash
npx vite --port 5183 --no-open
```

然后打开 `http://localhost:5183/dev/theme-preview/index.html`。

页面只写 `localStorage["gloss-theme-preview"]`。它**不写** `gloss-theme`，所以打开预览不会改变应用里已保存的主题。

## 文件

| 文件 | 作用 |
| --- | --- |
| `palettes.js` | 候选色值的唯一来源。每个候选带来源阅读器、许可、`adaptedTokens` / `carriedTokens` 与逐条说明；chrome 三阶由 `deriveChrome()` 从源的纸色与字色推导。 |
| `color.js` | WCAG 相对亮度与对比度、sRGB 插值、按目标对比度求最小步长（`solveMix` / `fadeTo` / `ensureContrast`）。 |
| `measure.js` | 一次候选要过的全部检查项。预览页与 Node 报告共用，所以屏幕上的数字和文档里的数字不会分叉。 |
| `contrast-report.mjs` | 命令行跑同一份检查：`node dev/theme-preview/contrast-report.mjs`（`--json` 输出机器可读版本）。 |
| `index.html` / `preview.css` / `preview.js` | 预览页。`index.html` 引入应用的 `src/index.css`，因此排版是线上那一套，只有颜色随候选切换。 |
| `shoot.mjs` | 在**真实应用**上截图：`node --import tsx dev/theme-preview/shoot.mjs`，输出到 `docs/evidence/theme-20261019/`。 |

## 加一个候选

候选的纸色与字色必须来自某个**开源阅读软件**的公开主题，写进 `candidate({ bg, ink, ... })` 即可——chrome、`textDim`、`outline` 会由 `deriveChrome()` 按第 4 节（见研究记录）的规则自动推导，不用手填。预览页的色板条、对比度表和色值清单都会自动带上它。

`bg` 与 `text` 之外的 token 要么在 `adaptedTokens` 里（推导值），要么在 `carriedTokens` 里（沿用应用现有值）——**没有第三类**。不要手写一个既非来源、又非推导的色值：第一版就是那么做坏的。

跑一遍 `contrast-report.mjs` 看它有没有过线。

## 截图脚本为什么不碰你的数据

`shoot.mjs` 为每张图新开一个浏览器上下文（不是你的用户目录），示例文章由应用自己的 `parseLocalMarkdown` 生成后写进这个临时上下文，调色板靠注入一个 `<style>` 块 + 改 `<html data-theme>` 生效——和应用切换主题是同一个机制，不改应用源码。
