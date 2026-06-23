module.exports = {
    apps: [
        {
            // 통하리 리네이밍: 기존 PM2 프로세스명은 'alimtalk-proxy' 였음.
            // 배포 시 1회 마이그레이션 필요:
            //   pm2 stop alimtalk-proxy || true
            //   pm2 delete alimtalk-proxy || true
            //   pm2 start ecosystem.config.js && pm2 save
            name: 'tonghari-api',
            script: 'dist/index.js',
            
            // 1GB RAM 환경에서 fork 모드 권장
            // cluster 모드는 인스턴스 여러 개 띄우면 메모리 오버헤드가 큼
            instances: 1,
            exec_mode: 'fork',
            
            autorestart: true,
            watch: false,
            
            // 메모리 제한 (Swap 메모리가 있으므로 좀 더 넉넉히 설정)
            // OS 여유분 제외하고 800M으로 설정
            max_memory_restart: '800M',
            
            // Node.js 힙 메모리 제한 (V8 옵션)
            node_args: '--max-old-space-size=512',
            
            env: {
                NODE_ENV: 'development',
                PORT: 3100,
            },
            env_production: {
                NODE_ENV: 'production',
                PORT: 3100,
            },
            
            // 로그 설정
            log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
            error_file: 'logs/error.log',
            out_file: 'logs/out.log',
            merge_logs: true,
            time: true,
            
            // 종료 및 재시작 설정
            kill_timeout: 5000,
            wait_ready: true,
            listen_timeout: 10000,
        },
    ],
};
