<?php
/**
 * Plugin Name: Kiseki Demo CPTs & Fullwidth Layout Helper
 * Description: Registers dt_team (Character), org (Organization), and region (Nation/Region) CPTs for local WordPress testing.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

add_action(
	'init',
	function (): void {
		register_post_type(
			'dt_team',
			array(
				'labels'       => array(
					'name'          => '角色词条 (dt_team)',
					'singular_name' => '角色词条',
				),
				'public'       => true,
				'has_archive'  => true,
				'show_in_rest' => true,
				'rewrite'      => array( 'slug' => 'character' ),
				'supports'     => array( 'title', 'editor', 'excerpt', 'thumbnail' ),
				'menu_icon'    => 'dashicons-groups',
			)
		);

		register_post_type(
			'org',
			array(
				'labels'       => array(
					'name'          => '组织词条 (org)',
					'singular_name' => '组织词条',
				),
				'public'       => true,
				'has_archive'  => true,
				'show_in_rest' => true,
				'rewrite'      => array( 'slug' => 'org' ),
				'supports'     => array( 'title', 'editor', 'excerpt', 'thumbnail' ),
				'menu_icon'    => 'dashicons-shield',
			)
		);

		register_post_type(
			'region',
			array(
				'labels'       => array(
					'name'          => '国家地区 (region)',
					'singular_name' => '国家地区',
				),
				'public'       => true,
				'has_archive'  => true,
				'show_in_rest' => true,
				'rewrite'      => array( 'slug' => 'region' ),
				'supports'     => array( 'title', 'editor', 'excerpt', 'thumbnail' ),
				'menu_icon'    => 'dashicons-admin-site-alt3',
			)
		);
	},
	5
);

// Allow wide/full-bleed graph container inside default block themes (Twenty Twenty-Four / Twenty Twenty-Five)
add_action(
	'wp_head',
	function (): void {
		echo '<style>
			.entry-content > .kiseki-relation-mount,
			.wp-block-post-content > .kiseki-relation-mount {
				max-width: min(96vw, 1560px) !important;
				margin-left: auto !important;
				margin-right: auto !important;
			}
		</style>';
	}
);
