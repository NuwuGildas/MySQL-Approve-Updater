'use strict';
/* Python apps: Django, Flask, FastAPI (and generic WSGI/ASGI). A virtualenv
   is created inside each release (.venv) so rollbacks are self-contained;
   pip/uv caches live in shared/cache. Runs behind gunicorn/uvicorn managed
   by systemd or pm2 (target.process). */
const { has } = require('../detect/tree');

const req = (keyFiles, root, name) => keyFiles[root === '.' ? name : `${root}/${name}`];
const mentions = (text, pkg) => new RegExp(`(^|[\\s"'\\[,])${pkg}([\\s"'\\]=<>~!;,]|$)`, 'im').test(text || '');

function packageManager(keyFiles, root) {
  if (req(keyFiles, root, 'uv.lock')) return 'uv';
  if (req(keyFiles, root, 'poetry.lock') || /\[tool\.poetry\]/.test(req(keyFiles, root, 'pyproject.toml') || '')) return 'poetry';
  if (req(keyFiles, root, 'Pipfile')) return 'pipenv';
  return 'pip';
}
function installSteps(pm) {
  switch (pm) {
    case 'uv': return ['uv sync --frozen --no-dev'];
    case 'poetry': return ['python3 -m venv .venv', '.venv/bin/pip install -q -U pip poetry', '.venv/bin/poetry config virtualenvs.create false --local', '.venv/bin/poetry install --only main --no-interaction --no-root'];
    case 'pipenv': return ['python3 -m venv .venv', '.venv/bin/pip install -q -U pip pipenv', 'PIPENV_VENV_IN_PROJECT=1 .venv/bin/pipenv install --deploy --ignore-pipfile'];
    default: return ['python3 -m venv .venv', '.venv/bin/pip install -q -U pip wheel', '.venv/bin/pip install -q -r requirements.txt'];
  }
}
/** Django project package = the directory that holds wsgi.py (from the tree). */
function djangoProject(tree, root) {
  const prefix = root === '.' ? '' : root + '/';
  const w = tree.find((e) => e.startsWith(prefix) && /\/(wsgi|asgi)\.py$/.test(e));
  return w ? w.slice(prefix.length).split('/')[0] : null;
}

module.exports = {
  id: 'python', type: 'python', framework: 'python', label: 'Python app',
  detect(tree, keyFiles, root = '.') {
    const reqs = req(keyFiles, root, 'requirements.txt'), pyproject = req(keyFiles, root, 'pyproject.toml'), pipfile = req(keyFiles, root, 'Pipfile');
    const manage = root === '.' ? 'manage.py' : `${root}/manage.py`;
    const hasManage = req(keyFiles, root, 'manage.py') !== undefined || has(tree, manage);
    if (!reqs && !pyproject && !pipfile && !hasManage) return null;
    const deps = `${reqs || ''}\n${pyproject || ''}\n${pipfile || ''}`;
    const pm = packageManager(keyFiles, root);
    const evidence = [reqs !== undefined && (root === '.' ? 'requirements.txt' : `${root}/requirements.txt`), pyproject !== undefined && (root === '.' ? 'pyproject.toml' : `${root}/pyproject.toml`), pipfile !== undefined && (root === '.' ? 'Pipfile' : `${root}/Pipfile`), hasManage && manage].filter(Boolean);
    const venvBin = pm === 'uv' ? '.venv/bin' : '.venv/bin';
    const mk = (framework, score, start, extraBuild, shared, health) => ({
      score, evidence,
      fragment: {
        root,
        stack: { type: 'python', framework, packageManager: pm, python: (/python\s*=\s*"[^\d]*(\d+\.\d+)/.exec(pyproject || '') || /requires-python\s*=\s*"[^\d]*(\d+\.\d+)/.exec(pyproject || '') || [])[1] || null },
        build: { steps: [...installSteps(pm), ...extraBuild], env: { PYTHONUNBUFFERED: '1', PIP_DISABLE_PIP_VERSION_CHECK: '1' } },
        artifact: { exclude: ['.git/**', '.github/**', '.venv/**', '__pycache__/**', '**/__pycache__/**', 'tests/**', '.env', '.env.*', '**/*.pyc', 'ship.json'] },
        shared: { files: ['.env'], dirs: shared },
        runtime: { kind: 'python', start, port: 8000, docroot: '.' },
        health: { path: health, expectStatus: [200, 399] },
      },
    });
    if (hasManage || mentions(deps, 'django')) {
      const proj = djangoProject(tree, root) || 'config';
      return mk('django', 0.95, `${venvBin}/gunicorn ${proj}.wsgi:application --bind 127.0.0.1:$PORT --workers 2`, [`${venvBin}/python manage.py collectstatic --noinput`], ['media'], '/');
    }
    if (mentions(deps, 'fastapi')) return mk('fastapi', 0.85, `${venvBin}/uvicorn main:app --host 127.0.0.1 --port $PORT --workers 2`, [], [], '/docs');
    if (mentions(deps, 'flask')) return mk('flask', 0.85, `${venvBin}/gunicorn app:app --bind 127.0.0.1:$PORT --workers 2`, [], [], '/');
    return mk('python', 0.5, `${venvBin}/gunicorn app:app --bind 127.0.0.1:$PORT`, [], [], '/');
  },
  remoteSteps(manifest) {
    const afterShip = [];
    if (manifest.stack.framework === 'django' && manifest.migrate !== false) afterShip.push('.venv/bin/python manage.py migrate --noinput');
    return { afterShip, beforeActivate: [], afterActivate: [], permissions: [] };
  },
  requiredTools: (m) => ['python3', ...(m.stack.packageManager === 'uv' ? ['uv'] : [])],
  remoteOnly: true,
};
