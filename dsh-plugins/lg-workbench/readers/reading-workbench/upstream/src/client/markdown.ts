/**
 * Markdown 渲染：marked 转 HTML，DOMPurify 消毒后再交给 React 注入。
 * 阅读材料是本地文件，但仍按不可信输入处理——文档里的 script/事件属性会被清掉。
 */
import DOMPurify from 'dompurify';
import { marked } from 'marked';

/** 渲染 Markdown 为安全 HTML。 */
export function renderMarkdown(source: string): string {
  const html = marked.parse(source, { async: false, gfm: true, breaks: false });
  const text = typeof html === 'string' ? html : '';
  return DOMPurify.sanitize(text, { USE_PROFILES: { html: true } });
}

/**
 * 消毒既有 HTML（EPUB/MOBI 章节已是 HTML，不经过 marked 转换）。
 * 允许 svg（封面与插图），清除脚本与事件属性。
 */
export function sanitizeHtml(source: string): string {
  return DOMPurify.sanitize(source, { USE_PROFILES: { html: true, svg: true } });
}
