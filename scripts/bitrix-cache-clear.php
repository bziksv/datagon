<?php
/**
 * Datagon: сброс файлового кэша каталога Bitrix после деактивации/цен.
 * GET/POST ?token=...
 */
header('Content-Type: application/json; charset=utf-8');
$token = isset($_REQUEST['token']) ? (string)$_REQUEST['token'] : '';
$expected = getenv('DATAGON_CACHE_CLEAR_TOKEN');
if (!$expected) {
    $cfg = __DIR__ . '/cache_clear.token';
    if (is_file($cfg)) {
        $expected = trim((string)file_get_contents($cfg));
    }
}
if ($expected === '' || !hash_equals($expected, $token)) {
    http_response_code(403);
    echo json_encode(['success' => false, 'error' => 'forbidden'], JSON_UNESCAPED_UNICODE);
    exit;
}
$docRoot = dirname(__DIR__, 2);
$removed = [];
$targets = [
    $docRoot . '/bitrix/cache/s1/bitrix/catalog.element',
    $docRoot . '/bitrix/cache/s1/bitrix/catalog.section',
    $docRoot . '/bitrix/cache/s1/bitrix/catalog',
    $docRoot . '/bitrix/cache/s1/nbrains',
    $docRoot . '/bitrix/managed_cache/MYSQL',
    $docRoot . '/bitrix/stack_cache/MYSQL',
];
foreach ($targets as $path) {
    if (!file_exists($path)) {
        continue;
    }
    $it = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($path, FilesystemIterator::SKIP_DOTS),
        RecursiveIteratorIterator::CHILD_FIRST
    );
    foreach ($it as $file) {
        $file->isDir() ? @rmdir($file->getPathname()) : @unlink($file->getPathname());
    }
    $removed[] = $path;
}
if (is_file($docRoot . '/bitrix/modules/main/include/prolog_before.php')) {
    define('NO_KEEP_STATISTIC', true);
    define('NOT_CHECK_PERMISSIONS', true);
    define('BX_NO_ACCELERATOR_RESET', true);
    try {
        require $docRoot . '/bitrix/modules/main/include/prolog_before.php';
        if (function_exists('BXClearCache')) {
            BXClearCache(true);
            $removed[] = 'BXClearCache';
        }
        if (class_exists('CHTMLPagesCache') && method_exists('CHTMLPagesCache', 'CleanAll')) {
            CHTMLPagesCache::CleanAll();
            $removed[] = 'CHTMLPagesCache';
        }
    } catch (Throwable $e) {
        echo json_encode([
            'success' => true,
            'removed' => $removed,
            'bitrix_warning' => $e->getMessage(),
        ], JSON_UNESCAPED_UNICODE);
        exit;
    }
}
echo json_encode(['success' => true, 'removed' => $removed], JSON_UNESCAPED_UNICODE);
