/**
 * Source handler registry.
 *
 * Every platform (YouTube, Vimeo, …) is a self-contained handler module that
 * implements a common interface. The converter never knows about a specific
 * site — it just asks the registry which handler matches a URL. Adding a new
 * platform is therefore a one-file change: create the handler, register it.
 *
 * Handler interface:
 *   id            : string                       unique slug, e.g. 'youtube'
 *   name          : string                       display name, e.g. 'YouTube'
 *   matchPattern  : RegExp                        decides if this handler owns a URL
 *   formats       : { [fmt]: { label, qualities[], defaultQuality } }
 *   validateUrl(url)            -> boolean
 *   fetchMetadata(url)          -> Promise<{ title, thumbnail, duration, … }>
 *   download(url, opts)         -> EventEmitter   ('progress'|'status'|'done'|'error')
 */
export class Registry {
  constructor() {
    this.handlers = [];
  }

  register(handler) {
    this.#validate(handler);
    if (this.handlers.some((h) => h.id === handler.id)) {
      throw new Error(`A handler with id "${handler.id}" is already registered.`);
    }
    this.handlers.push(handler);
    return this;
  }

  /** First handler whose pattern matches the URL, or null. */
  findHandler(url) {
    if (typeof url !== 'string') return null;
    return this.handlers.find((h) => h.matchPattern.test(url.trim())) || null;
  }

  /** Serializable summary of supported sources for the frontend. */
  list() {
    return this.handlers.map((h) => ({
      id: h.id,
      name: h.name,
      formats: h.formats,
      // The pattern source lets the client do an optimistic "is this supported?"
      pattern: h.matchPattern.source,
      flags: h.matchPattern.flags,
    }));
  }

  #validate(h) {
    const required = ['id', 'name', 'matchPattern', 'formats', 'validateUrl', 'fetchMetadata', 'download'];
    for (const key of required) {
      if (!(key in h)) throw new Error(`Handler "${h?.name || h?.id || '?'}" is missing "${key}".`);
    }
    if (!(h.matchPattern instanceof RegExp)) {
      throw new Error(`Handler "${h.name}" matchPattern must be a RegExp.`);
    }
  }
}

export const registry = new Registry();
