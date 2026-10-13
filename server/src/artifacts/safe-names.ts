/**
 * Making a stored artifact's name and media type safe to put in a response
 * header (§7.5). The artifact store (artifacts/artifact-store.ts) signs both
 * into a storage link, and the platform's HTTPS door (api/artifact-http.ts)
 * puts them in its own headers, so they live here, in the core, and the door
 * imports them.
 */

/**
 * A filename safe to put in a `Content-Disposition` header.
 *
 * The name came from whoever stored the file, which for a bridged A2A caller
 * means it came off the wire. A quote in it would close the header's quoted
 * string early, and a CR or LF would end the header line and let the rest be
 * read as headers of its own — so this keeps a conservative set and nothing
 * else, and falls back to the id when nothing usable survives.
 */
export function safeFilename(name: string | undefined, fallbackId: string): string {
  const cleaned = (name ?? "").replace(/[^\w.\- ]+/g, "_").replace(/^[.\s]+/, "").trim().slice(0, 128);
  // A name that survives sanitizing as nothing but punctuation ("////" becomes
  // "_") is not a filename, it is the residue of one. The id is a worse label
  // and a truthful one, which is the better trade for something a person is
  // about to find in their downloads folder.
  return /[A-Za-z0-9]/.test(cleaned) ? cleaned : fallbackId;
}

/** type/subtype, then any `; name=value` parameters, with RFC 7230 token
 *  characters only and a quoted value free of quotes and line breaks. */
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}(\s*;\s*[a-z0-9!#$&^_.+-]+=("[^"\r\n]*"|[a-z0-9!#$&^_.+-]+))*$/i;

/**
 * A media type safe to put in a `Content-Type` header, or
 * `application/octet-stream` when the stored one is not.
 *
 * Same reasoning as the filename above: the type came from whoever stored the
 * file, and it is about to become a response header, here or signed into a
 * storage link. Anything that is not plainly a media type is served as bytes
 * rather than being passed along to be interpreted.
 */
export function safeMediaType(type: string | undefined): string {
  const t = (type ?? "").trim();
  return t.length <= 256 && MEDIA_TYPE.test(t) ? t : "application/octet-stream";
}
