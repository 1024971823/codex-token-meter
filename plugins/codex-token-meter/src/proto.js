// Minimal protobuf wire-format reader (no schema): enough to pull numbered
// fields out of Antigravity's metadata blobs.

function readVarint(buf, pos) {
  let value = 0n;
  let shift = 0n;
  for (let i = 0; i < 10; i++) {
    if (pos.i >= buf.length) throw new Error('truncated varint');
    const byte = buf[pos.i++];
    value |= BigInt(byte & 0x7f) << shift;
    if (!(byte & 0x80)) return value;
    shift += 7n;
  }
  throw new Error('varint overflow');
}

/** Decodes one message level into [{ n, wire, v }] (v: BigInt for varints, Uint8Array for bytes). */
export function decodeFields(buf) {
  const out = [];
  const pos = { i: 0 };
  while (pos.i < buf.length) {
    const tag = readVarint(buf, pos);
    const n = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (n === 0) throw new Error('field number 0');
    if (wire === 0) out.push({ n, wire, v: readVarint(buf, pos) });
    else if (wire === 1) pos.i += 8;
    else if (wire === 5) pos.i += 4;
    else if (wire === 2) {
      const len = Number(readVarint(buf, pos));
      if (pos.i + len > buf.length) throw new Error('truncated bytes');
      out.push({ n, wire, v: buf.subarray(pos.i, pos.i + len) });
      pos.i += len;
    } else throw new Error(`unsupported wire type ${wire}`);
    if (pos.i > buf.length) throw new Error('truncated fixed');
  }
  return out;
}

export const fieldVarint = (fields, n) => {
  for (let i = fields.length - 1; i >= 0; i--) if (fields[i].n === n && fields[i].wire === 0) return Number(fields[i].v);
  return null;
};
export const fieldBytes = (fields, n) => fields.find((f) => f.n === n && f.wire === 2)?.v || null;
export const fieldBytesAll = (fields, n) => fields.filter((f) => f.n === n && f.wire === 2).map((f) => f.v);
export const fieldText = (fields, n) => {
  for (let i = fields.length - 1; i >= 0; i--) {
    const f = fields[i];
    if (f.n === n && f.wire === 2) {
      const s = Buffer.from(f.v).toString('utf8');
      return s.trim() ? s : null;
    }
  }
  return null;
};

/** Encoder used by tests/fixtures: encode([[n, value], ...]) where value is number|string|Uint8Array|array (nested). */
export function encode(fields) {
  const bytes = [];
  const varint = (v) => {
    let x = BigInt(v);
    do {
      let b = Number(x & 0x7fn);
      x >>= 7n;
      if (x) b |= 0x80;
      bytes.push(b);
    } while (x);
  };
  for (const [n, value] of fields) {
    if (typeof value === 'number' || typeof value === 'bigint') {
      varint((n << 3) | 0);
      varint(value);
    } else {
      const data = typeof value === 'string' ? Buffer.from(value) : Array.isArray(value) ? encode(value) : value;
      varint((n << 3) | 2);
      varint(data.length);
      bytes.push(...data);
    }
  }
  return Uint8Array.from(bytes);
}
