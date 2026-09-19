from gevent import monkey; monkey.patch_all()

from flask import Flask, render_template, request, jsonify
from flask_socketio import SocketIO, emit, disconnect
from geventwebsocket.handler import WebSocketHandler
from datetime import datetime, timedelta
from gevent.pywsgi import WSGIServer
from collections import deque
from html import escape
from config import *
import subprocess
import threading
import signal
import time
import os
import re

app = Flask(__name__)
app.config['SECRET_KEY'] = SECRET_KEY
app.config['MAX_CONTENT_LENGTH'] = MAX_CONTENT_LENGTH
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="gevent", max_size=MAX_CONTENT_LENGTH)

authenticated_sessions = {}
session_lock = threading.Lock()
ansi_escape = re.compile(r'\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])')

process = None
process_lock = threading.Lock()
process_log_buffer = deque(maxlen=PROCESS_MAX_LINES) # ? Keep recent output to show on new connections
process_reader_thread = None
_process_stop_requested = False

def check_auth(username, password):
    """Verify username and password
    """
    return username == USERNAME and password == PASSWORD


def get_client_ip():
    """Get the client's IP address
    """
    if request.environ.get('HTTP_X_FORWARDED_FOR'):
        return request.environ['HTTP_X_FORWARDED_FOR'].split(',')[0]
    return request.environ.get('REMOTE_ADDR', 'unknown')


def is_authenticated(ip):
    """Check if the IP is authenticated and session hasn't expired
    """
    with session_lock:
        if ip in authenticated_sessions:
            last_activity = authenticated_sessions[ip]
            if datetime.now() - last_activity < timedelta(seconds=SESSION_TIMEOUT):
                return True
            
            else:
                # ! Session expired
                del authenticated_sessions[ip]
                print(f"[AUTH] Session expired for IP: {ip}", flush=True)
                return False
            
        return False


def update_session(ip):
    """Update the last activity time for a session
    """
    with session_lock:
        authenticated_sessions[ip] = datetime.now()


def start_process():
    """Start the configured process if not running
    """
    global process, process_reader_thread, _process_stop_requested

    with process_lock:
        if process and process.poll() is None:
            print("[PROCESS] already running (pid=%s)" % getattr(process, "pid", "unknown"), flush=True)
            return

        _process_stop_requested = False
        cmd = PROCESS_CMD
        cwd = PROCESS_WORKING_DIR or None

        try:
            print(f"[PROCESS] Starting process: {cmd} (cwd={cwd})", flush=True)
            # ? Use shell=True because PROCESS_CMD is a single string from config
            process = subprocess.Popen(
                cmd,
                cwd=cwd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                stdin=subprocess.PIPE,
                shell=True,
                bufsize=1,
                universal_newlines=True,
                start_new_session=True,
            )
        
        except Exception as e:
            print(f"[PROCESS] Failed to start process: {e}", flush=True)
            process = None
            return

        # # Start reader thread
        def _reader():
            global process, _process_stop_requested
            try:
                if not process or not process.stdout:
                    return
                
                for raw in iter(process.stdout.readline, ''):
                    if raw is None:
                        break

                    line = raw.rstrip('\n')
                    if line:
                        process_log_buffer.append(ansi_escape.sub('', line))
                        # ? Broadcast line to authenticated clients
                        try:
                            socketio.emit('process_output', {'process_output': ansi_escape.sub('', line)})
                            print("[PROCESS]", line, flush=True)
                        except Exception: pass

                    if _process_stop_requested:
                        break
                
            except Exception as e:
                print(f"[PROCESS] Reader thread error: {e}", flush=True)
            
            finally:
                # ? If process exited, notify clients
                exitcode = None
                try:
                    if process:
                        exitcode = process.poll()
                except Exception:
                    pass

                socketio.emit('process_output', {'process_output': f'<font color="#ad3737">[INTERFACE] Process terminated (exitcode={exitcode})</font>'})
                process_log_buffer.append(f'<font color="#ad3737">[INTERFACE] Process terminated (exitcode={exitcode})</font>')
                print("[PROCESS] Reader thread exiting", flush=True)

        process_reader_thread = threading.Thread(target=_reader, daemon=True)
        process_reader_thread.start()
        print(f"[PROCESS] started (pid={process.pid})", flush=True)


def kill_process():
    """Request stop of process (kill the whole process group)
    """
    global process, _process_stop_requested

    with process_lock:
        _process_stop_requested = True
        if not process:
            return True, None
        pid = process.pid

    if os.name == 'nt':
        try:
            subprocess.run(
                ['taskkill', '/F', '/T', '/PID', str(pid)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            )
        except Exception:
            try:
                os.kill(pid, signal.SIGKILL)
            except Exception:
                pass
    else:
        try:
            os.killpg(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        except Exception:
            try:
                os.kill(pid, signal.SIGKILL)
            except Exception:
                pass

    with process_lock:
        exitcode = None
        try:
            exitcode = process.poll()
        except Exception:
            pass
        process = None

    return True, exitcode


@app.route('/')
def index():
    """Display the main page
    """
    return render_template(
        'index.html',
        title_name=TITLE_NAME,
        theme_colors=THEME_COLORS,
    )


@app.route('/api/auth', methods=['POST'])
def authenticate():
    """Authenticate user and create session
    """
    try:
        data = request.get_json()
        username = data.get('username', '')
        password = data.get('password', '')
        
        client_ip = get_client_ip()
        print(f"[AUTH] Authentication attempt from IP: {client_ip}, Username: {username}", flush=True)
        
        if check_auth(username, password):
            with session_lock:
                authenticated_sessions[client_ip] = datetime.now()
            
            update_session(client_ip)
            print(f"[AUTH] Authentication successful for IP: {client_ip}", flush=True)
            return jsonify({'success': True, 'message': 'Authentication successful'})
        
        else:
            print(f"[AUTH] Authentication failed for IP: {client_ip}", flush=True)
            return jsonify({'success': False, 'message': 'Invalid credentials'}), 401
        
    except Exception as e:
        print(f"[ERROR] Authentication error: {e}", flush=True)
        return jsonify({'success': False, 'message': 'Server error'}), 500


@app.route('/api/check-auth', methods=['GET'])
def check_authentication():
    """Check if the client is authenticated
    """
    client_ip = get_client_ip()
    
    if is_authenticated(client_ip):
        update_session(client_ip)
        return jsonify({'authenticated': True})
    else:
        return jsonify({'authenticated': False})


@socketio.on('connect')
def handle_connect():
    """Handle client connection
    """
    client_ip = get_client_ip()
    print(f"[SOCKET] Client connected: {client_ip}", flush=True)
    
    if not is_authenticated(client_ip):
        print(f"[SOCKET] Unauthorized connection from: {client_ip}", flush=True)
        disconnect()
        return False
    
    update_session(client_ip)
    print(f"[SOCKET] Authenticated client connected: {client_ip}", flush=True)
    emit('process_output', {'process_output': '<font color="#039b16">[INTERFACE] Connected to backend.</font>'})

    try:
        if process_log_buffer:
            for line in list(process_log_buffer):
                emit('process_output', {'process_output': ansi_escape.sub('', line)})
    
    except Exception as e:
        print(f"[SOCKET] failed to send initial process buffer: {e}", flush=True)


@socketio.on('disconnect')
def handle_disconnect():
    """Handle client disconnection
    """
    client_ip = get_client_ip()
    print(f"[SOCKET] Client disconnected: {client_ip}", flush=True)


@socketio.on('ping')
def handle_ping():
    """Handle ping from client to keep session alive
    """
    client_ip = get_client_ip()
    
    if not is_authenticated(client_ip):
        disconnect()
        return
    
    update_session(client_ip)
    emit('pong', {'timestamp': datetime.now().isoformat()})


@socketio.on('execute_command')
def on_execute_command(data):
    """Receive a command from client and forward it to the process stdin
    """
    ip = get_client_ip()
    if not is_authenticated(ip):
        disconnect()
        return
    update_session(ip)

    cmd = data.get('command', '')
    print(f"[COMMAND] from {ip}: {cmd}", flush=True)

    with process_lock:
        if not process or process.poll() is not None:
            emit('process_output', {'process_output': '<font color="#ad3737">[INTERFACE] Process not running. Please restart (reboot cmd) to run it.</font>'})
            return

        if process and process.stdin and process.poll() is None:
            try:
                # ? Write command and flush
                command_output = '<span class="prompt-prefix">$</span> ' + escape(cmd)
                process_log_buffer.append(command_output)
                socketio.emit('process_output', {'process_output': command_output})

                process.stdin.write(cmd + "\n")
                process.stdin.flush()
            
            except Exception as e:
                emit('process_output', {'process_output': f'<font color="#ad3737">[INTERFACE] Failed to send command: {e}</font>'})
        
        else:
            emit('process_output', {'process_output': '<font color="#ad3737">[INTERFACE] Unable to send command; Process unavailable.</font>'})


@socketio.on('restart_process')
def handle_restart_process():
    """Stop the process (if running) then start it again
    """
    ip = get_client_ip()
    if not is_authenticated(ip):
        disconnect()
        return
    update_session(ip)

    socketio.emit('process_output', {'process_output': '<font color="#f0ad4e">[INTERFACE] Restart requested...</font>'})
    process_log_buffer.append('<font color="#f0ad4e">[INTERFACE] Restart requested...</font>')

    stopped, exitcode = kill_process()
    socketio.emit('process_output', {'process_output': f'<font color="#ad3737">[INTERFACE] Process stopped for restart (exitcode={exitcode})</font>'})
    process_log_buffer.append(f'<font color="#ad3737">[INTERFACE] Process stopped for restart (exitcode={exitcode})</font>')

    # ? Small pause to let things settle, then start
    time.sleep(1)
    start_process()
    socketio.emit('process_output', {'process_output': '<font color="#039b16">[INTERFACE] Process restarted.</font>'})
    process_log_buffer.append('<font color="#039b16">[INTERFACE] Process restarted.</font>')


@socketio.on('shutdown_process')
def handle_shutdown_process():
    """Stop the process (if running) and leave it inactive. Inform clients to restart to run again
    """
    ip = get_client_ip()
    if not is_authenticated(ip):
        disconnect()
        return
    update_session(ip)

    socketio.emit('process_output', {'process_output': '<font color="#f0ad4e">[INTERFACE] Shutdown requested...</font>'})
    process_log_buffer.append('<font color="#f0ad4e">[INTERFACE] Shutdown requested...</font>')

    stopped, exitcode = kill_process()
    inactive_msg = f'<font color="#ad3737">[INTERFACE] Process is inactive (exitcode={exitcode}). Please restart (reboot cmd) to run it.</font>'
    socketio.emit('process_output', {'process_output': inactive_msg})
    process_log_buffer.append(inactive_msg)

if __name__ == '__main__':
    start_process()
    print(f"wsgi starting up on http://{SERVER_IP}:{SERVER_PORT}", flush=True)
    WSGIServer((SERVER_IP, SERVER_PORT), app, handler_class=WebSocketHandler).serve_forever()