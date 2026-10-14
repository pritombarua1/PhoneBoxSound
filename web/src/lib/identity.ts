/**
 * This phone's identity: an ECDSA P-256 key pair created by the browser and marked non-extractable.
 * The private key can sign, but nothing (not this code, not a browser extension, not someone copying
 * the phone's saved site data as text) can read it out. The PC only ever sees the public half and a
 * signature of a fresh random challenge, so there is no reusable secret to steal.
 *
 * Browsers only offer this on secure pages (https, or localhost). On a plain http page there is no
 * identity, and in strict mode the PC then withholds the permissions that control the PC itself.
 */
export interface Identity { pub: { x: string; y: string }; sign: (challenge: string) => Promise<string> }

const DB = "phoneboxsound", STORE = "keys", KEY = "device";

function idb<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction(STORE, mode), req = run(tx.objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => open.result.close();
    };
  });
}

let cached: Promise<Identity | null> | null = null;

async function load(): Promise<Identity | null> {
  if (!window.isSecureContext || !crypto?.subtle || !window.indexedDB) return null;
  try {
    let pair = await idb<CryptoKeyPair | undefined>("readonly", (s) => s.get(KEY));
    if (!pair) {
      pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
      await idb("readwrite", (s) => s.put(pair, KEY));
    }
    const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    const priv = pair.privateKey;
    return {
      pub: { x: jwk.x!, y: jwk.y! },
      async sign(challenge) {
        const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, priv, new TextEncoder().encode(challenge));
        return btoa(String.fromCharCode(...new Uint8Array(sig)));
      },
    };
  } catch {
    return null;   // private mode, storage blocked…: behave like a page without an identity
  }
}

export const identity = () => (cached ??= load());
/** Forget this phone's key (used with "Forget this PC"). */
export async function forgetIdentity() { cached = null; try { await idb("readwrite", (s) => s.delete(KEY)); } catch { /* ignore */ } }
