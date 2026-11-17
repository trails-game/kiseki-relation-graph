<?php
/**
 * WP REST API Controller for Kiseki Interactive Relationship Graph.
 * All /admin/* endpoints grant full access to both Editor and Administrator roles.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class Kiseki_Relation_Rest_Controller {

	private const NAMESPACE = 'kiseki-relation/v1';

	private const ENTITY_TYPES        = array( 'nation', 'organization', 'family', 'school', 'character' );
	private const IMPORTANCE_TIERS    = array( 'core', 'supporting', 'minor' );
	private const RELATION_CATEGORIES = array( 'membership', 'hierarchy', 'family', 'school', 'ally', 'romance', 'hostile' );
	private const DIRECTIONS          = array( 'directed', 'bidirectional' );
	private const STATUSES            = array( 'published', 'pending_review', 'draft' );

	/**
	 * Legacy relation.xlsx name variants -> canonical Chinese name map.
	 */
	private const LEGACY_CANONICAL_NAME_MAP = array(
		'ellen?'         => '卡拜德夫人',
		'静奈·蕾姆·御折木'      => '静名·蕾姆·御折木',
		'静名·雷姆·御折木'      => '静名·蕾姆·御折木',
		'金·瓦赛克'          => '阵·瓦赛克',
		'瓦鲁特'            => '瓦尔特·克隆',
		'瓦尔特·克伦'         => '瓦尔特·克隆',
		'巴克霍恩'           => '贝尔加德·哲曼',
		'范恩·阿克莱德'        => '范恩·亚克莱德',
		'菲莉·阿尔费德'        => '菲莉·阿尔法德',
		'结社'             => '噬身之蛇',
		'克洛斯贝尔独立州'       => '克洛斯贝尔自治州',
		'克洛斯贝尔'          => '克洛斯贝尔自治州',
		'特务支援科'          => '特务支援课',
		'托尔兹士官学校总校'      => '托尔兹军官学院',
		'托尔兹军官学校'        => '托尔兹军官学院',
		'托尔兹士官学校第Ⅱ分校'    => '托尔兹第Ⅱ分校',
		'帝都女子学院'         => '圣亚斯特莱亚女子学院',
		'莱恩福尔特(RF)集团'    => '莱恩福尔特社',
		'A·拉赛尔'          => '阿尔伯特·拉赛尔',
		'A·拉塞尔'          => '阿尔伯特·拉赛尔',
		'丹·拉塞尔'          => '丹·拉赛尔',
		'G·施密特'          => '格哈特·施密特',
		'F·诺华提斯'         => '弗朗茨·诺华提斯',
	);

	private const KNOWN_NATIONS = array(
		'卡尔瓦德共和国',
		'埃雷波尼亚帝国',
		'利贝尔王国',
		'克洛斯贝尔自治州',
		'艾尔萨姆公国',
		'奥雷德自治州',
		'亚尔特利亚法典国',
		'雷米菲利亚公国',
		'诺森比亚自治州',
	);

	private const KNOWN_SCHOOLS = array(
		'八叶一刀流',
		'泰斗流',
		'昆仑流',
		'月华流',
		'黑神一刀流',
		'范德尔流',
		'亚尔赛德流',
		'百式军刀术',
		'宫廷枪术',
		'骑马枪术',
		'许莱登流',
	);

	private Kiseki_Relation_Json_Store $store;

	public function __construct( Kiseki_Relation_Json_Store $store ) {
		$this->store = $store;
	}

	public function register_hooks(): void {
		add_action( 'rest_api_init', array( $this, 'register_routes' ) );
	}

	public function register_routes(): void {
		register_rest_route(
			self::NAMESPACE,
			'/graph',
			array(
				'methods'             => WP_REST_Server::READABLE,
				'callback'            => array( $this, 'get_public_graph' ),
				'permission_callback' => '__return_true',
			)
		);

		register_rest_route(
			self::NAMESPACE,
			'/admin/state',
			array(
				'methods'             => WP_REST_Server::READABLE,
				'callback'            => array( $this, 'get_admin_state' ),
				'permission_callback' => 'kiseki_relation_user_can_manage',
			)
		);

		register_rest_route(
			self::NAMESPACE,
			'/admin/patch',
			array(
				'methods'             => WP_REST_Server::CREATABLE,
				'callback'            => array( $this, 'post_admin_patch' ),
				'permission_callback' => 'kiseki_relation_user_can_manage',
			)
		);

		register_rest_route(
			self::NAMESPACE,
			'/admin/import',
			array(
				'methods'             => WP_REST_Server::CREATABLE,
				'callback'            => array( $this, 'post_admin_import' ),
				'permission_callback' => 'kiseki_relation_user_can_manage',
			)
		);

		register_rest_route(
			self::NAMESPACE,
			'/admin/restore',
			array(
				'methods'             => WP_REST_Server::CREATABLE,
				'callback'            => array( $this, 'post_admin_restore' ),
				'permission_callback' => 'kiseki_relation_user_can_manage',
			)
		);

		register_rest_route(
			self::NAMESPACE,
			'/admin/wp-search',
			array(
				'methods'             => WP_REST_Server::READABLE,
				'callback'            => array( $this, 'get_wp_post_search' ),
				'permission_callback' => 'kiseki_relation_user_can_manage',
			)
		);
	}

	public function get_public_graph(): WP_REST_Response {
		$response = new WP_REST_Response( $this->store->read_dataset(), 200 );
		$response->header( 'Cache-Control', 'public, max-age=300' );
		return $response;
	}

	public function get_admin_state(): WP_REST_Response {
		return new WP_REST_Response(
			array(
				'dataset'  => $this->store->read_dataset(),
				'manifest' => $this->store->get_manifest(),
				'backups'  => $this->store->list_backups(),
			),
			200
		);
	}

	private function resolve_actor(): array {
		$user         = wp_get_current_user();
		$user_id      = ( $user && $user->ID ) ? (int) $user->ID : 0;
		$display_name = ( $user && ! empty( trim( (string) $user->display_name ) ) )
			? wp_strip_all_tags( trim( (string) $user->display_name ) )
			: 'Editor';

		return array(
			'userId'      => $user_id,
			'displayName' => $display_name,
		);
	}

	private function extract_base_version( array $params ): ?int {
		if ( ! isset( $params['baseVersion'] ) || null === $params['baseVersion'] || '' === $params['baseVersion'] ) {
			return null;
		}
		if ( ! is_numeric( $params['baseVersion'] ) || (int) $params['baseVersion'] < 1 ) {
			throw new InvalidArgumentException( '非法的 baseVersion 参数。' );
		}
		return (int) $params['baseVersion'];
	}

	public function post_admin_patch( WP_REST_Request $request ): WP_REST_Response {
		$params = $request->get_json_params();
		if ( ! is_array( $params ) ) {
			$params = array();
		}
		$action  = isset( $params['action'] ) ? sanitize_key( (string) $params['action'] ) : '';
		$summary = isset( $params['summary'] ) ? sanitize_text_field( (string) $params['summary'] ) : $action;
		$actor   = $this->resolve_actor();

		try {
			$base_version     = $this->extract_base_version( $params );
			$touched_post_ids = array();

			$result = $this->store->mutate_and_publish(
				function ( array $dataset ) use ( $action, $params, &$touched_post_ids ): array {
					switch ( $action ) {
						case 'upsert_relation':
							if ( ! isset( $params['relation'] ) || ! is_array( $params['relation'] ) ) {
								throw new InvalidArgumentException( '关系数据不完整。' );
							}
							$rel   = $this->sanitize_relation( $params['relation'] );
							$found = false;
							foreach ( $dataset['relations'] as $idx => $existing ) {
								if ( ( $existing['id'] ?? '' ) === $rel['id'] ) {
									$dataset['relations'][ $idx ] = $rel;
									$found                        = true;
									break;
								}
							}
							if ( ! $found ) {
								$dataset['relations'][] = $rel;
							}

							$ensure = $params['ensureEntityArcs'] ?? array();
							if ( is_array( $ensure ) && ! empty( $ensure ) ) {
								foreach ( $dataset['entities'] as $eidx => $ent ) {
									$ent_id = (string) ( $ent['id'] ?? '' );
									if ( $ent_id === $rel['source'] || $ent_id === $rel['target'] ) {
										if ( ! empty( $ent['wpPostId'] ) ) {
											$touched_post_ids[] = (int) $ent['wpPostId'];
										}
									}
									foreach ( $ensure as $pair ) {
										if ( ! is_array( $pair ) ) {
											continue;
										}
										$pair_eid = $this->sanitize_optional_id( $pair['entityId'] ?? '' );
										$pair_aid = $this->sanitize_optional_id( $pair['arcId'] ?? '' );
										if ( '' !== $pair_eid && $pair_eid === $ent_id && '' !== $pair_aid ) {
											$arcs = isset( $ent['arcs'] ) && is_array( $ent['arcs'] ) ? $ent['arcs'] : array();
											if ( ! in_array( $pair_aid, $arcs, true ) ) {
												$arcs[]                               = $pair_aid;
												$dataset['entities'][ $eidx ]['arcs'] = array_values( $arcs );
											}
										}
									}
								}
							}
							break;

						case 'delete_relation':
							$rid = $this->sanitize_slug_id( $params['relationId'] ?? '', 'relationId' );
							$dataset['relations'] = array_values(
								array_filter(
									$dataset['relations'],
									static fn( array $r ): bool => ( $r['id'] ?? '' ) !== $rid
								)
							);
							foreach ( $dataset['relations'] as $idx => $r ) {
								if ( ( $r['supersedesId'] ?? '' ) === $rid ) {
									unset( $dataset['relations'][ $idx ]['supersedesId'] );
								}
							}
							break;

						case 'upsert_entity':
							if ( ! isset( $params['entity'] ) || ! is_array( $params['entity'] ) ) {
								throw new InvalidArgumentException( '实体 ID 与名称不能为空。' );
							}
							$ent = $this->sanitize_entity( $params['entity'], true );
							if ( ! empty( $ent['wpPostId'] ) ) {
								$touched_post_ids[] = (int) $ent['wpPostId'];
							}
							$found = false;
							foreach ( $dataset['entities'] as $idx => $existing ) {
								if ( ( $existing['id'] ?? '' ) === $ent['id'] ) {
									if ( ! empty( $existing['wpPostId'] ) ) {
										$touched_post_ids[] = (int) $existing['wpPostId'];
									}
									$dataset['entities'][ $idx ] = $ent;
									$found                       = true;
									break;
								}
							}
							if ( ! $found ) {
								$dataset['entities'][] = $ent;
							}
							break;

						case 'delete_entity':
							$eid = $this->sanitize_slug_id( $params['entityId'] ?? '', 'entityId' );
							foreach ( $dataset['entities'] as $existing ) {
								if ( ( $existing['id'] ?? '' ) === $eid && ! empty( $existing['wpPostId'] ) ) {
									$touched_post_ids[] = (int) $existing['wpPostId'];
								}
							}
							$dataset['entities'] = array_values(
								array_filter(
									$dataset['entities'],
									static fn( array $e ): bool => ( $e['id'] ?? '' ) !== $eid
								)
							);
							// Clean dangling entity references (nationId, defaultGroupId, primaryGroupId)
							foreach ( $dataset['entities'] as $eidx => $e ) {
								if ( ( $e['nationId'] ?? '' ) === $eid ) {
									unset( $dataset['entities'][ $eidx ]['nationId'] );
								}
								if ( ( $e['defaultGroupId'] ?? '' ) === $eid ) {
									unset( $dataset['entities'][ $eidx ]['defaultGroupId'] );
								}
								if ( ! empty( $e['arcOverrides'] ) && is_array( $e['arcOverrides'] ) ) {
									foreach ( $e['arcOverrides'] as $ak => $ov ) {
										if ( is_array( $ov ) && ( $ov['primaryGroupId'] ?? '' ) === $eid ) {
											unset( $dataset['entities'][ $eidx ]['arcOverrides'][ $ak ]['primaryGroupId'] );
										}
									}
								}
							}

							$removed_rel_ids      = array();
							$dataset['relations'] = array_values(
								array_filter(
									$dataset['relations'],
									static function ( array $r ) use ( $eid, &$removed_rel_ids ): bool {
										if ( ( $r['source'] ?? '' ) === $eid || ( $r['target'] ?? '' ) === $eid ) {
											if ( ! empty( $r['id'] ) ) {
												$removed_rel_ids[ (string) $r['id'] ] = true;
											}
											return false;
										}
										return true;
									}
								)
							);
							if ( ! empty( $removed_rel_ids ) ) {
								foreach ( $dataset['relations'] as $ridx => $r ) {
									$sup = (string) ( $r['supersedesId'] ?? '' );
									if ( '' !== $sup && isset( $removed_rel_ids[ $sup ] ) ) {
										unset( $dataset['relations'][ $ridx ]['supersedesId'] );
									}
								}
							}
							break;

						case 'upsert_arc':
							if ( ! isset( $params['arc'] ) || ! is_array( $params['arc'] ) ) {
								throw new InvalidArgumentException( '作品层数据不完整。' );
							}
							$arc   = $this->sanitize_arc( $params['arc'] );
							$found = false;
							foreach ( $dataset['arcs'] as $idx => $existing ) {
								if ( ( $existing['id'] ?? '' ) === $arc['id'] ) {
									$dataset['arcs'][ $idx ] = $arc;
									$found                   = true;
									break;
								}
							}
							if ( ! $found ) {
								$dataset['arcs'][] = $arc;
							}
							usort(
								$dataset['arcs'],
								static fn( array $a, array $b ): int => ( (int) ( $a['order'] ?? 0 ) ) <=> ( (int) ( $b['order'] ?? 0 ) )
							);
							break;

						case 'delete_arc':
							$raw_aid = $params['arcId'] ?? ( $params['id'] ?? '' );
							$aid     = $this->sanitize_slug_id( $raw_aid, 'arcId' );

							$before_count    = count( $dataset['arcs'] );
							$dataset['arcs'] = array_values(
								array_filter(
									$dataset['arcs'],
									static fn( array $a ): bool => ( $a['id'] ?? '' ) !== $aid
								)
							);
							if ( count( $dataset['arcs'] ) === $before_count ) {
								throw new InvalidArgumentException( '未找到要删除的作品层：' . $aid );
							}
							if ( empty( $dataset['arcs'] ) ) {
								throw new InvalidArgumentException( '至少需要保留一个作品层，无法删除最后一个作品层。' );
							}

							foreach ( $dataset['entities'] as $eidx => $ent ) {
								if ( ! empty( $ent['arcs'] ) && is_array( $ent['arcs'] ) ) {
									$dataset['entities'][ $eidx ]['arcs'] = array_values(
										array_filter(
											$ent['arcs'],
											static fn( $x ): bool => (string) $x !== $aid
										)
									);
								}
								if ( isset( $ent['arcOverrides'][ $aid ] ) ) {
									unset( $dataset['entities'][ $eidx ]['arcOverrides'][ $aid ] );
									if ( empty( $dataset['entities'][ $eidx ]['arcOverrides'] ) ) {
										unset( $dataset['entities'][ $eidx ]['arcOverrides'] );
									}
								}
							}

							$removed_rel_ids = array();
							$kept_relations  = array();
							foreach ( $dataset['relations'] as $rel ) {
								$rarcs = isset( $rel['arcs'] ) && is_array( $rel['arcs'] )
									? array_values( array_filter( $rel['arcs'], static fn( $x ): bool => (string) $x !== $aid ) )
									: array();
								if ( empty( $rarcs ) ) {
									if ( ! empty( $rel['id'] ) ) {
										$removed_rel_ids[ (string) $rel['id'] ] = true;
									}
									continue;
								}
								$rel['arcs']      = $rarcs;
								$kept_relations[] = $rel;
							}
							if ( ! empty( $removed_rel_ids ) ) {
								foreach ( $kept_relations as $ridx => $rel ) {
									$sup = (string) ( $rel['supersedesId'] ?? '' );
									if ( '' !== $sup && isset( $removed_rel_ids[ $sup ] ) ) {
										unset( $kept_relations[ $ridx ]['supersedesId'] );
									}
								}
							}
							$dataset['relations'] = $kept_relations;
							break;

						case 'republish':
							break;

						default:
							throw new InvalidArgumentException( '未知的 patch 操作类型：' . $action );
					}
					return $dataset;
				},
				$actor,
				$base_version,
				$summary,
				$touched_post_ids
			);

			return new WP_REST_Response( $result, 200 );
		} catch ( Kiseki_Relation_Conflict_Exception $e ) {
			return new WP_REST_Response(
				array(
					'code'           => 'version_conflict',
					'message'        => $e->getMessage(),
					'currentVersion' => $e->getCode(),
				),
				409
			);
		} catch ( Throwable $e ) {
			return new WP_REST_Response( array( 'message' => $e->getMessage() ), 400 );
		}
	}

	public function post_admin_import( WP_REST_Request $request ): WP_REST_Response {
		$params = $request->get_json_params();
		if ( ! is_array( $params ) ) {
			$params = array();
		}
		$mode       = ( $params['mode'] ?? 'merge' ) === 'replace' ? 'replace' : 'merge';
		$raw_format = strtolower( trim( (string) ( $params['format'] ?? 'json' ) ) );
		$content    = (string) ( $params['content'] ?? '' );
		$actor      = $this->resolve_actor();
		$summary    = isset( $params['summary'] ) && '' !== trim( (string) $params['summary'] )
			? sanitize_text_field( (string) $params['summary'] )
			: sprintf( '批量导入 (%s / %s)', strtoupper( $raw_format ), $mode );

		try {
			if ( ! in_array( $raw_format, array( 'json', 'csv', 'xlsx' ), true ) ) {
				throw new InvalidArgumentException( '不支持的导入格式：' . $raw_format );
			}
			if ( '' === trim( $content ) ) {
				throw new InvalidArgumentException( '导入内容不能为空。' );
			}
			$base_version = $this->extract_base_version( $params );

			$result = $this->store->mutate_and_publish(
				function ( array $dataset ) use ( $mode, $raw_format, $content ): array {
					if ( 'json' === $raw_format ) {
						return $this->apply_json_import( $dataset, $content, $mode );
					}
					if ( 'csv' === $raw_format ) {
						return $this->apply_csv_import( $dataset, $content, $mode );
					}
					return $this->apply_xlsx_import( $dataset, $content, $mode );
				},
				$actor,
				$base_version,
				$summary
			);

			return new WP_REST_Response( $result, 200 );
		} catch ( Kiseki_Relation_Conflict_Exception $e ) {
			return new WP_REST_Response(
				array(
					'code'           => 'version_conflict',
					'message'        => $e->getMessage(),
					'currentVersion' => $e->getCode(),
				),
				409
			);
		} catch ( Throwable $e ) {
			return new WP_REST_Response( array( 'message' => $e->getMessage() ), 400 );
		}
	}

	public function post_admin_restore( WP_REST_Request $request ): WP_REST_Response {
		$params = $request->get_json_params();
		if ( ! is_array( $params ) ) {
			$params = array();
		}
		$file  = (string) ( $params['backupFile'] ?? '' );
		$actor = $this->resolve_actor();

		try {
			$base_version = $this->extract_base_version( $params );
			$result       = $this->store->restore_backup( $file, $actor, $base_version );
			return new WP_REST_Response( $result, 200 );
		} catch ( Kiseki_Relation_Conflict_Exception $e ) {
			return new WP_REST_Response(
				array(
					'code'           => 'version_conflict',
					'message'        => $e->getMessage(),
					'currentVersion' => $e->getCode(),
				),
				409
			);
		} catch ( Throwable $e ) {
			return new WP_REST_Response( array( 'message' => $e->getMessage() ), 400 );
		}
	}

	/**
	 * Searches PUBLISHED WordPress wiki posts (dt_team, org, region, page, post) to auto-link
	 * permalink and Featured Image avatar into a graph node without leaking draft/private content.
	 */
	public function get_wp_post_search( WP_REST_Request $request ): WP_REST_Response {
		$q = sanitize_text_field( (string) $request->get_param( 'q' ) );
		if ( '' === $q ) {
			return new WP_REST_Response( array(), 200 );
		}

		$candidate_types = array( 'dt_team', 'org', 'region', 'page', 'post' );
		$active_types    = array_values( array_filter( $candidate_types, 'post_type_exists' ) );
		if ( empty( $active_types ) ) {
			return new WP_REST_Response( array(), 200 );
		}

		$query = new WP_Query(
			array(
				'post_type'      => $active_types,
				'post_status'    => 'publish',
				's'              => $q,
				'posts_per_page' => 12,
				'no_found_rows'  => true,
			)
		);

		$hits = array();
		foreach ( $query->posts as $p ) {
			$thumb = get_the_post_thumbnail_url( $p->ID, 'thumbnail' );
			if ( ! $thumb ) {
				$thumb = get_the_post_thumbnail_url( $p->ID, 'medium' );
			}
			$hits[] = array(
				'id'        => (int) $p->ID,
				'postType'  => sanitize_key( (string) $p->post_type ),
				'title'     => wp_strip_all_tags( html_entity_decode( get_the_title( $p->ID ), ENT_QUOTES, 'UTF-8' ) ),
				'link'      => esc_url_raw( (string) get_permalink( $p->ID ), array( 'http', 'https' ) ),
				'avatarUrl' => $thumb ? esc_url_raw( (string) $thumb, array( 'http', 'https' ) ) : '',
				'excerpt'   => wp_trim_words( wp_strip_all_tags( $p->post_excerpt ?: $p->post_content ), 40 ),
			);
		}

		return new WP_REST_Response( $hits, 200 );
	}

	/* ==========================================================================
	 * Import Handlers (JSON / CSV / .xlsx via ZipArchive + SimpleXMLElement)
	 * ========================================================================== */

	private function apply_json_import( array $dataset, string $content, string $mode ): array {
		$incoming = json_decode( $content, true );
		if ( ! is_array( $incoming ) ) {
			throw new InvalidArgumentException( 'JSON 格式解析失败。' );
		}

		if ( 'replace' === $mode ) {
			if (
				! isset( $incoming['arcs'], $incoming['entities'], $incoming['relations'] )
				|| ! is_array( $incoming['arcs'] )
				|| ! is_array( $incoming['entities'] )
				|| ! is_array( $incoming['relations'] )
			) {
				throw new InvalidArgumentException( '全量替换 JSON 必须同时包含 arcs、entities、relations 数组。' );
			}
			$clean_arcs = array();
			foreach ( $incoming['arcs'] as $a ) {
				if ( ! is_array( $a ) ) {
					throw new InvalidArgumentException( 'arcs 包含非对象元素。' );
				}
				$clean_arcs[] = $this->sanitize_arc( $a );
			}
			usort(
				$clean_arcs,
				static fn( array $a, array $b ): int => ( (int) $a['order'] ) <=> ( (int) $b['order'] )
			);

			$clean_entities = array();
			foreach ( $incoming['entities'] as $e ) {
				if ( ! is_array( $e ) ) {
					throw new InvalidArgumentException( 'entities 包含非对象元素。' );
				}
				$clean_entities[] = $this->sanitize_entity( $e, true );
			}

			$clean_relations = array();
			foreach ( $incoming['relations'] as $r ) {
				if ( ! is_array( $r ) ) {
					throw new InvalidArgumentException( 'relations 包含非对象元素。' );
				}
				$clean_relations[] = $this->sanitize_relation( $r );
			}

			return array(
				'schemaVersion' => 1,
				'version'       => $dataset['version'] ?? 1,
				'updatedAt'     => $dataset['updatedAt'] ?? gmdate( 'Y-m-d\TH:i:s\Z' ),
				'arcs'          => $clean_arcs,
				'entities'      => $clean_entities,
				'relations'     => $clean_relations,
			);
		}

		// Merge mode: validate and merge arcs, entities, relations by ID
		$has_any_bucket = false;
		if ( isset( $incoming['arcs'] ) ) {
			if ( ! is_array( $incoming['arcs'] ) ) {
				throw new InvalidArgumentException( 'arcs 字段必须是数组。' );
			}
			$has_any_bucket = true;
			$map            = array();
			foreach ( $dataset['arcs'] as $item ) {
				$map[ $item['id'] ] = $item;
			}
			foreach ( $incoming['arcs'] as $raw_arc ) {
				if ( ! is_array( $raw_arc ) ) {
					throw new InvalidArgumentException( 'arcs 包含无效元素。' );
				}
				$clean               = $this->sanitize_arc( $raw_arc );
				$map[ $clean['id'] ] = $clean;
			}
			$merged_arcs = array_values( $map );
			usort(
				$merged_arcs,
				static fn( array $a, array $b ): int => ( (int) ( $a['order'] ?? 0 ) ) <=> ( (int) ( $b['order'] ?? 0 ) )
			);
			$dataset['arcs'] = $merged_arcs;
		}

		if ( isset( $incoming['entities'] ) ) {
			if ( ! is_array( $incoming['entities'] ) ) {
				throw new InvalidArgumentException( 'entities 字段必须是数组。' );
			}
			$has_any_bucket = true;
			$map            = array();
			foreach ( $dataset['entities'] as $item ) {
				$map[ $item['id'] ] = $item;
			}
			foreach ( $incoming['entities'] as $raw_ent ) {
				if ( ! is_array( $raw_ent ) ) {
					throw new InvalidArgumentException( 'entities 包含无效元素。' );
				}
				$clean               = $this->sanitize_entity( $raw_ent, true );
				$map[ $clean['id'] ] = $clean;
			}
			$dataset['entities'] = array_values( $map );
		}

		if ( isset( $incoming['relations'] ) ) {
			if ( ! is_array( $incoming['relations'] ) ) {
				throw new InvalidArgumentException( 'relations 字段必须是数组。' );
			}
			$has_any_bucket = true;
			$map            = array();
			foreach ( $dataset['relations'] as $item ) {
				$map[ $item['id'] ] = $item;
			}
			foreach ( $incoming['relations'] as $raw_rel ) {
				if ( ! is_array( $raw_rel ) ) {
					throw new InvalidArgumentException( 'relations 包含无效元素。' );
				}
				$clean               = $this->sanitize_relation( $raw_rel );
				$map[ $clean['id'] ] = $clean;
			}
			$dataset['relations'] = array_values( $map );
		}

		if ( ! $has_any_bucket ) {
			throw new InvalidArgumentException( '导入的 JSON 不包含 arcs、entities 或 relations 数据。' );
		}

		return $dataset;
	}

	private function apply_csv_import( array $dataset, string $content, string $mode ): array {
		$clean_csv = trim( (string) preg_replace( '/^\xEF\xBB\xBF/', '', $content ) );
		$lines     = preg_split( '/\r\n|\r|\n/', $clean_csv );
		if ( ! $lines || count( $lines ) < 2 ) {
			throw new InvalidArgumentException( 'CSV 内容为空或缺少数据行。' );
		}

		$raw_headers = str_getcsv( (string) array_shift( $lines ) );
		$headers     = array_map( static fn( $h ): string => trim( (string) $h ), $raw_headers );

		// Support Entity CSV import if headers describe entities (canonicalName / entityType without source/target)
		$is_entity_csv = ( in_array( 'canonicalName', $headers, true ) || in_array( 'entityType', $headers, true ) )
			&& ! in_array( 'source', $headers, true )
			&& ! in_array( 'target', $headers, true );

		if ( $is_entity_csv ) {
			$ent_map = array();
			if ( 'merge' === $mode ) {
				foreach ( $dataset['entities'] as $e ) {
					$ent_map[ $e['id'] ] = $e;
				}
			}
			$imported_count = 0;
			foreach ( $lines as $line ) {
				if ( '' === trim( $line ) ) {
					continue;
				}
				$cols = str_getcsv( $line );
				$row  = array();
				foreach ( $headers as $h_idx => $h_name ) {
					if ( '' !== $h_name ) {
						$row[ $h_name ] = isset( $cols[ $h_idx ] ) ? trim( (string) $cols[ $h_idx ] ) : '';
					}
				}
				$cname = $row['canonicalName'] ?? ( $row['name'] ?? '' );
				if ( '' === $cname ) {
					continue;
				}
				$eid  = ! empty( $row['id'] ) ? $row['id'] : 'ent-csv-' . substr( md5( $cname ), 0, 10 );
				$arcs = ! empty( $row['arcs'] )
					? array_values( array_filter( array_map( 'trim', (array) preg_split( '/[|,]/', $row['arcs'] ) ) ) )
					: array( 'kuro' );

				$raw_ent = array(
					'id'               => $eid,
					'canonicalName'    => $cname,
					'entityType'       => ! empty( $row['entityType'] ) ? $row['entityType'] : 'character',
					'importance'       => ! empty( $row['importance'] ) ? $row['importance'] : 'supporting',
					'arcs'             => $arcs,
					'bio'              => $row['bio'] ?? '',
					'nameEn'           => $row['nameEn'] ?? '',
					'defaultTitle'     => $row['defaultTitle'] ?? '',
					'nationId'         => $row['nationId'] ?? '',
					'defaultGroupId'   => $row['defaultGroupId'] ?? '',
					'defaultAvatarUrl' => $row['defaultAvatarUrl'] ?? '',
					'wikiUrl'          => $row['wikiUrl'] ?? '',
				);
				if ( ! empty( $row['wpPostId'] ) && is_numeric( $row['wpPostId'] ) ) {
					$raw_ent['wpPostId'] = (int) $row['wpPostId'];
				}
				$clean_ent                   = $this->sanitize_entity( $raw_ent, true );
				$ent_map[ $clean_ent['id'] ] = $clean_ent;
				++$imported_count;
			}
			if ( 0 === $imported_count ) {
				throw new InvalidArgumentException( '实体 CSV 未包含有效的数据行。' );
			}
			$dataset['entities'] = array_values( $ent_map );
			return $dataset;
		}

		// Relation CSV: id,source,sourceName,target,targetName,category,label,direction,arcs,supersedesId,status,weight,note
		$name_to_id = $this->build_entity_lookup_map( $dataset['entities'] );
		$rel_map    = array();
		if ( 'merge' === $mode ) {
			foreach ( $dataset['relations'] as $r ) {
				$rel_map[ $r['id'] ] = $r;
			}
		}

		$imported_count = 0;
		foreach ( $lines as $line ) {
			if ( '' === trim( $line ) ) {
				continue;
			}
			$cols = str_getcsv( $line );
			$row  = array();
			foreach ( $headers as $h_idx => $h_name ) {
				if ( '' !== $h_name ) {
					$row[ $h_name ] = isset( $cols[ $h_idx ] ) ? trim( (string) $cols[ $h_idx ] ) : '';
				}
			}

			$raw_src   = $row['source'] ?? '';
			$raw_tgt   = $row['target'] ?? '';
			$raw_label = $row['label'] ?? ( $row['Relation'] ?? '' );
			if ( '' === $raw_src || '' === $raw_tgt || '' === $raw_label ) {
				continue;
			}

			$norm_src  = $this->normalize_entity_name( $raw_src );
			$norm_tgt  = $this->normalize_entity_name( $raw_tgt );
			$source_id = $name_to_id[ $raw_src ] ?? ( $name_to_id[ $norm_src ] ?? $raw_src );
			$target_id = $name_to_id[ $raw_tgt ] ?? ( $name_to_id[ $norm_tgt ] ?? $raw_tgt );

			$arcs = ! empty( $row['arcs'] )
				? array_values( array_filter( array_map( 'trim', (array) preg_split( '/[|,]/', $row['arcs'] ) ) ) )
				: array( 'kuro' );
			if ( empty( $arcs ) ) {
				$arcs = array( 'kuro' );
			}

			$category  = ! empty( $row['category'] ) ? $row['category'] : 'ally';
			$direction = ! empty( $row['direction'] ) ? $row['direction'] : 'bidirectional';
			$status    = ! empty( $row['status'] ) ? $row['status'] : 'published';
			$weight    = ( isset( $row['weight'] ) && '' !== $row['weight'] && is_numeric( $row['weight'] ) )
				? (int) $row['weight']
				: 3;

			$sorted_arcs = $arcs;
			sort( $sorted_arcs );
			$hash_input = implode(
				'|',
				array(
					$source_id,
					$target_id,
					$category,
					$raw_label,
					implode( ',', $sorted_arcs ),
				)
			);
			$rid = ! empty( $row['id'] )
				? $row['id']
				: 'rel-csv-' . substr( md5( $hash_input ), 0, 10 );

			$raw_rel = array(
				'id'        => $rid,
				'source'    => $source_id,
				'target'    => $target_id,
				'category'  => $category,
				'label'     => $raw_label,
				'direction' => $direction,
				'weight'    => $weight,
				'arcs'      => $arcs,
				'status'    => $status,
			);
			if ( ! empty( $row['supersedesId'] ) ) {
				$raw_rel['supersedesId'] = $row['supersedesId'];
			}
			if ( ! empty( $row['note'] ) ) {
				$raw_rel['note'] = $row['note'];
			}

			$clean_rel                   = $this->sanitize_relation( $raw_rel );
			$rel_map[ $clean_rel['id'] ] = $clean_rel;
			++$imported_count;
		}

		if ( 0 === $imported_count ) {
			throw new InvalidArgumentException( 'CSV 未包含任何有效的关系数据行（需包含 source、target、label 列）。' );
		}

		$dataset['relations'] = array_values( $rel_map );
		return $dataset;
	}

	/**
	 * Parses base64-encoded .xlsx workbook (supporting legacy relation.xlsx `角色` + `人物组织关系` + `抽卡`
	 * sheets as well as modern Entities / Relations sheets) via PHP ZipArchive + SimpleXMLElement.
	 */
	private function apply_xlsx_import( array $dataset, string $content, string $mode ): array {
		if ( ! class_exists( 'ZipArchive' ) || ! class_exists( 'SimpleXMLElement' ) ) {
			throw new RuntimeException( '当前 PHP 环境未启用 ZipArchive 或 SimpleXML 扩展，无法解析 .xlsx。' );
		}

		$b64 = trim( $content );
		if ( str_contains( $b64, ',' ) && preg_match( '/^data:[^;]*;base64,(.+)$/is', $b64, $m ) ) {
			$b64 = $m[1];
		}
		$b64    = (string) preg_replace( '/\s+/', '', $b64 );
		$binary = base64_decode( $b64, true );
		if ( false === $binary || strlen( $binary ) < 64 ) {
			throw new InvalidArgumentException( '.xlsx 文件 Base64 解码失败或内容损坏。' );
		}
		if ( strlen( $binary ) > 15 * 1024 * 1024 ) {
			throw new InvalidArgumentException( '.xlsx 文件大小超过 15MB 限制。' );
		}

		$tmp_xlsx = trailingslashit( get_temp_dir() ) . 'kiseki-import-' . getmypid() . '-' . uniqid( '', true ) . '.xlsx';
		if ( false === @file_put_contents( $tmp_xlsx, $binary ) ) {
			throw new RuntimeException( '无法创建用于解析 .xlsx 的临时文件。' );
		}

		try {
			$sheets = $this->read_xlsx_workbook_sheets( $tmp_xlsx );
		} finally {
			@unlink( $tmp_xlsx );
		}

		$char_rows  = $sheets['角色'] ?? ( $sheets['Entities'] ?? ( $sheets['实体'] ?? array() ) );
		$rel_rows   = $sheets['人物组织关系'] ?? ( $sheets['Relations'] ?? ( $sheets['关系'] ?? array() ) );
		$gacha_rows = $sheets['抽卡'] ?? array();

		if ( empty( $char_rows ) && empty( $rel_rows ) ) {
			throw new InvalidArgumentException( '.xlsx 中未找到「角色」或「人物组织关系」工作表数据。' );
		}

		// Optional fallback avatars from legacy 抽卡 sheet
		$gacha_avatars = array();
		foreach ( $gacha_rows as $grow ) {
			$gname = $this->normalize_entity_name( $grow['name'] ?? '' );
			$gurl  = trim( (string) ( $grow['url'] ?? '' ) );
			if ( '' !== $gname && '' !== $gurl ) {
				$clean_gurl = $this->sanitize_http_url( $gurl, 'gacha.url', false );
				if ( '' !== $clean_gurl ) {
					$gacha_avatars[ $gname ] = $clean_gurl;
				}
			}
		}

		$ent_map = array();
		if ( 'merge' === $mode ) {
			foreach ( $dataset['entities'] as $e ) {
				$ent_map[ $e['id'] ] = $e;
			}
		}
		$name_to_id = $this->build_entity_lookup_map( array_values( $ent_map ) );

		// 1. Parse `角色` / `Entities` sheet
		foreach ( $char_rows as $crow ) {
			$raw_name = trim( (string) ( $crow['canonicalName'] ?? ( $crow['name'] ?? '' ) ) );
			if ( '' === $raw_name ) {
				continue;
			}
			$canon_name = $this->normalize_entity_name( $raw_name );
			$matched_id = '';
			if ( ! empty( $crow['id'] ) ) {
				$matched_id = trim( (string) $crow['id'] );
			} elseif ( isset( $name_to_id[ $canon_name ] ) ) {
				$matched_id = $name_to_id[ $canon_name ];
			} elseif ( isset( $name_to_id[ $raw_name ] ) ) {
				$matched_id = $name_to_id[ $raw_name ];
			} else {
				$matched_id = 'xlsx-' . substr( md5( $canon_name ), 0, 10 );
			}

			$existing = $ent_map[ $matched_id ] ?? null;

			$raw_type = trim( (string) ( $crow['entityType'] ?? ( $crow['type'] ?? '' ) ) );
			$etype    = $existing['entityType'] ?? $this->map_xlsx_entity_type( $raw_type, $canon_name );

			$raw_avatar = trim( (string) ( $crow['defaultAvatarUrl'] ?? ( $crow['avatar'] ?? '' ) ) );
			$avatar_url = $this->sanitize_http_url( $raw_avatar, 'avatar', false );
			if ( '' === $avatar_url && isset( $gacha_avatars[ $canon_name ] ) ) {
				$avatar_url = $gacha_avatars[ $canon_name ];
			}
			if ( '' === $avatar_url && ! empty( $existing['defaultAvatarUrl'] ) ) {
				$avatar_url = (string) $existing['defaultAvatarUrl'];
			}

			$raw_wiki = trim( (string) ( $crow['wikiUrl'] ?? ( $crow['wikiPage'] ?? '' ) ) );
			$wiki_url = $this->sanitize_http_url( $raw_wiki, 'wikiUrl', false );
			$post_id  = 0;
			if ( ! empty( $crow['wpPostId'] ) && is_numeric( $crow['wpPostId'] ) ) {
				$post_id = (int) $crow['wpPostId'];
			} elseif ( ! empty( $crow['postid'] ) && is_numeric( $crow['postid'] ) ) {
				$post_id = (int) $crow['postid'];
			} elseif ( ! empty( $existing['wpPostId'] ) ) {
				$post_id = (int) $existing['wpPostId'];
			}
			if ( '' === $wiki_url && ! empty( $existing['wikiUrl'] ) ) {
				$wiki_url = (string) $existing['wikiUrl'];
			}

			$arcs = ! empty( $crow['arcs'] )
				? array_values( array_filter( array_map( 'trim', (array) preg_split( '/[|,]/', (string) $crow['arcs'] ) ) ) )
				: ( $existing['arcs'] ?? array( 'sen' ) );

			$importance = ! empty( $crow['importance'] ) && in_array( $crow['importance'], self::IMPORTANCE_TIERS, true )
				? $crow['importance']
				: ( $existing['importance'] ?? 'supporting' );

			$aliases = isset( $existing['aliases'] ) && is_array( $existing['aliases'] ) ? $existing['aliases'] : array();
			if ( $raw_name !== $canon_name && ! in_array( $raw_name, $aliases, true ) ) {
				$aliases[] = $raw_name;
			}

			$candidate = is_array( $existing ) ? $existing : array();
			$candidate['id']            = $matched_id;
			$candidate['canonicalName'] = $existing['canonicalName'] ?? $canon_name;
			$candidate['entityType']    = $etype;
			$candidate['importance']    = $importance;
			$candidate['arcs']          = $arcs;
			$candidate['bio']           = isset( $crow['bio'] ) && '' !== trim( (string) $crow['bio'] )
				? (string) $crow['bio']
				: ( $existing['bio'] ?? '' );

			if ( '' !== $avatar_url ) {
				$candidate['defaultAvatarUrl'] = $avatar_url;
			}
			if ( '' !== $wiki_url ) {
				$candidate['wikiUrl'] = $wiki_url;
			}
			if ( $post_id > 0 ) {
				$candidate['wpPostId'] = $post_id;
			}
			if ( ! empty( $aliases ) ) {
				$candidate['aliases'] = $aliases;
			}

			$clean_ent                       = $this->sanitize_entity( $candidate, false );
			$ent_map[ $clean_ent['id'] ]     = $clean_ent;
			$name_to_id[ $canon_name ]       = $clean_ent['id'];
			$name_to_id[ $raw_name ]         = $clean_ent['id'];
			$name_to_id[ $clean_ent['id'] ]  = $clean_ent['id'];
		}

		// 2. Parse `人物组织关系` / `Relations` sheet
		$rel_map = array();
		if ( 'merge' === $mode ) {
			foreach ( $dataset['relations'] as $r ) {
				$rel_map[ $r['id'] ] = $r;
			}
		}

		// Build existing (source|target|category|label) index so merge avoids duplicating existing seed edges
		$existing_edge_sig = array();
		foreach ( $rel_map as $er ) {
			$sig                       = $er['source'] . '|' . $er['target'] . '|' . $er['label'];
			$existing_edge_sig[ $sig ] = $er['id'];
		}

		foreach ( $rel_rows as $rrow ) {
			$raw_src   = trim( (string) ( $rrow['source'] ?? '' ) );
			$raw_tgt   = trim( (string) ( $rrow['target'] ?? '' ) );
			$raw_label = trim( (string) ( $rrow['label'] ?? ( $rrow['Relation'] ?? '' ) ) );
			$raw_rtype = trim( (string) ( $rrow['category'] ?? ( $rrow['RelationType'] ?? '' ) ) );

			if ( '' === $raw_src || '' === $raw_tgt || '' === $raw_label ) {
				continue;
			}

			$canon_src = $this->normalize_entity_name( $raw_src );
			$canon_tgt = $this->normalize_entity_name( $raw_tgt );

			$src_id = $name_to_id[ $raw_src ] ?? ( $name_to_id[ $canon_src ] ?? '' );
			$tgt_id = $name_to_id[ $raw_tgt ] ?? ( $name_to_id[ $canon_tgt ] ?? '' );

			// Auto-create placeholder character node if referenced in `人物组织关系` without a `角色` row
			if ( '' === $src_id ) {
				$src_id              = 'xlsx-' . substr( md5( $canon_src ), 0, 10 );
				$auto_ent            = $this->sanitize_entity(
					array(
						'id'            => $src_id,
						'canonicalName' => $canon_src,
						'entityType'    => $this->map_xlsx_entity_type( '', $canon_src ),
						'importance'    => 'minor',
						'arcs'          => array( 'sen' ),
						'bio'           => '',
					),
					false
				);
				$ent_map[ $src_id ]       = $auto_ent;
				$name_to_id[ $canon_src ] = $src_id;
			}
			if ( '' === $tgt_id ) {
				$tgt_id              = 'xlsx-' . substr( md5( $canon_tgt ), 0, 10 );
				$auto_ent            = $this->sanitize_entity(
					array(
						'id'            => $tgt_id,
						'canonicalName' => $canon_tgt,
						'entityType'    => $this->map_xlsx_entity_type( '', $canon_tgt ),
						'importance'    => 'minor',
						'arcs'          => array( 'sen' ),
						'bio'           => '',
					),
					false
				);
				$ent_map[ $tgt_id ]       = $auto_ent;
				$name_to_id[ $canon_tgt ] = $tgt_id;
			}

			if ( $src_id === $tgt_id ) {
				continue;
			}

			$category = in_array( $raw_rtype, self::RELATION_CATEGORIES, true )
				? $raw_rtype
				: $this->map_xlsx_relation_category( $raw_rtype, $raw_label );

			$direction = ! empty( $rrow['direction'] ) && in_array( $rrow['direction'], self::DIRECTIONS, true )
				? $rrow['direction']
				: ( in_array( $category, array( 'membership', 'hierarchy', 'school' ), true ) ? 'directed' : 'bidirectional' );

			// Infer arcs from intersection or union of endpoint entity arcs when not specified
			if ( ! empty( $rrow['arcs'] ) ) {
				$rarcs = array_values( array_filter( array_map( 'trim', (array) preg_split( '/[|,]/', (string) $rrow['arcs'] ) ) ) );
			} else {
				$s_arcs = $ent_map[ $src_id ]['arcs'] ?? array();
				$t_arcs = $ent_map[ $tgt_id ]['arcs'] ?? array();
				$common = array_values( array_intersect( $s_arcs, $t_arcs ) );
				$rarcs  = ! empty( $common ) ? $common : ( ! empty( $s_arcs ) ? array( $s_arcs[0] ) : array( 'sen' ) );
			}

			$sig = $src_id . '|' . $tgt_id . '|' . $raw_label;
			if ( ! empty( $rrow['id'] ) ) {
				$rid = trim( (string) $rrow['id'] );
			} elseif ( isset( $existing_edge_sig[ $sig ] ) ) {
				$rid = $existing_edge_sig[ $sig ];
			} else {
				$rid = 'rel-xlsx-' . substr( md5( $src_id . '|' . $tgt_id . '|' . $category . '|' . $raw_label ), 0, 10 );
			}

			$note    = trim( (string) ( $rrow['note'] ?? ( $rrow['备注'] ?? '' ) ) );
			$raw_rel = array(
				'id'        => $rid,
				'source'    => $src_id,
				'target'    => $tgt_id,
				'category'  => $category,
				'label'     => $raw_label,
				'direction' => $direction,
				'weight'    => 3,
				'arcs'      => $rarcs,
				'status'    => ! empty( $rrow['status'] ) && in_array( $rrow['status'], self::STATUSES, true )
					? $rrow['status']
					: 'published',
			);
			if ( '' !== $note ) {
				$raw_rel['note'] = $note;
			}
			if ( ! empty( $rrow['supersedesId'] ) ) {
				$raw_rel['supersedesId'] = trim( (string) $rrow['supersedesId'] );
			}

			$clean_rel                   = $this->sanitize_relation( $raw_rel );
			$rel_map[ $clean_rel['id'] ] = $clean_rel;
			$existing_edge_sig[ $sig ]   = $clean_rel['id'];

			// Ensure endpoint entities carry the relation's arcs
			foreach ( $clean_rel['arcs'] as $a_id ) {
				foreach ( array( $src_id, $tgt_id ) as $endpoint_id ) {
					if ( isset( $ent_map[ $endpoint_id ] ) && ! in_array( $a_id, $ent_map[ $endpoint_id ]['arcs'], true ) ) {
						$ent_map[ $endpoint_id ]['arcs'][] = $a_id;
					}
				}
			}
		}

		$dataset['entities']  = array_values( $ent_map );
		$dataset['relations'] = array_values( $rel_map );
		return $dataset;
	}

	/**
	 * Reads all worksheet tables from an OOXML .xlsx file into `[sheetName => [rowAssoc, ...]]`.
	 */
	private function read_xlsx_workbook_sheets( string $xlsx_path ): array {
		$zip = new ZipArchive();
		if ( true !== $zip->open( $xlsx_path ) ) {
			throw new InvalidArgumentException( '无法作为有效的 ZIP/OOXML 工作簿打开 .xlsx 文件。' );
		}

		try {
			$shared_strings = array();
			$ss_xml         = $this->read_zip_entry_guarded( $zip, 'xl/sharedStrings.xml', false );
			if ( '' !== $ss_xml ) {
				$ss = $this->parse_xml_safe( $ss_xml, 'xl/sharedStrings.xml' );
				if ( isset( $ss->si ) ) {
					foreach ( $ss->si as $si ) {
						if ( isset( $si->t ) ) {
							$shared_strings[] = (string) $si->t;
						} elseif ( isset( $si->r ) ) {
							// Concatenate rich-text <r><t> runs while ignoring phonetic <rPh> furigana
							$buf = '';
							foreach ( $si->r as $run ) {
								if ( isset( $run->t ) ) {
									$buf .= (string) $run->t;
								}
							}
							$shared_strings[] = $buf;
						} else {
							$shared_strings[] = '';
						}
					}
				}
			}

			$rels_xml    = $this->read_zip_entry_guarded( $zip, 'xl/_rels/workbook.xml.rels', true );
			$rels        = $this->parse_xml_safe( $rels_xml, 'xl/_rels/workbook.xml.rels' );
			$rel_targets = array();
			if ( isset( $rels->Relationship ) ) {
				foreach ( $rels->Relationship as $rel ) {
					$rid    = (string) $rel['Id'];
					$target = ltrim( (string) $rel['Target'], '/' );
					if ( ! str_starts_with( $target, 'xl/' ) ) {
						$target = 'xl/' . $target;
					}
					$rel_targets[ $rid ] = $target;
				}
			}

			$wb_xml = $this->read_zip_entry_guarded( $zip, 'xl/workbook.xml', true );
			$wb     = $this->parse_xml_safe( $wb_xml, 'xl/workbook.xml' );
			$out    = array();

			if ( isset( $wb->sheets->sheet ) ) {
				foreach ( $wb->sheets->sheet as $sheet_el ) {
					$sheet_name = trim( (string) $sheet_el['name'] );
					$r_attrs    = $sheet_el->attributes( 'http://schemas.openxmlformats.org/officeDocument/2006/relationships' );
					$rid        = isset( $r_attrs['id'] ) ? (string) $r_attrs['id'] : (string) $sheet_el['id'];
					if ( '' === $sheet_name || empty( $rel_targets[ $rid ] ) ) {
						continue;
					}
					$ws_xml = $this->read_zip_entry_guarded( $zip, $rel_targets[ $rid ], false );
					if ( '' === $ws_xml ) {
						continue;
					}
					$out[ $sheet_name ] = $this->parse_worksheet_rows( $ws_xml, $shared_strings );
				}
			}

			return $out;
		} finally {
			$zip->close();
		}
	}

	private function read_zip_entry_guarded( ZipArchive $zip, string $entry_name, bool $required ): string {
		$idx = $zip->locateName( $entry_name );
		if ( false === $idx ) {
			if ( $required ) {
				throw new InvalidArgumentException( '.xlsx 缺少核心组件：' . $entry_name );
			}
			return '';
		}
		$stat = $zip->statIndex( $idx );
		if ( is_array( $stat ) && isset( $stat['size'] ) && (int) $stat['size'] > 32 * 1024 * 1024 ) {
			throw new InvalidArgumentException( '.xlsx 内部 XML 体积异常超限：' . $entry_name );
		}
		$raw = $zip->getFromIndex( $idx );
		return is_string( $raw ) ? $raw : '';
	}

	private function parse_xml_safe( string $xml, string $label ): SimpleXMLElement {
		$prev = libxml_use_internal_errors( true );
		try {
			// Reject DOCTYPE declarations defensively against XXE / billion-laughs
			if ( preg_match( '/<!DOCTYPE/i', substr( $xml, 0, 4096 ) ) ) {
				throw new InvalidArgumentException( '.xlsx XML 包含禁止的 DOCTYPE 声明：' . $label );
			}
			$el = new SimpleXMLElement( $xml, LIBXML_NONET | LIBXML_COMPACT );
			return $el;
		} catch ( Throwable $e ) {
			if ( $e instanceof InvalidArgumentException ) {
				throw $e;
			}
			throw new InvalidArgumentException( '解析 .xlsx XML 失败 (' . $label . ')。' );
		} finally {
			libxml_clear_errors();
			libxml_use_internal_errors( $prev );
		}
	}

	private function parse_worksheet_rows( string $ws_xml, array $shared_strings ): array {
		$ws = $this->parse_xml_safe( $ws_xml, 'worksheet' );
		if ( ! isset( $ws->sheetData->row ) ) {
			return array();
		}

		$headers = array();
		$rows    = array();

		foreach ( $ws->sheetData->row as $row_el ) {
			if ( ! isset( $row_el->c ) ) {
				continue;
			}
			$col_values = array();
			$seq_idx    = 0;
			foreach ( $row_el->c as $cell ) {
				$coord  = (string) $cell['r'];
				$col_id = '' !== $coord ? (string) preg_replace( '/\d+/', '', $coord ) : 'COL_' . $seq_idx;
				++$seq_idx;

				$ctype = (string) $cell['t'];
				$val   = '';
				if ( 's' === $ctype ) {
					$ss_idx = isset( $cell->v ) ? (int) (string) $cell->v : -1;
					$val    = $shared_strings[ $ss_idx ] ?? '';
				} elseif ( 'inlineStr' === $ctype ) {
					if ( isset( $cell->is->t ) ) {
						$val = (string) $cell->is->t;
					} elseif ( isset( $cell->is->r ) ) {
						foreach ( $cell->is->r as $run ) {
							if ( isset( $run->t ) ) {
								$val .= (string) $run->t;
							}
						}
					}
				} elseif ( isset( $cell->v ) ) {
					$val = (string) $cell->v;
				}
				$col_values[ $col_id ] = trim( $val );
			}

			$has_non_empty = false;
			foreach ( $col_values as $cv ) {
				if ( '' !== $cv ) {
					$has_non_empty = true;
					break;
				}
			}
			if ( ! $has_non_empty ) {
				continue;
			}

			if ( empty( $headers ) ) {
				foreach ( $col_values as $col_id => $h_text ) {
					if ( '' !== $h_text ) {
						$headers[ $col_id ] = $h_text;
					}
				}
				continue;
			}

			$assoc         = array();
			$row_has_value = false;
			foreach ( $headers as $col_id => $h_name ) {
				$v                = $col_values[ $col_id ] ?? '';
				$assoc[ $h_name ] = $v;
				if ( '' !== $v ) {
					$row_has_value = true;
				}
			}
			if ( $row_has_value ) {
				$rows[] = $assoc;
			}
		}

		return $rows;
	}

	private function build_entity_lookup_map( array $entities ): array {
		$map = array();
		foreach ( $entities as $e ) {
			$eid   = (string) ( $e['id'] ?? '' );
			$cname = (string) ( $e['canonicalName'] ?? '' );
			if ( '' === $eid ) {
				continue;
			}
			$map[ $eid ] = $eid;
			if ( '' !== $cname ) {
				$map[ $cname ]                                 = $eid;
				$map[ $this->normalize_entity_name( $cname ) ] = $eid;
			}
			if ( ! empty( $e['aliases'] ) && is_array( $e['aliases'] ) ) {
				foreach ( $e['aliases'] as $alias ) {
					$al = trim( (string) $alias );
					if ( '' !== $al ) {
						$map[ $al ]                                 = $eid;
						$map[ $this->normalize_entity_name( $al ) ] = $eid;
					}
				}
			}
		}
		return $map;
	}

	private function normalize_entity_name( string $raw ): string {
		$s = trim( html_entity_decode( $raw, ENT_QUOTES, 'UTF-8' ) );
		$s = str_replace( array( '‧', '･', '•', '・' ), '·', $s );
		$s = (string) preg_replace( '/\s+/u', ' ', $s );
		return self::LEGACY_CANONICAL_NAME_MAP[ $s ] ?? $s;
	}

	private function map_xlsx_entity_type( string $raw_type, string $canon_name ): string {
		if ( in_array( $raw_type, self::ENTITY_TYPES, true ) ) {
			return $raw_type;
		}
		if ( in_array( $canon_name, self::KNOWN_NATIONS, true ) ) {
			return 'nation';
		}
		if ( in_array( $canon_name, self::KNOWN_SCHOOLS, true ) ) {
			return 'school';
		}
		$prefix = explode( '.', $raw_type )[0];
		if ( 'Fam' === $prefix || str_ends_with( $canon_name, '家族' ) || str_ends_with( $canon_name, '皇族' ) || str_ends_with( $canon_name, '王家' ) || str_ends_with( $canon_name, '家系' ) ) {
			return 'family';
		}
		if ( 'Org' === $prefix ) {
			return 'organization';
		}
		return 'character';
	}

	private function map_xlsx_relation_category( string $rel_type, string $label ): string {
		$rt = trim( $rel_type );
		$lb = trim( $label );
		if ( in_array( $rt, array( '成员', '隶属' ), true ) ) {
			return 'membership';
		}
		if ( in_array( $rt, array( '流派', '师生', '师从', '学生' ), true ) ) {
			return 'school';
		}
		if ( '家族' === $rt ) {
			return 'family';
		}
		if ( in_array( $rt, array( '恋人', '倾慕', '倾慕?' ), true ) ) {
			return 'romance';
		}
		foreach ( array( '恋爱', '相爱', '爱情', '倾慕', '好感', '告白' ) as $kw ) {
			if ( str_contains( $lb, $kw ) ) {
				return 'romance';
			}
		}
		if (
			str_contains( $rt, '敌' )
			|| str_contains( $lb, '仇' )
			|| str_contains( $lb, '敌' )
			|| str_contains( $lb, '杀' )
			|| str_contains( $lb, '憎恨' )
		) {
			return 'hostile';
		}
		if ( in_array( $rt, array( '合作', '同事', '上下级', '支配' ), true ) ) {
			return 'hierarchy';
		}
		foreach ( array( '雇主', '委托', '邀请', '利用', '启动者', '创始人' ) as $kw ) {
			if ( str_contains( $lb, $kw ) ) {
				return 'hierarchy';
			}
		}
		return 'ally';
	}

	/* ==========================================================================
	 * Strict Schema & Protocol Validation / Sanitization Helpers
	 * ========================================================================== */

	private function sanitize_slug_id( $raw, string $field ): string {
		$id = trim( (string) $raw );
		if ( '' === $id || strlen( $id ) > 128 || ! preg_match( '/^[a-zA-Z0-9_\-\x{4e00}-\x{9fff}.]+$/u', $id ) ) {
			throw new InvalidArgumentException( sprintf( '字段 %s 包含非法的标识符格式。', $field ) );
		}
		if ( '.' === $id || '..' === $id || str_contains( $id, '..' ) ) {
			throw new InvalidArgumentException( sprintf( '字段 %s 包含非法的路径序列。', $field ) );
		}
		return $id;
	}

	private function sanitize_optional_id( $raw ): string {
		if ( null === $raw ) {
			return '';
		}
		$id = trim( (string) $raw );
		if ( '' === $id ) {
			return '';
		}
		return $this->sanitize_slug_id( $id, 'id' );
	}

	private function clean_plain_text( $raw, int $max_len = 300 ): string {
		$txt = trim( wp_strip_all_tags( (string) $raw ) );
		$txt = (string) preg_replace( '/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]+/u', '', $txt );
		return mb_substr( $txt, 0, $max_len );
	}

	private function clean_multiline_text( $raw, int $max_len = 4000 ): string {
		$txt = trim( wp_strip_all_tags( (string) $raw ) );
		$txt = (string) preg_replace( '/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]+/u', '', $txt );
		return mb_substr( $txt, 0, $max_len );
	}

	/**
	 * Strictly sanitizes URLs using esc_url_raw($u, ['http', 'https']), rejecting javascript:/data:/vbscript:.
	 */
	private function sanitize_http_url( $raw_url, string $field_name, bool $strict = true ): string {
		if ( null === $raw_url ) {
			return '';
		}
		$u = trim( (string) $raw_url );
		if ( '' === $u ) {
			return '';
		}

		// Explicitly block dangerous schemes even in non-strict spreadsheet mode
		if ( preg_match( '/^\s*(?:javascript|data|vbscript|file|blob):/i', $u ) ) {
			throw new InvalidArgumentException( sprintf( '安全拦截：字段 %s 包含禁止的危险协议。', $field_name ) );
		}

		if ( str_starts_with( $u, '/' ) && ! str_starts_with( $u, '//' ) ) {
			$u = home_url( $u );
		}

		if ( ! preg_match( '#^https?://#i', $u ) ) {
			if ( $strict ) {
				throw new InvalidArgumentException( sprintf( '字段 %s 仅允许 http:// 或 https:// 链接。', $field_name ) );
			}
			return '';
		}

		$clean = esc_url_raw( $u, array( 'http', 'https' ) );
		if ( '' === $clean || ! preg_match( '#^https?://#i', $clean ) ) {
			if ( $strict ) {
				throw new InvalidArgumentException( sprintf( '字段 %s 不是合法的 HTTP/HTTPS URL。', $field_name ) );
			}
			return '';
		}

		return $clean;
	}

	private function sanitize_arc( array $raw ): array {
		$id   = $this->sanitize_slug_id( $raw['id'] ?? '', 'arc.id' );
		$name = $this->clean_plain_text( $raw['name'] ?? '', 120 );
		if ( '' === $name ) {
			throw new InvalidArgumentException( '作品层名称 (arc.name) 不能为空。' );
		}
		$short    = $this->clean_plain_text( $raw['shortName'] ?? '', 40 );
		$subtitle = $this->clean_plain_text( $raw['subtitle'] ?? '', 160 );
		$order    = isset( $raw['order'] ) && is_numeric( $raw['order'] ) ? (int) $raw['order'] : 0;

		$accent = isset( $raw['accent'] ) ? trim( (string) $raw['accent'] ) : '#38bdf8';
		if ( '' === $accent ) {
			$accent = '#38bdf8';
		}
		if ( ! preg_match( '/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/', $accent ) ) {
			throw new InvalidArgumentException( '作品层主题色 (arc.accent) 必须是合法的十六进制颜色值（如 #38bdf8）。' );
		}

		return array(
			'id'        => $id,
			'name'      => $name,
			'shortName' => '' !== $short ? $short : mb_substr( $name, 0, 4 ),
			'subtitle'  => $subtitle,
			'order'     => $order,
			'accent'    => strtolower( $accent ),
		);
	}

	private function sanitize_entity( array $raw, bool $strict_urls = true ): array {
		$id    = $this->sanitize_slug_id( $raw['id'] ?? '', 'entity.id' );
		$cname = $this->clean_plain_text( $raw['canonicalName'] ?? '', 160 );
		if ( '' === $cname ) {
			throw new InvalidArgumentException( '实体名称 (canonicalName) 不能为空。' );
		}

		$etype = isset( $raw['entityType'] ) ? trim( (string) $raw['entityType'] ) : 'character';
		if ( ! in_array( $etype, self::ENTITY_TYPES, true ) ) {
			throw new InvalidArgumentException( '非法的实体类型 (entityType)：' . $etype );
		}

		$importance = isset( $raw['importance'] ) && '' !== trim( (string) $raw['importance'] )
			? trim( (string) $raw['importance'] )
			: 'supporting';
		if ( ! in_array( $importance, self::IMPORTANCE_TIERS, true ) ) {
			throw new InvalidArgumentException( '非法的实体重要度分级 (importance)：' . $importance );
		}

		$arcs = array();
		if ( isset( $raw['arcs'] ) ) {
			if ( ! is_array( $raw['arcs'] ) ) {
				throw new InvalidArgumentException( '实体 arcs 字段必须是数组。' );
			}
			foreach ( $raw['arcs'] as $a ) {
				$clean_a = $this->sanitize_optional_id( $a );
				if ( '' !== $clean_a && ! in_array( $clean_a, $arcs, true ) ) {
					$arcs[] = $clean_a;
				}
			}
		}

		$out = array(
			'id'            => $id,
			'canonicalName' => $cname,
			'entityType'    => $etype,
			'importance'    => $importance,
			'arcs'          => $arcs,
			'bio'           => $this->clean_multiline_text( $raw['bio'] ?? '', 4000 ),
		);

		$name_en = $this->clean_plain_text( $raw['nameEn'] ?? '', 160 );
		if ( '' !== $name_en ) {
			$out['nameEn'] = $name_en;
		}

		$subtype = $this->clean_plain_text( $raw['subtype'] ?? '', 100 );
		if ( '' !== $subtype ) {
			$out['subtype'] = $subtype;
		}

		$nation_id = $this->sanitize_optional_id( $raw['nationId'] ?? '' );
		if ( '' !== $nation_id ) {
			$out['nationId'] = $nation_id;
		}

		$group_id = $this->sanitize_optional_id( $raw['defaultGroupId'] ?? '' );
		if ( '' !== $group_id ) {
			$out['defaultGroupId'] = $group_id;
		}

		$title = $this->clean_plain_text( $raw['defaultTitle'] ?? '', 200 );
		if ( '' !== $title ) {
			$out['defaultTitle'] = $title;
		}

		if ( isset( $raw['wpPostId'] ) && '' !== (string) $raw['wpPostId'] ) {
			if ( ! is_numeric( $raw['wpPostId'] ) || (int) $raw['wpPostId'] < 0 ) {
				throw new InvalidArgumentException( '非法的 wpPostId 参数。' );
			}
			if ( (int) $raw['wpPostId'] > 0 ) {
				$out['wpPostId'] = (int) $raw['wpPostId'];
			}
		}

		$avatar_url = $this->sanitize_http_url( $raw['defaultAvatarUrl'] ?? '', 'defaultAvatarUrl', $strict_urls );
		if ( '' !== $avatar_url ) {
			$out['defaultAvatarUrl'] = $avatar_url;
		}

		$wiki_url = $this->sanitize_http_url( $raw['wikiUrl'] ?? '', 'wikiUrl', $strict_urls );
		if ( '' !== $wiki_url ) {
			$out['wikiUrl'] = $wiki_url;
		}

		if ( ! empty( $raw['aliases'] ) && is_array( $raw['aliases'] ) ) {
			$aliases = array();
			foreach ( $raw['aliases'] as $al ) {
				$cal = $this->clean_plain_text( $al, 120 );
				if ( '' !== $cal && ! in_array( $cal, $aliases, true ) ) {
					$aliases[] = $cal;
				}
			}
			if ( ! empty( $aliases ) ) {
				$out['aliases'] = $aliases;
			}
		}

		if ( ! empty( $raw['arcOverrides'] ) && is_array( $raw['arcOverrides'] ) ) {
			$overrides = array();
			foreach ( $raw['arcOverrides'] as $arc_key => $ov ) {
				$clean_ak = $this->sanitize_slug_id( $arc_key, 'arcOverrides.arcId' );
				if ( ! is_array( $ov ) ) {
					continue;
				}
				$clean_ov = array();

				$dn = $this->clean_plain_text( $ov['displayName'] ?? '', 160 );
				if ( '' !== $dn ) {
					$clean_ov['displayName'] = $dn;
				}
				$ot = $this->clean_plain_text( $ov['title'] ?? '', 200 );
				if ( '' !== $ot ) {
					$clean_ov['title'] = $ot;
				}
				$pg = $this->sanitize_optional_id( $ov['primaryGroupId'] ?? '' );
				if ( '' !== $pg ) {
					$clean_ov['primaryGroupId'] = $pg;
				}
				$oa = $this->sanitize_http_url( $ov['avatarUrl'] ?? '', "arcOverrides[{$clean_ak}].avatarUrl", $strict_urls );
				if ( '' !== $oa ) {
					$clean_ov['avatarUrl'] = $oa;
				}
				if ( isset( $ov['importance'] ) && '' !== trim( (string) $ov['importance'] ) ) {
					$oimp = trim( (string) $ov['importance'] );
					if ( ! in_array( $oimp, self::IMPORTANCE_TIERS, true ) ) {
						throw new InvalidArgumentException( "arcOverrides[{$clean_ak}].importance 非法：" . $oimp );
					}
					$clean_ov['importance'] = $oimp;
				}
				$obio = $this->clean_multiline_text( $ov['bio'] ?? '', 4000 );
				if ( '' !== $obio ) {
					$clean_ov['bio'] = $obio;
				}

				if ( ! empty( $clean_ov ) ) {
					$overrides[ $clean_ak ] = $clean_ov;
				}
			}
			if ( ! empty( $overrides ) ) {
				$out['arcOverrides'] = $overrides;
			}
		}

		if ( ! empty( $raw['scriptMoments'] ) && is_array( $raw['scriptMoments'] ) ) {
			$moments = array();
			foreach ( $raw['scriptMoments'] as $sm ) {
				if ( ! is_array( $sm ) ) {
					continue;
				}
				$ch = $this->clean_plain_text( $sm['chapter'] ?? '', 120 );
				$sp = $this->clean_plain_text( $sm['speaker'] ?? '', 120 );
				$qt = $this->clean_multiline_text( $sm['quote'] ?? '', 1000 );
				if ( '' !== $qt ) {
					$moments[] = array(
						'chapter' => $ch,
						'speaker' => $sp,
						'quote'   => $qt,
					);
				}
			}
			if ( ! empty( $moments ) ) {
				$out['scriptMoments'] = $moments;
			}
		}

		return $out;
	}

	private function sanitize_relation( array $raw ): array {
		$id     = $this->sanitize_slug_id( $raw['id'] ?? '', 'relation.id' );
		$source = $this->sanitize_slug_id( $raw['source'] ?? '', 'relation.source' );
		$target = $this->sanitize_slug_id( $raw['target'] ?? '', 'relation.target' );

		if ( $source === $target ) {
			throw new InvalidArgumentException( '关系的源实体与目标实体不能相同。' );
		}

		$category = isset( $raw['category'] ) && '' !== trim( (string) $raw['category'] )
			? trim( (string) $raw['category'] )
			: 'ally';
		if ( ! in_array( $category, self::RELATION_CATEGORIES, true ) ) {
			throw new InvalidArgumentException( '非法的关系类别 (category)：' . $category );
		}

		$label = $this->clean_plain_text( $raw['label'] ?? '', 160 );
		if ( '' === $label ) {
			throw new InvalidArgumentException( '关系描述词 (label) 不能为空。' );
		}

		$direction = isset( $raw['direction'] ) && '' !== trim( (string) $raw['direction'] )
			? trim( (string) $raw['direction'] )
			: 'bidirectional';
		if ( ! in_array( $direction, self::DIRECTIONS, true ) ) {
			throw new InvalidArgumentException( '非法的关系方向 (direction)：' . $direction );
		}

		$status = isset( $raw['status'] ) && '' !== trim( (string) $raw['status'] )
			? trim( (string) $raw['status'] )
			: 'published';
		if ( ! in_array( $status, self::STATUSES, true ) ) {
			throw new InvalidArgumentException( '非法的关系审核状态 (status)：' . $status );
		}

		$weight = isset( $raw['weight'] ) && is_numeric( $raw['weight'] )
			? max( 1, min( 10, (int) $raw['weight'] ) )
			: 3;

		$arcs = array();
		if ( isset( $raw['arcs'] ) ) {
			if ( ! is_array( $raw['arcs'] ) ) {
				throw new InvalidArgumentException( '关系 arcs 字段必须是数组。' );
			}
			foreach ( $raw['arcs'] as $a ) {
				$clean_a = $this->sanitize_optional_id( $a );
				if ( '' !== $clean_a && ! in_array( $clean_a, $arcs, true ) ) {
					$arcs[] = $clean_a;
				}
			}
		}
		if ( empty( $arcs ) ) {
			throw new InvalidArgumentException( '关系必须至少归属一个作品层 (arcs)。' );
		}

		$out = array(
			'id'        => $id,
			'source'    => $source,
			'target'    => $target,
			'category'  => $category,
			'label'     => $label,
			'direction' => $direction,
			'weight'    => $weight,
			'arcs'      => $arcs,
			'status'    => $status,
		);

		$sup = $this->sanitize_optional_id( $raw['supersedesId'] ?? '' );
		if ( '' !== $sup && $sup !== $id ) {
			$out['supersedesId'] = $sup;
		}

		$note = $this->clean_multiline_text( $raw['note'] ?? '', 2000 );
		if ( '' !== $note ) {
			$out['note'] = $note;
		}

		return $out;
	}
}
