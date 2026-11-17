<?php
/**
 * Registers WP Admin Studio Menu (open to Editors & Administrators), CPT Relationship Meta Box,
 * Shortcode [kiseki_relation], and Gutenberg Block (kiseki/relation-graph).
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class Kiseki_Relation_Admin_Frontend {

	private Kiseki_Relation_Json_Store $store;
	private bool $viewer_enqueued = false;

	public function __construct( Kiseki_Relation_Json_Store $store ) {
		$this->store = $store;
	}

	public function register_hooks(): void {
		add_action( 'admin_menu', array( $this, 'register_admin_menu' ) );
		add_action( 'admin_enqueue_scripts', array( $this, 'enqueue_admin_assets' ) );
		add_action( 'add_meta_boxes', array( $this, 'register_cpt_meta_boxes' ) );
		add_shortcode( 'kiseki_relation', array( $this, 'render_shortcode' ) );
		add_action( 'init', array( $this, 'register_gutenberg_block' ) );
	}

	/**
	 * Registers top-level WP Admin menu accessible to BOTH Editors ('edit_others_posts') and Administrators.
	 */
	public function register_admin_menu(): void {
		$cap = current_user_can( KISEKI_RELATION_CAP ) ? KISEKI_RELATION_CAP : 'edit_others_posts';
		add_menu_page(
			'轨迹系列导力关系图谱',
			'轨迹关系图',
			$cap,
			'kiseki-relation-studio',
			array( $this, 'render_admin_studio_page' ),
			'dashicons-networking',
			28
		);
	}

	public function render_admin_studio_page(): void {
		if ( ! kiseki_relation_user_can_manage() ) {
			wp_die( esc_html__( '您没有访问轨迹关系图工作台的权限。', 'kiseki-relation-graph' ) );
		}
		echo '<div id="kiseki-relation-admin-root"></div>';
	}

	public function register_cpt_meta_boxes(): void {
		if ( ! kiseki_relation_user_can_manage() ) {
			return;
		}
		$screens = array_values(
			array_filter(
				array( 'dt_team', 'org', 'region' ),
				'post_type_exists'
			)
		);
		if ( empty( $screens ) ) {
			return;
		}
		add_meta_box(
			'kiseki-relation-cpt-box',
			'塞姆利亚导力关系图谱 · 关联节点与关系维护',
			array( $this, 'render_cpt_meta_box' ),
			$screens,
			'normal',
			'high'
		);
	}

	public function render_cpt_meta_box(): void {
		echo '<div id="kiseki-relation-metabox-root"></div>';
	}

	public function enqueue_admin_assets( string $hook_suffix ): void {
		if ( ! kiseki_relation_user_can_manage() ) {
			return;
		}

		$is_studio  = ( 'toplevel_page_kiseki-relation-studio' === $hook_suffix );
		$is_post_ed = in_array( $hook_suffix, array( 'post.php', 'post-new.php' ), true );

		if ( ! $is_studio && ! $is_post_ed ) {
			return;
		}

		if ( $is_post_ed ) {
			$screen = get_current_screen();
			if ( ! $screen || ! in_array( $screen->post_type, array( 'dt_team', 'org', 'region' ), true ) ) {
				return;
			}
		}

		wp_enqueue_media();

		$css_ver = file_exists( KISEKI_RELATION_PLUGIN_DIR . 'assets/admin.css' )
			? KISEKI_RELATION_VERSION . '.' . (string) filemtime( KISEKI_RELATION_PLUGIN_DIR . 'assets/admin.css' )
			: KISEKI_RELATION_VERSION;
		$js_ver  = file_exists( KISEKI_RELATION_PLUGIN_DIR . 'assets/admin.js' )
			? KISEKI_RELATION_VERSION . '.' . (string) filemtime( KISEKI_RELATION_PLUGIN_DIR . 'assets/admin.js' )
			: KISEKI_RELATION_VERSION;

		wp_enqueue_style(
			'kiseki-relation-admin',
			KISEKI_RELATION_PLUGIN_URL . 'assets/admin.css',
			array(),
			$css_ver
		);

		wp_enqueue_script(
			'kiseki-relation-admin',
			KISEKI_RELATION_PLUGIN_URL . 'assets/admin.js',
			array(),
			$js_ver,
			true
		);

		$user         = wp_get_current_user();
		$display_name = ( $user && ! empty( trim( (string) $user->display_name ) ) )
			? wp_strip_all_tags( (string) $user->display_name )
			: 'Editor';

		$boot = array(
			'restUrl'            => esc_url_raw( rest_url( 'kiseki-relation/v1' ) ),
			'nonce'              => wp_create_nonce( 'wp_rest' ),
			'currentUser'        => $display_name,
			'userRoles'          => $user ? array_values( (array) $user->roles ) : array(),
			'frontendPreviewUrl' => esc_url_raw( home_url( '/relations/' ) ),
		);

		if ( $is_post_ed ) {
			global $post;
			if ( $post instanceof WP_Post ) {
				$is_auto_draft       = ( 'auto-draft' === $post->post_status );
				$thumb               = get_the_post_thumbnail_url( $post->ID, 'thumbnail' );
				$clean_title         = $is_auto_draft
					? ''
					: wp_strip_all_tags( html_entity_decode( get_the_title( $post->ID ), ENT_QUOTES, 'UTF-8' ) );
				$clean_permalink     = $is_auto_draft
					? ''
					: esc_url_raw( (string) get_permalink( $post->ID ), array( 'http', 'https' ) );
				$boot['postContext'] = array(
					'postId'     => (int) $post->ID,
					'postTitle'  => $clean_title,
					'postType'   => sanitize_key( (string) $post->post_type ),
					'postStatus' => sanitize_key( (string) $post->post_status ),
					'permalink'  => $clean_permalink,
					'avatarUrl'  => $thumb ? esc_url_raw( (string) $thumb, array( 'http', 'https' ) ) : '',
				);
			}
		}

		wp_add_inline_script(
			'kiseki-relation-admin',
			'window.KisekiRelationAdminBoot = ' . wp_json_encode(
				$boot,
				JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT
			) . ';',
			'before'
		);
	}

	private function enqueue_viewer_assets(): void {
		if ( $this->viewer_enqueued ) {
			return;
		}
		$this->viewer_enqueued = true;

		$css_ver = file_exists( KISEKI_RELATION_PLUGIN_DIR . 'assets/viewer.css' )
			? KISEKI_RELATION_VERSION . '.' . (string) filemtime( KISEKI_RELATION_PLUGIN_DIR . 'assets/viewer.css' )
			: KISEKI_RELATION_VERSION;
		$js_ver  = file_exists( KISEKI_RELATION_PLUGIN_DIR . 'assets/viewer.js' )
			? KISEKI_RELATION_VERSION . '.' . (string) filemtime( KISEKI_RELATION_PLUGIN_DIR . 'assets/viewer.js' )
			: KISEKI_RELATION_VERSION;

		wp_enqueue_style(
			'kiseki-relation-viewer',
			KISEKI_RELATION_PLUGIN_URL . 'assets/viewer.css',
			array(),
			$css_ver
		);

		wp_enqueue_script(
			'kiseki-relation-viewer',
			KISEKI_RELATION_PLUGIN_URL . 'assets/viewer.js',
			array(),
			$js_ver,
			true
		);
	}

	/**
	 * Shortcode:
	 * [kiseki_relation mode="full" default_arc="kuro" default_tier="supporting" default_view="3d" focus="" focus_post_id="" height="82vh" full_url="/relations/"]
	 */
	public function render_shortcode( $atts = array() ): string {
		$atts = shortcode_atts(
			array(
				'mode'          => 'full',
				'default_arc'   => 'kuro',
				'default_tier'  => 'supporting',
				'default_view'  => '3d',
				'focus'         => '',
				'focus_post_id' => '',
				'height'        => '82vh',
				'full_url'      => '/relations/',
			),
			$atts,
			'kiseki_relation'
		);

		// Read manifest via wp_options / object cache without filesystem stat calls on cached/anonymous renders;
		// get_manifest() falls back to ensure_initialized() only when uninitialized.
		$manifest = $this->store->get_manifest();
		$this->enqueue_viewer_assets();

		$raw_full_url   = (string) $atts['full_url'];
		$resolved_full  = preg_match( '#^https?://#i', $raw_full_url ) ? $raw_full_url : home_url( $raw_full_url );

		$cfg = array(
			'dataUrl'          => esc_url_raw( (string) $manifest['fileUrl'], array( 'http', 'https' ) ),
			'mode'             => 'mini' === $atts['mode'] ? 'mini' : 'full',
			'defaultArc'       => sanitize_text_field( (string) $atts['default_arc'] ),
			'defaultTier'      => in_array( $atts['default_tier'], array( 'core', 'supporting', 'minor' ), true ) ? $atts['default_tier'] : 'supporting',
			'defaultView'      => '2d' === $atts['default_view'] ? '2d' : '3d',
			'height'           => sanitize_text_field( (string) $atts['height'] ),
			'fullGraphPageUrl' => esc_url_raw( $resolved_full, array( 'http', 'https' ) ),
		);

		if ( ! empty( $atts['focus'] ) ) {
			$cfg['focusNodeId'] = sanitize_text_field( (string) $atts['focus'] );
		}

		if ( 'current' === $atts['focus_post_id'] && get_the_ID() ) {
			$cfg['focusWpPostId'] = (int) get_the_ID();
		} elseif ( is_numeric( $atts['focus_post_id'] ) ) {
			$cfg['focusWpPostId'] = (int) $atts['focus_post_id'];
		}

		if ( is_user_logged_in() && kiseki_relation_user_can_manage() ) {
			$cfg['adminStudioUrl'] = esc_url_raw( admin_url( 'admin.php?page=kiseki-relation-studio' ), array( 'http', 'https' ) );
		}

		$json_attr = esc_attr( (string) wp_json_encode( $cfg, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES ) );
		return sprintf(
			'<div class="kiseki-relation-mount alignwide" data-config="%s" style="width:100%%;min-height:420px;"></div>',
			$json_attr
		);
	}

	/**
	 * Registers Gutenberg Block (kiseki/relation-graph) so Editors can insert the graph visually.
	 */
	public function register_gutenberg_block(): void {
		if ( ! function_exists( 'register_block_type' ) ) {
			return;
		}

		wp_register_script(
			'kiseki-relation-block-editor',
			false,
			array( 'wp-blocks', 'wp-element', 'wp-components', 'wp-block-editor' ),
			KISEKI_RELATION_VERSION,
			true
		);

		$editor_js = <<<'JS'
(function(wp) {
	if (!wp || !wp.blocks) return;
	var el = wp.element.createElement;
	var InspectorControls = wp.blockEditor.InspectorControls;
	var PanelBody = wp.components.PanelBody;
	var SelectControl = wp.components.SelectControl;
	var TextControl = wp.components.TextControl;

	wp.blocks.registerBlockType('kiseki/relation-graph', {
		title: '轨迹人物势力关系图 (Kiseki Graph)',
		icon: 'networking',
		category: 'widgets',
		attributes: {
			mode: { type: 'string', default: 'full' },
			default_arc: { type: 'string', default: 'kuro' },
			default_tier: { type: 'string', default: 'supporting' },
			default_view: { type: 'string', default: '3d' },
			focus: { type: 'string', default: '' },
			height: { type: 'string', default: '82vh' }
		},
		edit: function(props) {
			var a = props.attributes;
			return [
				el(InspectorControls, { key: 'ins' },
					el(PanelBody, { title: '关系图展示设置', initialOpen: true },
						el(SelectControl, {
							label: '展示模式',
							value: a.mode,
							options: [
								{ label: '完整交互图谱 (Full)', value: 'full' },
								{ label: '单角色精简卡片 (Mini)', value: 'mini' }
							],
							onChange: function(v) { props.setAttributes({ mode: v }); }
						}),
						el(SelectControl, {
							label: '默认作品层',
							value: a.default_arc,
							options: [
								{ label: '界之轨迹 (kai)', value: 'kai' },
								{ label: '黎之轨迹II (kuro2)', value: 'kuro2' },
								{ label: '黎之轨迹 (kuro)', value: 'kuro' },
								{ label: '闪/创之轨迹 (sen)', value: 'sen' },
								{ label: '零/碧之轨迹 (zero_ao)', value: 'zero_ao' },
								{ label: '空之轨迹 (sora)', value: 'sora' },
								{ label: '全系列总览 (all)', value: 'all' }
							],
							onChange: function(v) { props.setAttributes({ default_arc: v }); }
						}),
						el(SelectControl, {
							label: '默认角色精简度',
							value: a.default_tier,
							options: [
								{ label: '★ 核心主线 (core)', value: 'core' },
								{ label: '★★ 重要配角 (supporting)', value: 'supporting' },
								{ label: '★★★ 全量登场 (minor)', value: 'minor' }
							],
							onChange: function(v) { props.setAttributes({ default_tier: v }); }
						}),
						el(SelectControl, {
							label: '默认视图引擎',
							value: a.default_view,
							options: [
								{ label: '3D 星盘视图', value: '3d' },
								{ label: '2D 战术导力图', value: '2d' }
							],
							onChange: function(v) { props.setAttributes({ default_view: v }); }
						}),
						el(TextControl, {
							label: '默认聚焦节点 ID（可选，如 van-arkride）',
							value: a.focus,
							onChange: function(v) { props.setAttributes({ focus: v }); }
						}),
						el(TextControl, {
							label: '画布高度（如 82vh 或 520px）',
							value: a.height,
							onChange: function(v) { props.setAttributes({ height: v }); }
						})
					)
				),
				el('div', {
					key: 'preview',
					style: {
						padding: '24px',
						borderRadius: '12px',
						background: '#060913',
						color: '#38bdf8',
						border: '1px solid rgba(56,189,248,0.4)',
						textAlign: 'center'
					}
				}, '🌌 塞姆利亚导力关系图谱区块 · 模式: ' + a.mode + ' · 默认作品层: ' + a.default_arc + ' (' + a.default_view.toUpperCase() + ')')
			];
		},
		save: function() { return null; }
	});
})(window.wp);
JS;

		wp_add_inline_script( 'kiseki-relation-block-editor', $editor_js );

		register_block_type(
			'kiseki/relation-graph',
			array(
				'editor_script'   => 'kiseki-relation-block-editor',
				'render_callback' => array( $this, 'render_shortcode' ),
				'attributes'      => array(
					'mode'         => array( 'type' => 'string', 'default' => 'full' ),
					'default_arc'  => array( 'type' => 'string', 'default' => 'kuro' ),
					'default_tier' => array( 'type' => 'string', 'default' => 'supporting' ),
					'default_view' => array( 'type' => 'string', 'default' => '3d' ),
					'focus'        => array( 'type' => 'string', 'default' => '' ),
					'height'       => array( 'type' => 'string', 'default' => '82vh' ),
				),
			)
		);
	}
}
