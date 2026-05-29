import { Transform } from 'stream';

/**
 * A Transform stream that skips specified 1-based data row numbers.
 * The header row is always passed through unchanged.
 * Row numbering matches the preview endpoint (first data row = 1).
 */
export function createFilterRowsTransform(skipRowNums: Set<number>): Transform {
  let headerDone = false;
  let rowNum = 0;
  let leftover = '';

  return new Transform({
    transform(chunk: Buffer, _enc, callback) {
      const text = leftover + chunk.toString('utf8');
      const lines = text.split('\n');
      leftover = lines.pop() ?? '';

      for (const raw of lines) {
        const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
        if (!headerDone) {
          this.push(line + '\n');
          headerDone = true;
        } else {
          rowNum++;
          if (!skipRowNums.has(rowNum)) this.push(line + '\n');
        }
      }
      callback();
    },
    flush(callback) {
      if (leftover) {
        const line = leftover.endsWith('\r') ? leftover.slice(0, -1) : leftover;
        if (!headerDone) {
          this.push(line);
        } else {
          rowNum++;
          if (!skipRowNums.has(rowNum)) this.push(line);
        }
      }
      callback();
    },
  });
}
