(function() {
    'use strict';

    // ! ==============================
    // ! State
    // ! ==============================
    const State = {
        BOOT:           'boot',
        AUTH:           'auth',
        AUTHENTICATING: 'authenticating',
        COMMAND:        'command',
        CONFIRM:        'confirm',
        RECONNECTING:   'reconnecting'
    };

    let state = State.BOOT;
    let socket = null;
    let pingInterval = null;
    let spinnerInterval = null;
    let pendingPowerAction = null;
    let lastAuthCheck = 0;

    // ! ==============================
    // ! DOM references
    // ! ==============================
    const $ = (id) => document.getElementById(id);
    const els = {
        form:           $('terminalForm'),
        output:         $('terminalOutput'),
        usernameLine:   $('usernameLine'),
        passwordLine:   $('passwordLine'),
        commandLine:    $('commandLine'),
        confirmLine:    $('confirmLine'),
        usernameInput:  $('usernameInput'),
        passwordInput:  $('passwordInput'),
        commandInput:   $('commandInput'),
        confirmInput:   $('confirmInput'),
        commandPrompt:  $('commandPrompt'),
        confirmPrompt:  $('confirmPrompt')
    };

    const MAX_LINES = 5000;

    // ! ==============================
    // ! Output helpers
    // ! ==============================
    function escapeHtml(s) {
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function print(text, cls) {
        const line = document.createElement('div');
        line.className = 'line' + (cls ? ' ' + cls : '');
        line.textContent = text == null ? '' : String(text);
        els.output.appendChild(line);
        trimLines();
        scrollToBottom();
        return line;
    }

    function printHTML(html, cls) {
        const line = document.createElement('div');
        line.className = 'line' + (cls ? ' ' + cls : '');
        line.innerHTML = html;
        els.output.appendChild(line);
        trimLines();
        scrollToBottom();
        return line;
    }

    function sanitizeProcessOutput(html) {
        const parsed = new DOMParser().parseFromString(html, 'text/html');
        const container = document.createElement('div');

        function appendNode(node, parent) {
            if (node.nodeType === Node.TEXT_NODE) {
                parent.appendChild(document.createTextNode(node.nodeValue));
                return;
            }

            if (node.nodeType !== Node.ELEMENT_NODE) return;

            if (node.tagName.toLowerCase() === 'font') {
                const font = document.createElement('font');
                const color = node.getAttribute('color');
                if (color && /^#[0-9a-f]{3,8}$/i.test(color)) {
                    font.setAttribute('color', color);
                }
                parent.appendChild(font);
                Array.from(node.childNodes).forEach((child) => appendNode(child, font));
                return;
            }

            if (
                node.tagName.toLowerCase() === 'span' &&
                node.getAttribute('class') === 'prompt-prefix'
            ) {
                const prompt = document.createElement('span');
                prompt.className = 'prompt-prefix';
                parent.appendChild(prompt);
                Array.from(node.childNodes).forEach((child) => appendNode(child, prompt));
                return;
            }

            Array.from(node.childNodes).forEach((child) => appendNode(child, parent));
        }

        Array.from(parsed.body.childNodes).forEach((node) => appendNode(node, container));
        return container.innerHTML;
    }

    function trimLines() {
        while (els.output.children.length > MAX_LINES) {
            els.output.removeChild(els.output.firstChild);
        }
    }

    function scrollToBottom() {
        els.output.scrollTop = els.output.scrollHeight;
    }

    // ! ==============================
    // ! Input line control
    // ! ==============================
    function clearInputLines() {
        els.usernameLine.classList.remove('active');
        els.passwordLine.classList.remove('active');
        els.commandLine.classList.remove('active');
        els.confirmLine.classList.remove('active');
    }

    function setState(newState) {
        state = newState;
        clearInputLines();

        switch (newState) {
            case State.AUTH:
                els.usernameLine.classList.add('active');
                els.passwordLine.classList.add('active');

                // ? Focus username if empty, else password
                if (els.usernameInput.value) {
                    els.passwordInput.focus();
                } else {
                    els.usernameInput.focus();
                }
                break;

            case State.COMMAND:
                els.commandLine.classList.add('active');
                els.commandInput.focus();
                break;

            case State.CONFIRM:
                els.confirmLine.classList.add('active');
                els.confirmInput.focus();
                break;

            // ? No input for other states
        }
    }

    const SPINNER_FRAMES = ['\u280B', '\u2819', '\u2839', '\u2838', '\u283C', '\u2834', '\u2826', '\u2827', '\u2807', '\u280F'];
    let spinnerLine = null;
    let spinnerFrameIdx = 0;

    function startSpinner(text) {
        stopSpinner();
        spinnerLine = document.createElement('div');
        spinnerLine.className = 'line dim';
        spinnerLine.innerHTML =
            '<span class="spinner">' + SPINNER_FRAMES[0] + '</span>' +
            escapeHtml(text);
        els.output.appendChild(spinnerLine);
        scrollToBottom();

        spinnerInterval = setInterval(() => {
            spinnerFrameIdx = (spinnerFrameIdx + 1) % SPINNER_FRAMES.length;
            const s = spinnerLine.querySelector('.spinner');
            if (s) s.textContent = SPINNER_FRAMES[spinnerFrameIdx];
        }, 80);
    }

    function stopSpinner() {
        if (spinnerInterval) {
            clearInterval(spinnerInterval);
            spinnerInterval = null;
        }
        if (spinnerLine) {
            spinnerLine.remove();
            spinnerLine = null;
        }
    }

    // ! ==============================
    // ! Authentication
    // ! ==============================
    async function checkAuth() {
        try {
            const response = await fetch('/api/check-auth');
            const data = await response.json();
            if (data.authenticated) {
                connectSocket();
            } else {
                print('Authentication required.', 'warning');
                setState(State.AUTH);
            }
        } catch (err) {
            print('Failed to reach server: ' + err.message, 'error');
            setState(State.AUTH);
        }
    }

    function startAuthSequence(message) {
        if (message) print(message, 'warning');
        els.passwordInput.value = '';
        els.commandInput.value = '';
        setState(State.AUTH);
    }

    function requireAuthentication(message) {
        if (state === State.AUTH || state === State.AUTHENTICATING) return;

        if (socket) {
            try {
                socket.io.opts.reconnection = false;
                socket.removeAllListeners();
                socket.disconnect();
            } catch (e) {}
            socket = null;
        }
        if (pingInterval) {
            clearInterval(pingInterval);
            pingInterval = null;
        }

        stopSpinner();
        startAuthSequence(message || 'Session expired. Authentication required.');
    }

    async function submitAuth() {
        const username = els.usernameInput.value.trim();
        const password = els.passwordInput.value;

        if (!username) {
            print('Username is required.', 'error');
            els.usernameInput.focus();
            return;
        }
        if (!password) {
            print('Password is required.', 'error');
            els.passwordInput.focus();
            return;
        }

        // ? Echo credentials into the output (password masked)
        print('login as: ' + username, 'faint');
        print('Password: ' + '*'.repeat(password.length), 'faint');
        els.passwordInput.value = '';

        // ? Hide inputs, show spinner
        setState(State.AUTHENTICATING);
        startSpinner('Authenticating...');

        try {
            const response = await fetch('/api/auth', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });
            const data = await response.json();
            stopSpinner();

            if (data.success) {
                print('Authenticated.', 'success');
                connectSocket();
            } else {
                print('Authentication failed: ' + (data.message || 'Invalid credentials'), 'error');
                startAuthSequence(null);
            }
        } catch (err) {
            stopSpinner();
            print('Connection error: ' + err.message, 'error');
            startAuthSequence(null);
        }
    }

    // ! ==============================
    // ! Socket.IO setup
    // ! ==============================
    function connectSocket() {
        stopSpinner();

        // ? Clean up previous socket
        if (socket) {
            try {
                socket.removeAllListeners();
                socket.disconnect();
            } catch (e) {}
            socket = null;
        }
        if (pingInterval) {
            clearInterval(pingInterval);
            pingInterval = null;
        }

        if (state !== State.COMMAND) {
            setState(State.RECONNECTING);
        }
        startSpinner('Connecting...');

        socket = io({
            reconnection: true,
            reconnectionDelay: 2000,
            reconnectionAttempts: Infinity,
            timeout: 10000
        });

        socket.on('connect',         onSocketConnect);
        socket.on('disconnect',      onSocketDisconnect);
        socket.on('connect_error',   onSocketError);
        socket.on('process_output',  onProcessOutput);
        socket.on('pong',            onPong);
    }

    function onSocketConnect() {
        stopSpinner();
        print(`Connected to ${TITLE_NAME}.`, 'success');
        setState(State.COMMAND);

        if (pingInterval) clearInterval(pingInterval);
        pingInterval = setInterval(() => {
            if (socket && socket.connected) socket.emit('ping');
        }, 3000);
    }

    function onSocketDisconnect(reason) {
        console.log('[SOCKET] Disconnected:', reason);
        if (pingInterval) {
            clearInterval(pingInterval);
            pingInterval = null;
        }

        if (reason === 'io server disconnect') {
            checkAuth().catch(() => requireAuthentication());
            return;
        }

        print('Connection lost.', 'warning');
        startSpinner('Reconnecting...');
        if (state !== State.RECONNECTING) {
            setState(State.RECONNECTING);
        }
    }

    async function onSocketError(err) {
        console.log('[SOCKET] Error:', err);

        const now = Date.now();
        if (now - lastAuthCheck < 5000) {
            if (!spinnerLine) startSpinner('Reconnecting...');
            return;
        }
        lastAuthCheck = now;

        // ? Determine if this is an auth failure (session expired)
        try {
            const response = await fetch('/api/check-auth');
            if (!response.ok) throw new Error('HTTP ' + response.status);
            const data = await response.json();
            if (!data.authenticated) {
                requireAuthentication();
                return;
            }
        } catch (e) {
            console.log('[AUTH CHECK] Failed:', e);
        }

        if (!spinnerLine) startSpinner('Reconnecting...');
    }

    function onPong() {}

    function onProcessOutput(data) {
        if (!data || typeof data.process_output !== 'string') return;
        const lines = data.process_output.split('\n');
        for (let i = 0; i < lines.length; i++) {
            printHTML(sanitizeProcessOutput(lines[i]));
        }
    }

    // ! ==============================
    // ! Command handling
    // ! ==============================
    function submitCommand() {
        const cmd = els.commandInput.value;
        els.commandInput.value = '';

        if (!cmd.trim()) return;

        if (!socket || !socket.connected) {
            print('Not connected.', 'error');
            return;
        }

        const lower = cmd.trim().toLowerCase();

        if (lower === 'reboot') {
            pendingPowerAction = 'restart';
            els.confirmPrompt.textContent = 'Are you sure you want to reboot? [Y/N]';
            setState(State.CONFIRM);
        
        } else if (lower === 'shutdown') {
            pendingPowerAction = 'shutdown';
            els.confirmPrompt.textContent = 'Are you sure you want to shutdown? [Y/N]';
            setState(State.CONFIRM);
        
        } else {
            socket.emit('execute_command', { command: cmd });
            // ? Emit the rest of the commands
        }
    }

    function submitConfirm() {
        const answer = els.confirmInput.value.trim().toLowerCase();
        const action = pendingPowerAction;
        pendingPowerAction = null;

        // ? Echo the answer
        print('[Y/N] ' + (answer ? answer.toUpperCase() : '(empty)'));
        els.confirmInput.value = '';

        if (answer === 'y' || answer === 'yes') {
            if (socket && socket.connected && action) {

                if (action === 'restart') {
                    socket.emit('restart_process');
                } else if (action === 'shutdown') {
                    socket.emit('shutdown_process');
                }

                print('Sent ' + action + ' command.', 'dim');
            } else {
                print('Not connected.', 'error');
            }
        
        } else if (answer === 'n' || answer === 'no') {
            print('Cancelled.', 'dim');
        } else {
            print('Invalid input. Cancelled.', 'dim');
        }

        setState(State.COMMAND);
    }

    // ! ==============================
    // ! Event listeners
    // ! ==============================
    function setupListeners() {
        // ? Prevent native form submission & route to auth handler
        els.form.addEventListener('submit', (e) => {
            e.preventDefault();
            if (state === State.AUTH) {
                submitAuth();
            }
        });

        // ? Enter on username should jump to password
        els.usernameInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                if (els.usernameInput.value.trim()) {
                    els.passwordInput.focus();
                }
            }
        });

        // ? Enter on password should submit authenticate
        els.passwordInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                submitAuth();
            }
        });

        // ? Enter on command should submit command
        els.commandInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                submitCommand();
            }
        });

        // ? Enter on confirm should submit confirm
        els.confirmInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                submitConfirm();
            }
        });

        // ? Clicking the terminal refocuses the active input unless user is selecting text or input
        document.addEventListener('click', (e) => {
            const tag = e.target.tagName;
            if (tag === 'INPUT' || tag === 'BUTTON') return;

            const sel = window.getSelection();
            if (sel && sel.toString().length > 0) return;

            const activeLine = document.querySelector('.terminal-input-line.active');
            if (activeLine) {
                const input = activeLine.querySelector('input');
                if (input) input.focus();
            }
        });

        // ? Refocus active input when window regains focus
        window.addEventListener('focus', () => {
            const activeLine = document.querySelector('.terminal-input-line.active');
            if (activeLine) {
                const input = activeLine.querySelector('input');
                if (input && document.activeElement !== input) {
                    input.focus();
                }
            }
        });
    }

    // ! ==============================
    // ! Init setup
    // ! ==============================
    function init() {
        setupListeners();
        checkAuth();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
