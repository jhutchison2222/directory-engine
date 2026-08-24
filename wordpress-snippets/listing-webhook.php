<?php
/**
 * Directory Engine — owner-edit safeguard webhook snippet.
 *
 * Install via a code-snippets plugin (recommended) or the theme's
 * functions.php, on EVERY niche site. Fires whenever a gd_place listing is
 * saved on THIS site, and tells the Worker about it -- unless the save was
 * made by the Worker's own service account (the Application Password user),
 * in which case it's skipped so the Worker's own automated publishes don't
 * immediately re-lock themselves.
 *
 * -----------------------------------------------------------------------
 * EDIT THESE FOUR LINES FOR EACH SITE BEFORE INSTALLING:
 * -----------------------------------------------------------------------
 */
define( 'DE_WEBHOOK_SITE_ID', 'restaurants' );                     // this site's site_key in the `sites` table
define( 'DE_WEBHOOK_SERVICE_ACCOUNT_USER', 'firm777' );             // the Application Password user for THIS site
define( 'DE_WEBHOOK_WORKER_URL', 'https://directory-engine-api.jhutchison.workers.dev/v1/webhook/listing-changed' );
define( 'DE_WEBHOOK_SECRET', 'REPLACE_WITH_THE_WORDPRESS_WEBHOOK_SECRET_VALUE' ); // must match the Worker's WORDPRESS_WEBHOOK_SECRET

/**
 * Per-site reference (Application Password usernames, confirmed 2026-08-24):
 *   restaurants   -> firm777      hvac          -> ohwfc      dentists      -> hqmvb
 *   electricians  -> zbgur        roofers       -> tqoik      orthodontists -> f6pdu
 *   plumbers      -> c8itw        attorneys     -> hseft      chiropractors -> rpoe8
 *   hairsalons    -> 986of        autorepair    -> dibnl
 * Update DE_WEBHOOK_SITE_ID and DE_WEBHOOK_SERVICE_ACCOUNT_USER to match
 * whichever site this copy of the snippet is installed on.
 */

add_action( 'save_post_gd_place', 'de_webhook_notify_listing_changed', 20, 3 );

function de_webhook_notify_listing_changed( $post_id, $post, $update ) {
	// Skip autosaves/revisions -- only real saves matter.
	if ( wp_is_post_autosave( $post_id ) || wp_is_post_revision( $post_id ) ) {
		return;
	}
	// Skip anything not actually published/pending/draft (e.g. auto-drafts, trash).
	if ( ! in_array( $post->post_status, array( 'publish', 'pending', 'draft' ), true ) ) {
		return;
	}

	// The core of the safeguard: if the Worker itself made this save (via its
	// Application Password credential), the acting WordPress user is this
	// site's service account -- skip entirely, or every automated publish
	// would immediately lock itself and stop future updates from working.
	$current_user = wp_get_current_user();
	if ( $current_user && $current_user->user_login === DE_WEBHOOK_SERVICE_ACCOUNT_USER ) {
		return;
	}

	// Pull GeoDirectory's own listing detail (address/city/region/country/
	// lat/lng/phone/website) via its core accessor rather than guessing at
	// raw postmeta keys, which vary by GeoDirectory version.
	$gd_info = function_exists( 'geodir_get_post_info' ) ? geodir_get_post_info( $post_id ) : null;

	$body = array(
		'site_id'    => DE_WEBHOOK_SITE_ID,
		'wp_post_id' => $post_id,
		'title'      => get_the_title( $post_id ),
	);

	if ( $gd_info ) {
		$maybe = array(
			'category' => isset( $gd_info->default_category_name ) ? $gd_info->default_category_name : null,
			'address'  => isset( $gd_info->street ) ? $gd_info->street : null,
			'city'     => isset( $gd_info->city ) ? $gd_info->city : null,
			'region'   => isset( $gd_info->region ) ? $gd_info->region : null,
			'country'  => isset( $gd_info->country ) ? $gd_info->country : null,
			'lat'      => isset( $gd_info->latitude ) ? floatval( $gd_info->latitude ) : null,
			'lng'      => isset( $gd_info->longitude ) ? floatval( $gd_info->longitude ) : null,
			'phone'    => isset( $gd_info->geodir_contact ) ? $gd_info->geodir_contact : null,
			'website'  => isset( $gd_info->geodir_website ) ? $gd_info->geodir_website : null,
		);
		foreach ( $maybe as $key => $value ) {
			if ( $value !== null && $value !== '' ) {
				$body[ $key ] = $value;
			}
		}
	}

	wp_remote_post(
		DE_WEBHOOK_WORKER_URL,
		array(
			'timeout' => 8,
			'headers' => array(
				'Content-Type'                        => 'application/json',
				'X-Directory-Engine-Webhook-Secret'   => DE_WEBHOOK_SECRET,
			),
			'body'    => wp_json_encode( $body ),
			'blocking' => false, // fire-and-forget -- don't slow down the editor's save.
		)
	);
}
