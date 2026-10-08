/* 打包 package.zip：思源集市要求的发布包
 * 规范（官方 bazaar）：zip 解压后文件必须在根目录、不能多套一层目录；
 * plugin.json / index.js / index.css / README*.md 必需，
 * i18n/ icon.png / preview 名为可选。
 * 清单条目平铺写入（不建父目录），核验见 kernel/bazaar/install.go:161-169。 */
import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";

const root = process.cwd();

for (const f of ["plugin.json", "index.js", "index.css"]) {
    if (!fs.existsSync(path.join(root, f))) {
        console.error("缺少必需文件：" + f + "（先执行 npm run build）");
        process.exit(1);
    }
}

const zip = new AdmZip();
for (const f of [
    "plugin.json", "index.js", "index.css",
    "icon.png", "preview.webp",
    "README.md", "README.en.md", "CHANGELOG.md",
    "THIRD-PARTY-NOTICES.md", // 第三方组件声明（BSD-2/MIT 分发义务）
    "LICENSE"
]) {
    if (fs.existsSync(path.join(root, f))) zip.addLocalFile(path.join(root, f));
}
if (fs.existsSync(path.join(root, "i18n"))) zip.addLocalFolder(path.join(root, "i18n"), "i18n");

const out = path.join(root, "package.zip");
zip.writeZip(out);
console.log("已生成 " + out + "（" + (fs.statSync(out).size / 1024).toFixed(1) + " KB）");
