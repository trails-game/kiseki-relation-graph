<?php
/**
 * Zero-SQL, flock-guarded atomic static JSON store with multi-instance safety,
 * optimistic version checks, author-attributed rolling backups, and targeted cache invalidation.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

if ( ! class_exists( 'Kiseki_Relation_Conflict_Exception' ) ) {
	class Kiseki_Relation_Conflict_Exception extends RuntimeException {}
}

class Kiseki_Relation_Json_Store {

	private const OPTION_MANIFEST      = 'kiseki_relation_manifest';
	private const OPTION_BACKUP_META   = 'kiseki_relation_backup_meta';
	private const MAX_BACKUPS          = 30;
	private const MIN_SNAPSHOTS_KEEP   = 50;
	private const SNAPSHOT_MIN_AGE_SEC = 86400;

	private const VALID_ENTITY_TYPES = array( 'nation', 'organization', 'family', 'school', 'character' );
	private const VALID_CATEGORIES   = array( 'membership', 'hierarchy', 'family', 'school', 'ally', 'romance', 'hostile' );

	private bool $lock_held = false;
	private bool $seeding   = false;

	public function get_paths(): array {
		$uploads  = wp_upload_dir();
		$base_dir = trailingslashit( $uploads['basedir'] ) . 'kiseki-relations';
		$base_url = trailingslashit( $uploads['baseurl'] ) . 'kiseki-relations';

		return array(
			'dir'           => $base_dir,
			'url'           => $base_url,
			'backups_dir'   => $base_dir . '/backups',
			'lock_file'     => $base_dir . '/.store.lock',
			'latest_file'   => $base_dir . '/zemuria.latest.json',
			'manifest_file' => $base_dir . '/manifest.json',
			'seed_file'     => KISEKI_RELATION_PLUGIN_DIR . 'seed/zemuria.seed.json',
		);
	}

	/**
	 * Rewrites upload/static JSON URL through W3TC CDN (if active) and custom filter.
	 */
	public function format_public_url( string $url ): string {
		if ( function_exists( 'w3tc_cdn_url' ) ) {
			$cdn_url = w3tc_cdn_url( $url );
			if ( is_string( $cdn_url ) && '' !== $cdn_url ) {
				$url = $cdn_url;
			}
		}
		return (string) apply_filters( 'kiseki_relation_cdn_url', $url );
	}

	public function ensure_initialized(): array {
		$paths = $this->get_paths();
		if ( ! is_dir( $paths['dir'] ) ) {
			wp_mkdir_p( $paths['dir'] );
		}
		if ( ! is_dir( $paths['backups_dir'] ) ) {
			wp_mkdir_p( $paths['backups_dir'] );
		}

		// Protect backups directory from directory listing
		$index_guard = $paths['backups_dir'] . '/index.php';
		if ( ! file_exists( $index_guard ) ) {
			@file_put_contents( $index_guard, "<?php // Silence is golden.\n" );
		}

		if ( ! file_exists( $paths['latest_file'] ) && file_exists( $paths['seed_file'] ) ) {
			$this->seeding = true;
			try {
				if ( $this->lock_held ) {
					$this->seed_from_bundle_unlocked( $paths );
				} else {
					$lock_fp = @fopen( $paths['lock_file'], 'c+' );
					if ( ! $lock_fp ) {
						throw new RuntimeException( '无法打开关系图谱初始化文件锁 (.store.lock)，请检查 uploads 目录写权限。' );
					}
					if ( ! flock( $lock_fp, LOCK_EX ) ) {
						fclose( $lock_fp );
						throw new RuntimeException( '无法获取关系图谱初始化写入锁，请稍后重试。' );
					}
					$this->lock_held = true;
					try {
						if ( ! file_exists( $paths['latest_file'] ) ) {
							$this->seed_from_bundle_unlocked( $paths );
						}
					} finally {
						$this->lock_held = false;
						flock( $lock_fp, LOCK_UN );
						fclose( $lock_fp );
					}
				}
			} finally {
				$this->seeding = false;
			}
		}

		return $this->get_manifest();
	}

	private function seed_from_bundle_unlocked( array $paths ): void {
		$raw     = file_get_contents( $paths['seed_file'] );
		$decoded = json_decode( (string) $raw, true );
		if ( ! is_array( $decoded ) ) {
			return;
		}
		$ver                   = isset( $decoded['version'] ) ? max( 1, (int) $decoded['version'] ) : 1;
		$now_iso               = gmdate( 'Y-m-d\TH:i:s\Z' );
		$decoded['version']    = $ver;
		$decoded['updatedAt']  = $decoded['updatedAt'] ?? $now_iso;
		$decoded['updatedBy']  = $decoded['updatedBy'] ?? 'seed-bootstrap';
		$snap_name             = "zemuria.v{$ver}.json";
		$snap_path             = $paths['dir'] . '/' . $snap_name;

		$this->atomic_write_json( $paths['latest_file'], $decoded, true );
		$this->atomic_write_json( $snap_path, $decoded, false );

		$manifest = array(
			'currentVersion' => $ver,
			'updatedAt'      => $now_iso,
			'updatedBy'      => 'seed-bootstrap',
			'userId'         => 0,
			'displayName'    => 'seed-bootstrap',
			'summary'        => 'Initial seed bootstrap',
			'timestamp'      => $now_iso,
			'file'           => $snap_name,
		);
		$this->atomic_write_json( $paths['manifest_file'], $manifest, true );
		update_option( self::OPTION_MANIFEST, $manifest, true );
	}

	/**
	 * Reads current manifest metadata.
	 * Trusts wp_options / object cache directly on frontend reads without per-request
	 * file_exists() stat overhead on shared filesystems.
	 */
	public function get_manifest(): array {
		$paths = $this->get_paths();
		$opt   = get_option( self::OPTION_MANIFEST );
		if ( is_array( $opt ) && ! empty( $opt['file'] ) ) {
			$clean_file     = basename( (string) $opt['file'] );
			$opt['fileUrl'] = $this->format_public_url( $paths['url'] . '/' . $clean_file );
			return $opt;
		}

		if ( file_exists( $paths['manifest_file'] ) ) {
			$m = json_decode( (string) file_get_contents( $paths['manifest_file'] ), true );
			if ( is_array( $m ) && ! empty( $m['file'] ) ) {
				$opt_ver = ( is_array( $opt ) && isset( $opt['currentVersion'] ) ) ? (int) $opt['currentVersion'] : 0;
				$m_ver   = isset( $m['currentVersion'] ) ? (int) $m['currentVersion'] : 0;
				if ( $m_ver >= $opt_ver ) {
					update_option( self::OPTION_MANIFEST, $m, true );
				}
				$clean_file   = basename( (string) $m['file'] );
				$m['fileUrl'] = $this->format_public_url( $paths['url'] . '/' . $clean_file );
				return $m;
			}
		}

		if ( ! $this->seeding && ! file_exists( $paths['latest_file'] ) && file_exists( $paths['seed_file'] ) ) {
			return $this->ensure_initialized();
		}

		return array(
			'currentVersion' => 1,
			'updatedAt'      => gmdate( 'Y-m-d\TH:i:s\Z' ),
			'updatedBy'      => 'seed',
			'file'           => 'zemuria.v1.json',
			'fileUrl'        => $this->format_public_url( KISEKI_RELATION_PLUGIN_URL . 'seed/zemuria.seed.json' ),
		);
	}

	public function read_dataset(): array {
		$this->ensure_initialized();
		return $this->read_dataset_unlocked( $this->get_paths() );
	}

	private function read_dataset_unlocked( array $paths ): array {
		$file = file_exists( $paths['latest_file'] ) ? $paths['latest_file'] : $paths['seed_file'];
		$data = json_decode( (string) file_get_contents( $file ), true );
		if ( ! is_array( $data ) ) {
			return array(
				'schemaVersion' => 1,
				'version'       => 1,
				'updatedAt'     => gmdate( 'Y-m-d\TH:i:s\Z' ),
				'updatedBy'     => 'seed',
				'arcs'          => array(),
				'entities'      => array(),
				'relations'     => array(),
			);
		}
		unset( $data['backupMeta'] );
		return $data;
	}

	public function list_backups(): array {
		$paths = $this->get_paths();
		if ( ! is_dir( $paths['backups_dir'] ) ) {
			return array();
		}
		$files = glob( $paths['backups_dir'] . '/zemuria.v*.json' );
		if ( ! is_array( $files ) ) {
			return array();
		}
		// Sort by mtime descending (then filename descending) so v10+ always sorts newer than v9
		usort(
			$files,
			static function ( string $a, string $b ): int {
				$ma = (int) @filemtime( $a );
				$mb = (int) @filemtime( $b );
				if ( $ma !== $mb ) {
					return $mb <=> $ma;
				}
				return strnatcasecmp( basename( $b ), basename( $a ) );
			}
		);

		$meta_index = get_option( self::OPTION_BACKUP_META );
		if ( ! is_array( $meta_index ) ) {
			$meta_index = array();
		}

		$out = array();
		foreach ( array_slice( $files, 0, self::MAX_BACKUPS ) as $fp ) {
			$bn = basename( $fp );
			if ( ! preg_match( '/^zemuria\.v(\d+)\.(\d{8}-\d{6})-([a-zA-Z0-9_\-]+)\.json$/', $bn, $m ) ) {
				continue;
			}
			$ver  = (int) $m[1];
			$ts   = substr( $m[2], 0, 4 ) . '-' . substr( $m[2], 4, 2 ) . '-' . substr( $m[2], 6, 2 )
				. ' ' . substr( $m[2], 9, 2 ) . ':' . substr( $m[2], 11, 2 ) . ':' . substr( $m[2], 13, 2 );
			$user = $m[3];
			$meta = isset( $meta_index[ $bn ] ) && is_array( $meta_index[ $bn ] ) ? $meta_index[ $bn ] : array();
			if ( ! empty( $meta['previousAuthor'] ) ) {
				$user = (string) $meta['previousAuthor'];
			} elseif ( ! empty( $meta['displayName'] ) ) {
				$user = (string) $meta['displayName'];
			}

			$out[] = array(
				'file'        => $bn,
				'version'     => $ver,
				'timestamp'   => $ts,
				'user'        => $user,
				'userId'      => isset( $meta['userId'] ) ? (int) $meta['userId'] : 0,
				'displayName' => isset( $meta['displayName'] ) ? (string) $meta['displayName'] : $user,
				'summary'     => isset( $meta['summary'] ) ? (string) $meta['summary'] : '',
				'sizeKb'      => round( (int) @filesize( $fp ) / 1024, 1 ),
			);
		}
		return $out;
	}

	/**
	 * Executes an exclusive flock mutation against zemuria.latest.json, validates the result BEFORE
	 * writing backups, checks optional baseVersion (409 on conflict), bumps version, writes immutable
	 * zemuria.v{N}.json, and flushes targeted W3TC URLs.
	 *
	 * @param callable     $mutator          Receives (array $dataset) and returns updated array $dataset.
	 * @param array|string $actor            Actor metadata array {userId, displayName} or display name string.
	 * @param int|null     $base_version     Optional optimistic-locking version expected by caller.
	 * @param string       $summary          Optional human-readable audit summary.
	 * @param int[]        $touched_post_ids Optional WP post IDs whose permalinks should be cache-flushed.
	 */
	public function mutate_and_publish(
		callable $mutator,
		array|string $actor = 'Editor',
		?int $base_version = null,
		string $summary = '',
		array $touched_post_ids = array()
	): array {
		$this->ensure_initialized();

		$actor_id   = 0;
		$actor_name = 'Editor';
		if ( is_array( $actor ) ) {
			$actor_id   = isset( $actor['userId'] ) ? (int) $actor['userId'] : 0;
			$raw_dn     = trim( wp_strip_all_tags( (string) ( $actor['displayName'] ?? '' ) ) );
			$actor_name = '' !== $raw_dn ? $raw_dn : 'Editor';
			if ( '' === $summary && ! empty( $actor['summary'] ) ) {
				$summary = (string) $actor['summary'];
			}
		} else {
			$raw_dn     = trim( wp_strip_all_tags( $actor ) );
			$actor_name = '' !== $raw_dn ? $raw_dn : 'Editor';
		}
		$clean_summary = sanitize_text_field( mb_substr( trim( $summary ), 0, 240 ) );

		$paths   = $this->get_paths();
		$lock_fp = @fopen( $paths['lock_file'], 'c+' );
		if ( ! $lock_fp ) {
			throw new RuntimeException( '无法打开关系图谱文件锁 (.store.lock)，请检查 uploads 目录写权限。' );
		}

		if ( ! flock( $lock_fp, LOCK_EX ) ) {
			fclose( $lock_fp );
			throw new RuntimeException( '无法获取关系图谱写入锁，请稍后重试。' );
		}

		$this->lock_held = true;
		try {
			$current  = $this->read_dataset_unlocked( $paths );
			$prev_ver = isset( $current['version'] ) ? max( 1, (int) $current['version'] ) : 1;

			if ( null !== $base_version && $base_version !== $prev_ver ) {
				throw new Kiseki_Relation_Conflict_Exception(
					sprintf( '版本冲突：当前最新图谱为 v%d（请求基于旧版 v%d），请刷新后重试。', $prev_ver, $base_version ),
					$prev_ver
				);
			}

			// Run mutator & strict dataset validation BEFORE writing backup or pruning history!
			$next = $mutator( $current );
			if ( ! is_array( $next ) ) {
				throw new InvalidArgumentException( '图谱变更处理器返回了无效数据结构。' );
			}
			$this->validate_dataset( $next );

			$now_iso     = gmdate( 'Y-m-d\TH:i:s\Z' );
			$prev_author = isset( $current['updatedBy'] ) && '' !== trim( (string) $current['updatedBy'] )
				? trim( (string) $current['updatedBy'] )
				: 'editor';
			$safe_author = trim( (string) preg_replace( '/[^a-zA-Z0-9_\-]+/', '-', $prev_author ), '-' );
			$safe_author = '' !== $safe_author ? substr( $safe_author, 0, 40 ) : 'editor';
			$safe_author = rtrim( $safe_author, '-' );
			if ( '' === $safe_author ) {
				$safe_author = 'editor';
			}

			$audit_entry = array(
				'userId'         => $actor_id,
				'displayName'    => $actor_name,
				'previousAuthor' => $prev_author,
				'summary'        => $clean_summary,
				'timestamp'      => $now_iso,
			);

			$backup_name    = sprintf( 'zemuria.v%d.%s-%s.json', $prev_ver, gmdate( 'Ymd-His' ), $safe_author );
			$backup_payload = $current;
			$backup_payload['backupMeta'] = array(
				'userId'      => $actor_id,
				'displayName' => $actor_name,
				'summary'     => $clean_summary,
				'timestamp'   => $now_iso,
			);
			$this->atomic_write_json( $paths['backups_dir'] . '/' . $backup_name, $backup_payload, false );
			$this->record_and_prune_backups( $paths['backups_dir'], $backup_name, $audit_entry );

			$new_ver               = $prev_ver + 1;
			unset( $next['backupMeta'] );
			$next['schemaVersion'] = 1;
			$next['version']       = $new_ver;
			$next['updatedAt']     = $now_iso;
			$next['updatedBy']     = $actor_name;

			$snap_name = "zemuria.v{$new_ver}.json";
			$snap_path = $paths['dir'] . '/' . $snap_name;

			$this->atomic_write_json( $paths['latest_file'], $next, true );
			$this->atomic_write_json( $snap_path, $next, false );
			$this->prune_old_snapshots( $paths['dir'], $new_ver );

			$manifest = array(
				'currentVersion' => $new_ver,
				'updatedAt'      => $now_iso,
				'updatedBy'      => $actor_name,
				'userId'         => $actor_id,
				'displayName'    => $actor_name,
				'summary'        => $clean_summary,
				'timestamp'      => $now_iso,
				'file'           => $snap_name,
			);
			$this->atomic_write_json( $paths['manifest_file'], $manifest, true );
			update_option( self::OPTION_MANIFEST, $manifest, true );

			$this->flush_caches( $touched_post_ids );

			$manifest['fileUrl'] = $this->format_public_url( $paths['url'] . '/' . $snap_name );
			return array(
				'dataset'  => $next,
				'manifest' => $manifest,
				'backups'  => $this->list_backups(),
			);
		} finally {
			$this->lock_held = false;
			flock( $lock_fp, LOCK_UN );
			fclose( $lock_fp );
		}
	}

	public function restore_backup(
		string $backup_filename,
		array|string $actor = 'Editor',
		?int $base_version = null
	): array {
		$paths = $this->get_paths();
		$clean = basename( $backup_filename );
		if (
			$clean !== $backup_filename
			|| ! preg_match( '/^zemuria\.v\d+\.\d{8}-\d{6}-[a-zA-Z0-9_\-]+\.json$/', $clean )
		) {
			throw new InvalidArgumentException( '非法的历史备份文件名格式。' );
		}
		$full = $paths['backups_dir'] . '/' . $clean;
		if ( ! file_exists( $full ) ) {
			throw new InvalidArgumentException( '指定的历史备份文件不存在。' );
		}
		$restored = json_decode( (string) file_get_contents( $full ), true );
		if ( ! is_array( $restored ) ) {
			throw new RuntimeException( '备份文件 JSON 解析失败。' );
		}
		unset( $restored['backupMeta'] );

		return $this->mutate_and_publish(
			static function () use ( $restored ): array {
				return $restored;
			},
			$actor,
			$base_version,
			'回滚至历史备份 ' . $clean
		);
	}

	private function validate_dataset( array $data ): void {
		if ( ! isset( $data['arcs'] ) || ! is_array( $data['arcs'] ) || empty( $data['arcs'] ) ) {
			throw new InvalidArgumentException( '图谱数据必须包含非空的 arcs 数组。' );
		}
		if ( ! isset( $data['entities'] ) || ! is_array( $data['entities'] ) ) {
			throw new InvalidArgumentException( '图谱数据缺少 entities 数组。' );
		}
		if ( ! isset( $data['relations'] ) || ! is_array( $data['relations'] ) ) {
			throw new InvalidArgumentException( '图谱数据缺少 relations 数组。' );
		}

		foreach ( $data['arcs'] as $arc ) {
			if ( ! is_array( $arc ) || empty( $arc['id'] ) || empty( $arc['name'] ) ) {
				throw new InvalidArgumentException( '作品层 (arcs) 存在缺少 id 或 name 的无效项。' );
			}
		}

		foreach ( $data['entities'] as $ent ) {
			if ( ! is_array( $ent ) || empty( $ent['id'] ) || empty( $ent['canonicalName'] ) ) {
				throw new InvalidArgumentException( '实体列表存在缺少 id 或 canonicalName 的无效项。' );
			}
			$etype = (string) ( $ent['entityType'] ?? '' );
			if ( ! in_array( $etype, self::VALID_ENTITY_TYPES, true ) ) {
				throw new InvalidArgumentException( '实体存在非法的 entityType：' . $etype );
			}
		}

		foreach ( $data['relations'] as $rel ) {
			if (
				! is_array( $rel )
				|| empty( $rel['id'] )
				|| empty( $rel['source'] )
				|| empty( $rel['target'] )
				|| ! isset( $rel['label'] )
				|| '' === trim( (string) $rel['label'] )
			) {
				throw new InvalidArgumentException( '关系列表存在缺少必填字段 (id/source/target/label) 的无效项。' );
			}
			$cat = (string) ( $rel['category'] ?? '' );
			if ( ! in_array( $cat, self::VALID_CATEGORIES, true ) ) {
				throw new InvalidArgumentException( '关系存在非法的 category：' . $cat );
			}
		}
	}

	private function atomic_write_json( string $target_path, array $payload, bool $pretty ): void {
		$flags = JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES;
		if ( $pretty ) {
			$flags |= JSON_PRETTY_PRINT;
		}
		$encoded = wp_json_encode( $payload, $flags );
		if ( false === $encoded ) {
			throw new RuntimeException( 'JSON 序列化失败。' );
		}

		$tmp = sprintf( '%s.tmp.%d.%s', $target_path, getmypid(), uniqid( '', true ) );
		$fh  = @fopen( $tmp, 'wb' );
		if ( false === $fh ) {
			throw new RuntimeException( '创建临时文件失败：' . $tmp );
		}

		$total   = strlen( $encoded );
		$written = 0;
		try {
			while ( $written < $total ) {
				$chunk = fwrite( $fh, substr( $encoded, $written ) );
				if ( false === $chunk || 0 === $chunk ) {
					throw new RuntimeException( '写入临时文件失败：' . $tmp );
				}
				$written += $chunk;
			}
			fflush( $fh );
			if ( function_exists( 'fsync' ) ) {
				@fsync( $fh );
			}
		} catch ( Throwable $e ) {
			fclose( $fh );
			@unlink( $tmp );
			throw $e;
		}
		fclose( $fh );

		if ( ! @rename( $tmp, $target_path ) ) {
			@unlink( $tmp );
			throw new RuntimeException( '原子替换文件失败：' . $target_path );
		}
	}

	private function record_and_prune_backups( string $backups_dir, string $new_backup_name, array $audit_entry ): void {
		$meta_index = get_option( self::OPTION_BACKUP_META );
		if ( ! is_array( $meta_index ) ) {
			$meta_index = array();
		}
		$meta_index[ $new_backup_name ] = $audit_entry;

		$files = glob( $backups_dir . '/zemuria.v*.json' );
		if ( is_array( $files ) && count( $files ) > self::MAX_BACKUPS ) {
			usort(
				$files,
				static function ( string $a, string $b ): int {
					$ma = (int) @filemtime( $a );
					$mb = (int) @filemtime( $b );
					if ( $ma !== $mb ) {
						return $ma <=> $mb;
					}
					return strnatcasecmp( basename( $a ), basename( $b ) );
				}
			);
			$excess = array_slice( $files, 0, count( $files ) - self::MAX_BACKUPS );
			foreach ( $excess as $old ) {
				$old_bn = basename( $old );
				unset( $meta_index[ $old_bn ] );
				@unlink( $old );
			}
		}

		// Trim stale keys not matching remaining files
		if ( count( $meta_index ) > self::MAX_BACKUPS + 10 && is_array( $files ) ) {
			$alive = array();
			foreach ( $files as $fp ) {
				$bn = basename( $fp );
				if ( isset( $meta_index[ $bn ] ) ) {
					$alive[ $bn ] = $meta_index[ $bn ];
				}
			}
			$meta_index = $alive;
		}

		update_option( self::OPTION_BACKUP_META, $meta_index, false );
	}

	/**
	 * Keeps at least the latest 50 snapshots AND never unlinks any snapshot modified within the
	 * last 24 hours (86400s, exceeding typical reverse-proxy and CDN HTML cache TTLs).
	 */
	private function prune_old_snapshots( string $dir, int $current_ver ): void {
		$files = glob( $dir . '/zemuria.v*.json' );
		if ( ! is_array( $files ) ) {
			return;
		}

		$snapshots = array();
		foreach ( $files as $fp ) {
			if ( preg_match( '/^zemuria\.v(\d+)\.json$/', basename( $fp ), $m ) ) {
				$snapshots[] = array(
					'path' => $fp,
					'ver'  => (int) $m[1],
				);
			}
		}

		if ( count( $snapshots ) <= self::MIN_SNAPSHOTS_KEEP ) {
			return;
		}

		usort(
			$snapshots,
			static fn( array $a, array $b ): int => $b['ver'] <=> $a['ver']
		);

		$cutoff_ts = time() - self::SNAPSHOT_MIN_AGE_SEC;
		foreach ( $snapshots as $idx => $snap ) {
			// Always retain the latest 50 snapshots and the newly published snapshot
			if ( $idx < self::MIN_SNAPSHOTS_KEEP || $snap['ver'] === $current_ver ) {
				continue;
			}
			$mtime = @filemtime( $snap['path'] );
			if ( false === $mtime || $mtime > $cutoff_ts ) {
				continue;
			}
			@unlink( $snap['path'] );
		}
	}

	/**
	 * Performs targeted W3TC URL invalidation rather than wiping the entire site's page/object cache.
	 *
	 * @param int[] $touched_post_ids Optional post IDs affected by a single-node/edge edit.
	 */
	private function flush_caches( array $touched_post_ids = array() ): void {
		if ( function_exists( 'w3tc_flush_url' ) ) {
			w3tc_flush_url( home_url( '/' ) );
			w3tc_flush_url( home_url( '/relations/' ) );
			if ( ! empty( $touched_post_ids ) && count( $touched_post_ids ) <= 10 ) {
				foreach ( array_unique( array_map( 'intval', $touched_post_ids ) ) as $pid ) {
					if ( $pid > 0 ) {
						if ( function_exists( 'w3tc_flush_post' ) ) {
							w3tc_flush_post( $pid );
						} else {
							$plink = get_permalink( $pid );
							if ( $plink ) {
								w3tc_flush_url( $plink );
							}
						}
					}
				}
			}
			return;
		}

		if ( function_exists( 'w3tc_flush_post' ) && ! empty( $touched_post_ids ) && count( $touched_post_ids ) <= 10 ) {
			foreach ( array_unique( array_map( 'intval', $touched_post_ids ) ) as $pid ) {
				if ( $pid > 0 ) {
					w3tc_flush_post( $pid );
				}
			}
		}

		wp_cache_delete( self::OPTION_MANIFEST, 'options' );
	}
}
