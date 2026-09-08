'use strict';
/* Server-side config snippets rendered for the "Setup" tab (copy-paste in
   Phase 1). Plain JS strings so pkg needs no extra assets. */

function nginxPhp({ domain, current, docroot, phpVersion }) {
  const sock = `/run/php/php${phpVersion || '8.3'}-fpm.sock`;
  return `server {
    listen 80;
    server_name ${domain || '_'};
    root ${current}/${docroot || 'public'};
    index index.php index.html;
    client_max_body_size 64m;

    location / { try_files $uri $uri/ /index.php?$query_string; }
    location ~ \\.php$ {
        include snippets/fastcgi-php.conf;
        fastcgi_pass unix:${sock};
        # serve the NEW release right after the symlink swap (no stale OPcache paths)
        fastcgi_param SCRIPT_FILENAME $realpath_root$fastcgi_script_name;
        fastcgi_param DOCUMENT_ROOT $realpath_root;
    }
    location ~ /\\.(?!well-known).* { deny all; }
}`;
}

function nginxNode({ domain, port }) {
  return `server {
    listen 80;
    server_name ${domain || '_'};
    location / {
        proxy_pass http://127.0.0.1:${port || 3000};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}`;
}

function nginxStatic({ domain, current, docroot }) {
  return `server {
    listen 80;
    server_name ${domain || '_'};
    root ${current}${docroot && docroot !== '.' ? '/' + docroot : ''};
    index index.html;
    location / { try_files $uri $uri/ /index.html; }
    location ~* \\.(js|css|png|jpg|jpeg|gif|svg|ico|woff2?)$ { expires 30d; add_header Cache-Control "public, immutable"; }
}`;
}

function apachePhp({ domain, current, docroot }) {
  return `<VirtualHost *:80>
    ServerName ${domain || 'example.com'}
    DocumentRoot ${current}/${docroot || 'public'}
    <Directory ${current}/${docroot || 'public'}>
        AllowOverride All
        Require all granted
        Options -Indexes +FollowSymLinks
    </Directory>
    ErrorLog \${APACHE_LOG_DIR}/${domain || 'app'}-error.log
    CustomLog \${APACHE_LOG_DIR}/${domain || 'app'}-access.log combined
</VirtualHost>`;
}

function systemdNode({ name, user, current, start, port, envFile }) {
  return `[Unit]
Description=${name} (deployed by Server Tools)
After=network.target

[Service]
Type=simple
User=${user || 'deploy'}
WorkingDirectory=${current}
Environment=NODE_ENV=production
Environment=PORT=${port || 3000}
${envFile ? `EnvironmentFile=-${envFile}` : ''}
ExecStart=/bin/sh -lc '${(start || 'node server.js').replace(/'/g, "'\\''")}'
Restart=always
RestartSec=3
KillSignal=SIGINT
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target`;
}

function pm2Ecosystem({ name, start, port }) {
  const [cmd, ...args] = (start || 'node server.js').split(' ');
  const script = cmd === 'node' ? args.join(' ') : start;
  return `module.exports = {
  apps: [{
    name: ${JSON.stringify(name)},
    ${cmd === 'node' ? `script: ${JSON.stringify(script)},` : `script: ${JSON.stringify(cmd)}, args: ${JSON.stringify(args.join(' '))},`}
    cwd: __dirname,
    env: { NODE_ENV: 'production', PORT: ${port || 3000} },
    instances: 1,
    exec_mode: 'fork',
    max_memory_restart: '512M',
  }],
};
`;
}

/** .htaccess placed in the docroot when the host cannot symlink public_html. */
function htaccessRewrite({ target }) {
  return `# Managed by Server Tools: routes the docroot into the current release
Options +FollowSymLinks
RewriteEngine On
RewriteCond %{REQUEST_URI} !^/${target}/
RewriteRule ^(.*)$ ${target}/$1 [L]
`;
}

function maintenanceHtml({ name }) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Updating…</title>
<style>body{font:16px system-ui;margin:0;display:grid;place-items:center;height:100vh;background:#0f141a;color:#e6edf3}p{opacity:.7}</style></head>
<body><div><h1>${name || 'This site'} is being updated</h1><p>We'll be back in a few seconds. Please refresh shortly.</p></div></body></html>`;
}

function htaccessMaintenance() {
  return `# Server Tools maintenance mode (temporary)
RewriteEngine On
RewriteCond %{REQUEST_URI} !/\\.st-maintenance\\.html$
RewriteRule ^(.*)$ /.st-maintenance.html [R=503,L]
ErrorDocument 503 /.st-maintenance.html
Header always set Retry-After "10"
`;
}

function sudoers({ user, phpVersion }) {
  return `# /etc/sudoers.d/${user || 'deploy'}-servertools: allow ONLY the reload commands the deploy runs
${user || 'deploy'} ALL=(root) NOPASSWD: /bin/systemctl reload nginx, /bin/systemctl reload apache2, /bin/systemctl reload php${phpVersion || '8.3'}-fpm, /bin/systemctl restart ${user || 'deploy'}-*.service, /usr/bin/systemctl reload nginx, /usr/bin/systemctl reload php${phpVersion || '8.3'}-fpm, /usr/bin/tee /etc/nginx/sites-available/*, /usr/bin/ln -sfn /etc/nginx/sites-available/* /etc/nginx/sites-enabled/*, /usr/sbin/nginx -t, /usr/bin/certbot *`;
}

module.exports = { nginxPhp, nginxNode, nginxStatic, apachePhp, systemdNode, pm2Ecosystem, htaccessRewrite, maintenanceHtml, htaccessMaintenance, sudoers };
