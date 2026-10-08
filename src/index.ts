/* 于民·epub阅读器插件入口
 * 兼容旧 snippet：onload 时清理其手工注入的 <style id=epubMiniStyle> */
import { Plugin } from "siyuan";
import "./style.css";
import { attachInterceptor, detachInterceptor } from "./click";
import { openEpub } from "./open";
import { ensureIcons } from "./icons";
import { bindPlugin, pruneOrphanAnnotations, stopPrune, flushState } from "./state";

const LEGACY_CSS_ID = "epubMiniStyle"; // 代码片段版本遗留的样式节点 id

export default class YuMinEbookReaderPlugin extends Plugin {
    onload() {
        // 清理旧 snippet 版本手工注入的样式
        try {
            const legacy = document.getElementById(LEGACY_CSS_ID);
            if (legacy && legacy.parentNode) legacy.parentNode.removeChild(legacy);
        } catch (e) { /* 忽略 */ }

        // 作者卡片/夜间开关的自定义图标符号（ymer 前缀，避免与思源 sprite 重名）
        ensureIcons();
        attachInterceptor();
        // 标注状态改存插件数据目录（随思源同步）：注入实例 + 清扫已删书籍的孤儿标注文件
        bindPlugin(this);
        pruneOrphanAnnotations();
        // 供外部调用 / 测试
        window.__EPUB_MINI__ = { openEpub: openEpub };
        const i18n = this.i18n as any;
        console.log("[EPUB-MINI]", i18n.helloPlugin || "yumin-ebook-reader 就绪：点击 .epub 链接 → 原生页签打开（连续滚动，滚轮自动加载上下章）");
    }

    onunload() {
        detachInterceptor();
        stopPrune();      // 停掉孤儿标注的周期复查定时器
        flushState(); // 防抖中未落盘的标注状态立即写入
        try { delete window.__EPUB_MINI__; } catch (e) {}
        const i18n = this.i18n as any;
        console.log("[EPUB-MINI]", i18n.byePlugin || "yumin-ebook-reader 已卸载");
    }
}
