/** Literal output must stay literal even when it contains Markdown fences. */
export function codeBlock(text: string, language = "text"): string {
  const fence = "`".repeat(Math.max(3, ...Array.from(text.matchAll(/`+/g), m => m[0].length + 1)));
  return `${fence}${language}\n${text.replace(/\n$/, "")}\n${fence}`;
}

export function inlineCode(text: string): string {
  const fence = "`".repeat(Math.max(1, ...Array.from(text.matchAll(/`+/g), m => m[0].length + 1)));
  const value = text.replace(/[\r\n]+/g, " ");
  const pad = value.startsWith("`") || value.endsWith("`") || /^ .+ $/.test(value) ? " " : "";
  return `${fence}${pad}${value}${pad}${fence}`;
}

/** Prefer paragraph/line boundaries and never cut a UTF-16 surrogate pair. */
function splitPlain(text: string, maxChars: number): string[] {
  const pieces: string[] = [];
  while (text.length > maxChars) {
    let end = maxChars;
    for (const boundary of ["\n\n", "\n", " "]) {
      const at = text.lastIndexOf(boundary, maxChars - boundary.length);
      if (at >= maxChars / 2) { end = at + boundary.length; break; }
    }
    if (/[\uD800-\uDBFF]/.test(text[end - 1]!) && /[\uDC00-\uDFFF]/.test(text[end]!)) end--;
    // A single supplementary character can exceed an unusually tiny preference.
    if (!end) end = 2;
    pieces.push(text.slice(0, end)); text = text.slice(end);
  }
  if (text) pieces.push(text);
  return pieces;
}

/** Chat messages are independent Markdown documents, including continued code blocks. */
export function splitMarkdown(text: string, maxChars: number): string[] {
  if (!Number.isSafeInteger(maxChars) || maxChars <= 0) throw new Error("分段长度必须是正整数");
  const chunks: string[] = [];
  let current = "", position = 0;
  const append = (part: string) => {
    if (current && current.length + part.length > maxChars) { chunks.push(current); current = ""; }
    current += part;
  };
  const prose = (part: string) => { for (const piece of splitPlain(part, maxChars)) append(piece); };
  const openings = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)(?:\r?\n|$)/gm;
  for (let open: RegExpExecArray | null; (open = openings.exec(text));) {
    if (open[1]![0] === "`" && open[2]!.includes("`")) continue;
    prose(text.slice(position, open.index));
    const marker = open[1]!;
    const closes = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}[ \\t]*(?:\\r?\\n|$)`, "gm");
    closes.lastIndex = openings.lastIndex;
    const close = closes.exec(text);
    const end = close ? closes.lastIndex : text.length;
    const opening = open[0].endsWith("\n") ? open[0] : `${open[0]}\n`;
    const closing = close?.[0] ?? marker;
    const body = text.slice(openings.lastIndex, close?.index ?? text.length);
    const block = text.slice(open.index, end) + (close ? "" : `${body.endsWith("\n") ? "" : "\n"}${marker}`);
    if (block.length <= maxChars) append(block);
    else {
      if (current) { chunks.push(current); current = ""; }
      // Reserve the newline before a synthetic closing fence as well as both fences.
      const budget = Math.max(2, maxChars - opening.length - closing.length - 1);
      const pieces = splitPlain(body, budget);
      if (!pieces.length) chunks.push(block);
      // Each continuation is a separate document, even when its short last piece would fit.
      for (const piece of pieces) chunks.push(`${opening}${piece}${piece.endsWith("\n") ? "" : "\n"}${closing}`);
    }
    position = end; openings.lastIndex = end;
  }
  prose(text.slice(position));
  if (current) chunks.push(current);
  return chunks;
}
