import {
    createCipheriv,
    createDecipheriv,
    createHmac,
    randomBytes,
    scryptSync
} from 'crypto';

const API_KEY_ENCRYPTION_SECRET = process.env.ENCRYPTION_SECRET;
const ENCRYPTION_SALT = process.env.ENCRYPTION_SALT;
const LOOKUP_SALT = process.env.LOOKUP_SALT;
const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const ENCRYPTION_VERSION = 'v1';
const IV_LENGTH = 12;

let cachedKeys = null;
let cachedSecret = null;

/**
 * Creates the persistence representation for an API key.
 * @param {string} apiKey
 * @returns {{ api_key_ciphertext: string, api_key_lookup_hash: string }}
 */
export function createApiKeyRecord(apiKey) {
    return {
        api_key_ciphertext: encryptApiKey(apiKey),
        api_key_lookup_hash: computeApiKeyLookupHash(apiKey)
    };
}

/**
 * Computes the indexed lookup hash for a bearer API key.
 * @param {string} apiKey
 * @returns {string}
 */
export function computeApiKeyLookupHash(apiKey) {
    const { lookupKey } = getDerivedKeys();

    return createHmac('sha256', lookupKey)
        .update(apiKey, 'utf8')
        .digest('hex');
}

/**
 * Encrypts an API key for at-rest storage using authenticated encryption.
 * @param {string} apiKey
 * @returns {string}
 */
export function encryptApiKey(apiKey) {
    const { encryptionKey } = getDerivedKeys();
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ENCRYPTION_ALGORITHM, encryptionKey, iv);
    const encrypted = Buffer.concat([
        cipher.update(apiKey, 'utf8'),
        cipher.final()
    ]);
    const authTag = cipher.getAuthTag();

    return [
        ENCRYPTION_VERSION,
        iv.toString('base64url'),
        authTag.toString('base64url'),
        encrypted.toString('base64url')
    ].join(':');
}

/**
 * Decrypts a stored API key value.
 * @param {string} encryptedApiKey
 * @returns {string}
 */
export function decryptApiKey(encryptedApiKey) {
    const { encryptionKey } = getDerivedKeys();
    const [version, iv, authTag, ciphertext] = String(encryptedApiKey).split(':');

    if (version !== ENCRYPTION_VERSION || !iv || !authTag || !ciphertext) {
        throw new Error('Invalid encrypted API key payload.');
    }

    const decipher = createDecipheriv(
        ENCRYPTION_ALGORITHM,
        encryptionKey,
        Buffer.from(iv, 'base64url')
    );

    decipher.setAuthTag(Buffer.from(authTag, 'base64url'));

    const decrypted = Buffer.concat([
        decipher.update(Buffer.from(ciphertext, 'base64url')),
        decipher.final()
    ]);

    return decrypted.toString('utf8');
}

/**
 * Derives and caches separate keys for encryption and lookup operations.
 * @returns {{ encryptionKey: Buffer, lookupKey: Buffer }}
 */
function getDerivedKeys() {
    const secret = API_KEY_ENCRYPTION_SECRET;
    if (!secret) {
        throw new Error(`API_KEY_ENCRYPTION_SECRET must be set to protect stored API keys.`);
    }

    if (cachedKeys && cachedSecret === secret) {
        return cachedKeys;
    }

    cachedSecret = secret;
    cachedKeys = {
        encryptionKey: scryptSync(secret, ENCRYPTION_SALT, 32),
        lookupKey: scryptSync(secret, LOOKUP_SALT, 32)
    };

    return cachedKeys;
}