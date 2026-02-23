/**

- StoragePolyfill.gs
- 
- A polyfill for the Web Storage API (sessionStorage / localStorage)
- backed by Google Apps Script CacheService (script scope).
- 
- Designed to be deployed as a library. The consuming project is responsible
- for any top-level entry points it needs, e.g.:
- 
- function refreshLocalStorageCache() {
- ```
  StoragePolyfill.refreshLocalStorageCache();
  ```
- }
- 
- USAGE
- -----
- const { sessionStorage, localStorage } = StoragePolyfill;
- 
- sessionStorage.setItem(‘key’, ‘value’);
- sessionStorage.getItem(‘key’);   // ‘value’
- sessionStorage.length;           // 1
- sessionStorage.key(0);           // ‘key’
- sessionStorage.removeItem(‘key’);
- sessionStorage.clear();
- 
- localStorage refresh strategies:
- 
- Automatic — every call to localStorage.getItem() checks whether a
- refresh is due (at most once per hour) and re-puts all entries if so.
- As long as localStorage is being read, it stays alive indefinitely.
- 
- Belt-and-suspenders — call installLocalStorageTrigger() once from a
- setup function to also register a 5-hour time-based trigger, covering
- periods where no reads occur.
- 
- CONSTRAINTS
- -----
- - Values are coerced to strings (mirrors Web Storage spec).
- - Max value size: 100KB per entry (CacheService hard limit).
- - Script cache is shared across all users (1,000-entry cap total).
- - Cache is not truly atomic; index reads outside locks are optimistic
- fast-paths — the write always re-reads inside the lock.
- - If cache entries expire with no reads or trigger firing to refresh
- them, data is lost. This is an accepted tradeoff to avoid PropertiesService.
  */

const StoragePolyfill = (() => {

// ─── Constants ─────────────────────────────────────────────────────────────

const SESSION_PREFIX   = 'ss__';
const LOCAL_PREFIX     = 'ls__';
const TTL              = 21600;   // 6 hours (CacheService max)
const DEBOUNCE_WINDOW  = 3600;    // 1 hour in seconds
const TRIGGER_ID_KEY   = 'ls__trigger_id__';
const LAST_REFRESH_KEY = 'ls__last_refresh__';
const REFRESH_FN       = 'refreshLocalStorageCache';

// ─── Memoized cache handle ─────────────────────────────────────────────────

let _cache = null;
const getCache = () => {
if (!_cache) _cache = CacheService.getScriptCache();
return _cache;
};

// ─── Shared refresh logic ──────────────────────────────────────────────────

/**

- Re-puts all localStorage entries with a fresh TTL.
- Includes the trigger ID and last-refresh timestamp in the batch.
- 
- @param {boolean} [debounce=false] - If true, skips the refresh if one
- occurred within the last DEBOUNCE_WINDOW seconds.
- @returns {boolean} true if a refresh ran, false if debounced or nothing stored.
  */
  const _refresh = (debounce = false) => {
  const cache    = getCache();
  const indexKey = `${LOCAL_PREFIX}__index__`;


if (debounce) {
  const lastRefresh = cache.get(LAST_REFRESH_KEY);
  if (lastRefresh) {
    const elapsed = (Date.now() / 1000) - Number(lastRefresh);
    if (elapsed < DEBOUNCE_WINDOW) return false;
  }
}

const raw = cache.get(indexKey);
if (!raw) return false;

const index        = JSON.parse(raw);
const prefixedKeys = index.map(k => `${LOCAL_PREFIX}${k}`);
const values       = cache.getAll(prefixedKeys);

const batch = { [indexKey]: raw };
prefixedKeys.forEach(pk => { if (values[pk] != null) batch[pk] = values[pk]; });

const triggerId = cache.get(TRIGGER_ID_KEY);
if (triggerId) batch[TRIGGER_ID_KEY] = triggerId;
batch[LAST_REFRESH_KEY] = String(Math.floor(Date.now() / 1000));

cache.putAll(batch, TTL);
return true;


};

// ─── Core factory ──────────────────────────────────────────────────────────

/**

- @param {string}    keyPrefix  - Namespace prefix for all cache keys.
- @param {number}    [ttl]      - TTL in seconds (default 21600).
- @param {function}  [onGet]    - Optional callback invoked after getItem.
- Receives the key and resolved value. Used to trigger debounced refresh
- on localStorage reads without blocking the return value.
  */
  const createStorage = (keyPrefix, ttl = TTL, onGet = null) => {
  const INDEX_KEY = `${keyPrefix}__index__`;
  const prefixed  = key => `${keyPrefix}${key}`;


const getIndex = () => {
  const raw = getCache().get(INDEX_KEY);
  return raw ? JSON.parse(raw) : [];
};

const saveIndex = keys => safePut(INDEX_KEY, JSON.stringify(keys), ttl);

const withLock = fn => {
  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
};

const safePut = (cacheKey, value, expiresIn) => {
  try {
    getCache().put(cacheKey, value, expiresIn);
  } catch (e) {
    throw new Error(
      `StoragePolyfill: Failed to cache key "${cacheKey}". ` +
      `Value may exceed the 100KB CacheService limit. ` +
      `Original error: ${e.message}`
    );
  }
};

return {

  get length() {
    return getIndex().length;
  },

  key(n) {
    const index = getIndex();
    return (n >= 0 && n < index.length) ? index[n] : null;
  },

  getItem(key) {
    const value = getCache().get(prefixed(key));
    const result = value !== null ? value : null;
    onGet?.(key, result);
    return result;
  },

  setItem(key, value) {
    safePut(prefixed(key), String(value), ttl);

    if (!getIndex().includes(key)) {
      withLock(() => {
        const freshIndex = getIndex();
        if (!freshIndex.includes(key)) {
          freshIndex.push(key);
          saveIndex(freshIndex);
        }
      });
    }
  },

  removeItem(key) {
    if (!getIndex().includes(key)) return;
    getCache().remove(prefixed(key));
    withLock(() => saveIndex(getIndex().filter(k => k !== key)));
  },

  clear() {
    withLock(() => {
      const index = getIndex();
      if (index.length > 0) getCache().removeAll(index.map(prefixed));
      getCache().remove(INDEX_KEY);
    });
  },

  entries() {
    const index = getIndex();
    if (index.length === 0) return [];
    const prefixedKeys = index.map(prefixed);
    const values = getCache().getAll(prefixedKeys);
    return index.map(k => [k, values[prefixed(k)] ?? null]);
  },

  _indexKey: INDEX_KEY,
  _prefix: keyPrefix,
  _ttl: ttl,
};


};

// ─── Trigger lifecycle ─────────────────────────────────────────────────────

const installLocalStorageTrigger = () => {
const cache    = getCache();
const storedId = cache.get(TRIGGER_ID_KEY);


if (storedId) {
  const stillExists = ScriptApp.getProjectTriggers()
    .some(t => t.getUniqueId() === storedId);

  if (stillExists) {
    Logger.log(`StoragePolyfill: localStorage trigger already installed (${storedId})`);
    return null;
  }
}

const trigger = ScriptApp
  .newTrigger(REFRESH_FN)
  .timeBased()
  .everyHours(5)
  .create();

const id = trigger.getUniqueId();
cache.put(TRIGGER_ID_KEY, id, TTL);
Logger.log(`StoragePolyfill: localStorage trigger installed (${id})`);
return id;


};

const uninstallLocalStorageTrigger = () => {
const cache    = getCache();
const storedId = cache.get(TRIGGER_ID_KEY);
if (!storedId) return;


ScriptApp.getProjectTriggers()
  .filter(t => t.getUniqueId() === storedId)
  .forEach(t => ScriptApp.deleteTrigger(t));

cache.remove(TRIGGER_ID_KEY);
Logger.log('StoragePolyfill: localStorage trigger removed.');


};

// Register the trigger target at the top level so Apps Script can resolve
// it by name when used as a library, without requiring the consuming project
// to define a wrapper.
globalThis[REFRESH_FN] = () => _refresh(false);

// ─── Public API ────────────────────────────────────────────────────────────

return {
sessionStorage: createStorage(SESSION_PREFIX),


// localStorage passes a debounced refresh as the onGet callback so that
// any read will opportunistically keep the cache alive.
localStorage: createStorage(LOCAL_PREFIX, TTL, () => _refresh(true)),

installLocalStorageTrigger,
uninstallLocalStorageTrigger,
refreshLocalStorageCache: () => _refresh(false),


};

})();
