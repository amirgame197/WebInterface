# # #################### Interface settings ########################################################

TITLE_NAME        = "Process Console"
THEME_COLORS = {
    'bg':         "#1f1a16",   # ? THEME_BG
    'bg_soft':    "#2a231e",   # ? THEME_BG_SOFT
    'fg':         "#ede0d4",   # ? THEME_FG
    'fg_dim':     "#b8a595",   # ? THEME_FG_DIM
    'fg_faint':   "#7a6e5f",   # ? THEME_FG_FAINT
    'accent':     "#d4a574",   # ? THEME_ACCENT
    'accent_dim': "#a08260",   # ? THEME_ACCENT_DIM
    'danger':     "#d4847a",   # ? THEME_DANGER
    'success':    "#a8c896",   # ? THEME_SUCCESS
    'warning':    "#d4b876",   # ? THEME_WARNING
    'selection':  "#d4a57440", # ? THEME_SELECTION
}

USERNAME = "admin"
PASSWORD = "admin"
AUTH_RPM = 30 # ? The maximum amount of requests-per-minute for authentication requests

# # #################### Server settings ###########################################################

SECRET_KEY = "HASH"
MAX_CONTENT_LENGTH = 16 * 1024 * 1024  # ? 16MB Max
SESSION_TIMEOUT = 600  # ? 10 Minutes

LISTEN_IP = "0.0.0.0"
LISTEN_PORT = 0000

# # #################### Process settings ##########################################################

PROCESS_CMD = "python3 ./example_process.py"
PROCESS_WORKING_DIR = ""

PROCESS_MAX_LINES = 500