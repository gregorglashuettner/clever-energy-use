<?php
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Headers: Content-Type, Authorization');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

$rootDir = dirname(__DIR__);
$dataDir = $rootDir . '/data';
$stateFile = $dataDir . '/state.json';
$subscriptionsFile = $dataDir . '/subscriptions.json';
$apgCacheFile = $dataDir . '/apg-cache.json';
const MAX_STATE_HISTORY_ITEMS = 30;
const MAX_STATE_FILE_BYTES = 131072;

if (is_file($rootDir . '/vendor/autoload.php')) {
    require_once $rootDir . '/vendor/autoload.php';
}

loadEnvFile($rootDir . '/.env');

$config = [
    'APG_BASE_URL' => envValue('APG_BASE_URL', 'https://transparency.apg.at/api'),
    'APG_LANGUAGE' => envValue('APG_LANGUAGE', 'English'),
    'APG_RESOLUTION' => envValue('APG_RESOLUTION', 'PT15M'),
    'APG_DAY_OFFSET' => envValue('APG_DAY_OFFSET', '0'),
    'WEBSITE_CHECK_SECRET' => envValue('WEBSITE_CHECK_SECRET', ''),
    'VAPID_PUBLIC_KEY' => envValue('VAPID_PUBLIC_KEY', ''),
    'VAPID_PRIVATE_KEY' => envValue('VAPID_PRIVATE_KEY', ''),
    'VAPID_SUBJECT' => envValue('VAPID_SUBJECT', 'mailto:admin@example.com')
];

ensureDataFiles($dataDir, $stateFile, $subscriptionsFile, $apgCacheFile);

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$path = requestPath();
$query = $_GET;
$body = requestJsonBody();

try {
    if ($method === 'GET' && $path === '/vapid-public-key') {
        jsonResponse(200, ['publicKey' => $config['VAPID_PUBLIC_KEY']]);
    }

    if ($method === 'GET' && $path === '/status') {
        $state = readJson($stateFile, defaultState());
        $subscriptions = readJson($subscriptionsFile, []);

        jsonResponse(200, [
            'source' => 'APG EXAAD1P day-ahead prices',
            'apgBaseUrl' => $config['APG_BASE_URL'],
            'defaultLanguage' => $config['APG_LANGUAGE'],
            'defaultResolution' => $config['APG_RESOLUTION'],
            'defaultDayOffset' => (int) $config['APG_DAY_OFFSET'],
            'lastTargetDate' => $state['lastTargetDate'] ?? null,
            'lastAveragePrice' => $state['lastAveragePrice'] ?? null,
            'lastCheckedAt' => $state['lastCheckedAt'] ?? null,
            'todayTypeDate' => $state['todayTypeDate'] ?? null,
            'todayType' => $state['todayType'] ?? null,
            'latestRun' => $state['history'][0] ?? null,
            'subscribers' => count($subscriptions)
        ]);
    }

    if ($method === 'GET' && $path === '/spec') {
        jsonResponse(200, [
            'openApiSpec' => 'https://transparency.apg.at/api/swagger/v1/swagger.json',
            'swaggerUi' => 'https://transparency.apg.at/api/swagger/index.html',
            'dayAheadEndpoint' => '/v1/EXAAD1P/Data/{language}/PT15M/{fromlocal}/{tolocal}',
            'parameters' => [
                'language' => ['English', 'German'],
                'resolution' => ['PT15M'],
                'fromlocal' => 'yyyy-MM-ddTHHmmss',
                'tolocal' => 'yyyy-MM-ddTHHmmss (max 1 day after fromlocal)'
            ],
            'valueColumns' => ['MCAuctionPrice', 'MCReferencePrice', 'MCPrice_Chart']
        ]);
    }

    if ($method === 'GET' && $path === '/data') {
        $state = readJson($stateFile, defaultState());
        $todayTypeInfo = resolveTodayType($state);
        $language = (string) ($query['language'] ?? $config['APG_LANGUAGE']);
        $date = isset($query['date']) ? (string) $query['date'] : null;

        $cached = fetchApgDayAheadCached($config, $apgCacheFile, $date, $language);
        $apg = $cached['apg'];
        $fromCache = (bool) ($cached['fromCache'] ?? false);

        $sameScope = (($state['lastTargetDate'] ?? null) === ($apg['targetDate'] ?? null))
            && (($state['lastLanguage'] ?? null) === $language);

        $hasChanged = $sameScope && isset($state['lastSignature'])
            ? ($state['lastSignature'] !== $apg['signature'])
            : false;

        $previousAveragePrice = is_numeric($state['lastAveragePrice'] ?? null)
            ? (float) $state['lastAveragePrice']
            : null;
        $currentAverage = is_numeric($apg['stats']['average'] ?? null)
            ? (float) $apg['stats']['average']
            : null;
        $averagePriceDelta = ($previousAveragePrice !== null && $currentAverage !== null)
            ? ($currentAverage - $previousAveragePrice)
            : null;

        $runRecord = [
            'at' => gmdate('c'),
            'trigger' => 'data',
            'targetDate' => $apg['targetDate'],
            'language' => $language,
            'averagePrice' => $apg['stats']['average'],
            'minPrice' => $apg['stats']['min'],
            'maxPrice' => $apg['stats']['max'],
            'spread' => $apg['stats']['spread'],
            'negativeHours' => $apg['stats']['negativeHours'],
            'priceCount' => $apg['stats']['count'],
            'hasChanged' => $hasChanged,
            'averagePriceDelta' => $averagePriceDelta
        ];

        $nextState = compactStateForStorage([
            'lastCheckedAt' => $runRecord['at'],
            'lastTargetDate' => $apg['targetDate'],
            'lastLanguage' => $language,
            'lastSignature' => $apg['signature'],
            'lastAveragePrice' => $apg['stats']['average'],
            'todayTypeDate' => $todayTypeInfo['todayTypeDate'],
            'todayType' => $todayTypeInfo['todayType'],
            'history' => array_merge([$runRecord], $state['history'] ?? [])
        ]);

        writeJson($stateFile, $nextState);
        $userNotificationResult = evaluateUserNotifications($subscriptionsFile, $apg, $config, $todayTypeInfo['todayType']);
        jsonResponse(200, ['ok' => true, 'apg' => $apg, 'hasChanged' => $hasChanged, 'averagePriceDelta' => $averagePriceDelta, 'fromCache' => $fromCache, 'userNotificationResult' => $userNotificationResult]);
    }

    if ($method === 'POST' && $path === '/subscribe') {
        $subscription = $body['subscription'] ?? null;
        $settings = normalizeNotificationSettings($body['settings'] ?? null);

        if (!is_array($subscription)
            || !isset($subscription['endpoint'])
            || !isset($subscription['keys']['p256dh'])
            || !isset($subscription['keys']['auth'])) {
            jsonResponse(400, ['error' => 'Invalid push subscription payload']);
        }

        $subscriptions = readJson($subscriptionsFile, []);
        $id = subscriptionId((string) $subscription['endpoint']);

        $entry = [
            'id' => $id,
            'subscription' => $subscription,
            'settings' => $settings,
            'createdAt' => gmdate('c')
        ];

        $existingIndex = null;
        foreach ($subscriptions as $idx => $sub) {
            if (($sub['id'] ?? null) === $id) {
                $existingIndex = $idx;
                break;
            }
        }

        if ($existingIndex !== null) {
            $subscriptions[$existingIndex] = array_merge($subscriptions[$existingIndex], $entry);
        } else {
            $subscriptions[] = $entry;
        }

        writeJson($subscriptionsFile, $subscriptions);
        jsonResponse(200, ['ok' => true, 'id' => $id]);
    }

    if ($method === 'POST' && $path === '/settings') {
        $endpoint = (string) ($body['endpoint'] ?? '');
        if ($endpoint === '') {
            jsonResponse(400, ['error' => 'Missing endpoint']);
        }

        $settings = normalizeNotificationSettings($body['settings'] ?? null);
        $subscriptions = readJson($subscriptionsFile, []);

        $found = false;
        foreach ($subscriptions as $idx => $entry) {
            if (($entry['subscription']['endpoint'] ?? '') === $endpoint) {
                $subscriptions[$idx]['settings'] = $settings;
                $found = true;
                break;
            }
        }

        if (!$found) {
            jsonResponse(404, ['error' => 'Subscription not found']);
        }

        writeJson($subscriptionsFile, $subscriptions);
        jsonResponse(200, ['ok' => true]);
    }

    if ($method === 'POST' && $path === '/unsubscribe') {
        $endpoint = (string) ($body['endpoint'] ?? '');
        if ($endpoint === '') {
            jsonResponse(400, ['error' => 'Missing endpoint']);
        }

        $subscriptions = readJson($subscriptionsFile, []);
        $filtered = array_values(array_filter($subscriptions, static function (array $entry) use ($endpoint): bool {
            return (($entry['subscription']['endpoint'] ?? '') !== $endpoint);
        }));

        writeJson($subscriptionsFile, $filtered);
        jsonResponse(200, ['ok' => true, 'removed' => count($subscriptions) - count($filtered)]);
    }

    if ($method === 'POST' && $path === '/check') {
        assertSecret($config['WEBSITE_CHECK_SECRET'], $query);

        $state = readJson($stateFile, defaultState());
        $todayTypeInfo = resolveTodayType($state);
        $language = (string) ($query['language'] ?? $config['APG_LANGUAGE']);
        $date = isset($query['date']) ? (string) $query['date'] : null;

        $cached = fetchApgDayAheadCached($config, $apgCacheFile, $date, $language);
        $apg = $cached['apg'];
        $fromCache = (bool) ($cached['fromCache'] ?? false);

        $sameScope = (($state['lastTargetDate'] ?? null) === ($apg['targetDate'] ?? null))
            && (($state['lastLanguage'] ?? null) === $language);

        $hasChanged = $sameScope && isset($state['lastSignature'])
            ? ($state['lastSignature'] !== $apg['signature'])
            : false;

        $previousAveragePrice = is_numeric($state['lastAveragePrice'] ?? null)
            ? (float) $state['lastAveragePrice']
            : null;
        $currentAverage = is_numeric($apg['stats']['average'] ?? null)
            ? (float) $apg['stats']['average']
            : null;
        $averagePriceDelta = ($previousAveragePrice !== null && $currentAverage !== null)
            ? ($currentAverage - $previousAveragePrice)
            : null;

        $runRecord = [
            'at' => gmdate('c'),
            'trigger' => 'check',
            'targetDate' => $apg['targetDate'],
            'language' => $language,
            'averagePrice' => $apg['stats']['average'],
            'minPrice' => $apg['stats']['min'],
            'maxPrice' => $apg['stats']['max'],
            'spread' => $apg['stats']['spread'],
            'negativeHours' => $apg['stats']['negativeHours'],
            'priceCount' => $apg['stats']['count'],
            'hasChanged' => $hasChanged,
            'averagePriceDelta' => $averagePriceDelta
        ];

        $nextState = compactStateForStorage([
            'lastCheckedAt' => $runRecord['at'],
            'lastTargetDate' => $apg['targetDate'],
            'lastLanguage' => $language,
            'lastSignature' => $apg['signature'],
            'lastAveragePrice' => $apg['stats']['average'],
            'todayTypeDate' => $todayTypeInfo['todayTypeDate'],
            'todayType' => $todayTypeInfo['todayType'],
            'history' => array_merge([$runRecord], $state['history'] ?? [])
        ]);

        writeJson($stateFile, $nextState);

        $pushResult = ['sent' => 0, 'removed' => 0, 'total' => 0, 'warning' => null];
        if ($hasChanged) {
            $avg = $apg['stats']['average'] === null
                ? 'n/a'
                : number_format((float) $apg['stats']['average'], 2, '.', '') . ' EUR/MWh';
            $bodyText = 'Date ' . $apg['targetDate']
                . ': avg ' . $avg
                . ', min ' . numberOrNA($apg['stats']['min'])
                . ', max ' . numberOrNA($apg['stats']['max']);

            $pushPayload = [
                'title' => 'APG day-ahead prices changed',
                'body' => $bodyText,
                'url' => '/',
                'data' => [
                    'targetDate' => $apg['targetDate'],
                    'averagePrice' => $apg['stats']['average'],
                    'minPrice' => $apg['stats']['min'],
                    'maxPrice' => $apg['stats']['max'],
                    'spread' => $apg['stats']['spread'],
                    'negativeHours' => $apg['stats']['negativeHours'],
                    'checkedAt' => $runRecord['at']
                ]
            ];

            $pushResult = sendPushToAll(
                $subscriptionsFile,
                $pushPayload,
                $config['VAPID_SUBJECT'],
                $config['VAPID_PUBLIC_KEY'],
                $config['VAPID_PRIVATE_KEY']
            );
        }

        $userNotificationResult = evaluateUserNotifications($subscriptionsFile, $apg, $config, $todayTypeInfo['todayType']);

        jsonResponse(200, [
            'ok' => true,
            'hasChanged' => $hasChanged,
            'averagePriceDelta' => $averagePriceDelta,
            'apg' => $apg,
            'fromCache' => $fromCache,
            'pushResult' => $pushResult,
            'userNotificationResult' => $userNotificationResult
        ]);
    }

    jsonResponse(404, ['error' => 'Not found', 'path' => $path]);
} catch (Throwable $error) {
    jsonResponse(500, ['ok' => false, 'error' => $error->getMessage()]);
}

function envValue(string $key, string $default): string
{
    $value = getenv($key);
    if ($value === false || $value === '') {
        return $default;
    }
    return (string) $value;
}

function loadEnvFile(string $file): void
{
    if (!is_file($file)) {
        return;
    }

    $lines = file($file, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
    if ($lines === false) {
        return;
    }

    foreach ($lines as $line) {
        $trimmed = trim($line);
        if ($trimmed === '' || str_starts_with($trimmed, '#')) {
            continue;
        }

        $pos = strpos($trimmed, '=');
        if ($pos === false) {
            continue;
        }

        $name = trim(substr($trimmed, 0, $pos));
        $value = trim(substr($trimmed, $pos + 1));
        if ($name === '') {
            continue;
        }

        if ((str_starts_with($value, '"') && str_ends_with($value, '"'))
            || (str_starts_with($value, "'") && str_ends_with($value, "'"))) {
            $value = substr($value, 1, -1);
        }

        putenv($name . '=' . $value);
        $_ENV[$name] = $value;
        $_SERVER[$name] = $value;
    }
}

function requestPath(): string
{
    $pathInfo = $_SERVER['PATH_INFO'] ?? null;
    if (is_string($pathInfo) && $pathInfo !== '') {
        return '/' . ltrim($pathInfo, '/');
    }

    $requestUri = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
    $scriptName = str_replace('\\', '/', $_SERVER['SCRIPT_NAME'] ?? '');
    $scriptDir = rtrim(str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'] ?? '/')), '/');
    if ($scriptDir === '.' || $scriptDir === '/') {
        $scriptDir = '';
    }

    $path = $requestUri ?: '/';

    if ($scriptName !== '' && str_starts_with($path, $scriptName)) {
        $path = substr($path, strlen($scriptName));
    }
    if ($scriptDir !== '' && str_starts_with($path, $scriptDir)) {
        $path = substr($path, strlen($scriptDir));
    }

    return $path === '' ? '/' : $path;
}

function requestJsonBody(): array
{
    $raw = file_get_contents('php://input');
    if ($raw === false || trim($raw) === '') {
        return [];
    }

    $decoded = json_decode($raw, true);
    return is_array($decoded) ? $decoded : [];
}

function jsonResponse(int $status, array $payload): void
{
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_SLASHES);
    exit;
}

function ensureDataFiles(string $dataDir, string $stateFile, string $subscriptionsFile, string $apgCacheFile): void
{
    if (!is_dir($dataDir) && !mkdir($dataDir, 0775, true) && !is_dir($dataDir)) {
        throw new RuntimeException('Failed to create data directory');
    }

    if (!is_file($stateFile)) {
        writeJson($stateFile, defaultState());
    }

    if (!is_file($subscriptionsFile)) {
        writeJson($subscriptionsFile, []);
    }

    if (!is_file($apgCacheFile)) {
        writeJson($apgCacheFile, ['entries' => []]);
    }
}

function defaultState(): array
{
    return [
        'lastCheckedAt' => null,
        'lastTargetDate' => null,
        'lastSignature' => null,
        'lastAveragePrice' => null,
        'todayTypeDate' => null,
        'todayType' => null,
        'history' => []
    ];
}

function sanitizeRunRecord(array $record): array
{
    return [
        'at' => $record['at'] ?? null,
        'trigger' => $record['trigger'] ?? null,
        'targetDate' => $record['targetDate'] ?? null,
        'language' => $record['language'] ?? null,
        'averagePrice' => $record['averagePrice'] ?? null,
        'minPrice' => $record['minPrice'] ?? null,
        'maxPrice' => $record['maxPrice'] ?? null,
        'spread' => $record['spread'] ?? null,
        'negativeHours' => $record['negativeHours'] ?? null,
        'priceCount' => $record['priceCount'] ?? null,
        'hasChanged' => $record['hasChanged'] ?? null,
        'averagePriceDelta' => $record['averagePriceDelta'] ?? null
    ];
}

function compactStateForStorage(array $state): array
{
    $history = [];
    foreach (($state['history'] ?? []) as $item) {
        if (!is_array($item)) {
            continue;
        }
        $history[] = sanitizeRunRecord($item);
        if (count($history) >= MAX_STATE_HISTORY_ITEMS) {
            break;
        }
    }

    $next = [
        'lastCheckedAt' => $state['lastCheckedAt'] ?? null,
        'lastTargetDate' => $state['lastTargetDate'] ?? null,
        'lastLanguage' => $state['lastLanguage'] ?? null,
        'lastSignature' => $state['lastSignature'] ?? null,
        'lastAveragePrice' => $state['lastAveragePrice'] ?? null,
        'todayTypeDate' => $state['todayTypeDate'] ?? null,
        'todayType' => $state['todayType'] ?? null,
        'history' => $history
    ];

    while (count($next['history']) > 1) {
        $encoded = json_encode($next, JSON_UNESCAPED_SLASHES);
        if ($encoded === false || strlen($encoded) <= MAX_STATE_FILE_BYTES) {
            break;
        }
        array_pop($next['history']);
    }

    return $next;
}

function readJson(string $file, array $fallback): array
{
    if (!is_file($file)) {
        return $fallback;
    }

    $raw = file_get_contents($file);
    if ($raw === false) {
        return $fallback;
    }

    $decoded = json_decode($raw, true);
    return is_array($decoded) ? $decoded : $fallback;
}

function writeJson(string $file, array $value): void
{
    $encoded = json_encode($value, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
    if ($encoded === false) {
        throw new RuntimeException('Failed to encode JSON');
    }

    $ok = file_put_contents($file, $encoded . PHP_EOL, LOCK_EX);
    if ($ok === false) {
        throw new RuntimeException('Failed to write file: ' . $file);
    }
}

function todayViennaDateString(): string
{
    $dt = new DateTimeImmutable('now', new DateTimeZone('Europe/Vienna'));
    return $dt->format('Y-m-d');
}

function addDays(string $dateString, int $days): string
{
    $dt = DateTimeImmutable::createFromFormat('Y-m-d', $dateString, new DateTimeZone('UTC'));
    if (!$dt) {
        throw new InvalidArgumentException('Invalid date format. Use YYYY-MM-DD');
    }
    return $dt->modify(($days >= 0 ? '+' : '') . $days . ' day')->format('Y-m-d');
}

function toApgDateTimeStartOfDay(string $dateString): string
{
    return $dateString . 'T000000';
}

function getTargetDate(array $config, ?string $requestedDate): string
{
    if ($requestedDate !== null && $requestedDate !== '') {
        if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $requestedDate)) {
            throw new InvalidArgumentException('Invalid date format. Use YYYY-MM-DD');
        }
        return $requestedDate;
    }

    $offset = filter_var($config['APG_DAY_OFFSET'], FILTER_VALIDATE_INT);
    $safeOffset = ($offset === false) ? 1 : (int) $offset;
    return addDays(todayViennaDateString(), $safeOffset);
}

function resolveTodayType(array $state): array
{
    $now = getViennaNowParts();
    $todayKey = dateObjToKey($now);
    $persistedType = $state['todayType'] ?? null;
    if (
        ($state['todayTypeDate'] ?? null) === $todayKey
        && ($persistedType === 'Werktag' || $persistedType === 'Feiertag/Wochenende')
    ) {
        return ['todayTypeDate' => $todayKey, 'todayType' => $persistedType];
    }

    $dayType = (isAustriaHoliday($now) || isWeekendDate($now)) ? 'Feiertag/Wochenende' : 'Werktag';
    return ['todayTypeDate' => $todayKey, 'todayType' => $dayType];
}

function pickPriceValue(array $columnNames, array $rowValues): array
{
    $priorityColumns = ['MCPrice_Chart', 'MCAuctionPrice', 'MCReferencePrice'];

    foreach ($priorityColumns as $name) {
        $idx = array_search($name, $columnNames, true);
        if ($idx === false) {
            continue;
        }

        $candidate = $rowValues[$idx]['V'] ?? null;
        if (is_numeric($candidate)) {
            return ['value' => (float) $candidate, 'column' => $name];
        }
    }

    return ['value' => null, 'column' => null];
}

function calculatePriceStats(array $series): array
{
    $values = [];
    foreach ($series as $item) {
        if (isset($item['price']) && is_numeric($item['price'])) {
            $values[] = (float) $item['price'];
        }
    }

    if (count($values) === 0) {
        return [
            'count' => 0,
            'average' => null,
            'min' => null,
            'max' => null,
            'spread' => null,
            'negativeHours' => 0,
            'first' => null,
            'last' => null,
            'dayDelta' => null
        ];
    }

    $sum = array_sum($values);
    $min = min($values);
    $max = max($values);
    $first = $values[0];
    $last = $values[count($values) - 1];
    $negativeCount = 0;
    foreach ($values as $value) {
        if ($value < 0) {
            $negativeCount++;
        }
    }

    return [
        'count' => count($values),
        'average' => $sum / count($values),
        'min' => $min,
        'max' => $max,
        'spread' => $max - $min,
        'negativeHours' => $negativeCount,
        'first' => $first,
        'last' => $last,
        'dayDelta' => $last - $first
    ];
}

function buildSeriesSignature(array $series): string
{
    $parts = [];
    foreach ($series as $row) {
        $parts[] = sprintf('%.4f', (float) ($row['price'] ?? 0.0));
    }
    return hash('sha256', implode('|', $parts));
}

function fetchApgDayAhead(array $config, ?string $date, string $language): array
{
    $targetDate = getTargetDate($config, $date);
    $toDate = addDays($targetDate, 1);
    $fromLocal = toApgDateTimeStartOfDay($targetDate);
    $toLocal = toApgDateTimeStartOfDay($toDate);

    $url = $config['APG_BASE_URL']
        . '/v1/EXAAD1P/Data/'
        . rawurlencode($language)
        . '/PT15M'
        . '/' . $fromLocal
        . '/' . $toLocal;

    $payload = httpGetJson($url);
    $responseData = $payload['ResponseData'] ?? null;

    if (!is_array($responseData)
        || !isset($responseData['ValueRows'])
        || !is_array($responseData['ValueRows'])
        || !isset($responseData['ValueColumns'])
        || !is_array($responseData['ValueColumns'])) {
        throw new RuntimeException('Unexpected APG response format');
    }

    $columnNames = [];
    foreach ($responseData['ValueColumns'] as $column) {
        $columnNames[] = (string) ($column['InternalName'] ?? '');
    }

    $series = [];
    foreach ($responseData['ValueRows'] as $row) {
        $rowValues = $row['V'] ?? [];
        if (!is_array($rowValues)) {
            continue;
        }
        $picked = pickPriceValue($columnNames, $rowValues);
        if (!is_numeric($picked['value'])) {
            continue;
        }

        $series[] = [
            'dateFrom' => $row['DF'] ?? null,
            'timeFrom' => $row['TF'] ?? null,
            'dateTo' => $row['DT'] ?? null,
            'timeTo' => $row['TT'] ?? null,
            'price' => (float) $picked['value'],
            'sourceColumn' => $picked['column']
        ];
    }

    $stats = calculatePriceStats($series);

    return [
        'targetDate' => $targetDate,
        'range' => ['fromlocal' => $fromLocal, 'tolocal' => $toLocal],
        'endpoint' => '/v1/EXAAD1P/Data/{language}/PT15M/{fromlocal}/{tolocal}',
        'request' => ['language' => $language, 'resolution' => 'PT15M'],
        'sourceUrl' => $url,
        'versionInformation' => $responseData['VersionInformation'] ?? null,
        'description' => $responseData['Description'] ?? null,
        'columns' => $columnNames,
        'series' => $series,
        'stats' => $stats,
        'signature' => buildSeriesSignature($series),
        'fetchedAt' => gmdate('c')
    ];
}

function fetchApgDayAheadCached(array $config, string $apgCacheFile, ?string $date, string $language): array
{
    $targetDate = getTargetDate($config, $date);
    $cache = readJson($apgCacheFile, ['entries' => []]);
    $entries = isset($cache['entries']) && is_array($cache['entries']) ? $cache['entries'] : [];
    $key = $targetDate . '|' . $language . '|PT15M';
    $entry = $entries[$key] ?? null;
    $maxAgeSeconds = 2 * 60 * 60;

    if (is_array($entry) && isset($entry['fetchedAt'], $entry['apg']) && is_array($entry['apg'])) {
        $ts = strtotime((string) $entry['fetchedAt']);
        if ($ts !== false && (time() - $ts) <= $maxAgeSeconds) {
            return ['apg' => $entry['apg'], 'fromCache' => true];
        }
    }

    $apg = fetchApgDayAhead($config, $targetDate, $language);
    $entries[$key] = [
        'fetchedAt' => gmdate('c'),
        'apg' => $apg
    ];
    writeJson($apgCacheFile, ['entries' => $entries]);
    return ['apg' => $apg, 'fromCache' => false];
}

function httpGetJson(string $url): array
{
    $ch = curl_init($url);
    if ($ch === false) {
        throw new RuntimeException('Failed to initialize HTTP client');
    }

    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_TIMEOUT => 20,
        CURLOPT_HTTPHEADER => [
            'Accept: application/json',
            'User-Agent: clever-energy-use-php/1.0'
        ]
    ]);

    $raw = curl_exec($ch);
    $httpStatus = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $error = curl_error($ch);
    curl_close($ch);

    if ($raw === false) {
        throw new RuntimeException('APG request failed: ' . $error);
    }
    if ($httpStatus < 200 || $httpStatus >= 300) {
        throw new RuntimeException('APG request failed (' . $httpStatus . '): ' . substr($raw, 0, 240));
    }

    $decoded = json_decode($raw, true);
    if (!is_array($decoded)) {
        throw new RuntimeException('APG response was not valid JSON');
    }

    return $decoded;
}

function subscriptionId(string $endpoint): string
{
    return hash('sha256', $endpoint);
}

function defaultNotificationSettings(): array
{
    return [
        'cheapAlertEnabled' => false,
        'weekdayStart' => '08:00',
        'weekdayEnd' => '20:00',
        'holidayStart' => '10:00',
        'holidayEnd' => '18:00',
        'dailyDigestEnabled' => false
    ];
}

function isValidHalfHourSlot($value): bool
{
    if (!is_string($value) || !preg_match('/^\d{2}:(00|30)$/', $value)) {
        return false;
    }
    $parts = explode(':', $value);
    $hour = (int) $parts[0];
    $minute = (int) $parts[1];
    $total = $hour * 60 + $minute;
    return $total >= 240 && $total <= 1320;
}

function normalizeNotificationSettings($input): array
{
    $defaults = defaultNotificationSettings();
    $raw = is_array($input) ? $input : [];
    $settings = $defaults;

    if (array_key_exists('cheapAlertEnabled', $raw)) {
        $settings['cheapAlertEnabled'] = (bool) $raw['cheapAlertEnabled'];
    }

    foreach (['weekdayStart', 'weekdayEnd', 'holidayStart', 'holidayEnd'] as $key) {
        if (array_key_exists($key, $raw) && isValidHalfHourSlot($raw[$key])) {
            $settings[$key] = $raw[$key];
        }
    }

    if (array_key_exists('dailyDigestEnabled', $raw)) {
        $settings['dailyDigestEnabled'] = (bool) $raw['dailyDigestEnabled'];
    }

    return $settings;
}

function getViennaNowParts(): array
{
    $dt = new DateTimeImmutable('now', new DateTimeZone('Europe/Vienna'));
    return [
        'year' => (int) $dt->format('Y'),
        'month' => (int) $dt->format('m'),
        'day' => (int) $dt->format('d'),
        'hour' => (int) $dt->format('H'),
        'minute' => (int) $dt->format('i')
    ];
}

function dateObjToKey(array $date): string
{
    return sprintf('%04d-%02d-%02d', (int) $date['year'], (int) $date['month'], (int) $date['day']);
}

function timeToMinutes($value): ?int
{
    if (!is_string($value) || !preg_match('/^\d{2}:\d{2}$/', $value)) {
        return null;
    }
    [$h, $m] = array_map('intval', explode(':', $value));
    return $h * 60 + $m;
}

function easterSundayDate(int $year): array
{
    $base = new DateTimeImmutable('@' . easter_date($year));
    $utc = $base->setTimezone(new DateTimeZone('UTC'));
    return [
        'year' => (int) $utc->format('Y'),
        'month' => (int) $utc->format('m'),
        'day' => (int) $utc->format('d')
    ];
}

function addDaysToDateObj(array $date, int $days): array
{
    $dt = DateTimeImmutable::createFromFormat('Y-m-d', dateObjToKey($date), new DateTimeZone('UTC'));
    if (!$dt) {
        return $date;
    }
    $next = $dt->modify(($days >= 0 ? '+' : '') . $days . ' day');
    return [
        'year' => (int) $next->format('Y'),
        'month' => (int) $next->format('m'),
        'day' => (int) $next->format('d')
    ];
}

function buildAustriaHolidaySet(int $year): array
{
    $holidays = [
        sprintf('%04d-01-01', $year),
        sprintf('%04d-01-06', $year),
        sprintf('%04d-05-01', $year),
        sprintf('%04d-08-15', $year),
        sprintf('%04d-10-26', $year),
        sprintf('%04d-11-01', $year),
        sprintf('%04d-12-08', $year),
        sprintf('%04d-12-25', $year),
        sprintf('%04d-12-26', $year)
    ];

    $easter = easterSundayDate($year);
    foreach ([1, 39, 50, 60] as $offset) {
        $holidays[] = dateObjToKey(addDaysToDateObj($easter, $offset));
    }

    return array_values(array_unique($holidays));
}

function isAustriaHoliday(array $date): bool
{
    return in_array(dateObjToKey($date), buildAustriaHolidaySet((int) $date['year']), true);
}

function isWeekendDate(array $date): bool
{
    $dt = DateTimeImmutable::createFromFormat('Y-m-d', dateObjToKey($date), new DateTimeZone('UTC'));
    if (!$dt) {
        return false;
    }
    $weekday = (int) $dt->format('w'); // 0=Sun,6=Sat
    return $weekday === 0 || $weekday === 6;
}

function pickWindowForDate(array $settings, array $date): array
{
    $holidayOrWeekend = isAustriaHoliday($date) || isWeekendDate($date);
    if ($holidayOrWeekend) {
        return ['start' => $settings['holidayStart'], 'end' => $settings['holidayEnd'], 'dayType' => 'Feiertag/Wochenende'];
    }
    return ['start' => $settings['weekdayStart'], 'end' => $settings['weekdayEnd'], 'dayType' => 'Werktag'];
}

function pickWindowForDayType(array $settings, string $dayType): array
{
    if ($dayType === 'Feiertag/Wochenende') {
        return ['start' => $settings['holidayStart'], 'end' => $settings['holidayEnd'], 'dayType' => $dayType];
    }
    return ['start' => $settings['weekdayStart'], 'end' => $settings['weekdayEnd'], 'dayType' => 'Werktag'];
}

function filterSeriesByWindow(array $series, string $windowStart, string $windowEnd): array
{
    $startMin = timeToMinutes($windowStart);
    $endMin = timeToMinutes($windowEnd);
    if ($startMin === null || $endMin === null || $startMin >= $endMin) {
        return [];
    }

    return array_values(array_filter($series, static function (array $row) use ($startMin, $endMin): bool {
        $rowMin = timeToMinutes((string) ($row['timeFrom'] ?? ''));
        return $rowMin !== null && $rowMin >= $startMin && $rowMin < $endMin;
    }));
}

function findCheapestRangeInSeries(array $series, int $slotCount = 3): ?array
{
    if (count($series) < $slotCount) {
        return null;
    }
    $values = [];
    foreach ($series as $row) {
        $v = $row['price'] ?? null;
        if (!is_numeric($v)) {
            return null;
        }
        $values[] = (float) $v;
    }

    $sum = 0.0;
    for ($i = 0; $i < $slotCount; $i++) {
        $sum += $values[$i];
    }
    $bestStart = 0;
    $bestAvg = $sum / $slotCount;
    for ($i = 1; $i <= count($values) - $slotCount; $i++) {
        $sum += $values[$i + $slotCount - 1] - $values[$i - 1];
        $avg = $sum / $slotCount;
        if ($avg < $bestAvg) {
            $bestAvg = $avg;
            $bestStart = $i;
        }
    }

    return [
        'start' => $series[$bestStart],
        'end' => $series[$bestStart + $slotCount - 1],
        'average' => $bestAvg
    ];
}

function sendPushToSingleEntry(array $entry, array $payload, array $config): array
{
    if (!class_exists('Minishlink\\WebPush\\WebPush') || !class_exists('Minishlink\\WebPush\\Subscription')) {
        return ['ok' => false, 'invalid' => false, 'reason' => 'missing_library'];
    }
    if (($config['VAPID_PUBLIC_KEY'] ?? '') === '' || ($config['VAPID_PRIVATE_KEY'] ?? '') === '') {
        return ['ok' => false, 'invalid' => false, 'reason' => 'missing_vapid'];
    }

    $auth = [
        'VAPID' => [
            'subject' => $config['VAPID_SUBJECT'],
            'publicKey' => $config['VAPID_PUBLIC_KEY'],
            'privateKey' => $config['VAPID_PRIVATE_KEY']
        ]
    ];
    $webPush = new Minishlink\WebPush\WebPush($auth);
    $jsonPayload = json_encode($payload, JSON_UNESCAPED_SLASHES);
    if ($jsonPayload === false) {
        return ['ok' => false, 'invalid' => false, 'reason' => 'encode_failed'];
    }

    try {
        $subscription = Minishlink\WebPush\Subscription::create($entry['subscription'] ?? []);
        $report = $webPush->sendOneNotification($subscription, $jsonPayload);
        if (method_exists($report, 'isSuccess') && $report->isSuccess()) {
            return ['ok' => true, 'invalid' => false, 'reason' => null];
        }
        $response = method_exists($report, 'getResponse') ? $report->getResponse() : null;
        $statusCode = ($response && method_exists($response, 'getStatusCode')) ? $response->getStatusCode() : null;
        if ($statusCode === 404 || $statusCode === 410) {
            return ['ok' => false, 'invalid' => true, 'reason' => 'gone'];
        }
        return ['ok' => false, 'invalid' => false, 'reason' => 'push_failed'];
    } catch (Throwable $error) {
        return ['ok' => false, 'invalid' => false, 'reason' => 'push_exception'];
    }
}

function evaluateUserNotifications(string $subscriptionsFile, array $apg, array $config, string $todayType): array
{
    $subscriptions = readJson($subscriptionsFile, []);
    if (count($subscriptions) === 0) {
        return ['digestSent' => 0, 'cheapSent' => 0, 'removed' => 0, 'total' => 0, 'skipped' => 'no_subscriptions'];
    }

    $now = getViennaNowParts();
    $todayKey = dateObjToKey($now);
    if (($apg['targetDate'] ?? '') !== $todayKey) {
        return ['digestSent' => 0, 'cheapSent' => 0, 'removed' => 0, 'total' => count($subscriptions), 'skipped' => 'not_today_target'];
    }

    $nowMinutes = ((int) $now['hour']) * 60 + (int) $now['minute'];
    $digestSent = 0;
    $cheapSent = 0;
    $removed = 0;
    $changed = false;
    $keep = [];

    foreach ($subscriptions as $entry) {
        $settings = normalizeNotificationSettings($entry['settings'] ?? null);
        $history = isset($entry['notificationHistory']) && is_array($entry['notificationHistory'])
            ? $entry['notificationHistory']
            : [];
        $window = pickWindowForDayType($settings, $todayType);
        $startMin = timeToMinutes($window['start']);
        $endMin = timeToMinutes($window['end']);
        $inWindow = $startMin !== null && $endMin !== null && $endMin > $startMin && $nowMinutes >= $startMin && $nowMinutes < $endMin;

        $invalid = false;

        if ($settings['dailyDigestEnabled'] && $inWindow && (($history['lastDigestDate'] ?? null) !== $todayKey)) {
            $avg = is_numeric($apg['stats']['average'] ?? null) ? number_format((float) $apg['stats']['average'], 2, '.', '') : 'n/a';
            $payload = [
                'title' => 'Deine Benachrichtigung über den heutigen Strompreis',
                'body' => 'Heute (' . $window['dayType'] . ') im Zeitfenster ' . $window['start'] . '-' . $window['end'] . ': Durchschnitt ' . $avg . ' EUR/MWh.',
                'url' => '/',
                'data' => ['type' => 'daily_digest', 'targetDate' => $apg['targetDate']]
            ];
            $send = sendPushToSingleEntry($entry, $payload, $config);
            if ($send['invalid']) {
                $invalid = true;
            } elseif ($send['ok']) {
                $digestSent++;
                $history['lastDigestDate'] = $todayKey;
                $changed = true;
            }
        }

        if (!$invalid && $settings['cheapAlertEnabled'] && $inWindow && (($history['lastCheapAlertDate'] ?? null) !== $todayKey)) {
            $windowSeries = filterSeriesByWindow($apg['series'] ?? [], $window['start'], $window['end']);
            $cheapest = findCheapestRangeInSeries($windowSeries, 3);
            if ($cheapest !== null) {
                $cheapStart = timeToMinutes((string) ($cheapest['start']['timeFrom'] ?? ''));
                $cheapEnd = timeToMinutes((string) ($cheapest['end']['timeTo'] ?? ''));
                $inCheapRange = $cheapStart !== null && $cheapEnd !== null && $cheapEnd > $cheapStart && $nowMinutes >= $cheapStart && $nowMinutes < $cheapEnd;
                if ($inCheapRange) {
                    $payload = [
                        'title' => 'Der Strom ist ab jetzt billig!',
                        'body' => $window['dayType'] . ' ' . $window['start'] . '-' . $window['end'] . ': günstigster Bereich gestartet (' . (($cheapest['start']['timeFrom'] ?? '')) . '-' . (($cheapest['end']['timeTo'] ?? '')) . ').',
                        'url' => '/',
                        'data' => ['type' => 'cheap_alert', 'targetDate' => $apg['targetDate']]
                    ];
                    $send = sendPushToSingleEntry($entry, $payload, $config);
                    if ($send['invalid']) {
                        $invalid = true;
                    } elseif ($send['ok']) {
                        $cheapSent++;
                        $history['lastCheapAlertDate'] = $todayKey;
                        $changed = true;
                    }
                }
            }
        }

        if ($invalid) {
            $removed++;
            $changed = true;
            continue;
        }

        $entry['settings'] = $settings;
        $entry['notificationHistory'] = $history;
        $keep[] = $entry;
    }

    if ($changed) {
        writeJson($subscriptionsFile, $keep);
    }

    return [
        'digestSent' => $digestSent,
        'cheapSent' => $cheapSent,
        'removed' => $removed,
        'total' => count($subscriptions),
        'skipped' => null
    ];
}

function assertSecret(string $checkSecret, array $query): void
{
    if ($checkSecret === '') {
        jsonResponse(500, ['ok' => false, 'error' => 'Missing WEBSITE_CHECK_SECRET in environment']);
    }

    $authHeader = (string) ($_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '');
    $headerSecret = null;
    if (str_starts_with($authHeader, 'Bearer ')) {
        $headerSecret = substr($authHeader, 7);
    }

    $querySecret = isset($query['secret']) ? (string) $query['secret'] : null;

    if ($headerSecret === $checkSecret || $querySecret === $checkSecret) {
        return;
    }

    jsonResponse(401, ['error' => 'Unauthorized']);
}

function sendPushToAll(
    string $subscriptionsFile,
    array $payload,
    string $vapidSubject,
    string $vapidPublicKey,
    string $vapidPrivateKey
): array {
    $subscriptions = readJson($subscriptionsFile, []);
    if (count($subscriptions) === 0) {
        return ['sent' => 0, 'removed' => 0, 'total' => 0, 'warning' => null];
    }

    if (!class_exists('Minishlink\\WebPush\\WebPush') || !class_exists('Minishlink\\WebPush\\Subscription')) {
        return [
            'sent' => 0,
            'removed' => 0,
            'total' => count($subscriptions),
            'warning' => 'Push library missing. Install minishlink/web-push with Composer.'
        ];
    }

    if ($vapidPublicKey === '' || $vapidPrivateKey === '') {
        return [
            'sent' => 0,
            'removed' => 0,
            'total' => count($subscriptions),
            'warning' => 'Missing VAPID_PUBLIC_KEY or VAPID_PRIVATE_KEY.'
        ];
    }

    $auth = [
        'VAPID' => [
            'subject' => $vapidSubject,
            'publicKey' => $vapidPublicKey,
            'privateKey' => $vapidPrivateKey
        ]
    ];

    $webPush = new Minishlink\WebPush\WebPush($auth);
    $jsonPayload = json_encode($payload, JSON_UNESCAPED_SLASHES);
    if ($jsonPayload === false) {
        throw new RuntimeException('Failed to encode push payload');
    }

    $sent = 0;
    $removed = 0;
    $keep = [];

    foreach ($subscriptions as $entry) {
        try {
            $subscription = Minishlink\WebPush\Subscription::create($entry['subscription'] ?? []);
            $report = $webPush->sendOneNotification($subscription, $jsonPayload);

            if (method_exists($report, 'isSuccess') && $report->isSuccess()) {
                $sent++;
                $keep[] = $entry;
                continue;
            }

            $response = method_exists($report, 'getResponse') ? $report->getResponse() : null;
            $statusCode = ($response && method_exists($response, 'getStatusCode'))
                ? $response->getStatusCode()
                : null;
            if ($statusCode === 404 || $statusCode === 410) {
                $removed++;
                continue;
            }

            $keep[] = $entry;
        } catch (Throwable $error) {
            $keep[] = $entry;
        }
    }

    if ($removed > 0) {
        writeJson($subscriptionsFile, $keep);
    }

    return ['sent' => $sent, 'removed' => $removed, 'total' => count($subscriptions), 'warning' => null];
}

function numberOrNA($value): string
{
    if (!is_numeric($value)) {
        return 'n/a';
    }
    return number_format((float) $value, 2, '.', '');
}
