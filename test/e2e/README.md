# Deploy module — end-to-end tests

Unit tests (`npm test`) cover the detector, manifest, vault, engine and the FTP
adapter with an in-process FTP server. The scripts here exercise real servers.

## VPS over SSH (Docker)

```bash
docker build -t st-vps test/e2e/vps
docker run -d --rm --name st-vps -p 2222:22 -p 8088:80 st-vps
node test/e2e/vps/run-e2e.js          # plan → ship → ship → rollback → failed health check → rollback
docker rm -f st-vps
```

The container is Ubuntu 24.04 with sshd (user `deploy`/`deploy`), nginx pointing at
`/var/www/demo/current/public`, PHP-FPM, composer, node and git. The script uses a
throwaway data dir, so your own `connections.json`, targets and vault are untouched.

To try the same thing through the UI: add an SSH-only server `127.0.0.1:2222`
(`deploy`/`deploy`) in **SSH servers**, then in **Deploy** connect the
`test/fixtures/repos/php-web` folder, add a VPS target with root `/var/www/demo`,
reload commands `sudo -n /usr/sbin/nginx -s reload` and
`sudo -n /usr/sbin/service php8.3-fpm reload`, health URL `http://127.0.0.1:8088/`.

## Shared hosting over FTP

```bash
node test/e2e/ftp-server.js            # prints the root dir; user acme / ftp-secret, docroot /public_html
```

Then in the UI: Secrets → `FTP_E2E` = `ftp-secret`; connect a repo (e.g.
`test/fixtures/repos/plain-html`); add a shared-hosting target with transport FTP
`127.0.0.1:2121`, home `/`, docroot `/public_html`; Plan → Ship. Or from the CLI:

```bash
node server.js plan <target>
node server.js ship <target> --yes
node server.js releases <target>
node server.js rollback <target> --yes
```

## Auto-ship webhook

```bash
node test/e2e/ftp-server.js            # terminal 1
PORT=3999 node server.js               # terminal 2
node test/e2e/webhook-e2e.js           # terminal 3: signed GitHub/GitLab pushes → listener on 127.0.0.1:3001 → ship
```
