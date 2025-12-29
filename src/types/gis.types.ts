export interface GisSyncRequest {
    unionId: string;
    addresses: string[];
}

export interface GisJobInfo {
    jobId: string;
    unionId: string;
    totalCount: number;
    processedCount: number;
    status: 'pending' | 'processing' | 'completed' | 'failed';
    error?: string;
    createdAt: Date;
    startedAt?: Date;
    completedAt?: Date;
}
