import crypto from 'crypto';
import axios, { AxiosInstance } from 'axios';
import { env } from '../config/env';
import { createLogger } from '../utils/logger';
import {
    KgInicisAuthRequest,
    KgInicisAuthRequestResult,
    KgInicisCallbackParams,
    KgInicisEsignResult,
    KgInicisIdResult,
    KgInicisResultBase,
    KgInicisTxStatus,
    ReqSvcCd,
} from '../types/kg-inicis.types';

const logger = createLogger('KG_INICIS');

/** 간편인증/전자서명 인증 URL */
const AUTH_URL_DEFAULT = 'https://sa.inicis.com/auth';
/** 본인확인 인증 URL */
const AUTH_URL_ID = 'https://sa.inicis.com/id/auth';

/** 거래 TTL (5분) */
const TX_TTL_MS = 5 * 60 * 1000;
/** 정리 주기 (1분) */
const CLEANUP_INTERVAL_MS = 60 * 1000;

/** reqSvcCd별 인증 URL 매핑 */
const AUTH_URLS: Record<ReqSvcCd, string> = {
    '01': AUTH_URL_DEFAULT,
    '02': AUTH_URL_DEFAULT,
    '03': AUTH_URL_ID,
};

/** 내부 거래 레코드 */
interface KgInicisTx {
    mTxId: string;
    mid: string;
    reqSvcCd: ReqSvcCd;
    identifier?: string;
    status: KgInicisTxStatus;
    createdAt: number;
    /** STEP2 콜백 수신 후 채워짐 */
    authRequestUrl?: string;
    txId?: string;
    token?: string;
}

/**
 * KG이니시스 통합인증 서비스
 * 간편인증('01'), 전자서명('02'), 본인확인('03') 3종 서비스를 처리한다.
 */
class KgInicisService {
    private httpClient: AxiosInstance;
    /** 진행 중인 거래 저장소 (mTxId → KgInicisTx) */
    private transactions: Map<string, KgInicisTx> = new Map();
    private cleanupTimer: NodeJS.Timeout | null = null;

    constructor() {
        this.httpClient = axios.create({
            timeout: 10000,
            headers: {
                'Content-Type': 'application/json',
            },
        });

        // 만료된 거래 주기적 정리 (.unref()로 graceful shutdown 방해 방지)
        this.cleanupTimer = setInterval(() => this.cleanupExpired(), CLEANUP_INTERVAL_MS);
        if (this.cleanupTimer.unref) {
            this.cleanupTimer.unref();
        }
    }

    // ─── STEP1: 인증 요청 ──────────────────────────────────────────────────────

    /**
     * STEP1: 인증 요청
     * 가맹점 거래 ID와 인증 폼 파라미터를 생성하여 반환한다.
     */
    requestAuth(request: KgInicisAuthRequest): KgInicisAuthRequestResult {
        const { mid, apiKey } = this.getCredentials();

        const mTxId = this.generateMTxId();
        const authHash = this.generateAuthHash(mid, mTxId, apiKey);

        // 전자서명('02')은 식별자 필수
        if (request.reqSvcCd === '02' && !request.identifier) {
            throw new Error('전자서명 서비스(reqSvcCd=02)는 identifier가 필요합니다.');
        }

        // 거래 저장
        this.transactions.set(mTxId, {
            mTxId,
            mid,
            reqSvcCd: request.reqSvcCd,
            identifier: request.identifier,
            status: 'REQUESTED',
            createdAt: Date.now(),
        });

        // 폼 파라미터 구성
        const formParams: Record<string, string> = {
            mid,
            reqSvcCd: request.reqSvcCd,
            mTxId,
            successUrl: request.successUrl,
            failUrl: request.failUrl,
            authHash,
            reservedMsg: 'isUseToken=Y',
        };

        // 선택 파라미터
        if (request.flgFixedUser) formParams.flgFixedUser = request.flgFixedUser;
        if (request.userName) formParams.userName = request.userName;
        if (request.userPhone) formParams.userPhone = request.userPhone;
        if (request.userBirthday) formParams.userBirthday = request.userBirthday;
        if (request.identifier) formParams.identifier = request.identifier;

        const authUrl = AUTH_URLS[request.reqSvcCd];

        logger.info(`Auth requested: mTxId=${mTxId}, reqSvcCd=${request.reqSvcCd}`);

        return { mTxId, authUrl, formParams };
    }

    // ─── STEP2: 콜백 처리 ──────────────────────────────────────────────────────

    /**
     * STEP2: KG이니시스 콜백 처리
     * 인증 완료 후 KG이니시스가 successUrl/failUrl로 전달하는 파라미터를 저장한다.
     */
    handleCallback(mTxId: string, params: KgInicisCallbackParams): void {
        const tx = this.transactions.get(mTxId);
        if (!tx) {
            logger.error(`Transaction not found: mTxId=${mTxId}`);
            throw new Error(`거래를 찾을 수 없습니다: ${mTxId}`);
        }

        if (params.resultCode !== '0000') {
            tx.status = 'FAILED';
            logger.warn(`Callback failed: mTxId=${mTxId}, code=${params.resultCode}, msg=${params.resultMsg}`);
            throw new Error(`KG이니시스 인증 실패: [${params.resultCode}] ${params.resultMsg}`);
        }

        tx.authRequestUrl = params.authRequestUrl;
        tx.txId = params.txId;
        tx.token = params.token;
        tx.status = 'CALLBACK_RECEIVED';

        logger.info(`Callback received: mTxId=${mTxId}, txId=${params.txId}`);
    }

    // ─── STEP3+4: 인증 결과 조회 ───────────────────────────────────────────────

    /**
     * STEP3+4: 인증 결과 조회
     * KG이니시스 authRequestUrl에 POST하여 최종 인증 결과를 반환한다.
     * 조회 완료 후 거래를 삭제하여 재사용을 방지한다.
     */
    async queryResult(
        mTxId: string
    ): Promise<KgInicisResultBase | KgInicisIdResult | KgInicisEsignResult> {
        const tx = this.transactions.get(mTxId);
        if (!tx) {
            logger.error(`Transaction not found: mTxId=${mTxId}`);
            throw new Error(`거래를 찾을 수 없습니다: ${mTxId}`);
        }

        if (tx.status !== 'CALLBACK_RECEIVED') {
            logger.error(`Invalid tx status for result query: mTxId=${mTxId}, status=${tx.status}`);
            throw new Error(`결과를 조회할 수 없는 상태입니다: ${tx.status}`);
        }

        if (!tx.authRequestUrl || !tx.txId || !tx.token) {
            logger.error(`Missing callback data: mTxId=${mTxId}`);
            throw new Error('콜백 데이터가 불완전합니다.');
        }

        logger.info(`Querying result: mTxId=${mTxId}, txId=${tx.txId}`);

        const response = await this.httpClient.post(tx.authRequestUrl, {
            mid: tx.mid,
            txId: tx.txId,
            token: tx.token,
        });

        const result = response.data as KgInicisResultBase | KgInicisIdResult | KgInicisEsignResult;

        if (result.resultCode !== '0000') {
            logger.error(`Result query failed: mTxId=${mTxId}, code=${result.resultCode}, msg=${result.resultMsg}`);
            throw new Error(`KG이니시스 결과 조회 실패: [${result.resultCode}] ${result.resultMsg}`);
        }

        // 재사용 방지를 위해 거래 삭제
        this.transactions.delete(mTxId);

        logger.info(`Result retrieved successfully: mTxId=${mTxId}`);

        return result;
    }

    // ─── 상태 조회 ─────────────────────────────────────────────────────────────

    /**
     * 거래 상태 조회
     */
    getTxStatus(mTxId: string): KgInicisTxStatus | null {
        const tx = this.transactions.get(mTxId);
        return tx ? tx.status : null;
    }

    // ─── 내부 유틸리티 ─────────────────────────────────────────────────────────

    /** 환경 변수에서 KG이니시스 인증 정보 가져오기 */
    private getCredentials(): { mid: string; apiKey: string } {
        if (!env.KG_INICIS_MID) {
            throw new Error('환경 변수 KG_INICIS_MID가 설정되지 않았습니다.');
        }
        if (!env.KG_INICIS_API_KEY) {
            throw new Error('환경 변수 KG_INICIS_API_KEY가 설정되지 않았습니다.');
        }
        return { mid: env.KG_INICIS_MID, apiKey: env.KG_INICIS_API_KEY };
    }

    /**
     * authHash 생성
     * SHA256(mid + mTxId + apiKey) → hex
     */
    private generateAuthHash(mid: string, mTxId: string, apiKey: string): string {
        return crypto
            .createHash('sha256')
            .update(mid + mTxId + apiKey)
            .digest('hex');
    }

    /** 20자리 고유 거래 ID 생성 */
    private generateMTxId(): string {
        return crypto.randomUUID().replace(/-/g, '').substring(0, 20);
    }

    /** 만료된 거래 정리 (TTL: 5분) */
    private cleanupExpired(): void {
        const now = Date.now();
        let cleaned = 0;
        for (const [key, tx] of this.transactions) {
            if (now - tx.createdAt > TX_TTL_MS) {
                this.transactions.delete(key);
                cleaned++;
            }
        }
        if (cleaned > 0) {
            logger.debug(`Cleaned up ${cleaned} expired transactions`);
        }
    }

    /** 리소스 정리 */
    destroy(): void {
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = null;
        }
        this.transactions.clear();
    }
}

export const kgInicisService = new KgInicisService();
export default kgInicisService;
