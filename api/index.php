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

if (is_file($rootDir . '/vendor/autoload.php')) {
    require_once $rootDir . '/vendor/autoload.php';
}

loadEnvFile($rootDir . '/.env');

$config = [
    'APG_BASE_URL' => envValue('APG_BASE_URL', 'https://transparency.apg.at/api'),
    'APG_LANGUAGE' => envValue('APG_LANGUAGE', 'English'),
    'APG_RESOLUTION' => envValue('APG_RESOLUTION', 'PT60M'),
    'APG_DAY_OFFSET' => envValue('APG_DAY_OFFSET', '1'),
    'CHECK_SECRET' => envValue('CHECK_SECRET', ''),
    'VAPID_PUBLIC_KEY' => envValue('VAPID_PUBLIC_KEY', ''),
    'VAPID_PRIVATE_KEY' => envValue('VAPID_PRIVATE_KEY', ''),
    'VAPID_SUBJECT' => envValue('VAPID_SUBJECT', 'mailto:admin@example.com')
];

ensureDataFiles($dataDir, $stateFile, $subscriptionsFile);

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
            'latestRun' => $state['history'][0] ?? null,
            'subscribers' => count($subscriptions)
        ]);
    }

    if ($method === 'GET' && $path === '/spec') {
        jsonResponse(200, [
            'openApiSpec' => 'https://transparency.apg.at/api/swagger/v1/swagger.json',
            'swaggerUi' => 'https://transparency.apg.at/api/swagger/index.html',
            'dayAheadEndpoint' => '/v1/EXAAD1P/Data/{language}/{resolution}/{fromlocal}/{tolocal}',
            'parameters' => [
                'language' => ['English', 'German'],
                'resolution' => ['PT15M', 'PT60M'],
                'fromlocal' => 'yyyy-MM-ddTHHmmss',
                'tolocal' => 'yyyy-MM-ddTHHmmss (max 1 day after fromlocal)'
            ],
            'valueColumns' => ['MCAuctionPrice', 'MCReferencePrice', 'MCPrice_Chart']
        ]);
    }

    if ($method === 'GET' && $path === '/data') {
        $language = (string) ($query['language'] ?? $config['APG_LANGUAGE']);
        $resolution = (string) ($query['resolution'] ?? $config['APG_RESOLUTION']);
        $date = isset($query['date']) ? (string) $query['date'] : null;

        $apg = fetchApgDayAhead($config, $date, $resolution, $language);
        jsonResponse(200, ['ok' => true, 'apg' => $apg]);
    }

    if ($method === 'POST' && $path === '/subscribe') {
        $subscription = $body['subscription'] ?? null;
        $deviceName = trim((string) ($body['deviceName'] ?? 'Unnamed device'));

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
            'deviceName' => $deviceName !== '' ? $deviceName : 'Unnamed device',
            'subscription' => $subscription,
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
        assertSecret($config['CHECK_SECRET'], $query);

        $state = readJson($stateFile, defaultState());
        $language = (string) ($query['language'] ?? $config['APG_LANGUAGE']);
        $resolution = (string) ($query['resolution'] ?? $config['APG_RESOLUTION']);
        $date = isset($query['date']) ? (string) $query['date'] : null;

        $apg = fetchApgDayAhead($config, $date, $resolution, $language);

        $sameScope = (($state['lastTargetDate'] ?? null) === ($apg['targetDate'] ?? null))
            && (($state['lastResolution'] ?? null) === $resolution)
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
            'targetDate' => $apg['targetDate'],
            'language' => $language,
            'resolution' => $resolution,
            'averagePrice' => $apg['stats']['average'],
            'minPrice' => $apg['stats']['min'],
            'maxPrice' => $apg['stats']['max'],
            'spread' => $apg['stats']['spread'],
            'negativeHours' => $apg['stats']['negativeHours'],
            'priceCount' => $apg['stats']['count'],
            'hasChanged' => $hasChanged,
            'averagePriceDelta' => $averagePriceDelta,
            'signature' => $apg['signature'],
            'sourceVersion' => $apg['versionInformation'] ?? null
        ];

        $nextHistory = $state['history'] ?? [];
        array_unshift($nextHistory, $runRecord);
        $nextHistory = array_slice($nextHistory, 0, 50);

        $nextState = [
            'lastCheckedAt' => $runRecord['at'],
            'lastTargetDate' => $apg['targetDate'],
            'lastResolution' => $resolution,
            'lastLanguage' => $language,
            'lastSignature' => $apg['signature'],
            'lastAveragePrice' => $apg['stats']['average'],
            'history' => $nextHistory
        ];

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

        jsonResponse(200, [
            'ok' => true,
            'hasChanged' => $hasChanged,
            'averagePriceDelta' => $averagePriceDelta,
            'apg' => $apg,
            'pushResult' => $pushResult
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
    $requestUri = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
    $scriptDir = rtrim(str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'] ?? '/')), '/');
    if ($scriptDir === '.' || $scriptDir === '/') {
        $scriptDir = '';
    }

    $path = $requestUri ?: '/';
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

function ensureDataFiles(string $dataDir, string $stateFile, string $subscriptionsFile): void
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
}

function defaultState(): array
{
    return [
        'lastCheckedAt' => null,
        'lastTargetDate' => null,
        'lastSignature' => null,
        'lastAveragePrice' => null,
        'history' => []
    ];
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

function fetchApgDayAhead(array $config, ?string $date, string $resolution, string $language): array
{
    $targetDate = getTargetDate($config, $date);
    $toDate = addDays($targetDate, 1);
    $fromLocal = toApgDateTimeStartOfDay($targetDate);
    $toLocal = toApgDateTimeStartOfDay($toDate);

    $url = $config['APG_BASE_URL']
        . '/v1/EXAAD1P/Data/'
        . rawurlencode($language)
        . '/' . rawurlencode($resolution)
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
        'endpoint' => '/v1/EXAAD1P/Data/{language}/{resolution}/{fromlocal}/{tolocal}',
        'request' => ['language' => $language, 'resolution' => $resolution],
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

function assertSecret(string $checkSecret, array $query): void
{
    if ($checkSecret === '') {
        jsonResponse(500, ['ok' => false, 'error' => 'Missing CHECK_SECRET in environment']);
    }

    $authHeader = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
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
