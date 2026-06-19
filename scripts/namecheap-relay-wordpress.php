<?php
/**
 * Namecheap egress relay — WordPress version.
 *
 * Drop this whole snippet into a WordPress code-snippets plugin (Code Snippets,
 * WPCode, etc.) on a site you own. Set it to "Run everywhere" (or "Run as PHP
 * snippet"). It registers a REST endpoint at:
 *   https://yoursite.com/wp-json/onboard/v1/namecheap
 *
 * SETUP
 *   1. Paste this snippet into your snippet plugin and activate it.
 *   2. Change $secret below to a long random string.
 *   3. Find this site's outbound IP - visit:
 *        https://yoursite.com/wp-json/onboard/v1/namecheap?whoami=1
 *      Whitelist that IP in Namecheap (Profile -> Tools -> API Access).
 *   4. In Render, set:
 *        NAMECHEAP_RELAY_URL    = https://yoursite.com/wp-json/onboard/v1/namecheap
 *        NAMECHEAP_RELAY_SECRET = <the same $secret>
 *        NAMECHEAP_CLIENT_IP    = <this site's whitelisted IP from step 3>
 *
 * SECURITY: the shared secret gates access. Keep it private; serve over HTTPS.
 * The endpoint only forwards to Namecheap, nothing else. WordPress + cURL only;
 * no other deps.
 */

add_action('rest_api_init', function () {
    register_rest_route('onboard/v1', '/namecheap', [
        'methods'             => 'GET',
        'permission_callback' => '__return_true', // secret check happens in the handler
        'callback'            => 'onboard_namecheap_relay',
    ]);
});

function onboard_namecheap_relay(WP_REST_Request $req) {
    $secret = 'CHANGE_ME_TO_A_LONG_RANDOM_STRING';

    // Helper: report this server's outbound IP so you know what to whitelist.
    if ($req->get_param('whoami')) {
        $resp = wp_remote_get('https://api.ipify.org', ['timeout' => 5]);
        $ip = is_wp_error($resp) ? 'could not determine outbound IP' : trim(wp_remote_retrieve_body($resp));
        return new WP_REST_Response($ip, 200, ['Content-Type' => 'text/plain']);
    }

    if (!hash_equals($secret, (string) $req->get_param('s'))) {
        return new WP_REST_Response('unauthorized', 401, ['Content-Type' => 'text/plain']);
    }

    $env = $req->get_param('env') === 'live' ? 'live' : 'sandbox';
    $base = $env === 'live'
        ? 'https://api.namecheap.com/xml.response'
        : 'https://api.sandbox.namecheap.com/xml.response';

    // Forward every query param except our own (s, env, whoami, plus WP internals).
    $params = $req->get_query_params();
    unset($params['s'], $params['env'], $params['whoami'], $params['rest_route']);
    $url = $base . '?' . http_build_query($params);

    $resp = wp_remote_get($url, ['timeout' => 30]);
    if (is_wp_error($resp)) {
        return new WP_REST_Response('relay error: ' . $resp->get_error_message(), 502, ['Content-Type' => 'text/plain']);
    }

    $body = wp_remote_retrieve_body($resp);
    $status = wp_remote_retrieve_response_code($resp);
    return new WP_REST_Response($body, $status ?: 200, ['Content-Type' => 'text/xml']);
}
