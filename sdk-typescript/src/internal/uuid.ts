/**
 * UUID v7 generator (RFC 9562).
 * Time-ordered: 48-bit ms timestamp + a 12-bit monotonic sub-millisecond
 * sequence (rand_a) + random tail. The sequence guarantees IDs generated within
 * the same millisecond are strictly increasing, so string/byte comparison sorts
 * them in creation order. No dependencies — uses crypto.getRandomValues.
 */
let _lastMs = 0;
let _seq = 0;

export function uuid7(): string {
  let now = Date.now();
  if (now > _lastMs) {
    _lastMs = now;
    _seq = 0;
  } else {
    // Same (or backwards) clock tick — advance the sub-ms sequence. On the rare
    // 12-bit overflow, borrow a millisecond so ordering never regresses.
    _seq++;
    if (_seq > 0x0fff) {
      _seq = 0;
      _lastMs++;
    }
    now = _lastMs;
  }

  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  // Bytes 0-5: 48-bit ms timestamp (big-endian)
  bytes[0] = (now / 2 ** 40) & 0xff;
  bytes[1] = (now / 2 ** 32) & 0xff;
  bytes[2] = (now / 2 ** 24) & 0xff;
  bytes[3] = (now / 2 ** 16) & 0xff;
  bytes[4] = (now / 2 ** 8) & 0xff;
  bytes[5] = now & 0xff;

  // Bytes 6-7: version (0111) + 12-bit monotonic sequence in rand_a
  bytes[6] = 0x70 | ((_seq >> 8) & 0x0f);
  bytes[7] = _seq & 0xff;

  // Byte 8: variant (10) + random tail (bytes 8-15 stay random)
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}
