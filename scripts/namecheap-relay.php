<?php
/**
 * Namecheap egress relay — static-IP workaround for OnboardEngine.
 *
 * WHY: Namecheap requires API calls to come from a whitelisted IP. Render's
 * outbound IPs are shared/rotating, so the engine can't be whitelisted directly.
 * Drop this one file on any host you control that has a stable IP (e.g. one of
 * your web servers). It forwards the engine's Namecheap query to Namecheap from
 * THIS server's IP and returns the response verbatim. You whitelist THIS
 * server's IP in Namecheap, once.
 *
 * SETUP
 *   1. Put this file somewhere web-accessible, e.g.
 *        https://yoursite.com/ne-relay.php
 *   2. Change $SECRET below to a long random string.
 *   3. Find this server's outbound IP:  https://yoursite.com/ne-relay.php?whoami=1
 *      Whitelist that IP in Namecheap (Profile -> Tools -> API Access).
 *   4. In Render, set:
 *        NAMECHEAP_RELAY_URL    = https://yoursite.com/ne-relay.php
 *        NAMECHEAP_RELAY_SECRET = <the same $SECRET>
 *        NAMECHEAP_CLIENT_IP    = <this server's whitelisted IP from step 3>
 *
 * SECURITY: the shared secret gates access. Anyone with the URL + secret can
 * make Namecheap API calls on your account, so keep the secret private and serve
 * this over HTTPS. Requires PHP with cURL.
 */

$SECRET = 'CHANGE_ME_TO_A_LONG_RANDOM_STRING';

// Helper: report this server's outbound IP so you know what to whitelist.
if (isset($_GET['whoami'])) {
    $ip = @file_get_contents('https://api.ipify.org');
    header('Content-Type: text/plain');
    echo $ip ?: 'could not determine outbound IP';
    exit;
}

if (!hash_equals($SECRET, $_GET['s'] ?? '')) {
    http_response_code(401);
    exit('unauthorized');
}

$base = (($_GET['env'] ?? 'sandbox') === 'live')
    ? 'https://api.namecheap.com/xml.response'
    : 'https://api.sandbox.namecheap.com/xml.response';

// Forward every param except our own control params (s, env, whoami).
$params = $_GET;
unset($params['s'], $params['env'], $params['whoami']);
$url = $base . '?' . http_build_query($params);

$ch = curl_init($url);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_TIMEOUT, 30);
$resp = curl_exec($ch);
$status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
$err = curl_error($ch);
curl_close($ch);

if ($resp === false) {
    http_response_code(502);
    header('Content-Type: text/plain');
    echo 'relay curl error: ' . $err;
    exit;
}

http_response_code($status ?: 200);
header('Content-Type: text/xml');
echo $resp;
