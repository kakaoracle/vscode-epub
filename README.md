<div align="center">

<img src="https://raw.githubusercontent.com/kakaoracle/vscode-epub/main/media/icon.png" alt="EPUB Reader" width="128" />

# 📖 EPUB Reader

**在 VS Code 里，正大光明地看书。**

_你以为我是 IDE？其实我是……电子书阅读器哒！(๑•̀ㅂ•́)و✧_

[![Marketplace](https://img.shields.io/visual-studio-marketplace/v/kakaoracle.vscode-epub?style=for-the-badge&logo=visualstudiocode&logoColor=white&label=Marketplace&color=0078D7)](https://marketplace.visualstudio.com/items?itemName=kakaoracle.vscode-epub)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/kakaoracle.vscode-epub?style=for-the-badge&color=2ea043)](https://marketplace.visualstudio.com/items?itemName=kakaoracle.vscode-epub)
[![Rating](https://img.shields.io/visual-studio-marketplace/stars/kakaoracle.vscode-epub?style=for-the-badge&color=f0a020)](https://marketplace.visualstudio.com/items?itemName=kakaoracle.vscode-epub&ssr=false#review-details)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](./LICENSE)
[![Size](https://img.shields.io/badge/体积-~40%20KB-blueviolet?style=for-the-badge)](https://github.com/kakaoracle/vscode-epub)
[![VS Code](https://img.shields.io/badge/VS%20Code-1.74.0+-blue?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://code.visualstudio.com/)

</div>

---

## 它是什么

写代码写到眼睛发直，要不要偷偷摸会儿鱼？

双击一本 `.epub`，它就静静地在 VS Code 里摊开了 —— 不切窗口，不开新软件，
**就像打开一个 `.txt` 一样自然**。老板路过时你只需面无表情地盯着屏幕，
因为屏幕上确实全是代码……旁边的标签页除外。

```text
┌──────────────────────────────────────────────────────┐
│  ←  →   ☰   ⚙                      chapter-03.xhtml  │
├──────────────┬───────────────────────────────────────┤
│  目 录       │                                       │
│              │   第三章  漫长的告别                   │
│  第一章      │                                       │
│  第二章      │   那年夏天，蝉鸣得格外早。他站在       │
│ ▸第三章      │   月台上，手里攥着一张被汗水浸软       │
│  第四章      │   的车票，忽然想起很多年前也有这       │
│  第五章      │   样一个下午……                        │
│              │                                       │
│              │                                       │
│              │                                       │
├──────────────┴───────────────────────────────────────┤
│                                        第 128 页 · 41%│
└──────────────────────────────────────────────────────┘
```

---

## ✨ 功能一览

<table>
  <tr>
    <td width="50%" valign="top">

### 🗂️ 打开即用
双击 `.epub` 直接开读，跟打开普通文件没区别。
支持 **EPUB 2 / EPUB 3**，无需任何转换。

### 📑 真·分页
整页翻页 or 连续滚动，随你习惯。
支持 **1 / 2 / 3 栏**排版，宽屏也不浪费。

### 🎨 想怎么读就怎么读
字号、字体、行距、段距、页边距、对齐、栏距……
**全部走 VS Code 原生设置**，改完立刻生效。

</td>
    <td width="50%" valign="top">

### 🔖 进度自动记
关掉再开，回到你离开的那**一句话**。
按字符偏移记录，改字号改窗口都不会迷路。

### 🌙 四套配色
明亮 / 纸质米黄 / 深色 / 护眼绿，
默认 `auto` 跟随你的 VS Code 主题。

### 📚 章节目录
侧边栏章节树，支持搜索章节名跳转。
翻到章尾自动接下一章，不用手动点。

</td>
  </tr>
</table>

---

## 🚀 安装

**方式一 —— 从插件市场（推荐）**

在 VS Code 中按 `Ctrl/Cmd + P`，粘贴：

```
ext install kakaoracle.vscode-epub
```

或者打开扩展面板（`Ctrl/Cmd + Shift + X`）搜索 **EPUB Reader**。

**方式二 —— 手动安装 VSIX**

从 [Releases](https://github.com/kakaoracle/vscode-epub/releases) 下载 `.vsix`，
扩展面板 → 右上角 `…` → **从 VSIX 安装…**

**方式三 —— 从源码跑**

```bash
git clone https://github.com/kakaoracle/vscode-epub.git
cd vscode-epub
npm run package        # 打包成 vscode-epub.vsix
npm run install-local  # 装到当前 VS Code
```

---

## ⌨️ 快捷键

| 按键 | 作用 |
| :--- | :--- |
| <kbd>→</kbd> / <kbd>Space</kbd> / <kbd>PageDown</kbd> | 下一页 |
| <kbd>←</kbd> / <kbd>PageUp</kbd> | 上一页 |
| <kbd>↑</kbd> <kbd>↓</kbd> | 滚动模式下小幅滚动 |
| <kbd>Home</kbd> / <kbd>End</kbd> | 本章开头 / 结尾 |
| <kbd>Alt</kbd>+<kbd>T</kbd> | 开关目录 |
| <kbd>Alt</kbd>+<kbd>S</kbd> | 打开阅读器设置 |

鼠标滚轮也能翻页（整页翻）；切成连续滚动后滚轮就是自由滚动了。

---

## 🎛️ 常用设置

`Ctrl/Cmd + ,` 打开设置，搜 **`vscodeEpub`** 即可看到全部选项。
想只对某本书生效？写进工作区的 `.vscode/settings.json`。

| 设置项 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `vscodeEpub.fontSize` | `18` | 正文字号 |
| `vscodeEpub.theme` | `auto` | `auto` / `light` / `sepia` / `dark` / `green` |
| `vscodeEpub.pageMode` | `page` | `page` 整页翻页 / `scroll` 连续滚动 |
| `vscodeEpub.columns` | `1` | 每屏栏数 1 / 2 / 3 |
| `vscodeEpub.lineHeight` | `1.8` | 行间距倍数 |
| `vscodeEpub.rememberProgress` | `true` | 自动记忆阅读进度 |

改排版不会弄丢当前页 —— 这是这个插件的底线。

---

## 🍵 碎碎念

- 进度记的是「读到哪个字的偏移」而不是页码，所以换个排版照样找得回去。
- 同一本书在不同工作区打开，进度共享（按文件路径记）。
- 想从头再来：命令面板搜 **清除本书阅读进度**。
- 它 **从不修改你的书**，只在 VS Code 自己的存储里记一下读到哪，卸载即清理。

---

## 🛠️ 项目结构

```
src/      扩展主体（EPUB 解析 / 自定义编辑器 / 进度存储）
media/    Webview 前端（分页引擎 + 阅读样式）
tools/    开发用脚本（生成示例书、图标、解析与分页测试）
samples/  两本测试用示例 EPUB
```

```bash
npm test          # 解析 + 分页冒烟测试
npm run samples   # 重新生成示例 EPUB
npm run icon      # 重新生成扩展图标
```

---

## 📜 关于

作者：**转塘第一大作手** · License: [MIT](./LICENSE)

写这个东西的起因很简单 —— 想在写代码的地方，也能安静看会儿书。

有问题或想法 → [提 Issue](https://github.com/kakaoracle/vscode-epub/issues)，
觉得好用 → 给个 ⭐ 吧，祝你看书愉快，bug 少少 ✧◡✧

<div align="center">

<sub>用 ☕ 和一点小小的叛逆心写成。</sub>

</div>
