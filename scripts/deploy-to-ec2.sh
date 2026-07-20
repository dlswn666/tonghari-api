#!/bin/bash

set -euo pipefail

echo "이 스크립트의 Docker Hub/latest 직접 배포 방식은 폐기되었습니다." >&2
echo ".github/workflows/docker-build.yml의 GHCR SHA/digest 배포를 사용하세요." >&2
exit 1
