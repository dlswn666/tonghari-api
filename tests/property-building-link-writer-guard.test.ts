import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';

test('Phase 0-S property-building 자동 writer allowlist는 0건이다', () => {
    const result = spawnSync(process.execPath, ['scripts/check-property-building-link-writers.mjs'], {
        cwd: process.cwd(),
        encoding: 'utf8',
    });

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /writer guard passed/);
});
