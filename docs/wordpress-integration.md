# WordPress integration — member self-registration (#599)

Lets a visitor register from the gym's WordPress site. WordPress sends the name and email to Gymdesk, Gymdesk emails the person an invitation, and they set a password and land in the member app. The member appears in the gym's Members list the first time they sign in.

The call is made **by the WordPress server (PHP), never by the visitor's browser**. The API key must not appear in any page, theme template or JavaScript.

## 1. Get the endpoint and the key (Gymdesk admin)

1. Sign in to the admin app as a gym **admin** and open **System → Website Integration**.
2. Copy the **Registration endpoint**. It looks like `https://<api-host>/public/gyms/<gym-id>-<gym-name>/registrations`.
   The id at the front is what identifies the gym, so two gyms with the same name never share an endpoint (#645). Always copy the endpoint from this page rather than typing it — the name after the id is only there for readability and is ignored.
3. Click **Generate key** and copy the key (`gdk_…`). It is shown once. If it is lost, use **Rotate key** — the old key stops working immediately.

## 2. Store both values in `wp-config.php`

Add these lines above `/* That's all, stop editing! */`:

```php
define( 'GYMDESK_REGISTRATION_URL', 'https://<api-host>/public/gyms/<gym-id>-<gym-name>/registrations' );
define( 'GYMDESK_API_KEY', 'gdk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' );

// Optional but strongly recommended — Cloudflare Turnstile (free). Create a widget for
// the site's domain at https://dash.cloudflare.com → Turnstile.
define( 'GYMDESK_TURNSTILE_SITE_KEY', '' );
define( 'GYMDESK_TURNSTILE_SECRET_KEY', '' );
```

`wp-config.php` is not served to visitors and is normally outside version control, which is why the key goes here and not in the plugin file or the database.

## 3. Install the plugin

Create `wp-content/mu-plugins/gymdesk-registration.php` (create the `mu-plugins` folder if it does not exist — files there are always active and cannot be disabled from the dashboard by mistake):

```php
<?php
/**
 * Plugin Name: Gymdesk Registration
 * Description: [gymdesk_register] shortcode — sends member sign-ups to Gymdesk.
 */

if ( ! defined( 'ABSPATH' ) ) exit;

/** Sends one registration to Gymdesk. Returns true when Gymdesk accepted it. */
function gymdesk_register_member( string $name, string $email, ?int $center_id = null ): bool {
    if ( ! defined( 'GYMDESK_REGISTRATION_URL' ) || ! defined( 'GYMDESK_API_KEY' ) ) return false;

    $body = array( 'name' => $name, 'email' => $email, 'locale' => substr( get_locale(), 0, 2 ) );
    if ( ! in_array( $body['locale'], array( 'en', 'es', 'ca' ), true ) ) unset( $body['locale'] );
    if ( $center_id ) $body['center_id'] = $center_id;

    $response = wp_remote_post( GYMDESK_REGISTRATION_URL, array(
        'timeout' => 10,
        'headers' => array( 'Content-Type' => 'application/json', 'x-api-key' => GYMDESK_API_KEY ),
        'body'    => wp_json_encode( $body ),
    ) );

    if ( is_wp_error( $response ) ) {
        error_log( 'Gymdesk registration failed: ' . $response->get_error_message() );
        return false;
    }
    $code = wp_remote_retrieve_response_code( $response );
    if ( 202 !== $code ) error_log( 'Gymdesk registration failed: HTTP ' . $code . ' ' . wp_remote_retrieve_body( $response ) );
    return 202 === $code;
}

/**
 * Health check (#645): confirms the endpoint, the key and network access
 * without registering anybody. Returns true when Gymdesk answered 200.
 */
function gymdesk_registration_health_check(): bool {
    if ( ! defined( 'GYMDESK_REGISTRATION_URL' ) || ! defined( 'GYMDESK_API_KEY' ) ) return false;

    $response = wp_remote_post( GYMDESK_REGISTRATION_URL, array(
        'timeout' => 10,
        'headers' => array( 'Content-Type' => 'application/json', 'x-api-key' => GYMDESK_API_KEY ),
        'body'    => wp_json_encode( array( 'name' => 'test', 'email' => '' ) ),
    ) );

    if ( is_wp_error( $response ) ) return false;
    return 200 === wp_remote_retrieve_response_code( $response );
}

function gymdesk_turnstile_enabled(): bool {
    return defined( 'GYMDESK_TURNSTILE_SITE_KEY' ) && GYMDESK_TURNSTILE_SITE_KEY
        && defined( 'GYMDESK_TURNSTILE_SECRET_KEY' ) && GYMDESK_TURNSTILE_SECRET_KEY;
}

function gymdesk_turnstile_passed(): bool {
    if ( ! gymdesk_turnstile_enabled() ) return true;
    $response = wp_remote_post( 'https://challenges.cloudflare.com/turnstile/v0/siteverify', array(
        'timeout' => 10,
        'body'    => array(
            'secret'   => GYMDESK_TURNSTILE_SECRET_KEY,
            'response' => sanitize_text_field( wp_unslash( $_POST['cf-turnstile-response'] ?? '' ) ),
            'remoteip' => $_SERVER['REMOTE_ADDR'] ?? '',
        ),
    ) );
    if ( is_wp_error( $response ) ) return false;
    $result = json_decode( wp_remote_retrieve_body( $response ), true );
    return ! empty( $result['success'] );
}

/** Form handler — runs for logged-out and logged-in visitors. */
function gymdesk_handle_registration() {
    $back = wp_get_referer() ?: home_url( '/' );
    $done = function ( string $status ) use ( $back ) {
        wp_safe_redirect( add_query_arg( 'gymdesk', $status, remove_query_arg( 'gymdesk', $back ) ) . '#gymdesk-register' );
        exit;
    };

    if ( ! isset( $_POST['_gymdesk_nonce'] ) || ! wp_verify_nonce( $_POST['_gymdesk_nonce'], 'gymdesk_register' ) ) $done( 'error' );
    // Honeypot: real visitors never see or fill this field. Pretend it worked.
    if ( ! empty( $_POST['website'] ) ) $done( 'ok' );
    if ( ! gymdesk_turnstile_passed() ) $done( 'captcha' );

    $name  = sanitize_text_field( wp_unslash( $_POST['gymdesk_name'] ?? '' ) );
    $email = sanitize_email( wp_unslash( $_POST['gymdesk_email'] ?? '' ) );
    if ( '' === $name || ! is_email( $email ) ) $done( 'invalid' );

    $done( gymdesk_register_member( $name, $email ) ? 'ok' : 'error' );
}
add_action( 'admin_post_nopriv_gymdesk_register', 'gymdesk_handle_registration' );
add_action( 'admin_post_gymdesk_register', 'gymdesk_handle_registration' );

/** [gymdesk_register] */
function gymdesk_register_shortcode(): string {
    $messages = array(
        'ok'      => __( 'Thanks! Check your inbox — we have sent you an email to finish creating your account.', 'gymdesk' ),
        'invalid' => __( 'Please enter your name and a valid email address.', 'gymdesk' ),
        'captcha' => __( 'Please complete the security check and try again.', 'gymdesk' ),
        'error'   => __( 'Something went wrong. Please try again in a few minutes.', 'gymdesk' ),
    );
    $status = sanitize_key( $_GET['gymdesk'] ?? '' );

    ob_start(); ?>
    <div id="gymdesk-register">
        <?php if ( isset( $messages[ $status ] ) ) : ?>
            <p class="gymdesk-message gymdesk-message--<?php echo esc_attr( $status ); ?>" role="status"><?php echo esc_html( $messages[ $status ] ); ?></p>
        <?php endif; ?>
        <?php if ( 'ok' !== $status ) : ?>
        <form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
            <input type="hidden" name="action" value="gymdesk_register">
            <?php wp_nonce_field( 'gymdesk_register', '_gymdesk_nonce' ); ?>
            <p><label><?php esc_html_e( 'Name', 'gymdesk' ); ?><br><input type="text" name="gymdesk_name" required maxlength="255" autocomplete="name"></label></p>
            <p><label><?php esc_html_e( 'Email', 'gymdesk' ); ?><br><input type="email" name="gymdesk_email" required maxlength="255" autocomplete="email"></label></p>
            <p style="position:absolute;left:-9999px" aria-hidden="true"><label>Website<input type="text" name="website" tabindex="-1" autocomplete="off"></label></p>
            <?php if ( gymdesk_turnstile_enabled() ) : ?>
                <div class="cf-turnstile" data-sitekey="<?php echo esc_attr( GYMDESK_TURNSTILE_SITE_KEY ); ?>"></div>
                <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
            <?php endif; ?>
            <p><button type="submit"><?php esc_html_e( 'Register', 'gymdesk' ); ?></button></p>
        </form>
        <?php endif; ?>
    </div>
    <?php return ob_get_clean();
}
add_shortcode( 'gymdesk_register', 'gymdesk_register_shortcode' );
```

## 4. Put the form on a page

Edit the page where people should register, add a **Shortcode** block and type `[gymdesk_register]`. Style it from the theme with the `#gymdesk-register` selector.

If a page-caching plugin is active (WP Rocket, LiteSpeed, W3 Total Cache…), **exclude that page from the cache** — a cached page serves an expired nonce and every submission fails with the generic error.

### Already using a form plugin?

Keep the plugin's form and CAPTCHA, skip the shortcode, and call `gymdesk_register_member()` from the plugin's submit hook. Contact Form 7 example (fields named `your-name` and `your-email`):

```php
add_action( 'wpcf7_before_send_mail', function ( $form ) {
    $data = WPCF7_Submission::get_instance()->get_posted_data();
    gymdesk_register_member( sanitize_text_field( $data['your-name'] ), sanitize_email( $data['your-email'] ) );
} );
```

## 5. Test it

1. Submit the form with an email address that has never been used with Gymdesk.
2. The page shows "Check your inbox". The invitation email arrives within a minute.
3. Open the link, set a password — you land in the member app.
4. In the admin app, the person is now in **Members**.

From a terminal, without WordPress:

```bash
curl -i -X POST "$GYMDESK_REGISTRATION_URL" -H "Content-Type: application/json" -H "x-api-key: $GYMDESK_API_KEY" -d '{"name":"Test Person","email":"test.person@example.com"}'
```

## API reference

`POST /public/gyms/:gymRef/registrations` — header `x-api-key`, JSON body:

`:gymRef` is `{gymId}-{gymName}` (#645). Only the id is resolved; the name is decorative, so renaming the gym does not break a configured site. The pre-#645 `{gymSlug}` form still works, so existing installs keep registering, but new integrations should use the format the admin page shows.

| Field | Required | Notes |
|-------|----------|-------|
| `name` | yes | Up to 255 characters. |
| `email` | yes | |
| `center_id` | only for gyms with more than one active center | The center the member joins. An inactive center is treated as non-existent: it is rejected like an unknown id and never counts towards "more than one center". |
| `locale` | no | `en`, `es` or `ca` — language of the page the invitation link opens. Defaults to `en`. Does **not** change the email's language — see below. |

**Invitation email language.** `locale` only sets the language of the page the link opens (`/{locale}/link`). A Spanish site should send `'locale' => 'es'`. The invitation **email** is Clerk's *Invitation* template, which Clerk sends as written: its invitation API takes no language, and there is one template per Clerk instance, shared by every gym and by every invitation (website registration, members created in the admin, staff). To change its wording or language, edit it in the Clerk Dashboard → Customization → Emails → *Invitation*. A bilingual template is the safe choice while gyms with different languages share the instance.

| Status | Meaning |
|--------|---------|
| `200` | Health check accepted — see below. Nothing was registered. |
| `202` | Accepted. Returned for every valid, authenticated request — **including** when the email already belongs to a member, a staff login, or a pending invitation. This is deliberate: the endpoint never reveals who belongs to the gym. Always show the visitor the same "check your inbox" message. |
| `400` | Invalid body (bad email, missing name, unknown or missing `center_id`). |
| `401` | Missing or wrong key, or the gym in the URL is unknown, inactive or not the one that owns the key. |
| `429` | Rate limit reached (per server IP per hour, and per gym per day). |
| `502` | The invitation service is temporarily unavailable — ask the visitor to retry later. |

### Health check (#645)

To verify the endpoint, the key and network access without registering anybody, send the registration request with the name `test` and an empty email:

```bash
curl -i -X POST "$GYMDESK_REGISTRATION_URL" -H "Content-Type: application/json" -H "x-api-key: $GYMDESK_API_KEY" -d '{"name":"test","email":""}'
```

`200` means the key is valid and the gym resolved. The call creates no member, no invitation and no email, writes nothing, and does not spend the gym's daily registration quota (the per-IP hourly limit still applies). `401` means the key or the gym reference is wrong.

Any other name, or a non-empty email, is a real registration — including the name `test` with a real address.

## Known limitations

- An email that **already has a Gymdesk account** (for example, a member of another gym) receives no email: the identity provider refuses to invite existing accounts. Staff handle these people from the Members page.
- A person can be a member of **one gym only** on the platform (their email is unique across gyms). Someone already on another gym's member list gets the "check your inbox" message but no email.
- There is no "resend" from the website while an invitation is pending. Invitations expire after 30 days; staff can resend from the Members page once the person exists there.

## Troubleshooting

| Symptom | Cause |
|---------|-------|
| Always "Something went wrong" | Check the PHP error log for `Gymdesk registration failed`. `HTTP 401` = wrong key, or the gym id in the URL does not match the gym that owns the key. Run the health check above to tell the two apart from the key's own behaviour. |
| `HTTP 400 … center_id is required as the gym has more than one center` | The gym has several active centers (inactive ones don't count) — pass the center id as the third argument of `gymdesk_register_member()`. |
| Form works once, then always fails | The page is cached. Exclude it from the page cache. |
| "Check your inbox" but no email | The address is already a member, a staff login, already invited, or already has an account. This is reported as success on purpose. Check the spam folder, then the Members page in the admin app. |
