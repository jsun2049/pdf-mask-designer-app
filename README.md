# PDF Mask Designer

本地 PDF 遮挡工具，支持：

- 上传 PDF 后可视化圈选遮挡坐标
- 分开配置单页（奇数页）和双页（偶数页）矩形
- 简单模式直接处理并下载 PDF，不依赖 Python
- 高级模式导出 JSON 配置，供单文件或批量脚本复用
- 打包为 macOS / Windows 桌面应用

## 快速开始

如果你只想直接使用：

1. 安装依赖：`npm install`
2. 启动桌面版：`npm start`
3. 选择 PDF，填写开始页和结束页
4. 分别圈选奇数页和偶数页矩形
5. 点击“处理并下载当前 PDF”

这个流程不需要 Python。

## 目录结构

```text
desktop/     Electron 主进程与预加载脚本
renderer/    本地前端页面与 PDF.js / pdf-lib 依赖
scripts/     Python 高级处理脚本（单文件 / 批量）
examples/    示例配置
```

## 适合的使用场景

- 同一个 logo 或角标在多页固定位置，需要批量遮挡
- 奇数页与偶数页版式不同，需要两套矩形规则
- 需要先用前端圈选，再把同一份规则批量应用到一批 PDF

## 简单模式

桌面版或本地网页里：

1. 选择 PDF
2. 填写开始页和结束页
3. 在奇数页圈选“单页(奇数页)”矩形
4. 在偶数页圈选“双页(偶数页)”矩形
5. 点击“处理并下载当前 PDF”

这个流程不依赖 Python。

## 高级模式

高级模式会导出如下信息：

- 可复用的 JSON 配置
- 单个 PDF 的处理命令

### 单文件脚本

```bash
python3 scripts/mask_pdf_region.py \
  "/path/to/input.pdf" \
  --config "/path/to/mask-config.json" \
  -o "/path/to/output-masked.pdf" \
  --force
```

### 批量处理脚本

```bash
python3 scripts/batch_mask_pdf.py \
  "/path/to/pdf-folder" \
  --config "/path/to/mask-config.json" \
  --output-dir "/path/to/pdf-folder-masked" \
  --force
```

可选参数：

- `--recursive`：递归处理子目录
- `--verbose`：打印详细进度

## 本地开发

```bash
npm install
npm start
```

如果你只是想把前端当作本地网页使用，也可以在仓库根目录启动一个静态文件服务，例如：

```bash
python3 -m http.server 8765
```

然后打开 `http://127.0.0.1:8765/renderer/index.html`。

## 打包桌面应用

### macOS

```bash
npm install
npm run dist:mac
```

### Windows

```bash
npm install
npm run dist:win
```

### 仅生成未压缩目录

```bash
npm install
npm run dist:dir
```

构建输出默认位于 `dist/`。

## Python 依赖

如果你要用 `scripts/` 里的高级脚本：

```bash
python3 -m pip install -r requirements-pdf-tools.txt
```

## 示例配置

参考 `examples/mask-config.sample.json`。

当前配置格式支持：

- `page_range.start`
- `page_range.end`
- `rules[].apply_to = odd|even|all`
- `rules[].rects[]`

## 注意事项

- 桌面版首次打开可能被系统拦截，因为默认是未签名构建。
- Windows 便携版第一次运行可能被 SmartScreen 提示。
- 本仓库默认不提交 `dist/` 和 `node_modules/`。

## 许可

MIT License，见 `LICENSE`。
