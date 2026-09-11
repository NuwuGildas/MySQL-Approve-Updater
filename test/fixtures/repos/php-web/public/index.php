<?php
// shows which release is live — the deploy e2e asserts on this
$rel = json_decode(@file_get_contents(__DIR__ . '/../.release.json'), true) ?: [];
header('Content-Type: text/plain');
echo 'php-web ok release=' . ($rel['ts'] ?? 'unknown') . ' version=' . trim(@file_get_contents(__DIR__ . '/../VERSION') ?: '0') . "\n";
