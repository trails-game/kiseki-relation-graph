<?php
/**
 * Plugin Name:       Kiseki Interactive Relationship Graph (轨迹系列导力关系图谱)
 * Plugin URI:        https://trails-game.com/relations
 * Description:       Interactive 3D/2D multi-arc relationship graph for Trails / Kiseki (Characters, Organizations, Families, Martial Schools & Nations) powered by zero-SQL static JSON snapshots and a Visual Admin Studio accessible to Editors and Administrators.
 * Version:           1.0.2
 * Requires at least: 6.2
 * Requires PHP:      8.1
 * Author:            trails-game
 * License:           GPL-2.0-or-later
 * Text Domain:       kiseki-relation-graph
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'KISEKI_RELATION_VERSION', '1.0.2' );
define( 'KISEKI_RELATION_CAP', 'manage_kiseki_relations' );
define( 'KISEKI_RELATION_PLUGIN_DIR', plugin_dir_path( __FILE__ ) );
define( 'KISEKI_RELATION_PLUGIN_URL', plugin_dir_url( __FILE__ ) );

require_once KISEKI_RELATION_PLUGIN_DIR . 'includes/class-json-store.php';
require_once KISEKI_RELATION_PLUGIN_DIR . 'includes/class-rest-controller.php';
require_once KISEKI_RELATION_PLUGIN_DIR . 'includes/class-admin-frontend.php';

/**
 * Checks whether the current user has full backend access.
 * Explicitly grants full access to BOTH Administrator and Editor roles.
 */
function kiseki_relation_user_can_manage(): bool {
	return is_user_logged_in() && (
		current_user_can( KISEKI_RELATION_CAP )
		|| current_user_can( 'edit_others_posts' )
		|| current_user_can( 'manage_options' )
	);
}

/**
 * Ensures both 'administrator' and 'editor' roles hold manage_kiseki_relations.
 */
function kiseki_relation_ensure_capabilities(): void {
	foreach ( array( 'administrator', 'editor' ) as $role_slug ) {
		$role = get_role( $role_slug );
		if ( $role && ! $role->has_cap( KISEKI_RELATION_CAP ) ) {
			$role->add_cap( KISEKI_RELATION_CAP );
		}
	}
}

/**
 * Activation hook: grant Editor + Admin capabilities & initialize static JSON store from seed.
 */
function kiseki_relation_activate(): void {
	kiseki_relation_ensure_capabilities();
	$store = new Kiseki_Relation_Json_Store();
	$store->ensure_initialized();
}
register_activation_hook( __FILE__, 'kiseki_relation_activate' );

add_action(
	'init',
	function (): void {
		if ( get_option( 'kiseki_relation_caps_version' ) !== KISEKI_RELATION_VERSION ) {
			kiseki_relation_ensure_capabilities();
			update_option( 'kiseki_relation_caps_version', KISEKI_RELATION_VERSION, true );
			if ( function_exists( 'w3tc_flush_url' ) ) {
				w3tc_flush_url( home_url( '/' ) );
				w3tc_flush_url( home_url( '/relations/' ) );
			}
		}
	},
	5
);

$kiseki_relation_store = new Kiseki_Relation_Json_Store();
$kiseki_relation_rest  = new Kiseki_Relation_Rest_Controller( $kiseki_relation_store );
$kiseki_relation_ui    = new Kiseki_Relation_Admin_Frontend( $kiseki_relation_store );

$kiseki_relation_rest->register_hooks();
$kiseki_relation_ui->register_hooks();
