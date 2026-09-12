// sessionStorage survives refreshes, but a duplicated tab can inherit its values.
// A document-lifetime Web Lock detects that copy without changing other app storage.
let initialized: Promise<void> | undefined;

export function initializePromotionalTabSession(): Promise<void> {
  if (initialized) return initialized;
  initialized = new Promise<void>((resolve) => {
    try {
      if (!navigator.locks) { resolve(); return; }
      const identityKey = 'promotion:tab-identity';
      const identity = sessionStorage.getItem(identityKey) || crypto.randomUUID();
      sessionStorage.setItem(identityKey, identity);
      const hold = () => new Promise<void>((release) => {
        window.addEventListener('pagehide', () => {
          initialized = undefined;
          release();
        }, { once: true });
        resolve();
      });
      void navigator.locks.request(`promotion-tab:${identity}`, { ifAvailable: true }, async (lock) => {
        if (lock) return hold();
        // Another document owns this identity: this tab copied its storage.
        const newIdentity = crypto.randomUUID();
        sessionStorage.setItem(identityKey, newIdentity);
        for (let index = sessionStorage.length - 1; index >= 0; index--) {
          const key = sessionStorage.key(index);
          if (key?.startsWith('promotion:tab-last-shown:')) sessionStorage.removeItem(key);
        }
        await navigator.locks.request(`promotion-tab:${newIdentity}`, hold);
      }).catch(() => resolve());
    } catch {
      // Storage or locking may be unavailable in private browsing.
      resolve();
    }
  });
  return initialized;
}
