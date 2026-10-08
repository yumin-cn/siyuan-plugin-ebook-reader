import path from "node:path";
import fs from "node:fs";
import { defineConfig, type Plugin } from "vite";

/* 思源插件构建：
 * - 产出仓库根目录的 index.js（CJS，module.exports = 插件类）+ index.css
 * - siyuan 保持 external（运行时由思源加载器注入 require("siyuan")）
 * - epubjs/jszip 及其依赖全部打进 index.js，离线可用（原片段「内联源码」的正解）
 * - 整个仓库可直接放进 {思源工作空间}/data/plugins/ 供开发调试
 *
 * 开发热重载（YUMIN_DEV=1，由 `npm run dev` 自动设置）：
 * 在 index.js 顶部注入 live-reload 客户端（scripts/live-client.js），
 * 配合 scripts/dev-server.mjs 的 ws 服务实现「保存 → 自动重载插件」。
 * 发布构建不含该客户端。 */
const isDev = process.env.YUMIN_DEV === "1";
const devClient = isDev ? fs.readFileSync(path.resolve(__dirname, "scripts/live-client.js"), "utf8") : "";

function injectLiveClient(): Plugin {
    return {
        name: "yumin-live-client",
        apply: "build",
        renderChunk(code, chunk) {
            if (chunk.fileName === "index.js") return devClient + "\n" + code;
            return null;
        }
    };
}

export default defineConfig({
    plugins: isDev ? [injectLiveClient()] : [],
    build: {
        outDir: ".",
        emptyOutDir: false,
        sourcemap: false,
        minify: "esbuild",
        lib: {
            entry: path.resolve(__dirname, "src/index.ts"),
            name: "YuminEbookReader",
            formats: ["cjs"]
        },
        rollupOptions: {
            external: ["siyuan"],
            output: {
                entryFileNames: "index.js",
                assetFileNames: "index.[ext]",
                exports: "default"
            }
        }
    }
});
