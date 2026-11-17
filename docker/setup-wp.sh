#!/bin/sh
set -e

echo "Waiting for WordPress wp-config.php and database..."
until [ -f /var/www/html/wp-config.php ] && wp db check --path=/var/www/html >/dev/null 2>&1; do
  sleep 2
done
cd /var/www/html

if ! wp core is-installed --allow-root; then
  wp core install \
    --url="http://localhost:8088" \
    --title="轨迹系列数据库 · Kiseki Relation Demo" \
    --admin_user="admin" \
    --admin_password="local-admin-password" \
    --admin_email="admin@example.local" \
    --skip-email \
    --allow-root
fi

# Create Editor user to verify full backend access for Editor role
if ! wp user get editor --allow-root >/dev/null 2>&1; then
  wp user create editor editor@example.local \
    --role=editor \
    --user_pass="local-editor-password" \
    --display_name="黎轨编辑员 (Editor)" \
    --allow-root
fi

# Configure pretty permalinks & write standard WordPress .htaccess
wp rewrite structure '/%postname%/' --allow-root
cat <<'EOF' > /var/www/html/.htaccess
# BEGIN WordPress
<IfModule mod_rewrite.c>
RewriteEngine On
RewriteRule .* - [E=HTTP_AUTHORIZATION:%{HTTP:Authorization}]
RewriteBase /
RewriteRule ^index\.php$ - [L]
RewriteCond %{REQUEST_FILENAME} !-f
RewriteCond %{REQUEST_FILENAME} !-d
RewriteRule . /index.php [L]
</IfModule>
# END WordPress
EOF

# Activate Kiseki Interactive Relationship Graph plugin
wp plugin activate kiseki-relation-graph --allow-root

# Create full-page /relations/ page if missing
if ! wp post list --post_type=page --name=relations --field=ID --allow-root | grep -q '[0-9]'; then
  REL_PAGE_ID=$(wp post create \
    --post_type=page \
    --post_title="轨迹系列人物势力关系图" \
    --post_name="relations" \
    --post_status=publish \
    --post_content='[kiseki_relation mode="full" default_arc="kuro" default_tier="supporting" default_view="3d" height="84vh"]' \
    --porcelain \
    --allow-root)
  wp option update show_on_front page --allow-root
  wp option update page_on_front "$REL_PAGE_ID" --allow-root
fi

# Create sample dt_team / org / region wiki posts for auto-link & mini-mode testing
if ! wp post list --post_type=dt_team --name=van-arkride --field=ID --allow-root | grep -q '[0-9]'; then
  wp post create \
    --post_type=dt_team \
    --post_title="范恩·亚克莱德" \
    --post_name="van-arkride" \
    --post_excerpt="首都伊帝斯第八区旧市街经营《亚克莱德解决事务所》的青年地下万事屋。" \
    --post_status=publish \
    --post_content='<p>本页演示角色百科词条页内嵌 <code>mode="mini"</code> 局部关系网卡片：</p>[kiseki_relation mode="mini" focus="van-arkride" default_arc="kuro" default_view="2d" height="480px" full_url="/relations/"]' \
    --allow-root

  wp post create \
    --post_type=dt_team \
    --post_title="乌莉卡" \
    --post_name="ulrica" \
    --post_excerpt="界之轨迹新登场人气角色示例（可用于后台测试「一键关联 WordPress 百科词条」功能）。" \
    --post_status=publish \
    --post_content='<p>乌莉卡角色百科词条示例页。</p>' \
    --allow-root

  wp post create \
    --post_type=org \
    --post_title="亚克莱德解决事务所" \
    --post_name="spriggan" \
    --post_excerpt="位于伊帝斯旧市街《蒙马特》二楼的地下万事屋事务所。" \
    --post_status=publish \
    --post_content='[kiseki_relation mode="mini" focus="spriggan" default_arc="kuro" default_view="2d" height="480px" full_url="/relations/"]' \
    --allow-root
fi

wp rewrite flush --hard --allow-root
echo "WordPress provisioning complete!"
