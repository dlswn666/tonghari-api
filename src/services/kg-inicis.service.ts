import crypto from 'crypto';
import axios from 'axios';
import { env } from '../config/env';
import { AppError } from '../middleware/errorHandler';
import type {
    IdentityVerificationContext, KgInicisAuthRequest, KgInicisAuthRequestResult,
    KgInicisCallbackParams, KgInicisTxStatus, KgInicisVerifiedResult,
} from '../types/kg-inicis.types';

const TX_TTL_MS = 5 * 60 * 1000;
const MAX_TRANSACTIONS = 1000;
const MAX_ACTOR_TRANSACTIONS = 5;
const RESULT_HOSTS = new Set(['fcsa.inicis.com', 'kssa.inicis.com']);
/** 공식 reqSvcCd=03 지원 기관. 계약으로 허용한 기관도 별도로 일치해야 한다. */
const ID_PROVIDERS = new Set(['TOSS', 'KFTC', 'SHINHAN', 'KB', 'HANA', 'WOORI', 'KAKAOBANK', 'IBK', 'SMS']);

export interface KgInicisConfig {
    enabled: boolean;
    databaseTarget: string;
    mid: string;
    apiKey: string;
    seedIv: string;
    callbackBaseUrl: string;
    idProviders: string[];
}

interface ServiceDependencies {
    now?: () => number;
    transport?: (url: string, body: { mid: string; txId: string }) => Promise<unknown>;
    cipher?: {
        available: () => boolean;
        decrypt: (ciphertext: unknown, token: string, iv: string) => string;
    };
}

interface KgInicisTx {
    mTxId: string;
    owner: IdentityVerificationContext;
    status: KgInicisTxStatus;
    issuedAt: number;
    expiresAt: number;
    expectedSubjectDigest: string;
    requestPayloadDigest: string;
    callbackDigest?: string;
    stateHash: Buffer;
    expectedNameHash?: Buffer;
    expectedPhoneHash?: Buffer;
    expectedBirthdayHash?: Buffer;
    authRequestUrl?: string;
    txId?: string;
    token?: string;
}

function failure(code = 'IDENTITY_VERIFICATION_FAILED', status = 400): AppError {
    const message = code === 'IDENTITY_VERIFICATION_UNAVAILABLE'
        ? '본인확인 서비스 연결이 준비되지 않았습니다.'
        : '본인확인 요청을 처리할 수 없습니다. 인증을 다시 시작해 주세요.';
    return new AppError(message, status, code);
}

function strictBase64(value: unknown, maxBytes = 4096): Buffer {
    if (typeof value !== 'string' || value.length === 0 || value.length > maxBytes * 2 ||
        value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw failure();
    const decoded = Buffer.from(value, 'base64');
    if (decoded.length > maxBytes || decoded.toString('base64') !== value) throw failure();
    return decoded;
}

/** KG token은 Base64로 전달된 16바이트 키이며 IV는 별도 발급된 UTF-8 16바이트다. */
export function decryptKgSeed(ciphertext: unknown, token: string, iv: string): string {
    const key = strictBase64(token, 16);
    const ivBytes = Buffer.from(iv, 'utf8');
    let plaintext: Buffer | undefined;
    try {
        const encrypted = strictBase64(ciphertext);
        if (key.length !== 16 || ivBytes.length !== 16 || encrypted.length % 16 !== 0) throw failure();
        const decipher = crypto.createDecipheriv('seed-cbc', key, ivBytes);
        plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]);
        // 잘못된 UTF-8을 대체 문자로 바꾸어 동일 신원으로 인정하지 않는다.
        return new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
    } catch {
        throw failure();
    } finally {
        key.fill(0);
        ivBytes.fill(0);
        plaintext?.fill(0);
    }
}

export function validateKgResultUrl(value: unknown): string {
    try {
        if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 200 || /[\s\\]/.test(value)) throw failure();
        const url = new URL(value);
        if (url.protocol !== 'https:' || !RESULT_HOSTS.has(url.hostname) ||
            (url.port && url.port !== '443') || url.username || url.password || url.hash) throw failure();
        return url.toString();
    } catch { throw failure('IDENTITY_VERIFICATION_CALLBACK_INVALID'); }
}

function normalizeName(value: unknown): string {
    if (typeof value !== 'string') throw failure('INVALID_PARAMS');
    const name = value.normalize('NFC').trim();
    if (!name || Buffer.byteLength(name) > 25 || /[\u0000-\u001f\u007f]/.test(name)) throw failure('INVALID_PARAMS');
    return name;
}

function normalizePhone(value: unknown): string {
    if (typeof value !== 'string') throw failure('INVALID_PARAMS');
    const phone = value.replace(/[ -]/g, '');
    if (!/^01\d{8,9}$/.test(phone)) throw failure('INVALID_PARAMS');
    return phone;
}

function validBirthday(value: unknown, now: number): value is string {
    if (typeof value !== 'string' || !/^\d{8}$/.test(value)) return false;
    const date = new Date(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T00:00:00Z`);
    return Number.isFinite(date.valueOf()) && date.valueOf() <= now &&
        date.toISOString().slice(0, 10).replace(/-/g, '') === value;
}

function sameOwner(left: IdentityVerificationContext, right: IdentityVerificationContext): boolean {
    return left.userId === right.userId && left.unionId === right.unionId &&
        left.databaseTarget === right.databaseTarget && left.assemblyId === right.assemblyId && left.purpose === right.purpose;
}

/** 결과 응답과 axios 오류를 로그/상위 오류로 전달하지 않는 단일 외부 연결점. */
async function resultTransport(url: string, body: { mid: string; txId: string }): Promise<unknown> {
    const response = await axios.post(url, body, {
        timeout: 5000,
        maxRedirects: 0,
        maxContentLength: 16 * 1024,
        maxBodyLength: 1024,
        headers: { 'Content-Type': 'application/json;charset=utf-8' },
        responseType: 'json',
        validateStatus: (status) => status === 200,
    });
    return response.data;
}

/** 계정 값만 채워서는 활성화되지 않는 본인확인 어댑터. */
export class KgInicisService {
    private readonly transactions = new Map<string, KgInicisTx>();
    private readonly comparisonKey = crypto.randomBytes(32);
    private readonly config: KgInicisConfig;
    private readonly now: () => number;
    private readonly transport: NonNullable<ServiceDependencies['transport']>;
    private readonly cipher: NonNullable<ServiceDependencies['cipher']>;
    private readonly cleanupTimer: NodeJS.Timeout;

    constructor(config: KgInicisConfig, dependencies: ServiceDependencies = {}) {
        this.config = { ...config, idProviders: [...config.idProviders] };
        this.now = dependencies.now ?? Date.now;
        this.transport = dependencies.transport ?? resultTransport;
        this.cipher = dependencies.cipher ?? {
            available: () => crypto.getCiphers().includes('seed-cbc'),
            decrypt: decryptKgSeed,
        };
        this.cleanupTimer = setInterval(() => this.cleanupExpired(), 60_000);
        this.cleanupTimer.unref();
    }

    /** 외부 연결·계정 값·개인정보 없이 비활성 여부만 제공한다. */
    getReadiness(target: string): { enabled: boolean; available: boolean; code: string } {
        const c = this.config;
        let available = false;
        try {
            available = c.enabled === true && ['production', 'development'].includes(c.databaseTarget) &&
                c.databaseTarget === target && /^[A-Za-z0-9_-]{10}$/.test(c.mid) && c.apiKey.length > 0 &&
                Buffer.byteLength(c.seedIv, 'utf8') === 16 && c.idProviders.length > 0 &&
                new Set(c.idProviders).size === c.idProviders.length && c.idProviders.every((p) => ID_PROVIDERS.has(p)) &&
                this.cipher.available();
            this.callbackUrl('success', '0'.repeat(20), '0'.repeat(22));
        } catch { available = false; }
        return { enabled: c.enabled === true, available, code: available ? 'READY' : 'IDENTITY_VERIFICATION_UNAVAILABLE' };
    }

    private assertAvailable(target: string): void {
        if (!this.getReadiness(target).available) throw failure('IDENTITY_VERIFICATION_UNAVAILABLE', 503);
    }

    requestAuth(request: KgInicisAuthRequest, owner: IdentityVerificationContext): KgInicisAuthRequestResult {
        this.assertAvailable(owner.databaseTarget);
        if (request?.reqSvcCd !== '03' || !request.expectedIdentity ||
            !owner.userId || !owner.unionId || !owner.assemblyId || !['ENTRY', 'VOTE'].includes(owner.purpose)) throw failure('INVALID_PARAMS');
        const name = normalizeName(request.expectedIdentity.name);
        const phone = normalizePhone(request.expectedIdentity.phone);
        const birthday = request.expectedIdentity.birthday;
        if (birthday !== undefined && !validBirthday(birthday, this.now())) throw failure('INVALID_PARAMS');
        this.cleanupExpired();
        const actorCount = [...this.transactions.values()].filter((t) => t.owner.databaseTarget === owner.databaseTarget &&
            t.owner.userId === owner.userId && t.status !== 'FAILED').length;
        if (this.transactions.size >= MAX_TRANSACTIONS || actorCount >= MAX_ACTOR_TRANSACTIONS) {
            throw failure('IDENTITY_VERIFICATION_RATE_LIMITED', 429);
        }
        const mTxId = crypto.randomBytes(10).toString('hex');
        const state = crypto.randomBytes(16).toString('base64url');
        const issuedAt = this.now();
        const expiresAt = issuedAt + TX_TTL_MS;
        const formParams: Record<string, string> = {
            mid: this.config.mid, reqSvcCd: '03', mTxId,
            successUrl: this.callbackUrl('success', mTxId, state),
            failUrl: this.callbackUrl('fail', mTxId, state),
            authHash: crypto.createHash('sha256').update(this.config.mid + mTxId + this.config.apiKey).digest('hex'),
            reservedMsg: 'isUseToken=Y', flgFixedUser: birthday ? 'Y' : 'N',
        };
        // 복수 기관 directAgency 구분자는 공식 문서에 명시되지 않아 결과 검증에서 계약 목록을 강제한다.
        if (this.config.idProviders.length === 1) formParams.directAgency = this.config.idProviders[0];
        if (birthday) Object.assign(formParams, {
            userName: name, userPhone: phone, userBirth: birthday,
            userHash: crypto.createHash('sha256').update(name + this.config.mid + phone + mTxId + birthday + '03').digest('hex'),
        });
        this.transactions.set(mTxId, {
            mTxId, owner: { ...owner }, status: 'REQUESTED', issuedAt, expiresAt,
            expectedSubjectDigest: this.subjectDigest(name, phone, birthday),
            requestPayloadDigest: this.hash(JSON.stringify(formParams)).toString('hex'),
            stateHash: this.hash(state), expectedNameHash: this.hash(name), expectedPhoneHash: this.hash(phone),
            expectedBirthdayHash: birthday ? this.hash(birthday) : undefined,
        });
        return { mTxId, authUrl: 'https://sa.inicis.com/id/auth', formParams, expiresAt: new Date(expiresAt).toISOString() };
    }

    handleCallback(mTxId: string, state: string, outcome: 'success' | 'fail', params: KgInicisCallbackParams): void {
        this.assertAvailable(this.config.databaseTarget);
        const tx = this.getTransaction(mTxId);
        if (typeof state !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(state) || !crypto.timingSafeEqual(this.hash(state), tx.stateHash)) {
            throw failure('IDENTITY_VERIFICATION_CALLBACK_INVALID');
        }
        this.assertUnexpired(tx);
        if (tx.status !== 'REQUESTED') throw failure('IDENTITY_VERIFICATION_REPLAY', 409);
        if (outcome === 'fail') { this.failTransaction(tx); return; }
        try {
            if (params.resultCode !== '0000' || typeof params.txId !== 'string' ||
                !/^[A-Za-z0-9_-]{1,40}$/.test(params.txId) || typeof params.token !== 'string') throw failure();
            const key = strictBase64(params.token, 16);
            const validKey = key.length === 16;
            key.fill(0);
            if (!validKey) throw failure();
            tx.authRequestUrl = validateKgResultUrl(params.authRequestUrl);
            tx.txId = params.txId;
            tx.token = params.token;
            tx.callbackDigest = this.hash(JSON.stringify({ resultCode: params.resultCode,
                authRequestUrl: tx.authRequestUrl, txId: tx.txId, token: tx.token })).toString('hex');
            tx.status = 'CALLBACK_RECEIVED';
        } catch {
            this.failTransaction(tx);
            throw failure('IDENTITY_VERIFICATION_CALLBACK_INVALID');
        }
    }

    async queryResult(
        mTxId: string,
        owner: IdentityVerificationContext,
        currentIdentity: KgInicisAuthRequest['expectedIdentity']
    ): Promise<KgInicisVerifiedResult> {
        this.assertAvailable(owner.databaseTarget);
        const tx = this.getOwnedTransaction(mTxId, owner);
        this.assertUnexpired(tx);
        if (tx.status !== 'CALLBACK_RECEIVED') {
            throw failure(tx.status === 'FAILED' ? 'IDENTITY_VERIFICATION_FAILED' : 'IDENTITY_VERIFICATION_NOT_READY', 409);
        }
        // 인증창이 열린 사이 바뀐 조합원 프로필로 이전 거래를 소비하지 못하게 한다.
        // 비교 기준은 결과 요청 시에도 Web 서버가 원본 자료에서 다시 읽어 확정한다.
        try {
            const name = normalizeName(currentIdentity?.name);
            const phone = normalizePhone(currentIdentity?.phone);
            const birthday = currentIdentity?.birthday;
            if ((birthday !== undefined && !validBirthday(birthday, this.now())) ||
                this.subjectDigest(name, phone, birthday) !== tx.expectedSubjectDigest ||
                !this.matchesHash(name, tx.expectedNameHash) || !this.matchesHash(phone, tx.expectedPhoneHash) ||
                (birthday !== undefined) !== !!tx.expectedBirthdayHash ||
                (birthday !== undefined && !this.matchesHash(birthday, tx.expectedBirthdayHash))) throw failure();
        } catch {
            this.failTransaction(tx);
            throw failure('IDENTITY_VERIFICATION_SUBJECT_CHANGED', 409);
        }
        // 첫 await 전에 상태를 바꾸어 두 개의 요청이 같은 결과를 소비하지 못하게 한다.
        tx.status = 'VERIFYING';
        try {
            const raw = await this.transport(validateKgResultUrl(tx.authRequestUrl), { mid: this.config.mid, txId: tx.txId! });
            this.assertUnexpired(tx);
            if (this.transactions.get(mTxId) !== tx) throw failure('IDENTITY_VERIFICATION_EXPIRED', 410);
            if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw failure();
            const result = raw as Record<string, unknown>;
            if (result.resultCode !== '0000' || result.mTxId !== mTxId || result.txId !== tx.txId ||
                result.svcCd !== '03' || typeof result.providerDevCd !== 'string' ||
                !ID_PROVIDERS.has(result.providerDevCd) || !this.config.idProviders.includes(result.providerDevCd)) throw failure();
            const decrypt = (value: unknown) => this.cipher.decrypt(value, tx.token!, this.config.seedIv);
            const name = normalizeName(decrypt(result.userName));
            const phone = normalizePhone(decrypt(result.userPhone));
            const birthday = decrypt(result.userBirthday);
            if (!validBirthday(birthday, this.now()) || !this.matchesHash(name, tx.expectedNameHash) ||
                !this.matchesHash(phone, tx.expectedPhoneHash) ||
                (tx.expectedBirthdayHash && !this.matchesHash(birthday, tx.expectedBirthdayHash))) throw failure();
            // 본인확인 결과의 CI 형식만 검증하고 조합원 키나 증빙으로 저장하지 않는다.
            const ci = strictBase64(decrypt(result.userCi), 64);
            const validCi = ci.length === 64;
            ci.fill(0);
            if (!validCi) throw failure();
            this.assertUnexpired(tx);
            const verified: KgInicisVerifiedResult = {
                verified: true, mTxId, txId: tx.txId!, svcCd: '03', providerDevCd: result.providerDevCd,
                verifiedAt: new Date(this.now()).toISOString(), assemblyId: tx.owner.assemblyId, purpose: tx.owner.purpose,
                issuedAt: new Date(tx.issuedAt).toISOString(), expiresAt: new Date(tx.expiresAt).toISOString(),
                expectedSubjectDigest: tx.expectedSubjectDigest,
                verifiedSubjectDigest: this.subjectDigest(name, phone, tx.expectedBirthdayHash ? birthday : undefined),
                requestPayloadDigest: tx.requestPayloadDigest,
                providerEvidenceDigest: this.hash(JSON.stringify({ resultCode: result.resultCode, mTxId,
                    txId: result.txId, svcCd: result.svcCd, providerDevCd: result.providerDevCd,
                    userName: result.userName, userPhone: result.userPhone, userBirthday: result.userBirthday,
                    userCi: result.userCi })).toString('hex'),
                callbackDigest: tx.callbackDigest!,
            };
            this.scrub(tx);
            this.transactions.delete(mTxId);
            return verified;
        } catch (error) {
            this.failTransaction(tx);
            if (error instanceof AppError && error.code === 'IDENTITY_VERIFICATION_EXPIRED') throw error;
            // axios 오류는 요청/응답/토큰을 포함할 수 있으므로 원인 객체를 외부로 전달하지 않는다.
            throw failure();
        }
    }

    getTxStatus(mTxId: string, owner: IdentityVerificationContext): KgInicisTxStatus {
        this.assertAvailable(owner.databaseTarget);
        const tx = this.getOwnedTransaction(mTxId, owner);
        if (this.now() >= tx.expiresAt) { tx.status = 'EXPIRED'; this.scrub(tx); }
        return tx.status;
    }

    private callbackUrl(outcome: 'success' | 'fail', mTxId: string, state: string): string {
        const base = new URL(this.config.callbackBaseUrl);
        if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash ||
            (base.port && base.port !== '443') || base.pathname !== '/api/identity-verification/callback') throw failure();
        const url = `${base.toString()}/${outcome}?t=${mTxId}&s=${state}`;
        if (Buffer.byteLength(url, 'utf8') > 128) throw failure();
        return url;
    }

    private hash(value: string): Buffer {
        return crypto.createHmac('sha256', this.comparisonKey).update(value, 'utf8').digest();
    }
    private subjectDigest(name: string, phone: string, birthday?: string): string {
        return this.hash(JSON.stringify({ name, phone, birthday })).toString('hex');
    }
    private matchesHash(value: string, expected?: Buffer): boolean {
        return !!expected && crypto.timingSafeEqual(this.hash(value), expected);
    }
    private getTransaction(mTxId: string): KgInicisTx {
        const tx = typeof mTxId === 'string' && /^[a-f0-9]{20}$/.test(mTxId) ? this.transactions.get(mTxId) : undefined;
        if (!tx) throw failure('IDENTITY_VERIFICATION_NOT_FOUND', 404);
        return tx;
    }
    private getOwnedTransaction(mTxId: string, owner: IdentityVerificationContext): KgInicisTx {
        const tx = this.getTransaction(mTxId);
        if (!sameOwner(tx.owner, owner)) throw failure('IDENTITY_VERIFICATION_NOT_FOUND', 404);
        return tx;
    }
    private assertUnexpired(tx: KgInicisTx): void {
        if (this.now() >= tx.expiresAt) {
            tx.status = 'EXPIRED'; this.scrub(tx);
            throw failure('IDENTITY_VERIFICATION_EXPIRED', 410);
        }
    }
    private scrub(tx: KgInicisTx): void {
        tx.expectedNameHash?.fill(0); tx.expectedPhoneHash?.fill(0); tx.expectedBirthdayHash?.fill(0);
        tx.expectedNameHash = undefined; tx.expectedPhoneHash = undefined; tx.expectedBirthdayHash = undefined;
        tx.token = undefined; tx.authRequestUrl = undefined;
    }
    private failTransaction(tx: KgInicisTx): void {
        if (tx.status !== 'EXPIRED') tx.status = 'FAILED';
        this.scrub(tx);
    }
    private cleanupExpired(): void {
        for (const [key, tx] of this.transactions) {
            if (this.now() >= tx.expiresAt) { this.scrub(tx); this.transactions.delete(key); }
        }
    }
    destroy(): void {
        clearInterval(this.cleanupTimer);
        for (const tx of this.transactions.values()) this.scrub(tx);
        this.transactions.clear();
        this.comparisonKey.fill(0);
    }
}

export const kgInicisService = new KgInicisService({
    enabled: env.KG_INICIS_ENABLED,
    databaseTarget: env.KG_INICIS_DATABASE_TARGET,
    mid: env.KG_INICIS_MID,
    apiKey: env.KG_INICIS_API_KEY,
    seedIv: env.KG_INICIS_SEED_IV,
    callbackBaseUrl: env.KG_INICIS_CALLBACK_BASE_URL,
    idProviders: env.KG_INICIS_ID_PROVIDERS.split(',').map((p) => p.trim()).filter(Boolean),
});
export default kgInicisService;
