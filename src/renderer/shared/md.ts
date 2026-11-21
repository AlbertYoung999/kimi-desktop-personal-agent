/**
 * 轻量 markdown 渲染(转义安全,支持 code/bold/italic/list/table)。
 * 从 shared/chat-panel.ts 抽取,工厂与 remote 手机端共用;行为与抽取前完全一致。
 */

// ---------- tiny markdown renderer (escaped, code/bold/italic/lists) ----------
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function mdToHtml(md: string): string {
  const blocks: string[] = [];
  // extract fenced code blocks first, replaced by \x00N\x00 sentinels (escapeHtml leaves \x00 intact)
  let text = md.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, _lang, code) => {
    blocks.push(`<pre><code>${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`);
    return `\x00${blocks.length - 1}\x00`;
  });
  text = escapeHtml(text);
  // images first, then markdown links (negative lookbehind so ![...]( ) isn't eaten), then bare URLs
  text = text
    .replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g, '<img class="md-img" src="$2" alt="$1" loading="lazy" />')
    .replace(/(?<!!)\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" data-link>$1</a>')
    .replace(/(?<!href=")(?<!src=")(https?:\/\/[^\s<)。，、；：！？」』]+)/g, (m) => {
      const trailing = m.match(/[.,;:!?]+$/)?.[0] ?? '';
      const url = m.slice(0, m.length - trailing.length);
      return `<a href="${url}" data-link>${url}</a>${trailing}`;
    });
  text = text
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  const lines = text.split('\n');
  const out: string[] = [];
  let list: 'ul' | 'ol' | null = null;
  const closeList = () => {
    if (list) { out.push(`</${list}>`); list = null; }
  };
  const splitRow = (row: string): string[] =>
    row.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  let i = 0;
  while (i < lines.length) {
    const trimmed = lines[i].trim();
    // markdown table: header row + |---| separator row
    if (trimmed.startsWith('|') && i + 1 < lines.length && /^\|[\s:|-]+\|?$/.test(lines[i + 1].trim())) {
      closeList();
      const header = splitRow(trimmed);
      i += 2; // skip header + separator
      const body: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        body.push(splitRow(lines[i].trim()));
        i++;
      }
      out.push(
        '<div class="table-wrap"><table class="md-table"><thead><tr>' +
          header.map((c) => `<th>${c}</th>`).join('') +
          '</tr></thead><tbody>' +
          body.map((r) => '<tr>' + r.map((c) => `<td>${c}</td>`).join('') + '</tr>').join('') +
          '</tbody></table></div>',
      );
      continue;
    }
    i++;
    const sentinel = trimmed.match(/^\x00(\d+)\x00$/);
    if (sentinel) {
      closeList();
      out.push(blocks[Number(sentinel[1])]);
      continue;
    }
    const ul = trimmed.match(/^[-*•]\s+(.*)$/);
    const ol = trimmed.match(/^\d+[.、]\s+(.*)$/);
    if (ul) {
      if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
      out.push(`<li>${ul[1]}</li>`);
    } else if (ol) {
      if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; }
      out.push(`<li>${ol[1]}</li>`);
    } else if (/^#{1,4}\s+/.test(trimmed)) {
      closeList();
      out.push(`<p><strong>${trimmed.replace(/^#{1,4}\s+/, '')}</strong></p>`);
    } else if (trimmed === '') {
      closeList();
    } else {
      closeList();
      out.push(`<p>${trimmed}</p>`);
    }
  }
  closeList();
  return out.join('');
}
