#!/usr/bin/env python3
"""Isolated Linux GUI tests; backend-env requires explicit live authorization."""
import os
import pathlib
import secrets
import select
import signal
import subprocess
import sys
import tempfile
import time

if sys.platform != 'linux' or not pathlib.Path('/usr/lib/xorg/Xorg').is_file():
    raise SystemExit('This helper requires the installed Linux Xorg dummy server')
arguments = sys.argv[1:]
backend_env = bool(arguments and arguments[0] == '--backend-env')
if backend_env:
    arguments = arguments[1:]
if not arguments:
    raise SystemExit('Pass a test command')
with tempfile.TemporaryDirectory(prefix='acd-gui-') as directory:
    root = pathlib.Path(directory)
    os.chmod(root, 0o700)
    for name in ['runtime', 'data', 'config', 'cache', 'home']:
        (root / name).mkdir(mode=0o700)
    env = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'LANG': 'C.UTF-8',
           'HOME': str(root/'home'), 'USERPROFILE': str(root/'home'),
           'TMPDIR': directory, 'XDG_RUNTIME_DIR': str(root/'runtime'),
           'XDG_DATA_HOME': str(root/'data'), 'XDG_CONFIG_HOME': str(root/'config'),
           'XDG_CACHE_HOME': str(root/'cache'), 'npm_config_cache': '/tmp/acd-npm-cache'}
    display = next((n for n in range(90, 110) if not pathlib.Path(f'/tmp/.X{n}-lock').exists()
                    and not pathlib.Path(f'/tmp/.X11-unix/X{n}').exists()), None)
    if display is None:
        raise SystemExit('No unused test display')
    auth = root/'Xauthority'
    auth.touch(mode=0o600)
    subprocess.run(['xauth', '-f', str(auth), 'add', f':{display}', 'MIT-MAGIC-COOKIE-1',
                    secrets.token_hex(16)], env=env, check=True, capture_output=True, timeout=3)
    read_fd, write_fd = os.pipe()
    with (root/'xorg-output.txt').open('w') as log:
        server = subprocess.Popen(['/usr/lib/xorg/Xorg', f':{display}', '-nolisten', 'tcp',
                  '-noreset', '-novtswitch', '-sharevts', '-auth', str(auth),
                  '-displayfd', str(write_fd)], env=env, stdin=subprocess.DEVNULL,
                  stdout=log, stderr=subprocess.STDOUT, pass_fds=(write_fd,))
    os.close(write_fd)
    wm = None
    try:
        ready = select.select([read_fd], [], [], 8)[0]
        number = os.read(read_fd, 128).decode().strip() if ready else ''
        if number != str(display):
            raise SystemExit('Xorg did not become ready; no test executed')
        env.update(DISPLAY=f':{display}', XAUTHORITY=str(auth), ACD_TEST_NO_SANDBOX='1',
                   ACD_TEST_CHROMIUM_PATH='/usr/bin/chromium')
        if pathlib.Path('/usr/bin/xfwm4').is_file():
            with (root/'wm-output.txt').open('w') as log:
                wm = subprocess.Popen(['dbus-run-session', '--', 'xfwm4', '--compositor=off'],
                    env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                    start_new_session=True)
            deadline = time.monotonic() + 5
            while True:
                check = subprocess.run(['xprop', '-root', '_NET_SUPPORTING_WM_CHECK'], env=env,
                    capture_output=True, text=True, timeout=2)
                if 'window id #' in check.stdout:
                    break
                if time.monotonic() >= deadline or wm.poll() is not None:
                    raise SystemExit('Installed window manager did not become ready')
                time.sleep(0.05)  # Readiness polling, never test-event ordering.
        if backend_env:
            for key in ['ACD_EMBEDDED_PROVIDER', 'ACD_EMBEDDED_MODEL', 'ACD_EMBEDDED_HELPER_MODEL',
                        'ANTHROPIC_AUTH_TOKEN', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
                        'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'NODE_USE_ENV_PROXY',
                        'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR']:
                if key in os.environ:
                    env[key] = os.environ[key]
        result = subprocess.run(arguments, env=env)
    finally:
        os.close(read_fd)
        if wm is not None:
            try: os.killpg(wm.pid, signal.SIGTERM)
            except ProcessLookupError: pass
            try: wm.wait(timeout=3)
            except subprocess.TimeoutExpired:
                os.killpg(wm.pid, signal.SIGKILL)
                wm.wait(timeout=3)
        if server.poll() is None:
            server.terminate()
            try:
                server.wait(timeout=3)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait(timeout=3)
    raise SystemExit(result.returncode)
