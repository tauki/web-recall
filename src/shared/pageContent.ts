export function pageContent(page: { text?: string; chunks?: Array<{ text: string }> }): string {
  return page.text || page.chunks?.map(chunk => chunk.text).join('\n') || '';
}
