# PicReader

一个用于浏览深层嵌套文件夹图片的桌面应用。

## 功能特性

- **深度文件夹扫描** — 递归扫描任意层级的嵌套文件夹，自动识别图片文件
- **流式加载** — 增量推送扫描结果，大文件夹也能实时查看进度
- **网格布局** — 自适应窗口宽度的多列缩略图展示
- **虚拟滚动** — 基于 `vue-virtual-scroller`，轻松处理数万张图片
- **缩略图缓存** — 使用 `sharp` 生成缩略图并持久化缓存，二次打开秒加载
- **安全图片访问** — 自定义 `pic://` 协议只允许读取当前扫描目录和缩略图缓存目录
- **幻灯片播放** — 全屏幻灯片模式，支持播放 / 暂停和键盘导航
- **目录树导航** — 侧边栏展示完整文件夹层级，支持返回根目录筛选全部图片
- **记住上次目录** — 启动时自动打开上次浏览的文件夹
- **缓存自动清理** — 缩略图缓存超过 1 万张或 2GB 时自动清理最旧的文件

## 技术栈

- **前端**：Vue 3 + Vite
- **桌面端**：Electron 42
- **虚拟滚动**：vue-virtual-scroller
- **图片处理**：sharp
- **打包工具**：electron-builder

## 项目结构

```
picreader/
├── electron/           # Electron 主进程
│   ├── main.js         # 主进程入口（扫描、缩略图、协议注册）
│   └── preload.js      # 预加载脚本（IPC 桥接）
├── src/                # 渲染进程（Vue）
│   ├── App.vue         # 根组件
│   ├── components/     # 子组件
│   │   ├── Sidebar.vue      # 文件夹树侧边栏
│   │   ├── ThumbnailGrid.vue # 缩略图网格（虚拟滚动）
│   │   └── Slideshow.vue     # 幻灯片播放器
│   ├── main.js         # Vue 入口
│   └── styles/
│       └── main.css    # 全局样式
├── dist/               # 前端构建输出
├── dist-electron/      # Electron 构建输出
├── release/            # 打包输出
├── index.html
├── vite.config.js
└── package.json
```

## 快速开始

### 开发

```bash
# 安装依赖
npm install

# 启动开发环境
npm run dev
```

`postinstall` 会自动下载 Electron 运行时。如果安装过程被中断，重新执行 `npm install` 即可补齐。

### 构建

```bash
# 构建生产包
npm run build

# 打包为 Portable 可执行文件
npm run package
```

打包后的文件位于 `release/PicReader 1.0.0.exe`。

## 支持格式

`.jpg` `.jpeg` `.png` `.gif` `.webp` `.bmp` `.tiff` `.tif` `.svg` `.ico`

## 键盘快捷键

| 快捷键 | 功能 |
|--------|------|
| `←` / `→` | 幻灯片上一张 / 下一张 |
| `Space` | 幻灯片播放 / 暂停 |
| `Esc` | 关闭幻灯片 |

## 优化记录

本项目经历了多轮性能与体验优化：

- 升级 `protocol.registerFileProtocol` 到 `protocol.handle`
- 扫描算法从递归改为非递归栈实现，防止深层目录栈溢出
- `buildFolderTree` 使用 `Map` 优化子节点查找至 `O(1)`
- 缩略图加载增加预缓冲区和并发数，滚动更流畅
- 幻灯片预加载前后各 2 张图片，切换无延迟
- 流式数据批量缓冲，减少 Vue 响应式更新频率
- 缩略图缓存自动清理（限制 1 万张或 2GB）
- `pic://` 协议增加真实路径校验和访问白名单，避免任意本地文件读取
- 扫描任务增加 `scanId` 和取消机制，避免快速切换目录时旧结果污染新视图
- Electron 渲染进程启用 sandbox，preload 固定 CommonJS 输出以保证 `contextBridge` 注入稳定
- 缩略图 URL 增加前端 LRU 缓存，目录筛选切换时复用已加载缩略图

## License

MIT
