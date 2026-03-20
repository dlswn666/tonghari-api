import crypto from 'crypto';
import axios, { AxiosInstance } from 'axios';
import { env } from '../config/env';
import { createLogger } from '../utils/logger';
import {
    NiceCryptoTokenResponse,
    NiceEncryptionArtifact,
    NiceEncryptRequest,
    NiceEncryptResponse,
    NiceIdentityResult,
} from '../types/nice.types';

const logger = createLogger('NICE');

const NICE_API_BASE_URL = 'https://svc.niceapi.co.kr:22001';
const NICE_AUTH_URL = 'https://nice.checkplus.co.kr/CheckPlusSafeModel/service.cb';

/** 암호화 키 저장소 TTL (5분) */
const ARTIFACT_TTL_MS = 5 * 60 * 1000;
/** 정리 주기 (1분) */
const CLEANUP_INTERVAL_MS = 60 * 1000;

/**
 * NICE 본인인증 API 서비스
 */
class NiceService {
    private httpClient: AxiosInstance;
    /** 암호화 키 임시 저장소 (reqNo → artifact) */
    private artifacts: Map<string, NiceEncryptionArtifact> = new Map();
    private cleanupTimer: NodeJS.Timeout | null = null;

    constructor() {
        this.httpClient = axios.create({
            baseURL: NICE_API_BASE_URL,
            timeout: 30000,
            headers: {
                'Content-Type': 'application/json',
            },
        });

        // 만료된 artifact 주기적 정리 (.unref()로 graceful shutdown 방해 방지)
        this.cleanupTimer = setInterval(() => this.cleanupExpiredArtifacts(), CLEANUP_INTERVAL_MS);
        if (this.cleanupTimer.unref) {
            this.cleanupTimer.unref();
        }
    }

    /**
     * 1단계: Access Token 발급 (최초 1회, 50년 유효)
     * NICE API 대시보드에서 Client ID/Secret 발급 후 호출
     * 발급된 토큰은 환경변수(NICE_ACCESS_TOKEN)에 저장
     */
    async issueAccessToken(): Promise<string> {
        const credentials = Buffer.from(
            `${env.NICE_CLIENT_ID}:${env.NICE_CLIENT_SECRET}`
        ).toString('base64');

        const response = await this.httpClient.post(
            '/digital/niceid/oauth/oauth/token',
            'scope=default&grant_type=client_credentials',
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    Authorization: `Basic ${credentials}`,
                },
            }
        );

        const accessToken = response.data.dataBody.access_token;
        logger.info('Access Token issued successfully (valid for 50 years)');
        return accessToken;
    }

    /**
     * 2단계: 암호화 토큰 요청 + 데이터 암호화
     * 프론트에서 호출하면 NICE에서 crypto token을 받아 요청 데이터를 암호화하여 반환
     */
    async encrypt(request: NiceEncryptRequest): Promise<NiceEncryptResponse> {
        // 요청 번호/시간 생성
        const reqDtim = this.formatDateTime(new Date());
        const reqNo = this.generateReqNo();

        // Bearer 인증 헤더 생성
        const timestamp = Date.now().toString();
        const bearerToken = Buffer.from(
            `${env.NICE_ACCESS_TOKEN}:${timestamp}:${env.NICE_CLIENT_ID}`
        ).toString('base64');

        // NICE에 암호화 토큰 요청
        logger.info(`Requesting crypto token (reqNo: ${reqNo})`);
        const tokenResponse = await this.httpClient.post<NiceCryptoTokenResponse>(
            '/digital/niceid/api/v1.0/common/crypto/token',
            {
                dataHeader: { CNTY_CD: 'ko' },
                dataBody: {
                    req_dtim: reqDtim,
                    req_no: reqNo,
                    enc_mode: '1',
                },
            },
            {
                headers: {
                    Authorization: `bearer ${bearerToken}`,
                    ProductID: env.NICE_PRODUCT_ID,
                },
            }
        );

        const { dataHeader, dataBody } = tokenResponse.data;

        if (dataHeader.GW_RSLT_CD !== '1200') {
            logger.error(`Crypto token request failed: ${dataHeader.GW_RSLT_CD} - ${dataHeader.GW_RSLT_MSG}`);
            throw new Error(`NICE API 오류: ${dataHeader.GW_RSLT_MSG}`);
        }

        if (dataBody.rsp_cd !== 'P000') {
            logger.error(`Crypto token response error: ${dataBody.rsp_cd} - ${dataBody.result_cd}`);
            throw new Error(`NICE 암호화 토큰 오류: ${dataBody.result_cd}`);
        }

        const { site_code, token_version_id, token_val } = dataBody;

        // 대칭키 생성 (SHA256)
        // NICE 스펙: hash의 Base64 문자열에서 key(앞16자), iv(뒤16자), hmacKey(앞32자) 추출
        const hashSource = reqDtim + reqNo + token_val;
        const hashBase64 = crypto
            .createHash('sha256')
            .update(hashSource)
            .digest('base64');

        const key = hashBase64.substring(0, 16);
        const iv = hashBase64.substring(hashBase64.length - 16);
        const hmacKey = hashBase64.substring(0, 32);

        // 암호화 키 저장 (reqNo를 키로 사용하여 동시 세션 충돌 방지)
        this.artifacts.set(reqNo, {
            key,
            iv,
            hmacKey,
            reqNo,
            tokenVersionId: token_version_id,
            returnUrl: request.returnUrl,
            createdAt: Date.now(),
        });

        // 요청 데이터 평문 생성
        const plainData: Record<string, string> = {
            requestno: reqNo,
            returnurl: request.returnUrl,
            sitecode: site_code,
            authtype: request.authType || 'M',
            popupGuide: request.popupGuide || 'N',
            customize: request.customize || '',
            receivedata: '',
        };
        const plainText = JSON.stringify(plainData);

        // AES-128-CBC 암호화
        const encData = this.aesEncrypt(plainText, key, iv);

        // HMAC-SHA256 무결성 값 생성
        const integrityValue = this.hmacSha256(hmacKey, encData);

        logger.info(`Encryption completed (reqNo: ${reqNo}, tokenVersionId: ${token_version_id})`);

        return {
            requestNo: reqNo,
            tokenVersionId: token_version_id,
            encData,
            integrityValue,
        };
    }

    /**
     * 3단계: 인증 결과 복호화
     * NICE 콜백에서 받은 암호화 데이터를 복호화하여 사용자 정보 반환
     */
    decrypt(
        requestNo: string,
        encData: string,
        integrityValue: string
    ): NiceIdentityResult {
        // 저장된 암호화 키 조회 (reqNo 기반)
        const artifact = this.artifacts.get(requestNo);
        if (!artifact) {
            logger.error(`Encryption artifact not found for requestNo: ${requestNo}`);
            throw new Error('인증 세션이 만료되었거나 유효하지 않습니다.');
        }

        // HMAC 무결성 검증 (타이밍 공격 방지를 위한 constant-time 비교)
        const computedHmac = this.hmacSha256(artifact.hmacKey, encData);
        const computedBuf = Buffer.from(computedHmac, 'base64');
        const providedBuf = Buffer.from(integrityValue, 'base64');

        if (computedBuf.length !== providedBuf.length || !crypto.timingSafeEqual(computedBuf, providedBuf)) {
            logger.error('HMAC integrity verification failed');
            throw new Error('데이터 무결성 검증 실패');
        }

        // AES 복호화
        const decryptedText = this.aesDecrypt(encData, artifact.key, artifact.iv);

        // JSON 파싱 + 런타임 검증
        let result: unknown;
        try {
            result = JSON.parse(decryptedText);
        } catch {
            logger.error('Failed to parse decrypted NICE response');
            throw new Error('인증 결과 파싱 실패');
        }

        if (typeof result !== 'object' || result === null || !('requestno' in result) || !('utf8_name' in result)) {
            logger.error('Decrypted NICE response has unexpected shape');
            throw new Error('인증 결과 형식 오류');
        }

        const identity = result as NiceIdentityResult;

        // reqNo 일치 검증
        if (identity.requestno !== artifact.reqNo) {
            logger.error(`Request number mismatch: expected ${artifact.reqNo}, got ${identity.requestno}`);
            throw new Error('요청 번호 불일치');
        }

        // 사용 완료된 artifact 삭제 (재사용 방지)
        this.artifacts.delete(requestNo);

        logger.info(`Identity verified: name=${identity.utf8_name}, birthdate=${identity.birthdate}`);
        return identity;
    }

    /**
     * NICE 본인인증 팝업 URL 반환
     */
    getAuthUrl(): string {
        return NICE_AUTH_URL;
    }

    // ─── 내부 유틸리티 ────────────────────────────────────

    /** AES-128-CBC 암호화 (PKCS7 패딩) */
    private aesEncrypt(plainText: string, key: string, iv: string): string {
        const cipher = crypto.createCipheriv(
            'aes-128-cbc',
            Buffer.from(key, 'utf8'),
            Buffer.from(iv, 'utf8')
        );
        let encrypted = cipher.update(plainText, 'utf8', 'base64');
        encrypted += cipher.final('base64');
        return encrypted;
    }

    /** AES-128-CBC 복호화 */
    private aesDecrypt(encData: string, key: string, iv: string): string {
        const decipher = crypto.createDecipheriv(
            'aes-128-cbc',
            Buffer.from(key, 'utf8'),
            Buffer.from(iv, 'utf8')
        );
        let decrypted = decipher.update(encData, 'base64', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    }

    /** HMAC-SHA256 생성 (Base64) */
    private hmacSha256(hmacKey: string, data: string): string {
        return crypto
            .createHmac('sha256', hmacKey)
            .update(data)
            .digest('base64');
    }

    /** 현재 시간 포맷 (yyyyMMddHHmmss) */
    private formatDateTime(date: Date): string {
        const pad = (n: number) => n.toString().padStart(2, '0');
        return (
            date.getFullYear().toString() +
            pad(date.getMonth() + 1) +
            pad(date.getDate()) +
            pad(date.getHours()) +
            pad(date.getMinutes()) +
            pad(date.getSeconds())
        );
    }

    /** 30자리 고유 요청 번호 생성 */
    private generateReqNo(): string {
        return crypto.randomUUID().replace(/-/g, '').substring(0, 30);
    }

    /** 만료된 artifact 정리 */
    private cleanupExpiredArtifacts(): void {
        const now = Date.now();
        let cleaned = 0;
        for (const [key, artifact] of this.artifacts) {
            if (now - artifact.createdAt > ARTIFACT_TTL_MS) {
                this.artifacts.delete(key);
                cleaned++;
            }
        }
        if (cleaned > 0) {
            logger.debug(`Cleaned up ${cleaned} expired encryption artifacts`);
        }
    }

    /** 리소스 정리 */
    destroy(): void {
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = null;
        }
        this.artifacts.clear();
    }
}

export const niceService = new NiceService();
export default niceService;
