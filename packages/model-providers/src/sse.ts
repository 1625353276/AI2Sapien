export interface SseChunk {
  event: string | null;
  data: string;
}

/**
 * Incremental SSE parser over "data:" / "event:" lines.
 * Handles chunks split across network boundaries.
 */
export class SseParser {
  #buffer = "";
  #eventName: string | null = null;

  push(text: string): SseChunk[] {
    this.#buffer += text;
    const chunks: SseChunk[] = [];
    let index: number;
    while ((index = this.#buffer.indexOf("\n")) !== -1) {
      const line = this.#buffer.slice(0, index);
      this.#buffer = this.#buffer.slice(index + 1);
      const chunk = parseLine(line, this.#eventName);
      if (chunk) {
        if (chunk.event !== null) this.#eventName = chunk.event;
        chunks.push(chunk);
      }
    }
    return chunks;
  }

  drain(): SseChunk[] {
    const tail = this.#buffer;
    this.#buffer = "";
    if (tail.length === 0) return [];
    const chunk = parseLine(tail, this.#eventName);
    return chunk ? [chunk] : [];
  }
}

function parseLine(line: string, eventName: string | null): SseChunk | null {
  const trimmed = line.replace(/\r$/, "");
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith(":")) return null;
  if (trimmed.startsWith("event:")) return { event: trimmed.slice(6).trim(), data: "" };
  if (trimmed.startsWith("data:")) return { event: eventName, data: trimmed.slice(5).trim() };
  return null;
}
