// Just enough protobuf decoding to read the blobs inside newer Anki collections.
// Returns a map of field number -> array of raw values (numbers or Uint8Array).
export function decodeProto(bytes) {
  const out = {};
  let pos = 0;
  const readVarint = () => {
    let result = 0;
    let shift = 0;
    while (pos < bytes.length) {
      const b = bytes[pos++];
      result += (b & 0x7f) * 2 ** shift;
      if (!(b & 0x80)) break;
      shift += 7;
    }
    return result;
  };
  while (pos < bytes.length) {
    const key = readVarint();
    const field = Math.floor(key / 8);
    const wire = key & 7;
    let value;
    if (wire === 0) value = readVarint();
    else if (wire === 2) {
      const len = readVarint();
      value = bytes.subarray(pos, pos + len);
      pos += len;
    } else if (wire === 1) {
      value = bytes.subarray(pos, pos + 8);
      pos += 8;
    } else if (wire === 5) {
      value = bytes.subarray(pos, pos + 4);
      pos += 4;
    } else break; // groups are not used by Anki
    (out[field] ||= []).push(value);
  }
  return out;
}

const utf8 = new TextDecoder();

export function protoString(msg, field) {
  const v = msg[field]?.[0];
  return v instanceof Uint8Array ? utf8.decode(v) : '';
}

export function protoInt(msg, field) {
  const v = msg[field]?.[0];
  return typeof v === 'number' ? v : 0;
}
