/** A deliberately small Markdown subset. Raw HTML, images and external link syntax stay text. */
function appendInline(parent: HTMLElement, text: string, citations: Set<number>): void {
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[\d+\])/g;
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    parent.append(document.createTextNode(text.slice(offset, match.index)));
    const token = match[0];
    const number = Number(token.slice(1, -1));
    if (token.startsWith('[') && citations.has(number)) {
      const link = document.createElement('a');
      link.href = `#ask-source-${number}`;
      link.textContent = token;
      link.setAttribute('aria-label', `Source ${number}`);
      parent.append(link);
    } else if (token.startsWith('**')) {
      const strong = document.createElement('strong'); strong.textContent = token.slice(2, -2); parent.append(strong);
    } else if (token.startsWith('*') || token.startsWith('`')) {
      const node = document.createElement(token.startsWith('`') ? 'code' : 'em'); node.textContent = token.slice(1, -1); parent.append(node);
    } else parent.append(document.createTextNode(token));
    offset = (match.index || 0) + token.length;
  }
  parent.append(document.createTextNode(text.slice(offset)));
}

export function renderAnswer(target: HTMLElement, text: string, sourceIndices: number[] = []): void {
  const citations = new Set(sourceIndices);
  const fragment = document.createDocumentFragment();
  let paragraph: HTMLElement | null = null;
  let list: HTMLElement | null = null;
  let code: HTMLElement | null = null;
  for (const line of text.split('\n')) {
    if (line.trim().startsWith('```')) {
      if (code) code = null;
      else { const pre = document.createElement('pre'); code = document.createElement('code'); pre.append(code); fragment.append(pre); }
      paragraph = list = null;
      continue;
    }
    if (code) { code.append(document.createTextNode(line + '\n')); continue; }
    if (!line.trim()) { paragraph = list = null; continue; }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    const item = /^\s*(?:[-*+] |\d+[.)] )(.+)$/.exec(line);
    if (heading) {
      const h = document.createElement(heading[1]!.length === 1 ? 'h2' : 'h3');
      appendInline(h, heading[2]!, citations); fragment.append(h); paragraph = list = null;
    } else if (item) {
      const tag = /^\s*\d/.test(line) ? 'OL' : 'UL';
      if (!list || list.tagName !== tag) { list = document.createElement(tag.toLowerCase()); fragment.append(list); }
      const li = document.createElement('li'); appendInline(li, item[1]!, citations); list.append(li); paragraph = null;
    } else {
      list = null;
      if (!paragraph) { paragraph = document.createElement('p'); fragment.append(paragraph); }
      else paragraph.append(document.createTextNode(' '));
      appendInline(paragraph, line, citations);
    }
  }
  target.replaceChildren(fragment);
}
