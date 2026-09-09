# 注意事项
1. 每次改动完成后需要commit
2. 每次改动后需要跟进测试，并确保测试全部通过

## 弈境 Demo

这是一个根据《轻量化技术方案》制作的围棋棋谱管理与 AI 复盘交互原型，包含棋谱搜索、SGF 导入、棋盘播放、落点标记、模拟 AI 推荐与胜率走势。

```powershell
npm start
```

浏览器访问 `http://127.0.0.1:4173`。运行测试：

```powershell
npm test
```

Demo 默认连接本机 `G:\Edge_download\KataGo` 下的 TensorRT / CUDA KataGo。需要使用其他安装位置时，可设置 `KATAGO_EXE`、`KATAGO_MODEL`、`KATAGO_CONFIG` 和 `KATAGO_DATA_DIR` 环境变量。

## Tauri 桌面版

正式版桌面壳位于 `src-tauri`，使用 Rust、SQLite/FTS5 和 Tauri 2。开发运行：

```powershell
npm run tauri dev
```

生成 Windows 可执行文件：

```powershell
npm run tauri -- build --debug --no-bundle
```

桌面后端已经提供棋谱查询、SGF 去重导入、自定义文件夹、重命名/移动分类以及 KataGo 分析命令。浏览器模式仍由 `npm start` 提供，便于快速调试界面。
