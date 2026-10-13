/**
 * Minimal growable binary writer / bounded reader (little-endian).
 *
 * Used by the wire codecs in ../protocol/codec.ts. The reader is intentionally
 * strict: any read past the end throws instead of silently returning garbage,
 * so a malformed or truncated packet fails loudly in tests and on the server.
 */

const MIN_GROWTH_CAPACITY = 64;

export class ByteWriter {
  private buffer: ArrayBuffer;
  private view: DataView;
  private offset = 0;

  constructor(initialCapacity = 256) {
    this.buffer = new ArrayBuffer(Math.max(0, initialCapacity));
    this.view = new DataView(this.buffer);
  }

  /** Bytes written so far. */
  get length(): number {
    return this.offset;
  }

  private ensure(extra: number): void {
    const needed = this.offset + extra;
    if (needed <= this.buffer.byteLength) return;
    let capacity = Math.max(this.buffer.byteLength * 2, MIN_GROWTH_CAPACITY);
    while (capacity < needed) capacity *= 2;
    const next = new ArrayBuffer(capacity);
    new Uint8Array(next).set(new Uint8Array(this.buffer, 0, this.offset));
    this.buffer = next;
    this.view = new DataView(next);
  }

  u8(value: number): this {
    this.ensure(1);
    this.view.setUint8(this.offset, value);
    this.offset += 1;
    return this;
  }

  i8(value: number): this {
    this.ensure(1);
    this.view.setInt8(this.offset, value);
    this.offset += 1;
    return this;
  }

  u16(value: number): this {
    this.ensure(2);
    this.view.setUint16(this.offset, value, true);
    this.offset += 2;
    return this;
  }

  i16(value: number): this {
    this.ensure(2);
    this.view.setInt16(this.offset, value, true);
    this.offset += 2;
    return this;
  }

  u32(value: number): this {
    this.ensure(4);
    this.view.setUint32(this.offset, value, true);
    this.offset += 4;
    return this;
  }

  f32(value: number): this {
    this.ensure(4);
    this.view.setFloat32(this.offset, value, true);
    this.offset += 4;
    return this;
  }

  bytes(source: Uint8Array): this {
    this.ensure(source.byteLength);
    new Uint8Array(this.buffer, this.offset, source.byteLength).set(source);
    this.offset += source.byteLength;
    return this;
  }

  /** Copy of the written bytes (detached from the internal buffer). */
  toBytes(): Uint8Array {
    return new Uint8Array(this.buffer.slice(0, this.offset));
  }
}

export class ByteReader {
  private view: DataView;
  private offset = 0;
  readonly length: number;

  constructor(source: Uint8Array) {
    this.view = new DataView(source.buffer, source.byteOffset, source.byteLength);
    this.length = source.byteLength;
  }

  /** Bytes not yet read. */
  get remaining(): number {
    return this.length - this.offset;
  }

  private need(count: number): void {
    if (this.offset + count > this.length) {
      throw new RangeError(
        `buffer underflow: need ${count} byte(s) at offset ${this.offset}, ` +
          `only ${this.length - this.offset} available`
      );
    }
  }

  u8(): number {
    this.need(1);
    const value = this.view.getUint8(this.offset);
    this.offset += 1;
    return value;
  }

  i8(): number {
    this.need(1);
    const value = this.view.getInt8(this.offset);
    this.offset += 1;
    return value;
  }

  u16(): number {
    this.need(2);
    const value = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return value;
  }

  i16(): number {
    this.need(2);
    const value = this.view.getInt16(this.offset, true);
    this.offset += 2;
    return value;
  }

  u32(): number {
    this.need(4);
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  f32(): number {
    this.need(4);
    const value = this.view.getFloat32(this.offset, true);
    this.offset += 4;
    return value;
  }

  bytes(count: number): Uint8Array {
    this.need(count);
    const value = new Uint8Array(
      this.view.buffer,
      this.view.byteOffset + this.offset,
      count
    ).slice();
    this.offset += count;
    return value;
  }
}
