import type { CaptureInfo } from '../shared/capture';

export type PageExtraction = { text: string; captureInfo: CaptureInfo };

const OMITTED = 'script, style, noscript, template, svg, nav, footer, aside, form, button, input, select, textarea, [hidden], [inert], [aria-hidden="true"], [role="navigation"], [role="complementary"], [role="banner"], [role="contentinfo"], [role="toolbar"], [role="menu"], [role="dialog"], [role="button"], [role="search"], [role="advertisement"], [data-ad], [data-ad-slot], [aria-label="Advertisement" i], .ad, .ads, .advertisement, .sidebar';
const EMBEDDED = 'iframe, object, embed, canvas, video, audio';
const EMBED_WARNING = 'Embedded content was not captured. Open an HTML or text version and capture it separately.';
const CLOSED_WARNING = 'Collapsed content was not captured. Expand it and capture again.';
const LOADING_WARNING = 'Content is still loading. Wait for it to finish and capture again.';

type Candidate = PageExtraction & { root: Element; readingCharacters: number };

export function extractPage(document: Document): PageExtraction {
  if (document.contentType.split(';')[0]?.trim().toLowerCase() === 'application/pdf') {
    throw new Error('PDF capture is not supported. Open an HTML or text version of this document and capture it instead.');
  }
  const view = document.defaultView;
  const styles = new WeakMap<Element, CSSStyleDeclaration>();
  const styleOf = (element: Element): CSSStyleDeclaration => {
    let style = styles.get(element);
    if (!style) {
      style = view!.getComputedStyle(element);
      styles.set(element, style);
    }
    return style;
  };
  const isOmitted = (element: Element): boolean => {
    if (element.matches(OMITTED)) return true;
    if (element.tagName === 'HEADER' && !element.closest('article, main, [role="main"]')) return true;
    const style = styleOf(element);
    return style.display === 'none' || style.contentVisibility === 'hidden';
  };
  const isReachable = (element: Element): boolean => {
    for (let current: Element | null = element; current; current = current.parentElement) {
      if (isOmitted(current)) return false;
      if (current.tagName === 'DETAILS' && !current.hasAttribute('open') && current !== element) {
        if (!current.querySelector('summary')?.contains(element)) return false;
      }
    }
    return true;
  };

  const render = (root: Element, source: CaptureInfo['source']): Candidate => {
    const warnings = new Set<string>();
    const codeBlocks: string[] = [];
    let codePrefix = '\uE000webRecallCode';
    while (root.textContent?.includes(codePrefix)) codePrefix += '_';
    let readingCharacters = 0;

    const read = (node: Node, preformatted = false): string => {
      if (node.nodeType === 3) {
        const parent = node.parentElement;
        if (!parent || styleOf(parent).visibility === 'hidden' || styleOf(parent).visibility === 'collapse') return '';
        const text = node.textContent || '';
        if (!parent.closest('h1, h2, h3, h4, h5, h6, header')) readingCharacters += text.trim().length;
        return preformatted || /^(pre|break-spaces)/.test(styleOf(parent).whiteSpace) ? text : text.replace(/\s+/g, ' ');
      }
      if (node.nodeType !== 1) return '';
      const element = node as Element;
      if (isOmitted(element)) return '';
      const style = styleOf(element);
      if (element.matches(EMBEDDED)) {
        if (style.visibility !== 'hidden' && style.visibility !== 'collapse') warnings.add(EMBED_WARNING);
        return '';
      }
      if (element.getAttribute('aria-busy') === 'true' && style.visibility !== 'hidden') warnings.add(LOADING_WARNING);
      if (element.tagName === 'BR') return style.visibility === 'hidden' ? '' : '\n';
      let children = Array.from(element.childNodes);
      if (element.tagName === 'DETAILS' && !element.hasAttribute('open')) {
        const summary = Array.from(element.children).find(child => child.tagName === 'SUMMARY');
        const previousWarnings = new Set(warnings);
        const previousReadingCharacters = readingCharacters;
        warnings.clear();
        const omittedText = children.filter(child => child !== summary).map(child => read(child)).join('');
        const omittedEmbed = warnings.has(EMBED_WARNING);
        warnings.clear();
        previousWarnings.forEach(warning => warnings.add(warning));
        readingCharacters = previousReadingCharacters;
        if (omittedText.trim() || omittedEmbed) warnings.add(CLOSED_WARNING);
        children = summary ? [summary] : [];
      }
      if (element.tagName === 'PRE' && !preformatted) {
        const text = children.map(child => read(child, true)).join('');
        if (!text.trim()) return '';
        const index = codeBlocks.push(text) - 1;
        return `\n${codePrefix}${index}\uE001\n`;
      }
      if (element.tagName === 'TR' && !preformatted) {
        const cells = Array.from(element.children).filter(child => child.matches('th, td') && !isOmitted(child));
        return cells.length ? `\n${cells.map(cell => read(cell).trim().replace(/\s*\n\s*/g, ' ')).join(' | ')}\n` : '';
      }
      const text = children.map(child => read(child, preformatted)).join('');
      if (!text.trim()) return '';
      if (preformatted) return text;
      if (/^H[1-6]$/.test(element.tagName)) return `\n${'#'.repeat(Number(element.tagName[1]))} ${text.trim()}\n`;
      if (element.tagName === 'LI') {
        const list = element.parentElement;
        let marker = '-';
        if (list?.tagName === 'OL') {
          const items = Array.from(list.children).filter(child => child.tagName === 'LI');
          const reversed = list.hasAttribute('reversed');
          let number = Number(list.getAttribute('start') ?? (reversed ? items.length : 1));
          for (const item of items) {
            if (item.hasAttribute('value')) number = Number(item.getAttribute('value'));
            if (item === element) break;
            number += reversed ? -1 : 1;
          }
          marker = `${number}.`;
        }
        let depth = 0;
        for (let ancestor = list?.parentElement; ancestor && root.contains(ancestor); ancestor = ancestor.parentElement) {
          if (ancestor.matches('ul, ol')) depth++;
        }
        return `\n${'  '.repeat(depth)}${marker} ${text.trim()}\n`;
      }
      return /^(inline|contents)/.test(style.display) || element.matches('th, td') ? text : `\n${text}\n`;
    };

    let text = '';
    if (isReachable(root)) {
      text = read(root).replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+\n/g, '\n\n').replace(/\n{3,}/g, '\n\n').trim();
      text = text.replace(new RegExp(`${codePrefix}(\\d+)\uE001`, 'g'), (_token, index: string) => codeBlocks[Number(index)] || '');
      if (root.parentElement?.closest('[aria-busy="true"]')) warnings.add(LOADING_WARNING);
    }
    return { root, text, readingCharacters, captureInfo: { source, warnings: [...warnings] } };
  };

  if (!document.body || !view) return { text: '', captureInfo: { source: 'body', warnings: [] } };
  const body = render(document.body, 'body');
  const mains = Array.from(document.querySelectorAll('main, [role="main"]'))
    .filter(root => !root.parentElement?.closest('main, [role="main"]'))
    .map(root => render(root, 'main')).filter(candidate => candidate.text.trim());
  const articles = Array.from(document.querySelectorAll('article'))
    .filter(root => !root.parentElement?.closest('article'))
    .map(root => render(root, 'article')).filter(candidate => candidate.text.trim());
  let selected = body;
  const main = mains[0];
  const sameText = (left: string, right: string): boolean => left.replace(/\s+/g, ' ').trim() === right.replace(/\s+/g, ' ').trim();
  if (mains.length === 1 && main && sameText(body.text, main.text)) selected = main;
  const article = articles[0];
  if (articles.length === 1 && article && article.readingCharacters && selected.root.contains(article.root) && sameText(selected.text, article.text)) {
    const losesMainWarnings = selected.captureInfo.source === 'main'
      && selected.captureInfo.warnings.some(warning => !article.captureInfo.warnings.includes(warning));
    if (!losesMainWarnings) selected = article;
  }
  if (selected.captureInfo.warnings.includes(EMBED_WARNING) && !selected.readingCharacters) {
    throw new Error('This page only contains embedded content. Open an HTML or text version of the embedded document and capture it instead.');
  }
  return { text: selected.text, captureInfo: selected.captureInfo };
}
