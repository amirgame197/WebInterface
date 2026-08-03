(function() {
    'use strict';

    // State
    let socket = null;
    let pingInterval = null;

    // DOM Elements
    const elements = {
        authModal: null,
        authForm: null,
        authError: null,
        mainContent: null,
        themeToggle: null,
        connectionStatus: null,
        connectionText: null,
        processOutput: null,
        executeCommand: null,
        executeCommandValue: null,
        resultModal: null,
        resultModalTitle: null,
        resultModalContent: null,
        confirmModal: null,
        confirmModalTitle: null,
        confirmModalMessage: null,
        confirmYes: null,
        confirmNo: null,
        restartBtn: null,
        shutdownBtn: null
    };

    // Initialize
    function init() {
        console.log('[CLIENT] Initializing Mindustry Console...');
        
        // Get DOM elements
        getDOMElements();
        
        // Setup event listeners
        setupEventListeners();
        
        // Load theme
        loadTheme();
        
        // Check authentication
        checkAuth();
    }

    function getDOMElements() {
        elements.authModal = document.getElementById('authModal');
        elements.authForm = document.getElementById('authForm');
        elements.authError = document.getElementById('authError');
        elements.mainContent = document.getElementById('mainContent');
        elements.themeToggle = document.getElementById('themeToggle');
        elements.connectionStatus = document.getElementById('connectionStatus');
        elements.connectionText = document.getElementById('connectionText');
        elements.resultModal = document.getElementById('resultModal');
        elements.resultModalTitle = document.getElementById('resultModalTitle');
        elements.resultModalContent = document.getElementById('resultModalContent');
        elements.confirmModal = document.getElementById('confirmModal');
        elements.confirmModalTitle = document.getElementById('confirmModalTitle');
        elements.confirmModalMessage = document.getElementById('confirmModalMessage');
        elements.confirmYes = document.getElementById('confirmYes');
        elements.confirmNo = document.getElementById('confirmNo');
        elements.processOutput = document.getElementById('processOutput');
        elements.executeCommand = document.getElementById('executeCommand');
        elements.executeCommandValue = document.getElementById('executeCommandValue');
        elements.restartBtn = document.getElementById('restartBtn');
        elements.shutdownBtn = document.getElementById('shutdownBtn');
    }

    function setupEventListeners() {
        // Auth form
        elements.authForm.addEventListener('submit', handleAuth);
        
        // Theme toggle
        elements.themeToggle.addEventListener('click', toggleTheme);
        
        // Power buttons
        elements.restartBtn.addEventListener('click', () => confirmPowerAction('restart'));
        elements.shutdownBtn.addEventListener('click', () => confirmPowerAction('shutdown'));
        
        // Modal close buttons
        document.querySelectorAll('.modal-close').forEach(btn => {
            btn.addEventListener('click', function() {
                const modal = this.closest('.modal');
                hideModal(modal);
            });
        });
        
        // Click outside modal to close
        document.querySelectorAll('.modal').forEach(modal => {
            modal.addEventListener('click', function(e) {
                if (e.target === this) {
                    hideModal(this);
                }
            });
        });

        // Confirm modal buttons
        elements.confirmNo.addEventListener('click', () => hideModal(elements.confirmModal));

        // Execute button
        elements.executeCommand.addEventListener('click', handleExecuteCommand);
        elements.executeCommandValue.addEventListener('keydown', function(event) {
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                handleExecuteCommand(event);
            }
        });
    }

    // Authentication
    async function checkAuth() {
        try {
            const response = await fetch('/api/check-auth');
            const data = await response.json();
            
            if (data.authenticated) {
                console.log('[AUTH] Already authenticated');
                onAuthSuccess();
            } else {
                console.log('[AUTH] Not authenticated');
                showAuthModal();
            }
        } catch (error) {
            console.error('[AUTH] Error checking authentication:', error);
            showAuthModal();
        }
    }

    function showAuthModal() {
        elements.authModal.style.display = 'flex';
        elements.mainContent.style.display = 'none';
    }

    function hideAuthModal() {
        elements.authModal.style.display = 'none';
        elements.mainContent.style.display = 'block';
    }

    async function handleAuth(e) {
        e.preventDefault();
        
        const username = document.getElementById('username').value;
        const password = document.getElementById('password').value;
        
        elements.authError.textContent = '';
        
        try {
            const response = await fetch('/api/auth', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ username, password })
            });
            
            const data = await response.json();
            
            if (data.success) {
                console.log('[AUTH] Authentication successful');
                onAuthSuccess();
            } else {
                elements.authError.textContent = data.message || 'Authentication failed';
            }
        } catch (error) {
            console.error('[AUTH] Authentication error:', error);
            elements.authError.textContent = 'Connection error';
        }
    }

    function onAuthSuccess() {
        hideAuthModal();
        connectSocket();
    }

    // Socket.IO Connection
    function connectSocket() {
        console.log('[SOCKET] Connecting to server...');
        
        updateConnectionStatus('connecting', 'Connecting...');
        
        socket = io({
            reconnection: true,
            reconnectionDelay: 5000,
            reconnectionAttempts: Infinity
        });
        
        socket.on('connect', onSocketConnect);
        socket.on('disconnect', onSocketDisconnect);
        socket.on('connect_error', onSocketError);
        socket.on('process_output', onProcessOutput);
        socket.on('pong', onPong);
    }

    function onSocketConnect() {
        console.log('[SOCKET] Connected to server');
        updateConnectionStatus('connected', 'Connected');
        
        // Start ping interval
        if (pingInterval) {
            clearInterval(pingInterval);
        }
        pingInterval = setInterval(() => {
            if (socket && socket.connected) {
                socket.emit('ping');
            }
        }, 3000);
    }

    function onSocketDisconnect() {
        console.log('[SOCKET] Disconnected from server');
        updateConnectionStatus('disconnected', 'Disconnected');
        
        if (pingInterval) {
            clearInterval(pingInterval);
            pingInterval = null;
        }
    }

    function onSocketError(error) {
        console.error('[SOCKET] Connection error:', error);
        updateConnectionStatus('disconnected', 'Connection Error');
    }

    function onPong(data) {
        // Keep-alive response
        console.log('[SOCKET] Pong received');
    }

    function updateConnectionStatus(status, text) {
        elements.connectionStatus.className = 'status-dot ' + status;
        elements.connectionText.textContent = text;
    }

    // Process Output
    function onProcessOutput(data) {
        console.log('[DATA] Process Output Received:', data);
        
        if (!data) {
            elements.coreStatusContent.innerHTML = '<div class="loading">No Process Output Data Available.</div>';
            return;
        }
        elements.processOutput.innerHTML += data.process_output + "\n";
        elements.processOutput.scrollTo({
            top: elements.processOutput.scrollHeight,
            behavior: 'smooth'
        });
    }
    
    // Command Execution
    function handleExecuteCommand(e) {
        e.preventDefault();
        
        const value = elements.executeCommandValue.value;
        
        console.log('[COMMAND] Executing:', value);

        if (!socket || !socket.connected) {
            alert('Not connected to server');
            return;
        }
        
        socket.emit('execute_command', { command: value});
        
        elements.executeCommandValue.value = '';
    }

    // Power Actions
    function confirmPowerAction(action) {
        console.log('[POWER] Confirming action:', action);
        
        const messages = {
            restart: 'Are you sure you want to restart the process?',
            shutdown: 'Are you sure you want to shutdown the process?'
        };
        
        elements.confirmModalTitle.textContent = 'Confirm ' + (action === 'restart' ? 'Restart' : 'Shutdown');
        elements.confirmModalMessage.textContent = messages[action];
        
        // Remove old event listener
        const newConfirmYes = elements.confirmYes.cloneNode(true);
        elements.confirmYes.parentNode.replaceChild(newConfirmYes, elements.confirmYes);
        elements.confirmYes = newConfirmYes;
        
        // Add new event listener
        elements.confirmYes.addEventListener('click', () => {
            hideModal(elements.confirmModal);
            executePowerAction(action);
        });
        
        showModal(elements.confirmModal);
    }

    function executePowerAction(action) {
        console.log('[POWER] Executing action:', action);
        
        if (!socket || !socket.connected) {
            alert('Not connected to server');
            return;
        }
        
        if (action === 'restart') {
            socket.emit('restart_process');
        } else if (action === 'shutdown') {
            socket.emit('shutdown_process');
        }
    }

    function onPowerActionResult(data) {
        console.log('[POWER] Power action result:', data);
        
        elements.resultModalTitle.textContent = data.success ? 'Success' : 'Error';
        elements.resultModalContent.className = 'result-content ' + (data.success ? 'success' : 'error');
        elements.resultModalContent.textContent = data.message;
        
        showModal(elements.resultModal);
    }

    // Theme
    function loadTheme() {
        const theme = localStorage.getItem('theme') || 'dark';
        applyTheme(theme);
    }

    function toggleTheme() {
        const currentTheme = document.body.classList.contains('light-mode') ? 'light' : 'dark';
        const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
        applyTheme(newTheme);
        localStorage.setItem('theme', newTheme);
    }

    function applyTheme(theme) {
        if (theme === 'light') {
            document.body.classList.add('light-mode');
            elements.themeToggle.querySelector('.theme-icon').textContent = '☀️';
        } else {
            document.body.classList.remove('light-mode');
            elements.themeToggle.querySelector('.theme-icon').textContent = '🌙';
        }
    }

    // Modal Helpers
    function showModal(modal) {
        modal.classList.add('show');
    }

    function hideModal(modal) {
        modal.classList.remove('show');
    }

    // Initialize on page load
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
