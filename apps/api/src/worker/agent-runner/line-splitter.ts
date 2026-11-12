/** Turns arbitrary stream chunks into whole lines. Call `flush()` at the end for a last unterminated line. */
export class LineSplitter {
  private buffer = '';

  constructor(private readonly onLine: (line: string) => void) {}

  push(chunk: Buffer | string): void {
    this.buffer += chunk.toString('utf8');
    let index: number;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      this.onLine(this.buffer.slice(0, index).replace(/\r$/, ''));
      this.buffer = this.buffer.slice(index + 1);
    }
  }

  flush(): void {
    if (this.buffer.length > 0) this.onLine(this.buffer.replace(/\r$/, ''));
    this.buffer = '';
  }
}
