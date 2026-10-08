# 开发说明 / Development

面向插件开发者；普通用户无需阅读。
For plugin development only — regular users don't need this.

## 构建 / Build

```bash
npm install
npm run build      # → 仓库根目录生成 index.js + index.css / build at repo root
npm run package    # → 生成集市发布包 package.zip / marketplace package
```

## 开发调试 / Development

把本仓库复制（或软链）到思源工作空间 / copy or symlink this repo into your SiYuan workspace:

```
{思源工作空间}/data/plugins/siyuan-plugin-ebook-reader/
```

然后 `npm run dev`（watch 构建），重启思源，在 设置 → 集市 → 已下载 → 插件 里启用即可。
Then run `npm run dev` (watch build), restart SiYuan, and enable the plugin under Settings → Marketplace → Downloaded → Plugins.

> **注意**：`npm run dev` / `npm run make-link` 依赖 `scripts/dev-server.mjs`、
> `scripts/live-client.js`、`scripts/make_dev_link.js` —— 这三个脚本写死了作者本机的
> 思源工作空间路径与调试端口，属于本地开发工具，**不随本仓库分发**（见 .gitignore）。
> 自行 clone 后如需 watch 调试，按下面的等价步骤手动做即可：
>
> ```bash
> npm run watch                                  # 等价于 dev 的 watch 构建
> # 把 index.js / index.css 手动拷到 {思源工作空间}/data/plugins/siyuan-plugin-ebook-reader/
> ```
>
> 单纯构建与打发布包（`npm run build` / `npm run package`）**不需要**这三个脚本。
> Note: the three local dev-workflow scripts are intentionally not distributed
> (they hardcode the author's local workspace paths). `build` and `package` work without them.

## 路线图 / Roadmap

- [ ] UI 文案迁移到 i18n / Migrate UI strings to i18n
- [ ] 支持 TXT / MOBI / TXT & MOBI support
